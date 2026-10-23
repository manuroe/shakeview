import { describe, it, expect } from 'vitest';
import { parseLogFile } from '../../logParser';
import { allLinesOf, deviceFromDroppedFiles, deviceFromEntries, deviceFromFile, deviceFromLoadedLogs, detailsFromEntries, droppedDevices, linesOfFile, loadedLogSteps } from '../loadDevice';
import { deviceIdentity } from '../identity';
import { SENDER_LOG, RECEIVER_LOG, SENDER_DETAILS, entry } from './fixtures';

describe('deviceIdentity', () => {
  it('reads user, device and curve key from details.json', () => {
    expect(deviceIdentity({
      userText: null, userId: '@a:d', deviceId: 'DEV', deviceKeys: 'curve25519:CK, ed25519:EK',
      appId: null, version: null, sdkSha: null, cryptoVersion: null, reportUrl: null,
    }, [])).toEqual({ userId: '@a:d', deviceId: 'DEV', curveKey: 'CK' });
  });
  it('falls back to the last Element Web setLoggedIn line', () => {
    const lines = parseLogFile([
      '2026-09-07T15:49:25.878Z D setLoggedIn: mxid: @old:d deviceId: OLD guest: false',
      '2026-09-07T15:51:38.356Z D setLoggedIn: mxid: @bob:d deviceId: VYTOIDPHBO guest: false',
    ].join('\n')).rawLogLines;
    expect(deviceIdentity(null, lines)).toEqual({ userId: '@bob:d', deviceId: 'VYTOIDPHBO', curveKey: undefined });
  });
});

describe('deviceFromEntries', () => {
  it('parses every log entry, tags steps with archive and file, and reads details.json', async () => {
    const device = await deviceFromEntries('alice.tar.gz', [
      entry('2026-09-08_ID/details.json', SENDER_DETAILS),
      entry('2026-09-08_ID/logs.2026-09-08-06.log', SENDER_LOG),
      entry('2026-09-08_ID/screenshot.png', 'not a log'),
    ]);
    expect(device.id).toBe('alice.tar.gz');
    expect(device.identity).toEqual({ userId: '@alice:a.org', deviceId: 'ALICEPHONE', curveKey: 'ALICEKEY' });
    expect(device.steps.map((s) => s.kind)).toEqual([
      'share.encrypt', 'todevice.batch', 'todevice.http', 'todevice.sent', 'event.sent',
    ]);
    expect(device.steps[0].line).toEqual({ archive: 'alice.tar.gz', file: 'logs.2026-09-08-06.log', line: 1 });
    expect(device.coverage).toHaveLength(1);
    expect(device.entries).toHaveLength(3);
  });

  it('no identity: no details.json and no setLoggedIn line', async () => {
    const device = await deviceFromEntries('bob.tar.gz', [entry('logs.log', RECEIVER_LOG)]);
    expect(device.identity).toEqual({ userId: undefined, deviceId: undefined, curveKey: undefined });
    expect(device.steps.map((s) => s.kind)).toEqual(['event.utd']);
  });

  it('no crypto lines: loads with zero steps', async () => {
    const device = await deviceFromEntries('quiet.tar.gz', [
      entry('logs.log', '2026-09-08T06:55:10.000000Z  INFO matrix_sdk::sync: hello | crates/matrix-sdk/src/sync.rs:1'),
    ]);
    expect(device.steps).toEqual([]);
    expect(device.coverage).toHaveLength(1);
  });
});

describe('deviceFromFile', () => {
  it('treats a bare .log as a one-entry archive', async () => {
    const device = await deviceFromFile('bob.log', new TextEncoder().encode(RECEIVER_LOG));
    expect(device.id).toBe('bob.log');
    expect(device.entries.map((e) => e.name)).toEqual(['bob.log']);
    expect(device.steps[0].line.file).toBe('bob.log');
  });
});

describe('droppedDevices', () => {
  it('makes one device per archive and one of all the loose logs', () => {
    const [alice, carol, a, b] = ['alice.tar.gz', 'carol.tgz', 'a.log', 'b.log.gz'].map((n) => new File([''], n));
    expect(droppedDevices([a, alice, b, carol])).toEqual([
      { name: 'alice.tar.gz', files: [alice] }, { name: 'carol.tgz', files: [carol] }, { name: 'a.log, b.log.gz', files: [a, b] },
    ]);
  });
});

describe('deviceFromDroppedFiles', () => {
  const dropped = (...files: File[]) => ({ name: files.map((f) => f.name).join(', '), files });
  it('loads a valid log', async () => {
    expect((await deviceFromDroppedFiles(dropped(new File([RECEIVER_LOG], 'bob.log')))).steps.map((s) => s.kind)).toEqual(['event.utd']);
  });
  it('loads several logs of one rageshake as one device', async () => {
    const d = await deviceFromDroppedFiles(dropped(new File([SENDER_LOG], 'a.log'), new File([RECEIVER_LOG], 'b.log')));
    expect(d.id).toBe('a.log, b.log');
    expect(new Set(d.steps.map((s) => s.line.file))).toEqual(new Set(['a.log', 'b.log']));
  });
  it('refuses what the landing page upload refuses, before reading it', async () => {
    await expect(deviceFromDroppedFiles(dropped(new File([RECEIVER_LOG], 'bob.log.gz')))).rejects.toThrow('Not a valid gzip file');
    const huge = new File(['x'], 'huge.log');
    Object.defineProperty(huge, 'size', { value: 600 * 1024 * 1024 });
    await expect(deviceFromDroppedFiles(dropped(new File([RECEIVER_LOG], 'ok.log'), huge))).rejects.toThrow(/File too large .*Maximum is 500MB/);
    const hugeArchive = new File(['x'], 'huge.tar.gz');
    Object.defineProperty(hugeArchive, 'size', { value: 600 * 1024 * 1024 });
    await expect(deviceFromDroppedFiles(dropped(hugeArchive))).rejects.toThrow(/Archive is too large/);
  });
});

describe('deviceFromLoadedLogs', () => {
  it('builds a device from lines already in the log store', () => {
    const lines = parseLogFile(RECEIVER_LOG).rawLogLines;
    const device = deviceFromLoadedLogs('bob.log', lines);
    expect(device.entries).toEqual([]);
    expect(device.steps.map((s) => s.kind)).toEqual(['event.utd']);
    // A single-file parse names no file: the device's name stands for it.
    expect(device.steps[0].line).toMatchObject({ archive: 'bob.log', file: 'bob.log' });
    expect(device.coverage).toHaveLength(1);
  });

  it('keeps the file of merged lines', () => {
    const lines = parseLogFile(RECEIVER_LOG).rawLogLines.map((l) => ({ ...l, sourceFile: 'console.log' }));
    expect(deviceFromLoadedLogs('bob.tar.gz', lines).steps[0].line).toMatchObject({ archive: 'bob.tar.gz', file: 'console.log' });
  });
});

describe('loadedLogSteps', () => {
  it('extracts once per lines array: /summary and /decryption share the work', () => {
    const lines = parseLogFile(RECEIVER_LOG).rawLogLines;
    expect(loadedLogSteps(lines)).toBe(loadedLogSteps(lines));
    expect(loadedLogSteps([...lines])).not.toBe(loadedLogSteps(lines));
    expect(loadedLogSteps(lines).map((s) => s.kind)).toEqual(['event.utd']);
  });
});

describe('detailsFromEntries / deviceFromLoadedLogs with details', () => {
  it('takes the identity from the open archive details.json', () => {
    const details = detailsFromEntries([entry('dir/details.json', SENDER_DETAILS), entry('logs.log', SENDER_LOG)]);
    const device = deviceFromLoadedLogs('alice.tar.gz', parseLogFile(SENDER_LOG).rawLogLines, details);
    expect(device.identity).toEqual({ userId: '@alice:a.org', deviceId: 'ALICEPHONE', curveKey: 'ALICEKEY' });
  });
  it('is null without details.json', () => {
    expect(detailsFromEntries([entry('logs.log', SENDER_LOG)])).toBeNull();
  });
});

describe('linesOfFile', () => {
  it('parses the named file of an added device, numbered as its steps', async () => {
    const d = await deviceFromEntries('alice.tar.gz', [entry('details.json', SENDER_DETAILS), entry('logs/logs.log', SENDER_LOG)]);
    const lines = linesOfFile(d, d.steps[0].line.file);
    expect(lines.find((l) => l.lineNumber === d.steps[0].line.line)?.message).toContain('Trying to encrypt a room key');
    expect(linesOfFile(d, 'missing.log')).toEqual([]);
  });
});

describe('allLinesOf', () => {
  it('parses and merges every log file of the archive, skipping the rest', async () => {
    const d = await deviceFromEntries('alice.tar.gz', [entry('details.json', SENDER_DETAILS), entry('a.log', SENDER_LOG), entry('b.log', RECEIVER_LOG)]);
    const lines = allLinesOf(d);
    expect(lines.length).toBe(SENDER_LOG.split('\n').length + RECEIVER_LOG.split('\n').length);
    expect(new Set(lines.map((l) => l.lineNumber)).size).toBe(lines.length);
  });
});

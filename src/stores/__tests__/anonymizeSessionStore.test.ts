import { describe, it, expect, vi, afterEach } from 'vitest';
import { decompressSync, gzipSync, strFromU8, strToU8 } from 'fflate';
import { phaseProgress, saveJobOutput, useAnonymizeSessionStore } from '../anonymizeSessionStore';
import * as download from '../../utils/downloadBlob';
import { buildTar } from '../../utils/tarWriter';
import { MAX_TAR_GZ_SIZE } from '../../utils/tarGzArchive';
import { parseTar } from '../../utils/tarParser';
import { countUnresolvedAliases, unanonymizeReport } from '../../utils/deanonymizeReport';
import { isIdentifierAlias, MATRIX_IDENTIFIER_RE } from '../../utils/anonymizeUtils';
import { useAnonSaltStore } from '../anonSaltStore';

const bytes = strToU8('@alice:matrix.org joined\n');
// jsdom's File lacks arrayBuffer(), which every browser has.
const fileOf = (data: Uint8Array, name: string) =>
  Object.assign(new File([data], name), { arrayBuffer: () => Promise.resolve(data.buffer) });
const logFile = () => fileOf(bytes, 'console.log');
const archiveFile = () => fileOf(gzipSync(buildTar([{ name: 'rs/console.log', data: bytes }])), 'rs.tar.gz');

describe('anonymizeSessionStore', () => {
  // jsdom has no object URLs; the store holds one per raw archive.
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const initialSalt = useAnonSaltStore.getState().salt;
  afterEach(() => {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    vi.restoreAllMocks();
    useAnonymizeSessionStore.setState({ jobs: [], text: '', driver: 'anonymised', textDict: { forward: {}, reverse: {} } });
    // Back to the first salt. A salt change re-anonymises after a debounce: run that here, not in the next test.
    vi.useFakeTimers();
    useAnonSaltStore.setState({ salt: initialSalt });
    vi.runAllTimers();
    vi.useRealTimers();
  });

  it('downloads each file dropped to anonymise', async () => {
    const spy = vi.spyOn(download, 'downloadBlob').mockImplementation(() => {});
    await useAnonymizeSessionStore.getState().anonymiseFiles([logFile()], true);

    expect(useAnonymizeSessionStore.getState().jobs[0].message).toBe('');
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('@user-'), 'console-anonym.log', 'text/plain');
    expect(useAnonymizeSessionStore.getState().jobs[0].status).toBe('done');
  });

  it('keeps only the mapping of an original dropped to de-anonymise, still savable by hand', async () => {
    const spy = vi.spyOn(download, 'downloadBlob').mockImplementation(() => {});
    await useAnonymizeSessionStore.getState().anonymiseFiles([logFile()], false);
    expect(spy).not.toHaveBeenCalled();
    expect(useAnonymizeSessionStore.getState().jobs[0].output?.dict.reverse).not.toEqual({});

    saveJobOutput(useAnonymizeSessionStore.getState().jobs[0]);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('@user-'), 'console-anonym.log', 'text/plain');
  });

  it('holds the raw archive, reports progress, and replaces an earlier drop of the same file', async () => {
    vi.spyOn(download, 'downloadBlob').mockImplementation(() => {});
    let n = 0;
    URL.createObjectURL = vi.fn(() => `blob:http://localhost/${n++}`);
    const revoke = vi.fn();
    URL.revokeObjectURL = revoke;
    const messages: string[] = [];
    const unsubscribe = useAnonymizeSessionStore.subscribe((s) => { if (s.jobs[0]?.message) messages.push(s.jobs[0].message); });

    await useAnonymizeSessionStore.getState().anonymiseFiles([archiveFile()], true);
    await useAnonymizeSessionStore.getState().anonymiseFiles([archiveFile()], true);
    unsubscribe();

    expect(messages.length).toBeGreaterThan(0);
    const { jobs } = useAnonymizeSessionStore.getState();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].rawUrl).toBe('blob:http://localhost/1');
    expect(jobs[0].output?.name).toBe('rs-anonym.tar.gz');
    expect(revoke).toHaveBeenCalledWith('blob:http://localhost/0');
  });

  it('reads whose log it is from its login line', async () => {
    const log = strToU8('setLoggedIn: mxid: @bob:example.com deviceId: BOBDEV\n');
    await useAnonymizeSessionStore.getState().anonymiseFiles([fileOf(log, 'console.log')], false);

    expect(useAnonymizeSessionStore.getState().jobs[0].output?.identity).toMatchObject({ userId: '@bob:example.com', deviceId: 'BOBDEV' });
  });

  it('reads whose archive it is from its latest login line, whatever the file order', async () => {
    const line = (ts: string, who: string) => strToU8(`${ts} D setLoggedIn: mxid: ${who} deviceId: DEV guest: false\n`);
    const tar = buildTar([
      { name: 'rs/logs-0000.log', data: line('2026-09-07T15:51:38.356Z', '@bob:d') },
      { name: 'rs/logs-0001.log', data: line('2026-09-07T15:49:25.878Z', '@old:d') },
    ]);
    URL.createObjectURL = vi.fn(() => 'blob:http://localhost/0');
    await useAnonymizeSessionStore.getState().anonymiseFiles([fileOf(gzipSync(tar), 'rs.tar.gz')], false);

    expect(useAnonymizeSessionStore.getState().jobs[0].output?.identity).toMatchObject({ userId: '@bob:d' });
  });

  it('marks a file it cannot anonymise as failed', async () => {
    await useAnonymizeSessionStore.getState().anonymiseFiles([fileOf(new Uint8Array([0x89, 0x50, 0, 0, 255]), 'shot.png')], true);

    const [job] = useAnonymizeSessionStore.getState().jobs;
    expect(job.status).toBe('error');
    expect(job.message).toMatch(/not a text log/);
  });

  it('refuses an oversized file without reading it', async () => {
    const huge = Object.defineProperty(logFile(), 'size', { value: MAX_TAR_GZ_SIZE + 1 });
    const read = vi.spyOn(huge, 'arrayBuffer');
    await useAnonymizeSessionStore.getState().anonymiseFiles([huge], true);

    const [job] = useAnonymizeSessionStore.getState().jobs;
    expect(job.status).toBe('error');
    expect(job.message).toMatch(/too large/);
    expect(read).not.toHaveBeenCalled();
  });

  it('forgets every job and mapping, keeping only the anonymised text', () => {
    const revoke = vi.fn();
    URL.revokeObjectURL = revoke;
    useAnonymizeSessionStore.setState({
      jobs: [{ id: 9, sourceName: 'rs.tar.gz', status: 'done', message: '', progress: 1, output: null, salt: 's', file: archiveFile(), rawUrl: 'blob:http://localhost/9' }],
      textDict: { forward: { '@alice:matrix.org': '@user-0123456789ab:domain-01234567.org' }, reverse: { '@user-0123456789ab:domain-01234567.org': '@alice:matrix.org' } },
    });
    useAnonymizeSessionStore.getState().setText('real', '@alice:matrix.org left');

    useAnonymizeSessionStore.getState().forgetAll('@user-0123456789ab:domain-01234567.org left');
    expect(useAnonymizeSessionStore.getState()).toMatchObject({
      jobs: [], text: '@user-0123456789ab:domain-01234567.org left', driver: 'anonymised', textDict: { forward: {}, reverse: {} },
    });
    expect(revoke).toHaveBeenCalledWith('blob:http://localhost/9');
  });

  it('anonymises every finished file again, and the text mapping, when the salt changes', async () => {
    vi.spyOn(download, 'downloadBlob').mockImplementation(() => {});
    useAnonSaltStore.setState({ salt: 'first' });
    const store = useAnonymizeSessionStore.getState();
    await store.anonymiseFiles([logFile()], true);
    await store.anonymiseFiles([fileOf(bytes, 'other.log')], false);
    store.addTextDict({ forward: { '@bob:matrix.org': 'old' }, reverse: { old: '@bob:matrix.org' } });
    const before = useAnonymizeSessionStore.getState().jobs[0].output!.dict.forward['@alice:matrix.org'];

    useAnonSaltStore.setState({ salt: 'second' });
    await store.applySalt();

    const { jobs, textDict } = useAnonymizeSessionStore.getState();
    expect(jobs).toMatchObject([{ status: 'done', salt: 'second' }, { status: 'done', salt: 'second' }]);
    const after = jobs[0].output!.dict.forward['@alice:matrix.org'];
    expect(after).not.toBe(before);
    expect(textDict.forward['@bob:matrix.org']).toMatch(/^@user-[0-9a-f]{12}:domain-/);
    // The file dropped to download is downloaded again, with the new salt; the one dropped for its mapping is not.
    expect(download.downloadBlob).toHaveBeenCalledTimes(2);
    expect(download.downloadBlob).toHaveBeenLastCalledWith(expect.stringContaining(after), 'console-anonym.log', 'text/plain');
  });

  it('drops the output of a file that fails with a new salt, and tries it again with the next', async () => {
    vi.spyOn(download, 'downloadBlob').mockImplementation(() => {});
    useAnonSaltStore.setState({ salt: 'first' });
    const store = useAnonymizeSessionStore.getState();
    let reads = 0;
    const file = Object.assign(new File([bytes], 'console.log'), {
      arrayBuffer: () => (++reads === 2 ? Promise.reject(new Error('gone')) : Promise.resolve(bytes.buffer as ArrayBuffer)),
    });
    await store.anonymiseFiles([file], false);

    useAnonSaltStore.setState({ salt: 'second' });
    await store.applySalt();
    expect(useAnonymizeSessionStore.getState().jobs[0]).toMatchObject({ status: 'error', message: 'gone', output: null });

    useAnonSaltStore.setState({ salt: 'third' });
    await store.applySalt();
    expect(useAnonymizeSessionStore.getState().jobs[0]).toMatchObject({ status: 'done', salt: 'third' });
  });

  it('keeps the text mapping as is when nothing new is added', () => {
    const store = useAnonymizeSessionStore.getState();
    store.addTextDict({ forward: { '@bob:matrix.org': 'old' }, reverse: { old: '@bob:matrix.org' } });
    const before = useAnonymizeSessionStore.getState().textDict;

    store.addTextDict({ forward: { '@bob:matrix.org': 'old' }, reverse: { old: '@bob:matrix.org' } });

    expect(useAnonymizeSessionStore.getState().textDict).toBe(before);
  });

  it('anonymises again a file still in flight when the salt changes', async () => {
    vi.spyOn(download, 'downloadBlob').mockImplementation(() => {});
    useAnonSaltStore.setState({ salt: 'first' });
    const store = useAnonymizeSessionStore.getState();
    // The first read waits for the salt change; the second, with the new salt, does not.
    let read: (() => void) | undefined;
    const file = Object.assign(new File([bytes], 'console.log'), {
      arrayBuffer: () => (read
        ? Promise.resolve(bytes.buffer as ArrayBuffer)
        : new Promise<ArrayBuffer>((resolve) => { read = () => resolve(bytes.buffer as ArrayBuffer); })),
    });
    const drop = store.anonymiseFiles([file], true);
    await vi.waitFor(() => expect(read).toBeDefined()); // reading, with the first salt

    useAnonSaltStore.setState({ salt: 'second' });
    const applying = store.applySalt();
    read!();
    await Promise.all([drop, applying]);

    expect(useAnonymizeSessionStore.getState().jobs[0]).toMatchObject({ status: 'done', salt: 'second' });
  });

  it('keeps URL hosts in the text mapping when the salt changes', async () => {
    useAnonSaltStore.setState({ salt: 'first' });
    const store = useAnonymizeSessionStore.getState();
    store.addTextDict({ forward: { 'matrix.example.org': 'old' }, reverse: { old: 'matrix.example.org' } });

    useAnonSaltStore.setState({ salt: 'second' });
    await store.applySalt();

    expect(useAnonymizeSessionStore.getState().textDict.forward['matrix.example.org']).toMatch(/^domain-[0-9a-f]{8}\.org$/);
  });

  it('does not bring the text mapping back when everything is forgotten during a salt change', async () => {
    const store = useAnonymizeSessionStore.getState();
    store.addTextDict({ forward: { '@bob:matrix.org': 'old' }, reverse: { old: '@bob:matrix.org' } });

    useAnonSaltStore.setState({ salt: 'third' });
    const applying = store.applySalt();
    store.forgetAll('');
    await applying;

    expect(useAnonymizeSessionStore.getState().textDict).toEqual({ forward: {}, reverse: {} });
  });

  it('keeps a result when the same file is dropped twice at once', async () => {
    vi.spyOn(download, 'downloadBlob').mockImplementation(() => {});
    const store = useAnonymizeSessionStore.getState();
    await Promise.all([store.anonymiseFiles([logFile()], true), store.anonymiseFiles([logFile()], false)]);

    // Whichever finishes last replaces the other; the mapping is never lost.
    expect(useAnonymizeSessionStore.getState().jobs).toMatchObject([{ status: 'done', message: '' }]);
  });

  it('stops working on, and saving, files forgotten mid-drop', async () => {
    const spy = vi.spyOn(download, 'downloadBlob').mockImplementation(() => {});
    const store = useAnonymizeSessionStore.getState();
    const drop = store.anonymiseFiles([logFile(), logFile()], true);
    store.forgetAll('');
    await drop;

    expect(spy).not.toHaveBeenCalled();
    expect(useAnonymizeSessionStore.getState().jobs).toEqual([]);
  });

  it('weights the anonymiser phases into one share of the file', () => {
    expect(phaseProgress('Reading files', 5, 10)).toBeCloseTo(0.1);
    expect(phaseProgress('Anonymising files', 0, 10)).toBeCloseTo(0.2);
    expect(phaseProgress('Anonymising files', 10, 10)).toBeCloseTo(0.95);
    expect(phaseProgress('Compressing', 0, 0)).toBeCloseTo(0.95);
    expect(phaseProgress('Reading', 0, 0)).toBe(0);
  });

  it('round trip: a report quoting the anonymised archive reads back with the original dropped for its mapping', async () => {
    vi.spyOn(download, 'downloadBlob').mockImplementation(() => {});
    URL.createObjectURL = vi.fn(() => 'blob:http://localhost/raw');
    URL.revokeObjectURL = vi.fn();
    // Shapes a real Element X log holds: legacy and modern room ids, a room id
    // followed by an event id, percent-encoded ids in URLs, an alias, a server.
    const log = [
      '2026-10-28T07:52:57.001Z INFO matrix_sdk::sync: received sync for @alice:matrix.org',
      '2026-10-28T07:52:57.002Z DEBUG room{room_id="!OGEhHVWSdvArJzumhm:matrix.org"}: timeline reset',
      '2026-10-28T07:52:57.003Z DEBUG send{room_id=!mJwYmKFpHVwcXdtMkoHtzlHgoACAfsPPyqTAYoxPsUM}: event $kbX3HqnFq2r5bXg1N0Wl8Ta1Yc5mT7c3KZ0Wm2yB1sQ sent',
      '2026-10-28T07:52:57.004Z DEBUG link https://matrix.to/#/!mJwYmKFpHVwcXdtMkoHtzlHgoACAfsPPyqTAYoxPsUM/$kbX3HqnFq2r5bXg1N0Wl8Ta1Yc5mT7c3KZ0Wm2yB1sQ',
      '2026-10-28T07:52:57.005Z INFO http: GET https://matrix-client.matrix.org/_matrix/client/v3/rooms/%21OGEhHVWSdvArJzumhm%3Amatrix.org/messages?from=s1',
      '2026-10-28T07:52:57.006Z INFO room alias #element-x:matrix.org resolved for @bob:example.com',
      '',
    ].join('\n');
    const archive = () => fileOf(
      gzipSync(buildTar([
        { name: 'rs/console.2026-10-28-07.log.gz', data: gzipSync(strToU8(log)) },
        { name: 'rs/details.json', data: strToU8('{"data":{"user_id":"@alice:matrix.org","device_id":"ALICEDEV"}}') },
      ])),
      'rs.tar.gz',
    );
    const store = useAnonymizeSessionStore.getState();

    // 1. Anonymise to share, as the top zone does.
    await store.anonymiseFiles([archive()], true);
    const shared = useAnonymizeSessionStore.getState().jobs[0].output!;
    expect(shared.identity).toMatchObject({ userId: '@alice:matrix.org', deviceId: 'ALICEDEV' });
    const entries = parseTar(decompressSync(shared.data as Uint8Array));
    const anonLog = strFromU8(decompressSync(entries.find((e) => e.name.endsWith('.log.gz'))!.data));
    expect(anonLog).not.toContain('matrix.org');

    // 2. The report quotes the anonymised log verbatim, as an analysis would.
    const report = `## What the logs show\n\n${anonLog.split('\n').map((l) => `- \`${l}\``).join('\n')}`;
    const aliases = new Set([...report.matchAll(new RegExp(MATRIX_IDENTIFIER_RE.source, 'g'))].map((m) => m[0]).filter(isIdentifierAlias));
    expect(aliases.size).toBeGreaterThan(4);

    // 3. Later, in a fresh state: the original is dropped on the de-anonymised pane.
    store.forgetAll('');
    await store.anonymiseFiles([archive()], false);
    const sources = useAnonymizeSessionStore.getState().jobs.map((j) => ({ anonymizedName: j.output!.name, dict: j.output!.dict, rawUrl: j.rawUrl }));
    const back = unanonymizeReport(report, sources);

    expect(countUnresolvedAliases(back)).toBe(0);
    expect(back).toBe(`## What the logs show\n\n${log.split('\n').map((l) => `- \`${l}\``).join('\n')}`);
  });
});

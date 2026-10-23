import { describe, it, expect, beforeEach } from 'vitest';
import { useCryptoStore, loadCryptoDevice, currentCaseKey, isInCase, startCase } from '../cryptoStore';
import { useArchiveStore } from '../archiveStore';
import { useLogStore } from '../logStore';
import { parseLogFile } from '../../utils/logParser';
import type { CryptoDevice } from '../../utils/crypto/types';

const device = (name: string): CryptoDevice => ({ id: name, entries: [], identity: {}, steps: [], coverage: [] });

describe('cryptoStore', () => {
  beforeEach(() => useCryptoStore.getState().clear());

  it('dedupes by name', () => {
    useCryptoStore.getState().addDevice(device('a.tar.gz'));
    useCryptoStore.getState().addDevice(device('a.tar.gz'));
    expect(useCryptoStore.getState().devices).toHaveLength(1);
  });

  it('loadCryptoDevice loads once, tracks pending, and records errors', async () => {
    let calls = 0;
    const load = async () => { calls += 1; return device('b.log'); };
    const first = loadCryptoDevice('b.log', load);
    expect(useCryptoStore.getState().pending).toEqual(['b.log']);
    await Promise.all([first, loadCryptoDevice('b.log', load)]);
    expect(calls).toBe(1);
    expect(useCryptoStore.getState()).toMatchObject({ pending: [], errors: [] });

    await loadCryptoDevice('bad.tar.gz', async () => { throw new Error('not a valid archive'); });
    expect(useCryptoStore.getState().errors).toEqual([{ name: 'bad.tar.gz', message: 'not a valid archive' }]);
    expect(useCryptoStore.getState().pending).toEqual([]);
  });

  it('refuses a name already open, with an error: it may be another rageshake', async () => {
    useArchiveStore.getState().loadArchive('logs.tar.gz', [{ name: 'a.log', data: new Uint8Array() }]);
    useLogStore.getState().clearData();
    useLogStore.getState().loadMergedLogParserResults([{ name: 'a.log', result: parseLogFile('2026-09-08T06:55:10.000000Z  INFO x: y | f.rs:1') }]);
    let calls = 0;
    const load = (name: string) => async () => { calls += 1; return device(name); };
    await loadCryptoDevice('b.log', load('b.log'));
    await loadCryptoDevice('b.log', load('b.log'));
    await loadCryptoDevice('logs.tar.gz', load('logs.tar.gz'));
    expect(calls).toBe(1);
    expect(useCryptoStore.getState().errors.map((e) => e.name)).toEqual(['b.log', 'logs.tar.gz']);
  });

  it('a retry that loads forgets the earlier failure of that name', async () => {
    await loadCryptoDevice('bob.log', async () => { throw new Error('offline'); });
    await loadCryptoDevice('bob.log', async () => { throw new Error('still offline'); });
    expect(useCryptoStore.getState().errors).toEqual([{ name: 'bob.log', message: 'still offline' }]);
    await loadCryptoDevice('bob.log', async () => device('bob.log'));
    expect(useCryptoStore.getState()).toMatchObject({ errors: [], devices: [device('bob.log')] });
  });

  it('isInCase: the devices of the case, or of an added device opened as the loaded logs', () => {
    const s = { caseKey: 'bob.tar.gz', caseArchive: { name: 'bob.tar.gz', entries: [] }, devices: [device('alice.tar.gz')] };
    expect(isInCase(s, 'bob.tar.gz')).toBe(true);
    expect(isInCase(s, 'alice.tar.gz')).toBe(true);
    expect(isInCase(s, 'carol.tar.gz')).toBe(false);
    expect(isInCase({ ...s, caseArchive: null }, 'alice.tar.gz')).toBe(false);
  });

  it('drops a load that finishes after its case was replaced', async () => {
    useCryptoStore.getState().resetForCase('alice.tar.gz');
    let finish: (d: CryptoDevice) => void = () => {};
    let fail: (e: Error) => void = () => {};
    const loading = loadCryptoDevice('bob.log', () => new Promise((resolve) => { finish = resolve; }));
    const failing = loadCryptoDevice('bad.log', () => new Promise((_, reject) => { fail = reject; }));
    useCryptoStore.getState().resetForCase('carol.tar.gz');
    finish(device('bob.log'));
    fail(new Error('late'));
    await Promise.all([loading, failing]);
    expect(useCryptoStore.getState()).toMatchObject({ devices: [], errors: [], pending: [], caseKey: 'carol.tar.gz' });
  });

  it('a load from a replaced case leaves the new case loading the same name pending', async () => {
    useCryptoStore.getState().resetForCase('alice.tar.gz');
    let finishOld: (d: CryptoDevice) => void = () => {};
    const old = loadCryptoDevice('bob.log', () => new Promise((resolve) => { finishOld = resolve; }));
    useCryptoStore.getState().resetForCase('carol.tar.gz');
    let finishNew: (d: CryptoDevice) => void = () => {};
    const current = loadCryptoDevice('bob.log', () => new Promise((resolve) => { finishNew = resolve; }));
    finishOld(device('bob.log'));
    await old;
    expect(useCryptoStore.getState().pending).toEqual(['bob.log']);
    finishNew(device('bob.log'));
    await current;
    expect(useCryptoStore.getState()).toMatchObject({ pending: [], devices: [device('bob.log')] });
  });

  it('resetForCase drops devices and errors, records the case', () => {
    const s = useCryptoStore.getState();
    s.addDevice(device('a.tar.gz'));
    s.addError('x', 'y');
    s.resetForCase('bob.tar.gz');
    expect(useCryptoStore.getState()).toMatchObject({
      devices: [], errors: [], caseKey: 'bob.tar.gz',
    });
  });

  it('currentCaseKey is the open archive, else the loaded files', () => {
    useArchiveStore.getState().clearArchive();
    useLogStore.getState().clearData();
    useLogStore.getState().loadMergedLogParserResults([{ name: 'a.log', result: parseLogFile('2026-09-08T06:55:10.000000Z  INFO x: y | f.rs:1') }]);
    expect(currentCaseKey()).toBe('a.log');
    useArchiveStore.getState().loadArchive('bob.tar.gz', [{ name: 'a.log', data: new Uint8Array() }]);
    expect(currentCaseKey()).toBe('bob.tar.gz');
  });

  it('startCase drops added devices and remembers the archive the loaded logs come from', () => {
    const entries = [{ name: 'a.log', data: new Uint8Array() }];
    useArchiveStore.getState().loadArchive('bob.tar.gz', entries);
    useLogStore.getState().clearData();
    useLogStore.getState().loadMergedLogParserResults([{ name: 'a.log', result: parseLogFile('2026-09-08T06:55:10.000000Z  INFO x: y | f.rs:1') }]);
    useCryptoStore.getState().addDevice(device('alice.tar.gz'));
    startCase();
    expect(useCryptoStore.getState()).toMatchObject({ devices: [], caseKey: 'bob.tar.gz', caseArchive: { name: 'bob.tar.gz', entries } });

    useLogStore.getState().loadMergedLogParserResults([{ name: 'carol.log', result: parseLogFile('2026-09-08T06:55:10.000000Z  INFO x: y | f.rs:1') }]);
    startCase();
    expect(useCryptoStore.getState()).toMatchObject({ caseKey: 'carol.log', caseArchive: null });
  });

  it('currentCaseKey ignores a stale archive the loaded logs do not come from', () => {
    useArchiveStore.getState().loadArchive('bob.tar.gz', [{ name: 'logs.log', data: new Uint8Array() }]);
    useLogStore.getState().clearData();
    useLogStore.getState().loadMergedLogParserResults([{ name: 'carol.log', result: parseLogFile('2026-09-08T06:55:10.000000Z  INFO x: y | f.rs:1') }]);
    expect(currentCaseKey()).toBe('carol.log');
  });

  it('sets and clears a sender override per session; a new case forgets them', () => {
    useCryptoStore.getState().setSenderOverride('S', 'alice.tar.gz');
    useCryptoStore.getState().setSenderOverride('T', 'carol.log');
    useCryptoStore.getState().setSenderOverride('T', null);
    expect(useCryptoStore.getState().senderOverrides).toEqual({ S: 'alice.tar.gz' });
    useCryptoStore.getState().resetForCase('bob.tar.gz');
    expect(useCryptoStore.getState().senderOverrides).toEqual({});
  });
});

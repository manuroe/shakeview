import { describe, it, expect, vi, afterEach } from 'vitest';
import { decompressSync, gzipSync, strFromU8, strToU8 } from 'fflate';
import { phaseProgress, saveJobOutput, useAnonymizeSessionStore } from '../anonymizeSessionStore';
import * as download from '../../utils/downloadBlob';
import { buildTar } from '../../utils/tarWriter';
import { MAX_TAR_GZ_SIZE } from '../../utils/tarGzArchive';
import { parseTar } from '../../utils/tarParser';
import { countUnresolvedAliases, unanonymizeReport } from '../../utils/deanonymizeReport';
import { isIdentifierAlias, MATRIX_IDENTIFIER_RE } from '../../utils/anonymizeUtils';

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
  afterEach(() => {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    vi.restoreAllMocks();
    useAnonymizeSessionStore.setState({ jobs: [], batch: null, report: '' });
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

  it('forgets every job and mapping, keeping the anonymised text', () => {
    const revoke = vi.fn();
    URL.revokeObjectURL = revoke;
    useAnonymizeSessionStore.setState({
      jobs: [{ id: 9, sourceName: 'rs.tar.gz', status: 'done', message: '', progress: 1, output: null, rawUrl: 'blob:http://localhost/9', save: true }],
    });
    useAnonymizeSessionStore.getState().setReport('# Case');
    expect(useAnonymizeSessionStore.getState().report).toBe('# Case');

    useAnonymizeSessionStore.getState().forgetAll();
    expect(useAnonymizeSessionStore.getState()).toMatchObject({ jobs: [], batch: null, report: '# Case' });
    expect(revoke).toHaveBeenCalledWith('blob:http://localhost/9');
  });

  it('joins a drop to the notice still showing, and starts afresh once it is dismissed', async () => {
    vi.spyOn(download, 'downloadBlob').mockImplementation(() => {});
    const store = useAnonymizeSessionStore.getState();
    await store.anonymiseFiles([logFile()], true);
    await store.anonymiseFiles([logFile()], true);
    // Same name: the second result replaces the first job, but the batch still names both ids.
    expect(useAnonymizeSessionStore.getState().batch?.jobIds).toHaveLength(2);

    store.dismissBatch();
    await store.anonymiseFiles([logFile()], true);
    expect(useAnonymizeSessionStore.getState().batch).toEqual({ jobIds: [expect.any(Number)], dismissed: false });
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
    store.forgetAll();
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
        { name: 'rs/details.json', data: strToU8('{"user_id":"@alice:matrix.org"}') },
      ])),
      'rs.tar.gz',
    );
    const store = useAnonymizeSessionStore.getState();

    // 1. Anonymise to share, as the top zone does.
    await store.anonymiseFiles([archive()], true);
    const shared = useAnonymizeSessionStore.getState().jobs[0].output!;
    const entries = parseTar(decompressSync(shared.data as Uint8Array));
    const anonLog = strFromU8(decompressSync(entries.find((e) => e.name.endsWith('.log.gz'))!.data));
    expect(anonLog).not.toContain('matrix.org');

    // 2. The report quotes the anonymised log verbatim, as an analysis would.
    const report = `## What the logs show\n\n${anonLog.split('\n').map((l) => `- \`${l}\``).join('\n')}`;
    const aliases = new Set([...report.matchAll(new RegExp(MATRIX_IDENTIFIER_RE.source, 'g'))].map((m) => m[0]).filter(isIdentifierAlias));
    expect(aliases.size).toBeGreaterThan(4);

    // 3. Later, in a fresh state: the original is dropped on the de-anonymised pane.
    store.forgetAll();
    await store.anonymiseFiles([archive()], false);
    const sources = useAnonymizeSessionStore.getState().jobs.map((j) => ({ anonymizedName: j.output!.name, dict: j.output!.dict, rawUrl: j.rawUrl }));
    const back = unanonymizeReport(report, sources);

    expect(countUnresolvedAliases(back)).toBe(0);
    expect(back).toBe(`## What the logs show\n\n${log.split('\n').map((l) => `- \`${l}\``).join('\n')}`);
  });
});

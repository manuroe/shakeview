import { describe, it, expect, vi, afterEach } from 'vitest';
import { gzipSync, strToU8 } from 'fflate';
import { saveJobOutput, useAnonymizeSessionStore } from '../anonymizeSessionStore';
import * as download from '../../utils/downloadBlob';
import { buildTar } from '../../utils/tarWriter';
import { MAX_TAR_GZ_SIZE } from '../../utils/tarGzArchive';

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
    useAnonymizeSessionStore.setState({ jobs: [], report: '', autoSave: true });
  });

  it('downloads each anonymised file when auto-save is on', async () => {
    const spy = vi.spyOn(download, 'downloadBlob').mockImplementation(() => {});
    await useAnonymizeSessionStore.getState().anonymiseFiles([logFile()]);

    expect(useAnonymizeSessionStore.getState().jobs[0].message).toBe('');
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('@user-'), 'console-anonym.log', 'text/plain');
    expect(useAnonymizeSessionStore.getState().jobs[0].status).toBe('done');
  });

  it('keeps the file for a manual save when auto-save is off', async () => {
    const spy = vi.spyOn(download, 'downloadBlob').mockImplementation(() => {});
    useAnonymizeSessionStore.getState().setAutoSave(false);
    await useAnonymizeSessionStore.getState().anonymiseFiles([logFile()]);
    expect(spy).not.toHaveBeenCalled();

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

    await useAnonymizeSessionStore.getState().anonymiseFiles([archiveFile()]);
    await useAnonymizeSessionStore.getState().anonymiseFiles([archiveFile()]);
    unsubscribe();

    expect(messages.length).toBeGreaterThan(0);
    const { jobs } = useAnonymizeSessionStore.getState();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].rawUrl).toBe('blob:http://localhost/1');
    expect(jobs[0].output?.name).toBe('rs-anonym.tar.gz');
    expect(revoke).toHaveBeenCalledWith('blob:http://localhost/0');
  });

  it('marks a file it cannot anonymise as failed', async () => {
    await useAnonymizeSessionStore.getState().anonymiseFiles([fileOf(new Uint8Array([0x89, 0x50, 0, 0, 255]), 'shot.png')]);

    const [job] = useAnonymizeSessionStore.getState().jobs;
    expect(job.status).toBe('error');
    expect(job.message).toMatch(/not a text log/);
  });

  it('refuses an oversized file without reading it', async () => {
    const huge = Object.defineProperty(logFile(), 'size', { value: MAX_TAR_GZ_SIZE + 1 });
    const read = vi.spyOn(huge, 'arrayBuffer');
    await useAnonymizeSessionStore.getState().anonymiseFiles([huge]);

    const [job] = useAnonymizeSessionStore.getState().jobs;
    expect(job.status).toBe('error');
    expect(job.message).toMatch(/too large/);
    expect(read).not.toHaveBeenCalled();
  });

  it('forgets every job and the report', () => {
    const revoke = vi.fn();
    URL.revokeObjectURL = revoke;
    useAnonymizeSessionStore.setState({
      jobs: [{ id: 9, sourceName: 'rs.tar.gz', status: 'done', message: '', output: null, rawUrl: 'blob:http://localhost/9' }],
    });
    useAnonymizeSessionStore.getState().setReport('# Case');
    expect(useAnonymizeSessionStore.getState().report).toBe('# Case');

    useAnonymizeSessionStore.getState().forgetAll();
    expect(useAnonymizeSessionStore.getState()).toMatchObject({ jobs: [], report: '' });
    expect(revoke).toHaveBeenCalledWith('blob:http://localhost/9');
  });
});

import { create } from 'zustand';
import { anonymiseDroppedFile, type AnonymisedFile } from '../utils/anonymizeArchive';
import { downloadBlob } from '../utils/downloadBlob';
import { assertArchiveSizeOk } from '../utils/tarGzArchive';
import { useAnonSaltStore } from './anonSaltStore';

/** One file dropped on the anonymise page, from queued to downloaded. */
export interface AnonymizeJob {
  readonly id: number;
  readonly sourceName: string;
  readonly status: 'working' | 'done' | 'error';
  /** Progress phase while working, the reason when it failed. */
  readonly message: string;
  /** 0–1 while working (see `phaseProgress`), 1 once finished. */
  readonly progress: number;
  /** The anonymised file and its mapping, once done — kept so it can be saved (again) from the list. */
  readonly output: AnonymisedFile | null;
  /** `blob:` URL of the raw archive, so a report link can open the real log; null for single logs. */
  readonly rawUrl: string | null;
  /**
   * Download the anonymised file once done. Set by where it was dropped: true on
   * the anonymise zone, false for an original dropped only for its mapping.
   */
  readonly save: boolean;
}

/**
 * The files of the drops the progress notice reports on. A drop while the
 * notice is still up joins it, so one notice covers everything in flight.
 */
export interface AnonymizeBatch {
  readonly jobIds: readonly number[];
  readonly dismissed: boolean;
}

interface AnonymizeSessionStore {
  jobs: readonly AnonymizeJob[];
  batch: AnonymizeBatch | null;
  /** Report text pasted or dropped on the page, kept across in-app navigation. */
  report: string;
  /**
   * Anonymise each file in turn, keeping its mapping. With `save`, each result
   * downloads as soon as it is ready; without, only the mapping is wanted.
   */
  anonymiseFiles: (files: readonly File[], save: boolean) => Promise<void>;
  setReport: (report: string) => void;
  dismissBatch: () => void;
  /** Drop every raw file and mapping held for this tab. The text pasted is kept: it holds no real identifier. */
  forgetAll: () => void;
}

/**
 * Share of a file's anonymisation done, from an `anonymiseDroppedFile`
 * progress report. Reading is quick, rewriting every file is the bulk, and
 * compressing ends it — so the phases get 20%, 75% and the last 5%. The
 * dictionary build between reading and rewriting reports nothing, so the bar
 * holds at 20% meanwhile.
 *
 * @example
 * ```ts
 * phaseProgress('Anonymising files', 5, 10); // 0.575
 * ```
 */
export function phaseProgress(phase: string, current: number, total: number): number {
  const share = total > 0 ? current / total : 0;
  if (phase === 'Reading files') return 0.2 * share;
  if (phase === 'Anonymising files') return 0.2 + 0.75 * share;
  if (phase === 'Compressing') return 0.95;
  return 0;
}

/** Download a finished job's anonymised file. */
export function saveJobOutput(job: AnonymizeJob): void {
  if (job.output) downloadBlob(job.output.data, job.output.name, job.output.mime);
}

let nextId = 0;

/**
 * State of the anonymise page: what it anonymised and the mappings to reverse it.
 *
 * Nothing is persisted. Raw rageshakes and mappings hold the real
 * identifiers, so they live in this tab's memory only: closing or
 * reloading the tab forgets them, and de-anonymising later means dropping the
 * original rageshake again (aliases are a pure function of the salt, so it
 * rebuilds the same mapping).
 */
export const useAnonymizeSessionStore = create<AnonymizeSessionStore>()((set, get) => {
  const update = (id: number, patch: Partial<AnonymizeJob>) =>
    set((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)) }));

  return {
    jobs: [],
    batch: null,
    report: '',

    anonymiseFiles: async (files, save) => {
      const salt = useAnonSaltStore.getState().salt;
      // Queue the whole drop first, so progress can say "2/3".
      // A drop joins the notice still showing.
      const open = get().batch?.dismissed === false ? get().batch : null;
      const queued: AnonymizeJob[] = files.map((file) => ({
        id: nextId++, sourceName: file.name, status: 'working', message: 'Waiting', progress: 0, output: null, rawUrl: null, save,
      }));
      set((s) => ({
        jobs: [...s.jobs, ...queued],
        batch: { jobIds: [...(open?.jobIds ?? []), ...queued.map((j) => j.id)], dismissed: false },
      }));
      // Sequential: one archive's bytes in memory at a time, and the
      // downloads arrive in drop order.
      for (const [i, file] of files.entries()) {
        const { id } = queued[i];
        // Forget all, meanwhile: nothing left to show or save it.
        const forgotten = () => !get().jobs.some((j) => j.id === id);
        if (forgotten()) continue;
        update(id, { message: 'Reading' });
        try {
          // Before reading, like the start page's drop zone: an oversized file never enters memory.
          assertArchiveSizeOk(file.size);
          const out = await anonymiseDroppedFile(
            file.name,
            new Uint8Array(await file.arrayBuffer()),
            salt,
            (phase, current, total) => update(id, {
              message: total > 0 ? `${phase} ${current}/${total}` : phase,
              progress: phaseProgress(phase, current, total),
            }),
          );
          if (forgotten()) continue;
          if (save) downloadBlob(out.data, out.name, out.mime);
          // A File is a Blob: the URL references it, no copy of the bytes.
          const rawUrl = out.isArchive ? URL.createObjectURL(file) : null;
          // Dropping the same file again replaces the earlier result. Only a finished
          // one: a same-name job still working replaces this one in turn when done.
          const replaced = (j: AnonymizeJob) => j.id !== id && j.sourceName === file.name && j.status !== 'working';
          for (const old of get().jobs) if (replaced(old) && old.rawUrl) URL.revokeObjectURL(old.rawUrl);
          set((s) => ({
            jobs: s.jobs
              .filter((j) => !replaced(j))
              .map((j) => (j.id === id ? { ...j, status: 'done', message: '', progress: 1, output: out, rawUrl } : j)),
          }));
        } catch (e) {
          update(id, { status: 'error', progress: 1, message: e instanceof Error ? e.message : 'Could not anonymise this file.' });
        }
      }
    },

    setReport: (report) => set({ report }),

    dismissBatch: () => set((s) => ({ batch: s.batch && { ...s.batch, dismissed: true } })),

    forgetAll: () => {
      for (const j of get().jobs) if (j.rawUrl) URL.revokeObjectURL(j.rawUrl);
      set({ jobs: [], batch: null });
    },
  };
});

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
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
  /** The anonymised file and its mapping, once done — kept so it can be saved again (or at all, with auto-save off). */
  readonly output: AnonymisedFile | null;
  /** `blob:` URL of the raw archive, so a report link can open the real log; null for single logs. */
  readonly rawUrl: string | null;
}

interface AnonymizeSessionStore {
  jobs: readonly AnonymizeJob[];
  /** Download each anonymised file as soon as it is ready. The only persisted field. */
  autoSave: boolean;
  setAutoSave: (autoSave: boolean) => void;
  /** Report text pasted or dropped on the page, kept across in-app navigation. */
  report: string;
  /** Anonymise each file in turn, downloading each result when `autoSave` is on. */
  anonymiseFiles: (files: readonly File[]) => Promise<void>;
  setReport: (report: string) => void;
  /** Drop every raw file and mapping held for this tab. */
  forgetAll: () => void;
}

/** Download a finished job's anonymised file. */
export function saveJobOutput(job: AnonymizeJob): void {
  if (job.output) downloadBlob(job.output.data, job.output.name, job.output.mime);
}

let nextId = 0;

/**
 * State of the anonymise page: what it anonymised and the mappings to reverse it.
 *
 * Only the auto-save preference is persisted. Raw rageshakes and mappings hold
 * the real identifiers, so they live in this tab's memory only: closing or
 * reloading the tab forgets them, and de-anonymising later means dropping the
 * original rageshake again (aliases are a pure function of the salt, so it
 * rebuilds the same mapping).
 */
export const useAnonymizeSessionStore = create<AnonymizeSessionStore>()(persist((set, get) => {
  const update = (id: number, patch: Partial<AnonymizeJob>) =>
    set((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)) }));

  return {
    jobs: [],
    autoSave: true,
    report: '',

    setAutoSave: (autoSave) => set({ autoSave }),

    anonymiseFiles: async (files) => {
      const salt = useAnonSaltStore.getState().salt;
      // Sequential: one archive's bytes in memory at a time, and the
      // downloads arrive in drop order.
      for (const file of files) {
        const id = nextId++;
        const job: AnonymizeJob = {
          id, sourceName: file.name, status: 'working', message: 'Reading', output: null, rawUrl: null,
        };
        set((s) => ({ jobs: [...s.jobs, job] }));
        try {
          // Before reading, like the start page's drop zone: an oversized file never enters memory.
          assertArchiveSizeOk(file.size);
          const out = await anonymiseDroppedFile(
            file.name,
            new Uint8Array(await file.arrayBuffer()),
            salt,
            (phase, current, total) => update(id, { message: total > 0 ? `${phase} ${current}/${total}` : phase }),
          );
          if (get().autoSave) downloadBlob(out.data, out.name, out.mime);
          // A File is a Blob: the URL references it, no copy of the bytes.
          const rawUrl = out.isArchive ? URL.createObjectURL(file) : null;
          // Dropping the same file again replaces the earlier result.
          for (const old of get().jobs) {
            if (old.id !== id && old.sourceName === file.name && old.rawUrl) URL.revokeObjectURL(old.rawUrl);
          }
          set((s) => ({
            jobs: s.jobs
              .filter((j) => j.id === id || j.sourceName !== file.name)
              .map((j) => (j.id === id ? { ...j, status: 'done', message: '', output: out, rawUrl } : j)),
          }));
        } catch (e) {
          update(id, { status: 'error', message: e instanceof Error ? e.message : 'Could not anonymise this file.' });
        }
      }
    },

    setReport: (report) => set({ report }),

    forgetAll: () => {
      for (const j of get().jobs) if (j.rawUrl) URL.revokeObjectURL(j.rawUrl);
      set({ jobs: [], report: '' });
    },
  };
}, {
  name: 'anonymize-auto-save',
  partialize: (s) => ({ autoSave: s.autoSave }),
}));

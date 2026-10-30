import { create } from 'zustand';
import type { AnonymizationDictionary } from '../types/log.types';
import { anonymiseDroppedFile, decodeEntryText, type AnonymisedFile } from '../utils/anonymizeArchive';
import { buildAnonymizationDictionaryFromTexts } from '../utils/anonymizeUtils';
import { downloadBlob } from '../utils/downloadBlob';
import { parseLogFile } from '../utils/logParser';
import { assertArchiveSizeOk, parseTarGzArchive } from '../utils/tarGzArchive';
import { useArchiveStore } from './archiveStore';
import { useLogStore } from './logStore';
import { useAnonSaltStore } from './anonSaltStore';

/** One file dropped on the anonymise page, from queued to anonymised. */
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
  /** Salt the file was last anonymised with: a salt change anonymises it again. */
  readonly salt: string | null;
  /** Dropped to download: a salt change downloads the new anonymisation too. */
  readonly save: boolean;
  /** The file as dropped, so a salt change can anonymise it again. */
  readonly file: File;
  /** `blob:` URL of the raw archive, so a report link can open the real log; null for single logs. */
  readonly rawUrl: string | null;
}

/** Which pane holds the text typed or loaded; the other pane is derived from it. */
export type TextSide = 'real' | 'anonymised';

const emptyDict = (): AnonymizationDictionary => ({ forward: {}, reverse: {} });

interface AnonymizeSessionStore {
  jobs: readonly AnonymizeJob[];
  /** Text typed, pasted or dropped on the page, kept across in-app navigation. */
  text: string;
  /** The pane `text` belongs to. */
  driver: TextSide;
  /**
   * Mapping of the identifiers typed on the real side, so they read back once
   * the anonymised side drives. Holds real identifiers: memory only.
   */
  textDict: AnonymizationDictionary;
  /**
   * Anonymise each file in turn, keeping its mapping. With `save`, each result
   * downloads as soon as it is ready; without, only the mapping is wanted.
   */
  anonymiseFiles: (files: readonly File[], save: boolean) => Promise<void>;
  setText: (driver: TextSide, text: string) => void;
  addTextDict: (dict: AnonymizationDictionary) => void;
  /** Anonymise every finished file again, and rebuild the text mapping, with the current salt. */
  applySalt: () => Promise<void>;
  /**
   * Drop every raw file and mapping held for this tab. Only `anonymisedText` is
   * kept, on the anonymised side: it holds no real identifier.
   */
  forgetAll: (anonymisedText: string) => void;
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

/**
 * Load a finished job into the viewer, like a drop on the start page, and return
 * the route to land on. A file loaded above the anonymised side opens as its
 * anonymised copy, one loaded above the real side as dropped.
 */
export async function openJob(job: AnonymizeJob): Promise<string> {
  const { output } = job;
  if (!output) throw new Error('Not anonymised yet');
  const name = job.save ? output.name : job.sourceName;
  const data = job.save ? output.data : new Uint8Array(await job.file.arrayBuffer());
  if (output.isArchive) {
    useArchiveStore.getState().loadArchive(name, parseTarGzArchive(data as Uint8Array));
    return '/archive';
  }
  // Decodes as it did to anonymise, so never null here.
  const text = typeof data === 'string' ? data : decodeEntryText({ name, data })!;
  useLogStore.getState().loadMergedLogParserResults([{ name, result: parseLogFile(text) }]);
  return '/summary';
}

let nextId = 0;
// One file at a time across drops and salt changes: one archive's bytes in
// memory at a time, downloads in drop order, and each run reads the salt current
// when it starts.
let queue: Promise<void> = Promise.resolve();

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

  const run = async (id: number) => {
    const job = get().jobs.find((j) => j.id === id);
    // Forget all, meanwhile: nothing left to show or save it.
    if (!job) return;
    const forgotten = () => !get().jobs.some((j) => j.id === id);
    const salt = useAnonSaltStore.getState().salt;
    const { file, save } = job;
    update(id, { status: 'working', message: 'Reading', progress: 0 });
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
      if (forgotten()) return;
      if (save) downloadBlob(out.data, out.name, out.mime);
      // A File is a Blob: the URL references it, no copy of the bytes.
      const rawUrl = job.rawUrl ?? (out.isArchive ? URL.createObjectURL(file) : null);
      // Dropping the same file again replaces the earlier result. Only a finished
      // one: a same-name job still working replaces this one in turn when done.
      const replaced = (j: AnonymizeJob) => j.id !== id && j.sourceName === file.name && j.status !== 'working';
      for (const old of get().jobs) if (replaced(old) && old.rawUrl) URL.revokeObjectURL(old.rawUrl);
      set((s) => ({
        jobs: s.jobs
          .filter((j) => !replaced(j))
          .map((j) => (j.id === id ? { ...j, status: 'done', message: '', progress: 1, output: out, salt, rawUrl } : j)),
      }));
    } catch (e) {
      // An earlier salt's output would map aliases this salt never makes. Its salt
      // stays, so the next salt change tries again.
      update(id, { status: 'error', progress: 1, output: null, message: e instanceof Error ? e.message : 'Could not anonymise this file.' });
    }
  };

  const enqueue = (ids: readonly number[]) => {
    for (const id of ids) queue = queue.then(() => run(id));
    return queue;
  };

  return {
    jobs: [],
    text: '',
    driver: 'anonymised',
    textDict: emptyDict(),

    anonymiseFiles: (files, save) => {
      const queued: AnonymizeJob[] = files.map((file) => ({
        id: nextId++, sourceName: file.name, status: 'working', message: 'Waiting', progress: 0, output: null, salt: null, save, file, rawUrl: null,
      }));
      set((s) => ({ jobs: [...s.jobs, ...queued] }));
      return enqueue(queued.map((j) => j.id));
    },

    setText: (driver, text) => set({ driver, text }),

    addTextDict: (dict) => {
      // Nothing new, nothing set: a new textDict would drop a salt change's rebuild (see applySalt).
      const { forward } = get().textDict;
      if (Object.entries(dict.forward).every(([id, alias]) => forward[id] === alias)) return;
      set((s) => ({
        textDict: { forward: { ...s.textDict.forward, ...dict.forward }, reverse: { ...s.textDict.reverse, ...dict.reverse } },
      }));
    },

    applySalt: async () => {
      const { salt } = useAnonSaltStore.getState();
      // Behind the files in flight: one still working now finishes with the old salt, so is stale then.
      const files = queue.then(async () => {
        // A re-run that failed is tried again; a first failure has no salt: the file is bad.
        const current = useAnonSaltStore.getState().salt;
        const stale = get().jobs.filter((j) => j.salt !== null && (j.status === 'error' || (j.status === 'done' && j.salt !== current)));
        for (const j of stale) update(j.id, { status: 'working', message: 'Waiting', progress: 0 });
        for (const j of stale) await run(j.id);
      });
      queue = files;
      const before = get().textDict;
      // URL hosts are keyed bare: back in a URL, so the scan finds them again.
      const ids = Object.keys(before.forward).map((id) => (/^[@#!$%]/.test(id) ? id : `https://${id}/`));
      if (ids.length > 0) {
        const dict = await buildAnonymizationDictionaryFromTexts([ids.join('\n')], salt);
        // Not after a newer salt, nor after Forget all: it would bring the forgotten IDs back.
        if (useAnonSaltStore.getState().salt === salt && get().textDict === before) set({ textDict: dict });
      }
      await files;
    },

    forgetAll: (anonymisedText) => {
      for (const j of get().jobs) if (j.rawUrl) URL.revokeObjectURL(j.rawUrl);
      set({ jobs: [], text: anonymisedText, driver: 'anonymised', textDict: emptyDict() });
    },
  };
});

// The salt field writes on every keystroke: re-anonymise once typing settles.
let saltTimer: ReturnType<typeof setTimeout> | undefined;
useAnonSaltStore.subscribe((s, prev) => {
  if (s.salt === prev.salt) return;
  clearTimeout(saltTimer);
  saltTimer = setTimeout(() => { void useAnonymizeSessionStore.getState().applySalt(); }, 500);
});

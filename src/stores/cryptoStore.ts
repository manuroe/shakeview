/**
 * Devices added on the /decryption view next to the loaded logs: other people's
 * rageshakes, typically the sender's. The loaded logs themselves (the main
 * device) live in logStore like for every other view. Added devices belong to
 * one case — the loaded logs they were added for — and are dropped when the
 * loaded logs switch to another archive. Not persisted: devices hold raw bytes.
 */
import { create } from 'zustand';
import { useArchiveStore, type ArchiveEntry } from './archiveStore';
import { useLogStore } from './logStore';
import type { CryptoDevice } from '../utils/crypto/types';

interface CryptoStore {
  readonly devices: readonly CryptoDevice[];
  /** Names being loaded right now. */
  readonly pending: readonly string[];
  readonly errors: readonly { readonly name: string; readonly message: string }[];
  /** The loaded logs the added devices belong to (see currentCaseKey). */
  readonly caseKey: string | null;
  /**
   * The archive the case started from, kept so that visiting an added device's
   * archive (a step link re-opens it) does not lose it: it joins as a device.
   */
  readonly caseArchive: { readonly name: string; readonly entries: readonly ArchiveEntry[] } | null;
  addDevice: (device: CryptoDevice) => void;
  setPending: (name: string, pending: boolean) => void;
  addError: (name: string, message: string) => void;
  /** Start a new case: no added devices or errors. */
  resetForCase: (caseKey: string, caseArchive?: CryptoStore['caseArchive']) => void;
  clear: () => void;
}

/** A fresh empty state: no shared arrays between resets. */
const empty = () => ({ devices: [], pending: [], errors: [], caseKey: null, caseArchive: null });

/** The devices added on /decryption, for the case of the loaded logs. */
export const useCryptoStore = create<CryptoStore>((set) => ({
  ...empty(),
  addDevice: (device) => set((s) => (
    s.devices.some((d) => d.id === device.id) ? s : { devices: [...s.devices, device] }
  )),
  setPending: (name, pending) => set((s) => ({
    pending: pending ? [...s.pending, name] : s.pending.filter((n) => n !== name),
  })),
  addError: (name, message) => set((s) => ({ errors: [...s.errors, { name, message }] })),
  resetForCase: (caseKey, caseArchive = null) => set({ ...empty(), caseKey, caseArchive }),
  clear: () => set(empty()),
}));

/**
 * The archive the loaded logs come from, or null. archiveStore keeps the last
 * archive after a plain log is opened, so it only counts when every loaded
 * file is one of its entries.
 */
export function loadedArchive(archiveName: string, archiveEntries: readonly ArchiveEntry[], loadedEntryNames: readonly string[]): string | null {
  const fromArchive = loadedEntryNames.length > 0 && loadedEntryNames.every((n) => archiveEntries.some((e) => e.name === n));
  return archiveName && fromArchive ? archiveName : null;
}

/** Identifies the loaded logs: their archive, else the open log files. */
export function caseKeyOf(archiveName: string, archiveEntries: readonly ArchiveEntry[], loadedEntryNames: readonly string[]): string {
  return loadedArchive(archiveName, archiveEntries, loadedEntryNames) ?? loadedEntryNames.join('+');
}

/** The case key of what is loaded now, read from the stores: for callers outside React. */
export function currentCaseKey(): string {
  const { archiveName, archiveEntries } = useArchiveStore.getState();
  return caseKeyOf(archiveName, archiveEntries, useLogStore.getState().loadedEntryNames);
}

/** Start a new case for the loaded logs, remembering their archive if they come from one. */
export function startCase(): void {
  const { archiveName, archiveEntries } = useArchiveStore.getState();
  const archive = loadedArchive(archiveName, archiveEntries, useLogStore.getState().loadedEntryNames);
  useCryptoStore.getState().resetForCase(currentCaseKey(), archive ? { name: archive, entries: archiveEntries } : null);
}

/**
 * Load a device once per name; concurrent calls for the same name are no-ops.
 * A load that finishes after its case was replaced is dropped: it belongs to other logs.
 */
export async function loadCryptoDevice(name: string, load: () => Promise<CryptoDevice>): Promise<void> {
  const state = useCryptoStore.getState();
  if (state.pending.includes(name) || state.devices.some((d) => d.id === name)) return;
  const { caseKey } = state;
  const sameCase = () => useCryptoStore.getState().caseKey === caseKey;
  state.setPending(name, true);
  try {
    const device = await load();
    if (sameCase()) useCryptoStore.getState().addDevice(device);
  } catch (err) {
    if (sameCase()) useCryptoStore.getState().addError(name, err instanceof Error ? err.message : String(err));
  } finally {
    // A replaced case starts with nothing pending: its own load of this name may be running.
    if (sameCase()) useCryptoStore.getState().setPending(name, false);
  }
}

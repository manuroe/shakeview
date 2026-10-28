/**
 * Turn a rageshake (archive entries, a dropped file, or logs already open) into a
 * `CryptoDevice`: its identity, its crypto steps, and the time its logs cover.
 * Parsed lines are dropped once their steps are extracted.
 */
import { decompressSync } from 'fflate';
import type { ArchiveEntry } from '../../stores/archiveStore';
import type { ParsedLogLine } from '../../types/log.types';
import type { ListingDetails } from '../../types/listing';
import { isAnalyzableEntry } from '../archiveSummary';
import { mergeLogParserResults } from '../mergeLogParserResults';
import { parseDetailsJson } from '../detailsJson';
import { decodeTextBytes, readBlob, validateGzipFile, validateTextFile } from '../fileValidator';
import { parseLogFile } from '../logParser';
import { assertArchiveSizeOk, parseTarGzArchive, TAR_GZ_NAME } from '../tarGzArchive';
import { getMinMaxTimestamps } from '../timeUtils';
import { byTs } from './buildCryptoModel';
import { deviceIdentity } from './identity';
import { extractSteps } from './steps';
import type { CryptoDevice, CryptoStep, DeviceCoverage } from './types';

const basename = (name: string): string => name.split('/').pop() ?? name;
const yieldToUi = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function entryText(e: ArchiveEntry): string {
  return decodeTextBytes(e.name.toLowerCase().endsWith('.gz') ? decompressSync(e.data) : e.data);
}

function coverageOf(lines: readonly ParsedLogLine[]): DeviceCoverage | null {
  const { min, max } = getMinMaxTimestamps(lines);
  return max > 0 ? { start: min, end: max } : null;
}

/**
 * The `details.json` of an archive, if it has one: who the device is.
 *
 * @example detailsFromEntries(archiveEntries)?.userId // '@alice:a.org'
 */
export function detailsFromEntries(entries: readonly ArchiveEntry[]): ListingDetails | null {
  const d = entries.find((e) => basename(e.name) === 'details.json');
  return d ? parseDetailsJson(decodeTextBytes(d.data)) : null;
}

/**
 * One device from archive entries: a sender rageshake added on /decryption. Yields to the UI between log files.
 *
 * @example (await deviceFromEntries('alice.tar.gz', parseTarGzArchive(bytes))).steps.length // 42
 */
export async function deviceFromEntries(archiveName: string, entries: readonly ArchiveEntry[]): Promise<CryptoDevice> {
  const details = detailsFromEntries(entries);
  const steps: CryptoStep[] = [];
  const coverage: DeviceCoverage[] = [];
  const loginLines: ParsedLogLine[] = [];
  for (const e of entries) {
    if (!isAnalyzableEntry(e.name)) continue;
    const file = basename(e.name);
    const lines = parseLogFile(entryText(e)).rawLogLines;
    for (const s of extractSteps(lines, { archive: archiveName, file })) steps.push(s);
    const c = coverageOf(lines);
    if (c) coverage.push(c);
    for (const l of lines) if (l.message.includes('setLoggedIn: mxid:')) loginLines.push(l);
    await yieldToUi();
  }
  steps.sort(byTs);
  loginLines.sort((a, b) => a.timestampUs - b.timestampUs);
  return { id: archiveName, entries, identity: deviceIdentity(details, loginLines), steps, coverage };
}

/**
 * One device from a dropped or fetched file: a `.tar.gz` archive or a bare log.
 *
 * @example (await deviceFromFile('bob.log', bytes)).entries // [{ name: 'bob.log', data: bytes }]
 */
export function deviceFromFile(name: string, bytes: Uint8Array): Promise<CryptoDevice> {
  const entries = TAR_GZ_NAME.test(name) ? parseTarGzArchive(bytes) : [{ name, data: bytes }];
  return deviceFromEntries(name, entries);
}

/** One device's files out of a drop or a pick, and the name it goes by (see droppedDevices). */
export interface DroppedDevice {
  readonly name: string;
  readonly files: readonly File[];
}

/**
 * The devices one drop or pick holds: each archive is a rageshake of its own, while
 * loose log files dropped together are one rageshake's logs (its hourly files), so
 * they make one device rather than one per file.
 *
 * @example droppedDevices([alice.tar.gz, a.log, b.log]) // [{ name: 'alice.tar.gz', files: [alice] }, { name: 'a.log, b.log', files: [a, b] }]
 */
export function droppedDevices(files: readonly File[]): DroppedDevice[] {
  const groups = files.filter((f) => TAR_GZ_NAME.test(f.name)).map((f) => [f]);
  const logs = files.filter((f) => !TAR_GZ_NAME.test(f.name));
  if (logs.length > 0) groups.push(logs);
  return groups.map((g) => ({ name: g.map((f) => f.name).join(', '), files: g }));
}

/**
 * One device from files the user dropped or picked, each checked first like the
 * landing page's upload (size, gzip header, text content), so a bad file is
 * refused before it is read whole. Throws the first validation error.
 *
 * @example await deviceFromDroppedFiles({ name: 'bob.log', files: [new File([log], 'bob.log')] }) // a device, or throws 'File too large …'
 */
export async function deviceFromDroppedFiles({ name, files }: DroppedDevice): Promise<CryptoDevice> {
  for (const file of files) {
    if (TAR_GZ_NAME.test(file.name)) {
      assertArchiveSizeOk(file.size);
    } else {
      const v = file.name.toLowerCase().endsWith('.gz') ? await validateGzipFile(file, decompressSync) : await validateTextFile(file);
      if (!v.isValid) throw v.errors[0] ?? new Error('Invalid file');
    }
  }
  const entries = await Promise.all(files.map(async (f) => ({ name: f.name, data: new Uint8Array(await readBlob(f)) })));
  return entries.length === 1 ? deviceFromFile(name, entries[0].data) : deviceFromEntries(name, entries);
}

/**
 * The parsed lines of one log file of an added device: the file its steps name in `line.file`, opened in the log panel.
 *
 * @example linesOfFile(device, step.line.file).find((l) => l.lineNumber === step.line.line)
 */
export function linesOfFile(device: CryptoDevice, file: string): readonly ParsedLogLine[] {
  const e = device.entries.find((x) => basename(x.name) === file);
  return e ? parseLogFile(entryText(e)).rawLogLines : [];
}

/**
 * Every log file of an added device, parsed and merged like the app merges files: a search across its archive.
 *
 * @example allLinesOf(device).filter((l) => l.message.includes(eventId))
 */
export function allLinesOf(device: CryptoDevice): readonly ParsedLogLine[] {
  const files = device.entries.filter((e) => isAnalyzableEntry(e.name)).map((e) => ({ name: basename(e.name), result: parseLogFile(entryText(e)) }));
  return mergeLogParserResults(files).rawLogLines;
}

const loadedSteps = new WeakMap<readonly ParsedLogLine[], readonly CryptoStep[]>();

/**
 * The loaded logs' crypto steps, in time order, extracted once per `rawLogLines` array:
 * /summary and /decryption both need them, and extraction reads every line.
 * Lines without a `sourceFile` get an empty `line.file` (see deviceFromLoadedLogs).
 *
 * @example loadedLogSteps(useLogStore.getState().rawLogLines) === loadedLogSteps(useLogStore.getState().rawLogLines) // true
 */
export function loadedLogSteps(lines: readonly ParsedLogLine[]): readonly CryptoStep[] {
  let steps = loadedSteps.get(lines);
  if (!steps) loadedSteps.set(lines, (steps = extractSteps(lines, { archive: '', file: '' }).sort(byTs)));
  return steps;
}

/**
 * The main device: the lines already loaded in the log store. Its steps carry the
 * loaded logs' own line numbers, so /logs?line= opens them without reloading.
 * `details` is the open archive's details.json, when there is one.
 *
 * @example deviceFromLoadedLogs('bob.tar.gz', rawLogLines, details).identity.userId // '@bob:b.org'
 */
export function deviceFromLoadedLogs(name: string, lines: readonly ParsedLogLine[], details: ListingDetails | null = null): CryptoDevice {
  // The shared steps name no device: tag them with this one, and its name as the file of a single-file load.
  const steps = loadedLogSteps(lines).map((s) => ({ ...s, line: { ...s.line, archive: name, file: s.line.file || name } }));
  const c = coverageOf(lines);
  return { id: name, entries: [], identity: deviceIdentity(details, lines), steps, coverage: c ? [c] : [] };
}

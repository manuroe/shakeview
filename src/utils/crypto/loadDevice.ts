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
import { assertArchiveSizeOk, parseTarGzArchive } from '../tarGzArchive';
import { getMinMaxTimestamps } from '../timeUtils';
import { byTs } from './buildCryptoModel';
import { deviceIdentity } from './identity';
import { extractSteps } from './steps';
import type { CryptoDevice, CryptoStep, DeviceCoverage } from './types';

const ARCHIVE_NAME = /\.(tar\.gz|tgz)$/i;
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
  const entries = ARCHIVE_NAME.test(name) ? parseTarGzArchive(bytes) : [{ name, data: bytes }];
  return deviceFromEntries(name, entries);
}

/**
 * One device from a file the user dropped or picked, checked first like the
 * landing page's upload (size, gzip header, text content), so a bad file is
 * refused before it is read whole. Throws the first validation error.
 *
 * @example await deviceFromDroppedFile(new File([log], 'bob.log')) // a device, or throws 'File too large …'
 */
export async function deviceFromDroppedFile(file: File): Promise<CryptoDevice> {
  if (ARCHIVE_NAME.test(file.name)) {
    assertArchiveSizeOk(file.size);
  } else {
    const v = file.name.toLowerCase().endsWith('.gz') ? await validateGzipFile(file, decompressSync) : await validateTextFile(file);
    if (!v.isValid) throw v.errors[0] ?? new Error('Invalid file');
  }
  return deviceFromFile(file.name, new Uint8Array(await readBlob(file)));
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

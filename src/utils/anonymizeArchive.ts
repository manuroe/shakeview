import { decompressSync, gzipSync, strToU8 } from 'fflate';
import type { ListingDetails } from '../types/listing';
import type { AnonymizationDictionary } from '../types/log.types';
import { ANONYMIZED_LOG_MARKER, buildAnonymizationDictionaryFromTexts, buildCompiledAnonymizer } from './anonymizeUtils';
import { deriveAnonymizedFilename } from './anonymizedLogFile';
import { deviceIdentity } from './crypto/identity';
import { detailsFromEntries } from './crypto/loadDevice';
import type { DeviceIdentity } from './crypto/types';
import { FileError } from './errorHandling';
import { parseLogFile } from './logParser';
import { roomsInLog, type RoomsInLog } from './roomCount';
import { decodeTextBytes, isValidGzipHeader, isValidTextContent } from './fileValidator';
import { parseTarGzArchive, TAR_GZ_NAME } from './tarGzArchive';
import { buildTar, canEncodeUstarName, type TarFile } from './tarWriter';

/**
 * Anonymise every text file in an archive and repack as a gzipped tar.
 *
 * A single dictionary is built across all text files (with the given salt) so
 * aliases are consistent across the whole archive and match the per-log save.
 * Text file names are preserved exactly; they are decoded, anonymised, and
 * re-gzipped when their name ends in `.gz`. A file that cannot be decoded as
 * text cannot be anonymised either, so it is dropped and replaced by a
 * `<name>.removed` marker rather than shipped raw.
 */

/**
 * Extensions treated as anonymisable text. `.gz` covers inner gzipped logs
 * (e.g. `console.log.gz`). Everything else — notably images — is dropped and
 * replaced by a `.removed` marker, so binary content is neither corrupted nor
 * leaked unanonymised.
 *
 * ponytail: extension whitelist is the ceiling. An unknown type without a listed
 * text extension is dropped with a marker; add its extension here to anonymise it
 * instead.
 */
const TEXT_EXTENSIONS = ['.log', '.txt', '.json', '.csv', '.xml', '.yaml', '.yml', '.ndjson', '.gz'];

function isTextEntry(name: string): boolean {
  const lower = name.toLowerCase();
  if (TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext))) return true;
  // Extensionless members (e.g. "logs") are treated as text.
  return !lower.slice(lower.lastIndexOf('/') + 1).includes('.');
}

/**
 * Body of a `<name>.removed` marker. An entry the anonymiser cannot decode as text
 * cannot be anonymised either, so it is dropped rather than passed through raw —
 * the marker keeps the fact that it existed, which is what a reader needs in order
 * to ask for it out of band.
 */
const REMOVED_NOTE = 'Removed by shakeview anonymization: this file could not be anonymized.\n'
  + 'If its contents matter, ask the reporter to describe it or share it separately.\n';

/**
 * Decode a text entry to a string (gunzipping `.gz`), or null when it cannot be
 * anonymised and must be dropped: a binary member, a `.gz` that is not actually
 * gzip (corrupt/mislabelled), or any member that fails to decompress. Returning
 * null replaces the entry with a marker instead of throwing and aborting the export.
 */
export function decodeEntryText(entry: { name: string; data: Uint8Array }): string | null {
  if (!isTextEntry(entry.name)) return null;
  // An empty member is empty text, not undecodable: an empty `.gz` would otherwise
  // fail the gzip-header check below and be replaced by a marker telling the reader
  // to chase content that never existed.
  if (entry.data.length === 0) return '';
  try {
    const isGz = entry.name.toLowerCase().endsWith('.gz');
    if (isGz && !isValidGzipHeader(entry.data)) return null;
    const bytes = isGz ? decompressSync(entry.data) : entry.data;
    // Guard the lenient decode: binary payloads (null bytes / undecodable) would
    // otherwise decode to a lossy string and be re-encoded, corrupting the file.
    // This matters most for extensionless and gzipped-binary members.
    if (!isValidTextContent(bytes).isValid) return null;
    return decodeTextBytes(bytes);
  } catch {
    return null;
  }
}

/**
 * Name of the marker that replaces a dropped entry. An entry already named
 * `<name>.removed` is a marker from an earlier pass and keeps its name, so
 * re-anonymising an anonymised archive doesn't stack suffixes. When the suffix
 * would push the name past what ustar can encode (a 93+ char member with no '/'
 * to split on), the tail of the name is dropped to make room — the marker has to
 * fit, or that one entry aborts the whole export.
 */
function markerName(name: string): string {
  if (name.endsWith('.removed')) return name;
  const withSuffix = `${name}.removed`;
  return canEncodeUstarName(withSuffix) ? withSuffix : `${name.slice(0, -'.removed'.length)}.removed`;
}

/**
 * Build the anonymisation dictionary that `buildAnonymisedArchiveGz` would apply
 * to these entries — one dictionary across all text files. Used to preview the
 * mapping before saving.
 */
export async function buildArchiveDictionary(
  entries: readonly { name: string; data: Uint8Array }[],
  salt: string,
  onProgress?: ArchiveProgress,
): Promise<AnonymizationDictionary> {
  const total = entries.length;
  const maybeYield = makeYielder();
  const texts: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const text = decodeEntryText(entries[i]);
    if (text !== null) texts.push(text);
    onProgress?.('Reading files', i + 1, total);
    await maybeYield();
  }
  onProgress?.('Building mapping', 0, 0);
  return buildAnonymizationDictionaryFromTexts(texts, salt);
}

/** Reports progress of a long archive build. `total === 0` = indeterminate. */
export type ArchiveProgress = (phase: string, current: number, total: number) => void;

/**
 * Returns a `maybeYield()` that hands control back to the event loop at most
 * ~every 50ms, so a progress bar can repaint without a macrotask per file.
 */
function makeYielder(): () => Promise<void> {
  let last = performance.now();
  return async () => {
    if (performance.now() - last <= 50) return;
    await new Promise<void>((r) =>
      typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame(() => r()) : setTimeout(r, 0),
    );
    last = performance.now();
  };
}

/** Derive `<base>-anonym.tar.gz` from an archive name (or a fallback base). */
export function deriveAnonymizedArchiveName(name: string | null): string {
  const raw = (name ?? '').trim() || 'archive';
  const base = raw.replace(/\.tar\.gz$/i, '').replace(/\.tgz$/i, '').replace(/\.tar$/i, '');
  return `${base}-anonym.tar.gz`;
}

/**
 * Build an anonymised `.tar.gz` (returned as bytes) from raw archive entries.
 * Entry order is preserved, as are the names of anonymisable text entries; an
 * entry that cannot be anonymised becomes a `<name>.removed` marker. The work is
 * chunked and yields to the event loop periodically so `onProgress` updates paint.
 */
export async function buildAnonymisedArchiveGz(
  entries: readonly { name: string; data: Uint8Array }[],
  salt: string,
  onProgress?: ArchiveProgress,
): Promise<Uint8Array> {
  return (await anonymiseArchiveEntries(entries, salt, onProgress)).gz;
}

/**
 * `buildAnonymisedArchiveGz`, also returning the mapping it applied. The
 * anonymise page keeps that mapping to reverse a report written about the archive.
 *
 * @example
 * ```ts
 * const { gz, dict } = await anonymiseArchiveEntries(entries, salt);
 * dict.reverse['@user-0123456789ab:domain-01234567.org']; // '@alice:example.org'
 * ```
 */
export async function anonymiseArchiveEntries(
  entries: readonly { name: string; data: Uint8Array }[],
  salt: string,
  onProgress?: ArchiveProgress,
): Promise<{ gz: Uint8Array; dict: AnonymizationDictionary; texts: readonly string[] }> {
  const total = entries.length;
  const maybeYield = makeYielder();

  // Phase 1: decode every text entry once (gunzipping inner `.gz` members).
  const decoded: { entry: { name: string; data: Uint8Array }; text: string | null }[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    decoded.push({ entry, text: decodeEntryText(entry) });
    onProgress?.('Reading files', i + 1, total);
    await maybeYield();
  }

  // Phase 2: one dictionary across all text, then anonymise + re-gzip each entry.
  onProgress?.('Anonymising files', 0, total);
  const texts = decoded.filter((d) => d.text !== null).map((d) => d.text as string);
  const dict = await buildAnonymizationDictionaryFromTexts(texts, salt);
  const apply = buildCompiledAnonymizer(dict);

  const outFiles: TarFile[] = [];
  for (let i = 0; i < decoded.length; i++) {
    const { entry, text } = decoded[i];
    if (text === null) {
      outFiles.push({ name: markerName(entry.name), data: strToU8(REMOVED_NOTE) });
    } else {
      const anonBytes = strToU8(apply(text));
      const data = entry.name.toLowerCase().endsWith('.gz') ? gzipSync(anonBytes) : anonBytes;
      outFiles.push({ name: entry.name, data });
    }
    onProgress?.('Anonymising files', i + 1, total);
    await maybeYield();
  }

  // Phase 3: pack + compress (single blocking step → indeterminate).
  onProgress?.('Compressing', 0, 0);
  await maybeYield();
  return { gz: gzipSync(buildTar(outFiles)), dict, texts };
}

/** Result of anonymising one dropped file, ready to download. */
export interface AnonymisedFile {
  readonly name: string;
  readonly data: Uint8Array | string;
  readonly mime: string;
  readonly dict: AnonymizationDictionary;
  /** True for a `.tar.gz` archive: the only kind a report's deep links point into. */
  readonly isArchive: boolean;
  /** Whose rageshake it is, read from the original. */
  readonly identity: DeviceIdentity;
  /** The rooms its logs mention and list, for the user header (see `roomCount`). */
  readonly rooms: RoomsInLog;
}

/** Element Web login lines, the only ones `deviceIdentity` reads: no copy of every line of an archive. */
// Anchored: unanchored, `.*` retries from every column, quadratic on a long line.
const loginLines = (text: string | null): string[] => text?.match(/^.*setLoggedIn: .*$/gm) ?? [];

/** What the texts say about the user's rooms: only the room list lines are parsed, for their timestamps. */
function roomsOf(texts: readonly string[], dict: AnonymizationDictionary): RoomsInLog {
  // ponytail: lines lead with an ISO timestamp, so a string sort is chronological across files, as in identityOf.
  const listLines = texts.flatMap((t) => t.match(/^.*Rebuilding room summaries.*$/gm) ?? []).sort();
  // The mapping holds every ID of the texts, each spelling once: their room IDs without a second scan.
  const ids = Object.keys(dict.forward).map((rawText) => ({ rawText, timestampUs: 0 }));
  const lists = listLines.length > 0 ? parseLogFile(listLines.join('\n')).rawLogLines : [];
  return roomsInLog([...lists, ...ids]);
}

/** Whose rageshake: `details.json` first, else the last Element Web login line of its logs. */
function identityOf(details: ListingDetails | null, lines: () => readonly string[]): DeviceIdentity {
  if (details?.userId && details.deviceId) return deviceIdentity(details, []);
  // ponytail: lines lead with an ISO timestamp, so a string sort is chronological
  // across log files (archive order is not), like `deviceFromEntries`' timestamp sort.
  return deviceIdentity(details, [...lines()].sort().map((message) => ({ message })));
}

/**
 * Anonymise one file as dropped on the anonymise page. A `.tar.gz`/`.tgz` is
 * repacked whole (`<base>-anonym.tar.gz`); anything else is one log, written as
 * plain text with the anonymised marker (`<name>-anonym.log`), like "Save
 * anonymised" on a loaded log.
 *
 * @throws {FileError} when a single file is not text (binary, or a corrupt `.gz`).
 * @example
 * ```ts
 * const out = await anonymiseDroppedFile('rageshake.tar.gz', bytes, salt);
 * out.name; // 'rageshake-anonym.tar.gz'
 * ```
 */
export async function anonymiseDroppedFile(
  name: string,
  bytes: Uint8Array,
  salt: string,
  onProgress?: ArchiveProgress,
): Promise<AnonymisedFile> {
  if (TAR_GZ_NAME.test(name)) {
    const entries = parseTarGzArchive(bytes);
    const { gz, dict, texts } = await anonymiseArchiveEntries(entries, salt, onProgress);
    const identity = identityOf(detailsFromEntries(entries), () => texts.flatMap(loginLines));
    return { name: deriveAnonymizedArchiveName(name), data: gz, mime: 'application/gzip', dict, isArchive: true, identity, rooms: roomsOf(texts, dict) };
  }
  const text = decodeEntryText({ name, data: bytes });
  if (text === null) throw new FileError(`${name} is not a text log, so it cannot be anonymised.`);
  const dict = await buildAnonymizationDictionaryFromTexts([text], salt);
  const data = `${ANONYMIZED_LOG_MARKER}\n${buildCompiledAnonymizer(dict)(text)}`;
  return { name: deriveAnonymizedFilename(name), data, mime: 'text/plain', dict, isArchive: false, identity: identityOf(null, () => loginLines(text)), rooms: roomsOf([text], dict) };
}

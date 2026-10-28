/**
 * rageshake CLI — compact, LLM-friendly views over rageshake archives and logs.
 *
 * Thin command wrapper over the viewer's pure parsers: never dumps raw logs,
 * every command emits bounded output sized for an LLM context window.
 *
 * Usage: npx tsx cli/rageshake.ts <command> <path> [options]
 * Run with no arguments for the full command reference.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'fflate';
import { parseTar } from '../src/utils/tarParser.ts';
import { parseLogFile } from '../src/utils/logParser.ts';
import { mergeLogParserResults, maxLineNumber, type NamedLogParserResult } from '../src/utils/mergeLogParserResults.ts';
import { parseDetailsJson, rustSdkShaFromLogs } from '../src/utils/detailsJson.ts';
import { isAnalyzableEntry } from '../src/utils/archiveSummary.ts';
import { isValidGzipHeader, isValidTextContent, decodeTextBytes } from '../src/utils/fileValidator.ts';
import { decodeIdentifier, detectAnonymizedLog, isDomainAlias, MATRIX_IDENTIFIER_RE, URL_HOST_RE } from '../src/utils/anonymizeUtils.ts';
import { computeSummaryStats } from '../src/utils/summaryStats.ts';
import { lastColdStartUs, lastForegroundUs, deriveAppStateSegments, MARKER_KINDS, type AppStateSegment } from '../src/utils/lifecycleEvents.ts';
import { buildLogOverview, extractTarget, type OverviewNode } from '../src/utils/logOverview.ts';
import { buildSpanOverview, type SpanNode } from '../src/utils/spanOverview.ts';
import { extractDateKey, extractCategory } from '../src/utils/listingEntries.ts';
import { stripLogPrefix } from '../src/utils/logMessageUtils.ts';
import { SPANS_MARKER } from '../src/utils/spansParser.ts';
import { alignLogcatFiles, isLogcatFile } from '../src/utils/logcatClockAlign.ts';
import { isoToMicros, microsToISO, getMinMaxTimestamps, formatDuration } from '../src/utils/timeUtils.ts';
import { deviceFromLoadedLogs } from '../src/utils/crypto/loadDevice.ts';
import { buildCryptoModel } from '../src/utils/crypto/buildCryptoModel.ts';
import { scopeSessions } from '../src/utils/crypto/scope.ts';
import { sessionTime } from '../src/utils/crypto/sessionList.ts';
import { sessionLanes, shareRecipients } from '../src/utils/crypto/timeline.ts';
import { buildJourney, type JourneyState } from '../src/utils/crypto/journey.ts';
import { lateOutcomeKey, matchesOutcomes, sessionEventKeys, utdOutcomeKey } from '../src/utils/crypto/decryptionSummary.ts';
import { ANALYTICS_CATEGORIES, REPORTED_MEANING } from '../src/utils/crypto/labels.ts';
import { describeStep } from '../src/utils/crypto/describeStep.ts';
import { plural } from '../src/utils/crypto/format.ts';
import type { AnalyticsCategory, CryptoDevice, CryptoStep, LineRef, MegolmSession, UtdEvent } from '../src/utils/crypto/types.ts';
import { cmdServe } from './serve.ts';
import type { LogParserResult, ParsedLogLine, LifecycleEvent, HttpRequest } from '../src/types/log.types.ts';
import type { TimestampMicros, ISODateTimeString } from '../src/types/time.types.ts';

const USAGE = `rageshake CLI — compact views over a rageshake archive (.tar.gz) or log file (.log / .log.gz)

Commands:
  precheck <path>              Verify the file is anonymized. Exit 1 + reason when not.
  summary  <path>              details.json + per-file stats + top errors/warnings/HTTP failures (JSON).
  overview <path>              Log lines grouped by module target, error/warn counts per subtree.
  lastseen <path>              Per-target last-activity table, quietest first. Silence is evidence:
                               a deadlocked subsystem stops logging without any error — this names
                               the target that went quiet while everything else kept running.
  spans    <path>              SDK log lines grouped by span chain (operation view).
  grep     <path> <pattern>... Lines matching ANY pattern (case-insensitive substring).
  slice    <path>              All lines in a time window (use with --last/--since/--from).
  http     <path>              HTTP requests: time, method, uri, status, duration.
  cycles   <path>              App lifecycle: event counts, cold starts/crashes, app-state segments.
  megolm   <path> [<path>...]  Megolm sessions (room keys) across rageshakes: the first is the main device,
                               the others added devices — the sender's rageshake, typically. Lists every
                               session, newest first, with each archive's outcome: utd:<reason>×N still
                               failing, late:<how>×N decrypted later, outbound (it sent the key, and to how
                               many devices), key_received. With --event or --session: that session's
                               verdict, checklist, UTD events, recipients with delivery, and step timeline.
                               Refs are what grep prints on that archive; "2:f3" = f3 of the 2nd archive.
  serve    [dir]               Serve the viewer + a directory of rageshakes on http://127.0.0.1:7357
                               (default dir: the working directory), so a log line can be opened by
                               URL: /#/logs?archive=/<path-under-dir>/x.tar.gz&file=<log>&line=<N>.
                               file/line are the "[<N>|f<k>]" prefix printed on every line, with the
                               "# files:" legend expanding f<k> to the log name — line numbers are
                               always counted inside their own file, so file= is what makes line=
                               resolve (drop it and all logs open merged instead). Runs until
                               stopped; starting it twice reuses the first server. Flag: --port <N>

Time window (grep, slice, http, overview, lastseen, spans, cycles, megolm list — on the main archive):
  --from <ISO>                 Start timestamp, e.g. 2026-01-15T10:00:00Z
  --to <ISO>                   End timestamp
  --since <anchor|ISO>         last-cold-start | last-foreground | last-background, or an ISO timestamp
  --last <dur>                 Window ending at the last log line, e.g. 10m, 1h, 30s

Filters:
  --level <LEVEL>              Minimum level: TRACE|DEBUG|INFO|WARN|ERROR (grep, slice)
  --around <N>                 Context lines around each match (grep, default 0)
  --file <name>                Only lines from this source log file (grep, slice)
  --errors                     Only failed requests: HTTP >= 400 or transport error (http)
  --slowest <N>                N slowest requests, sorted by duration (http)
  --top <N|all>                Per-file table: N noisiest files or "all" (summary, default 5)
  --utd                        Only sessions with a UTD on some device (megolm)
  --analytics <value>          Only sessions with a UTD the app's analytics counts so (megolm, as /decryption):
                               reported | not_reported | unknown. Reported = still not decrypted 4 s after
                               the app first tried to show it, i.e. the UTDs the user saw
  --event <id>                 The session of this UTD, in full (megolm). Ids here are aliases ($event-…,
                               !room-…, @user-…), a prefix of 6+ hex of one, or any text holding one, e.g. a
                               permalink: a raw id never matches. The user's bug report (summary userText)
                               usually has them aliased
  --session <id>               This session in full (megolm); a unique prefix of 6+ characters is enough
  --raw                        Timeline steps as their verbatim log message, capped by --width, instead of
                               a one-line description (megolm --event/--session): the lines a report quotes
  --room <id>                  Only sessions in this room (megolm); matching nothing lists the main device's rooms with a UTD
  --sender <id>                Only sessions this user sent (megolm)

Pagination (all line/tree output is capped, never unbounded):
  --count                      Counts + a time distribution instead of lines (grep, slice). Probe with this
                               before fetching lines: it shows how many matches there are and when they
                               happen, so the window can be picked in one call rather than by walking --limit
  --width <N>                  Truncate each line's message to N chars (grep, slice; default 200, 0 = no limit)
  --spans                      Keep the "| spans: …" chain on each line (grep, slice). Dropped by default:
                               it is ~49% of an average SDK line, mostly the sliding-sync pos= cursor.
                               Use the "spans" command for span structure; this is for one specific chain
  --limit <N>                  Max lines / tree nodes (default 50 lines, 100 nodes)
  --offset <N>                 Skip N output entries (cycles pages back from the newest; footer shows the next offset)
  --depth <N>                  Max tree depth (overview, spans; default 3)`;

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

interface TextEntry {
  readonly name: string;
  readonly text: string;
}

export interface Ingest {
  /** Parsed analyzable log files, chronological order. */
  readonly files: readonly NamedLogParserResult[];
  /** All files merged into one timeline. */
  readonly merged: LogParserResult;
  /**
   * Per-file line-number offset in the merged timeline, keyed by file name.
   * Subtracting it turns a merged number back into the number that line has
   * inside its own file — which is what output prints and what a viewer link
   * carries, so opening one log is enough to reach the line.
   */
  readonly offsets: ReadonlyMap<string, number>;
  /** Parsed details.json when the archive has one. */
  readonly details: ReturnType<typeof parseDetailsJson>;
  /** Every decodable text entry (for precheck). */
  readonly textEntries: readonly TextEntry[];
  /**
   * Names of members the anonymizer dropped because it could not anonymize them
   * (a screenshot, typically), with the `.removed` suffix stripped. Listed by
   * `summary` so the content is known to be missing and can be asked for; a
   * dropped *log* also raises a partial-view warning in `precheck`.
   */
  readonly removedEntries: readonly string[];
  /**
   * Microseconds added to the logcat file's timestamps to align its
   * device-local clock with the UTC tracing logs (0 = no correction applied).
   * Surfaced in the `# files:` legend so the shift is never silent.
   */
  readonly logcatSkewUs: number;
}

function isTarBytes(bytes: Uint8Array): boolean {
  // 'ustar' magic at offset 257
  return bytes.length > 262 && bytes[257] === 0x75 && bytes[258] === 0x73
    && bytes[259] === 0x74 && bytes[260] === 0x61 && bytes[261] === 0x72;
}

/**
 * Validate bytes as text and decode with the detected encoding (UTF-8, or the
 * ISO-8859-1 fallback the rest of the app uses). Returns null for binary /
 * null-byte content so callers can skip or reject it.
 */
function decodeIfText(data: Uint8Array): string | null {
  const validation = isValidTextContent(data);
  if (!validation.isValid) return null;
  return decodeTextBytes(data, validation.metadata?.encoding as string | undefined);
}

/** Ingest raw file bytes: decompress, unpack, parse, merge. */
export function ingest(rawBytes: Uint8Array, name: string): Ingest {
  const bytes = isValidGzipHeader(rawBytes) ? gunzipSync(rawBytes) : rawBytes;
  const textEntries: TextEntry[] = [];
  const removedEntries: string[] = [];
  let details: Ingest['details'] = null;

  // Trust the archive extension first (parseTar handles non-ustar tars the magic
  // check would miss); fall back to the ustar magic for extensionless input.
  const nameIsTar = /\.tar$|\.tar\.gz$|\.tgz$/i.test(name);
  if (nameIsTar || isTarBytes(bytes)) {
    for (const entry of parseTar(bytes)) {
      // A marker left by the anonymizer for a member it had to drop. Note it and
      // move on: its body is a fixed explanatory note, never analysable content.
      if (entry.name.endsWith('.removed')) {
        removedEntries.push(basename(entry.name.slice(0, -'.removed'.length)));
        continue;
      }
      // A log file or details.json that can't be read is a broken archive, not
      // an unrelated binary member — fail loudly rather than analyse a partial
      // view. Other members (images, etc.) are skipped silently.
      const important = isAnalyzableEntry(entry.name) || basename(entry.name) === 'details.json';
      let data = entry.data;
      if (entry.name.toLowerCase().endsWith('.gz')) {
        if (!isValidGzipHeader(data)) {
          if (important) throw new Error(`${entry.name} is not valid gzip — cannot analyse this archive`);
          continue;
        }
        data = gunzipSync(data);
      }
      const text = decodeIfText(data);
      if (text === null) {
        if (important) throw new Error(`${entry.name} is not valid text — cannot analyse this archive`);
        continue;
      }
      textEntries.push({ name: entry.name, text });
      if (basename(entry.name) === 'details.json') details = parseDetailsJson(text);
    }
  } else {
    const text = decodeIfText(bytes);
    if (text === null) throw new Error(`${name} is not a valid text log file (binary or unsupported encoding)`);
    textEntries.push({ name, text });
  }

  const logs = textEntries
    .filter((t) => isAnalyzableEntry(t.name) || textEntries.length === 1)
    .sort((a, b) =>
      (extractDateKey(a.name) ?? a.name).localeCompare(extractDateKey(b.name) ?? b.name)
      || a.name.localeCompare(b.name));
  // Pass the raw text: parseLogFile detects and strips the anonymization marker
  // itself and sets isAnonymized — pre-stripping here would hide that signal.
  // Android logcat runs on the device-local clock while the tracing files are
  // UTC. Merging them uncorrected fabricates phantom multi-hour gaps and
  // breaks lifecycle durations, so align logcat onto the tracing clock (both
  // are captured at submission time — see estimateLogcatSkewUs).
  const { files, skewUs: logcatSkewUs } = alignLogcatFiles(
    logs.map((t) => ({ name: t.name, result: parseLogFile(t.text) })));

  // Mirror mergeLogParserResults' cumulative rebasing, so a merged number can be
  // mapped back to (file, line-in-file). Same helper, so the two cannot drift.
  const offsets = new Map<string, number>();
  let offset = 0;
  for (const f of files) {
    offsets.set(f.name, offset);
    offset += maxLineNumber(f.result);
  }
  return { files, merged: mergeLogParserResults(files), offsets, details, textEntries, removedEntries, logcatSkewUs };
}

function loadInput(path: string): Ingest {
  return ingest(new Uint8Array(readFileSync(path)), basename(path));
}

// ---------------------------------------------------------------------------
// Shared flags: time window, pagination
// ---------------------------------------------------------------------------

interface Flags {
  from?: string;
  to?: string;
  since?: string;
  last?: string;
  level?: string;
  around?: string;
  file?: string;
  limit?: string;
  offset?: string;
  depth?: string;
  errors?: boolean;
  slowest?: string;
  top?: string;
  count?: boolean;
  width?: string;
  spans?: boolean;
  utd?: boolean;
  analytics?: string;
  event?: string;
  session?: string;
  room?: string;
  sender?: string;
  raw?: boolean;
}

const DUR_RE = /^(\d+)(s|m|h|d)$/;
const DUR_US: Record<string, number> = { s: 1e6, m: 60e6, h: 3600e6, d: 86400e6 };

interface Range {
  startUs: number;
  endUs: number;
}

/**
 * Parse an ISO timestamp flag to µs, throwing on malformed input. `isoToMicros`
 * returns 0 for anything it can't parse (and for the epoch), so a 0 here means
 * the flag was malformed — no rageshake log line is at epoch.
 */
function parseIsoFlag(iso: string, flag: string): number {
  const us = isoToMicros(iso as ISODateTimeString);
  if (us === 0) throw new Error(`invalid ${flag} timestamp "${iso}"; use full ISO, e.g. 2026-01-15T10:00:00Z`);
  return us;
}

/** Resolve --from/--to/--since/--last into a µs range; null = whole log. */
export function resolveRange(merged: LogParserResult, flags: Flags, warn: (msg: string) => void): Range | null {
  const { min, max } = getMinMaxTimestamps(merged.rawLogLines);
  // A log with no parseable timestamps yields {min:0,max:0}; every time flag
  // resolves against that and produces a meaningless [0,0] window, so reject
  // them up front rather than silently filtering everything out.
  if ((flags.from || flags.to || flags.since || flags.last) && max === 0) {
    throw new Error('cannot apply a time window: the log has no parseable timestamps');
  }
  let startUs: number | null = null;
  let endUs: number | null = null;

  if (flags.from) startUs = parseIsoFlag(flags.from, '--from');
  if (flags.to) endUs = parseIsoFlag(flags.to, '--to');

  if (flags.since) {
    const events = merged.lifecycleEvents ?? [];
    let anchor: TimestampMicros | null = null;
    if (flags.since === 'last-cold-start') anchor = lastColdStartUs(events);
    else if (flags.since === 'last-foreground') anchor = lastForegroundUs(events);
    else if (flags.since === 'last-background') {
      for (const e of events) if (e.kind === 'background' && (anchor === null || e.timestampUs > anchor)) anchor = e.timestampUs;
    } else {
      // Accept an absolute ISO timestamp too (equivalent to --from), so an
      // explicit time doesn't force the caller to switch flags.
      const us = isoToMicros(flags.since as ISODateTimeString);
      if (us !== 0) anchor = us as TimestampMicros;
      else throw new Error(`invalid --since "${flags.since}" — use an anchor (last-cold-start | last-foreground | last-background) or an ISO timestamp like 2026-01-15T10:00:00Z`);
    }
    if (anchor === null) {
      warn(`# warning: no "${flags.since}" event found — ignoring --since; run "cycles" to see what exists`);
    } else {
      startUs = Math.max(startUs ?? 0, anchor);
    }
  }

  if (flags.last) {
    const m = flags.last.match(DUR_RE);
    if (!m) throw new Error(`invalid --last duration "${flags.last}" (e.g. 30s, 10m, 1h, 2d)`);
    const durUs = Number(m[1]) * DUR_US[m[2]];
    // Clamp to the first log timestamp (min), not epoch, so a duration longer
    // than the log span doesn't render a misleading 1970 range header. An
    // explicit --from still wins via its own startUs.
    startUs = Math.max(startUs ?? min, (endUs ?? max) - durUs);
  }

  if (startUs === null && endUs === null) return null;
  const range = { startUs: startUs ?? min, endUs: endUs ?? max };
  if (range.startUs > range.endUs) {
    throw new Error(`empty time window: start ${microsToISO(range.startUs as TimestampMicros)} is after end ${microsToISO(range.endUs as TimestampMicros)}`);
  }
  return range;
}

function intFlag(v: string | undefined, def: number): number {
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`invalid numeric flag value "${v}"`);
  return n;
}

/**
 * Page a list from the end: --offset 0 shows the last `limit` items, higher
 * offsets step further back. Returns the page and how many older items precede
 * it. Used by `cycles`, where the newest activity is what matters first.
 */
function tailPage<T>(items: readonly T[], limit: number, offset: number): { page: readonly T[]; older: number } {
  const end = items.length - offset;
  if (end <= 0) return { page: [], older: items.length };
  const start = Math.max(0, end - limit);
  return { page: items.slice(start, end), older: start };
}

// ---------------------------------------------------------------------------
// Line emission: collapse duplicates, gap markers, pagination
// ---------------------------------------------------------------------------

const LEVELS = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR'];

/**
 * Default cap for line output (`grep`, `slice`, `http`).
 *
 * Sized against the other commands rather than picked round: at the old 200,
 * `slice --last 2m` returned 42,846 chars while `overview`/`cycles`/`spans`/
 * `summary` all landed between 3,950 and 7,779 — the line commands alone could
 * drop ~11k tokens in a single call. That gap is what made walking `--limit`
 * down from 200 the rational thing to do. 50 × the ~208-char line width puts
 * line output back in the same band as everything else; ask for more explicitly
 * when a case needs it, after `--count` has shown the shape.
 */
const LINE_LIMIT = 50;

function levelFilter(min: string | undefined): (l: ParsedLogLine) => boolean {
  if (!min) return () => true;
  const idx = LEVELS.indexOf(min.toUpperCase());
  if (idx === -1) throw new Error(`unknown --level "${min}" (use ${LEVELS.join('|')})`);
  return (l) => LEVELS.indexOf(l.level) >= idx;
}

interface DisplayEntry {
  readonly line: ParsedLogLine;
  /** Consecutive following duplicates collapsed into this entry. */
  readonly dupCount: number;
  /** Log lines skipped between the previous entry and this one. */
  readonly gapBefore: number;
}

/**
 * Printed message text: log prefix stripped, `| spans: …` chain dropped unless kept.
 *
 * The `| spans: …` suffix the SDK's tracing layer appends is 49% of an average
 * line — more than twice the message itself — and it is mostly the sliding-sync
 * `pos=` cursor. Truncating instead of dropping it meant every line ended in
 * half a token. `./rs spans` is the view for span structure; `--spans` puts it
 * back on a line when a specific chain matters.
 *
 * Single definition on purpose: `buildDisplayEntries` keys its duplicate
 * collapsing on this, so lines that only differ in the dropped chain collapse
 * the way they read.
 */
function displayText(line: ParsedLogLine, keepSpans: boolean): string {
  const text = stripLogPrefix(line.rawText);
  if (keepSpans) return text;
  // lastIndexOf, matching parseSpansChain: a message body that embeds the
  // marker must not be cut at its first occurrence.
  const at = text.lastIndexOf(SPANS_MARKER);
  return at === -1 ? text : text.slice(0, at);
}

/** Collapse consecutive same-message lines and record gaps, before pagination. */
function buildDisplayEntries(lines: readonly ParsedLogLine[], selected: readonly number[], keepSpans: boolean): DisplayEntry[] {
  const entries: DisplayEntry[] = [];
  let i = 0;
  while (i < selected.length) {
    const line = lines[selected[i]];
    // Gap = raw lines skipped between the two displayed entries. Measure it from
    // the selected timeline positions, not lineNumber: merged logs are sorted by
    // timestamp (mergeLogParserResults) so lineNumber is not monotonic in array
    // order and its delta would report phantom gaps when processes interleave.
    const gapBefore = i > 0 ? selected[i] - selected[i - 1] - 1 : 0;
    const baseText = displayText(line, keepSpans);
    let dupCount = 0;
    let j = i + 1;
    while (
      j < selected.length
      && selected[j] === selected[j - 1] + 1
      && displayText(lines[selected[j]], keepSpans) === baseText
    ) {
      dupCount++;
      j++;
    }
    entries.push({ line, dupCount, gapBefore });
    i = j;
  }
  return entries;
}

/**
 * Map each source file to a short tag (`f1`, `f2`, …) for the line prefix;
 * `emitEntries` prints the legend that expands the ones a page cites.
 *
 * Rageshake archives name every log `console.<date>-<hour>.log.gz`, so
 * `extractCategory` returned `console` for all of them — the suffix cost bytes
 * on every line and still never identified the file a report has to cite. An
 * index costs 2-3 chars per line and the legend resolves it exactly once.
 * Indices follow `ingest`'s chronological sort, so they are stable per archive.
 */
function fileTags(ing: Ingest): Map<string, string> {
  return new Map(ing.files.map((f, i) => [f.name, `f${i + 1}`]));
}

/**
 * `# files:` legend expanding only the tags the emitted page actually cites. A
 * rageshake routinely carries 60 logs; expanding all of them costs far more than
 * the tags save, and the caller only ever needs to resolve a tag it can see.
 */
function filesLegend(ing: Ingest, tags: Map<string, string> | null, citedFiles: Iterable<string | undefined>): string | null {
  if (!tags) return null;
  const cited = new Set<string>();
  for (const name of citedFiles) if (name !== undefined) cited.add(name);
  const shown = ing.files.filter((f) => cited.has(f.name));
  if (shown.length === 0) return null;
  return `# files: ${shown.map((f) => `${tags.get(f.name)}=${basename(f.name)}${skewNote(ing, f.name)}`).join(' · ')}`;
}

/**
 * A logcat whose device-local clock was aligned to UTC says so in a legend, so
 * the times printed never silently disagree with the raw file.
 */
function skewNote(ing: Ingest, name: string): string {
  return ing.logcatSkewUs !== 0 && isLogcatFile(name) ? ` (device-local times shifted ${formatSkew(ing.logcatSkewUs)} to UTC)` : '';
}

/** Render a clock skew as a signed hours/minutes label, e.g. `-2h`, `+5h45m` or `+30m`. */
function formatSkew(skewUs: number): string {
  const sign = skewUs < 0 ? '-' : '+';
  const totalMinutes = Math.round(Math.abs(skewUs) / 60e6);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${sign}${h > 0 ? `${h}h` : ''}${m > 0 ? `${m}m` : ''}`;
}

/**
 * Render a merged line number as `<line-in-its-own-file>|<file tag>`.
 *
 * Every printed number is per-file, never merged, so one number means one thing
 * throughout the output: the line as its own log file counts it. That is what a
 * viewer link needs — with the file named, the viewer opens that log alone
 * (~0.3s) instead of merging all 50-odd logs in the archive (~2.4s) to make a
 * merged number resolve.
 *
 * `tags` is null for a single-log archive, where the offset is 0 and the file
 * needs no naming, so the output is just the number.
 */
function lineRef(mergedLineNumber: number, sourceFile: string | undefined, tags: Map<string, string> | null, offsets: ReadonlyMap<string, number>): string {
  if (!tags || !sourceFile) return `${mergedLineNumber}`;
  const inFile = mergedLineNumber - (offsets.get(sourceFile) ?? 0);
  return `${inFile}|${tags.get(sourceFile) ?? extractCategory(sourceFile)}`;
}

function formatLine(line: ParsedLogLine, tags: Map<string, string> | null, width: number, keepSpans: boolean, offsets: ReadonlyMap<string, number>): string {
  const time = line.displayTime ? line.displayTime.slice(0, 12) : '??:??:??.???';
  const text = displayText(line, keepSpans);
  return `[${lineRef(line.lineNumber, line.sourceFile, tags, offsets)}] ${time} ${line.level.padEnd(5)} ${width > 0 ? trim(text, width) : text}`;
}

/** Emit display entries with day markers, gap markers and a pagination footer. */
function emitEntries(out: string[], entries: readonly DisplayEntry[], flags: Flags, ing: Ingest): void {
  const limit = intFlag(flags.limit, LINE_LIMIT);
  const offset = intFlag(flags.offset, 0);
  const width = intFlag(flags.width, 200);
  const page = entries.slice(offset, offset + limit);
  const tags = ing.files.length > 1 ? fileTags(ing) : null;
  const legend = filesLegend(ing, tags, page.map((e) => e.line.sourceFile));
  if (legend) out.push(legend);
  let lastDay = '';
  for (const e of page) {
    const day = String(e.line.isoTimestamp).slice(0, 10);
    if (day && day !== lastDay) {
      out.push(`# ${day}`);
      lastDay = day;
    }
    if (e.gapBefore > 0) out.push(`... ${e.gapBefore} lines ...`);
    out.push(formatLine(e.line, tags, width, flags.spans === true, ing.offsets));
    if (e.dupCount > 0) out.push(`... ${e.dupCount} duplicated lines ...`);
  }
  const remaining = entries.length - offset - page.length;
  if (remaining > 0) out.push(`# ${remaining} more entries — next: --offset ${offset + page.length}`);
  if (page.length === 0) {
    out.push(entries.length === 0
      ? '# no matching lines'
      : `# --offset ${offset} is past the end (${entries.length} entries) — lower --offset`);
  }
}

/**
 * Count-only probe: a coarse time histogram over the selected lines, plus a
 * ready-to-paste --from/--to for the busiest bucket.
 *
 * This is the answer to walking --limit down: the caller cannot see the shape of
 * a match set before paying for it, so it guesses a limit, and guesses again.
 * One --count call shows both how many matches there are and when they happen,
 * and the peak line is the next command's window.
 *
 * Deliberately not `bucketActivityRuns`: that merges adjacent non-empty buckets
 * into runs, which collapses a dense match set to a single row.
 */
function emitDistribution(out: string[], lines: readonly ParsedLogLine[], selected: readonly number[]): void {
  const stamped = selected.map((i) => lines[i].timestampUs).filter((t) => t > 0);
  if (stamped.length === 0) return;
  // Reduce rather than Math.min(...arr): a match set of tens of thousands of
  // lines overflows the argument stack when spread.
  let min = stamped[0];
  let max = stamped[0];
  for (const t of stamped) {
    if (t < min) min = t;
    if (t > max) max = t;
  }
  const BUCKETS = 10;
  const span = max - min;
  const width = Math.max(1, Math.ceil(span / BUCKETS));
  const counts = new Array<number>(BUCKETS).fill(0);
  for (const t of stamped) counts[Math.min(BUCKETS - 1, Math.floor((t - min) / width))]++;

  // A rageshake routinely spans several days, and bare HH:MM:SS labels then read
  // as a backwards range ("13:00 → 11:14"). Add the date only when it varies.
  const iso = (us: number): string => microsToISO(us as TimestampMicros);
  const sameDay = iso(min).slice(0, 10) === iso(max).slice(0, 10);
  const hhmmss = (us: number): string => (sameDay ? iso(us).slice(11, 19) : iso(us).slice(5, 16));
  const cells = counts
    .map((n, i) => ({ n, startUs: min + i * width }))
    .filter((b) => b.n > 0)
    .map((b) => `${hhmmss(b.startUs)} ${b.n}`);
  out.push(`# ${hhmmss(min)} → ${hhmmss(max)} · ${cells.join(' | ')}`);

  let peak = 0;
  for (let i = 1; i < BUCKETS; i++) if (counts[i] > counts[peak]) peak = i;
  const peakStart = min + peak * width;
  out.push(`# peak ${counts[peak]} — --from ${microsToISO(peakStart as TimestampMicros)} --to ${microsToISO((peakStart + width) as TimestampMicros)}`);
}

/** Select line indices by range/level/file filters. */
function selectIndices(
  merged: LogParserResult,
  range: Range | null,
  flags: Flags,
): number[] {
  const passLevel = levelFilter(flags.level);
  const fileFilter = flags.file ?? null;
  const selected: number[] = [];
  merged.rawLogLines.forEach((l, idx) => {
    if (range && (l.timestampUs < range.startUs || l.timestampUs > range.endUs)) return;
    if (!passLevel(l)) return;
    if (fileFilter && !(l.sourceFile ?? '').includes(fileFilter)) return;
    selected.push(idx);
  });
  return selected;
}

function rangeHeader(out: string[], range: Range | null, merged: LogParserResult): void {
  if (range) {
    out.push(`# range: ${microsToISO(range.startUs as TimestampMicros)} → ${microsToISO(range.endUs as TimestampMicros)}`);
  } else {
    const { min, max } = getMinMaxTimestamps(merged.rawLogLines);
    if (min > 0) out.push(`# full log: ${microsToISO(min)} → ${microsToISO(max)} (${merged.rawLogLines.length} lines)`);
  }
}

// ---------------------------------------------------------------------------
// precheck
// ---------------------------------------------------------------------------

/** Alias shapes produced by the anonymizer (anonymizeUtils naming scheme). */
const ALIAS_RE = /^(?:@user-[0-9a-f]{12}|#room_alias-[0-9a-f]{12}|!room-[0-9a-f]{12}|\$event-[0-9a-f]{12})(?::domain-[0-9a-f]{8}\.org(?::\d{1,5})?)?$/;
const DOMAIN_ALIAS_RE = /domain-[0-9a-f]{8}\.org/;

export function cmdPrecheck(ing: Ingest): { ok: boolean; report: string } {
  let aliasCount = 0;
  let markerCount = 0;
  const rawByFile = new Map<string, number>();
  const rawByKind = new Map<string, number>();

  for (const { name, text } of ing.textEntries) {
    if (detectAnonymizedLog(text)) markerCount++;
    if (DOMAIN_ALIAS_RE.test(text)) aliasCount++;
    // Preserve the exported regex's own flags (add global for exec-loop scanning)
    // so precheck can't drift from the anonymizer if those flags ever change.
    const flags = MATRIX_IDENTIFIER_RE.flags.includes('g') ? MATRIX_IDENTIFIER_RE.flags : `${MATRIX_IDENTIFIER_RE.flags}g`;
    const re = new RegExp(MATRIX_IDENTIFIER_RE.source, flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const id = decodeIdentifier(m[0]);
      if (ALIAS_RE.test(id)) {
        aliasCount++;
        continue;
      }
      rawByFile.set(name, (rawByFile.get(name) ?? 0) + 1);
      const kind = id[0] === '@' ? 'user-id' : id[0] === '#' ? 'room-alias' : id[0] === '!' ? 'room-id' : 'event-id';
      rawByKind.set(kind, (rawByKind.get(kind) ?? 0) + 1);
    }
    // Every URL host must be a domain alias: the anonymizer aliases them all. The
    // host itself is never printed, it is the value being kept out of the report.
    const hostRe = new RegExp(URL_HOST_RE.source, 'g');
    while ((m = hostRe.exec(text)) !== null) {
      if (isDomainAlias(m[1])) continue;
      rawByFile.set(name, (rawByFile.get(name) ?? 0) + 1);
      rawByKind.set('url-host', (rawByKind.get('url-host') ?? 0) + 1);
    }
  }

  const lines: string[] = [];
  if (rawByFile.size > 0) {
    lines.push('FAIL: raw (non-anonymized) Matrix identifiers or URL hosts found — do NOT analyse this file.');
    lines.push('Anonymize it with shakeview first, then re-run precheck.');
    for (const [kind, count] of rawByKind) lines.push(`  ${kind}: ${count} occurrence(s)`);
    for (const [file, count] of rawByFile) lines.push(`  in ${file}: ${count}`);
    return { ok: false, report: lines.join('\n') };
  }
  if (aliasCount === 0 && markerCount === 0) {
    lines.push('FAIL: no anonymization evidence — no anonymized marker and no alias patterns (@user-…, domain-….org) found.');
    lines.push('Either the file was never anonymized or it contains no Matrix identifiers at all. Verify before analysing.');
    return { ok: false, report: lines.join('\n') };
  }
  lines.push(`PASS: anonymized (${markerCount} marker(s), ${aliasCount} alias signal(s), 0 raw identifiers, 0 raw URL hosts).`);
  // A log the anonymizer had to drop is gone before ingest sees it, so the
  // fail-loud guard there can't fire. Say it here: the analysis is a partial view.
  const droppedLogs = ing.removedEntries.filter(isAnalyzableEntry);
  if (droppedLogs.length > 0) {
    lines.push(`WARN: ${droppedLogs.length} log file(s) dropped by anonymization — analysis is a partial view: ${droppedLogs.join(', ')}`);
  }
  return { ok: true, report: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------

const trim = (s: string, n = 160): string => (s.length > n ? `${s.slice(0, n)}…` : s);

export function cmdSummary(ing: Ingest, flags: Flags = {}): string {
  const { merged, details, files, removedEntries } = ing;
  const lineIndex = new Map(merged.rawLogLines.map((l) => [l.lineNumber, l]));
  const stats = computeSummaryStats(
    merged.rawLogLines, merged.httpRequests, merged.requests, merged.connectionIds,
    merged.sentryEvents, null, null, null, lineIndex, merged.lifecycleEvents ?? [],
  );
  const events = merged.lifecycleEvents ?? [];
  const lifecycleCounts: Record<string, number> = {};
  for (const e of events) lifecycleCounts[e.kind] = (lifecycleCounts[e.kind] ?? 0) + 1;
  const coldStart = lastColdStartUs(events);
  const foreground = lastForegroundUs(events);
  const span = getMinMaxTimestamps(merged.rawLogLines);

  const perFile = files.map(({ name, result }) => {
    let errors = 0;
    let warns = 0;
    for (const l of result.rawLogLines) {
      if (l.level === 'ERROR') errors++;
      else if (l.level === 'WARN') warns++;
    }
    // Basename only: every row otherwise repeats the archive-id directory
    // prefix ("2026-07-31_111428-JLS3UB6A/"), which is the same on all of them.
    return { name: basename(name), lines: result.rawLogLines.length, errors, warns, http: result.httpRequests.length, sentry: result.sentryEvents.length };
  });
  // Noisiest files first, capped by default so a 100-file archive's per-file
  // table doesn't dominate the output; --top all restores the full list.
  const sortedFiles = [...perFile].sort((a, b) => (b.errors + b.warns) - (a.errors + a.warns) || b.lines - a.lines);
  // 5, not 20: the table was 38% of every summary (2,734 of 7,280 chars) and the
  // tail of it is quiet files. The noisiest few are what pick the next --file.
  const topN = flags.top === 'all' ? Infinity : intFlag(flags.top, 5);
  const shownFiles = sortedFiles.slice(0, topN);

  return JSON.stringify({
    details: details && {
      userText: details.userText,
      // Who the device is, so a UTD's sender and receiver can be told apart. The
      // device id and curve key are not aliased, but the logs print both raw anyway
      // (share recipients, setLoggedIn, sender_key), so this leaks nothing new.
      userId: details.userId,
      deviceId: details.deviceId,
      deviceKeys: details.deviceKeys,
      app: details.appId,
      version: details.version,
      // Element Web sends no sdk_sha; its crypto-wasm lines name the SDK checkout.
      sdkSha: details.sdkSha ?? rustSdkShaFromLogs(merged.rawLogLines),
      cryptoVersion: details.cryptoVersion,
      reportUrl: details.reportUrl,
    },
    files: shownFiles,
    ...(sortedFiles.length > shownFiles.length ? { filesOmitted: sortedFiles.length - shownFiles.length } : {}),
    // Dropped by the anonymizer, so the content is gone but its existence isn't:
    // a screenshot here is worth asking the user to describe. Key omitted when empty.
    ...(removedEntries.length ? { removedFiles: removedEntries } : {}),
    // Dated: bare clocks make a log spanning a day read as seconds.
    timeSpan: span.max > 0 ? { start: microsToISO(span.min as TimestampMicros), end: microsToISO(span.max as TimestampMicros) } : null,
    totals: {
      lines: stats.totalLogLines,
      errors: stats.errors,
      warnings: stats.warnings,
      httpRequests: stats.httpRequestCount,
      incompleteRequests: stats.incompleteRequestCount,
      sentryEvents: merged.sentryEvents.length,
    },
    // Already capped at the 5 most frequent by computeSummaryStats — no --top
    // cap here, or --top all would promise a full list the stats never produce.
    errorsByType: stats.errorsByType.map((e) => ({ count: e.count, message: trim(e.type) })),
    warningsByType: stats.warningsByType.map((e) => ({ count: e.count, message: trim(e.type) })),
    httpErrorsByStatus: stats.httpErrorsByStatus,
    topFailedUrls: stats.topFailedUrls.map((u) => ({ ...u, uri: trim(u.uri, 120) })),
    slowestHttpRequests: stats.slowestHttpRequests.slice(0, 5).map((r) => ({
      durationMs: r.duration, method: r.method, status: r.status, uri: trim(r.uri, 120),
    })),
    // `line` is per-file like every other number the CLI prints, so `file` has to
    // come with it — there is no merged view to resolve it against.
    sentryEvents: merged.sentryEvents.slice(0, 10).map((e) => {
      const sourceFile = lineIndex.get(e.lineNumber)?.sourceFile;
      const offset = sourceFile !== undefined ? ing.offsets.get(sourceFile) ?? 0 : 0;
      return {
        platform: e.platform,
        line: e.lineNumber - offset,
        ...(ing.files.length > 1 && sourceFile !== undefined ? { file: basename(sourceFile) } : {}),
        message: trim(e.message),
      };
    }),
    lifecycle: {
      counts: lifecycleCounts,
      lastColdStart: coldStart !== null ? microsToISO(coldStart) : null,
      lastForeground: foreground !== null ? microsToISO(foreground) : null,
    },
  });
}

// ---------------------------------------------------------------------------
// overview / spans trees
// ---------------------------------------------------------------------------

/**
 * Paginate pre-rendered tree lines the same way as line output: slice the body
 * by --offset/--limit and emit a footer. The tree is generated in full (bounded
 * by --depth), so --offset can page past the noisiest nodes into the rest.
 */
function emitTreeBody(out: string[], body: readonly string[], flags: Flags): void {
  const limit = intFlag(flags.limit, 100);
  const offset = intFlag(flags.offset, 0);
  const page = body.slice(offset, offset + limit);
  out.push(...page);
  const remaining = body.length - offset - page.length;
  if (remaining > 0) out.push(`# ${remaining} more nodes — next: --offset ${offset + page.length}`);
  if (page.length === 0) {
    out.push(body.length === 0
      ? '# no matching nodes'
      : `# --offset ${offset} is past the end (${body.length} nodes) — lower --offset`);
  }
}

function overviewTotal(node: OverviewNode, memo: Map<OverviewNode, number>): number {
  const cached = memo.get(node);
  if (cached !== undefined) return cached;
  let total = node.leaves.reduce((s, l) => s + l.occurrences.length, 0);
  for (const c of node.children) total += overviewTotal(c, memo);
  memo.set(node, total);
  return total;
}

export function cmdOverview(ing: Ingest, flags: Flags): string {
  const out: string[] = [];
  const range = resolveRange(ing.merged, flags, (m) => out.push(m));
  rangeHeader(out, range, ing.merged);
  const indices = selectIndices(ing.merged, range, flags);
  const root = buildLogOverview(indices.map((i) => ing.merged.rawLogLines[i]));
  const memo = new Map<OverviewNode, number>();
  const depth = intFlag(flags.depth, 3);
  const body: string[] = [];

  const visit = (node: OverviewNode, level: number): void => {
    const children = [...node.children].sort((a, b) =>
      (b.errorCount + b.warnCount) - (a.errorCount + a.warnCount) || overviewTotal(b, memo) - overviewTotal(a, memo));
    for (const child of children) {
      const indent = '  '.repeat(level);
      const marks = child.errorCount || child.warnCount ? ` — ${child.errorCount} err, ${child.warnCount} warn` : '';
      body.push(`${indent}${child.segment} (${overviewTotal(child, memo)})${marks}`);
      if (level + 1 < depth) visit(child, level + 1);
      else if (child.children.length > 0) body.push(`${indent}  … deeper levels hidden — use --depth ${depth + 1}`);
      // Show where errors/warns come from: top offending leaves only.
      const noisyLeaves = child.leaves.filter((l) => l.errorCount + l.warnCount > 0)
        .sort((a, b) => (b.errorCount + b.warnCount) - (a.errorCount + a.warnCount)).slice(0, 5);
      for (const leaf of noisyLeaves) {
        body.push(`${indent}  @ ${leaf.location} — ${leaf.errorCount} err, ${leaf.warnCount} warn (${leaf.occurrences.length} lines)`);
      }
    }
  };
  visit(root, 0);
  emitTreeBody(out, body, flags);
  return out.join('\n');
}

/**
 * Flat per-target activity table, quietest-first: when did each module last
 * log inside the window?
 *
 * Silence is evidence. A wedged subsystem (deadlock, stuck task) simply stops
 * logging — no error ever fires — while the rest of the process carries on,
 * so presence-oriented views (`overview`, `grep`) look healthy. Sorting
 * targets by their last line and showing how long each has been silent before
 * the window end names the frozen subsystem in one call — the case this was
 * built for had the event cache's last line 11 minutes before the report was
 * sent while sliding sync logged to the final second.
 */
export function cmdLastSeen(ing: Ingest, flags: Flags): string {
  const out: string[] = [];
  const range = resolveRange(ing.merged, flags, (m) => out.push(m));
  rangeHeader(out, range, ing.merged);
  const indices = selectIndices(ing.merged, range, flags);

  interface Row { count: number; lastUs: number; }
  const rows = new Map<string, Row>();
  for (const i of indices) {
    const line = ing.merged.rawLogLines[i];
    if (!line.timestampUs) continue;
    const target = extractTarget(line.rawText) ?? '(no target)';
    const row = rows.get(target);
    if (row) {
      row.count += 1;
      row.lastUs = Math.max(row.lastUs, line.timestampUs);
    } else {
      rows.set(target, { count: 1, lastUs: line.timestampUs });
    }
  }
  if (rows.size === 0) {
    out.push('# no matching lines');
    return out.join('\n');
  }

  const endUs = range?.endUs ?? getMinMaxTimestamps(ing.merged.rawLogLines).max;
  const limit = intFlag(flags.limit, 40);
  // Quietest first: the wedged subsystem floats to the top.
  const sorted = [...rows.entries()].sort((a, b) => a[1].lastUs - b[1].lastUs);

  out.push(`# ${rows.size} targets · sorted by last activity (quietest first) · silent = gap to window end`);
  for (const [target, row] of sorted.slice(0, limit)) {
    const silentUs = endUs - row.lastUs;
    // formatDuration takes milliseconds.
    const silentLabel = silentUs > 1e6 ? `silent ${formatDuration(silentUs / 1000)}` : 'active at end';
    out.push(`${microsToISO(row.lastUs as TimestampMicros)}  ${silentLabel.padEnd(14)}  ${target} (${row.count} lines)`);
  }
  if (sorted.length > limit) out.push(`# ${sorted.length - limit} more targets — raise --limit`);
  return out.join('\n');
}

export function cmdSpans(ing: Ingest, flags: Flags): string {
  const out: string[] = [];
  const range = resolveRange(ing.merged, flags, (m) => out.push(m));
  rangeHeader(out, range, ing.merged);
  const indices = selectIndices(ing.merged, range, flags);
  const root = buildSpanOverview(indices.map((i) => ing.merged.rawLogLines[i]));
  const depth = intFlag(flags.depth, 3);
  const body: string[] = [];

  // Memoized per node (like overviewTotal): spanTotal is called once per node
  // while rendering, and each call walks the whole subtree, so without a cache
  // the totals are O(n²) on large span trees.
  const spanMemo = new Map<SpanNode, number>();
  const spanTotal = (node: SpanNode): number => {
    const cached = spanMemo.get(node);
    if (cached !== undefined) return cached;
    const total = node.leaves.reduce((s, l) => s + l.occurrences.length, 0)
      + node.children.reduce((s, c) => s + spanTotal(c), 0);
    spanMemo.set(node, total);
    return total;
  };

  const visit = (node: SpanNode, level: number): void => {
    const children = [...node.children].sort((a, b) => (b.errorCount + b.warnCount) - (a.errorCount + a.warnCount));
    for (const child of children) {
      const indent = '  '.repeat(level);
      const fields = child.fields.slice(0, 2)
        // Bound the whole value list: sliding-sync pos= fields carry up to 5
        // distinct tokens of hundreds of chars each and otherwise dominate output.
        .map((f) => {
          const joined = f.values.join('|');
          const shown = trim(joined, 64);
          // trim already appends '…' when it cuts; only add the distinct-values
          // marker when the string wasn't length-trimmed, to avoid '…|…'.
          return `${f.key}=${shown}${f.truncated && shown === joined ? '|…' : ''}`;
        }).join(' ');
      const marks = child.errorCount || child.warnCount ? ` — ${child.errorCount} err, ${child.warnCount} warn` : '';
      body.push(`${indent}${child.name}${fields ? ` {${fields}}` : ''} (${spanTotal(child)})${marks}`);
      if (level + 1 < depth) visit(child, level + 1);
      else if (child.children.length > 0) body.push(`${indent}  … deeper levels hidden — use --depth ${depth + 1}`);
    }
  };
  visit(root, 0);
  emitTreeBody(out, body, flags);
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// grep / slice
// ---------------------------------------------------------------------------

export function cmdGrep(ing: Ingest, patterns: readonly string[], flags: Flags): string {
  const out: string[] = [];
  const range = resolveRange(ing.merged, flags, (m) => out.push(m));
  rangeHeader(out, range, ing.merged);
  const indices = selectIndices(ing.merged, range, flags);
  const lines = ing.merged.rawLogLines;
  const queries = patterns.map((p) => p.toLowerCase());
  // Per-pattern counts, not one combined total: with several patterns in a call
  // a dud pattern is invisible in the total, and a zero has to distinguish "not
  // in this window" from "never logged" — otherwise the next call is a guess.
  // One pass yields both the counts and the match set: lowercasing each line
  // once per pattern would scan the selection P+1 times for the same answer.
  const counts = new Array<number>(queries.length).fill(0);
  const firstUs = new Array<number>(queries.length).fill(0);
  const lastUs = new Array<number>(queries.length).fill(0);
  const matches: number[] = [];
  for (const i of indices) {
    const text = lines[i].rawText.toLowerCase();
    let hit = false;
    for (let k = 0; k < queries.length; k++) {
      if (text.includes(queries[k])) {
        counts[k]++;
        hit = true;
        const t = lines[i].timestampUs;
        if (t > 0) {
          if (firstUs[k] === 0) firstUs[k] = t;
          lastUs[k] = t;
        }
      }
    }
    if (hit) matches.push(i);
  }

  const narrowed = range !== null || flags.level !== undefined || flags.file !== undefined;
  const hints: string[] = [];
  for (const [k, n] of counts.entries()) {
    if (n > 0 || !narrowed) continue;
    let inLog = 0;
    for (const l of lines) if (l.rawText.toLowerCase().includes(queries[k])) inLog++;
    hints.push(inLog > 0
      ? `# "${patterns[k]}" 0 in range, ${inLog} in full log — widen --last/--since/--from, or drop --level/--file`
      : `# "${patterns[k]}" 0 in range and 0 in full log — the pattern is never logged`);
  }
  // A regex alternation finds nothing, and "never logged" would send the caller the wrong way.
  for (const [k, n] of counts.entries()) {
    if (n === 0 && patterns[k].includes('|')) hints.push(`# "${patterns[k]}": patterns are literal substrings, not regexes — pass alternatives as separate arguments`);
  }
  const summary = counts.map((n, k) => `"${patterns[k]}" ${n}`).join(' · ');
  out.push(`# ${summary}${queries.length > 1 ? ` — ${matches.length} lines` : ` line${counts[0] === 1 ? '' : 's'}`}`);
  out.push(...hints);

  if (flags.count) {
    // One histogram mixes the patterns: say when each one happens, so each gets its own window.
    if (queries.length > 1) {
      const sameDay = new Set([...firstUs, ...lastUs].filter((t) => t > 0).map((t) => microsToISO(t as TimestampMicros).slice(0, 10))).size <= 1;
      const at = (us: number) => microsToISO(us as TimestampMicros).slice(sameDay ? 11 : 5, sameDay ? 19 : 16);
      const when = patterns.flatMap((p, k) => (firstUs[k] > 0 ? [`"${p}" ${at(firstUs[k])} → ${at(lastUs[k])}`] : []));
      if (when.length > 0) out.push(`# when: ${when.join(' · ')}`);
    }
    emitDistribution(out, lines, matches);
    return out.join('\n');
  }

  const around = intFlag(flags.around, 0);
  let selected = matches;
  if (around > 0) {
    // Expand within the filtered index list so context respects level/file/time filters.
    const positions = new Map(indices.map((idx, pos) => [idx, pos]));
    const keep = new Set<number>();
    for (const m of matches) {
      const pos = positions.get(m)!;
      for (let p = Math.max(0, pos - around); p <= Math.min(indices.length - 1, pos + around); p++) keep.add(indices[p]);
    }
    selected = [...keep].sort((a, b) => a - b);
  }
  emitEntries(out, buildDisplayEntries(lines, selected, flags.spans === true), flags, ing);
  return out.join('\n');
}

export function cmdSlice(ing: Ingest, flags: Flags): string {
  const out: string[] = [];
  const range = resolveRange(ing.merged, flags, (m) => out.push(m));
  rangeHeader(out, range, ing.merged);
  const indices = selectIndices(ing.merged, range, flags);
  if (flags.count) {
    out.push(`# ${indices.length} lines`);
    emitDistribution(out, ing.merged.rawLogLines, indices);
    return out.join('\n');
  }
  emitEntries(out, buildDisplayEntries(ing.merged.rawLogLines, indices, flags.spans === true), flags, ing);
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// http
// ---------------------------------------------------------------------------

function isFailed(r: HttpRequest): boolean {
  // status may carry a reason phrase ("404 Not Found"), so parse the numeric
  // prefix rather than Number(), which returns NaN for the whole string.
  return !!r.clientError || parseInt(r.status, 10) >= 400;
}

export function cmdHttp(ing: Ingest, flags: Flags): string {
  const out: string[] = [];
  const range = resolveRange(ing.merged, flags, (m) => out.push(m));
  rangeHeader(out, range, ing.merged);
  const lineIndex = new Map(ing.merged.rawLogLines.map((l) => [l.lineNumber, l]));
  const timeOf = (r: HttpRequest): number =>
    lineIndex.get(r.sendLineNumber || r.responseLineNumber)?.timestampUs ?? 0;

  let reqs = ing.merged.httpRequests.filter((r) => {
    if (range) {
      const ts = timeOf(r);
      if (ts < range.startUs || ts > range.endUs) return false;
    }
    return flags.errors ? isFailed(r) : true;
  });

  if (flags.slowest !== undefined) {
    reqs = [...reqs].sort((a, b) => b.requestDurationMs - a.requestDurationMs).slice(0, intFlag(flags.slowest, 10));
  }

  out.push(`# ${reqs.length} requests${flags.errors ? ' (failures only)' : ''}`);
  // Same reason as grep's hint: an empty result has to say whether the window or
  // the filter emptied it, or the follow-up call is a guess. `http` came back
  // empty on most of its recorded runs and said nothing about why.
  if (reqs.length === 0 && (range !== null || flags.errors)) {
    const total = ing.merged.httpRequests.length;
    const failed = ing.merged.httpRequests.filter(isFailed).length;
    out.push(total === 0
      ? '# no HTTP requests in this log at all'
      : `# ${total} requests in the full log, ${failed} of them failures — widen --last/--since/--from${flags.errors ? ', or drop --errors' : ''}`);
  }
  const limit = intFlag(flags.limit, LINE_LIMIT);
  const offset = intFlag(flags.offset, 0);
  const page = reqs.slice(offset, offset + limit);
  const tags = ing.files.length > 1 ? fileTags(ing) : null;
  const legend = filesLegend(ing, tags, page.map((r) => lineIndex.get(r.sendLineNumber || r.responseLineNumber)?.sourceFile));
  if (legend) out.push(legend);
  for (const r of page) {
    const line = lineIndex.get(r.sendLineNumber || r.responseLineNumber);
    const time = line?.displayTime ? line.displayTime.slice(0, 12) : '?';
    const outcome = r.clientError ? `err=${r.clientError}` : (r.status || 'incomplete');
    const retries = (r.numAttempts ?? 1) > 1 ? ` attempts=${r.numAttempts}` : '';
    const ref = lineRef(r.sendLineNumber || r.responseLineNumber, line?.sourceFile, tags, ing.offsets);
    out.push(`${time} ${r.method} ${trim(r.uri, 120)} → ${outcome} ${r.requestDurationMs}ms up=${r.requestSizeString || '0'} down=${r.responseSizeString || '0'}${retries} [line ${ref}]`);
  }
  const remaining = reqs.length - offset - page.length;
  if (remaining > 0) out.push(`# ${remaining} more — next: --offset ${offset + page.length}`);
  if (page.length === 0 && reqs.length > 0) {
    out.push(`# --offset ${offset} is past the end (${reqs.length} requests) — lower --offset`);
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// cycles
// ---------------------------------------------------------------------------

/** `HH:MM:SS.mmm` — the date lives on a day marker, as in `emitEntries`. */
const clockOf = (us: number): string => microsToISO(us as TimestampMicros).slice(11, 23);

/** Emit a `# YYYY-MM-DD` marker when the day changes; returns the new day. */
function pushDayMarker(out: string[], us: number, lastDay: string): string {
  const day = microsToISO(us as TimestampMicros).slice(0, 10);
  if (day !== lastDay) out.push(`# ${day}`);
  return day;
}

/** A run of consecutive idle/refresh segments, collapsed into one row. */
interface CollapsedSegment {
  readonly startUs: number;
  readonly endUs: number;
  readonly state: string;
  readonly collapsed: number;
}

const IDLE_STATES = new Set(['background', 'backgroundWorking']);
// ponytail: a run of 4 is two OS refresh wakes — below that the churn is short
// enough to read. Raise it if orientation still arrives buried.
const COLLAPSE_RUN = 4;

/**
 * Collapse long background/backgroundWorking alternations into a single row.
 *
 * iOS wakes a backgrounded app every few minutes to refresh, which derives as
 * `background → backgroundWorking → background → …` for as long as the log runs.
 * On a 9-day archive that churn was 132 of 165 segments and said nothing: the
 * interesting structure is the foreground sessions it sits between. Collapsing
 * keeps the run's real boundaries, so a window into it is still one --from/--to.
 */
function collapseIdleRuns(segs: readonly AppStateSegment[]): (AppStateSegment | CollapsedSegment)[] {
  const rows: (AppStateSegment | CollapsedSegment)[] = [];
  let i = 0;
  while (i < segs.length) {
    let j = i;
    while (j < segs.length && IDLE_STATES.has(segs[j].state)) j++;
    if (j - i >= COLLAPSE_RUN) {
      rows.push({ startUs: segs[i].startUs, endUs: segs[j - 1].endUs, state: 'background+refresh', collapsed: j - i });
      i = j;
    } else {
      rows.push(segs[i]);
      i++;
    }
  }
  return rows;
}

export function cmdCycles(ing: Ingest, flags: Flags): string {
  const out: string[] = [];
  const range = resolveRange(ing.merged, flags, (m) => out.push(m));
  rangeHeader(out, range, ing.merged);
  const all = (ing.merged.lifecycleEvents ?? []) as readonly LifecycleEvent[];
  const events = range ? all.filter((e) => e.timestampUs >= range.startUs && e.timestampUs <= range.endUs) : all;

  const limit = intFlag(flags.limit, 100);
  const offset = intFlag(flags.offset, 0);
  if (events.length === 0) {
    out.push('# no lifecycle events detected');
  } else {
    // Kind histogram instead of one row per event. Nothing is hidden: every
    // counted kind other than the markers below is a segment boundary, and the
    // segment list is the same information as a duration.
    const byKind = new Map<string, number>();
    for (const e of events) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);
    const kinds = [...byKind].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`);
    out.push(`# ${events.length} lifecycle events (${events[0].platform}): ${kinds.join(' · ')}`);

    // Only coldStart/crash are listed: MARKER_KINDS is the viewer's own split
    // between point-in-time signals and durations, and the durations are already
    // rendered as segments. Listing both was the same data printed twice.
    const markers = events.filter((e) => (MARKER_KINDS as readonly string[]).includes(e.kind));
    const { page: markerPage, older: olderMarkers } = tailPage(markers, limit, offset);
    if (markers.length === 0) {
      out.push('# no cold starts or crashes');
    } else if (markerPage.length === 0) {
      out.push(`# --offset ${offset} is past the end (${markers.length} markers) — lower --offset`);
    } else {
      out.push('# cold starts / crashes:');
      if (olderMarkers > 0) out.push(`# ${olderMarkers} earlier markers — next: --offset ${offset + markerPage.length}`);
      const tags = ing.files.length > 1 ? fileTags(ing) : null;
      const lineIndex = new Map(ing.merged.rawLogLines.map((l) => [l.lineNumber, l]));
      const legend = filesLegend(ing, tags, markerPage.map((e) => lineIndex.get(e.lineNumber)?.sourceFile));
      if (legend) out.push(legend);
      let lastDay = '';
      for (const e of markerPage) {
        lastDay = pushDayMarker(out, e.timestampUs, lastDay);
        const ref = lineRef(e.lineNumber, lineIndex.get(e.lineNumber)?.sourceFile, tags, ing.offsets);
        out.push(`  ${clockOf(e.timestampUs)} ${e.kind} [line ${ref}]`);
      }
    }
  }

  const { min, max } = getMinMaxTimestamps(ing.merged.rawLogLines);
  if (min > 0) {
    const segments = deriveAppStateSegments(all, range?.startUs ?? min, range?.endUs ?? max);
    const rows = collapseIdleRuns(segments);
    const { page: segPage, older: olderSegs } = tailPage(rows, limit, offset);
    if (rows.length === 0) {
      out.push('# app-state segments:');
      out.push('  # none');
    } else if (segPage.length === 0) {
      out.push('# app-state segments:');
      out.push(`  # --offset ${offset} is past the end (${rows.length} segments) — lower --offset`);
    } else {
      // Segments are contiguous, so each row's end is the next row's start —
      // printing both doubled the timestamps for nothing. Start + duration, and
      // the section header carries the one end that has no successor.
      out.push(`# app-state segments (start · state · duration; contiguous through ${microsToISO(segPage[segPage.length - 1].endUs as TimestampMicros)}):`);
      if (olderSegs > 0) out.push(`  # ${olderSegs} earlier segments — next: --offset ${offset + segPage.length}`);
      let lastDay = '';
      for (const s of segPage) {
        lastDay = pushDayMarker(out, s.startUs, lastDay);
        const runs = 'collapsed' in s ? ` ×${s.collapsed}` : '';
        out.push(`  ${clockOf(s.startUs)} ${s.state}${runs} (${formatDuration((s.endUs - s.startUs) / 1000)})`);
      }
    }
  }
  const coldStart = lastColdStartUs(all);
  const foreground = lastForegroundUs(all);
  out.push(`# last cold start: ${coldStart !== null ? microsToISO(coldStart) : 'none'}`);
  out.push(`# last foreground: ${foreground !== null ? microsToISO(foreground) : 'none'}`);
  out.push(`# crashes: ${all.filter((e) => e.kind === 'crash').length}`);
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// megolm
// ---------------------------------------------------------------------------

/** One archive given to `megolm`: the path as typed (for the next-command hints) and its ingest. */
export interface MegolmArchive {
  readonly path: string;
  readonly ing: Ingest;
}

const ID_ALIAS_RE = { event: /\$event-[0-9a-f]+/, room: /!room-[0-9a-f]+/, sender: /@user-[0-9a-f]+/ } as const;
/** Hex digits an alias prefix needs: fewer would match unrelated ids. */
const MIN_ALIAS_HEX = 6;
const ID_SIGIL = { event: '$event-…', room: '!room-…', sender: '@user-…' } as const;

/** An id without its domain alias: what an alias flag matches on, so `!room-x` finds `!room-x:domain-y.org`. */
const idKey = (id: string | undefined): string | undefined => id?.split(':')[0];
/** An id names the alias a flag gave, or starts with it: people quote ids cut short. */
const isAlias = (id: string | undefined, alias: string): boolean => idKey(id)?.startsWith(alias) ?? false;

/**
 * The alias an id flag names, taken from an alias or any text holding one (a
 * permalink, percent-encoded or not). A raw id never matches the archive's
 * aliases without the anonymizer's salt, which the CLI never has, so it is refused.
 */
function aliasFlag(text: string, kind: keyof typeof ID_ALIAS_RE): string {
  const m = ID_ALIAS_RE[kind].exec(decodeIdentifier(text));
  if (!m || m[0].length - m[0].indexOf('-') - 1 < MIN_ALIAS_HEX) {
    throw new Error(`--${kind} needs an anonymized id (${ID_SIGIL[kind]}, at least ${MIN_ALIAS_HEX} hex of it) or a permalink holding one: a raw id can never match the archive's aliases — alias it in shakeview first`);
  }
  return m[0];
}

/** Same steps in a row on one device from which the timeline folds them into one line. */
const FOLD_RUN = 3;

const JOURNEY_MARK: Readonly<Record<JourneyState, string>> = { ok: '✓', fail: '✗', unknown: '?', note: '·' };

/**
 * Megolm sessions across one or more rageshakes: the first archive is the main
 * device, the others added devices (the sender's rageshake, typically), as on
 * /decryption?archive=A&archive=B. Without --event/--session, a list of sessions,
 * newest first, with each archive's outcome; with one, that session's verdict,
 * checklist, events, recipients and step timeline.
 */
export function cmdMegolm(archives: readonly MegolmArchive[], flags: Flags = {}): string {
  // Every archive, not just the main one: the agent's precheck habit covers the main archive only.
  for (const a of archives) {
    const { ok, report } = cmdPrecheck(a.ing);
    if (!ok) throw new Error(`${a.path} fails precheck — anonymize it with shakeview first:\n${report}`);
  }
  const devices = archives.map((a) => deviceFromLoadedLogs(basename(a.path), a.ing.merged.rawLogLines, a.ing.details));
  if (new Set(devices.map((d) => d.id)).size < devices.length) throw new Error('two archives share a file name: rename one, the name tells devices apart');
  const num = new Map(devices.map((d, i) => [d.id, i + 1]));
  const model = buildCryptoModel(devices, { includeHealthy: true });

  // Refs are what `grep` prints on that archive; an added archive's carry its position.
  const tagsOf = archives.map((a) => (a.ing.files.length > 1 ? fileTags(a.ing) : null));
  const cited = new Map<string, string>();
  const ref = (r: LineRef): string => {
    const i = (num.get(r.archive) ?? 1) - 1;
    const tag = tagsOf[i]?.get(r.file);
    const where = i === 0 ? tag ?? '' : `${i + 1}${tag ? `:${tag}` : ''}`;
    if (tag) cited.set(i === 0 ? tag : where, `${i === 0 ? '' : `${devices[i].id}/`}${basename(r.file)}${skewNote(archives[i].ing, r.file)}`);
    return `[${r.line - (archives[i].ing.offsets.get(r.file) ?? 0)}${where ? `|${where}` : ''}]`;
  };

  const out: string[] = [];
  out.push(`# devices: ${devices.map((d, i) => {
    const who = d.identity.userId ? `${d.identity.userId} ${d.identity.deviceId ?? '?'}` : 'identity unknown';
    return `${i + 1}=${d.id} ${who}${i === 0 ? ' (main)' : ''}`;
  }).join(' · ')}`);
  const nexts = (what: string) => archives.map((a) => `# next: ./rs grep ${a.path} ${what}`);

  if (flags.event || flags.session) {
    let session: MegolmSession | undefined;
    let mainId = devices[0].id;
    if (flags.event) {
      const ev = aliasFlag(flags.event, 'event');
      // A prefix can name several events: refuse rather than pick one at random.
      const hits = model.flatMap((s) => s.utds.filter((x) => isAlias(x.eventId, ev)).map((u) => ({ s, u })));
      const named = [...new Set(hits.map(({ u }) => idKey(u.eventId)))];
      if (named.length > 1) return [...out, `# ${named.length} UTD events start with ${ev}: ${named.slice(0, 10).join(' · ')} — give more of it`].join('\n');
      if (hits.length > 0) {
        session = hits[0].s;
        // Judge the device that failed the event asked about: buildJourney keeps only its receiver's UTDs.
        mainId = hits[0].u.deviceId;
      }
      if (!session) return [...out, `# no UTD for ${ev} in the loaded logs: it may have decrypted fine`, ...nexts(`'${ev}'`)].join('\n');
    } else {
      const id = flags.session ?? '';
      // The exact id, else a prefix: base64 ids are long, and people quote them cut short.
      const named = model.filter((s) => s.sessionId === id);
      const matches = named.length > 0 || id.length < MIN_ALIAS_HEX ? named : model.filter((s) => s.sessionId.startsWith(id));
      if (matches.length > 1) return [...out, `# ${matches.length} sessions start with ${id}: ${matches.slice(0, 10).map((s) => s.sessionId).join(' · ')} — give more of it`].join('\n');
      session = matches[0];
      if (!session) return [...out, `# no megolm session ${id} in the loaded logs`].join('\n');
    }
    emitMegolmSession(out, session, devices, mainId, num, ref, flags);
    out.push(...nexts(session.sessionId));
    if (cited.size > 0) out.splice(1, 0, `# files: ${[...cited].map(([t, f]) => `${t}=${f}`).join(' · ')}`);
    return out.join('\n');
  }

  const range = resolveRange(archives[0].ing.merged, flags, (m) => out.push(m));
  if (range) rangeHeader(out, range, archives[0].ing.merged);
  const room = flags.room ? aliasFlag(flags.room, 'room') : undefined;
  const sender = flags.sender ? aliasFlag(flags.sender, 'sender') : undefined;
  const analytics = flags.analytics as AnalyticsCategory | undefined;
  if (analytics && !ANALYTICS_CATEGORIES.includes(analytics)) throw new Error(`invalid --analytics "${flags.analytics}" (use ${ANALYTICS_CATEGORIES.join(' | ')})`);
  const unroomed = (range ? scopeSessions(model, range.startUs, range.endUs) : model)
    .filter((s) => !flags.utd || s.utds.length > 0)
    .filter((s) => !analytics || matchesOutcomes(sessionEventKeys(s), null, analytics))
    .filter((s) => !sender || isAlias(s.sender.userId, sender) || s.utds.some((u) => u.steps.some((x) => isAlias(x.keys.userId, sender))));
  const sessions = unroomed
    .filter((s) => !room || isAlias(s.roomId, room))
    .map((s) => ({ s, ts: sessionTime(s) }))
    .sort((a, b) => b.ts - a.ts);

  const totals = devices.map((d, i) => {
    const mine = sessions.filter(({ s }) => (s.stepsByDevice[d.id]?.length ?? 0) > 0);
    const utds = mine.flatMap(({ s }) => s.utds.filter((u) => u.deviceId === d.id));
    return `${i + 1}: ${plural(mine.length, 'session')}, ${plural(utds.length, 'UTD')}${analyticsCounts(utds)}`;
  });
  out.push(`# ${plural(sessions.length, 'session')}${flags.utd ? ' with a UTD' : ''}, newest first · ${totals.join(' · ')}`);
  out.push('# time room session · sender (archive, how found) · per archive: utd:<reason>×N still failing, late:<how>×N decrypted later, (analytics)');
  out.push(`# ${REPORTED_MEANING}`);

  const limit = intFlag(flags.limit, LINE_LIMIT);
  const offset = intFlag(flags.offset, 0);
  const page = sessions.slice(offset, offset + limit);
  let lastDay = '';
  for (const { s, ts } of page) {
    lastDay = pushDayMarker(out, ts, lastDay);
    const from = s.sender.loadedId ? `${num.get(s.sender.loadedId)}, by ${s.senderSource}` : 'not loaded';
    const perArchive = devices.flatMap((d, i) => {
      const outcome = archiveOutcome(s, d);
      return outcome ? [`${i + 1}: ${outcome}`] : [];
    });
    out.push(`${clockOf(ts)} ${s.roomId ?? '?'} ${s.sessionId} · sender ${s.sender.userId ?? '?'}${s.sender.deviceId ? ` ${s.sender.deviceId}` : ''} (${from})${perArchive.map((p) => ` · ${p}`).join('')}`);
  }
  const remaining = sessions.length - offset - page.length;
  if (remaining > 0) out.push(`# ${remaining} more sessions — next: --offset ${offset + page.length}`);
  if (page.length === 0 && sessions.length > 0) out.push(`# --offset ${offset} is past the end (${sessions.length} sessions) — lower --offset`);
  else if (sessions.length === 0 && room) {
    // A room quoted from a report may be mistyped or aliased under another salt: show what is there.
    const byRoom = new Map<string, number>();
    // The main device's UTDs only: an added archive (the sender's) brings its own rooms' failures.
    for (const s of unroomed) if (s.roomId && s.utds.some((u) => u.deviceId === devices[0].id)) byRoom.set(s.roomId, (byRoom.get(s.roomId) ?? 0) + 1);
    const rooms = [...byRoom].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([r, n]) => `${r} (${plural(n, 'session')})`);
    out.push(`# no session in ${room}; rooms with a UTD on the main device: ${rooms.join(' · ') || 'none'}`);
  } else if (sessions.length === 0) out.push('# no megolm sessions');
  return out.join('\n');
}

/** UTDs per analytics value, as /decryption names them: ` (2 reported, 1 unknown)`; empty for none. */
function analyticsCounts(utds: readonly UtdEvent[]): string {
  const parts = ANALYTICS_CATEGORIES.flatMap((c) => {
    const n = utds.filter((u) => u.analytics.category === c).length;
    return n > 0 ? [`${n} ${c.replace('_', ' ')}`] : [];
  });
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

/** One archive's part of a session row: outbound and how widely shared, its UTDs by outcome, or that it got the key. */
function archiveOutcome(s: MegolmSession, d: CryptoDevice): string {
  const parts: string[] = [];
  if (s.sender.loadedId === d.id) {
    const { deviceCount } = shareRecipients(s.stepsByDevice[d.id] ?? [], d.identity.userId);
    parts.push(deviceCount > 0 ? `outbound, shared to ${plural(deviceCount, 'device')}` : 'outbound, no share logged');
  }
  const utds = s.utds.filter((u) => u.deviceId === d.id);
  if (utds.length > 0) {
    const byKey = new Map<string, number>();
    for (const u of utds) {
      const k = u.resolution.state === 'resolved' ? lateOutcomeKey(u.resolution.by) : utdOutcomeKey(u.reason);
      byKey.set(k, (byKey.get(k) ?? 0) + 1);
    }
    parts.push(`${[...byKey].map(([k, n]) => `${k}×${n}`).join(' ')}${analyticsCounts(utds)}`);
  } else if (parts.length === 0 && (s.stepsByDevice[d.id] ?? []).some((x) => x.kind === 'roomkey.received')) {
    parts.push('key_received');
  }
  return parts.join(' ');
}

/** One session in full: verdict and checklist (buildJourney), events, recipients with delivery, step timeline. */
function emitMegolmSession(
  out: string[], session: MegolmSession, devices: readonly CryptoDevice[], mainId: string,
  num: ReadonlyMap<string, number>, ref: (r: LineRef) => string, flags: Flags,
): void {
  const limit = intFlag(flags.limit, LINE_LIMIT);
  const offset = intFlag(flags.offset, 0);
  const width = intFlag(flags.width, 200);
  const { sender, receiver } = sessionLanes(session, devices, mainId);
  const j = buildJourney(session, sender, receiver);
  const who = (d: CryptoDevice | undefined) => (d ? `${num.get(d.id)} ${d.identity.userId ?? '?'} ${d.identity.deviceId ?? '?'}` : 'not loaded');
  out.push(`# session ${session.sessionId} · room ${session.roomId ?? '?'}`);
  const senderText = sender ? who(sender) : `${session.sender.userId ?? '?'} ${session.sender.deviceId ?? '?'} (not loaded)`;
  out.push(`# sender: ${senderText} · found by ${session.senderSource} · receiver: ${who(receiver)}`);
  out.push(`verdict: ${j.verdict}`);
  out.push(`basis: ${j.basis}`);
  for (const l of j.lines) {
    out.push(`${JOURNEY_MARK[l.state]} ${l.label} — ${l.detail}${l.ref ? ` ${ref(l.ref)}` : ''}${l.decisive ? ' ← decisive' : ''}`);
  }

  // `from` given = paged by --offset (the timeline, the longest section); else capped only.
  const capped = <T>(title: string, items: readonly T[], line: (x: T) => string, from?: number): void => {
    if (items.length === 0) return;
    out.push(title);
    const start = from ?? 0;
    const page = items.slice(start, start + limit);
    for (const x of page) out.push(line(x));
    const more = items.length - start - page.length;
    if (more > 0) out.push(`# ${more} more${from !== undefined ? ` — next: --offset ${start + page.length}` : ''}`);
  };

  capped(`events (${j.events.length}, first failure first):`, j.events, (e) => `${e.ok ? '✓' : '✗'} ${clockOf(e.ts)} ${e.eventId} ${e.text} ${ref(e.ref)}`);

  if (sender) {
    const steps = session.stepsByDevice[sender.id] ?? [];
    const shares = steps.filter((x) => x.kind === 'share.encrypt');
    const { users, deviceCount } = shareRecipients(steps, sender.identity.userId);
    const recipients = users.flatMap(([userId, ids]) => ids.map((deviceId) => ({ userId, deviceId })));
    capped(`recipients (${plural(deviceCount, 'device')}, from archive ${num.get(sender.id)}'s shares):`, recipients, ({ userId, deviceId }) => {
      const share = shares.filter((x) => x.keys.recipients?.some(([u, d]) => u === userId && d === deviceId)).pop();
      const link = session.deliveries.filter((x) => x.userId === userId && x.deviceId === deviceId).pop();
      const parts = [`${userId} ${deviceId}`, `shared ${share ? `${clockOf(share.ts)} ${ref(share.line)}` : '?'}`];
      if (link) {
        parts.push(`msgid ${link.messageId}`);
        if (link.http) parts.push(`/sendToDevice ${link.http.keys.status ?? '?'}`);
        if (link.received) parts.push(`received by ${num.get(link.receiverId ?? '')} ${clockOf(link.received.ts)} ${ref(link.received.line)}`);
        else if (link.receiverId) parts.push(`not in archive ${num.get(link.receiverId)}'s logs`);
      }
      return parts.join(' · ');
    });
    if (recipients.length > 0) out.push('# withheld codes per device are not logged; shares older than the logs are not visible');
  }

  const decisive = j.lines.find((l) => l.decisive)?.ref;
  const isDecisive = (x: CryptoStep) => decisive?.archive === x.line.archive && decisive.file === x.line.file && decisive.line === x.line.line;
  const timeline = Object.values(session.stepsByDevice).flat().sort((a, b) => a.ts - b.ts);
  // A burst of the same step on one device (ten UTDs in a row) reads as one line.
  const runs: CryptoStep[][] = [];
  for (const x of timeline) {
    const last = runs[runs.length - 1];
    if (last && last[0].kind === x.kind && last[0].line.archive === x.line.archive) last.push(x);
    else runs.push([x]);
  }
  // A run holding the decisive step stays unfolded: a folded row cites only its first step's ref.
  const rows = runs.flatMap((r) => (r.length >= FOLD_RUN && !r.some(isDecisive) ? [r] : r.map((x) => [x])));
  let lastDay = '';
  capped(`timeline (${plural(timeline.length, 'step')}, time order: time archive step):`, rows, (r) => {
    const marker: string[] = [];
    lastDay = pushDayMarker(marker, r[0].ts, lastDay);
    const fold = r.length > 1 ? ` ×${r.length} to ${clockOf(r[r.length - 1].ts)}` : '';
    const mark = isDecisive(r[0]) ? ' ← decisive' : '';
    const text = flags.raw ? (width > 0 ? trim(r[0].text, width) : r[0].text) : describeStep(r[0]);
    return [...marker, `${clockOf(r[0].ts)} ${num.get(r[0].line.archive)} ${text}${fold} ${ref(r[0].line)}${mark}`].join('\n');
  }, offset);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export function run(argv: string[]): { code: number; output: string } {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      since: { type: 'string' },
      last: { type: 'string' },
      level: { type: 'string' },
      around: { type: 'string' },
      file: { type: 'string' },
      limit: { type: 'string' },
      offset: { type: 'string' },
      depth: { type: 'string' },
      errors: { type: 'boolean' },
      slowest: { type: 'string' },
      top: { type: 'string' },
      count: { type: 'boolean' },
      width: { type: 'string' },
      spans: { type: 'boolean' },
      utd: { type: 'boolean' },
      analytics: { type: 'string' },
      event: { type: 'string' },
      session: { type: 'string' },
      room: { type: 'string' },
      sender: { type: 'string' },
      raw: { type: 'boolean' },
    },
  });
  const [cmd, path] = positionals;
  // Every positional after the path is a grep pattern: one call can carry the
  // whole candidate set, instead of a shell loop that re-reads, gunzips and
  // re-parses the entire archive once per pattern. For megolm, more archives.
  const patterns = positionals.slice(2);
  if (!cmd || !path) return { code: 2, output: USAGE };
  const flags = values as Flags;

  // Validate the command (and grep's pattern) before touching the filesystem, so
  // a typo'd command surfaces the usage message rather than a parse/IO error.
  const known = ['precheck', 'summary', 'overview', 'lastseen', 'spans', 'grep', 'slice', 'http', 'cycles', 'megolm'];
  if (!known.includes(cmd)) return { code: 2, output: `unknown command "${cmd}"\n\n${USAGE}` };
  if (cmd === 'grep' && patterns.length === 0) return { code: 2, output: 'grep needs at least one pattern: rageshake grep <path> <pattern>...' };

  const ing = loadInput(path);
  switch (cmd) {
    case 'precheck': {
      const { ok, report } = cmdPrecheck(ing);
      return { code: ok ? 0 : 1, output: report };
    }
    case 'summary': return { code: 0, output: cmdSummary(ing, flags) };
    case 'overview': return { code: 0, output: cmdOverview(ing, flags) };
    case 'lastseen': return { code: 0, output: cmdLastSeen(ing, flags) };
    case 'spans': return { code: 0, output: cmdSpans(ing, flags) };
    case 'grep': return { code: 0, output: cmdGrep(ing, patterns, flags) };
    case 'slice': return { code: 0, output: cmdSlice(ing, flags) };
    case 'http': return { code: 0, output: cmdHttp(ing, flags) };
    case 'megolm': return { code: 0, output: cmdMegolm([{ path, ing }, ...patterns.map((p) => ({ path: p, ing: loadInput(p) }))], flags) };
    default: return { code: 0, output: cmdCycles(ing, flags) };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  try {
    if (argv[0] === 'serve') {
      // The one command that owns the process instead of printing and exiting,
      // so it is dispatched here rather than through run()'s output contract.
      await cmdServe(argv.slice(1));
    } else {
      const { code, output } = run(argv);
      process.stdout.write(`${output}\n`);
      process.exit(code);
    }
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}

import type { HttpRequest, SyncRequest, LogParserResult, ParsedLogLine, LogLevel, SentryEvent, LifecycleEvent } from '../types/log.types';
import type { ISODateTimeString, TimestampMicros } from '../types/time.types';
import { isoToMicros, extractTimeFromISO } from './timeUtils';
import { detectLifecycleKind } from './lifecycleEvents';
import { parseSizeString } from './sizeUtils';
import { ParsingError } from './errorHandling';
import { INCOMPLETE_STATUS_KEY } from './statusCodeUtils';
import { ISO_TIMESTAMP_RE, WEB_LEVEL_PREFIX_RE, stripLogPrefix } from './logMessageUtils';
import { detectAnonymizedLog, stripAnonymizedMarker } from './anonymizeUtils';
import { isLogcatFormat, parseLogcatContent } from './logcatParser';

/**
 * Mutable builder record used during log parsing before all fields have been
 * resolved. Once finalized, records are cast to the sealed readonly `HttpRequest`.
 * Using a dedicated mutable type keeps the builder phase type-safe while
 * `HttpRequest` itself remains immutable in the rest of the codebase.
 */
type HttpRequestRecord = { -readonly [K in keyof HttpRequest]?: HttpRequest[K] };

/**
 * Mutable view of a `ParsedLogLine` used only during the parsing phase to
 * accumulate continuation lines and update `rawText` in place. Cast to the
 * sealed `ParsedLogLine` when pushed to the output array.
 */
type MutableParsedLogLine = { -readonly [K in keyof ParsedLogLine]: K extends 'continuationLines' ? string[] : ParsedLogLine[K] };

// Regex patterns for parsing HTTP requests - generic (all URIs)
// request_size= is optional: some SDK log lines (e.g. API error responses) omit it from the span.
// request_id= is not necessarily the first field of the send{} span: since matrix-rust-sdk
// b8b4e9bb9 the span opens with `config=RequestConfig { … }`, whose own braces rule out a
// `[^}]*` prefix — hence the lazy `.*?`, which stays inside the send{} field list because
// request_id= appears there and nowhere later on the line.
const SEND_SPAN = String.raw`send\{.*?request_id="(?<id>[^"]+)"\s+method=(?<method>\S+)\s+uri="(?<uri>[^"]+)"`;
const HTTP_RESP_RE = new RegExp(SEND_SPAN + String.raw`(?:\s+request_size="(?<req_size>[^"]+)")?\s+status=(?<status>\S+)\s+response_size="(?<resp_size>[^"]+)"\s+request_duration=(?<duration_val>[0-9.]+)(?<duration_unit>ms|s)`);
const HTTP_SEND_RE = new RegExp(SEND_SPAN + String.raw`(?:\s+request_size="(?<req_size>[^"]+)")?(?![^}]*(?:status=|response_size=|request_duration=))`);
// Like HTTP_SEND_RE but without the negative lookahead — used for retry send lines
// (num_attempt > 1) whose span context already contains status/response fields from
// the previous attempt, which would otherwise prevent HTTP_SEND_RE from matching.
const HTTP_RETRY_SEND_RE = new RegExp(SEND_SPAN + String.raw`(?:\s+request_size="(?<req_size>[^"]+)")?`);

// Regex for client-side transport errors (no HTTP response received, e.g. timeout, connection failure).
// The span ends right after uri= (GET) or after request_size= (POST/PUT/PATCH, whose body size the
// SDK records before sending); the closing `}` is what separates these from API-error lines, whose
// span also carries status=/response_size=/request_duration= and belongs to the response path.
export const HTTP_CLIENT_ERROR_RE = new RegExp(String.raw`Error while sending request.*` + SEND_SPAN + String.raw`(?:\s+request_size="[^"]+")?\}`);
// Extracts the specific error source from reqwest-style errors (e.g. "source: TimedOut")
const CLIENT_ERROR_SOURCE_RE = /\bsource:\s*([A-Za-z]\w*)/;

// Extracts the attempt number from "Sending request num_attempt=N" log lines.
// The SDK emits num_attempt=1 on the first send and increments on each retry.
const NUM_ATTEMPT_RE = /\bnum_attempt=(\d+)/;

// Element Web (matrix-js-sdk FetchHttpApi) request lines carry no request id:
//   FetchHttpApi: --> GET <url>
//   FetchHttpApi: <-- GET <url> [655ms 200]   or   [8ms TypeError: NetworkError …]
const WEB_HTTP_RE = /FetchHttpApi: (?<dir>-->|<--) (?<method>[A-Z]+) (?<uri>\S+)(?: \[(?<ms>\d+)ms (?<outcome>.*)\])?/;

/**
 * Element Web requests log no id, so the parser numbers them 1, 2, 3… in send
 * order (mergeLogParserResults renumbers them across files). SDK ids
 * (`REQ-42`, `req-001`) are never bare digits.
 *
 * @example
 * isWebRequestId('12');     // true
 * isWebRequestId('REQ-12'); // false
 */
export function isWebRequestId(requestId: string): boolean {
  return /^\d+$/.test(requestId);
}

// Pattern for extracting log level - matches common Rust log formats
const LOG_LEVEL_RE = /\s(TRACE|DEBUG|INFO|WARN|ERROR)\s/;

// Element Web writes a single-letter level; map it onto the shared level names.
const WEB_LEVELS: Readonly<Record<string, LogLevel>> = { D: 'DEBUG', I: 'INFO', W: 'WARN', E: 'ERROR' };

function extractLogLevel(line: string): LogLevel {
  // Anchored web form first: a web line's payload can itself contain a Rust
  // level word (crypto-wasm lines repeat it), but the letter is authoritative.
  const web = line.match(WEB_LEVEL_PREFIX_RE);
  if (web) return WEB_LEVELS[web[1]];
  const match = line.match(LOG_LEVEL_RE);
  return match ? (match[1] as LogLevel) : 'UNKNOWN';
}

function stripMessagePrefix(message: string): string {
  // For ISO-prefixed lines, stripLogPrefix removes timestamp + level in one
  // anchored pass via LOG_PREFIX_RE. Short-circuit here so we never apply the
  // level-stripping regex to the payload (avoiding accidental removal of a
  // level word that legitimately appears inside the message text).
  const isoStripped = stripLogPrefix(message);
  if (isoStripped !== message) {
    return isoStripped.trim();
  }

  // For lines that use a time-only prefix (no date), strip the timestamp first
  // and then remove only a leading level token from the remaining message.
  return message
    .replace(/^\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\s+/, '')  // Time-only timestamp
    .replace(/^(TRACE|DEBUG|INFO|WARN|ERROR)\s+/, '')    // Leading log level (time-only lines)
    .trim();
}

// Pretty-format source line, in one of two forms depending on how crypto-wasm pulled the SDK:
//   develop builds (git dep):      `    at /home/runner/.cargo/git/checkouts/matrix-rust-sdk-<h>/<sha>/crates/x/src/y.rs:211`
//   release builds (crates.io dep): `    at /home/runner/.cargo/registry/src/index.crates.io-<h>/matrix-sdk-crypto-0.18.0/src/y.rs:1912`
// Both map to the repo-relative `crates/<crate>/…` path so the GitHub link resolves like a `| … |` one.
// Both anchored on matrix-rust-sdk (its checkout, or a `matrix-sdk*` crate): other deps (ruma)
// also have `crates/`, but every `.rs` link points at matrix-rust-sdk.
const PRETTY_GIT_SOURCE_RE = /^\s+at \S*\/checkouts\/matrix-rust-sdk-[0-9a-f]+\/[0-9a-f]+\/(crates\/\S+\.rs):(\d+)\s*$/;
const PRETTY_REGISTRY_SOURCE_RE = /^\s+at \S*\/registry\/src\/[^/]+\/(matrix-sdk(?:-[a-z]+)*)-\d+\.\d+\.\d+[^/]*\/(\S+\.rs):(\d+)\s*$/;

/**
 * Source location from a pretty-format `at …` continuation line, as the
 * matrix-rust-sdk repo-relative path, or null when the line is not one.
 */
function extractPrettySourceLocation(line: string): { filePath: string; sourceLineNumber: number } | null {
  const git = line.match(PRETTY_GIT_SOURCE_RE);
  if (git) return { filePath: git[1], sourceLineNumber: parseInt(git[2], 10) };
  const registry = line.match(PRETTY_REGISTRY_SOURCE_RE);
  if (registry) return { filePath: `crates/${registry[1]}/${registry[2]}`, sourceLineNumber: parseInt(registry[3], 10) };
  return null;
}

/**
 * Where an entry's pretty-format source reference sits in its continuation
 * lines, so the viewer can link it: crypto-wasm puts the location on an
 * `at …` line instead of the first line, where `| … |` references are linked.
 * `start`/`end` bound the path:line text after `at ` on line `lineIndex`.
 * Returns null when no continuation line names that location.
 *
 * @example
 * locatePrettySourceRef(
 *   ['    at /r/.cargo/git/checkouts/matrix-rust-sdk-5c/f333a32/crates/a/src/b.rs:7'],
 *   'crates/a/src/b.rs', 7,
 * ); // { lineIndex: 0, start: 7, end: 77 }
 */
export function locatePrettySourceRef(
  continuationLines: readonly string[],
  filePath: string,
  sourceLineNumber: number,
): { readonly lineIndex: number; readonly start: number; readonly end: number } | null {
  for (let i = 0; i < continuationLines.length; i++) {
    const line = continuationLines[i];
    const loc = extractPrettySourceLocation(line);
    if (loc && loc.filePath === filePath && loc.sourceLineNumber === sourceLineNumber) {
      return { lineIndex: i, start: line.indexOf('at ') + 3, end: line.trimEnd().length };
    }
  }
  return null;
}

/**
 * Extract file path and line number from a log line.
 * Matches the pipe-delimited pattern: | path/to/file.rs:42 |
 * Returns {filePath, sourceLineNumber} or {filePath: undefined, sourceLineNumber: undefined} if not found.
 */
function extractSourceLocation(line: string): { filePath?: string; sourceLineNumber?: number } {
  // Match pattern: "| <path>:<number> |" where path can contain slashes
  // The path must end with .swift or .rs for our purposes
  const match = line.match(/\|\s*([^\s|]+\.(?:rs|swift)):(\d+)\s*\|/);
  if (match && match[1] && match[2]) {
    return {
      filePath: match[1],
      sourceLineNumber: parseInt(match[2], 10),
    };
  }
  return {};
}

/**
 * Extract ISO timestamp from the start of a log line.
 *
 * Anchored at position 0 so that a match also implies the line is the start of
 * a new log entry — removing the need for a separate `lineStartsWithISOTimestamp`
 * check and keeping the hot parser loop to a single regex call per line.
 *
 * Returns the full ISO timestamp string when the line starts a new entry, or
 * an empty string when the line is a continuation (no leading timestamp).
 *
 * @example
 * extractISOTimestamp('2026-04-01T09:18:52.057456Z ERROR foo'); // '2026-04-01T09:18:52.057456Z'
 * extractISOTimestamp('    SomeError { status: 404 }');          // ''
 */
function extractISOTimestamp(line: string): ISODateTimeString {
  // ISO_TIMESTAMP_RE is the canonical pattern; using it here avoids duplicating
  // the literal. Anchored at ^ so this doubles as a new-entry vs continuation
  // discriminator.
  const isoMatch = line.match(ISO_TIMESTAMP_RE);
  if (isoMatch) {
    // Ensure it ends with Z for consistency
    const timestamp = isoMatch[0];
    return timestamp.endsWith('Z') ? timestamp : `${timestamp}Z`;
  }
  return '' as ISODateTimeString;
}

/**
 * Format timestamp for display (time-only portion).
 */
function formatDisplayTime(isoTimestamp: ISODateTimeString): string {
  if (!isoTimestamp) return '';
  return extractTimeFromISO(isoTimestamp);
}

/**
 * Parse ISO timestamp to microseconds.
 */
function parseTimestampMicros(isoTimestamp: ISODateTimeString): TimestampMicros {
  return isoToMicros(isoTimestamp);
}

const SENTRY_IOS_RE = /Sentry detected a crash in the previous run:\s+([a-f0-9]+)/i;
const SENTRY_ANDROID_STR = 'Sending error to Sentry';
const SENTRY_URL_BASE = 'https://sentry.tools.element.io/organizations/element/issues/?project=44&query=';

export interface AllHttpRequestsResult {
  readonly httpRequests: readonly HttpRequest[];
  readonly rawLogLines: readonly ParsedLogLine[];
  readonly sentryEvents: readonly SentryEvent[];
  readonly lifecycleEvents: readonly LifecycleEvent[];
}

export function parseAllHttpRequests(logContent: string): AllHttpRequestsResult {
  // Validate input
  if (!logContent || logContent.trim().length === 0) {
    throw new ParsingError('Log file is empty', 'error');
  }

  const lines = logContent.split('\n');
  // Map from requestId to all in-progress records for that ID.
  // Multiple requests can share the same requestId; each gets its own record.
  const recordsByRequestId = new Map<string, HttpRequestRecord[]>();
  // Flat list of all request records in discovery (insertion) order;
  // final output may be reordered later.
  const allRecordsList: HttpRequestRecord[] = [];
  const rawLogLines: ParsedLogLine[] = [];
  const sentryEvents: SentryEvent[] = [];
  const lifecycleEvents: LifecycleEvent[] = [];
  // Element Web sends still awaiting their response, keyed by "METHOD url", oldest first.
  const openWebSends = new Map<string, HttpRequestRecord[]>();
  let webRequestCount = 0;
  let linesWithTimestamps = 0;
  // Counts non-empty physical lines so the file-size gate below can fire even
  // when all physical lines are continuation lines folded into one UNKNOWN entry.
  let totalNonEmptyLines = 0;
  // Mutable reference to the last pushed entry, used to fold continuation
  // lines (lines without a leading ISO timestamp) into the parent record.
  let lastEntry: MutableParsedLogLine | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Empty lines terminate a multi-line block; nothing to display or accumulate.
    // Reset lastEntry so that a non-timestamped line after a blank line is not
    // folded into the previous entry across the blank-line boundary.
    if (!line.trim()) {
      lastEntry = null;
      continue;
    }

    totalNonEmptyLines++;

    // A single anchored regex call doubles as the new-entry vs continuation
    // discriminator (empty string → continuation; non-empty → new entry).
    const isoTimestamp = extractISOTimestamp(line);

    // Continuation line: non-empty but no leading ISO timestamp → belongs to
    // the previous log entry (e.g. the indented body of a multi-line Rust error).
    if (!isoTimestamp) {
      if (lastEntry !== null) {
        if (!lastEntry.continuationLines) lastEntry.continuationLines = [];
        lastEntry.continuationLines.push(line);
        // Extend rawText so search queries can match content in continuation lines.
        lastEntry.rawText = lastEntry.rawText + '\n' + line;
        // matrix-sdk-crypto-wasm (Element Web) logs in tracing's pretty format: the
        // source location is an `at ….rs:N` continuation line, not a `| … |` field.
        if (lastEntry.filePath === undefined) {
          const at = extractPrettySourceLocation(line);
          if (at) {
            lastEntry.filePath = at.filePath;
            lastEntry.sourceLineNumber = at.sourceLineNumber;
          }
        }
      } else {
        // Orphaned continuation line: appears before any timestamped entry (e.g.
        // a malformed log that starts mid-message). Emit it as a standalone UNKNOWN
        // entry so the content is visible in the log view rather than silently lost.
        const orphan: MutableParsedLogLine = {
          lineNumber: i + 1,
          rawText: line,
          isoTimestamp: '' as ISODateTimeString,
          timestampUs: 0 as TimestampMicros,
          displayTime: '',
          level: 'UNKNOWN',
          message: line,
          strippedMessage: line,
        };
        rawLogLines.push(orphan as ParsedLogLine);
        lastEntry = orphan;
      }
      // Continuation lines never contain HTTP span patterns; skip HTTP parsing.
      continue;
    }

    // === New log entry (line has a leading ISO timestamp) ===
    const level = extractLogLevel(line);
    const timestampUs = parseTimestampMicros(isoTimestamp);
    const displayTime = formatDisplayTime(isoTimestamp);
    const strippedMessage = stripMessagePrefix(line);
    const { filePath, sourceLineNumber } = extractSourceLocation(line);

    linesWithTimestamps++;

    const entry: MutableParsedLogLine = {
      lineNumber: i + 1,
      rawText: line,
      isoTimestamp,
      timestampUs,
      displayTime,
      level,
      message: line,
      strippedMessage,
      filePath,
      sourceLineNumber,
    };
    rawLogLines.push(entry as ParsedLogLine);
    lastEntry = entry;

    // Detect Sentry events
    if (line.includes(SENTRY_ANDROID_STR)) {
      sentryEvents.push({ platform: 'android', lineNumber: i + 1, message: line });
    } else {
      const iosMatch = line.match(SENTRY_IOS_RE);
      if (iosMatch) {
        const sentryId = iosMatch[1];
        sentryEvents.push({
          platform: 'ios',
          lineNumber: i + 1,
          message: line,
          sentryId,
          sentryUrl: `${SENTRY_URL_BASE}${sentryId}`,
        });
      }
    }

    // Detect app-lifecycle events (cold start / background / foreground / crash).
    // Reuses the timestamp already parsed for this entry. Skip on an unparseable
    // timestamp (timestampUs 0) — same "0 means absent" convention used elsewhere
    // (e.g. getMinMaxTimestamps) — so a corrupt line can't poison the state band
    // as the carried-in state for the whole timeline.
    const lifecycle = timestampUs > 0 ? detectLifecycleKind(line) : null;
    if (lifecycle) {
      lifecycleEvents.push({
        kind: lifecycle.kind,
        platform: lifecycle.platform,
        lineNumber: i + 1,
        timestampUs,
      });
      // A page reload drops every in-flight request: sends still open stay
      // incomplete instead of claiming the new page's responses to the same URL.
      if (lifecycle.platform === 'web' && lifecycle.kind === 'coldStart') openWebSends.clear();
    }

    // Element Web request lines have no request id: pair each response with the
    // oldest open send for the same method+url and mint a synthetic id.
    if (line.includes('FetchHttpApi: ')) {
      const webMatch = line.match(WEB_HTTP_RE);
      if (webMatch?.groups) {
        const { dir, method, uri, ms, outcome } = webMatch.groups;
        const key = `${method} ${uri}`;
        if (dir === '-->') {
          const rec: HttpRequestRecord = {
            requestId: String(++webRequestCount),
            method,
            uri,
            sendLineNumber: i + 1,
            attemptTimestampsUs: timestampUs ? [timestampUs] : [],
          };
          allRecordsList.push(rec);
          const queue = openWebSends.get(key);
          if (queue) queue.push(rec);
          else openWebSends.set(key, [rec]);
        } else if (outcome !== undefined) {
          let rec = openWebSends.get(key)?.shift();
          if (!rec) {
            // Response with no send in this file (log starts mid-request).
            rec = { requestId: String(++webRequestCount), method, uri };
            allRecordsList.push(rec);
          }
          rec.responseLineNumber = i + 1;
          rec.requestDurationMs = Number(ms);
          if (/^\d{3}$/.test(outcome)) rec.status = outcome;
          else rec.clientError = outcome;
        }
      }
      continue;
    }

    // Early filter for performance - look for HTTP request patterns
    if (!line.includes('request_id=') || !line.includes('send{')) {
      continue;
    }

    // Retry send lines (num_attempt > 1) carry span data accumulated from prior attempts,
    // including status=/response_size=/request_duration= fields from the previous response.
    // Detect them early so HTTP_RESP_RE does not mistake them for actual responses.
    const numAttemptEarlyMatch = line.match(NUM_ATTEMPT_RE);
    const isRetrySend = numAttemptEarlyMatch !== null && parseInt(numAttemptEarlyMatch[1], 10) > 1;

    // Try to match response pattern first (skip for retry sends)
    const respMatch = !isRetrySend ? line.match(HTTP_RESP_RE) : null;
    if (respMatch && respMatch.groups) {
      const requestId = respMatch.groups.id;

      // A span context may contain duplicate fields when the SDK accumulates data
      // from prior attempts (e.g. status=503 ... status=200 ...).  Always use the
      // last occurrence, which represents the final response outcome.
      const allStatuses = [...line.matchAll(/\bstatus=(\S+)/g)];
      const finalStatus = allStatuses.length > 0
        ? allStatuses[allStatuses.length - 1][1]
        : respMatch.groups.status;
      const allDurations = [...line.matchAll(/\brequest_duration=([0-9.]+)(ms|s)/g)];
      const lastDuration = allDurations.length > 0 ? allDurations[allDurations.length - 1] : null;
      const durationVal = lastDuration ? parseFloat(lastDuration[1]) : parseFloat(respMatch.groups.duration_val);
      const durationUnit = lastDuration ? lastDuration[2] : respMatch.groups.duration_unit;
      const allRespSizes = [...line.matchAll(/\bresponse_size="([^"]+)"/g)];
      const finalRespSize = allRespSizes.length > 0
        ? allRespSizes[allRespSizes.length - 1][1]
        : respMatch.groups.resp_size;

      const durationMs = Math.round(durationVal * (durationUnit === 's' ? 1000.0 : 1.0));

      if (!recordsByRequestId.has(requestId)) {
        recordsByRequestId.set(requestId, []);
      }
      const bucket = recordsByRequestId.get(requestId)!;

      // Pair this response with the best matching send by scanning the bucket
      // backwards (most-recent first) in a single pass.
      // Priority:
      //   1. Last send with matching method+uri that has no response yet.
      //   2. Last send with no method/uri (response arrived before its send line).
      //   3. Last send with no response yet (any method/uri).
      const respMethod = respMatch.groups.method;
      const respUri = respMatch.groups.uri;
      let rec: HttpRequestRecord | undefined;
      let fallbackEmpty: HttpRequestRecord | undefined;
      let fallbackAny: HttpRequestRecord | undefined;
      for (let idx = bucket.length - 1; idx >= 0; idx--) {
        const candidate = bucket[idx];
        if (candidate.responseLineNumber) continue;
        if (candidate.method === respMethod && candidate.uri === respUri) {
          rec = candidate;
          break;
        }
        if (!fallbackEmpty && !candidate.method) {
          fallbackEmpty = candidate;
        }
        if (!fallbackAny) {
          fallbackAny = candidate;
        }
      }
      if (!rec) rec = fallbackEmpty ?? fallbackAny;
      if (!rec) {
        // Response with no matching send: create a new record.
        rec = {};
        bucket.push(rec);
        allRecordsList.push(rec);
      }

      rec.requestId = requestId;
      rec.method = rec.method || respMatch.groups.method;
      rec.uri = rec.uri || respMatch.groups.uri;
      // Unconditionally overwrite so the final response always wins over any
      // intermediate attempt value that was folded into the record earlier.
      rec.status = finalStatus;
      rec.responseSizeString = finalRespSize;
      rec.requestSizeString = rec.requestSizeString || respMatch.groups.req_size;
      rec.requestDurationMs = durationMs;
      rec.responseLineNumber = i + 1;

      // For retried requests the SDK-reported request_duration covers only the last
      // attempt. Override with the wall-clock elapsed time from the first send so
      // the waterfall bar spans the full retry sequence.
      if ((rec.numAttempts ?? 1) > 1 && rec.attemptTimestampsUs?.length) {
        const responseTsUs = rawLogLines[rawLogLines.length - 1].timestampUs as number;
        if (responseTsUs && rec.attemptTimestampsUs[0]) {
          rec.requestDurationMs = Math.max(1, Math.round((responseTsUs - rec.attemptTimestampsUs[0]) / 1000));
        }
      }
      continue;
    }

    // Try to match send pattern.
    // Lines that match HTTP_CLIENT_ERROR_RE are exclusively handled by the
    // client-error path below, even when their span looks like a plain send
    // (no request_size=, no status=). Skipping them here prevents the updated
    // HTTP_SEND_RE (which no longer requires request_size=) from stealing those
    // lines before the client-error path can mark them as clientError records.
    // For retry sends use the broader HTTP_RETRY_SEND_RE (tolerates span fields from prior attempts).
    const sendMatch = !HTTP_CLIENT_ERROR_RE.test(line)
      ? (isRetrySend ? line.match(HTTP_RETRY_SEND_RE) : line.match(HTTP_SEND_RE))
      : null;
    if (sendMatch && sendMatch.groups) {
      const requestId = sendMatch.groups.id;
      const sendMethod = sendMatch.groups.method;
      const sendUri = sendMatch.groups.uri;

      // Extract attempt number (defaults to 1 when absent for backward compat).
      // Reuse numAttemptEarlyMatch computed above (avoids a second regex run on the same line).
      const numAttempt = numAttemptEarlyMatch ? parseInt(numAttemptEarlyMatch[1], 10) : 1;

      // The current line's timestamp is already in the last rawLogLines entry
      // (rawLogLines.push runs before HTTP matching in this same loop iteration).
      const lineTimestampUs: TimestampMicros = rawLogLines.length > 0
        ? rawLogLines[rawLogLines.length - 1].timestampUs
        : 0 as TimestampMicros;

      if (!recordsByRequestId.has(requestId)) {
        recordsByRequestId.set(requestId, []);
      }
      const bucket = recordsByRequestId.get(requestId)!;

      // When num_attempt > 1 this is a retry of an existing record.
      // Fold it into the most-recent record for this request_id+method+uri
      // that already has a sendLineNumber (the prior attempt).
      // Keep sendLineNumber pointing at the first attempt (bar start);
      // only push the new timestamp and update the attempt counter.
      if (numAttempt > 1) {
        let priorRec: HttpRequestRecord | undefined;
        for (let j = bucket.length - 1; j >= 0; j--) {
          const candidate = bucket[j];
          if (candidate.sendLineNumber && candidate.method === sendMethod && candidate.uri === sendUri) {
            priorRec = candidate;
            break;
          }
        }
        if (priorRec) {
          // If the previous attempt already has a resolved response/error, capture its
          // outcome before clearing, so the final response can fill these fields again.
          let intermediateStatus: string | undefined = priorRec.status
            ? priorRec.status.split(' ')[0]
            : priorRec.clientError || undefined;
          // When no explicit intermediate "Got response" / error line was logged between
          // retries (common in real SDK logs), the retry-send span accumulates the
          // previous attempt's outcome as the last status= field in the span context.
          // Extract it here so attemptOutcomes is populated for waterfall coloring.
          if (intermediateStatus === undefined) {
            const spanStatuses = [...line.matchAll(/\bstatus=(\S+)/g)];
            if (spanStatuses.length > 0) {
              intermediateStatus = spanStatuses[spanStatuses.length - 1][1];
            }
          }
          if (intermediateStatus !== undefined) {
            if (!priorRec.attemptOutcomes) {
              priorRec.attemptOutcomes = [];
            }
            (priorRec.attemptOutcomes as string[]).push(intermediateStatus);
            // Reset response fields so the next attempt's result fills them.
            priorRec.status = undefined;
            priorRec.clientError = undefined;
            priorRec.responseLineNumber = undefined;
            priorRec.requestDurationMs = undefined;
            priorRec.responseSizeString = undefined;
          }
          priorRec.numAttempts = numAttempt;
          if (lineTimestampUs && priorRec.attemptTimestampsUs) {
            (priorRec.attemptTimestampsUs as TimestampMicros[]).push(lineTimestampUs);
          }
          continue;
        }
        // No prior record found (e.g. log starts mid-retry) — fall through to create a new one
      }

      // Pair this send with the best compatible response-only record by scanning
      // backwards (most-recent first) in a single pass.
      // Priority:
      //   1. Last response-only record with matching method+uri.
      //   2. Last response-only record with no method/uri yet.
      //   3. Otherwise create a new record.
      let rec: HttpRequestRecord | null = null;
      let fallbackEmpty: HttpRequestRecord | null = null;
      for (let j = bucket.length - 1; j >= 0; j--) {
        const candidate = bucket[j];
        if (candidate.sendLineNumber) continue;
        if (candidate.method === sendMethod && candidate.uri === sendUri) {
          rec = candidate;
          break;
        }
        if (!fallbackEmpty && !candidate.method && !candidate.uri) {
          fallbackEmpty = candidate;
        }
      }
      if (!rec) rec = fallbackEmpty;
      if (!rec) {
        rec = {};
        bucket.push(rec);
        allRecordsList.push(rec);
      }

      rec.requestId = requestId;
      rec.method = sendMethod;
      rec.uri = sendUri;
      rec.requestSizeString = sendMatch.groups.req_size;
      rec.sendLineNumber = i + 1;
      rec.numAttempts = numAttempt;
      rec.attemptTimestampsUs = lineTimestampUs ? [lineTimestampUs] : [];
    } else {
      // Try to match client-side error pattern (no HTTP response: timeout, connection failure, etc.).
      // These lines contain "Error while sending request" and are skipped by HTTP_SEND_RE above.
      const clientErrMatch = line.match(HTTP_CLIENT_ERROR_RE);
      if (clientErrMatch && clientErrMatch.groups) {
        const requestId = clientErrMatch.groups.id;
        const sourceMatch = line.match(CLIENT_ERROR_SOURCE_RE);
        const clientError = sourceMatch ? sourceMatch[1] : 'SendError';

        if (!recordsByRequestId.has(requestId)) {
          recordsByRequestId.set(requestId, []);
        }
        const bucket = recordsByRequestId.get(requestId)!;

        // Find the most-recent send record with matching method+uri that has no response yet.
        const errMethod = clientErrMatch.groups.method;
        const errUri = clientErrMatch.groups.uri;
        let rec: HttpRequestRecord | undefined;
        let fallbackAny: HttpRequestRecord | undefined;
        for (let idx = bucket.length - 1; idx >= 0; idx--) {
          const candidate = bucket[idx];
          if (candidate.responseLineNumber) continue; // already resolved
          if (candidate.method === errMethod && candidate.uri === errUri) {
            rec = candidate;
            break;
          }
          if (!fallbackAny) {
            fallbackAny = candidate;
          }
        }
        if (!rec) rec = fallbackAny;
        if (!rec) {
          rec = {};
          bucket.push(rec);
          allRecordsList.push(rec);
        }

        rec.requestId = requestId;
        rec.method = rec.method || errMethod;
        rec.uri = rec.uri || errUri;
        rec.clientError = clientError;
        rec.responseLineNumber = i + 1;
        // For retried requests that end in a client error, duration is computed from
        // timestamps in finalization (sendLineNumber → first send, responseLineNumber →
        // error line). No override needed here; finalization handles it correctly because
        // sendLineNumber points to the first attempt's send line.
      }
    }
  }

  // Validate that we found at least some timestamps.
  // Gate on physical file size (totalNonEmptyLines) so short test snippets aren't
  // rejected. Use logical entry count (rawLogLines.length) as the ratio denominator
  // instead of physical lines — this prevents a valid log dominated by large
  // multi-line entries from being wrongly rejected because continuation lines inflate
  // the denominator and dilute the apparent timestamp density.
  const logicalEntryCount = rawLogLines.length;
  const timestampPercentage = logicalEntryCount > 0 ? (linesWithTimestamps / logicalEntryCount) * 100 : 0;
  if (totalNonEmptyLines > 100 && timestampPercentage < 10) {
    throw new ParsingError(
      'Log file appears to be invalid. Please ensure this is a valid rageshake log file.',
      'error'
    );
  }

  // Filter and convert to array - include any request with at least a send or response line
  const pendingRequests = allRecordsList.filter(
    (rec) => !!rec.uri && (!!rec.sendLineNumber || !!rec.responseLineNumber)
  );

  // Build a line-number index for O(1) lookups when computing client-error durations
  const lineByNumber = new Map(rawLogLines.map(l => [l.lineNumber, l]));

  // Fill in missing fields with empty strings or default values
  pendingRequests.forEach((rec) => {
    rec.method = rec.method || '';
    rec.uri = rec.uri || '';
    rec.status = rec.status || '';
    rec.requestSizeString = rec.requestSizeString || '';
    rec.responseSizeString = rec.responseSizeString || '';
    rec.requestSize = parseSizeString(rec.requestSizeString);
    rec.responseSize = parseSizeString(rec.responseSizeString);
    rec.requestDurationMs = rec.requestDurationMs || 0;
    rec.sendLineNumber = rec.sendLineNumber || 0;
    rec.responseLineNumber = rec.responseLineNumber || 0;
    rec.numAttempts = rec.numAttempts ?? 1;
    rec.attemptTimestampsUs = rec.attemptTimestampsUs ?? [];
    rec.attemptOutcomes = rec.attemptOutcomes ?? [];
    // Append the final attempt's outcome to complete per-segment colour data when
    // all preceding attempts have already been captured (i.e. the log contained
    // intermediate response spans between every retry).
    if ((rec.numAttempts ?? 1) > 1) {
      const finalOutcome = rec.status
        ? rec.status.split(' ')[0]
        : rec.clientError ?? INCOMPLETE_STATUS_KEY;
      // Backfill any missing intermediate outcomes. This happens when no
      // "Got response" or error line was logged between consecutive retries
      // (e.g. all attempts timed out with no intermediate SDK response span).
      // A retry only occurs after failure, so the same failure mode
      // (clientError when available, otherwise INCOMPLETE_STATUS_KEY) is the
      // best-available inference for each unfilled slot.
      while ((rec.attemptOutcomes as string[]).length < (rec.numAttempts ?? 1) - 1) {
        (rec.attemptOutcomes as string[]).push(rec.clientError ?? INCOMPLETE_STATUS_KEY);
      }
      // Append the final outcome so the total count equals numAttempts.
      if ((rec.attemptOutcomes as string[]).length === (rec.numAttempts ?? 1) - 1) {
        (rec.attemptOutcomes as string[]).push(finalOutcome);
      }
    }

    // Compute duration from timestamps for client-error requests (no request_duration= field in error lines)
    if (rec.clientError && rec.requestDurationMs === 0 && rec.sendLineNumber && rec.responseLineNumber) {
      const sendLine = lineByNumber.get(rec.sendLineNumber);
      const errorLine = lineByNumber.get(rec.responseLineNumber);
      if (sendLine?.timestampUs && errorLine?.timestampUs) {
        rec.requestDurationMs = Math.max(1, Math.round((errorLine.timestampUs - sendLine.timestampUs) / 1000));
      }
    }
  });

  // Sort by start time (sendLineNumber) to ensure chronological order
  pendingRequests.sort((a, b) => (a.sendLineNumber ?? 0) - (b.sendLineNumber ?? 0));

  // Cast to sealed readonly HttpRequest[] — all required fields have been populated above.
  const allRequests = pendingRequests as HttpRequest[];

  return {
    httpRequests: allRequests,
    rawLogLines,
    sentryEvents,
    lifecycleEvents,
  };
}

export function parseLogFile(logContent: string): LogParserResult {
  const isAnonymized = detectAnonymizedLog(logContent);
  const contentToParse = isAnonymized ? stripAnonymizedMarker(logContent) : logContent;

  // Short-circuit for Android logcat files before the rageshake-specific HTTP
  // span parser runs. Logcat lines use a MM-DD timestamp prefix that never
  // matches the ISO 8601 format expected by parseAllHttpRequests, so they
  // would otherwise fail the timestamp-density validation and throw a
  // ParsingError.
  if (isLogcatFormat(contentToParse)) {
    return { ...parseLogcatContent(contentToParse), isAnonymized };
  }

  // First parse all HTTP requests
  const { httpRequests, rawLogLines, sentryEvents, lifecycleEvents } = parseAllHttpRequests(contentToParse);

  // Filter for sync-specific requests and add connId
  const syncRequests: SyncRequest[] = [];
  const lines = contentToParse.split('\n');

  // Build a map of request_id to sync metadata by scanning lines again
  const syncMetadataMap = new Map<string, { connId?: string; timeout?: number }>();
  for (const line of lines) {
    if (line.includes('request_id=') && line.includes('/sync')) {
      const reqIdMatch = line.match(/request_id="([^"]+)"/);
      const connMatch = line.match(/conn_id="([^"]+)"/);
      const timeoutMatch = line.match(/\btimeout=([+-]?\d+(?:\.\d+)?)/);

      if (reqIdMatch) {
        const requestId = reqIdMatch[1];
        const existingMetadata = syncMetadataMap.get(requestId) || {};
        const parsedTimeout = timeoutMatch ? Number(timeoutMatch[1]) : undefined;

        syncMetadataMap.set(requestId, {
          connId: connMatch?.[1] || existingMetadata.connId,
          timeout: parsedTimeout ?? existingMetadata.timeout,
        });
      }
    }
  }

  // Filter HTTP requests for sync URIs and add connId
  for (const httpReq of httpRequests) {
    if (httpReq.uri.includes('/sync')) {
      const metadata = syncMetadataMap.get(httpReq.requestId);
      const connId = metadata?.connId || '';

      // Extract timeout from span metadata first, fall back to URI query param.
      // The URI may contain ?timeout=30000 as a query parameter even when the
      // span attributes are not on the same log line as the /sync URI.
      let timeout = metadata?.timeout;
      if (timeout === undefined) {
        const uriTimeoutMatch = httpReq.uri.match(/[?&]timeout=(\d+(?:\.\d+)?)/);
        if (uriTimeoutMatch) {
          timeout = Number(uriTimeoutMatch[1]);
        }
      }

      syncRequests.push({
        ...httpReq,
        connId,
        timeout,
      });
    }
  }

  // Extract unique connection IDs
  const connectionIds = [
    ...new Set(syncRequests.map((r) => r.connId).filter((c) => c)),
  ];

  return {
    requests: syncRequests,
    httpRequests,
    connectionIds,
    rawLogLines,
    sentryEvents,
    lifecycleEvents,
    isAnonymized,
  };
}

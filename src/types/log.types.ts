import type { TimestampMicros, ISODateTimeString } from './time.types';

export interface HttpRequest {
  readonly requestId: string;
  readonly method: string;
  readonly uri: string;
  readonly status: string;
  readonly requestSizeString: string;
  readonly responseSizeString: string;
  readonly requestSize: number;
  readonly responseSize: number;
  readonly requestDurationMs: number;
  readonly sendLineNumber: number;
  readonly responseLineNumber: number;
  /** Client-side transport error (e.g., "TimedOut", "Connect") when the request failed without receiving an HTTP response */
  readonly clientError?: string;
  /**
   * Total number of send attempts made for this request (1 = no retry).
   * Populated from the `num_attempt=N` field logged by the SDK on each "Sending request" line.
   * Defaults to 1 when the field is absent (older SDK versions or single-attempt requests).
   */
  readonly numAttempts?: number;
  /**
   * Microsecond timestamps for each attempt's send line, in attempt order.
   * Index 0 = first attempt (same time as `sendLineNumber`), index N-1 = last attempt.
   * Used to compute per-attempt segment widths inside the waterfall bar.
   */
  readonly attemptTimestampsUs?: readonly TimestampMicros[];
  /**
   * Per-attempt outcome strings, one per attempt, in attempt order.
   * Each entry is either an HTTP status code (e.g. `'503'`) or a client error
   * name (e.g. `'TimedOut'`). Always initialised to an array by the parser;
   * may be empty for single-attempt requests. For retried requests it is
   * backfilled to length `numAttempts`, using `INCOMPLETE_STATUS_KEY` for
   * any attempt whose outcome could not be determined from the log.
   */
  readonly attemptOutcomes?: readonly string[];
}

export interface SyncRequest extends HttpRequest {
  readonly connId: string;
  readonly timeout?: number;
}

/**
 * An HTTP request attempt enriched with its chart timestamp in microseconds.
 * Stored in {@link SummaryStats.httpRequestsWithTimestamps} and consumed by
 * `HttpActivityChart` to plot request starts over time.
 */
export interface HttpRequestWithTimestamp {

  readonly requestId: string;
  readonly status: string;
  readonly timestampUs: TimestampMicros;
  /** Full request URI — used by consumers to filter by path (e.g. hide /media/ uploads). */
  readonly uri: string;
  /** Timeout in ms when this is a /sync request; 0 = catch-up, ≥30000 = long-poll. */
  readonly timeout?: number;
}

/**
 * A single HTTP request span with resolved start and end timestamps in
 * microseconds.  Stored in {@link SummaryStats.httpRequestSpans} and consumed
 * by `HttpActivityChart` in concurrent mode to compute how many requests are
 * simultaneously in-flight at any given time.
 *
 * `endUs` is `null` when the response has not yet been received (incomplete
 * request).  Such spans are treated as still in-flight until the end of the
 * chart's time range.
 *
 * `status` and `timeout` mirror the same fields on {@link HttpRequestWithTimestamp}
 * so the same bucket-key and color helpers can be reused without changes.
 */
export interface HttpRequestSpan {
  readonly startUs: TimestampMicros;
  /** Response (or error) timestamp; `null` when the request is still in-flight. */
  readonly endUs: TimestampMicros | null;
  readonly status: string;
  /** Full request URI — used by consumers to filter by path (e.g. hide /media/ uploads). */
  readonly uri: string;
  /** Timeout in ms when this is a /sync request; 0 = catch-up, ≥30000 = long-poll. */
  readonly timeout?: number;
}

/**
 * An HTTP request entry annotated with the bytes transferred, used by
 * `BandwidthChart` to plot upload and download volumes over time.
 *
 * Each entry corresponds to a single HTTP request, timestamped at the
 * moment the request was sent (start-based), so that both bandwidth and
 * HTTP-activity charts share the same time reference. Incomplete requests
 * (no response received yet) carry upload bytes only.
 */
export interface BandwidthRequestEntry {
  readonly timestampUs: TimestampMicros;
  readonly uploadBytes: number;
  readonly downloadBytes: number;
  /** Full request URI — used by consumers to filter by path (e.g. hide /media/ uploads). */
  readonly uri: string;
  /** True when no response has been received yet; the entry carries upload bytes only. */
  readonly isIncomplete: boolean;
  /**
   * HTTP status string (e.g. `'200 OK'`, `'client-error'`, `''` for incomplete).
   * Mirrors {@link HttpRequest.status} so the bandwidth chart can colour bars by
   * the same status-bucket palette used in `HttpActivityChart`.
   */
  readonly status: string;
  /**
   * Timeout in ms when this is a /sync request (0 = catch-up, ≥30000 = long-poll);
   * `undefined` for non-sync requests.  Mirrors the same field on
   * {@link HttpRequestWithTimestamp} so callers can identify and filter sync traffic.
   */
  readonly timeout?: number;
}

/**
 * A single request-level bandwidth span with resolved start and end timestamps
 * in microseconds. Used by the in-flight bandwidth chart mode to compute
 * stacked upload/download areas over time.
 */
export interface BandwidthRequestSpan {
  readonly startUs: TimestampMicros;
  /** Response timestamp; `null` when request is still in-flight. */
  readonly endUs: TimestampMicros | null;
  readonly uploadBytes: number;
  readonly downloadBytes: number;
  /** Full request URI — used by consumers to apply path filters. */
  readonly uri: string;
  /**
   * HTTP status string (e.g. `'200 OK'`, `'client-error'`, `''` for incomplete).
   * Used by the concurrent bandwidth chart to colour each area layer by status bucket.
   */
  readonly status: string;
  /** Timeout in ms when this is a /sync request; `undefined` for non-sync requests. */
  readonly timeout?: number;
}

export interface SentryEvent {
  readonly platform: 'android' | 'ios';
  readonly lineNumber: number;
  readonly message: string;
  /** Hex crash ID, present for iOS crash reports only */
  readonly sentryId?: string;
  /** Direct link to the Sentry issue, present for iOS crash reports only */
  readonly sentryUrl?: string;
}

/** Kind of an app-lifecycle event detected from a single log line. */
export type LifecycleEventKind =
  | 'coldStart'
  | 'background'
  | 'foreground'
  | 'crash'
  | 'backgroundRefreshStart'
  | 'backgroundRefreshEnd';

/**
 * An app-lifecycle transition detected from the logs (cold start, enter
 * background, resume, crash). Surfaced as a vertical marker on the activity
 * charts and used by the "Since last cold start" time-range preset.
 */
export interface LifecycleEvent {
  readonly kind: LifecycleEventKind;
  readonly platform: 'android' | 'ios' | 'web';
  readonly lineNumber: number;
  readonly timestampUs: TimestampMicros;
}

export interface LogParserResult {
  readonly requests: readonly SyncRequest[];
  readonly httpRequests: readonly HttpRequest[];
  readonly connectionIds: readonly string[];
  readonly rawLogLines: readonly ParsedLogLine[];
  readonly sentryEvents: readonly SentryEvent[];
  /** App-lifecycle events. Optional so older/partial result fixtures stay valid;
   * the parser always populates it. */
  readonly lifecycleEvents?: readonly LifecycleEvent[];
  /**
   * True when the log content was previously exported with the anonymization
   * marker prepended. Used to pre-activate the anonymized button state on load.
   */
  readonly isAnonymized?: boolean;
}

/**
 * Bidirectional mapping produced by the anonymization pass.
 *
 * - `forward`: original identifier → anonymized alias (used to anonymize)
 * - `reverse`: anonymized alias → original identifier (used to unanonymize)
 *
 * The dictionary can be exported alongside an anonymized log file so the user
 * can recover the original identifiers later.
 */
export interface AnonymizationDictionary {
  readonly forward: Readonly<Record<string, string>>;
  readonly reverse: Readonly<Record<string, string>>;
}

/**
 * A parsed log line with extracted timestamp and metadata.
 * 
 * Timestamps are stored as:
 * - `isoTimestamp`: Original ISO 8601 string from the log
 * - `timestampUs`: Microseconds since epoch (for calculations)
 * - `displayTime`: Time-only string for display (HH:MM:SS.ssssss)
 */
export interface ParsedLogLine {
  readonly lineNumber: number;
  /**
   * Full raw text of this logical log entry, including any continuation lines
   * joined with `\n`. Used for search matching so queries can find text that
   * appears in continuation lines (e.g. the body of a multi-line Rust error).
   */
  readonly rawText: string;
  /** Original ISO 8601 timestamp from log (e.g., "2026-01-26T16:01:13.382222Z") */
  readonly isoTimestamp: ISODateTimeString;
  /** Microseconds since Unix epoch - for time calculations */
  readonly timestampUs: TimestampMicros;
  /** Pre-formatted time for display (HH:MM:SS.ssssss) */
  readonly displayTime: string;
  readonly level: LogLevel;
  readonly message: string;
  readonly strippedMessage: string;
  /** Source file path extracted from log (e.g., "ClientProxy.swift" or "crates/matrix-sdk/src/http_client/native.rs") */
  readonly filePath?: string;
  /**
   * Name of the log file this line was loaded from. Set by
   * `mergeLogParserResults` for every line it returns — including the
   * single-file case — so any log opened through `loadMergedLogParserResults`
   * carries it. Absent only on raw parser output that bypasses the merge path
   * (e.g. a direct `loadLogParserResult(result)` with no source name).
   */
  readonly sourceFile?: string;
  /** Source file line number extracted from log */
  readonly sourceLineNumber?: number;
  /**
   * Physical lines that follow this log entry's first line and share its logical
   * record — i.e. lines that have no leading ISO timestamp and belong to the
   * same structured log message (e.g. a multi-line Rust error value).
   * Absent (undefined) for the common single-line case — intentionally omitted
   * rather than set to [] to keep object memory footprint small and preserve
   * cache efficiency when iterating large log arrays.
   */
  readonly continuationLines?: readonly string[];
}

export type LogLevel = 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'UNKNOWN';

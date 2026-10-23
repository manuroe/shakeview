/**
 * Pure filter functions for sync and HTTP requests.
 *
 * These are extracted from logStore so they can be unit-tested in isolation
 * without Zustand setup. The store calls these and stores results.
 */

import type { HttpRequest, SyncRequest, ParsedLogLine } from '../types/log.types';
import type { TimestampMicros, TimeFilterValue } from '../types/time.types';
import { calculateTimeRangeMicros, getMinMaxTimestamps } from './timeUtils';
import { INCOMPLETE_STATUS_KEY, CLIENT_ERROR_STATUS_KEY, isNumericStatus } from './statusCodeUtils';

export interface SyncRequestFilters {
  selectedConnId: string;
  showIncomplete: boolean;
  selectedTimeout: number | null;
  statusCodeFilter: Set<string> | null;
  startTime: TimeFilterValue | null;
  endTime: TimeFilterValue | null;
}

export interface HttpRequestFilters {
  showIncompleteHttp: boolean;
  statusCodeFilter: Set<string> | null;
  /** Case-insensitive substring matched against the rawText of the request's send and response log lines. */
  logFilter: string | null;
  startTime: TimeFilterValue | null;
  endTime: TimeFilterValue | null;
}

/**
 * Derive a microsecond time range from rawLogLines + filter values.
 * Returns null when no filter is active (callers treat null as "no time constraint").
 */
export function getTimeRangeUs(
  rawLogLines: ReadonlyArray<{ timestampUs: TimestampMicros }>,
  startFilter: TimeFilterValue | null,
  endFilter: TimeFilterValue | null
): { startUs: TimestampMicros; endUs: TimestampMicros } | null {
  if (!startFilter && !endFilter) return null;

  const { min: minLogTimeUs, max: maxLogTimeUs } = getMinMaxTimestamps(rawLogLines);
  if (minLogTimeUs === 0 && maxLogTimeUs === 0) return null;

  return calculateTimeRangeMicros(startFilter, endFilter, minLogTimeUs, maxLogTimeUs);
}

/**
 * Return true when the request falls inside the given microsecond range.
 * For completed requests we use the response timestamp; for incomplete requests
 * (no response line) we fall back to the send timestamp.
 *
 * @param lineNumberIndex - Optional prebuilt index for O(1) lookups. Falls back
 *   to a linear scan of rawLogLines when omitted.
 */
function isRequestInTimeRange(
  request: Pick<HttpRequest, 'responseLineNumber' | 'sendLineNumber'>,
  rawLogLines: ParsedLogLine[],
  timeRangeUs: { startUs: TimestampMicros; endUs: TimestampMicros },
  lineNumberIndex?: Map<number, ParsedLogLine>
): boolean {
  const lineNumber = request.responseLineNumber || request.sendLineNumber;
  if (!lineNumber) return false;

  const line = lineNumberIndex
    ? lineNumberIndex.get(lineNumber)
    : rawLogLines.find((l) => l.lineNumber === lineNumber);
  if (!line || !line.timestampUs) return false;

  return line.timestampUs >= timeRangeUs.startUs && line.timestampUs <= timeRangeUs.endUs;
}

/**
 * Filter sync (sliding-sync) requests according to current filter state.
 *
 * @param lineNumberIndex - Optional prebuilt line-number index for O(1) lookups.
 *   When omitted, falls back to a linear scan of rawLogLines (used by tests).
 */
export function filterSyncRequests(
  requests: SyncRequest[],
  rawLogLines: ParsedLogLine[],
  filters: SyncRequestFilters,
  lineNumberIndex?: Map<number, ParsedLogLine>
): SyncRequest[] {
  const { selectedConnId, showIncomplete, selectedTimeout, statusCodeFilter, startTime, endTime } =
    filters;

  const timeRangeUs = getTimeRangeUs(rawLogLines, startTime, endTime);

  return requests.filter((r) => {
    // Connection filter
    if (selectedConnId && r.connId !== selectedConnId) return false;

    // Timeout filter
    if (selectedTimeout !== null && r.timeout !== selectedTimeout) return false;

    // Incomplete filter — client errors are resolved outcomes, not truly incomplete
    if (!showIncomplete && !r.status && !r.clientError) return false;

    // Status code filter (null = all enabled).
    // A request matches if its final status matches OR any intermediate attempt outcome matches,
    // so retried requests (e.g. 503 → 200) appear when filtering for either code.
    if (statusCodeFilter !== null) {
      const statusKey = r.status || (r.clientError ? CLIENT_ERROR_STATUS_KEY : INCOMPLETE_STATUS_KEY);
      const matchesFinal = statusCodeFilter.has(statusKey);
      // Map non-numeric outcomes to their appropriate filter key:
      // 'Incomplete' placeholder → INCOMPLETE_STATUS_KEY; real transport failures → CLIENT_ERROR_STATUS_KEY.
      const matchesAttempt = r.attemptOutcomes?.some((o) => {
        if (isNumericStatus(o)) return statusCodeFilter.has(o);
        const key = o === INCOMPLETE_STATUS_KEY ? INCOMPLETE_STATUS_KEY : CLIENT_ERROR_STATUS_KEY;
        return statusCodeFilter.has(key);
      }) ?? false;
      if (!matchesFinal && !matchesAttempt) return false;
    }

    // Time filter
    if (timeRangeUs && !isRequestInTimeRange(r, rawLogLines, timeRangeUs, lineNumberIndex)) {
      return false;
    }

    return true;
  });
}

/**
 * Filter general HTTP requests according to current filter state.
 *
 * @param lineNumberIndex - Optional prebuilt line-number index for O(1) lookups.
 *   When omitted, falls back to a linear scan of rawLogLines (used by tests).
 */
export function filterHttpRequests(
  requests: HttpRequest[],
  rawLogLines: ParsedLogLine[],
  filters: HttpRequestFilters,
  lineNumberIndex?: Map<number, ParsedLogLine>
): HttpRequest[] {
  const { showIncompleteHttp, statusCodeFilter, logFilter, startTime, endTime } = filters;

  const timeRangeUs = getTimeRangeUs(rawLogLines, startTime, endTime);

  // Hoist log-filter helpers outside the per-request callback to avoid
  // repeated allocations when filtering large request sets.
  const logQuery = logFilter && logFilter.length > 0 ? logFilter.toLowerCase() : null;
  // sendLineNumber and responseLineNumber are both normalised to 0 as a sentinel meaning
  // "not present" (e.g. incomplete request = no response, response-only record = no send).
  // Skip the lookup when the sentinel is set to avoid accidentally matching line 0.
  const getLine = (lineNum: number): ParsedLogLine | undefined =>
    lineNumberIndex ? lineNumberIndex.get(lineNum) : rawLogLines.find((l) => l.lineNumber === lineNum);

  return requests.filter((r) => {
    // Incomplete filter — client errors always show (they are resolved, not truly incomplete)
    if (!showIncompleteHttp && !r.status && !r.clientError) return false;

    // Status code filter (null = all enabled).
    // A request matches if its final status matches OR any intermediate attempt outcome matches,
    // so retried requests (e.g. 503 → 200) appear when filtering for either code.
    if (statusCodeFilter !== null) {
      const statusKey = r.status || (r.clientError ? CLIENT_ERROR_STATUS_KEY : INCOMPLETE_STATUS_KEY);
      const matchesFinal = statusCodeFilter.has(statusKey);
      // Map non-numeric outcomes to their appropriate filter key:
      // 'Incomplete' placeholder → INCOMPLETE_STATUS_KEY; real transport failures → CLIENT_ERROR_STATUS_KEY.
      const matchesAttempt = r.attemptOutcomes?.some((o) => {
        if (isNumericStatus(o)) return statusCodeFilter.has(o);
        const key = o === INCOMPLETE_STATUS_KEY ? INCOMPLETE_STATUS_KEY : CLIENT_ERROR_STATUS_KEY;
        return statusCodeFilter.has(key);
      }) ?? false;
      if (!matchesFinal && !matchesAttempt) return false;
    }

    // Log filter: case-insensitive substring match against the raw text of the
    // request's send line and response line (the two lines the SDK emits per request).
    if (logQuery !== null) {
      const sendRaw =
        r.sendLineNumber !== 0 ? (getLine(r.sendLineNumber)?.rawText.toLowerCase() ?? '') : '';
      const responseRaw =
        r.responseLineNumber !== 0 ? (getLine(r.responseLineNumber)?.rawText.toLowerCase() ?? '') : '';
      if (!sendRaw.includes(logQuery) && !responseRaw.includes(logQuery)) return false;
    }

    // Time filter
    if (timeRangeUs && !isRequestInTimeRange(r, rawLogLines, timeRangeUs, lineNumberIndex)) {
      return false;
    }

    return true;
  });
}

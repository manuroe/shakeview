import type {
  LogParserResult,
  ParsedLogLine,
  SyncRequest,
  HttpRequest,
  SentryEvent,
  LifecycleEvent,
} from '../types/log.types';
import { isWebRequestId } from './logParser';

/** A parsed log file paired with the source-file name it came from. */
export interface NamedLogParserResult {
  readonly name: string;
  readonly result: LogParserResult;
}

/**
 * Highest line number any of a file's references point at — lines, requests,
 * sentry and lifecycle events. Every one of them is rebased by the same offset,
 * so the offset has to clear the highest of them.
 */
export function maxLineNumber(result: LogParserResult): number {
  let max = 0;
  const bump = (n: number | undefined) => {
    if (n !== undefined && n > max) max = n;
  };
  for (const line of result.rawLogLines) bump(line.lineNumber);
  for (const r of result.requests) { bump(r.sendLineNumber); bump(r.responseLineNumber); }
  for (const r of result.httpRequests) { bump(r.sendLineNumber); bump(r.responseLineNumber); }
  for (const e of result.sentryEvents) bump(e.lineNumber);
  for (const e of result.lifecycleEvents ?? []) bump(e.lineNumber);
  return max;
}

/**
 * Merge several parsed log files into one continuous dataset.
 *
 * Logs rotate into separate hourly files, and the app emits a separate stream
 * per process (`console`, `nse`, `shareextension`, …). Opening files together
 * lets the user follow activity across hour boundaries and correlate processes
 * on one timeline.
 *
 * Lines (and the request arrays) are **sorted by timestamp**, not concatenated
 * in file order. Same-process hourly files are already time-ordered, but two
 * processes share the same wall-clock hours, so a plain concat would jump
 * backwards in time whenever the process changes. A global timestamp sort fixes
 * both cases (all processes share the device clock). The sort is stable, so
 * lines with identical timestamps keep file order.
 *
 * Each file's line numbers restart at 1, so they are rebased with a cumulative
 * offset — one per file, stepping by that file's highest line number (see
 * `maxLineNumber`). This keeps `lineNumberIndex` collision-free and keeps every
 * line reference (`sendLineNumber`, `responseLineNumber`,
 * `SentryEvent.lineNumber`) pointing at the right line. Numbers are therefore
 * unique but not contiguous across a file boundary, exactly as they are not
 * contiguous inside a file whose continuation lines were folded.
 *
 * Every line is tagged with `sourceFile` so the UI can colour it by its
 * originating process.
 */
export function mergeLogParserResults(files: readonly NamedLogParserResult[]): LogParserResult {
  if (files.length === 0) {
    return { requests: [], httpRequests: [], connectionIds: [], rawLogLines: [], sentryEvents: [], lifecycleEvents: [] };
  }
  if (files.length === 1) {
    // Tag the single file too, so the source-file column is consistent.
    const { name, result } = files[0];
    return { ...result, rawLogLines: result.rawLogLines.map((l) => ({ ...l, sourceFile: name })) };
  }

  // Each line is paired with the timestamp used to position it on the merged
  // timeline. Orphan lines (timestampUs === 0, e.g. after a blank-line boundary)
  // carry forward the last positive timestamp from the same file, so they stay
  // with their originating section instead of jumping to the start.
  const sortable: { line: ParsedLogLine; sortKey: number }[] = [];
  const requests: SyncRequest[] = [];
  const httpRequests: HttpRequest[] = [];
  const sentryEvents: SentryEvent[] = [];
  const lifecycleEvents: LifecycleEvent[] = [];
  const connectionIds = new Set<string>();

  let offset = 0;
  for (const { name, result } of files) {
    let lastPositiveTs = 0;
    for (const line of result.rawLogLines) {
      const ts = line.timestampUs as number;
      if (ts > 0) lastPositiveTs = ts;
      sortable.push({
        line: { ...line, lineNumber: line.lineNumber + offset, sourceFile: name },
        sortKey: ts > 0 ? ts : lastPositiveTs,
      });
    }
    for (const r of result.requests) {
      requests.push({
        ...r,
        sendLineNumber: r.sendLineNumber !== 0 ? r.sendLineNumber + offset : 0,
        responseLineNumber: r.responseLineNumber !== 0 ? r.responseLineNumber + offset : 0,
      });
    }
    for (const r of result.httpRequests) {
      httpRequests.push({
        ...r,
        sendLineNumber: r.sendLineNumber !== 0 ? r.sendLineNumber + offset : 0,
        responseLineNumber: r.responseLineNumber !== 0 ? r.responseLineNumber + offset : 0,
      });
    }
    for (const e of result.sentryEvents) {
      sentryEvents.push({ ...e, lineNumber: e.lineNumber + offset });
    }
    for (const e of result.lifecycleEvents ?? []) {
      lifecycleEvents.push({ ...e, lineNumber: e.lineNumber + offset });
    }
    for (const id of result.connectionIds) connectionIds.add(id);
    // Advance by the file's highest line number, NOT by its line count: a
    // parsed line's number indexes the file's *text* lines, and continuation
    // lines get folded into their predecessor, so the highest number exceeds the
    // count. Advancing by the count would overlap the next file onto this one's
    // tail — 1017 colliding numbers on a real 55-log archive, which makes a
    // `?line=N` deep link resolve to the wrong line.
    offset += maxLineNumber(result);
  }

  // Interleave by time. Array.sort is stable, so equal-key lines keep the file
  // order they were pushed in (e.g. console before nse for the same µs, and an
  // orphan line right after the positive line whose timestamp it carries).
  sortable.sort((a, b) => a.sortKey - b.sortKey);
  const rawLogLines = sortable.map((s) => s.line);

  // Requests render in array order in the tables, so sort them by send time too.
  // Use the merged line index to resolve each request's timestamp.
  const tsByLine = new Map<number, number>();
  for (const line of rawLogLines) tsByLine.set(line.lineNumber, line.timestampUs as number);
  const sendTime = (r: HttpRequest) => tsByLine.get(r.sendLineNumber) ?? tsByLine.get(r.responseLineNumber) ?? 0;
  requests.sort((a, b) => sendTime(a) - sendTime(b));
  httpRequests.sort((a, b) => sendTime(a) - sendTime(b));
  sentryEvents.sort((a, b) => (tsByLine.get(a.lineNumber) ?? 0) - (tsByLine.get(b.lineNumber) ?? 0));
  // Lifecycle events carry their own timestamp, so sort on it directly.
  lifecycleEvents.sort((a, b) => a.timestampUs - b.timestampUs);

  // Element Web ids are per-file counters: renumber them in merged time order so
  // they stay unique and still read as the request sequence across page loads.
  // Keyed by the rebased line number, unique per request and shared by the
  // /sync copy in `requests`.
  const lineKey = (r: HttpRequest) => r.sendLineNumber || r.responseLineNumber;
  const webIds = new Map<number, string>();
  for (const r of httpRequests) {
    if (isWebRequestId(r.requestId)) webIds.set(lineKey(r), String(webIds.size + 1));
  }
  const renumber = <T extends HttpRequest>(r: T): T => {
    const id = isWebRequestId(r.requestId) ? webIds.get(lineKey(r)) : undefined;
    return id ? { ...r, requestId: id } : r;
  };

  return {
    requests: requests.map(renumber),
    httpRequests: httpRequests.map(renumber),
    connectionIds: [...connectionIds],
    rawLogLines,
    sentryEvents,
    lifecycleEvents,
    // Only flag the merged log as anonymized when every part is.
    isAnonymized: files.every((f) => f.result.isAnonymized),
  };
}

/**
 * Utilities for summarizing rageshake log entries within an archive.
 *
 * `computeArchiveSummary` reuses the shared `parseLogFile` parser and mirrors
 * the same data the browser extension shows on rageshake listing pages
 * (Lines, Sentry, Errors, Warnings, Requests, Upload, Download, Status codes).
 * Callers are expected to invoke it lazily (one entry at a time with a
 * scheduler yield between calls) so the main thread stays responsive while a
 * large archive is being processed.
 *
 * @example
 * const text = new TextDecoder().decode(decompressSync(entry.data));
 * const summary = computeArchiveSummary(text);
 * console.log(summary.errorCount); // number of ERROR-level log lines
 */

import { parseLogFile } from './logParser';
import { parseSizeString } from './sizeUtils';
import { getEntryKind } from './listingEntries';

/** Comprehensive summary matching what the browser extension shows per log file. */
export interface ArchiveSummary {
  /** Total number of parsed log lines. */
  readonly totalLines: number;
  /** Number of lines at ERROR level. */
  readonly errorCount: number;
  /** Number of lines at WARN level. */
  readonly warnCount: number;
  /** Number of Sentry event links detected in the log. */
  readonly sentryCount: number;
  /** Total number of HTTP requests (send+response pairs, including incomplete). */
  readonly httpCount: number;
  /** Total upload bytes across all HTTP requests (sum of request sizes). */
  readonly totalUploadBytes: number;
  /** Total download bytes across all HTTP requests (sum of response sizes). */
  readonly totalDownloadBytes: number;
  /**
   * HTTP status code (or synthetic key "incomplete" / "client-error") mapped
   * to the count of requests with that status.
   *
   * @example { "200": 42, "404": 3, "client-error": 1 }
   */
  readonly statusCodes: Readonly<Record<string, number>>;
}

/**
 * Returns true when a tar entry name represents a log file that the parser can
 * process. Both plain `.log` and gzip-compressed `.log.gz` files qualify.
 *
 * @example
 * isAnalyzableEntry('logs.2026-04-12-09.log.gz'); // true
 * isAnalyzableEntry('details.json');               // false
 * isAnalyzableEntry('details.log.gz');             // false
 */
export function isAnalyzableEntry(name: string): boolean {
  // One rule for "is a log" (incl. the details.log.gz exclusion), shared with
  // how the archive/listing views open an entry.
  return getEntryKind(name) !== 'other';
}

/**
 * Parses the given log text and returns the same aggregate data the browser
 * extension shows on rageshake listing pages.
 *
 * This calls the full `parseLogFile` parser, so it is CPU-intensive for large
 * files. Callers should yield between successive invocations (e.g. with
 * `setTimeout(fn, 0)`) to keep the UI responsive.
 *
 * @example
 * const summary = computeArchiveSummary(logText);
 * // { totalLines: 5000, errorCount: 3, warnCount: 0, sentryCount: 1,
 * //   httpCount: 41, totalUploadBytes: 8192, totalDownloadBytes: 204800,
 * //   statusCodes: { "200": 38, "404": 3 } }
 */
export function computeArchiveSummary(text: string): ArchiveSummary {
  const result = parseLogFile(text);

  let errorCount = 0;
  let warnCount = 0;
  for (const line of result.rawLogLines) {
    if (line.level === 'ERROR') errorCount++;
    else if (line.level === 'WARN') warnCount++;
  }

  let totalUploadBytes = 0;
  let totalDownloadBytes = 0;
  const statusCodes: Record<string, number> = {};
  for (const req of result.httpRequests) {
    totalUploadBytes += parseSizeString(req.requestSizeString ?? '');
    totalDownloadBytes += parseSizeString(req.responseSizeString ?? '');
    const code = req.clientError ? 'client-error' : (req.status || 'incomplete');
    statusCodes[code] = (statusCodes[code] ?? 0) + 1;
  }

  return {
    totalLines: result.rawLogLines.length,
    errorCount,
    warnCount,
    sentryCount: result.sentryEvents.length,
    httpCount: result.httpRequests.length,
    totalUploadBytes,
    totalDownloadBytes,
    statusCodes,
  };
}

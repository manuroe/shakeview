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
import { extractSteps } from './crypto/steps';
import { countBy, countUtdEvents, utdEventId } from './crypto/decryptionSummary';
import { addTo, buildCryptoModel, byTs, deviceFromSteps } from './crypto/buildCryptoModel';
import type { CryptoStep, UtdReason } from './crypto/types';

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
  /** Distinct events that failed to decrypt (UTD) in this file: /archive's count until every file is summarized (see `utdsByFile`). */
  readonly utdCount: number;
  /** Those UTD events per reason class. */
  readonly utdReasons: Readonly<Partial<Record<UtdReason, number>>>;
  /** This file's crypto steps, kept so UTDs can be judged over the whole archive (see `utdsByFile`). */
  readonly cryptoSteps: readonly CryptoStep[];
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
 * `file` names the entry in the steps' line refs, so `utdsByFile` can count per file.
 *
 * @example
 * const summary = computeArchiveSummary(logText, 'logs.2026-04-12-09.log.gz');
 * // { totalLines: 5000, errorCount: 3, warnCount: 0, sentryCount: 1,
 * //   httpCount: 41, totalUploadBytes: 8192, totalDownloadBytes: 204800,
 * //   statusCodes: { "200": 38, "404": 3 },
 * //   utdCount: 2, utdReasons: { missing_key: 2 }, cryptoSteps: [...] }
 */
export function computeArchiveSummary(text: string, file = ''): ArchiveSummary {
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

  const steps = extractSteps(result.rawLogLines, { archive: '', file });
  const utd = countUtdEvents(steps);

  return {
    totalLines: result.rawLogLines.length,
    errorCount,
    warnCount,
    sentryCount: result.sentryEvents.length,
    httpCount: result.httpRequests.length,
    totalUploadBytes,
    totalDownloadBytes,
    statusCodes,
    utdCount: utd.count,
    utdReasons: utd.byReason,
    cryptoSteps: steps,
  };
}

/**
 * A summary of nothing: an entry that failed to parse still gets a row, never stuck on "…".
 *
 * @example emptyArchiveSummary().totalLines // 0
 */
export function emptyArchiveSummary(): ArchiveSummary {
  return {
    totalLines: 0,
    errorCount: 0,
    warnCount: 0,
    sentryCount: 0,
    httpCount: 0,
    totalUploadBytes: 0,
    totalDownloadBytes: 0,
    statusCodes: {},
    utdCount: 0,
    utdReasons: {},
    cryptoSteps: [],
  };
}

/** One log file's UTDs on /archive, each UTD counted once, in the file of its first failure (see `utdsByFile`). */
export interface FileUtds {
  /** Distinct events that first failed to decrypt in this file. */
  readonly count: number;
  /** Of those, how many UTD analytics received; `null` when the archive can't tell (no timeline logs on older Element X builds). */
  readonly reported: number | null;
  /** Those UTD events per reason class. */
  readonly byReason: Readonly<Partial<Record<UtdReason, number>>>;
}

/**
 * Per log file, its UTDs and how many of them analytics received (the metric the team
 * tracks), judged over the whole archive with the /summary rules: a decryption logged in
 * the next hourly file still clears a UTD of this one. Each UTD counts once, in the file of
 * its first failure, so a retry logged an hour later does not count again. Files without
 * a first failure are absent.
 *
 * @example
 * const utds = utdsByFile(useArchiveStore.getState().archiveSummaries);
 * utds.get('logs.2026-04-12-09.log.gz'); // { count: 4, reported: 3, byReason: { missing_key: 4 } }, or undefined for none
 */
export function utdsByFile(summaries: ReadonlyMap<string, ArchiveSummary>): ReadonlyMap<string, FileUtds> {
  // In time order: an event's first failure names its file, and decisiveFailure reads the failures in order.
  const steps = [...summaries.values()].flatMap((s) => s.cryptoSteps).sort(byTs);
  const fileOf = new Map<string, string>();
  const failures = new Map<string, CryptoStep[]>();
  for (const s of steps) {
    const id = utdEventId(s);
    if (!id) continue;
    if (!fileOf.has(id)) fileOf.set(id, s.line.file);
    addTo(failures, fileOf.get(id)!, s);
  }
  const utds = buildCryptoModel([deviceFromSteps('archive', steps)]).flatMap((s) => s.utds);
  const canTell = utds.some((u) => u.analytics.category !== 'unknown');
  const reported = countBy(utds.filter((u) => u.analytics.category === 'reported'), (u) => fileOf.get(u.eventId));
  return new Map([...failures].map(([file, list]) => {
    const { count, byReason } = countUtdEvents(list);
    return [file, { count, byReason, reported: canTell ? reported[file] ?? 0 : null }];
  }));
}

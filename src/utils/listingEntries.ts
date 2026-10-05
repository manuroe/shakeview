/**
 * Shared filename helpers for archive entries and remote listing entries.
 *
 * @example
 * const kind = getEntryKind('console.2026-04-14-09.log.gz');
 * console.log(kind); // 'dated-log'
 */

/**
 * Classifies a file by how the viewer should open it.
 */
export type EntryKind = 'dated-log' | 'plain-log' | 'other';

/**
 * Strips the leading directory component from a path-like entry name.
 */
export function stripEntryPrefix(name: string): string {
  const slash = name.indexOf('/');
  return slash >= 0 ? name.slice(slash + 1) : name;
}

/**
 * Extracts the `YYYY-MM-DD` or `YYYY-MM-DD-HH` segment from a filename.
 */
export function extractDateKey(name: string): string | null {
  const basename = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name;
  const match = basename.match(/(\d{4}-\d{2}-\d{2}(?:-\d{2})?)/);
  return match ? match[1] : null;
}

/**
 * The leading category token of a log filename — also the process name for
 * rageshake logs (e.g. `console`, `nse`, `shareextension`).
 */
export function extractCategory(name: string): string {
  const basename = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name;
  const match = basename.match(/^([^.]+)/);
  const category = match ? match[1] : basename;
  // Element Web numbers one file per page load (logs-0000, logs-0001, …): all of
  // them are the app stream, so they share one process and its app-state lane.
  return /^logs-\d+$/.test(category) ? 'logs' : category;
}

/**
 * Sorts entries by category and then newest-first within each category.
 */
export function sortEntries<T extends { readonly name: string }>(entries: readonly T[]): readonly T[] {
  return [...entries].sort((a, b) => {
    const leftDate = extractDateKey(a.name);
    const rightDate = extractDateKey(b.name);

    if (leftDate && !rightDate) return -1;
    if (!leftDate && rightDate) return 1;
    if (!leftDate && !rightDate) return 0;

    const leftCategory = extractCategory(a.name);
    const rightCategory = extractCategory(b.name);
    const categoryCompare = leftCategory.localeCompare(rightCategory);
    if (categoryCompare !== 0) return categoryCompare;

    if (!leftDate || !rightDate) return 0;

    return rightDate.localeCompare(leftDate);
  });
}

/**
 * Returns how a file should be opened inside the viewer.
 */
export function getEntryKind(name: string): EntryKind {
  const lower = name.toLowerCase();
  const isLog = lower.endsWith('.log.gz') || lower.endsWith('.log');
  // details.log.gz is the rageshake server's plain-text copy of the report
  // metadata, not a log: it has no timestamps and would parse as UNKNOWN lines.
  const isMetadata = lower === 'details.log.gz' || lower.endsWith('/details.log.gz');
  if (!isLog || isMetadata) return 'other';
  // Element Web numbers its logs (logs-0000.log.gz) instead of dating them,
  // but they are app logs like the dated ones and open on the summary.
  const isWebLog = /(^|\/)logs-\d+\.log/.test(lower);
  return extractDateKey(name) !== null || isWebLog ? 'dated-log' : 'plain-log';
}

/**
 * Returns a best-effort MIME type for non-log files opened directly in the browser.
 */
export function getMimeType(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.gz')) return 'application/gzip';
  if (lower.endsWith('.log') || lower.endsWith('.txt')) return 'text/plain';
  return 'application/octet-stream';
}
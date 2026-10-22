/**
 * Ticks or unticks one key of a multi-select filter where `null` means "all"
 * (StatusFilterDropdown, OutcomeFilterDropdown). From "all", the selection starts
 * from every key, not only the ones listed now: a key hidden by another filter
 * must stay selected when it shows up again. Nothing or everything selected is `null`.
 *
 * @example toggleFilterKey(null, ['200', '404', '500'], '200') // Set { '404', '500' }
 * @example toggleFilterKey(new Set(['200']), ['200', '404'], '404') // null
 */
export function toggleFilterKey(selected: ReadonlySet<string> | null, allKeys: readonly string[], key: string): Set<string> | null {
  const next = new Set(selected ?? allKeys);
  if (!next.delete(key)) next.add(key);
  return next.size === 0 || allKeys.every((k) => next.has(k)) ? null : next;
}

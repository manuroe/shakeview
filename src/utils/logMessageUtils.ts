/**
 * Log Message Utilities
 *
 * Pure helpers for parsing and normalising raw log message strings.
 * These functions are log-format-aware but have no React or store dependencies,
 * making them straightforward to unit-test in isolation.
 */

/**
 * Regular expression that matches a rageshake ISO-8601 datetime stamp at the
 * start of a log line.  Fractional seconds and the trailing `Z` are both
 * optional, matching every format emitted by the Rust SDK.
 *
 * Exported so consumers can reuse the canonical pattern without duplicating
 * the regex literal.
 *
 * @example
 * ISO_TIMESTAMP_RE.test("2026-01-28T13:24:43.950890Z INFO foo") // => true
 * ISO_TIMESTAMP_RE.test("2026-01-28T13:24:43Z WARN bar")       // => true
 * ISO_TIMESTAMP_RE.test("continuation line")                   // => false
 */
export const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/;

/**
 * Matches the Element Web rageshake prefix `<ISO> <D|I|W|E> `, capturing the
 * single-letter level. Element Web logs one letter per line instead of a Rust
 * level word, so level detection must try this anchored form first.
 *
 * @example
 * "2026-09-28T15:36:15.377Z W FetchHttpApi: …".match(WEB_LEVEL_PREFIX_RE)?.[1] // => "W"
 * WEB_LEVEL_PREFIX_RE.test("2026-01-28T13:24:43.950890Z INFO foo")              // => false
 */
export const WEB_LEVEL_PREFIX_RE = new RegExp(`${ISO_TIMESTAMP_RE.source}\\s+([DIWE])\\s`);

/**
 * Regular expression that matches the ISO timestamp + log-level prefix of a
 * rageshake log line, allowing the prefix to be stripped via
 * {@link stripLogPrefix}.
 *
 * Derived from {@link ISO_TIMESTAMP_RE}.source so the timestamp portion is
 * defined exactly once; accepts any single-word level token (`\w+`) rather
 * than enumerating the known levels. An Element Web letter level (`D`/`I`/`W`/`E`)
 * also swallows the Rust level word that follows it on crypto-wasm lines
 * (`Z D DEBUG matrix_sdk_crypto…`), so the payload doesn't repeat the level.
 *
 * @example
 * LOG_PREFIX_RE.test("2026-01-28T13:24:43.950890Z INFO foo") // => true
 * LOG_PREFIX_RE.test("2026-01-28T13:24:43Z INFO foo")       // => true (no fractions)
 * LOG_PREFIX_RE.test("2026-01-28T13:24:43.123456 INFO foo")  // => true (no Z)
 */
export const LOG_PREFIX_RE = new RegExp(
  `${ISO_TIMESTAMP_RE.source}\\s+(?:[DIWE]\\s+(?:(?:TRACE|DEBUG|INFO|WARN|ERROR)\\s+)?|\\w+\\s+)`,
);

/**
 * Strip the ISO timestamp + log-level prefix from a raw log line, keeping only
 * the message payload.
 *
 * Uses {@link LOG_PREFIX_RE} — the single canonical source for this pattern in
 * the codebase. If the line does not match, it is returned unchanged.
 *
 * @param rawText - Raw log line string.
 * @returns The payload portion, or the original string if no prefix is found.
 *
 * @example
 * stripLogPrefix("2026-01-28T13:24:43.950890Z INFO Something happened")
 * // => "Something happened"
 */
export function stripLogPrefix(rawText: string): string {
  return rawText.replace(LOG_PREFIX_RE, '');
}

/**
 * Strip the ISO timestamp prefix and log-level token from a raw log message,
 * returning only the payload text.
 *
 * Rageshake log lines follow the pattern:
 *   `<ISO-timestamp>  <LEVEL>  <payload>`
 *
 * This is used to group duplicate error/warning messages by their semantic
 * content rather than by the full raw text (which would never be equal because
 * each line has a unique timestamp).
 *
 * If the input does not match the expected pattern the original string is
 * returned unchanged so callers never receive an empty result unexpectedly.
 *
 * @param message - Raw log message string (may contain leading timestamp + level).
 * @returns The payload portion of the message, or the original string if no
 *   timestamp prefix is recognised.
 *
 * @example
 * extractCoreMessage("2026-01-28T13:24:43.950890Z WARN Something went wrong")
 * // => "Something went wrong"
 *
 * extractCoreMessage("No timestamp here")
 * // => "No timestamp here"
 */
export function extractCoreMessage(message: string): string {
  // LOG_PREFIX_RE covers ISO timestamp + any level-word token — the canonical
  // pattern reused here so the ISO date literal is not duplicated.
  // Rageshake only emits TRACE/DEBUG/INFO/WARN/ERROR, so the permissive \w+
  // in LOG_PREFIX_RE is safe in practice.
  if (!LOG_PREFIX_RE.test(message)) return message;
  const payload = stripLogPrefix(message).trim();
  // Guard against a degenerate line that has only a prefix and no payload.
  return payload.length > 0 ? payload : message;
}

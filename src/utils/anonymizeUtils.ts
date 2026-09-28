import type { AnonymizationDictionary, ParsedLogLine } from '../types/log.types';

/**
 * Marker line prepended to exported anonymized logs.
 *
 * When this string appears as the very first non-empty line of a log file,
 * the viewer recognises the file as previously anonymized and pre-activates
 * the anonymized button state. The marker is stripped before the rest of the
 * file is parsed normally.
 *
 * @example
 * ```
 * # [shakeview-anonymized]
 * 2026-01-01T00:00:00Z INFO @user0:domain0.org joined !room0:domain0.org
 * ```
 */
export const ANONYMIZED_LOG_MARKER = '# [shakeview-anonymized]';

/**
 * Markers accepted when reading. Only `ANONYMIZED_LOG_MARKER` is ever written;
 * the legacy name is still recognised so logs exported before the rename keep
 * loading as anonymized.
 */
const ACCEPTED_LOG_MARKERS = [ANONYMIZED_LOG_MARKER, '# [rageshake-viewer-anonymized]'];

// ---------------------------------------------------------------------------
// Matrix identifier regexes (per spec Appendix 4)
// ---------------------------------------------------------------------------

/**
 * Server name component used inside composite identifier patterns.
 *
 * Covers:
 * - IPv6 literals:    `[hexchars]`
 * - IPv4 / DNS names: `matrix.org`, `1.2.3.4`, `sub.matrix.org`
 * - Optional port:    `:8448`
 *
 * A dot is required in the hostname part so that bare digits (e.g. `0`, `1`)
 * or single-label names (e.g. `localhost`, `channel`) are never mistaken for
 * Matrix server names. Without this guard, an identifier like `#channel:0`
 * would cause every `0` digit in every log line to be replaced with a domain
 * alias, silently corrupting timestamps and other unrelated values.
 */
const HOST_PAT =
  '(?:\\[[0-9A-Fa-f:.]+\\]|[A-Za-z0-9][A-Za-z0-9\\-]*(?:\\.[A-Za-z0-9][A-Za-z0-9\\-]*)+)';
const SERVER_NAME_PAT = `${HOST_PAT}(?::\\d{1,5})?`;

/**
 * Percent-encoded identifier parts, as found in URL query strings (e.g. Element
 * Call widget URLs: `userId=%40alice%3Aexample.org`). `ESC` is a `%` at any
 * nesting depth: `%` single-encoded, `%25` double-encoded (a URL in a URL), ….
 *
 * Each localpart class accepts exactly what the plain pattern of that kind
 * accepts, written unreserved or escaped, and never a URL separator (`%20`,
 * `%26` `&`, `%23` `#`, …), so a match cannot run across query parameters:
 * user IDs `[a-zA-Z0-9._=\-/+]`, room/event IDs the same plus `~`, room
 * aliases `+` and non-ASCII bytes, domainless IDs base64. An IPv6 server name
 * arrives as `%5B…%5D` (`[…]`).
 */
const ESC = '%(?:25)*';
const ENC_COLON = `${ESC}3[Aa]`;
const ENC_USER_CHAR = `(?:[A-Za-z0-9._\\-]|${ESC}(?:2[BbFf]|3[Dd]))`;
const ENC_CHAR = `(?:[A-Za-z0-9._~\\-]|${ESC}(?:2[BbFf]|3[Dd]))`;
const ENC_ALIAS_CHAR = `(?:[A-Za-z0-9._~\\-]|${ESC}(?:2[Bb]|[89A-Fa-f][0-9A-Fa-f]))`;
const ENC_BASE64_CHAR = `(?:[A-Za-z0-9_\\-]|${ESC}(?:2[BbFf]|3[Dd]))`;
const ENC_SERVER_NAME_PAT =
  `${ENC_COLON}(?:${ESC}5[Bb](?:[0-9A-Fa-f.]|${ENC_COLON})+${ESC}5[Dd]|${HOST_PAT})(?:${ENC_COLON}\\d{1,5})?`;

/**
 * Matches all Matrix identifiers in a text string.
 *
 * Patterns are ordered longest-first (identifiers with domain before bare
 * event/room IDs) so that `$id:domain` is captured before `$id`.
 *
 * Exported for the CLI `precheck` command, which scans archives for raw
 * (non-anonymized) identifiers before an analysis session starts.
 */
export const MATRIX_IDENTIFIER_RE = new RegExp(
  [
    // User ID:  @localpart:server_name
    // The Matrix spec requires lowercase localparts in modern IDs, but
    // historical servers (e.g. old Synapse versions) allowed uppercase letters
    // such as "@Bob:matrix.org". Accept both cases so those IDs are anonymized.
    `@[a-zA-Z0-9._=\\-/+]+:${SERVER_NAME_PAT}`,
    // Room alias: #alias:server_name. The localpart excludes URL delimiters
    // (`/?&=#`): a `#` followed by one is a URL fragment (`matrix.to/#/!room:…`,
    // `app.element.io/#/room/!room:…`, `index.html#?roomId=!room:…`), and
    // matching it as an alias would hide the ID inside behind a different hash.
    `#[^:\\s\\x00/?&=#]+:${SERVER_NAME_PAT}`,
    // Room ID with domain: !opaque_id:server_name
    `![A-Za-z0-9._~=+\\-/]+:${SERVER_NAME_PAT}`,
    // Event ID with domain: $opaque_id:server_name
    `\\$[A-Za-z0-9._~=+\\-/]+:${SERVER_NAME_PAT}`,
    // Percent-encoded user ID, room ID, event ID, room alias with domain (%40 @,
    // %21 !, %24 $, %23 #). The sigil may be left unescaped (encodeURIComponent
    // keeps `!`). Before the modern patterns, which would stop `!id%3A…` at `%`.
    `(?:${ESC}40|@)${ENC_USER_CHAR}+${ENC_SERVER_NAME_PAT}`,
    `(?:${ESC}2[14]|[!$])${ENC_CHAR}+${ENC_SERVER_NAME_PAT}`,
    `(?:${ESC}23|#)${ENC_ALIAS_CHAR}+${ENC_SERVER_NAME_PAT}`,
    // Percent-encoded modern room/event ID (no domain, base64, min 10 chars)
    `${ESC}2[14]${ENC_BASE64_CHAR}{10,}`,
    // Modern event ID (no domain, base64url, min 10 chars to reduce false positives)
    `\\$[A-Za-z0-9+/=_\\-]{10,}`,
    // Modern room ID (no domain, base64url, min 10 chars)
    `![A-Za-z0-9+/=_\\-]{10,}`,
  ].join('|'),
  'g',
);

/**
 * Decode a percent-encoded identifier (`%21abc%3Aexample.org` → `!abc:example.org`),
 * as many times as it was encoded. `levels` is that count; plain identifiers
 * come back unchanged with `levels` 0.
 */
function decodeIdentifierLevels(id: string): { plain: string; levels: number } {
  if (!/^%|%(?:25)*3[Aa]/.test(id)) return { plain: id, levels: 0 };
  // ponytail: ASCII escapes only, so a stray non-UTF-8 byte can never throw. A
  // non-ASCII localpart stays escaped: still anonymized, just not linked to its
  // plain spelling.
  const decodeOnce = (s: string) => s.replace(/%([0-7][0-9A-Fa-f])/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  let plain = id;
  let levels = 0;
  for (let next = decodeOnce(plain); next !== plain; next = decodeOnce(plain)) {
    plain = next;
    levels++;
  }
  return { plain, levels };
}

/** Plain form of a percent-encoded identifier. Plain identifiers come back unchanged. */
export function decodeIdentifier(id: string): string {
  return decodeIdentifierLevels(id).plain;
}

/**
 * Inverse of `decodeIdentifierLevels` for an alias: encode `levels` times,
 * escaping the sigil only when the original identifier escaped it.
 */
function encodeIdentifier(alias: string, levels: number, escapeSigil: boolean): string {
  let s = alias;
  for (let i = 0; i < levels; i++) {
    s = s.replace(/%/g, '%25').replace(/:/g, '%3A');
    if (i === 0 && escapeSigil) s = `%${s.charCodeAt(0).toString(16).toUpperCase()}${s.slice(1)}`;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * Return the first `len` hex characters of the SHA-256 digest of `input`.
 *
 * Uses the native Web Crypto API (`crypto.subtle`) — no dependency. Available
 * in the extension, on `localhost` (secure contexts), and in Node 20+/jsdom
 * test runners via `globalThis.crypto`.
 */
export async function sha256Hex(input: string, len: number): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, len);
}

// ---------------------------------------------------------------------------
// Dictionary builder
// ---------------------------------------------------------------------------

/**
 * Scan every raw text field in `logLines` and build a bidirectional
 * anonymization dictionary.
 *
 * Each alias is a pure function of the identifier: a truncated salted SHA-256
 * hash, so the same identifier maps to the same alias in every rageshake and on
 * every machine that shares the `salt`. Naming scheme:
 * - Domains:      `domain-<hash8>.org`
 * - User IDs:     `@user-<hash12>:domain-<hash8>.org`
 * - Room IDs:     `!room-<hash12>:domain-<hash8>.org` (or `!room-<hash12>` modern)
 * - Room aliases: `#room_alias-<hash12>:domain-<hash8>.org`
 * - Event IDs:    `$event-<hash12>:domain-<hash8>.org` (or `$event-<hash12>` modern)
 * - Percent-encoded IDs (`%21abc%3Aexample.org`): the alias of the decoded ID,
 *   encoded back (`%21room-<hash12>%3Adomain-<hash8>.org`), so an ID in a URL
 *   query links to the same ID logged plain.
 *
 * The bare server name is hashed separately from the full identifier so all
 * users on one server share one domain alias (preserves "same server" debugging
 * info) without revealing that two accounts share a username across servers.
 *
 * Domains encountered inside Matrix identifiers are registered in the `forward`
 * map so that standalone occurrences of the same domain string in log text are
 * also replaced by `applyAnonymization` without a second scan pass.
 *
 * @param salt Shared secret folded into every hash (see `anonSaltStore`). An
 *   empty salt yields reproducible-but-guessable pseudonymisation.
 *
 * @example
 * ```ts
 * const dict = await buildAnonymizationDictionary(parsedLines, salt);
 * dict.forward['@alice:matrix.example.org']; // '@user-<hash12>:domain-<hash8>.org'
 * ```
 */
export async function buildAnonymizationDictionary(
  logLines: readonly ParsedLogLine[],
  salt: string,
): Promise<AnonymizationDictionary> {
  const texts: string[] = [];
  for (const line of logLines) {
    texts.push(line.rawText);
    if (line.continuationLines) texts.push(...line.continuationLines);
  }
  return buildAnonymizationDictionaryFromTexts(texts, salt);
}

/**
 * Build an anonymization dictionary from raw text blobs (e.g. whole files)
 * instead of parsed log lines. Used to anonymise arbitrary archive members with
 * cross-file-consistent aliases: pass every file's text so one identifier maps
 * to one alias across the whole archive.
 */
export async function buildAnonymizationDictionaryFromTexts(
  texts: readonly string[],
  salt: string,
): Promise<AnonymizationDictionary> {
  const forward: Record<string, string> = {};
  const reverse: Record<string, string> = {};

  function register(original: string, alias: string): void {
    if (forward[original] !== undefined) return;
    // Detect a truncated-hash collision rather than silently overwriting the
    // reverse entry (which would make unanonymisation restore the wrong value).
    // Astronomically unlikely for realistic sizes; surfaced loudly if it happens.
    if (reverse[alias] !== undefined && reverse[alias] !== original) {
      // Do not embed the original identifiers in the message — they are the
      // sensitive values anonymisation exists to hide. The alias is a hash.
      throw new Error(`anonymisation alias collision on ${alias}`);
    }
    forward[original] = alias;
    reverse[alias] = original;
  }

  // ponytail: 12 hex chars = 48 bits for tokens, 8 = 32 bits for domains —
  // collisions negligible for realistic log sizes. A collision CANNOT be repaired
  // with a per-run suffix (different files see different ID sets, which would break
  // cross-file determinism), so the lengths are fixed. Bump if one is ever observed.

  /**
   * Return the existing or freshly-created alias for `serverName`.
   *
   * The bare server name (port stripped) is registered so that standalone
   * occurrences of that domain in log text are replaced by `applyAnonymization`
   * without needing an extra scan pass. Port-bearing variants get a distinct
   * alias that preserves the original port suffix (e.g. `domain0.org:8448`)
   * so the dictionary remains bijective and unanonymization can recover the
   * exact original server name.
   */
  async function getOrCreateDomainAlias(serverName: string): Promise<string> {
    if (forward[serverName] !== undefined) return forward[serverName];

    const portMatch = serverName.match(/:\d{1,5}$/);
    const portSuffix = portMatch?.[0] ?? '';
    const bare = portSuffix ? serverName.slice(0, -portSuffix.length) : serverName;

    let bareAlias = forward[bare];
    if (bareAlias === undefined) {
      bareAlias = `domain-${await sha256Hex(salt + bare, 8)}.org`;
      register(bare, bareAlias);
    }

    if (portSuffix === '') {
      return bareAlias;
    }

    const alias = `${bareAlias}${portSuffix}`;
    register(serverName, alias);
    return alias;
  }

  const aliasPrefixes = new Map([['@', '@user'], ['#', '#room_alias'], ['!', '!room'], ['$', '$event']]);

  /** Alias of a plain identifier, or undefined when it cannot be hashed. */
  async function aliasFor(id: string): Promise<string | undefined> {
    const prefix = aliasPrefixes.get(id[0]);
    if (prefix === undefined) return undefined;
    const colonIdx = id.indexOf(':');
    if (colonIdx === -1) {
      // Only room and event IDs exist without a server name (modern IDs).
      return prefix === '!room' || prefix === '$event' ? `${prefix}-${await sha256Hex(salt + id, 12)}` : undefined;
    }
    const domainAlias = await getOrCreateDomainAlias(id.slice(colonIdx + 1));
    return `${prefix}-${await sha256Hex(salt + id, 12)}:${domainAlias}`;
  }

  async function processIdentifier(id: string): Promise<void> {
    if (forward[id] !== undefined) return;
    // An encoded ID gets the alias of its plain form, encoded back the same
    // way, so it links to the same ID logged plain. The plain form itself is
    // not registered: it may not be in the text.
    const { plain, levels } = decodeIdentifierLevels(id);
    const plainAlias = forward[plain] ?? await aliasFor(plain);
    if (plainAlias === undefined) return;
    if (levels === 0) {
      register(id, plainAlias);
      return;
    }
    const alias = encodeIdentifier(plainAlias, levels, id.startsWith('%'));
    // Spellings of one ID (`%3A` / `%3a`) share its alias; unanonymization
    // restores the first one seen.
    if (reverse[alias] !== undefined && decodeIdentifier(reverse[alias]) === plain) forward[id] = alias;
    else register(id, alias);
  }

  // Phase 1 — synchronous scan collecting unique identifiers in first-seen order.
  // Hashing is async, so scanning synchronously first avoids an await per *match*
  // (there are far more occurrences than unique ids) — we only await once per
  // unique identifier in phase 2. Fresh regex instance so its lastIndex is ours.
  const scanRe = new RegExp(MATRIX_IDENTIFIER_RE.source, 'g');
  const uniqueIds: string[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    scanRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = scanRe.exec(text)) !== null) {
      if (!seen.has(m[0])) {
        seen.add(m[0]);
        uniqueIds.push(m[0]);
      }
    }
  }

  // Phase 2 — hash each unique identifier (order-independent, so dedup is safe).
  for (const id of uniqueIds) {
    await processIdentifier(id);
  }

  return { forward, reverse };
}

// ---------------------------------------------------------------------------
// Text transformation
// ---------------------------------------------------------------------------

/**
 * Matches every alias form `buildAnonymizationDictionary` writes, to look up in
 * `reverse`: a sigil, a `[\w-]` localpart (`user-<hash>`, legacy `room0`), then
 * up to two `:`-separated parts (domain alias, port). Percent-encoded aliases
 * (`%21room-…%3Adomain-….org`, `!room-…%3A…`, double-encoded `%2521…%253A…`)
 * come first, so the plain branch does not stop them at `%`. The localpart
 * never holds `/`, `?`, `&` or `=`, so a URL fragment (`#/`, `#?userId=…`) never
 * swallows the aliases in it, and a domain part never ends on a `.`, `/` or `&`
 * that follows it.
 */
const ALIAS_DOMAIN_PAT = '[\\w-]+(?:\\.[\\w-]+)*';
const ALIAS_CANDIDATE_PAT = [
  `(?:%(?:25)*(?:40|2[134])|[@#!$])[\\w-]+(?:%(?:25)*3A${ALIAS_DOMAIN_PAT}){1,2}`,
  '%(?:25)*2[14][\\w-]+',
  `[@#!$][\\w-]+(?::${ALIAS_DOMAIN_PAT}){0,2}`,
].join('|');

/**
 * Checks whether a forward/reverse map key is a bare domain name (no sigil,
 * not percent-encoded). Used to separate the two replacement strategies.
 */
function isBareKey(k: string): boolean {
  const c = k[0];
  return c !== '@' && c !== '#' && c !== '!' && c !== '$' && c !== '%';
}

/**
 * Replace all original identifiers in `text` with their anonymized aliases.
 *
 * Two-phase strategy:
 * 1. One pass with `MATRIX_IDENTIFIER_RE` (a fixed, V8-JIT-optimizable pattern)
 *    to find all sigil-prefixed Matrix identifiers, then resolve via Map lookup.
 *    This avoids building a large alternation regex from dictionary keys, which
 *    causes V8 to fall back to slow interpreted NFA mode.
 * 2. Split/join for bare domain names (e.g. `matrix.org`) that can appear
 *    standalone in log text. There are typically very few (< 20) unique domains,
 *    so the linear-scan split/join cost is negligible. Sorted longest-first to
 *    prevent a shorter key from consuming a longer overlapping key.
 *
 * @example
 * ```ts
 * const dict = buildAnonymizationDictionary(lines);
 * applyAnonymization('@alice:example.org invited @bob:example.org', dict);
 * // '@user0:domain0.org invited @user1:domain0.org'
 * ```
 */
export function applyAnonymization(text: string, dict: AnonymizationDictionary): string {
  const { forward } = dict;
  if (Object.keys(forward).length === 0) return text;
  // Phase 1: sigil-prefixed identifiers via MATRIX_IDENTIFIER_RE + Map.
  MATRIX_IDENTIFIER_RE.lastIndex = 0;
  let result = text.replace(MATRIX_IDENTIFIER_RE, (m) => forward[m] ?? m);
  // Phase 2: bare domain names, longest-first to avoid partial clobbering.
  for (const [key, val] of Object.entries(forward)
    .filter(([k]) => isBareKey(k))
    .sort(([a], [b]) => b.length - a.length)) {
    if (result.includes(key)) result = result.split(key).join(val);
  }
  return result;
}

/**
 * Recover original identifiers from anonymized aliases in `text`.
 *
 * Uses the same two-phase strategy as `applyAnonymization`:
 * 1. A compact alias-candidate pattern finds all sigil-prefixed alias forms
 *    generated by `buildAnonymizationDictionary` (including short aliases like
 *    `!room0` and `$event0` that fall below `MATRIX_IDENTIFIER_RE`'s 10-char
 *    minimum for modern IDs).
 * 2. Split/join for bare domain alias names (`domain0.org`, etc.).
 *
 * @example
 * ```ts
 * applyUnanonymization('@user0:domain0.org', dict);
 * // '@alice:example.org'
 * ```
 */
export function applyUnanonymization(text: string, dict: AnonymizationDictionary): string {
  const { reverse } = dict;
  if (Object.keys(reverse).length === 0) return text;
  // Phase 1: sigil-prefixed aliases (see ALIAS_CANDIDATE_PAT).
  const candidateRe = new RegExp(ALIAS_CANDIDATE_PAT, 'g');
  let result = text.replace(candidateRe, (m) => reverse[m] ?? m);
  // Phase 2: bare domain alias names.
  for (const [key, val] of Object.entries(reverse)
    .filter(([k]) => isBareKey(k))
    .sort(([a], [b]) => b.length - a.length)) {
    if (result.includes(key)) result = result.split(key).join(val);
  }
  return result;
}

/**
 * Compile a reusable text anonymizer from a dictionary. Precomputes all
 * derived structures once so the returned function is as cheap as possible
 * per invocation. Use this for batch processing (e.g. the full log).
 *
 * The compiled anonymizer uses the same two-phase strategy as
 * `applyAnonymization`: MATRIX_IDENTIFIER_RE scan + Map lookup for
 * sigil-prefixed identifiers, then split/join for bare domain names.
 *
 * @example
 * ```ts
 * const apply = buildCompiledAnonymizer(dict);
 * const anonLines = lines.map(l => apply(l.rawText));
 * ```
 */
export function buildCompiledAnonymizer(dict: AnonymizationDictionary): (text: string) => string {
  const { forward } = dict;
  if (Object.keys(forward).length === 0) return (text) => text;
  // Precompute bare-domain pairs once (sorted longest-first).
  const domainPairs = Object.entries(forward)
    .filter(([k]) => isBareKey(k))
    .sort(([a], [b]) => b.length - a.length) as Array<[string, string]>;
  // Fresh regex instance per compiled anonymizer so each closure owns its
  // own lastIndex state and they don't interfere with each other.
  const candidateRe = new RegExp(MATRIX_IDENTIFIER_RE.source, 'g');
  return (text: string): string => {
    let result = text.replace(candidateRe, (m) => forward[m] ?? m);
    for (const [key, val] of domainPairs) {
      if (result.includes(key)) result = result.split(key).join(val);
    }
    return result;
  };
}

/**
 * Compile a reusable text unanonymizer from a dictionary. Counterpart of
 * `buildCompiledAnonymizer` for restoring original identifiers.
 *
 * Uses a compact alias-candidate pattern instead of MATRIX_IDENTIFIER_RE so
 * that short aliases without a domain suffix (`!room0`, `$event0`) — which
 * fall below the 10-char minimum in the modern-ID patterns — are found
 * correctly.
 *
 * @example
 * ```ts
 * const restore = buildCompiledUnanonymizer(dict);
 * const origLines = anonLines.map(l => restore(l.rawText));
 * ```
 */
export function buildCompiledUnanonymizer(dict: AnonymizationDictionary): (text: string) => string {
  const { reverse } = dict;
  if (Object.keys(reverse).length === 0) return (text) => text;
  // Precompute bare domain alias pairs once.
  const domainAliasPairs = Object.entries(reverse)
    .filter(([k]) => isBareKey(k))
    .sort(([a], [b]) => b.length - a.length) as Array<[string, string]>;
  const candidateRe = new RegExp(ALIAS_CANDIDATE_PAT, 'g');
  return (text: string): string => {
    let result = text.replace(candidateRe, (m) => reverse[m] ?? m);
    for (const [key, val] of domainAliasPairs) {
      if (result.includes(key)) result = result.split(key).join(val);
    }
    return result;
  };
}

// ---------------------------------------------------------------------------
// Log-line transformers
// ---------------------------------------------------------------------------

/**
 * Return a new `ParsedLogLine` with all text fields anonymized according to
 * `dict`. Structural and numeric fields (`lineNumber`, all timestamp fields,
 * `level`, `filePath`, `sourceLineNumber`) are preserved unchanged.
 *
 * @example
 * ```ts
 * const anonLine = anonymizeLogLine(parsedLine, dict);
 * anonLine.rawText;                              // anonymized
 * anonLine.lineNumber === parsedLine.lineNumber; // true
 * ```
 */
export function anonymizeLogLine(line: ParsedLogLine, dict: AnonymizationDictionary): ParsedLogLine {
  return {
    ...line,
    rawText: applyAnonymization(line.rawText, dict),
    message: applyAnonymization(line.message, dict),
    strippedMessage: applyAnonymization(line.strippedMessage, dict),
    continuationLines: line.continuationLines?.map((cl) => applyAnonymization(cl, dict)),
  };
}

/**
 * Return a new `ParsedLogLine` with anonymized aliases restored to originals.
 *
 * Used when unanonymizing a log that was loaded from an already-anonymized file
 * (i.e., no in-memory backup of the original lines exists).
 */
export function unanonymizeLogLine(line: ParsedLogLine, dict: AnonymizationDictionary): ParsedLogLine {
  return {
    ...line,
    rawText: applyUnanonymization(line.rawText, dict),
    message: applyUnanonymization(line.message, dict),
    strippedMessage: applyUnanonymization(line.strippedMessage, dict),
    continuationLines: line.continuationLines?.map((cl) => applyUnanonymization(cl, dict)),
  };
}

// ---------------------------------------------------------------------------
// Marker detection
// ---------------------------------------------------------------------------

/**
 * Return true if `rawContent` was previously exported with the anonymization
 * marker. Only the first non-empty line is inspected.
 *
 * @example
 * ```ts
 * detectAnonymizedLog('# [shakeview-anonymized]\n2026-01-01T00:00:00Z INFO hello');
 * // true
 * detectAnonymizedLog('2026-01-01T00:00:00Z INFO hello');
 * // false
 * ```
 */
export function detectAnonymizedLog(rawContent: string): boolean {
  let lineStart = 0;
  while (lineStart <= rawContent.length) {
    let lineEnd = rawContent.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = rawContent.length;
    const line = rawContent.slice(lineStart, lineEnd).replace(/\r$/, '');
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      return ACCEPTED_LOG_MARKERS.includes(trimmed);
    }
    if (lineEnd === rawContent.length) break;
    lineStart = lineEnd + 1;
  }
  return false;
}

/**
 * Strip the anonymization marker from `rawContent` so the remainder can be
 * parsed normally. Returns the content unchanged if the marker is absent.
 *
 * Mirrors `detectAnonymizedLog`: skips leading blank lines and removes the
 * marker line wherever it appears as the first non-empty line, regardless of
 * line-ending style.
 */
export function stripAnonymizedMarker(rawContent: string): string {
  let lineStart = 0;
  while (lineStart <= rawContent.length) {
    let lineEnd = rawContent.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = rawContent.length;
    const line = rawContent.slice(lineStart, lineEnd).replace(/\r$/, '');
    if (line.trim().length > 0) {
      if (ACCEPTED_LOG_MARKERS.includes(line.trim())) {
        const nextLineStart = lineEnd < rawContent.length ? lineEnd + 1 : lineEnd;
        return rawContent.slice(0, lineStart) + rawContent.slice(nextLineStart);
      }
      return rawContent;
    }
    if (lineEnd === rawContent.length) break;
    lineStart = lineEnd + 1;
  }
  return rawContent;
}

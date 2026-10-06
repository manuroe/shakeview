/**
 * Parses the `| spans: <chain>` suffix that the Rust SDK's `tracing` layer
 * appends to a log line. The chain is the execution-context tree the line ran
 * under, e.g.
 *
 *   spans: root > next_sync_with_lock{store_generation=43} > sync_once{conn_id="encryption" timeout=30000} > send{request_id="REQ-0" method=GET}
 *
 * Grammar (confirmed against real logs + SDK `#[instrument]` definitions):
 * - Segments are separated by ` > `.
 * - A segment is `name` or `name{fields}`; names can contain spaces
 *   ("Global proxy"), so we split at the FIRST `{`.
 * - Fields are SPACE-separated `key=value` (not comma). Values may be quoted
 *   strings, bare tokens/ints, durations, or `Ident("…")` wrappers. Unrecorded
 *   fields render as an empty token (double space) and are dropped.
 * - The suffix is optional; a line with no spans yields [].
 */

import type { ParsedLogLine } from '../types/log.types';

export interface SpanSegment {
  readonly name: string;
  readonly fields: Readonly<Record<string, string>>;
}

export const SPANS_MARKER = ' | spans: ';

/**
 * Split a `{...}` field body into `key=value` tokens on spaces, but ignore
 * spaces inside quotes (`"…"`) or parens (`Ident(…)`) and drop empty tokens
 * (from the double-space rendering of an unrecorded field).
 */
function splitFieldTokens(body: string): string[] {
  const tokens: string[] = [];
  let depth = 0; // paren nesting
  let inQuote = false;
  let escaped = false; // previous char was a backslash inside a quote
  let cur = '';
  for (const ch of body) {
    if (inQuote) {
      cur += ch;
      // A `\"` (Debug-formatted value) is a literal quote, not the closer.
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inQuote = false;
      continue;
    }
    if (ch === '"') { inQuote = true; cur += ch; continue; }
    if (ch === '(') { depth++; cur += ch; continue; }
    if (ch === ')') { if (depth > 0) depth--; cur += ch; continue; }
    if (ch === ' ' && depth === 0) {
      if (cur) tokens.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

function parseFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const tok of splitFieldTokens(body)) {
    const eq = tok.indexOf('=');
    if (eq === -1) continue; // malformed token, skip
    const key = tok.slice(0, eq);
    let value = tok.slice(eq + 1);
    // Strip surrounding quotes for display; leave Ident("…") wrappers intact.
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }
  return fields;
}

function parseSegment(element: string): SpanSegment {
  const brace = element.indexOf('{');
  if (brace === -1 || !element.endsWith('}')) {
    return { name: element, fields: {} };
  }
  return { name: element.slice(0, brace), fields: parseFields(element.slice(brace + 1, -1)) };
}

/**
 * Filter value for a click-to-filter span chip. A fielded segment's full text
 * varies line to line (fields are recorded progressively), so filtering by the
 * whole segment would match only the exact rendering that was clicked. Return
 * the stable prefix `name{…request_id` (or `name{firstField` when the segment has
 * no request_id) — present in every rendering of that span instance (e.g.
 * `send{request_id="req-073"`) — so the filter catches all its lines. Field-less
 * segments scope by name.
 */
export function spanFilterValue(segment: string): string {
  const brace = segment.indexOf('{');
  if (brace === -1 || !segment.endsWith('}')) return segment;
  const name = segment.slice(0, brace);
  const body = segment.slice(brace + 1, -1);
  // The first field is not always instance-specific: since matrix-rust-sdk b8b4e9bb9
  // send{} opens with `config=RequestConfig { … }`, identical for every request, so
  // `send{config=RequestConfig` would filter in every HTTP line. When a request_id
  // field is present, stretch the prefix through it — still a literal prefix of the
  // segment, and unique to this span instance.
  const idAt = body.indexOf('request_id="');
  if (idAt !== -1) {
    const end = body.indexOf(' ', idAt); // request_id values are quoted and space-free
    return `${name}{${end === -1 ? body : body.slice(0, end)}`;
  }
  const [first] = splitFieldTokens(body);
  return first ? `${name}{${first}` : name;
}

// tracing's pretty format (matrix-sdk-crypto-wasm in Element Web) puts each span on its
// own continuation line, leaf first: `    in matrix_sdk_crypto::machine::receive_sync_changes with since="…"`.
const PRETTY_SPAN_RE = /^\s+in (\S+)(?: with (.+))?$/;

/**
 * Span segments from pretty-format `in …` continuation lines, root first and
 * rendered `name{fields}` like the compact chain. The name keeps only the last
 * `::` segment, as compact spans name the function alone.
 */
function prettySpanSegments(body: string): string[] {
  const segments: string[] = [];
  for (const line of body.split('\n')) {
    const m = line.match(PRETTY_SPAN_RE);
    if (!m) continue;
    const sep = m[1].lastIndexOf('::');
    const name = sep === -1 ? m[1] : m[1].slice(sep + 2);
    segments.push(m[2] ? `${name}{${m[2].trim()}}` : name);
  }
  return segments.reverse();
}

/**
 * Return the raw span-chain segments (the whole span, still quoted/braced, as
 * it appears in the line), or [] when there is neither a `spans:` suffix nor
 * pretty-format `in …` continuation lines. In `/logs`
 * each segment is the clickable chip's text; the value it actually filters by
 * is derived separately via `spanFilterValue` (the stable name+first-field
 * prefix, so it survives a span's progressively-recorded fields).
 *
 * ponytail: split on the literal ` > ` — no span field value in the wild
 * contains `>` (values are quoted or paren-wrapped). Make this quote-aware if
 * that ever changes.
 */
export function spanSegments(rawText: ParsedLogLine['rawText']): string[] {
  // Only the first physical line carries the prefix+suffix; bound the scan so
  // multi-line entries don't search their whole body (mirrors extractTarget).
  const nl = rawText.indexOf('\n');
  const firstLine = nl === -1 ? rawText : rawText.slice(0, nl);

  const idx = firstLine.lastIndexOf(SPANS_MARKER);
  if (idx === -1) return nl === -1 ? [] : prettySpanSegments(rawText.slice(nl + 1));

  const chain = firstLine.slice(idx + SPANS_MARKER.length).trim();
  if (!chain) return [];

  return chain.split(' > ').map((el) => el.trim());
}

/**
 * Parse the span chain from a log line's raw text. Returns [] when the line
 * carries no `spans:` suffix.
 *
 * @example
 * parseSpans('… | spans: root > send{request_id="REQ-0" method=GET}');
 * // [{ name: 'root', fields: {} },
 * //  { name: 'send', fields: { request_id: 'REQ-0', method: 'GET' } }]
 */
export function parseSpans(rawText: ParsedLogLine['rawText']): SpanSegment[] {
  return spanSegments(rawText).map(parseSegment);
}

/**
 * Field readers for crypto log lines, in both formats shakeview parses:
 * Rust compact (`msg key=value … | file.rs:NN | spans: a > b{k=v}`) and
 * tracing's pretty format from crypto-wasm on Element Web (event fields on a
 * continuation line, spans on `in <span> with k=v` lines).
 *
 * Values are Rust `Debug` text, so a value may nest quotes, (), {} and [].
 */
import type { ParsedLogLine } from '../../types/log.types';
import { parseSpans, type SpanSegment } from '../spansParser';
import type { ToDeviceMessage } from './types';

const IDENT_CHAR = /[A-Za-z0-9_]/;

/** Read a value starting at `start`: quotes and brackets nest; a top-level space, newline or unmatched closer ends it. */
function readValue(text: string, start: number): string {
  let depth = 0;
  let inQuote = false;
  let escaped = false;
  let i = start;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (inQuote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inQuote = false;
      continue;
    }
    if (ch === '"') inQuote = true;
    else if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') {
      if (depth === 0) break;
      depth--;
    } else if ((ch === ' ' || ch === '\n') && depth === 0) break;
  }
  return text.slice(start, i);
}

function unquote(v: string): string {
  return v.length >= 2 && v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v;
}

/**
 * First `key=value` in `text` whose key is not the tail of a longer identifier:
 * `session_id` must not read `old_session_id`.
 *
 * @example fieldIn('old_session_id="A" session_id="B"', 'session_id') // 'B'
 */
export function fieldIn(text: string, key: string): string | undefined {
  let from = 0;
  for (;;) {
    const at = text.indexOf(`${key}=`, from);
    if (at === -1) return undefined;
    if (at === 0 || !IDENT_CHAR.test(text[at - 1])) return unquote(readValue(text, at + key.length + 1));
    from = at + 1;
  }
}

/**
 * The event's own fields, without its spans: Rust compact keeps them on the
 * first line before ` | `; the pretty format on continuation lines that are not
 * `at …`/`in …` lines.
 */
function eventFieldText(line: ParsedLogLine): string {
  const [first, ...rest] = line.rawText.split('\n');
  const head = first.split(' | ')[0];
  return [head, ...rest.filter((l) => !/^\s+(at|in) /.test(l))].join(' ');
}

// ponytail: one-line cache — a step's extract reads several span fields of the same line,
// and re-parsing a long span chain each time made extraction seconds on a busy archive.
let lastRaw: string | undefined;
let lastSpans: SpanSegment[] = [];
function spansOf(line: ParsedLogLine): SpanSegment[] {
  if (line.rawText !== lastRaw) {
    lastRaw = line.rawText;
    lastSpans = parseSpans(line.rawText);
  }
  return lastSpans;
}

/**
 * A field of the innermost span named `span`: the same key (`room_id`) often sits on several spans of a chain.
 *
 * @example spanField(line, 'decrypt_room_event', 'event_id') // '$ev1'
 */
export function spanField(line: ParsedLogLine, span: string, key: string): string | undefined {
  const spans = spansOf(line);
  for (let i = spans.length - 1; i >= 0; i--) {
    const value = spans[i].name === span ? spans[i].fields[key] : undefined;
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * An event field, else the innermost span field with that key: for keys whichever of the two carries.
 *
 * @example field(line, 'session_id') // 'SESS1'
 */
export function field(line: ParsedLogLine, key: string): string | undefined {
  const own = fieldIn(eventFieldText(line), key);
  if (own !== undefined) return own;
  const spans = spansOf(line);
  for (let i = spans.length - 1; i >= 0; i--) {
    const value = spans[i].fields[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * A field value as an integer, `undefined` when absent or not a number, so a bad value never reads as 0.
 *
 * @example intField('42') // 42
 */
export function intField(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? undefined : n;
}

/**
 * A Curve25519 key as raw base64, however the line printed it, so keys from different SDKs compare equal.
 * Rust's `None` is no key: it must not match other keyless steps.
 *
 * @example curveKey('Some("curve25519:abc")') // 'abc'
 */
export function curveKey(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const m = /^(?:Some\()?"?(?:curve25519:)?([A-Za-z0-9+/=]+)"?\)?$/.exec(v.trim());
  return m && m[1] !== 'None' ? m[1] : undefined;
}

/**
 * Every `"…"` string at brace depth `depth` of a Debug-printed map/set: the session ids of an import or backup upload.
 *
 * @example stringsAtDepth('{"!r": {"K": {"S1", "S2"}}}', 3) // ['S1', 'S2']
 */
export function stringsAtDepth(v: string | undefined, depth: number): string[] {
  const out: string[] = [];
  if (!v) return out;
  let d = 0;
  for (let i = 0; i < v.length; i++) {
    const ch = v[i];
    if (ch === '{') d++;
    else if (ch === '}') d--;
    else if (ch === '"') {
      const end = v.indexOf('"', i + 1);
      if (end === -1) break;
      if (d === depth) out.push(v.slice(i + 1, end));
      i = end;
    }
  }
  return out;
}

/**
 * The devices a room key share went to, so a receiver can be found in it.
 *
 * @example parseRecipients('{"@u:d": {"DEV1", "DEV2"}}') // [['@u:d', 'DEV1'], ['@u:d', 'DEV2']]
 */
export function parseRecipients(v: string | undefined): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (!v) return out;
  let d = 0;
  let user = '';
  for (let i = 0; i < v.length; i++) {
    const ch = v[i];
    if (ch === '{') d++;
    else if (ch === '}') d--;
    else if (ch === '"') {
      const end = v.indexOf('"', i + 1);
      if (end === -1) break;
      const s = v.slice(i + 1, end);
      if (d === 1) user = s;
      else if (d === 2) out.push([user, s]);
      i = end;
    }
  }
  return out;
}

const MESSAGE_TUPLE_RE = /\("([^"]+)", "([^"]+)", "([^"]+)"\)/g;

/**
 * The messages of a to-device batch, so each can be joined to its receipt by msgid.
 *
 * @example parseMessageList('[("m1", "@u:d", "DEV")]') // [{ messageId: 'm1', userId: '@u:d', deviceId: 'DEV' }]
 */
export function parseMessageList(v: string | undefined): ToDeviceMessage[] {
  if (!v) return [];
  return [...v.matchAll(MESSAGE_TUPLE_RE)].map((m) => ({ messageId: m[1], userId: m[2], deviceId: m[3] }));
}

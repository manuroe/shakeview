/**
 * The /decryption session list: newest first, split by day, consecutive sessions
 * with the same room, sender and outcomes folded into one group (a burst of
 * rotations in a busy room reads as one row).
 */
import { matchesOutcomes, type EventKeys } from './decryptionSummary';
import { utcText } from './format';
import { ANALYTICS_CATEGORIES } from './labels';
import type { AnalyticsCategory, MegolmSession } from './types';

/** One session as the /decryption list shows it, with what its filters and tags need. */
export interface SessionRow {
  readonly session: MegolmSession;
  /** Outcome keys: the keys of `counts`. */
  readonly keys: readonly string[];
  /** UTD events per outcome key (see sessionOutcomeCounts). */
  readonly counts: ReadonlyMap<string, number>;
  /** Per UTD event: outcome key and whether analytics received it (see sessionEventKeys). */
  readonly pairs: readonly EventKeys[];
  /** See sessionTime. */
  readonly ts: number;
}

/** One day of the /decryption list. */
export interface SessionDay {
  /** YYYY-MM-DD, UTC like every timestamp in the app. */
  readonly day: string;
  /** One entry per list row; a group when longer than one. */
  readonly groups: readonly (readonly SessionRow[])[];
}

/**
 * When a session happened, as on the /summary chart: its first UTD, else its key's arrival, else its first step.
 *
 * @example sessionTime(session) // 1_768_471_201_620_000
 */
export function sessionTime(s: MegolmSession): number {
  let t = Number.POSITIVE_INFINITY;
  if (s.utds.length > 0) {
    for (const u of s.utds) t = Math.min(t, u.firstFailedAt);
    return t;
  }
  let first = Number.POSITIVE_INFINITY;
  for (const steps of Object.values(s.stepsByDevice)) {
    for (const x of steps) {
      first = Math.min(first, x.ts);
      if (x.kind === 'roomkey.received') t = Math.min(t, x.ts);
    }
  }
  return t === Number.POSITIVE_INFINITY ? first : t;
}

const foldKey = (r: SessionRow) => `${r.session.roomId ?? ''}|${r.session.sender.key}|${[...r.keys].sort().join(',')}`;

/**
 * The /decryption session list: newest first, by day, same-room-sender-outcome runs folded.
 *
 * @example listSessions(rows)[0] // { day: '2026-01-15', groups: [[newest], [a, b]] }
 */
export function listSessions(entries: readonly Omit<SessionRow, 'ts'>[]): SessionDay[] {
  const rows = entries.map((e) => ({ ...e, ts: sessionTime(e.session) })).sort((a, b) => b.ts - a.ts);
  const days: { day: string; groups: SessionRow[][] }[] = [];
  for (const r of rows) {
    const day = utcText(r.ts, 'day');
    let d = days[days.length - 1];
    if (d?.day !== day) days.push((d = { day, groups: [] }));
    const last = d.groups[d.groups.length - 1];
    if (last && foldKey(last[0]) === foldKey(r)) last.push(r);
    else d.groups.push([r]);
  }
  return days;
}

/**
 * No UTD of the row reached analytics: the list mutes it, reported UTDs being the tracked metric.
 *
 * @example isUnreported([['utd:missing_key', 'not_reported']]) // true
 */
export const isUnreported = (pairs: readonly EventKeys[]) => pairs.length > 0 && pairs.every(([, a]) => a === 'not_reported');

/**
 * A folded group's outcome tags: its rows' UTD counts, summed per outcome key.
 *
 * @example Object.fromEntries(sumCounts(group)) // { 'utd:missing_key': 3 }
 */
export function sumCounts(rows: readonly Pick<SessionRow, 'counts'>[]): Map<string, number> {
  const sum = new Map<string, number>();
  for (const r of rows) for (const [k, n] of r.counts) sum.set(k, (sum.get(k) ?? 0) + n);
  return sum;
}

/**
 * The first and last step of a session, any device: whether a device's logs cover it.
 * A loop, not Math.min(...): a session can hold more steps than a call takes arguments.
 *
 * @example sessionSpan(session) // { start: 1_768_471_201_620_000, end: 1_768_471_230_000_000 }
 */
export function sessionSpan(s: MegolmSession): { readonly start: number; readonly end: number } {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const steps of Object.values(s.stepsByDevice)) {
    for (const x of steps) {
      start = Math.min(start, x.ts);
      end = Math.max(end, x.ts);
    }
  }
  return { start, end };
}

/** Session counts of the two /decryption filters (see filterCounts). */
export interface FilterCounts {
  /** Per outcome key: sessions with an event of that outcome and the analytics value set. */
  readonly byOutcome: ReadonlyMap<string, number>;
  /** Per analytics value: sessions matching it and the outcomes set. */
  readonly byAnalytics: ReadonlyMap<AnalyticsCategory, number>;
  /** Sessions matching the outcomes set, any analytics value. */
  readonly any: number;
}

/**
 * Each filter's counts are the sessions it would show with the other filter as set (see matchesOutcomes).
 *
 * @example filterCounts(rows, null, 'reported').byOutcome.get('utd:missing_key') // 2
 */
export function filterCounts(rows: readonly Pick<SessionRow, 'pairs'>[], outcomes: ReadonlySet<string> | null, analytics: AnalyticsCategory | null): FilterCounts {
  const byOutcome = new Map<string, number>();
  for (const { pairs } of rows) {
    for (const k of new Set(pairs.flatMap(([o, a]) => (!analytics || a === analytics ? [o] : [])))) byOutcome.set(k, (byOutcome.get(k) ?? 0) + 1);
  }
  const count = (a: AnalyticsCategory | null) => rows.filter(({ pairs }) => matchesOutcomes(pairs, outcomes, a)).length;
  return { byOutcome, byAnalytics: new Map(ANALYTICS_CATEGORIES.map((c) => [c, count(c)])), any: count(null) };
}

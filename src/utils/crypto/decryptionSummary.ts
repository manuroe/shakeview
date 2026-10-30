/** Megolm aggregates for one set of loaded logs: the /summary keys and UTDs cards, the /archive UTD column, and the /decryption filters. */
import { formatTimestamp } from '../timeUtils';
import { addTo, buildCryptoModel, deviceFromSteps } from './buildCryptoModel';
import { decisiveFailure } from './classifyUtd';
import type { AnalyticsCategory, CryptoStep, MegolmSession, ResolutionMechanism, UtdEvent, UtdReason } from './types';

/** One UTD event on the /summary UTDs chart, at its first failure. */
export interface UtdPoint {
  readonly ts: number;
  readonly sessionId: string;
  readonly resolved: boolean;
  readonly by?: ResolutionMechanism;
  readonly reason: UtdReason;
  /** µs to resolution, when resolved: to the logged re-decryption, else to the key's arrival. */
  readonly delay?: number;
  /** No re-decryption logged: `delay` is the key's arrival, a lower bound of the decryption. */
  readonly inferred?: boolean;
  readonly analytics: AnalyticsCategory;
}

/** Where a new room key came from; `room_key_late` is the `m.room_key` that resolved a UTD, `outbound` one this device made to send with (Rust `OutboundGroupSession`). */
export type KeySource = 'room_key' | 'room_key_late' | 'forwarded' | 'bundle' | 'backup' | 'outbound';

/** One new room key on the /summary keys chart. A bundle counts once, whatever it holds. */
export interface KeyPoint {
  readonly ts: number;
  readonly source: KeySource;
}

/** One row of the /summary "Still failing" table: a reason class and how widely it fails. */
export interface UtdReasonRow {
  readonly reason: UtdReason;
  readonly utds: number;
  readonly sessions: number;
  readonly reported: number;
}

/** One row of the /summary "Late decryptions" table: a mechanism and how long it took. */
export interface LateDecryptionRow {
  readonly by: ResolutionMechanism;
  readonly count: number;
  readonly sessions: number;
  readonly reported: number;
  readonly medianDelayUs: number;
  /** Some delays are key arrivals with no re-decryption logged: the median is a lower bound. */
  readonly lowerBound: boolean;
}

/** What the /summary card charts: UTD events and new keys, each at its own time. */
export interface DecryptionSummary {
  readonly events: readonly UtdPoint[];
  readonly keys: readonly KeyPoint[];
}

/** Structurally an `ActivityBucket` (src/components/BaseActivityChart.tsx), with the points it holds. */
export interface TimeBucket<P> {
  readonly timestamp: number;
  readonly timeLabel: string;
  readonly total: number;
  readonly points: readonly P[];
}

/**
 * What UTD analytics receive: the metric the team tracks.
 *
 * @example events.filter(isReported).length // UTDs the app reported
 */
export const isReported = (e: UtdPoint) => e.analytics === 'reported';

/**
 * The /decryption filter key of still-failing UTDs of one reason, shared with the /summary links into it.
 *
 * @example utdOutcomeKey('missing_key') // 'utd:missing_key'
 */
export const utdOutcomeKey = (reason: UtdReason) => `utd:${reason}` as const;

/**
 * The /decryption filter key of UTDs decrypted late by one mechanism, shared with the /summary links into it.
 *
 * @example lateOutcomeKey('backup') // 'late:backup'
 */
export const lateOutcomeKey = (by: ResolutionMechanism) => `late:${by}` as const;

/**
 * Points per key, skipping those without one: chart tooltips count points by category.
 *
 * @example countBy([{ by: 'backup' }, { by: 'backup' }, {}], (p) => p.by) // { backup: 2 }
 */
export function countBy<P, K extends string>(points: readonly P[], key: (p: P) => K | undefined): Partial<Record<K, number>> {
  const r: Partial<Record<K, number>> = {};
  for (const p of points) {
    const k = key(p);
    if (k !== undefined) r[k] = (r[k] ?? 0) + 1;
  }
  return r;
}

/**
 * A new outbound session (Rust `OutboundGroupSession`): Rust logs no line when it creates one,
 * so its first share, at message index 0, stands for it. Later shares to new devices come at a higher index.
 */
const isOutboundStart = (s: CryptoStep) => s.kind === 'share.encrypt' && s.keys.messageIndex === 0;

/**
 * The /summary card's data: the loaded logs as one device, UTDs and their resolution from the builder,
 * and every new room key by source.
 *
 * @example
 * const { events, keys } = summarizeDecryption(loadedLogSteps(rawLogLines));
 * events[0]; // { ts, sessionId: 'S', resolved: true, by: 'late_key', reason: 'missing_key', delay: 20_000_000, inferred: true, analytics: 'reported' }
 * keys[0]; // { ts, source: 'room_key_late' }
 */
export function summarizeDecryption(steps: readonly CryptoStep[]): DecryptionSummary {
  const device = deviceFromSteps('loaded', steps);
  const utds = buildCryptoModel([device]).flatMap((s) => s.utds.map((u) => ({ ...u, sessionId: s.sessionId })));
  const events = utds.map((u): UtdPoint => (u.resolution.state === 'resolved'
    ? { ts: u.firstFailedAt, sessionId: u.sessionId, resolved: true, by: u.resolution.by, reason: u.reason, delay: u.resolution.delay, inferred: !u.resolution.confirmed, analytics: u.analytics.category }
    : { ts: u.firstFailedAt, sessionId: u.sessionId, resolved: false, reason: u.reason, analytics: u.analytics.category }));
  // Sessions this device sent are encryption, not decryption.
  // ponytail: backup imports and keys without a to-device type left out, they bring thousands of keys at once.
  const own = new Set(device.steps.flatMap((s) => (s.role === 'sender' && s.keys.sessionId ? [s.keys.sessionId] : [])));
  const lateAt = new Set(utds.flatMap((u) => (u.resolution.state === 'resolved' && u.resolution.by === 'late_key' ? [`${u.sessionId}@${u.resolution.at}`] : [])));
  const outbound = new Set<string>();
  const keys = device.steps.flatMap((s): KeyPoint[] => {
    if (s.kind === 'share.encrypt') {
      const sid = s.keys.sessionId;
      if (!sid || !isOutboundStart(s) || outbound.has(sid)) return [];
      outbound.add(sid);
      return [{ ts: s.ts, source: 'outbound' }];
    }
    if (s.kind === 'bundle.received') return [{ ts: s.ts, source: 'bundle' }];
    if (s.kind === 'backup.download' && s.keys.ok === true) return [{ ts: s.ts, source: 'backup' }];
    if (s.kind !== 'roomkey.received' || !s.keys.sessionId || own.has(s.keys.sessionId)) return [];
    if (s.keys.toDeviceType === 'm.forwarded_room_key') return [{ ts: s.ts, source: 'forwarded' }];
    if (s.keys.toDeviceType !== 'm.room_key') return [];
    return [{ ts: s.ts, source: lateAt.has(`${s.keys.sessionId}@${s.ts}`) ? 'room_key_late' : 'room_key' }];
  });
  return { events, keys };
}

/** Points grouped by a key, in first-seen order. */
function groupBy<P, K>(points: readonly P[], key: (p: P) => K | undefined): Map<K, P[]> {
  const groups = new Map<K, P[]>();
  for (const p of points) {
    const k = key(p);
    if (k !== undefined) addTo(groups, k, p);
  }
  return groups;
}

/**
 * One row per reason class, most UTDs first, with how many sessions they span: the /summary card's left table.
 *
 * @example utdReasonRows(failing) // [{ reason: 'missing_key', utds: 3, sessions: 2, reported: 2 }]
 */
export function utdReasonRows(events: readonly UtdPoint[]): UtdReasonRow[] {
  return [...groupBy(events, (e) => e.reason)]
    .map(([reason, list]) => ({ reason, utds: list.length, sessions: new Set(list.map((e) => e.sessionId)).size, reported: list.filter(isReported).length }))
    .sort((a, b) => b.utds - a.utds);
}

/** The median of sorted values: the mean of the two middle ones for an even count. */
const median = (sorted: readonly number[]) => {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * One row per resolution mechanism, most first, with sessions and median delay: the /summary card's right table.
 *
 * @example lateDecryptionRows(events) // [{ by: 'late_key', count: 2, sessions: 1, reported: 1, medianDelayUs: 30_000_000, lowerBound: false }]
 */
export function lateDecryptionRows(events: readonly UtdPoint[]): LateDecryptionRow[] {
  return [...groupBy(events, (e) => (e.delay !== undefined ? e.by : undefined))]
    .map(([by, list]) => {
      const delays = list.map((e) => e.delay!).sort((a, b) => a - b);
      return { by, count: list.length, sessions: new Set(list.map((e) => e.sessionId)).size, reported: list.filter(isReported).length, medianDelayUs: median(delays), lowerBound: list.some((e) => e.inferred === true) };
    })
    .sort((a, b) => b.count - a.count);
}

const outcomeKey = (u: UtdEvent) => (u.resolution.state === 'resolved' ? lateOutcomeKey(u.resolution.by) : utdOutcomeKey(u.reason));

/** One UTD event's outcome key and whether analytics received it; a session without UTD: its `key_received` / `outbound` keys, no analytics. */
export type EventKeys = readonly [outcome: string, analytics: AnalyticsCategory | undefined];

/**
 * Per UTD event, its outcome key and analytics category: the two /decryption filters must match the same event.
 *
 * @example sessionEventKeys(session) // [['late:late_key', 'not_reported'], ['utd:missing_key', 'reported']]
 */
export function sessionEventKeys(s: MegolmSession): EventKeys[] {
  if (s.utds.length > 0) return s.utds.map((u) => [outcomeKey(u), u.analytics.category] as const);
  return [...sessionOutcomeCounts(s).keys()].map((k) => [k, undefined] as const);
}

/**
 * Some event matches both filters: one of the outcomes and the analytics value (each `null`: any).
 *
 * @example matchesOutcomes([['utd:missing_key', 'reported']], new Set(['utd:missing_key']), 'not_reported') // false
 */
export function matchesOutcomes(pairs: readonly EventKeys[], outcomes: ReadonlySet<string> | null, analytics: AnalyticsCategory | null): boolean {
  return pairs.some(([o, a]) => (!outcomes || outcomes.has(o)) && (!analytics || a === analytics));
}

/**
 * The ids a /decryption search matches, lower-cased, one per line: the session, room, devices, events and
 * to-device messages it names. Not `sessionIds`: an import or backup upload lists thousands of other sessions.
 *
 * @example sessionSearchText(session).includes('$ev1') // true
 */
export function sessionSearchText(s: MegolmSession): string {
  const ids = [s.sessionId, s.roomId, s.senderKey];
  for (const d of [s.sender, ...s.receivers]) ids.push(d.userId, d.deviceId, d.senderKey);
  for (const m of s.deliveries) ids.push(m.messageId, m.userId, m.deviceId);
  for (const { keys: k } of Object.values(s.stepsByDevice).flat()) {
    ids.push(k.roomId, k.eventId, ...(k.eventIds ?? []), k.senderKey, k.userId, k.deviceId, k.messageId, k.requestId, k.transactionId);
    for (const m of k.messages ?? []) ids.push(m.messageId, m.userId, m.deviceId);
    for (const r of k.recipients ?? []) ids.push(...r);
  }
  return ids.filter(Boolean).join('\n').toLowerCase();
}

/**
 * The /decryption filter keys a session matches, with their UTD event counts: `utd:<reason>` per still-failing
 * UTD, `late:<mechanism>` per late decryption; when nothing failed, `key_received` when a key arrived,
 * `outbound` when a loaded device started it (see isOutboundStart), as on the /summary keys chart; those count 1.
 *
 * @example Object.fromEntries(sessionOutcomeCounts(session)) // { 'utd:missing_key': 2 }
 */
export function sessionOutcomeCounts(s: MegolmSession): Map<string, number> {
  const counts = new Map<string, number>();
  for (const u of s.utds) {
    const k = outcomeKey(u);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  if (s.utds.length === 0 && Object.values(s.stepsByDevice).some((steps) => steps.some((x) => x.kind === 'roomkey.received'))) counts.set('key_received', 1);
  if (s.utds.length === 0 && Object.values(s.stepsByDevice).some((steps) => steps.some(isOutboundStart))) counts.set('outbound', 1);
  return counts;
}

/**
 * The event a UTD step failed for, when the model can build it a session (it groups by session id):
 * the UTDs /archive counts are then the ones it can resolve and judge, like /summary's.
 *
 * @example utdEventId(step) // '$ev1', or undefined for another kind or a failure without a session id
 */
export function utdEventId(s: CryptoStep): string | undefined {
  return s.kind === 'event.utd' && s.keys.sessionId ? s.keys.eventId : undefined;
}

/**
 * Distinct failed events (by event id) and their reasons, as the model classes them (see decisiveFailure);
 * cheap, no resolution: /archive counts every file of an archive.
 *
 * @example countUtdEvents(steps) // { count: 2, byReason: { missing_key: 2 } }
 */
export function countUtdEvents(steps: readonly CryptoStep[]): { readonly count: number; readonly byReason: Partial<Record<UtdReason, number>> } {
  const failures = groupBy(steps, utdEventId);
  const byReason = countBy([...failures.values()], (list) => decisiveFailure(list).keys.reason ?? 'other');
  return { count: failures.size, byReason };
}

/**
 * Points in ~100 time buckets, at least 1 s each, the same rule as LogActivityChart: the /summary charts line up.
 *
 * @example bucketByTime(events, minUs, maxUs).buckets[0] // { timestamp, timeLabel: '10:00:00', total: 3, points: [...] }
 */
export function bucketByTime<P extends { readonly ts: number }>(points: readonly P[], minTime: number, maxTime: number): { buckets: TimeBucket<P>[]; maxCount: number } {
  if (minTime === 0 && maxTime === 0) return { buckets: [], maxCount: 0 };
  const bucketSize = Math.max(1_000_000, Math.ceil((maxTime - minTime) / 100));
  const first = Math.floor(minTime / bucketSize) * bucketSize;
  const last = Math.floor(maxTime / bucketSize) * bucketSize;
  const map = new Map<number, { timestamp: number; timeLabel: string; total: number; points: P[] }>();
  for (let t = first; t <= last; t += bucketSize) {
    map.set(t, { timestamp: t, timeLabel: formatTimestamp(t, 'HH:MM:SS'), total: 0, points: [] });
  }
  for (const p of points) {
    if (p.ts < minTime || p.ts > maxTime) continue;
    const b = map.get(Math.floor(p.ts / bucketSize) * bucketSize);
    if (!b) continue;
    b.total += 1;
    b.points.push(p);
  }
  const buckets = [...map.values()];
  return { buckets, maxCount: buckets.reduce((m, b) => Math.max(m, b.total), 0) };
}

/**
 * Counts as one line, for tooltips.
 *
 * @example formatCounts({ a: 1, b: 2 }) // 'a 1 · b 2'
 */
export function formatCounts(r: Readonly<Partial<Record<string, number>>>): string {
  return Object.entries(r).map(([k, v]) => `${k} ${v}`).join(' · ');
}

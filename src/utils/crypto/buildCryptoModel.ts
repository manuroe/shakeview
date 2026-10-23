/**
 * Build megolm sessions across devices: group steps by session id, detect the
 * sending device, join to-device messages sender → receiver, and resolve each
 * UTD (late key, forwarded key, backup, import, history bundle, unknown).
 */
import { decisiveFailure } from './classifyUtd';
import type {
  CryptoDevice, CryptoStep, DeviceRef, MegolmSession, ResolutionMechanism, SenderSource, StepKind,
  ToDeviceLink, UtdAnalytics, UtdEvent, UtdResolution,
} from './types';

interface BuildOptions {
  /** Also build sessions without a UTD (/decryption lists them; summaries only need the failing ones). */
  readonly includeHealthy?: boolean;
  /** sessionId → device id the user set as the sender; always wins over detection. */
  readonly senderOverrides?: Readonly<Record<string, string>>;
}

/** Two failures of one event closer than this are one attempt (Rust + js-sdk lines log the same failure). */
const ATTEMPT_GAP_US = 100_000;
/** Olm steps and history bundles count for a session only this close to its activity. */
const WINDOW_US = 10 * 60 * 1_000_000;
/** UTD analytics drop decryptions faster than this (Element X FFI `IGNORE_UTD_PERIOD`, Web `GRACE_PERIOD_MS`). */
export const ANALYTICS_GRACE_US = 4_000_000;
/** Element Web logs failures from the js-sdk; Element X from the Rust crypto crate. */
const isJsFailure = (s: CryptoStep) => s.text.startsWith('Error decrypting event');

/**
 * Steps with no archive behind them as one device, so the model can be built over them:
 * the /summary card's loaded logs, the /archive files' steps together. `steps` must be
 * in time order, like a device's: both callers already sort them, so no copy is made.
 *
 * @example buildCryptoModel([deviceFromSteps('archive', [...steps].sort(byTs))])
 */
export function deviceFromSteps(id: string, steps: readonly CryptoStep[]): CryptoDevice {
  return { id, entries: [], identity: {}, steps, coverage: [] };
}

const refOf = (d: CryptoDevice): DeviceRef => ({
  key: d.id, loadedId: d.id, userId: d.identity.userId, deviceId: d.identity.deviceId, senderKey: d.identity.curveKey,
});

/** History sharing and room key bundles: per room, not per session; attached to every session of their room. */
const ROOM_KINDS: ReadonlySet<StepKind> = new Set<StepKind>(['bundle.received', 'bundle.missing', 'bundle.rejected', 'history.shared', 'history.uploaded', 'history.not_shared', 'room.joined']);
type RoomIndex = Map<string, Map<string, CryptoStep[]>>;

const sessionIdsOf = (s: CryptoStep): readonly string[] =>
  s.keys.sessionIds ?? (s.keys.sessionId ? [s.keys.sessionId] : []);

/**
 * Steps in time order: the sort every device, session and UTD list relies on.
 *
 * @example [...steps].sort(byTs)
 */
export const byTs = (a: CryptoStep, b: CryptoStep) => a.ts - b.ts;

/**
 * The few steps a session looks up on a device beyond its own, gathered in one
 * pass: thousands of sessions each scanning every step of a 50k-step device cost
 * seconds. Lists stay in step (time) order.
 */
interface DeviceIndex {
  /** event.redecrypted, redecrypt.failed, timeline.handled and utd.reported by event id. */
  readonly byEvent: Map<string, CryptoStep[]>;
  /** The device logs Rust timelines handling events: without it, Element X analytics can't be told. */
  readonly handlesTimeline: boolean;
  /** Olm failures, unwedges and session-less withheld: matched to a session by sender key. */
  readonly keyLevel: readonly CryptoStep[];
  readonly bundles: readonly CryptoStep[];
  /** event.sent by transaction id: links a sender's event to its session's share. */
  readonly sentByTxn: ReadonlyMap<string, readonly CryptoStep[]>;
  /** todevice.http and todevice.sent by request id: links a sender's batch to its request. */
  readonly byRequest: ReadonlyMap<string, readonly CryptoStep[]>;
}

/**
 * Append to the list of `key`, creating it: the one grouping helper of the crypto model and its summaries.
 *
 * @example addTo(byFile, step.line.file, step)
 */
export function addTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function indexDevice(d: CryptoDevice): DeviceIndex {
  const byEvent = new Map<string, CryptoStep[]>();
  const keyLevel: CryptoStep[] = [];
  const bundles: CryptoStep[] = [];
  const sentByTxn = new Map<string, CryptoStep[]>();
  const byRequest = new Map<string, CryptoStep[]>();
  let handlesTimeline = false;
  for (const s of d.steps) {
    if (s.kind === 'timeline.handled') handlesTimeline = true;
    if (s.kind === 'event.redecrypted' || s.kind === 'redecrypt.failed' || s.kind === 'timeline.handled' || s.kind === 'utd.reported') {
      for (const id of s.keys.eventIds ?? (s.keys.eventId ? [s.keys.eventId] : [])) addTo(byEvent, id, s);
    }
    if (s.kind === 'olm.decrypt_failed' || s.kind === 'olm.unwedge' || (s.kind === 'withheld.received' && !s.keys.sessionId)) keyLevel.push(s);
    if (s.kind === 'bundle.received') bundles.push(s);
    if (s.kind === 'event.sent' && s.keys.transactionId) addTo(sentByTxn, s.keys.transactionId, s);
    if ((s.kind === 'todevice.http' || s.kind === 'todevice.sent') && s.keys.requestId) addTo(byRequest, s.keys.requestId, s);
  }
  return { byEvent, handlesTimeline, keyLevel, bundles, sentByTxn, byRequest };
}

/**
 * Every megolm session the devices' steps name, joined across devices: the one
 * model /decryption, /summary and /archive read UTDs, resolutions and deliveries
 * from. In no particular order; views sort for themselves.
 *
 * @example
 * const [session] = buildCryptoModel([sender, receiver]);
 * session.sender.loadedId; // 'alice.tar.gz'
 * session.utds[0].resolution.state; // 'resolved'
 */
export function buildCryptoModel(devices: readonly CryptoDevice[], opts: BuildOptions = {}): MegolmSession[] {
  // sessionId → deviceId → steps naming that session directly
  const direct = new Map<string, Map<string, CryptoStep[]>>();
  for (const d of devices) {
    for (const s of d.steps) {
      for (const sid of sessionIdsOf(s)) {
        let perDevice = direct.get(sid);
        if (!perDevice) direct.set(sid, (perDevice = new Map()));
        addTo(perDevice, d.id, s);
      }
    }
  }
  const hasUtd = (perDevice: Map<string, CryptoStep[]>) =>
    [...perDevice.values()].some((steps) => steps.some((s) => s.kind === 'event.utd'));

  // msgid → the device that received it; one pass, so the per-message join stays O(1) in big rooms.
  const receivedById: ReceivedIndex = new Map();
  for (const d of devices) {
    for (const s of d.steps) if (s.kind === 'todevice.received' && s.keys.messageId) receivedById.set(s.keys.messageId, { deviceId: d.id, step: s });
  }

  // deviceId → roomId → room-level steps; one pass, so attaching them stays O(1) per session.
  const roomSteps: RoomIndex = new Map();
  for (const d of devices) {
    const byRoom = new Map<string, CryptoStep[]>();
    for (const s of d.steps) {
      if (ROOM_KINDS.has(s.kind) && s.keys.roomId) addTo(byRoom, s.keys.roomId, s);
    }
    roomSteps.set(d.id, byRoom);
  }

  const index = new Map(devices.map((d) => [d.id, indexDevice(d)]));
  return [...direct]
    .filter(([, perDevice]) => opts.includeHealthy || hasUtd(perDevice))
    .map(([sid, perDevice]) => buildSession(sid, devices, perDevice, receivedById, roomSteps, index, opts.senderOverrides?.[sid]));
}

/** The sender the user chose, else the device that shared the session, else the one owning its curve key, else an unloaded one named by the key. */
function detectSender(
  devices: readonly CryptoDevice[], perDevice: Map<string, CryptoStep[]>,
  senderKey: string | undefined, eventSender: string | undefined, override: string | undefined,
): { readonly sender: DeviceRef; readonly senderSource: SenderSource } {
  const chosen = override ? devices.find((d) => d.id === override) : undefined;
  if (chosen) return { sender: refOf(chosen), senderSource: 'override' };
  const sharer = devices.find((d) => (perDevice.get(d.id) ?? []).some((s) => s.kind === 'share.encrypt' || s.kind === 'todevice.batch'));
  if (sharer) return { sender: refOf(sharer), senderSource: 'share' };
  const byCurve = senderKey ? devices.find((d) => d.identity.curveKey === senderKey) : undefined;
  if (byCurve) return { sender: refOf(byCurve), senderSource: 'curve_key' };
  return { sender: { key: `curve:${senderKey ?? '?'}`, userId: eventSender, senderKey }, senderSource: 'unknown' };
}

type ReceivedIndex = Map<string, { readonly deviceId: string; readonly step: CryptoStep }>;

function buildSession(
  sessionId: string, devices: readonly CryptoDevice[], perDevice: Map<string, CryptoStep[]>,
  receivedById: ReceivedIndex, roomSteps: RoomIndex, index: Map<string, DeviceIndex>, senderOverride: string | undefined,
): MegolmSession {
  const steps: Record<string, CryptoStep[]> = {};
  for (const d of devices) steps[d.id] = [...(perDevice.get(d.id) ?? [])];
  // A step can be pulled in twice (by session and by event): deduped once, before the sort.
  const push = (deviceId: string, s: CryptoStep) => steps[deviceId].push(s);

  const all = [...perDevice.values()].flat();
  const utdSteps = all.filter((s) => s.kind === 'event.utd');
  const senderKey = (utdSteps.find((s) => s.keys.senderKey)
    ?? all.find((s) => s.kind === 'roomkey.received' && s.keys.toDeviceType === 'm.room_key' && s.keys.senderKey))?.keys.senderKey;
  const roomId = all.find((s) => s.keys.roomId)?.keys.roomId;
  // The receiver's logs name the sender's user (UTD line, m.room_key to-device), never its device.
  const eventSender = (utdSteps.find((s) => s.keys.userId)
    ?? all.find((s) => s.kind === 'roomkey.received' && s.keys.toDeviceType === 'm.room_key' && s.keys.userId))?.keys.userId;
  const { sender, senderSource } = detectSender(devices, perDevice, senderKey, eventSender, senderOverride);
  const senderDev = devices.find((d) => d.id === sender.loadedId);

  // Sender: pull in steps linked by transaction id (event.sent) and request id (http, sent marks).
  const deliveries: ToDeviceLink[] = [];
  if (senderDev) {
    const own = steps[senderDev.id];
    const txns = new Set(own.map((s) => s.keys.transactionId).filter((t): t is string => Boolean(t)));
    const reqs = new Set(own.filter((s) => s.kind === 'todevice.batch').map((s) => s.keys.requestId).filter((r): r is string => Boolean(r)));
    const { sentByTxn, byRequest } = index.get(senderDev.id)!;
    for (const t of txns) for (const s of sentByTxn.get(t) ?? []) push(senderDev.id, s);
    for (const r of reqs) for (const s of byRequest.get(r) ?? []) push(senderDev.id, s);
    for (const batchStep of own.filter((s) => s.kind === 'todevice.batch')) {
      const http = batchStep.keys.requestId ? byRequest.get(batchStep.keys.requestId)?.find((s) => s.kind === 'todevice.http') : undefined;
      for (const m of batchStep.keys.messages ?? []) {
        const hit = receivedById.get(m.messageId);
        const target = devices.find((d) => d.id !== senderDev.id && d.identity.userId === m.userId && d.identity.deviceId === m.deviceId)
          ?? (hit && hit.deviceId !== senderDev.id ? devices.find((d) => d.id === hit.deviceId) : undefined);
        const received = hit && target && hit.deviceId === target.id ? hit.step : undefined;
        if (target && received) push(target.id, received);
        deliveries.push({
          ...m, batch: batchStep, http, receiverId: target?.id, received,
          latency: received ? received.ts - batchStep.ts : undefined,
        });
      }
    }
  }

  // UTD events, per loaded device, plus the steps that explain them.
  const utds: UtdEvent[] = [];
  for (const d of devices) {
    const own = steps[d.id];
    const idx = index.get(d.id)!;
    const failures = own.filter((s) => s.kind === 'event.utd' && s.keys.eventId);
    const byEvent = new Map<string, CryptoStep[]>();
    for (const f of failures) addTo(byEvent, f.keys.eventId!, f);
    for (const [eventId, list] of byEvent) {
      const u = resolveUtd(d.id, sessionId, roomId, eventId, list, perDevice.get(d.id) ?? [], idx);
      utds.push({ ...u, analytics: analyticsOf(u, idx) });
      for (const s of idx.byEvent.get(eventId) ?? []) if (s.kind !== 'redecrypt.failed') push(d.id, s);
    }
    if (senderKey && own.length > 0) {
      let from = Number.POSITIVE_INFINITY;
      let to = Number.NEGATIVE_INFINITY;
      for (const s of own) {
        from = Math.min(from, s.ts - WINDOW_US);
        to = Math.max(to, s.ts + WINDOW_US);
      }
      // A withheld without a session (m.no_olm) covers every session of its sender key.
      for (const s of idx.keyLevel) if (s.keys.senderKey === senderKey && s.ts >= from && s.ts <= to) push(d.id, s);
    }
  }
  for (const id of Object.keys(steps)) steps[id] = [...new Set(steps[id])].sort(byTs);

  const firstActivity = (id: string) => steps[id][0]?.ts ?? Number.MAX_SAFE_INTEGER;
  const loadedReceivers = devices
    .filter((d) => d.id !== sender.loadedId && steps[d.id].length > 0)
    .sort((a, b) => firstActivity(a.id) - firstActivity(b.id))
    .map(refOf);
  const seen = new Map<string, DeviceRef>();
  for (const s of senderDev ? steps[senderDev.id] : []) {
    for (const [userId, deviceId] of s.kind === 'share.encrypt' ? s.keys.recipients ?? [] : []) {
      const isLoaded = devices.some((d) => d.identity.userId === userId && d.identity.deviceId === deviceId);
      const key = `${userId}|${deviceId}`;
      if (!isLoaded && !seen.has(key)) seen.set(key, { key, userId, deviceId });
    }
  }

  // Room-level context last: it must not make a device a receiver of every session of the room.
  if (roomId) {
    for (const d of devices) {
      const extra = roomSteps.get(d.id)?.get(roomId);
      if (extra && (steps[d.id].length > 0 || d.id === sender.loadedId)) {
        steps[d.id].push(...extra);
        steps[d.id].sort(byTs);
      }
    }
  }

  return {
    sessionId, roomId, senderKey, sender, senderSource,
    receivers: [...loadedReceivers, ...seen.values()],
    stepsByDevice: steps, utds, deliveries,
  };
}

function coversSession(s: CryptoStep, sessionId: string): boolean {
  return s.keys.sessionId === sessionId || (s.keys.sessionIds?.includes(sessionId) ?? false);
}

function isUsableKey(s: CryptoStep, sessionId: string, messageIndex: number | undefined): boolean {
  if (!coversSession(s, sessionId)) return false;
  if (s.kind === 'roomkey.received') {
    if (s.keys.toDeviceType === undefined) return false;
    return s.keys.firstKnownIndex === undefined || messageIndex === undefined || s.keys.firstKnownIndex <= messageIndex;
  }
  if (s.kind === 'backup.imported') return true;
  return s.kind === 'backup.download' && s.keys.ok === true;
}

/** `own`: the device's steps naming this session. */
function mechanism(key: CryptoStep, own: readonly CryptoStep[], idx: DeviceIndex, sessionId: string, roomId: string | undefined): ResolutionMechanism {
  if (key.kind === 'roomkey.received') return key.keys.toDeviceType === 'm.forwarded_room_key' ? 'forwarded_key' : 'late_key';
  if (key.kind === 'backup.download') return 'backup';
  if (own.some((s) => s.kind === 'backup.download' && s.keys.sessionId === sessionId && s.ts <= key.ts)) return 'backup';
  // A bundle is per room: it only explains an import for a session of its own room.
  if (roomId && idx.bundles.some((s) => s.keys.roomId === roomId && s.ts <= key.ts && key.ts - s.ts <= WINDOW_US)) return 'history_bundle';
  return 'import';
}

const endOf = (r: UtdResolution) => (r.state === 'resolved' ? r.decryptedAt ?? r.at : undefined);

/**
 * The analytics rules replayed on the logs. Element X: the clock starts when a
 * timeline handles the event while it is UTD (`on_utd`, even when no item is added).
 * Web: at the first failure. Both stop at the decryption. The app's own report wins.
 */
function analyticsOf(u: Omit<UtdEvent, 'analytics'>, idx: DeviceIndex): UtdAnalytics {
  const steps = idx.byEvent.get(u.eventId) ?? [];
  const end = endOf(u.resolution);
  const logged = steps.find((s) => s.kind === 'utd.reported');
  if (logged) return { category: 'reported', logged: logged.line };
  let from = u.firstFailedAt;
  if (!u.steps.some(isJsFailure)) {
    if (!idx.handlesTimeline) return { category: 'unknown', why: 'no timeline logs on this device' };
    const handled = steps.find((s) => s.kind === 'timeline.handled' && s.ts >= u.firstFailedAt);
    if (!handled) return { category: 'not_reported', why: 'never in a timeline' };
    // A stale UTD copy shown after the re-decryption is reported, then dropped under 4 s.
    if (end !== undefined && handled.ts >= end) return { category: 'not_reported', why: 'decrypted before a timeline handled it' };
    from = handled.ts;
  }
  if (end !== undefined && end - from < ANALYTICS_GRACE_US) return { category: 'not_reported', why: `decrypted within ${ANALYTICS_GRACE_US / 1_000_000}s` };
  return { category: 'reported' };
}

/** `own`: the device's steps naming this session, in time order. */
function resolveUtd(
  deviceId: string, sessionId: string, roomId: string | undefined, eventId: string, failures: CryptoStep[], own: readonly CryptoStep[], idx: DeviceIndex,
): Omit<UtdEvent, 'analytics'> {
  const sorted = [...failures].sort(byTs);
  const first = sorted[0];
  const specific = decisiveFailure(sorted);
  const messageIndex = sorted.find((s) => s.keys.messageIndex !== undefined)?.keys.messageIndex;
  let attempts = 0;
  let lastCounted = Number.NEGATIVE_INFINITY;
  for (const s of sorted) {
    if (s.ts - lastCounted > ATTEMPT_GAP_US) {
      attempts += 1;
      lastCounted = s.ts;
    }
  }
  const base = {
    deviceId, eventId, firstFailedAt: first.ts, attempts, messageIndex,
    eventTs: sorted.find((s) => s.keys.eventTs !== undefined)?.keys.eventTs,
    reason: specific.keys.reason ?? 'other', error: specific.keys.error ?? '', steps: sorted,
  };

  const byEvent = idx.byEvent.get(eventId) ?? [];
  const retry = byEvent.find((s) => s.kind === 'event.redecrypted' && s.ts > first.ts);
  // A key logged after the re-decryption came too late to be what decrypted the event.
  const key = own.find((s) => s.ts > first.ts && (!retry || s.ts <= retry.ts) && isUsableKey(s, sessionId, messageIndex));
  const at = key ?? retry;
  if (!at) return { ...base, resolution: { state: 'unresolved' } };

  // The earliest redecrypt failure after the key, named by session or by event.
  const redecryptFailed = [...own, ...byEvent].filter((s) => s.kind === 'redecrypt.failed' && s.ts > at.ts).sort(byTs)[0];
  const laterFailure = sorted.find((s) => s.ts > at.ts) ?? redecryptFailed;
  if (laterFailure && !(retry && retry.ts > laterFailure.ts)) {
    return { ...base, resolution: { state: 'unresolved' }, keyArrivedButFailed: laterFailure.line };
  }

  const decryptedAt = retry && retry.ts >= at.ts ? retry.ts : undefined;
  const resolution: UtdResolution = {
    state: 'resolved',
    by: key ? mechanism(key, own, idx, sessionId, roomId) : 'unknown',
    at: at.ts,
    decryptedAt,
    delay: (decryptedAt ?? at.ts) - first.ts,
    confirmed: decryptedAt !== undefined,
    evidence: retry && retry !== at ? [at.line, retry.line] : [at.line],
  };
  return { ...base, resolution };
}

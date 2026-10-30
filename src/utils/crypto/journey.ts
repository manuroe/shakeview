/**
 * The /decryption session summary: a cautious verdict and the key's journey to the
 * receiver as a checklist, chosen by the UTD reason. ✓ the logs show it, ✗ the logs
 * show it failing, ? the logs cannot tell (each says why). Spine lines always show,
 * as ? when unknown; optional lines (Olm failure, withheld, backup) only when
 * something happened. Lines with a time read in time order around the first failure,
 * those after it with how long after. Every fact comes from the session and its devices' steps: no new log reading.
 */
import { domainOf, formatUs, mechanismLabel, plural, short, utcText } from './format';
import { ANALYTICS_GRACE_US } from './buildCryptoModel';
import { ANALYTICS_CATEGORIES, ANALYTICS_LABEL, REASON_NAME } from './labels';
import type { AnalyticsCategory, CryptoDevice, CryptoStep, LineRef, MegolmSession, UtdEvent } from './types';

/** A checklist mark: ✓ shown, ✗ shown failing, ? can't tell, or a plain note. */
export type JourneyState = 'ok' | 'fail' | 'unknown' | 'note';
/** How the verdict reads: fine, decrypted late, still failing, or no receiver to judge. */
export type JourneyTone = 'good' | 'late' | 'bad' | 'neutral';

/** One checklist line of the key's journey. */
export interface JourneyLine {
  readonly state: JourneyState;
  readonly label: string;
  readonly detail: string;
  /** The log line behind it, on the sender's or the receiver's lane. */
  readonly ref?: LineRef;
  readonly lane?: 'sender' | 'receiver';
  /** When it happened (µs, on its lane's clock); orders the timed lines. */
  readonly ts?: number;
  /** The line the verdict comes from. */
  readonly decisive?: boolean;
}

/** One UTD event of the receiver, listed under the checklist. */
export interface JourneyEvent {
  readonly eventId: string;
  readonly ts: number;
  readonly ok: boolean;
  /** Not reported to analytics: shown muted. */
  readonly muted: boolean;
  readonly text: string;
  readonly ref: LineRef;
}

/** The /decryption session summary: verdict, checklist and events. */
export interface Journey {
  readonly verdict: string;
  /** Which logs the verdict rests on, and what is missing. */
  readonly basis: string;
  readonly tone: JourneyTone;
  readonly lines: readonly JourneyLine[];
  /** The receiver's UTD events, first failure first. */
  readonly events: readonly JourneyEvent[];
}

const clock = (us: number) => utcText(us, 'clock');
/** 3 days · 8 months: how much older an event is than the logs. */
function ago(us: number): string {
  const days = us / 86_400_000_000;
  if (days >= 60) return `${Math.round(days / 30)} months`;
  if (days >= 2) return `${Math.round(days)} days`;
  return formatUs(us);
}
const NOT_LOADED = "sender's rageshake not loaded";
/** A bundle's keys are imported shortly after it arrives. */
const BUNDLE_IMPORT_US = 10 * 60 * 1_000_000;
/** A send is only provably lost when the receiver's logs cover this long after it. */
const DELIVERY_WINDOW_US = 60 * 1_000_000;
/** µs from the key's arrival to the logged re-decryption, when longer than the analytics grace period. */
function applyGap(u: UtdEvent): number | undefined {
  const r = u.resolution;
  if (r.state !== 'resolved' || r.decryptedAt === undefined || r.decryptedAt - r.at < ANALYTICS_GRACE_US) return undefined;
  return r.decryptedAt - r.at;
}

/** How many events the app reported to its UTD analytics; none when no event can be told. */
function analyticsLine(utds: readonly UtdEvent[]): JourneyLine | undefined {
  const n = (c: AnalyticsCategory) => utds.filter((u) => u.analytics.category === c).length;
  if (n('unknown') === utds.length) return undefined;
  const logged = utds.filter((u) => u.analytics.logged).length;
  const parts = ANALYTICS_CATEGORIES.filter((c) => n(c) > 0).map((c) => `${n(c)} ${ANALYTICS_LABEL[c].toLowerCase()}`);
  return {
    state: 'note', label: 'UTD analytics',
    detail: [...parts, ...(logged > 0 ? [`${logged} logged by the app`] : [])].join(' · '),
  };
}

const BACKUP_TEXT: Readonly<Record<string, { readonly state: JourneyState; readonly text: string }>> = {
  enabled: { state: 'ok', text: 'enabled' },
  ['recovery-enabled']: { state: 'ok', text: 'recovery enabled' },
  disabled: { state: 'fail', text: 'disabled' },
  ['recovery-disabled']: { state: 'fail', text: 'recovery disabled' },
  ['recovery-incomplete']: { state: 'fail', text: 'recovery incomplete' },
  none: { state: 'fail', text: 'no backup on the server' },
  untrusted: { state: 'fail', text: 'the backup on the server is not trusted' },
};

/** The device's key backup before the failure: its last state (backup over recovery), or broken when keys fail to decrypt from it. */
function backupLine(device: CryptoDevice, before: number): JourneyLine {
  const label = 'Key backup on this device';
  const broken = device.steps.filter((x) => x.kind === 'backup.broken');
  if (broken.length > 0) {
    return { state: 'fail', label, detail: `broken: ${plural(broken.length, 'key')} failed to decrypt from it (the backup key may not match)`, ref: broken[0].line, lane: 'receiver', ts: broken[0].ts };
  }
  const states = device.steps.filter((x) => x.kind === 'backup.state' && x.ts <= before);
  const last = states.filter((x) => !x.keys.backupState?.startsWith('recovery-')).pop() ?? states.pop();
  if (!last) return { state: 'unknown', label, detail: 'no backup state in the logs' };
  const known = BACKUP_TEXT[last.keys.backupState ?? ''];
  const version = last.keys.backupVersion ? ` (v${last.keys.backupVersion})` : '';
  return {
    state: known?.state ?? 'unknown', label, ref: last.line, lane: 'receiver', ts: last.ts,
    detail: `${known?.text ?? `state ${last.keys.backupState ?? '?'}`}${version} · ${clock(last.ts)}`,
  };
}

/**
 * The verdict on one session for the receiver, and the checklist it rests on: what /decryption shows above the timeline.
 *
 * @example buildJourney(session, alice, bob).verdict // 'Likely lost in delivery: the key was sent but never received'
 */
export function buildJourney(session: MegolmSession, sender: CryptoDevice | undefined, receiver: CryptoDevice | undefined): Journey {
  if (!receiver) {
    const shares = sender ? (session.stepsByDevice[sender.id] ?? []).filter((x) => x.kind === 'share.encrypt') : [];
    const devices = new Set(shares.flatMap((x) => (x.keys.recipients ?? []).map(([u, d]) => `${u}|${d}`)));
    return {
      verdict: 'Sent by this device; no loaded receiver for this session',
      basis: "the sender's logs only; no receiver's rageshake is loaded",
      tone: 'neutral',
      lines: shares.length > 0
        ? [{ state: 'ok', label: 'Shared by this device', detail: `${plural(shares.length, 'share')} to ${plural(devices.size, 'device')}`, ref: shares[0].line, lane: 'sender' }]
        : [],
      events: [],
    };
  }

  const rSteps = session.stepsByDevice[receiver.id] ?? [];
  const sSteps = sender ? session.stepsByDevice[sender.id] ?? [] : [];
  const utds = session.utds.filter((u) => u.deviceId === receiver.id).sort((a, b) => a.firstFailedAt - b.firstFailedAt);
  const open = utds.filter((u) => u.resolution.state === 'unresolved');
  const keys = rSteps.filter((x) => x.kind === 'roomkey.received');
  const lines: JourneyLine[] = [];
  const at = (s: CryptoStep, lane: 'sender' | 'receiver') => ({ ref: s.line, lane, ts: s.ts });
  const basis = sender ? "this device's and the sender's logs" : "this device's logs only; the sender's rageshake is not loaded";

  // No UTD: the key arrived and nothing failed in the loaded logs.
  if (utds.length === 0) {
    if (keys[0]) lines.push({ state: 'ok', label: 'Key received', detail: `${clock(keys[0].ts)} · ${keys[0].keys.toDeviceType ?? 'import'}`, ...at(keys[0], 'receiver') });
    return { verdict: 'Likely fine: key received, no UTD in the loaded logs', basis, tone: 'good', lines, events: [] };
  }

  const reason = (open[0] ?? utds[0]).reason;
  const shares = sSteps.filter((x) => x.kind === 'share.encrypt');
  const { userId, deviceId } = receiver.identity;
  const share = shares.find((x) => (x.keys.recipients ?? []).some(([u, d]) => u === userId && d === deviceId));
  // Re-shares list only the devices new to the session: being absent from them proves
  // nothing unless the session's first share (message index 0) is in the logs.
  const firstShareLogged = shares.some((x) => x.keys.messageIndex === 0);
  const loggedIndexes = shares.flatMap((x) => (x.keys.messageIndex !== undefined ? [x.keys.messageIndex] : []));
  // Left out of every share: the sender's last failure to create an Olm session with this device says why.
  const noOlm = share ? undefined : sender?.steps.filter((x) => x.kind === 'olm.claim' && x.keys.error
    && x.keys.userId === userId && x.keys.deviceId === deviceId && x.ts <= (shares[shares.length - 1]?.ts ?? 0)).pop();
  // A re-sent key that arrived counts; else the latest send speaks for the delivery.
  const toThisDevice = session.deliveries.filter((d) => d.receiverId === receiver.id);
  const delivery = toThisDevice.find((d) => d.received)
    ?? toThisDevice.reduce<typeof toThisDevice[number] | undefined>((a, d) => (!a || d.batch.ts > a.batch.ts ? d : a), undefined);
  // "Never received" only holds when this device logs its to-device events and its logs cover the send.
  const sentAt = delivery?.batch.ts;
  const unprovenLoss = !delivery || delivery.received ? undefined
    : !receiver.steps.some((x) => x.kind === 'todevice.received') ? "no to-device events in this device's logs"
    : !receiver.coverage.some((c) => c.start <= sentAt! && c.end >= sentAt! + DELIVERY_WINDOW_US) ? `this device's logs do not cover the send at ${clock(sentAt!)}`
    : undefined;
  const toDeviceKey = keys.find((x) => x.keys.toDeviceType === 'm.room_key' || x.keys.toDeviceType === 'm.forwarded_room_key');

  // History sharing (room key bundles): room-level steps the builder attached to this session.
  const bundle = rSteps.find((x) => x.kind === 'bundle.received');
  const noBundle = rSteps.find((x) => x.kind === 'bundle.missing');
  const rejected = rSteps.find((x) => x.kind === 'bundle.rejected');
  const inviter = (bundle ?? noBundle)?.keys.userId;
  // The loaded sender speaks for the inviter only when it is the inviter.
  const inviterSteps = sender && inviter && sender.identity.userId === inviter
    ? sSteps.filter((x) => x.kind.startsWith('history.') && (!x.keys.userId || x.keys.userId === userId))
    : undefined;
  const notShared = inviterSteps?.find((x) => x.kind === 'history.not_shared');
  const inBundle = bundle && rSteps.find((x) => x.kind === 'backup.imported' && x.ts >= bundle.ts && x.ts - bundle.ts <= BUNDLE_IMPORT_US);
  const history = { shown: !!(bundle || noBundle || rejected || inviterSteps?.length), notShared, noBundle, rejected, notInBundle: !!bundle && !inBundle };

  // When the event was sent, against when this device joined the room and when its logs start.
  const sent = (open[0] ?? utds[0]).eventTs;
  const join = rSteps.filter((x) => x.kind === 'room.joined' && x.ts <= utds[0].firstFailedAt).pop();
  const sentBeforeJoin = sent !== undefined && join !== undefined && sent < join.ts;
  const logsStart = receiver.coverage.length > 0 ? Math.min(...receiver.coverage.map((c) => c.start)) : undefined;
  const predatesLogs = sent !== undefined && logsStart !== undefined && sent < logsStart;

  const backupState = backupLine(receiver, utds[0].firstFailedAt);

  const facts = {
    history,
    sentBeforeJoin,
    predatesLogs,
    backup: backupState,
    leftOut: shares.length > 0 && !!userId && !!deviceId && !share && (firstShareLogged || !!noOlm),
    noOlm,
    lost: !!delivery && !delivery.received && !unprovenLoss,
    deliveryUnknown: !!unprovenLoss,
    withheld: rSteps.find((x) => x.kind === 'withheld.received'),
    olm: rSteps.filter((x) => x.kind === 'olm.decrypt_failed' && x.keys.senderKey === session.senderKey),
    stillAfterKey: utds.find((u) => u.keyArrivedButFailed),
    // Every loaded device of the session failed, the sender included, with one error.
    payload: !!sender && [session.sender.loadedId, ...session.receivers.map((r) => r.loadedId)]
      .every((id) => !id || session.utds.some((u) => u.deviceId === id))
      && new Set(session.utds.map((u) => u.error)).size === 1,
  };

  const keyReceived: JourneyLine = keys[0]
    ? { state: 'ok', label: 'Key received', detail: `${clock(keys[0].ts)} · ${keys[0].keys.toDeviceType ?? 'import'}`, ...at(keys[0], 'receiver') }
    : { state: 'unknown', label: 'Key received', detail: 'no room key in the loaded logs; it may predate them' };

  if (reason === 'trust_requirement') {
    lines.push(keyReceived);
    const u = open[0] ?? utds[0];
    lines.push({ state: 'fail', label: 'Sender trusted', detail: u.error || REASON_NAME[u.reason], ...at(u.steps[0], 'receiver') });
    lines.push({ state: 'note', label: 'Not a key-distribution problem', detail: 'the decryption settings refused this sender' });
  } else if (reason === 'unknown_index') {
    const u = open[0] ?? utds[0];
    const key = keys.find((x) => x.keys.firstKnownIndex !== undefined);
    lines.push(key
      ? { state: 'ok', label: 'Key received', detail: `${clock(key.ts)} · first index ${key.keys.firstKnownIndex}`, ...at(key, 'receiver') }
      : { state: 'unknown', label: 'Key received', detail: 'no room key in the loaded logs; it may predate them' });
    lines.push({
      state: 'fail', label: 'Key covers this message',
      detail: `message index ${u.messageIndex ?? '?'}${key ? ` is before the key's first index ${key.keys.firstKnownIndex}` : ''}`,
      ...at(u.steps[0], 'receiver'),
    });
  } else if (reason === 'invalid_payload') {
    // A JSON error: the event or its decrypted content is malformed, whatever the key did.
    const u = open[0] ?? utds[0];
    lines.push(keyReceived);
    lines.push({ state: 'fail', label: 'Content parsed', detail: u.error, ...at(u.steps[0], 'receiver') });
    lines.push({ state: 'note', label: 'Not a key-distribution problem', detail: 'the event, or its decrypted content, is not valid JSON' });
    if (facts.payload) lines.push({ state: 'note', label: 'Every loaded device fails the same way', detail: 'points at the payload the sender encrypted, not at key distribution' });
  } else {
    // Missing key and the rest: the key's way from the sender to this device.
    if (!sender) {
      lines.push({ state: 'unknown', label: 'Shared with this device', detail: NOT_LOADED });
    } else if (shares.length === 0) {
      lines.push({ state: 'unknown', label: 'Shared by the sender', detail: "no share in the sender's logs; they may not cover it" });
      lines.push({ state: 'unknown', label: 'This device in the share', detail: "no share in the sender's logs" });
    } else {
      const last = shares[shares.length - 1];
      lines.push({ state: 'ok', label: 'Shared by the sender', detail: `${plural(shares.length, 'share')}, last to ${plural(last.keys.recipients?.length ?? 0, 'device')}`, ...at(shares[0], 'sender') });
      lines.push(share
        ? { state: 'ok', label: 'This device in the share', detail: clock(share.ts), ...at(share, 'sender') }
        : !userId || !deviceId
          ? { state: 'unknown', label: 'This device in the share', detail: "this device's identity is unknown" }
          : noOlm
            ? { state: 'fail', label: 'This device in the share', detail: `no Olm session with this device: ${noOlm.keys.error}`, ...at(noOlm, 'sender') }
            : !firstShareLogged
              ? { state: 'unknown', label: 'This device in the share', detail: `not in the ${plural(shares.length, 'logged share')}; the earliest is at message index ${loggedIndexes.length > 0 ? Math.min(...loggedIndexes) : '?'}, earlier shares are not in the logs`, ...at(shares[0], 'sender') }
              : { state: 'fail', label: 'This device in the share', detail: `not in the recipients of ${plural(shares.length, 'share')}; the SDK does not log why`, ...at(shares[0], 'sender') });
    }
    // The anchor the timed lines are ordered around: the first failure on this device.
    lines.push({ state: 'fail', label: 'Failed to decrypt', detail: `${clock(utds[0].firstFailedAt)} · ${REASON_NAME[utds[0].reason]}`, ...at(utds[0].steps[0], 'receiver') });
    if (delivery?.http) {
      const status = delivery.http.keys.status ?? '?';
      lines.push({ state: status.startsWith('2') ? 'ok' : 'fail', label: 'Accepted by the server', detail: `/sendToDevice ${status}`, ...at(delivery.http, 'sender') });
    }
    if (delivery) {
      const federated = domainOf(sender?.identity.userId) !== undefined && domainOf(sender?.identity.userId) !== domainOf(userId);
      lines.push(delivery.received
        ? { state: 'ok', label: 'Delivered to this device', detail: `${clock(delivery.received.ts)} · ${delivery.latency !== undefined && delivery.latency < 0 ? 'clock skew?' : `after ${formatUs(delivery.latency ?? 0)}`}`, ...at(delivery.received, 'receiver') }
        // A non-event: untimed, so it stays after the send it failed to follow.
        : unprovenLoss
          ? { state: 'unknown', label: 'Delivered to this device', detail: unprovenLoss, ref: delivery.batch.line, lane: 'sender' }
          : { state: 'fail', label: 'Delivered to this device', detail: `never received${federated ? ' · the homeservers differ (federation)' : ''}`, ref: delivery.batch.line, lane: 'sender' });
    } else {
      lines.push(toDeviceKey
        ? { state: 'ok', label: 'Key received over to-device', detail: `${clock(toDeviceKey.ts)} · ${toDeviceKey.keys.toDeviceType}`, ...at(toDeviceKey, 'receiver') }
        : predatesLogs
          ? { state: 'unknown', label: 'Key received over to-device', detail: `the event was sent ${utcText(sent!, 'day')}, ${ago(logsStart! - sent!)} before these logs start` }
          : { state: 'fail', label: 'Key received over to-device', detail: 'none in the loaded logs' });
    }
    if (sentBeforeJoin) {
      lines.push({ state: 'fail', label: 'Sent before you joined the room', detail: `sent ${utcText(sent!, 'dateTime')} · joined ${utcText(join!.ts, 'dateTime')} (inferred)`, ...at(join!, 'receiver') });
    }
    if (history.shown) {
      const uploaded = inviterSteps?.find((x) => x.kind === 'history.uploaded');
      const started = inviterSteps?.find((x) => x.kind === 'history.shared');
      lines.push(!inviterSteps
        ? { state: 'unknown', label: 'History shared by the inviter', detail: `${inviter ?? 'the inviter'}'s rageshake not loaded` }
        : notShared
          ? { state: 'fail', label: 'History shared by the inviter', detail: notShared.keys.error ?? 'not shared', ...at(notShared, 'sender') }
          : uploaded
            ? { state: 'ok', label: 'History shared by the inviter', detail: `key blob uploaded${uploaded.keys.count !== undefined ? ` · ${plural(uploaded.keys.count, 'key')}${uploaded.keys.withheldCount ? `, ${uploaded.keys.withheldCount} withheld` : ''}` : ''}`, ...at(uploaded, 'sender') }
            : started
              ? { state: 'ok', label: 'History shared by the inviter', detail: 'sharing started', ...at(started, 'sender') }
              : { state: 'unknown', label: 'History shared by the inviter', detail: "no history sharing in the inviter's logs" });
      lines.push(bundle
        ? { state: 'ok', label: 'History bundle received', detail: `${clock(bundle.ts)}${inviter ? ` · from ${inviter}` : ''}`, ...at(bundle, 'receiver') }
        : rejected
          ? { state: 'fail', label: 'History bundle received', detail: `rejected: ${rejected.keys.error ?? '?'}`, ...at(rejected, 'receiver') }
          : noBundle
            ? { state: 'fail', label: 'History bundle received', detail: 'no room key bundle from the inviter', ...at(noBundle, 'receiver') }
            : { state: 'unknown', label: 'History bundle received', detail: "not in this device's logs" });
      if (bundle) {
        lines.push(inBundle
          ? { state: 'ok', label: 'This session in the bundle', detail: `imported ${clock(inBundle.ts)}`, ...at(inBundle, 'receiver') }
          : { state: 'fail', label: 'This session in the bundle', detail: "not among the bundle's keys" });
      }
    }
    if (facts.olm.length > 0) lines.push({ state: 'fail', label: "Olm messages from the sender's device", detail: `${plural(facts.olm.length, 'decryption failure')}`, ...at(facts.olm[0], 'receiver') });
    if (facts.withheld) lines.push({ state: 'fail', label: 'Key withheld by the sender', detail: facts.withheld.keys.withheldCode ?? 'no code', ...at(facts.withheld, 'receiver') });
    if (facts.payload) lines.push({ state: 'note', label: 'Every loaded device fails the same way', detail: 'points at the payload the sender encrypted, not at key distribution' });
    lines.push(backupState);
  }

  const backup = rSteps.filter((x) => x.kind === 'backup.download' && x.keys.ok !== undefined).pop();
  if (backup) lines.push({ state: backup.keys.ok ? 'ok' : 'fail', label: backup.keys.ok ? 'Key found in backup' : 'Not in key backup', detail: clock(backup.ts), ...at(backup, 'receiver') });
  if (facts.stillAfterKey?.keyArrivedButFailed) {
    lines.push({ state: 'fail', label: 'A usable key arrived', detail: `but ${short(facts.stillAfterKey.eventId)} still failed afterwards`, ref: facts.stillAfterKey.keyArrivedButFailed, lane: 'receiver' });
  }
  const resolved = utds.filter((u) => u.resolution.state === 'resolved');
  if (resolved.length > 0) {
    // The last event decrypted: when the session read in full.
    const end = (u: UtdEvent) => (u.resolution.state === 'resolved' ? u.resolution.decryptedAt ?? u.resolution.at : 0);
    const r = resolved.reduce((a, b) => (end(b) > end(a) ? b : a)).resolution;
    if (r.state === 'resolved') {
      const confirmed = resolved.every((u) => u.resolution.state === 'resolved' && u.resolution.confirmed);
      lines.push({ state: 'ok', label: 'Decrypted late', detail: `${plural(resolved.length, 'event')} · ${mechanismLabel(r.by)} · ${confirmed ? 'confirmed' : 'inferred'}`, ref: r.evidence[r.evidence.length - 1], lane: 'receiver', ts: r.decryptedAt ?? r.at });
    }
  }
  // Untimed: the state now, so it closes what happened; what the user saw follows.
  if (open.length > 0) lines.push({ state: 'fail', label: 'Still failing', detail: `${plural(open.length, 'event')} · first ${clock(open[0].firstFailedAt)} · ${plural(open[0].attempts, 'attempt')}`, ref: open[0].steps[0].line, lane: 'receiver' });
  const analytics = analyticsLine(utds);
  if (analytics) lines.push(analytics);

  // What the user saw is its own line: the verdict stays about what happened.
  const { verdict, because } = verdictOf(reason, utds, open, sender, facts);
  const marked = lines.map((l) => (l.label === because ? { ...l, decisive: true } : l));
  return { verdict, basis, tone: open.length === 0 ? 'late' : 'bad', lines: inTimeOrder(marked, utds[0].firstFailedAt), events: eventsOf(utds) };
}

/**
 * Timed lines in time order, within the slots timed lines hold; untimed ones (?,
 * notes, states) keep theirs. A line after the first failure says how long after.
 */
function inTimeOrder(lines: readonly JourneyLine[], failedAt: number): JourneyLine[] {
  const timed = lines.filter((l) => l.ts !== undefined).sort((a, b) => a.ts! - b.ts!);
  let next = 0;
  return lines.map((l) => {
    if (l.ts === undefined) return l;
    const t = timed[next++];
    return t.ts! > failedAt ? { ...t, detail: `${t.detail} · +${formatUs(t.ts! - failedAt)}` } : t;
  });
}


/** The verdict, and the label of the journey line it comes from. */
function verdictOf(
  reason: UtdEvent['reason'], utds: readonly UtdEvent[], open: readonly UtdEvent[], sender: CryptoDevice | undefined,
  facts: {
    history: { notShared?: CryptoStep; noBundle?: CryptoStep; rejected?: CryptoStep; notInBundle: boolean };
    sentBeforeJoin: boolean; predatesLogs: boolean; backup: JourneyLine;
    leftOut: boolean; noOlm?: CryptoStep; lost: boolean; deliveryUnknown: boolean; withheld?: CryptoStep; olm: readonly CryptoStep[]; stillAfterKey?: UtdEvent; payload: boolean;
  },
): { verdict: string; because: string } {
  if (open.length === 0) {
    const resolved = utds.flatMap((u) => (u.resolution.state === 'resolved' ? [u.resolution] : []));
    const r = utds[0].resolution;
    const gaps = utds.flatMap((u) => applyGap(u) ?? []);
    const slow = gaps.length > 0 ? `; the key was applied up to ${formatUs(Math.max(...gaps))} after it arrived` : '';
    // No re-decryption logged: an inferred delay is the key's arrival, not when the user saw the event.
    const upTo = (confirmed: boolean) => formatUs(Math.max(...resolved.filter((x) => x.confirmed === confirmed).map((x) => x.delay)));
    const inferred = resolved.filter((x) => !x.confirmed).length;
    const arrived = `the key arrived up to ${upTo(false)} after the failure; when it was applied is not logged`;
    const when = inferred === 0 ? `, after up to ${upTo(true)}${slow}`
      : inferred === resolved.length ? `: ${arrived}`
      : `, after up to ${upTo(true)}${slow}; for ${plural(inferred, 'other event')}, ${arrived}`;
    return {
      verdict: `Decrypted late: ${plural(utds.length, 'event')} by ${r.state === 'resolved' ? mechanismLabel(r.by) : '?'}${when}`,
      because: 'Decrypted late',
    };
  }
  const late = utds.length > open.length ? `; ${utds.length - open.length} of ${utds.length} events decrypted late` : '';
  const history = historyCause(facts.history);
  const [cause, because]: [string, string] =
    reason === 'trust_requirement' ? ["a trust decision: the key is present but the sender's identity is not trusted", 'Sender trusted']
    : reason === 'unknown_index' ? ['an incomplete key: it starts after this message', 'Key covers this message']
    : facts.payload ? ['a bad payload from the sender: every loaded device fails the same way', 'Every loaded device fails the same way']
    : reason === 'invalid_payload' ? ['a malformed event: it did not parse, so the key is not the problem', 'Content parsed']
    : facts.withheld ? [`withheld by the sender (${facts.withheld.keys.withheldCode ?? 'no code'})`, 'Key withheld by the sender']
    : history ? [`${history[0]}${facts.sentBeforeJoin ? ' (sent before you joined)' : ''}`, history[1]]
    : facts.sentBeforeJoin ? ['sent before you joined the room: only history sharing can provide its key', 'Sent before you joined the room']
    : facts.leftOut ? [`this device was left out of the key share${facts.noOlm ? `: no Olm session with it (${facts.noOlm.keys.error})` : ''}`, 'This device in the share']
    : facts.lost ? ['lost in delivery: the key was sent but never received', 'Delivered to this device']
    : facts.stillAfterKey ? ['a decryption problem: a usable key arrived but the event still fails', 'A usable key arrived']
    : facts.olm.length > 0 ? ["an Olm session problem with the sender's device", "Olm messages from the sender's device"]
    : facts.predatesLogs
      ? facts.backup.state !== 'fail'
        ? ['a historical message: its key predates these logs; only key backup or history sharing can provide it', 'Key received over to-device']
        : facts.backup.detail.startsWith('broken')
          ? ['a historical message, and key backup looks broken: its keys fail to decrypt', 'Key backup on this device']
          : [`a historical message, and key backup is unavailable (${facts.backup.detail.split(' · ')[0]})`, 'Key backup on this device']
    : !sender ? ["the key never reached this device; load the sender's rageshake to see why", 'Key received over to-device']
    // A send this device's logs can't confirm or deny: the delivery line is where it stops.
    : ['the key never reached this device', facts.deliveryUnknown ? 'Delivered to this device' : 'Key received over to-device'];
  return { verdict: `Likely ${cause}${late}`, because };
}

/** The history-sharing cause and the line it comes from, if any. */
function historyCause(h: { notShared?: CryptoStep; noBundle?: CryptoStep; rejected?: CryptoStep; notInBundle: boolean }): [string, string] | undefined {
  if (h.notShared) return [`history not shared by the inviter (${h.notShared.keys.error ?? '?'})`, 'History shared by the inviter'];
  if (h.rejected) return [`the history bundle was rejected (${h.rejected.keys.error ?? '?'})`, 'History bundle received'];
  if (h.noBundle) return ['no history bundle from the inviter', 'History bundle received'];
  if (h.notInBundle) return ["this session was not in the inviter's history bundle", 'This session in the bundle'];
  return undefined;
}

/** `analytics: reported (logged) · `, `analytics: not reported (never in a timeline) · `; nothing when unknown. */
function analyticsText(u: UtdEvent): string {
  const a = u.analytics;
  return a.category === 'unknown' ? '' : `analytics: ${ANALYTICS_LABEL[a.category].toLowerCase()}${a.why ? ` (${a.why})` : ''}${a.logged ? ' (logged)' : ''} · `;
}

function eventsOf(utds: readonly UtdEvent[]): JourneyEvent[] {
  return utds.map((u) => ({
    eventId: u.eventId,
    ts: u.firstFailedAt,
    ok: u.resolution.state === 'resolved',
    muted: u.analytics.category === 'not_reported',
    ref: u.steps[0].line,
    text: analyticsText(u) + (u.resolution.state === 'resolved'
      ? `${mechanismLabel(u.resolution.by)} after ${applyGap(u) ? `${formatUs(u.resolution.at - u.firstFailedAt)}, decrypted after ` : ''}${formatUs(u.resolution.delay)} (${u.resolution.confirmed ? 'confirmed' : 'inferred'})`
      : `still failing · ${REASON_NAME[u.reason]}${u.attempts > 1 ? ` · ${u.attempts} attempts` : ''}`),
  }));
}

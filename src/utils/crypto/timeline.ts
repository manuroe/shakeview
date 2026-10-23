/**
 * One /decryption timeline for a session: the sender's and the receiver's steps
 * merged on one time axis, each placed in its lane, with the links between the
 * lanes (to-device batch → received, sent event → UTD), gaps, and folds for
 * Olm steps and long same-lane runs. Each step keeps its own device's clock:
 * a link that goes back in time is flagged as clock skew, not reordered.
 */
import { formatTimestamp } from '../timeUtils';
import { formatUs, plural } from './format';
import type { CryptoDevice, CryptoStep, DeviceRef, MegolmSession, StepKind } from './types';

/** Which column of the timeline a step sits in: the two devices are read side by side. */
export type Lane = 'sender' | 'receiver';

/** The arrow end on a row: `out` leaves it towards the other lane, `in` arrives from it. */
export interface LinkMark {
  readonly dir: 'out' | 'in';
  readonly text: string;
  /** The message never arrived. */
  readonly missing?: boolean;
}

/** One step on the timeline, with its lane, the time since the previous step and its link to the other lane. */
export interface StepRow {
  readonly kind: 'step';
  readonly lane: Lane;
  readonly step: CryptoStep;
  /** µs since the previous step row, any lane; null for the first. */
  readonly deltaUs: number | null;
  readonly link?: LinkMark;
}

/** A timeline row: a step, a long silence, or a fold of steps worth hiding. */
export type TimelineRow =
  | StepRow
  | { readonly kind: 'gap'; readonly us: number }
  | { readonly kind: 'fold'; readonly id: string; readonly lane: Lane; readonly label: string; readonly rows: readonly StepRow[] };

/** A stretch with nothing logged longer than this gets a gap row. */
const GAP_US = 60_000_000;
/** Same-lane runs of plain steps at least this long fold: shorter ones read faster unfolded. */
export const FOLD_MIN = 8;
/** Steps that carry the story: never folded into a plain run. */
const KEY_KINDS: ReadonlySet<StepKind> = new Set<StepKind>([
  'event.utd', 'event.redecrypted', 'redecrypt.failed', 'roomkey.received', 'withheld.received', 'event.sent',
  'bundle.received', 'bundle.missing', 'bundle.rejected', 'history.shared', 'history.uploaded', 'history.not_shared', 'room.joined',
]);

const lag = (us: number) => (us < 0 ? 'clock skew?' : formatUs(us));

/**
 * The /decryption timeline of one session between a sender and a receiver: both devices' steps on one axis.
 *
 * @example buildTimeline(session, 'alice.tar.gz', 'bob.tar.gz')[0] // { kind: 'step', lane: 'sender', step, deltaUs: null, link: { dir: 'out', text: 'received 1.2s' } }
 */
export function buildTimeline(session: MegolmSession, senderId: string | undefined, receiverId: string | undefined): TimelineRow[] {
  const links = new Map<CryptoStep, LinkMark>();
  if (senderId && receiverId) {
    for (const d of session.deliveries) {
      if (d.receiverId !== receiverId || links.has(d.batch)) continue;
      if (d.received && d.latency !== undefined) {
        links.set(d.batch, { dir: 'out', text: `received ${lag(d.latency)}` });
        links.set(d.received, { dir: 'in', text: `batch +${lag(d.latency)}` });
      } else {
        links.set(d.batch, { dir: 'out', text: 'not received', missing: true });
      }
    }
    for (const sent of session.stepsByDevice[senderId] ?? []) {
      const u = sent.kind === 'event.sent' ? session.utds.find((x) => x.deviceId === receiverId && x.eventId === sent.keys.eventId) : undefined;
      if (!u) continue;
      links.set(sent, { dir: 'out', text: `UTD ${lag(u.firstFailedAt - sent.ts)}` });
      links.set(u.steps[0], { dir: 'in', text: `sent +${lag(u.firstFailedAt - sent.ts)}` });
    }
  }

  // A UTD's later attempts fold into its first card.
  const laterAttempts = new Set(session.utds.flatMap((u) => u.steps.slice(1)));
  const lanes: Array<[Lane, string | undefined]> = [['sender', senderId], ['receiver', receiverId]];
  const merged = lanes
    .flatMap(([lane, id]) => (id ? (session.stepsByDevice[id] ?? []).map((step) => ({ lane, step })) : []))
    .filter(({ step }) => !laterAttempts.has(step))
    .sort((a, b) => a.step.ts - b.step.ts);

  const rows: TimelineRow[] = [];
  let run: StepRow[] = [];
  const runClass = (r: StepRow) => (r.step.kind.startsWith('olm.') ? 'olm' : !r.link && !KEY_KINDS.has(r.step.kind) ? 'plain' : null);
  const flush = () => {
    const cls = run[0] && runClass(run[0]);
    if (cls === 'olm' || (cls === 'plain' && run.length >= FOLD_MIN)) {
      const first = run[0].step;
      const last = run[run.length - 1].step;
      rows.push({
        kind: 'fold', id: `${first.line.archive}:${first.line.file}:${first.line.line}`, lane: run[0].lane, rows: run,
        label: cls === 'olm'
          ? plural(run.length, 'Olm step')
          : `${run.length} steps · ${formatTimestamp(first.ts, 'HH:MM:SS')}–${formatTimestamp(last.ts, 'HH:MM:SS')}`,
      });
    } else rows.push(...run);
    run = [];
  };
  let prev: CryptoStep | undefined;
  for (const { lane, step } of merged) {
    if (prev && step.ts - prev.ts > GAP_US) {
      flush();
      rows.push({ kind: 'gap', us: step.ts - prev.ts });
    }
    const row: StepRow = { kind: 'step', lane, step, deltaUs: prev ? step.ts - prev.ts : null, link: links.get(step) };
    if (run[0] && (run[0].lane !== lane || runClass(run[0]) !== runClass(row) || runClass(row) === null)) flush();
    run.push(row);
    prev = step;
  }
  flush();
  return rows;
}

/**
 * The timeline's two devices: the session's sender, and the receiver — the main device, else (it sent
 * the session, or has nothing for it) the first loaded receiver. Other recipients are in shareRecipients.
 *
 * @example sessionLanes(session, [bob, alice], 'bob') // { sender: alice, receiver: bob, receiverRef: { key, loadedId: 'bob', … } }
 */
export function sessionLanes(session: MegolmSession, devices: readonly CryptoDevice[], mainId: string): {
  readonly sender?: CryptoDevice; readonly receiver?: CryptoDevice; readonly receiverRef?: DeviceRef;
} {
  const receiverRef = session.receivers.find((r) => r.loadedId === mainId) ?? session.receivers.find((r) => r.loadedId);
  return {
    sender: devices.find((d) => d.id === session.sender.loadedId),
    receiver: devices.find((d) => d.id === receiverRef?.loadedId),
    receiverRef,
  };
}

/**
 * Who the sender shared the key with, from its shares: each user with their devices, `firstUserId`
 * (the rageshake's own user) first.
 *
 * @example shareRecipients(aliceSteps, '@bob:b.org') // { users: [['@bob:b.org', ['BOBPHONE', 'BOBLAPTOP']], ['@carol:c.org', ['C1']]], deviceCount: 3 }
 */
export function shareRecipients(steps: readonly CryptoStep[], firstUserId: string | undefined): {
  readonly users: readonly (readonly [userId: string, deviceIds: readonly string[]])[]; readonly deviceCount: number;
} {
  const byUser = new Map<string, Set<string>>();
  for (const s of steps) {
    for (const [userId, deviceId] of s.kind === 'share.encrypt' ? s.keys.recipients ?? [] : []) {
      byUser.set(userId, (byUser.get(userId) ?? new Set()).add(deviceId));
    }
  }
  const users = [...byUser]
    .sort(([a], [b]) => Number(b === firstUserId) - Number(a === firstUserId))
    .map(([userId, devices]) => [userId, [...devices]] as const);
  return { users, deviceCount: users.reduce((n, [, d]) => n + d.length, 0) };
}

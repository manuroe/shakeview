import { formatUs, mechanismLabel, plural, short } from './format';
import { REASON_NAME } from './labels';
import type { CryptoStep, LineRef, MegolmSession, StepKind } from './types';

const id = (v: string | undefined) => (v === undefined ? '?' : short(v));

/**
 * One short line per step kind, never the raw log text: SDK wording differs, the timeline should not.
 *
 * @example describeStep(shareStep) // 'share to 3 devices · index 0'
 */
export function describeStep(s: CryptoStep): string {
  const k = s.keys;
  switch (s.kind) {
    case 'session.rotate':
      return 'room key rotated';
    case 'share.encrypt':
      return `share to ${plural(k.recipients?.length ?? 0, 'device')}${k.messageIndex !== undefined ? ` · index ${k.messageIndex}` : ''}`;
    case 'todevice.batch':
      return `to-device batch ${id(k.requestId)} · ${plural(k.messages?.length ?? 0, 'message')} (${k.toDeviceType ?? '?'})`;
    case 'todevice.http':
      return `/sendToDevice ${k.status ?? '?'}`;
    case 'todevice.sent':
      return k.requestId ? `batch ${id(k.requestId)} marked sent` : 'session marked as shared';
    case 'event.sent':
      return `sent ${id(k.eventId)}`;
    case 'backup.upload':
      return `backed up ${plural(k.sessionIds?.length ?? 0, 'key')}`;
    case 'olm.claim':
      return 'one-time keys claim';
    case 'todevice.received':
      return `received to-device ${id(k.messageId)}`;
    case 'olm.decrypt_failed':
      return 'Olm decryption failed';
    case 'olm.unwedge':
      return 'Olm session unwedged';
    case 'roomkey.received':
      return `room key received (${k.toDeviceType ?? 'import'})${k.firstKnownIndex !== undefined ? ` · first index ${k.firstKnownIndex}` : ''}`;
    case 'bundle.received':
      return `room key bundle received${k.userId ? ` from ${k.userId}` : ''}`;
    case 'bundle.missing':
      return `no room key bundle from the inviter${k.userId ? ` ${k.userId}` : ''}`;
    case 'bundle.rejected':
      return `room key bundle rejected: ${k.error ?? '?'}`;
    case 'history.shared':
      return `sharing history with ${k.userId ?? '?'}`;
    case 'history.uploaded':
      return `history key blob uploaded${k.count !== undefined ? ` · ${plural(k.count, 'key')}${k.withheldCount ? `, ${k.withheldCount} withheld` : ''}` : ''}`;
    case 'backup.state':
      return `key backup ${k.backupState ?? '?'}${k.backupVersion ? ` (v${k.backupVersion})` : ''}`;
    case 'backup.broken':
      return 'a key failed to decrypt from backup';
    case 'room.joined':
      return 'joined the room';
    case 'history.not_shared':
      return `history not shared: ${k.error ?? '?'}`;
    case 'withheld.received':
      return `withheld (${k.withheldCode ?? 'no code'})`;
    case 'backup.download':
      return k.ok === true ? 'key found in backup' : k.ok === false ? 'key not in backup' : 'backup lookup';
    case 'backup.imported':
      return `imported ${plural(k.sessionIds?.length ?? 0, 'key')}`;
    case 'keyrequest.served':
      return 'key request answered';
    case 'event.utd':
      return `UTD ${id(k.eventId)} · ${REASON_NAME[k.reason ?? 'other']}`;
    case 'event.redecrypted':
      return `decrypted on retry ${k.eventIds && k.eventIds.length > 1 ? plural(k.eventIds.length, 'event') : id(k.eventId ?? k.eventIds?.[0])}`;
    case 'redecrypt.failed':
      return 'still failing after a key arrived';
    case 'timeline.handled':
      return `timeline handled ${id(k.eventId)}`;
    case 'utd.reported':
      return `analytics: reported ${id(k.eventId)} · ${k.timeToDecryptMs !== undefined && k.timeToDecryptMs >= 0 ? `decrypted after ${formatUs(k.timeToDecryptMs * 1000)}` : 'never decrypted'}`;
  }
}

const FAILURE_KINDS: ReadonlySet<StepKind> = new Set<StepKind>([
  'event.utd', 'redecrypt.failed', 'olm.decrypt_failed', 'withheld.received', 'bundle.missing', 'bundle.rejected', 'history.not_shared',
]);
const SUCCESS_KINDS: ReadonlySet<StepKind> = new Set<StepKind>(['roomkey.received', 'event.redecrypted', 'bundle.received', 'history.uploaded']);

/**
 * How a step reads at a glance, for the timeline card accent: failures bad, keys and successes good, routine steps neither.
 *
 * @example stepTone(st('a', 'backup.download', 1, { ok: false })) // 'bad'
 */
export function stepTone(s: CryptoStep): 'good' | 'bad' | undefined {
  if (FAILURE_KINDS.has(s.kind) || (s.kind === 'backup.download' && s.keys.ok === false)) return 'bad';
  if (SUCCESS_KINDS.has(s.kind) || (s.kind === 'backup.download' && s.keys.ok === true)) return 'good';
  return undefined;
}

/**
 * How a UTD ended, under its first failure step only (retries repeat the event): resolved or not, by what,
 * after how long, and the key step that resolved it, which the card links to.
 *
 * @example utdStepNote(firstUtdStep, session, 'bob') // { text: 'resolved · late key · 10.0s · inferred · 2 attempts', keyStep: { archive, file, line } }
 */
export function utdStepNote(step: CryptoStep, session: MegolmSession, deviceId: string): { readonly text: string; readonly keyStep?: LineRef } | undefined {
  if (step.kind !== 'event.utd') return undefined;
  const utd = session.utds.find((u) => u.deviceId === deviceId && u.eventId === step.keys.eventId);
  if (!utd || utd.steps[0] !== step) return undefined;
  const attempts = utd.attempts > 1 ? ` · ${utd.attempts} attempts` : '';
  const r = utd.resolution;
  if (r.state !== 'resolved') return { text: `unresolved${attempts}` };
  return { text: `resolved · ${mechanismLabel(r.by)} · ${formatUs(r.delay)} · ${r.confirmed ? 'confirmed' : 'inferred'}${attempts}`, keyStep: r.evidence[0] };
}

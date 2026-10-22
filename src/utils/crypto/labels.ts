/** Names shown for crypto values, worded once for /summary, /archive and /decryption. */
import { ANALYTICS_GRACE_US } from './buildCryptoModel';
import type { AnalyticsCategory, DeviceIdentity, ResolutionMechanism, UtdReason } from './types';

/**
 * "user · device", else the device id (its archive name), else "user · unknown device" (a sender
 * seen only by its events), else the ref key: one name for loaded devices and session refs alike.
 *
 * @example deviceLabel({ identity: { userId: '@bob:b.org', deviceId: 'PHONE' } }) // '@bob:b.org · PHONE'
 * @example deviceLabel({ id: 'bob.tar.gz', identity: {} }) // 'bob.tar.gz'
 */
export function deviceLabel(d: {
  readonly identity?: DeviceIdentity; readonly userId?: string; readonly deviceId?: string; readonly id?: string; readonly key?: string;
}): string {
  const userId = d.identity?.userId ?? d.userId;
  const deviceId = d.identity?.deviceId ?? d.deviceId;
  if (userId && deviceId) return `${userId} · ${deviceId}`;
  if (d.id) return d.id;
  return userId ? `${userId} · unknown device` : d.key ?? '?';
}

/** Every UTD reason class, in the order the /decryption outcome filter lists them. */
export const UTD_REASONS: readonly UtdReason[] = ['missing_key', 'unknown_index', 'trust_requirement', 'invalid_payload', 'other'];

/** Every resolution mechanism, in the order the /decryption outcome filter lists them. */
export const RESOLUTION_MECHANISMS: readonly ResolutionMechanism[] = ['late_key', 'forwarded_key', 'backup', 'import', 'history_bundle', 'unknown'];

/** Our reason classes under the Rust SDK's `UnableToDecryptReason` names, which the team searches for. */
export const REASON_NAME: Readonly<Record<UtdReason, string>> = {
  ['missing_key']: 'MissingMegolmSession',
  ['unknown_index']: 'UnknownMegolmMessageIndex',
  ['trust_requirement']: 'SenderIdentityNotTrusted',
  ['invalid_payload']: 'PayloadDeserializationFailure',
  other: 'Unknown',
};

/** The analytics grace period in words: the apps drop UTDs decrypted faster than this. */
// A no-break space: "4 s" never splits over two lines.
const GRACE = `${ANALYTICS_GRACE_US / 1_000_000}\u00a0s`;

/** What "reported" means and how far to trust it, worded once for the /summary popup and the /decryption filter. */
export const REPORTED_MEANING = `A UTD counts as reported when it is still not decrypted ${GRACE} after the app first tried to show it.`;
/** Why the reported counts may differ from the app's own, next to REPORTED_MEANING. */
export const REPORTED_CAVEAT = 'Worked out from the logs with the same rules as Element Web and Element X, so it can differ from what the app '
  + 'actually sent. Element X Android logs its own reports, and those are used as is.';

/** The analytics categories in display order, reported first: the /summary chart stacks, the journey counts and the /decryption filter lists them so. */
export const ANALYTICS_CATEGORIES: readonly AnalyticsCategory[] = ['reported', 'not_reported', 'unknown'];

/** Whether UTD analytics received an event, as the /summary chart and the /decryption filter name it. */
export const ANALYTICS_LABEL: Readonly<Record<AnalyticsCategory, string>> = {
  reported: 'Reported',
  ['not_reported']: 'Not reported',
  unknown: 'Unknown',
};

/** Why an event lands in each analytics category, as a one-line hint next to ANALYTICS_LABEL. */
export const ANALYTICS_HINT: Readonly<Record<AnalyticsCategory, string>> = {
  reported: REPORTED_MEANING,
  ['not_reported']: `decrypted within ${GRACE}, or never in a timeline`,
  unknown: 'no timeline logs on this device',
};

/** The /decryption analytics filter's values: each category with its name and hint. */
export const ANALYTICS_OPTIONS: readonly { readonly key: AnalyticsCategory; readonly label: string; readonly hint: string }[] = ANALYTICS_CATEGORIES
  .map((key) => ({ key, label: ANALYTICS_LABEL[key], hint: ANALYTICS_HINT[key] }));

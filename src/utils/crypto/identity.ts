import type { ListingDetails } from '../../types/listing';
import type { DeviceIdentity } from './types';

const LOGGED_IN_RE = /setLoggedIn: mxid: (\S+) deviceId: (\S+)/;
const CURVE_RE = /curve25519:([A-Za-z0-9+/=]+)/;

/**
 * Who this rageshake's device is: `details.json` first (Element X and Element
 * Web both send `user_id`, `device_id`, `device_keys`); else the last Element Web
 * `setLoggedIn` line, which names user and device but no curve key.
 * Sessions need it to tell a rageshake's own shares from those it received.
 *
 * @example deviceIdentity(null, lines) // { userId: '@bob:d', deviceId: 'VYTOIDPHBO', curveKey: undefined }
 */
export function deviceIdentity(details: ListingDetails | null, lines: readonly { readonly message: string }[]): DeviceIdentity {
  let userId = details?.userId ?? undefined;
  let deviceId = details?.deviceId ?? undefined;
  const curveKey = details?.deviceKeys ? CURVE_RE.exec(details.deviceKeys)?.[1] : undefined;
  if (!userId || !deviceId) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = LOGGED_IN_RE.exec(lines[i].message);
      if (m) {
        userId ??= m[1];
        deviceId ??= m[2];
        break;
      }
    }
  }
  return { userId, deviceId, curveKey };
}

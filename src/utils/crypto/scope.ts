/**
 * Cut built sessions to the selected time window: a session stays when one of its
 * UTDs first failed inside the window, and only those UTDs are kept. Resolution
 * was computed on all the loaded logs, so a key arriving after the window still
 * resolves a UTD inside it. A session without UTD stays when its key arrived
 * inside the window (else its first step): the same times as the /summary chart.
 */
import { sessionTime } from './sessionList';
import type { MegolmSession } from './types';

/**
 * The sessions of the selected time window, so /decryption follows the global time filter.
 *
 * @example scopeSessions(buildCryptoModel(devices, { includeHealthy: true }), range.startUs, range.endUs)
 */
export function scopeSessions(sessions: readonly MegolmSession[], startUs: number, endUs: number): MegolmSession[] {
  const out: MegolmSession[] = [];
  for (const s of sessions) {
    if (s.utds.length === 0) {
      const t = sessionTime(s);
      if (t >= startUs && t <= endUs) out.push(s);
      continue;
    }
    const utds = s.utds.filter((u) => u.firstFailedAt >= startUs && u.firstFailedAt <= endUs);
    if (utds.length === 0) continue;
    out.push({ ...s, utds });
  }
  return out;
}

import type { CryptoDevice, CryptoStep, DeviceIdentity, StepKeys, StepKind } from '../types';

let lineNo = 0;

/** A step on device `device` at `sec` seconds. */
export function st(device: string, kind: StepKind, sec: number, keys: StepKeys = {}): CryptoStep {
  lineNo += 1;
  return { kind, role: 'either', ts: sec * 1_000_000, line: { archive: device, file: 'f.log', line: lineNo }, text: kind, keys };
}

/** A device whose logs cover 0 s → 10 000 s. */
export function dev(id: string, identity: DeviceIdentity, steps: CryptoStep[]): CryptoDevice {
  return {
    id, entries: [], identity,
    steps: [...steps].sort((a, b) => a.ts - b.ts),
    coverage: [{ start: 0, end: 10_000 * 1_000_000 }],
  };
}

export const ALICE = { userId: '@alice:a.org', deviceId: 'ALICEPHONE', curveKey: 'ALICEKEY' };
export const BOB_PHONE = { userId: '@bob:b.org', deviceId: 'BOBPHONE', curveKey: 'BOBKEY' };
export const BOB_LAPTOP = { userId: '@bob:b.org', deviceId: 'BOBLAPTOP', curveKey: 'BOBLAPKEY' };

/** A UTD step for `event` in session S on `device`. */
export const utd = (device: string, sec: number, event = '$ev1', extra: StepKeys = {}) =>
  st(device, 'event.utd', sec, {
    sessionId: 'S', eventId: event, senderKey: 'ALICEKEY', userId: '@alice:a.org', messageIndex: 0,
    reason: 'missing_key', error: "Can't find the room key", ...extra,
  });

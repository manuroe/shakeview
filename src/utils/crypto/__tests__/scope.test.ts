import { describe, it, expect } from 'vitest';
import { buildCryptoModel } from '../buildCryptoModel';
import { scopeSessions } from '../scope';
import { BOB_PHONE, dev, st, utd } from './helpers';

const sec = (s: number) => s * 1_000_000;
const bob = dev('bob', BOB_PHONE, [
  utd('bob', 10),
  utd('bob', 100, '$ev2', { sessionId: 'S2' }),
  st('bob', 'roomkey.received', 300, { sessionId: 'S2', toDeviceType: 'm.room_key' }),
  st('bob', 'roomkey.received', 5, { sessionId: 'OK', toDeviceType: 'm.room_key' }),
]);

describe('scopeSessions', () => {
  it('keeps sessions whose first failure is inside the window', () => {
    expect(scopeSessions(buildCryptoModel([bob]), sec(50), sec(150)).map((s) => s.sessionId)).toEqual(['S2']);
  });
  it('keeps a resolution that happens after the window', () => {
    const [s2] = scopeSessions(buildCryptoModel([bob]), sec(50), sec(150));
    expect(s2.utds[0].resolution).toMatchObject({ state: 'resolved', by: 'late_key' });
  });
  it('narrows a session to its UTDs in the window', () => {
    const two = dev('bob', BOB_PHONE, [
      utd('bob', 10), utd('bob', 100, '$ev2'),
      st('bob', 'roomkey.received', 50, { sessionId: 'S', toDeviceType: 'm.room_key' }),
    ]);
    // $ev1 resolved at 50 s; $ev2 (100 s) fails after the key: unresolved.
    const [inEarly] = scopeSessions(buildCryptoModel([two]), sec(0), sec(60));
    expect(inEarly.utds.map((u) => u.eventId)).toEqual(['$ev1']);
    expect(inEarly.utds[0].resolution.state).toBe('resolved');
  });
  it('keeps a healthy session only when its key arrived inside the window', () => {
    const all = buildCryptoModel([bob], { includeHealthy: true });
    expect(scopeSessions(all, sec(50), sec(150)).map((s) => s.sessionId)).toEqual(['S2']);
    expect(scopeSessions(all, sec(0), sec(60)).map((s) => s.sessionId).sort()).toEqual(['OK', 'S']);
  });
});

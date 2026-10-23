import { describe, it, expect } from 'vitest';
import { buildCryptoModel } from '../buildCryptoModel';
import { matchesOutcomes, sessionEventKeys, sessionOutcomeCounts } from '../decryptionSummary';
import { filterCounts, isUnreported, listSessions, sessionSpan, sessionTime, sumCounts } from '../sessionList';
import { ALICE, BOB_PHONE, dev, st, utd } from './helpers';

const DAY = 24 * 3600;
const model = () => buildCryptoModel([dev('bob', BOB_PHONE, [
  utd('bob', 10, '$a', { sessionId: 'A', roomId: '!r' }),
  utd('bob', 20, '$b', { sessionId: 'B', roomId: '!r' }),
  utd('bob', 30, '$c', { sessionId: 'C', roomId: '!other' }),
  st('bob', 'roomkey.received', DAY + 5, { sessionId: 'OK', roomId: '!r', toDeviceType: 'm.room_key' }),
])], { includeHealthy: true }).map((session) => {
  const counts = sessionOutcomeCounts(session);
  return { session, keys: [...counts.keys()], counts, pairs: sessionEventKeys(session) };
});

describe('listSessions', () => {
  it('sorts newest first, splits by day, folds same room + sender + outcome', () => {
    const days = listSessions(model());
    expect(days.map((d) => d.groups.map((g) => g.map((r) => r.session.sessionId)))).toEqual([[['OK']], [['C'], ['B', 'A']]]);
    expect(days.map((d) => d.day)).toEqual(['1970-01-02', '1970-01-01']);
  });
  it('times a session by its first UTD, else its first step', () => {
    const [ok] = model().filter((e) => e.session.sessionId === 'OK');
    expect(sessionTime(ok.session)).toBe((DAY + 5) * 1_000_000);
  });
});

describe('sessionOutcomeCounts', () => {
  it('counts UTD events per outcome; key received counts one', () => {
    const [s] = buildCryptoModel([dev('bob', BOB_PHONE, [
      utd('bob', 10, '$a', { sessionId: 'A' }), utd('bob', 20, '$b', { sessionId: 'A' }),
      st('bob', 'roomkey.received', 15, { sessionId: 'A', toDeviceType: 'm.room_key', firstKnownIndex: 5 }),
    ])]);
    expect(Object.fromEntries(sessionOutcomeCounts(s))).toEqual({ ['utd:missing_key']: 2 });
    const ok = model().find((e) => e.session.sessionId === 'OK')!;
    expect(Object.fromEntries(sessionOutcomeCounts(ok.session))).toEqual({ ['key_received']: 1 });
  });

  it('a UTD keeps its outcome; whether analytics received it is a second key per event', () => {
    const [s] = buildCryptoModel([dev('bob', BOB_PHONE, [
      utd('bob', 10, '$a'), utd('bob', 10, '$b'), st('bob', 'timeline.handled', 11, { eventId: '$b' }),
      st('bob', 'roomkey.received', 20, { sessionId: 'S', toDeviceType: 'm.room_key' }),
    ])]);
    expect(Object.fromEntries(sessionOutcomeCounts(s))).toEqual({ ['late:late_key']: 2 });
    expect(sessionEventKeys(s)).toEqual([['late:late_key', 'not_reported'], ['late:late_key', 'reported']]);
  });
});

describe('outbound sessions', () => {
  it('a session a loaded device started, nothing failing: `outbound`, listed like a key received', () => {
    const share = st('alice', 'share.encrypt', 1, { sessionId: 'S', messageIndex: 0, recipients: [['@bob:b.org', 'BOBPHONE']] });
    const [s] = buildCryptoModel([dev('alice', ALICE, [share])], { includeHealthy: true });
    expect(Object.fromEntries(sessionOutcomeCounts(s))).toEqual({ outbound: 1 });
    expect(sessionEventKeys(s)).toEqual([['outbound', undefined]]);
  });

  it('not when the logs only show later shares: the session started before them, as on /summary', () => {
    const reshare = st('alice', 'share.encrypt', 1, { sessionId: 'S', messageIndex: 5, recipients: [['@bob:b.org', 'BOBPHONE']] });
    const [s] = buildCryptoModel([dev('alice', ALICE, [reshare])], { includeHealthy: true });
    expect(sessionOutcomeCounts(s).has('outbound')).toBe(false);
  });
});

describe('matchesOutcomes', () => {
  const pairs = [['utd:missing_key', 'not_reported'], ['late:backup', 'reported']] as const;
  it('some event matches both filters', () => {
    expect(matchesOutcomes(pairs, null, null)).toBe(true);
    expect(matchesOutcomes(pairs, new Set(['utd:missing_key']), null)).toBe(true);
    expect(matchesOutcomes(pairs, new Set(['utd:missing_key']), 'not_reported')).toBe(true);
    expect(matchesOutcomes(pairs, new Set(['utd:missing_key']), 'reported')).toBe(false);
    expect(matchesOutcomes(pairs, null, 'reported')).toBe(true);
    expect(matchesOutcomes([['key_received', undefined]], new Set(['key_received']), null)).toBe(true);
    expect(matchesOutcomes([['key_received', undefined]], null, 'reported')).toBe(false);
  });
});

describe('isUnreported', () => {
  it('only when every UTD of the row was not reported', () => {
    expect(isUnreported([['utd:missing_key', 'not_reported'], ['late:backup', 'not_reported']])).toBe(true);
    expect(isUnreported([['utd:missing_key', 'not_reported'], ['late:backup', 'reported']])).toBe(false);
    expect(isUnreported([['key_received', undefined]])).toBe(false);
    expect(isUnreported([])).toBe(false);
  });
});

describe('sumCounts', () => {
  it('sums the rows\' counts per outcome', () => {
    const rows = [{ counts: new Map([['utd:missing_key', 2]]) }, { counts: new Map([['utd:missing_key', 1], ['late:backup', 1]]) }];
    expect(Object.fromEntries(sumCounts(rows))).toEqual({ ['utd:missing_key']: 3, ['late:backup']: 1 });
  });
});

describe('sessionSpan', () => {
  it('first and last step over every device', () => {
    const [s] = buildCryptoModel([
      dev('alice', ALICE, [st('alice', 'share.encrypt', 5, { sessionId: 'S', recipients: [['@bob:b.org', 'BOBPHONE']] })]),
      dev('bob', BOB_PHONE, [utd('bob', 10), utd('bob', 30, '$b')]),
    ]);
    expect(sessionSpan(s)).toEqual({ start: 5_000_000, end: 30_000_000 });
  });
});

describe('filterCounts', () => {
  const rows = [
    { pairs: [['utd:missing_key', 'reported'], ['late:backup', 'not_reported']] as const },
    { pairs: [['utd:missing_key', 'not_reported']] as const },
    { pairs: [['key_received', undefined]] as const },
  ];
  it('each filter counts the sessions it would show with the other as set', () => {
    const all = filterCounts(rows, null, null);
    expect(Object.fromEntries(all.byOutcome)).toEqual({ ['utd:missing_key']: 2, ['late:backup']: 1, ['key_received']: 1 });
    expect(Object.fromEntries(all.byAnalytics)).toEqual({ reported: 1, ['not_reported']: 2, unknown: 0 });
    expect(all.any).toBe(3);
    const reported = filterCounts(rows, new Set(['utd:missing_key']), 'reported');
    expect(Object.fromEntries(reported.byOutcome)).toEqual({ ['utd:missing_key']: 1 });
    expect(Object.fromEntries(reported.byAnalytics)).toEqual({ reported: 1, ['not_reported']: 1, unknown: 0 });
    expect(reported.any).toBe(2);
  });
});

import { describe, it, expect } from 'vitest';
import { parseLogFile } from '../../logParser';
import { extractSteps } from '../steps';
import { buildCryptoModel } from '../buildCryptoModel';
import {
  bucketByTime, countBy, countUtdEvents, formatCounts, lateDecryptionRows, lateOutcomeKey, summarizeDecryption, utdOutcomeKey, utdReasonRows,
} from '../decryptionSummary';
import { RECEIVER_LOG, RECEIVER_LATE_LINES, SENDER_LOG } from './fixtures';
import { BOB_PHONE, dev, st, utd } from './helpers';

const steps = extractSteps(parseLogFile(`${RECEIVER_LOG}\n${RECEIVER_LATE_LINES}`).rawLogLines, { archive: '', file: 'f.log' });

describe('summarizeDecryption', () => {
  it('one point per UTD event, with its session, reason and resolution', () => {
    const { events } = summarizeDecryption(steps);
    expect(new Set(events.map((e) => e.sessionId)).size).toBe(2);
    expect(events.every((e) => e.reason === 'missing_key')).toBe(true);
    expect(events.find((e) => e.resolved)).toMatchObject({ by: 'late_key', delay: 20_000_000 });
    expect(events.filter((e) => !e.resolved)).toHaveLength(1);
  });
  it('keys apart from UTDs: the m.room_key that resolved a UTD is late, others by their source', () => {
    const key = steps.find((x) => x.kind === 'roomkey.received')!;
    const other = { ...key, ts: key.ts + 1, keys: { ...key.keys, sessionId: 'SESS3' } };
    const forwarded = { ...key, ts: key.ts + 2, keys: { ...key.keys, sessionId: 'SESS4', toDeviceType: 'm.forwarded_room_key' } };
    const imported = { ...key, ts: key.ts + 3, keys: { ...key.keys, sessionId: 'SESS5', toDeviceType: undefined } };
    const backup = { ...key, ts: key.ts + 4, kind: 'backup.download' as const, keys: { sessionId: 'SESS6', ok: true } };
    const lookup = { ...backup, ts: key.ts + 5, keys: { sessionId: 'SESS7', ok: false } };
    const bundle = { ...key, ts: key.ts + 6, kind: 'bundle.received' as const, keys: { roomId: '!r:a.org' } };
    const s = summarizeDecryption([...steps, other, forwarded, imported, backup, lookup, bundle]);
    expect(s.keys.map((k) => k.source)).toEqual(['room_key_late', 'room_key', 'forwarded', 'backup', 'bundle']);
  });
  it('counts an outbound session this device created once, at its first share at message index 0', () => {
    const sent = extractSteps(parseLogFile(SENDER_LOG).rawLogLines, { archive: '', file: 'f.log' });
    const share = sent.find((x) => x.kind === 'share.encrypt')!;
    const again = { ...share, ts: share.ts + 1 };
    const older = { ...share, ts: share.ts + 2, keys: { ...share.keys, sessionId: 'OLD', messageIndex: 5 } };
    expect(summarizeDecryption([...sent, again, older]).keys).toEqual([{ ts: share.ts, source: 'outbound' }]);
  });
  it('does not count a key for a session this device sent', () => {
    const key = steps.find((x) => x.kind === 'roomkey.received')!;
    const mine = { ...key, keys: { ...key.keys, sessionId: 'MINE' } };
    expect(summarizeDecryption([mine]).keys).toHaveLength(1);
    expect(summarizeDecryption([mine, { ...mine, kind: 'share.encrypt', role: 'sender' }]).keys).toEqual([]);
  });
  it('carries how analytics count each UTD', () => {
    expect(summarizeDecryption(steps).events.map((e) => e.analytics)).toEqual(['unknown', 'unknown']);
  });
  it('is empty without steps', () => {
    expect(summarizeDecryption([])).toEqual({ events: [], keys: [] });
  });
});

describe('countUtdEvents', () => {
  it('counts distinct events, not lines', () => {
    const dup = [...steps, ...steps.filter((x) => x.kind === 'event.utd')];
    expect(countUtdEvents(dup)).toEqual({ count: 2, byReason: { ['missing_key']: 2 } });
  });
  it('classes an event by its latest specific failure, as the model does', () => {
    const payload = { reason: 'invalid_payload', error: 'EOF while parsing' } as const;
    const failures = [utd('bob', 10), utd('bob', 20, '$ev1', payload), utd('bob', 30, '$ev1', { reason: 'other', error: '?' })];
    expect(countUtdEvents(failures).byReason).toEqual({ ['invalid_payload']: 1 });
    expect(buildCryptoModel([dev('bob', BOB_PHONE, failures)])[0].utds[0].reason).toBe('invalid_payload');
  });
  it('skips failures without a session id: the model can never resolve or judge them', () => {
    const sessionless = st('bob', 'event.utd', 11, { eventId: '$x', error: 'x', reason: 'other' });
    expect(countUtdEvents([utd('bob', 10), sessionless])).toEqual({ count: 1, byReason: { ['missing_key']: 1 } });
  });
});

describe('outcome keys and countBy', () => {
  it('builds the /decryption filter keys', () => {
    expect([utdOutcomeKey('missing_key'), lateOutcomeKey('backup')]).toEqual(['utd:missing_key', 'late:backup']);
  });
  it('counts points per key, skipping those without one', () => {
    expect(countBy([{ by: 'a' }, { by: 'a' }, {}], (p: { by?: string }) => p.by)).toEqual({ a: 2 });
  });
});

describe('bucketByTime', () => {
  it('puts each point in its time bucket', () => {
    const { buckets, maxCount } = bucketByTime([{ ts: 1_000_000 }, { ts: 1_500_000 }, { ts: 1_600_000 }, { ts: 900_000_000 }], 0, 1_000_000_000);
    expect(buckets.length).toBeGreaterThan(1);
    expect(buckets[0]).toMatchObject({ total: 3, points: [{ ts: 1_000_000 }, { ts: 1_500_000 }, { ts: 1_600_000 }] });
    expect(maxCount).toBe(3);
  });
  it('drops points outside the range and handles an empty range', () => {
    expect(bucketByTime([{ ts: 5 }], 10, 20).buckets.every((b) => b.total === 0)).toBe(true);
    expect(bucketByTime([], 0, 0)).toEqual({ buckets: [], maxCount: 0 });
  });
});

describe('formatCounts', () => {
  it('joins entries', () => {
    expect(formatCounts({ ['missing_key']: 40, ['unknown_index']: 2 })).toBe('missing_key 40 · unknown_index 2');
  });
});

const pt = { analytics: 'not_reported' } as const;

describe('utdReasonRows', () => {
  it('one row per reason, most UTDs first, with the sessions they span and how many analytics received', () => {
    expect(utdReasonRows([
      { ts: 1, sessionId: 'A', resolved: false, reason: 'missing_key', ...pt, analytics: 'reported' },
      { ts: 2, sessionId: 'A', resolved: false, reason: 'missing_key', ...pt },
      { ts: 3, sessionId: 'B', resolved: false, reason: 'missing_key', ...pt, analytics: 'reported' },
      { ts: 4, sessionId: 'C', resolved: false, reason: 'unknown_index', ...pt, analytics: 'unknown' },
    ])).toEqual([
      { reason: 'missing_key', utds: 3, sessions: 2, reported: 2 },
      { reason: 'unknown_index', utds: 1, sessions: 1, reported: 0 },
    ]);
  });
});

describe('lateDecryptionRows', () => {
  it('one row per mechanism of the resolved UTDs, most first, with sessions and median delay', () => {
    expect(lateDecryptionRows([
      { ts: 1, sessionId: 'A', resolved: true, by: 'backup', reason: 'missing_key', delay: 5, ...pt },
      { ts: 2, sessionId: 'B', resolved: true, by: 'late_key', reason: 'missing_key', delay: 30, ...pt, analytics: 'reported' },
      { ts: 3, sessionId: 'B', resolved: true, by: 'late_key', reason: 'unknown_index', delay: 10, ...pt },
      { ts: 4, sessionId: 'C', resolved: false, reason: 'missing_key', ...pt },
    ])).toEqual([
      // An even count: the mean of the two middle delays, [10, 30] → 20.
      { by: 'late_key', count: 2, sessions: 1, reported: 1, medianDelayUs: 20 },
      { by: 'backup', count: 1, sessions: 1, reported: 0, medianDelayUs: 5 },
    ]);
  });
});

import { describe, it, expect } from 'vitest';
import { buildCryptoModel } from '../buildCryptoModel';
import { buildJourney, type Journey } from '../journey';
import { ALICE, BOB_PHONE, dev, st, utd } from './helpers';

type Steps = ReturnType<typeof st>[];
const msg = { messageId: 'm1', userId: '@bob:b.org', deviceId: 'BOBPHONE' };
const aliceShares = (recipients: [string, string][] = [['@bob:b.org', 'BOBPHONE']]): Steps => [
  st('alice', 'share.encrypt', 10, { sessionId: 'S', transactionId: 'T1', recipients }),
  st('alice', 'todevice.batch', 11, { sessionId: 'S', requestId: 'req1', messages: [msg] }),
  st('alice', 'todevice.http', 12, { requestId: 'req1', status: '200' }),
];
function journey(bob: Steps, alice?: Steps): Journey {
  const devices = [dev('bob', BOB_PHONE, bob), ...(alice ? [dev('alice', ALICE, alice)] : [])];
  const s = buildCryptoModel(devices, { includeHealthy: true }).find((x) => x.sessionId === 'S')!;
  return buildJourney(s, devices.find((d) => d.id === s.sender.loadedId), devices.find((d) => d.id === 'bob'));
}
const shape = (j: Journey) => j.lines.map((l) => `${l.state} ${l.label}`);

describe('buildJourney', () => {
  it('receiver only, missing key: ? for what only the sender knows, a cautious verdict', () => {
    const j = journey([utd('bob', 20), utd('bob', 25)]);
    expect(shape(j)).toEqual([
      'unknown Shared with this device', 'fail Failed to decrypt',
      'fail Key received over to-device', 'unknown Key backup on this device', 'fail Still failing',
    ]);
    expect(j.lines[1].detail).toBe('00:00:20.000 · MissingMegolmSession');
    expect(j.verdict).toBe("Likely the key never reached this device; load the sender's rageshake to see why");
    expect(j.tone).toBe('bad');
  });

  it('says what it is based on, and marks the line its verdict comes from', () => {
    const alone = journey([utd('bob', 20)]);
    expect(alone.basis).toBe("this device's logs only; the sender's rageshake is not loaded");
    expect(alone.lines.filter((l) => l.decisive).map((l) => l.label)).toEqual(['Key received over to-device']);
    const pair = journey([utd('bob', 20)], aliceShares());
    expect(pair.basis).toBe("this device's and the sender's logs");
    expect(pair.lines.filter((l) => l.decisive).map((l) => l.label)).toEqual(['Delivered to this device']);
    const trust = journey([utd('bob', 20, '$ev1', { reason: 'trust_requirement', error: 'x' })]);
    expect(trust.lines.filter((l) => l.decisive).map((l) => l.label)).toEqual(['Sender trusted']);
    const late = journey([utd('bob', 20), st('bob', 'roomkey.received', 40, { sessionId: 'S', toDeviceType: 'm.room_key' })]);
    expect(late.lines.filter((l) => l.decisive).map((l) => l.label)).toEqual(['Decrypted late']);
  });

  it('timed lines in time order around the failure, those after it with how long after', () => {
    const j = journey([
      st('bob', 'backup.state', 14, { backupState: 'enabled' }),
      utd('bob', 15),
      st('bob', 'backup.download', 15.25, { sessionId: 'S', ok: true }),
      st('bob', 'roomkey.received', 16, { sessionId: 'S', toDeviceType: 'm.room_key', firstKnownIndex: 0 }),
    ]);
    expect(shape(j)).toEqual([
      'unknown Shared with this device', 'ok Key backup on this device', 'fail Failed to decrypt',
      'ok Key found in backup', 'ok Decrypted late', 'ok Key received over to-device',
    ]);
    expect(j.lines.slice(1).map((l) => l.detail)).toEqual([
      'enabled · 00:00:14.000', '00:00:15.000 · MissingMegolmSession', '00:00:15.250 · +250ms',
      '1 event · key backup · inferred · +250ms', '00:00:16.000 · m.room_key · +1.0s',
    ]);
    expect(j.verdict).toBe('Decrypted late: 1 event by key backup, after up to 250ms');
  });

  it('sender loaded, key sent but never received: lost in delivery', () => {
    const j = journey([utd('bob', 20)], aliceShares());
    expect(shape(j)).toEqual([
      'ok Shared by the sender', 'ok This device in the share', 'ok Accepted by the server', 'fail Failed to decrypt',
      'fail Delivered to this device', 'unknown Key backup on this device', 'fail Still failing',
    ]);
    expect(j.verdict).toBe('Likely lost in delivery: the key was sent but never received');
    expect(j.events.map((e) => e.eventId)).toEqual(['$ev1']);
  });

  it('sender loaded, receiver left out of the share', () => {
    const j = journey([utd('bob', 20)], aliceShares([['@bob:b.org', 'OTHER']]));
    expect(j.lines.find((l) => l.label === 'This device in the share')?.state).toBe('fail');
    expect(j.verdict).toBe('Likely this device was left out of the key share');
  });

  it('sender loaded, receiver left out because the sender could not create an Olm session with it', () => {
    const j = journey([utd('bob', 20)], [
      st('alice', 'olm.claim', 8, { userId: '@bob:b.org', deviceId: 'BOBPHONE', error: 'InvalidSignature' }),
      ...aliceShares([['@bob:b.org', 'OTHER']]),
    ]);
    expect(j.lines.find((l) => l.label === 'This device in the share'))
      .toMatchObject({ state: 'fail', detail: 'no Olm session with this device: InvalidSignature', lane: 'sender' });
    expect(j.verdict).toBe('Likely this device was left out of the key share: no Olm session with it (InvalidSignature)');
  });

  it('withheld for lack of an Olm session (m.no_olm): a session-less withheld from the sender key', () => {
    const j = journey([st('bob', 'withheld.received', 15, { senderKey: 'ALICEKEY', withheldCode: 'NoOlm' }), utd('bob', 20)]);
    expect(j.lines.find((l) => l.label === 'Key withheld by the sender')).toMatchObject({ state: 'fail', detail: 'NoOlm' });
    expect(j.verdict).toBe('Likely withheld by the sender (NoOlm)');
  });

  it('invalid payload: the content did not parse, not a key-distribution problem, even without the sender', () => {
    const j = journey([utd('bob', 20, '$ev1', { reason: 'invalid_payload', error: 'unexpected end of hex escape at line 1 column 114' })]);
    expect(shape(j)).toEqual(['unknown Key received', 'fail Content parsed', 'note Not a key-distribution problem', 'fail Still failing']);
    expect(j.lines[1].detail).toBe('unexpected end of hex escape at line 1 column 114');
    expect(j.verdict).toBe('Likely a malformed event: it did not parse, so the key is not the problem');
  });

  it('late decryption: every UTD resolved, with its mechanism, and a per-event list', () => {
    const j = journey([utd('bob', 20), utd('bob', 22, '$ev2'), st('bob', 'roomkey.received', 40, { sessionId: 'S', toDeviceType: 'm.room_key', firstKnownIndex: 0 })]);
    expect(j.tone).toBe('late');
    expect(j.verdict).toBe('Decrypted late: 2 events by late key, after up to 20.0s');
    expect(shape(j)).toContain('ok Decrypted late');
    expect(j.events.map((e) => [e.eventId, e.ok, e.text])).toEqual([
      ['$ev1', true, 'late key after 20.0s (inferred)'], ['$ev2', true, 'late key after 18.0s (inferred)'],
    ]);
  });

  it('late decryption long after the key: the client applied it late', () => {
    const j = journey([
      utd('bob', 10),
      st('bob', 'roomkey.received', 10.5, { sessionId: 'S', toDeviceType: 'm.room_key' }),
      st('bob', 'event.redecrypted', 36.4, { eventIds: ['$ev1'] }),
    ]);
    expect(j.verdict).toBe('Decrypted late: 1 event by late key, after up to 26.4s; the key was applied up to 25.9s after it arrived');
    expect(j.lines.filter((l) => l.ts !== undefined && l.ts > 10_000_000).map((l) => `${l.label} ${l.detail}`)).toEqual([
      'Key received over to-device 00:00:10.500 · m.room_key · +500ms', 'Decrypted late 1 event · late key · confirmed · +26.4s',
    ]);
    expect(j.events.map((e) => e.text)).toEqual(['late key after 500ms, decrypted after 26.4s (confirmed)']);
  });

  it('analytics: each event says whether analytics received it, and a line sums them; not reported is muted', () => {
    const j = journey([
      utd('bob', 10), utd('bob', 10, '$ev2'), utd('bob', 10, '$ev3'),
      st('bob', 'timeline.handled', 15, { eventId: '$ev1' }), st('bob', 'timeline.handled', 15, { eventId: '$ev2' }),
      st('bob', 'roomkey.received', 10.5, { sessionId: 'S', toDeviceType: 'm.room_key' }),
      st('bob', 'event.redecrypted', 36, { eventIds: ['$ev1', '$ev3'] }), st('bob', 'event.redecrypted', 16, { eventIds: ['$ev2'] }),
      st('bob', 'utd.reported', 36.1, { eventId: '$ev1', timeToDecryptMs: 21112 }),
    ]);
    expect(j.lines.find((l) => l.label === 'UTD analytics')).toMatchObject({ state: 'note', detail: '1 reported · 2 not reported · 1 logged by the app' });
    expect(j.events.map((e) => [e.eventId, e.text.split(' · ')[0], e.muted])).toEqual([
      ['$ev1', 'analytics: reported (logged)', false],
      ['$ev2', 'analytics: not reported (decrypted within 4s)', true],
      ['$ev3', 'analytics: not reported (never in a timeline)', true],
    ]);
  });

  it('analytics: unreported failures keep the late verdict; it is about what happened', () => {
    const j = journey([
      utd('bob', 10), st('bob', 'timeline.handled', 15, { eventId: '$ev1' }),
      st('bob', 'roomkey.received', 10.5, { sessionId: 'S', toDeviceType: 'm.room_key' }), st('bob', 'event.redecrypted', 16, { eventIds: ['$ev1'] }),
    ]);
    expect(j.verdict).toBe('Decrypted late: 1 event by late key, after up to 6.0s; the key was applied up to 5.5s after it arrived');
    expect(j.tone).toBe('late');
    expect(j.lines.find((l) => l.label === 'UTD analytics')).toMatchObject({ state: 'note', detail: '1 not reported' });
  });

  it('trust requirement: the key is fine, the sender is not trusted', () => {
    const j = journey([
      st('bob', 'roomkey.received', 5, { sessionId: 'S', toDeviceType: 'm.room_key', firstKnownIndex: 0 }),
      utd('bob', 20, '$ev1', { reason: 'trust_requirement', error: 'does not meet the trust requirement' }),
    ]);
    expect(shape(j)).toEqual(['ok Key received', 'fail Sender trusted', 'note Not a key-distribution problem', 'fail Still failing']);
    expect(j.verdict).toMatch(/^Likely a trust decision/);
  });

  it("unknown index: the key starts after the event's index", () => {
    const j = journey([
      st('bob', 'roomkey.received', 5, { sessionId: 'S', toDeviceType: 'm.forwarded_room_key', firstKnownIndex: 4 }),
      utd('bob', 20, '$ev1', { reason: 'unknown_index', messageIndex: 2 }),
    ]);
    expect(j.lines[1]).toMatchObject({ state: 'fail', detail: "message index 2 is before the key's first index 4" });
    expect(j.verdict).toMatch(/^Likely an incomplete key/);
  });

  it('history sharing: no bundle from the inviter', () => {
    const j = journey([
      st('bob', 'bundle.missing', 5, { roomId: '!r', userId: '@alice:a.org' }),
      utd('bob', 20, '$ev1', { roomId: '!r' }),
    ]);
    expect(shape(j)).toEqual(expect.arrayContaining(['unknown History shared by the inviter', 'fail History bundle received']));
    expect(j.verdict).toBe('Likely no history bundle from the inviter');
  });

  it('history sharing: a bundle without this session, and one with it', () => {
    const without = journey([
      st('bob', 'bundle.received', 5, { roomId: '!r', userId: '@alice:a.org' }),
      st('bob', 'backup.imported', 6, { sessionIds: ['OTHER'] }),
      utd('bob', 20, '$ev1', { roomId: '!r' }),
    ]);
    expect(without.lines.find((l) => l.label === 'This session in the bundle')?.state).toBe('fail');
    expect(without.verdict).toBe("Likely this session was not in the inviter's history bundle");
    const withIt = journey([
      st('bob', 'bundle.received', 5, { roomId: '!r', userId: '@alice:a.org' }),
      st('bob', 'backup.imported', 30, { sessionIds: ['S'] }),
      utd('bob', 20, '$ev1', { roomId: '!r' }),
    ]);
    expect(withIt.lines.find((l) => l.label === 'This session in the bundle')?.state).toBe('ok');
    expect(withIt.tone).toBe('late');
  });

  it('history sharing: the loaded sender is the inviter and did not share', () => {
    const j = journey(
      [st('bob', 'bundle.missing', 5, { roomId: '!r', userId: '@alice:a.org' }), utd('bob', 20, '$ev1', { roomId: '!r' })],
      [st('alice', 'history.not_shared', 4, { roomId: '!r', userId: '@bob:b.org', error: 'cross-signing is not set up' }), ...aliceShares([['@bob:b.org', 'OTHER']])],
    );
    expect(j.lines.find((l) => l.label === 'History shared by the inviter')).toMatchObject({ state: 'fail', detail: 'cross-signing is not set up', lane: 'sender' });
    expect(j.verdict).toBe('Likely history not shared by the inviter (cross-signing is not set up)');
  });

  it('sent before you joined the room (inferred from a logged join)', () => {
    const j = journey([
      st('bob', 'room.joined', 15, { roomId: '!r' }),
      utd('bob', 20, '$ev1', { roomId: '!r', eventTs: 10_000_000 }),
    ]);
    expect(j.lines.find((l) => l.label === 'Sent before you joined the room')).toMatchObject({ state: 'fail', detail: 'sent 1970-01-01 00:00:10 · joined 1970-01-01 00:00:15 (inferred)' });
    expect(j.verdict).toBe('Likely sent before you joined the room: only history sharing can provide its key');
    const withHistory = journey([
      st('bob', 'room.joined', 15, { roomId: '!r' }), st('bob', 'bundle.missing', 16, { roomId: '!r', userId: '@alice:a.org' }),
      utd('bob', 20, '$ev1', { roomId: '!r', eventTs: 10_000_000 }),
    ]);
    expect(withHistory.verdict).toBe('Likely no history bundle from the inviter (sent before you joined)');
  });

  it('an event older than the logs: ? for the to-device key, a historical verdict', () => {
    const late = { ...dev('bob', BOB_PHONE, [utd('bob', 9_000_000, '$ev1', { eventTs: 1_000_000 })]), coverage: [{ start: 8_000_000 * 1_000_000, end: 9_500_000 * 1_000_000 }] };
    const [s] = buildCryptoModel([late]);
    const j = buildJourney(s, undefined, late);
    expect(j.lines.find((l) => l.label === 'Key received over to-device')).toMatchObject({ state: 'unknown', detail: 'the event was sent 1970-01-01, 3 months before these logs start' });
    // Even without the sender: its rageshake would hardly reach back months either.
    expect(j.verdict).toBe('Likely a historical message: its key predates these logs; only key backup or history sharing can provide it');
  });

  it('key backup on this device: last state before the failure, broken when keys fail to decrypt from it', () => {
    const line = (bob: Steps) => journey(bob).lines.find((l) => l.label === 'Key backup on this device');
    expect(line([st('bob', 'backup.state', 5, { backupState: 'enabled', backupVersion: '4' }), utd('bob', 20)])).toMatchObject({ state: 'ok', detail: 'enabled (v4) · 00:00:05.000' });
    expect(line([st('bob', 'backup.state', 5, { backupState: 'recovery-enabled' }), st('bob', 'backup.state', 6, { backupState: 'none' }), utd('bob', 20)]))
      .toMatchObject({ state: 'fail', detail: 'no backup on the server · 00:00:06.000' });
    expect(line([st('bob', 'backup.state', 5, { backupState: 'enabled' }), st('bob', 'backup.broken', 7), st('bob', 'backup.broken', 8), utd('bob', 20)]))
      .toMatchObject({ state: 'fail', detail: 'broken: 2 keys failed to decrypt from it (the backup key may not match)' });
  });

  it('a historical message with an unavailable or broken backup says so', () => {
    const coverage = [{ start: 8_000_000 * 1_000_000, end: 9_500_000 * 1_000_000 }];
    const verdict = (extra: Steps) => {
      const d = { ...dev('bob', BOB_PHONE, [...extra, utd('bob', 9_000_000, '$ev1', { eventTs: 1_000_000 })]), coverage };
      const [s] = buildCryptoModel([d]);
      return buildJourney(s, undefined, d).verdict;
    };
    expect(verdict([st('bob', 'backup.state', 8_100_000, { backupState: 'disabled' })])).toBe('Likely a historical message, and key backup is unavailable (disabled)');
    expect(verdict([st('bob', 'backup.broken', 8_100_000)])).toBe('Likely a historical message, and key backup looks broken: its keys fail to decrypt');
  });

  it('no UTD: likely fine; no receiver: sent by this device', () => {
    expect(journey([st('bob', 'roomkey.received', 5, { sessionId: 'S', toDeviceType: 'm.room_key' })]).verdict).toBe('Likely fine: key received, no UTD in the loaded logs');
    const devices = [dev('alice', ALICE, aliceShares())];
    const [s] = buildCryptoModel(devices, { includeHealthy: true });
    expect(buildJourney(s, devices[0], undefined)).toMatchObject({ tone: 'neutral', lines: [{ state: 'ok', detail: '1 share to 1 device' }] });
  });
});

import { describe, it, expect } from 'vitest';
import { buildCryptoModel, deviceFromSteps } from '../buildCryptoModel';
import { deviceLabel } from '../labels';
import { extractSteps } from '../steps';
import { parseLogFile } from '../../logParser';
import { ALICE, BOB_LAPTOP, BOB_PHONE, dev, st, utd } from './helpers';

const share = (sec: number, recipients: Array<[string, string]>, extra = {}) =>
  st('alice', 'share.encrypt', sec, { sessionId: 'S', recipients, transactionId: 'txn1', ...extra });
const batch = (sec: number, messages: Array<{ messageId: string; userId: string; deviceId: string }>) =>
  st('alice', 'todevice.batch', sec, { sessionId: 'S', requestId: 'req1', messages, transactionId: 'txn1' });

describe('grouping and filtering', () => {
  it('builds only sessions with a UTD unless includeHealthy is set', () => {
    const bob = dev('bob', BOB_PHONE, [
      utd('bob', 10),
      st('bob', 'roomkey.received', 5, { sessionId: 'OK', toDeviceType: 'm.room_key' }),
    ]);
    expect(buildCryptoModel([bob]).map((s) => s.sessionId)).toEqual(['S']);
    expect(buildCryptoModel([bob], { includeHealthy: true }).map((s) => s.sessionId).sort()).toEqual(['OK', 'S']);
  });

  it('ignores UTDs without a session id', () => {
    const bob = dev('bob', BOB_PHONE, [utd('bob', 10), st('bob', 'event.utd', 11, { eventId: '$x', error: 'x', reason: 'other' })]);
    expect(buildCryptoModel([bob]).map((s) => s.sessionId)).toEqual(['S']);
  });

  it('reads room and sender key from the session steps', () => {
    const [s] = buildCryptoModel([dev('bob', BOB_PHONE, [utd('bob', 10, '$ev1', { roomId: '!r:a.org' })])]);
    expect(s.roomId).toBe('!r:a.org');
    expect(s.senderKey).toBe('ALICEKEY');
  });
});

describe('sender detection', () => {
  const bob = () => dev('bob', BOB_PHONE, [utd('bob', 10)]);

  it('share: the device that logged a share for the session', () => {
    const [s] = buildCryptoModel([dev('alice', {}, [share(1, [])]), bob()]);
    expect(s.sender.loadedId).toBe('alice');
  });

  it('curve_key: the device whose details curve key equals the session sender key', () => {
    const [s] = buildCryptoModel([dev('alice', ALICE, []), bob()]);
    expect(s.sender.loadedId).toBe('alice');
  });

  it('unknown: keeps the sender key and the event sender', () => {
    const [s] = buildCryptoModel([bob()]);
    expect(s.sender).toMatchObject({ senderKey: 'ALICEKEY', userId: '@alice:a.org' });
    expect(s.sender.loadedId).toBeUndefined();
  });

  it('unknown without a UTD: the event sender comes from the m.room_key to-device sender', () => {
    const [s] = buildCryptoModel([dev('bob', BOB_PHONE, [
      st('bob', 'roomkey.received', 5, { sessionId: 'S', toDeviceType: 'm.room_key', senderKey: 'ALICEKEY', userId: '@alice:a.org' }),
    ])], { includeHealthy: true });
    expect(s.sender).toMatchObject({ senderKey: 'ALICEKEY', userId: '@alice:a.org' });
  });
});

describe('receivers and deliveries', () => {
  it('joins a batch msgid to the receiver, with http status and latency, and lists seen-only devices', () => {
    const alice = dev('alice', ALICE, [
      share(1, [['@bob:b.org', 'BOBPHONE'], ['@bob:b.org', 'BOBLAPTOP']]),
      batch(2, [{ messageId: 'm1', userId: '@bob:b.org', deviceId: 'BOBPHONE' }]),
      st('alice', 'todevice.http', 3, { requestId: 'req1', status: '200' }),
      st('alice', 'event.sent', 4, { eventId: '$ev1', transactionId: 'txn1' }),
    ]);
    const bob = dev('bob', BOB_PHONE, [st('bob', 'todevice.received', 7, { messageId: 'm1' }), utd('bob', 10)]);
    const [s] = buildCryptoModel([alice, bob]);

    expect(s.receivers.map((r) => r.key)).toEqual(['bob', '@bob:b.org|BOBLAPTOP']);
    expect(s.deliveries).toHaveLength(1);
    expect(s.deliveries[0]).toMatchObject({ messageId: 'm1', receiverId: 'bob', latency: 5_000_000 });
    expect(s.deliveries[0].http?.keys.status).toBe('200');
    expect(s.stepsByDevice.alice.map((x) => x.kind)).toEqual(['share.encrypt', 'todevice.batch', 'todevice.http', 'event.sent']);
    expect(s.stepsByDevice.bob.map((x) => x.kind)).toEqual(['todevice.received', 'event.utd']);
  });

  it('joins a msgid to a receiver with no identity through its received to-device event', () => {
    const alice = dev('alice', ALICE, [batch(2, [{ messageId: 'm1', userId: '@bob:b.org', deviceId: 'BOBPHONE' }])]);
    const anon = dev('anon', {}, [st('anon', 'todevice.received', 7, { messageId: 'm1' }), utd('anon', 10)]);
    const [s] = buildCryptoModel([alice, anon]);
    expect(s.deliveries[0]).toMatchObject({ receiverId: 'anon', latency: 5_000_000 });
  });

  it('a msgid never received leaves the link without receipt', () => {
    const alice = dev('alice', ALICE, [share(1, [['@bob:b.org', 'BOBPHONE']]), batch(2, [{ messageId: 'm1', userId: '@bob:b.org', deviceId: 'BOBPHONE' }])]);
    const [s] = buildCryptoModel([alice, dev('bob', BOB_PHONE, [utd('bob', 10)])]);
    expect(s.deliveries[0]).toMatchObject({ receiverId: 'bob', received: undefined, latency: undefined });
  });

  it('attaches Olm failures from the session sender key near the session activity', () => {
    const bob = dev('bob', BOB_PHONE, [
      st('bob', 'olm.decrypt_failed', 9, { senderKey: 'ALICEKEY' }),
      st('bob', 'olm.decrypt_failed', 5000, { senderKey: 'ALICEKEY' }),
      st('bob', 'olm.decrypt_failed', 9, { senderKey: 'OTHER' }),
      utd('bob', 10),
    ]);
    const [s] = buildCryptoModel([bob]);
    expect(s.stepsByDevice.bob.filter((x) => x.kind === 'olm.decrypt_failed')).toHaveLength(1);
  });

  it('attaches no Olm failure when Rust logged the sender key as None', () => {
    const bob = deviceFromSteps('bob', extractSteps(parseLogFile([
      '2026-09-08T06:55:21.000000Z  WARN matrix_sdk_crypto::olm::account: Failed to decrypt a non-pre-key message with all available sessions errors_by_olm_session=[] | crates/matrix-sdk-crypto/src/olm/account.rs:1354 | spans: receive_to_device_event{sender="@alice:a.org" event_type="m.room.encrypted" message_id="msg1"} > decrypt_olm_v1{sender="@alice:a.org" sender_key=None}',
      '2026-09-08T06:55:22.130000Z  WARN matrix_sdk_crypto::machine: Failed to decrypt a room event: Can\'t find the room key to decrypt the event, withheld code: None | crates/matrix-sdk-crypto/src/machine/mod.rs:2516 | spans: decrypt_room_event{room_id="!r:a.org" event_id="$ev1" sender="@alice:a.org" sender_key=None session_id="SESS" message_index=0}',
    ].join('\n')).rawLogLines, { archive: 'bob', file: 'f.log' }));
    const [s] = buildCryptoModel([bob]);
    expect(s.senderKey).toBeUndefined();
    expect(s.stepsByDevice.bob.map((x) => x.kind)).toEqual(['event.utd']);
  });

  it('attaches a session-less withheld (m.no_olm) from the session sender key near the session activity', () => {
    const bob = dev('bob', BOB_PHONE, [
      st('bob', 'withheld.received', 9, { senderKey: 'ALICEKEY', withheldCode: 'NoOlm' }),
      st('bob', 'withheld.received', 5000, { senderKey: 'ALICEKEY', withheldCode: 'NoOlm' }),
      st('bob', 'withheld.received', 9, { senderKey: 'OTHER', withheldCode: 'NoOlm' }),
      utd('bob', 10),
    ]);
    const [s] = buildCryptoModel([bob]);
    expect(s.stepsByDevice.bob.filter((x) => x.kind === 'withheld.received')).toHaveLength(1);
  });
});

describe('UTD events', () => {
  it('de-duplicates per event, counts attempts, prefers a specific reason', () => {
    const bob = dev('bob', BOB_PHONE, [
      utd('bob', 10, '$ev1', { reason: 'other', error: 'x', messageIndex: undefined }),
      utd('bob', 10.002),
      utd('bob', 15),
    ]);
    const [s] = buildCryptoModel([bob]);
    expect(s.utds).toHaveLength(1);
    expect(s.utds[0]).toMatchObject({ eventId: '$ev1', deviceId: 'bob', attempts: 2, reason: 'missing_key', messageIndex: 0, firstFailedAt: 10_000_000 });
  });

  it('the latest specific reason wins: a key that arrives turns a missing key into what fails now', () => {
    const payload = { reason: 'invalid_payload' as const, error: 'unexpected end of hex escape at line 1 column 114' };
    const [s] = buildCryptoModel([dev('bob', BOB_PHONE, [
      utd('bob', 10), st('bob', 'backup.imported', 11, { sessionIds: ['S'] }), utd('bob', 13, '$ev1', payload), utd('bob', 16, '$ev1', payload),
    ])]);
    expect(s.utds[0]).toMatchObject({ reason: 'invalid_payload', error: payload.error, resolution: { state: 'unresolved' } });
  });

  it('unresolved when nothing follows', () => {
    const [s] = buildCryptoModel([dev('bob', BOB_PHONE, [utd('bob', 10)])]);
    expect(s.utds[0].resolution).toEqual({ state: 'unresolved' });
  });

  it.each([
    ['late_key', [st('bob', 'roomkey.received', 30, { sessionId: 'S', toDeviceType: 'm.room_key', firstKnownIndex: 0 })]],
    ['forwarded_key', [st('bob', 'roomkey.received', 30, { sessionId: 'S', toDeviceType: 'm.forwarded_room_key' })]],
    ['backup', [st('bob', 'backup.download', 20, { sessionId: 'S' }), st('bob', 'backup.imported', 30, { sessionIds: ['S'] })]],
    ['backup', [st('bob', 'backup.download', 30, { sessionId: 'S', ok: true })]],
    ['import', [st('bob', 'backup.imported', 30, { sessionIds: ['S'] })]],
    ['history_bundle', [st('bob', 'bundle.received', 25, { roomId: '!r:a.org' }), st('bob', 'backup.imported', 30, { sessionIds: ['S'] })]],
    ['import', [st('bob', 'bundle.received', 25, { roomId: '!other:a.org' }), st('bob', 'backup.imported', 30, { sessionIds: ['S'] })]],
  ])('resolved by %s, inferred, 20 s delay', (by, after) => {
    const [s] = buildCryptoModel([dev('bob', BOB_PHONE, [utd('bob', 10, '$ev1', { roomId: '!r:a.org' }), ...after])]);
    expect(s.utds[0].resolution).toMatchObject({ state: 'resolved', by, delay: 20_000_000, confirmed: false });
  });

  it('a retry with no key step resolves as unknown, confirmed', () => {
    const [s] = buildCryptoModel([dev('bob', BOB_PHONE, [utd('bob', 10), st('bob', 'event.redecrypted', 40, { eventId: '$ev1' })])]);
    expect(s.utds[0].resolution).toMatchObject({ state: 'resolved', by: 'unknown', confirmed: true, delay: 30_000_000 });
  });

  it('a retry after the key confirms the key resolution', () => {
    const [s] = buildCryptoModel([dev('bob', BOB_PHONE, [
      utd('bob', 10),
      st('bob', 'roomkey.received', 30, { sessionId: 'S', toDeviceType: 'm.room_key' }),
      st('bob', 'event.redecrypted', 31, { eventId: '$ev1' }),
    ])]);
    expect(s.utds[0].resolution).toMatchObject({ by: 'late_key', confirmed: true });
    expect(s.stepsByDevice.bob.map((x) => x.kind)).toContain('event.redecrypted');
  });

  it('a key logged after the re-decryption is not what decrypted the event', () => {
    const [s] = buildCryptoModel([dev('bob', BOB_PHONE, [
      utd('bob', 10),
      st('bob', 'event.redecrypted', 20, { eventId: '$ev1' }),
      st('bob', 'roomkey.received', 30, { sessionId: 'S', toDeviceType: 'm.forwarded_room_key' }),
    ])]);
    expect(s.utds[0].resolution).toMatchObject({ by: 'unknown', at: 20_000_000, decryptedAt: 20_000_000, delay: 10_000_000, confirmed: true });
  });

  it('a Rust batch re-decryption long after the key: the delay runs to the re-decryption', () => {
    const [s] = buildCryptoModel([dev('bob', BOB_PHONE, [
      utd('bob', 10),
      st('bob', 'roomkey.received', 10.5, { sessionId: 'S', toDeviceType: 'm.room_key' }),
      st('bob', 'event.redecrypted', 36.4, { eventIds: ['$other', '$ev1'] }),
    ])]);
    expect(s.utds[0].resolution).toMatchObject({ by: 'late_key', at: 10_500_000, decryptedAt: 36_400_000, delay: 26_400_000, confirmed: true });
    expect(s.stepsByDevice.bob.map((x) => x.kind)).toContain('event.redecrypted');
  });

  it('a key that starts after the event index does not resolve it', () => {
    const [s] = buildCryptoModel([dev('bob', BOB_PHONE, [
      utd('bob', 10, '$ev1', { messageIndex: 2 }),
      st('bob', 'roomkey.received', 30, { sessionId: 'S', toDeviceType: 'm.room_key', firstKnownIndex: 5 }),
    ])]);
    expect(s.utds[0].resolution.state).toBe('unresolved');
  });

  it('an immediate re-failure right after the key (Element Web retry) un-resolves it', () => {
    const retryFail = utd('bob', 30.02);
    const [s] = buildCryptoModel([dev('bob', BOB_PHONE, [
      utd('bob', 10), st('bob', 'roomkey.received', 30, { sessionId: 'S', toDeviceType: 'm.room_key' }), retryFail,
    ])]);
    expect(s.utds[0].resolution.state).toBe('unresolved');
    expect(s.utds[0].keyArrivedButFailed).toEqual(retryFail.line);
  });

  it('a failure after a usable key un-resolves and records it', () => {
    const later = utd('bob', 40);
    const [s] = buildCryptoModel([dev('bob', BOB_PHONE, [
      utd('bob', 10), st('bob', 'roomkey.received', 30, { sessionId: 'S', toDeviceType: 'm.room_key' }), later,
    ])]);
    expect(s.utds[0].resolution.state).toBe('unresolved');
    expect(s.utds[0].keyArrivedButFailed).toEqual(later.line);
  });

  it('redecrypt.failed after the key un-resolves', () => {
    const [s] = buildCryptoModel([dev('bob', BOB_PHONE, [
      utd('bob', 10),
      st('bob', 'roomkey.received', 30, { sessionId: 'S', toDeviceType: 'm.room_key' }),
      st('bob', 'redecrypt.failed', 31, { sessionId: 'S' }),
    ])]);
    expect(s.utds[0].resolution.state).toBe('unresolved');
    expect(s.utds[0].keyArrivedButFailed).toBeDefined();
  });

  it('builds a healthy session, without UTD, only on request', () => {
    const bob = dev('bob', BOB_PHONE, [st('bob', 'roomkey.received', 5, { sessionId: 'OK', toDeviceType: 'm.room_key' })]);
    expect(buildCryptoModel([bob], { includeHealthy: true }).map((s) => [s.sessionId, s.utds.length])).toEqual([['OK', 0]]);
    expect(buildCryptoModel([bob])).toEqual([]);
  });
});

describe('UTD analytics', () => {
  const handled = (sec: number, event = '$ev1') => st('bob', 'timeline.handled', sec, { eventId: event });
  const key = (sec: number) => st('bob', 'roomkey.received', sec, { sessionId: 'S', toDeviceType: 'm.room_key' });
  const redecrypted = (sec: number) => st('bob', 'event.redecrypted', sec, { eventIds: ['$ev1'] });
  const analytics = (steps: ReturnType<typeof st>[]) => buildCryptoModel([dev('bob', BOB_PHONE, steps)])[0].utds[0].analytics;
  const web = (sec: number) => ({ ...utd('bob', sec), text: 'Error decrypting event (id=$ev1 …' });

  it('Element X: reported when still UTD 4 s after a timeline handled it, or never decrypted', () => {
    expect(analytics([utd('bob', 10), handled(15), key(15.5), redecrypted(36)])).toEqual({ category: 'reported' });
    expect(analytics([utd('bob', 10), handled(15)])).toEqual({ category: 'reported' });
  });

  it('Element X: not reported when re-decrypted within 4 s of the timeline handling it, or never in a timeline', () => {
    expect(analytics([utd('bob', 10), handled(15), key(15.5), redecrypted(18)])).toMatchObject({ category: 'not_reported', why: 'decrypted within 4s' });
    expect(analytics([utd('bob', 10), handled(12, '$other'), key(15.5), redecrypted(36)])).toMatchObject({ category: 'not_reported', why: 'never in a timeline' });
    expect(analytics([utd('bob', 10), key(11), handled(200)])).toMatchObject({ category: 'not_reported', why: 'decrypted before a timeline handled it' });
  });

  it('unknown when the device logs no timeline handling at all (older builds)', () => {
    expect(analytics([utd('bob', 10), key(15.5), redecrypted(36)])).toMatchObject({ category: 'unknown' });
  });

  it("the app's own report wins (Element X Android onUtd)", () => {
    const report = st('bob', 'utd.reported', 36.1, { eventId: '$ev1', timeToDecryptMs: 21112 });
    expect(analytics([utd('bob', 10), handled(15), key(15.5), redecrypted(16), report])).toEqual({ category: 'reported', logged: report.line });
  });

  it('Element Web: from the first failure, not reported within 4 s', () => {
    expect(analytics([web(10), key(12)])).toMatchObject({ category: 'not_reported', why: 'decrypted within 4s' });
    expect(analytics([web(10), key(30)])).toEqual({ category: 'reported' });
    expect(analytics([web(10)])).toMatchObject({ category: 'reported' });
  });
});

describe('deviceLabel', () => {
  it('prefers user · device, then archive name, then key', () => {
    expect(deviceLabel({ identity: BOB_LAPTOP, id: 'x' })).toBe('@bob:b.org · BOBLAPTOP');
    expect(deviceLabel({ identity: {}, id: 'bob.tar.gz' })).toBe('bob.tar.gz');
    expect(deviceLabel({ userId: '@u:d', deviceId: 'D' })).toBe('@u:d · D');
    expect(deviceLabel({ key: 'curve:K' })).toBe('curve:K');
    expect(deviceLabel({ key: 'curve:K', userId: '@u:d' })).toBe('@u:d · unknown device');
  });
});

describe('room-level history steps', () => {
  it('attach to the sessions of their room only, without making a device a receiver', () => {
    const bundle = st('bob', 'bundle.received', 5, { roomId: '!r', userId: '@alice:a.org' });
    const sessions = buildCryptoModel([
      dev('bob', BOB_PHONE, [bundle, utd('bob', 10, '$a', { roomId: '!r' }), utd('bob', 12, '$b', { sessionId: 'S2', roomId: '!other' })]),
      dev('carol', BOB_LAPTOP, [st('carol', 'bundle.received', 6, { roomId: '!r' })]),
    ]);
    const s = sessions.find((x) => x.sessionId === 'S')!;
    expect(s.stepsByDevice.bob).toContain(bundle);
    expect(s.stepsByDevice.carol).toEqual([]);
    expect(s.receivers.map((r) => r.loadedId)).toEqual(['bob']);
    expect(sessions.find((x) => x.sessionId === 'S2')!.stepsByDevice.bob).not.toContain(bundle);
  });
});

describe('deviceFromSteps', () => {
  it('wraps sorted steps as a device, without copying them', () => {
    const steps = [st('alice', 'share.encrypt', 1, { sessionId: 'S' }), st('alice', 'todevice.batch', 2, { sessionId: 'S' })];
    const d = deviceFromSteps('archive', steps);
    expect(d).toMatchObject({ id: 'archive', entries: [], identity: {}, coverage: [] });
    expect(d.steps).toBe(steps);
  });
});

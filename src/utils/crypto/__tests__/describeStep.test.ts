import { describe, it, expect } from 'vitest';
import { buildCryptoModel } from '../buildCryptoModel';
import { describeStep, stepTone, utdStepNote } from '../describeStep';
import { BOB_PHONE, dev, st, utd } from './helpers';

describe('describeStep', () => {
  it.each([
    [st('a', 'share.encrypt', 1, { recipients: [['@b:d', 'B1'], ['@b:d', 'B2']], messageIndex: 0 }), 'share to 2 devices · index 0'],
    [st('a', 'todevice.batch', 1, { requestId: 'req1', messages: [{ messageId: 'm', userId: '@b:d', deviceId: 'B' }], toDeviceType: 'm.room.encrypted' }), 'to-device batch req1 · 1 message (m.room.encrypted)'],
    [st('a', 'todevice.http', 1, { status: '200' }), '/sendToDevice 200'],
    [st('a', 'event.sent', 1, { eventId: '$e' }), 'sent $e'],
    [st('a', 'todevice.received', 1, { messageId: 'm1' }), 'received to-device m1'],
    [st('a', 'roomkey.received', 1, { toDeviceType: 'm.room_key', firstKnownIndex: 0 }), 'room key received (m.room_key) · first index 0'],
    [st('a', 'event.utd', 1, { eventId: '$e', reason: 'missing_key' }), 'UTD $e · MissingMegolmSession'],
    [st('a', 'event.redecrypted', 1, { eventId: '$e' }), 'decrypted on retry $e'],
    [st('a', 'timeline.handled', 1, { eventId: '$e' }), 'timeline handled $e'],
    [st('a', 'utd.reported', 1, { eventId: '$e', timeToDecryptMs: 21112 }), 'analytics: reported $e · decrypted after 21.1s'],
    [st('a', 'utd.reported', 1, { eventId: '$e', timeToDecryptMs: -1 }), 'analytics: reported $e · never decrypted'],
    [st('a', 'backup.download', 1, { ok: true }), 'key found in backup'],
    [st('a', 'backup.download', 1, { ok: false }), 'key not in backup'],
    [st('a', 'backup.download', 1, {}), 'backup lookup'],
    [st('a', 'backup.imported', 1, { sessionIds: ['S'] }), 'imported 1 key'],
    [st('a', 'withheld.received', 1, { withheldCode: 'Unverified' }), 'withheld (Unverified)'],
    [st('a', 'redecrypt.keys', 1, { sessionIds: ['S1', 'S2'] }), 'redecryptor took up 2 new keys'],
    [st('a', 'redecrypt.request', 1, { sessionIds: ['S1'] }), 'redecryption requested for 1 UTD session'],
  ])('%#', (step, text) => {
    expect(describeStep(step)).toBe(text);
  });

  it('names every other kind, never the raw text', () => {
    expect([
      st('a', 'session.rotate', 1), st('a', 'todevice.sent', 1, { requestId: 'req1' }), st('a', 'todevice.sent', 1),
      st('a', 'backup.upload', 1, { sessionIds: ['S', 'T'] }), st('a', 'olm.claim', 1),
      st('a', 'olm.decrypt_failed', 1), st('a', 'olm.unwedge', 1), st('a', 'bundle.received', 1), st('a', 'keyrequest.served', 1), st('a', 'redecrypt.failed', 1),
    ].map(describeStep)).toEqual([
      'room key rotated', 'batch req1 marked sent', 'session marked as shared',
      'backed up 2 keys', 'one-time keys claim',
      'Olm decryption failed', 'Olm session unwedged', 'room key bundle received', 'key request answered', 'still failing after a key arrived',
    ]);
  });

  it('names the history sharing steps', () => {
    expect([
      st('a', 'bundle.received', 1, { userId: '@a:d' }), st('a', 'bundle.missing', 1, { userId: '@a:d' }), st('a', 'bundle.rejected', 1, { error: 'empty' }),
      st('a', 'history.shared', 1, { userId: '@b:d' }), st('a', 'history.uploaded', 1, { count: 2, withheldCount: 1 }), st('a', 'history.not_shared', 1, { error: 'cross-signing is not set up' }),
    ].map(describeStep)).toEqual([
      'room key bundle received from @a:d', 'no room key bundle from the inviter @a:d', 'room key bundle rejected: empty',
      'sharing history with @b:d', 'history key blob uploaded · 2 keys, 1 withheld', 'history not shared: cross-signing is not set up',
    ]);
  });

  it('shortens long ids', () => {
    expect(describeStep(st('a', 'event.sent', 1, { eventId: '$ZN2d0gAzxR1CyWJx6AIcGz3oOV0M6wNgt7t1jWtcQSg' }))).toBe('sent $ZN2d0gAzxR1…');
  });
});

describe('stepTone', () => {
  it('failures bad, keys and successes good, routine steps neither', () => {
    expect([
      st('a', 'event.utd', 1), st('a', 'withheld.received', 1), st('a', 'backup.download', 1, { ok: false }),
      st('a', 'roomkey.received', 1), st('a', 'event.redecrypted', 1), st('a', 'backup.download', 1, { ok: true }),
      st('a', 'share.encrypt', 1), st('a', 'backup.download', 1),
    ].map(stepTone)).toEqual(['bad', 'bad', 'bad', 'good', 'good', 'good', undefined, undefined]);
  });
});

describe('utdStepNote', () => {
  it('under the first failure only: how it ended, after how many attempts, and the key step', () => {
    const first = utd('bob', 10, '$a');
    const retry = utd('bob', 12, '$a');
    const key = st('bob', 'roomkey.received', 20, { sessionId: 'S', toDeviceType: 'm.room_key' });
    const [s] = buildCryptoModel([dev('bob', BOB_PHONE, [first, retry, key])]);
    expect(utdStepNote(first, s, 'bob')).toEqual({ text: 'resolved · late key · key after 10.0s · inferred · 2 attempts', keyStep: key.line });
    expect(utdStepNote(retry, s, 'bob')).toBeUndefined();
    expect(utdStepNote(key, s, 'bob')).toBeUndefined();
  });

  it('a UTD nothing resolved', () => {
    const first = utd('bob', 10, '$a');
    const [s] = buildCryptoModel([dev('bob', BOB_PHONE, [first])]);
    expect(utdStepNote(first, s, 'bob')).toEqual({ text: 'unresolved' });
  });
});

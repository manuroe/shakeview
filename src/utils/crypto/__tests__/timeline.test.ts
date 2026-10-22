import { describe, it, expect } from 'vitest';
import { buildCryptoModel } from '../buildCryptoModel';
import { buildTimeline, FOLD_MIN, sessionLanes, shareRecipients, type StepRow, type TimelineRow } from '../timeline';
import { ALICE, BOB_LAPTOP, BOB_PHONE, dev, st, utd } from './helpers';

const msg = { messageId: 'm1', userId: '@bob:b.org', deviceId: 'BOBPHONE' };
const alice = (extra: ReturnType<typeof st>[] = []) => dev('alice', ALICE, [
  st('alice', 'share.encrypt', 10, { sessionId: 'S', transactionId: 'T1', recipients: [['@bob:b.org', 'BOBPHONE']] }),
  st('alice', 'todevice.batch', 11, { sessionId: 'S', requestId: 'req1', messages: [msg] }),
  st('alice', 'event.sent', 12, { transactionId: 'T1', eventId: '$ev1' }),
  ...extra,
]);
const session = (bobSteps: ReturnType<typeof st>[], aliceExtra: ReturnType<typeof st>[] = []) =>
  buildCryptoModel([alice(aliceExtra), dev('bob', BOB_PHONE, bobSteps)]).find((s) => s.sessionId === 'S')!;
const steps = (rows: readonly TimelineRow[]) => rows.filter((r): r is StepRow => r.kind === 'step');

describe('buildTimeline', () => {
  it('merges both lanes on one axis with the delta to the previous row', () => {
    const rows = steps(buildTimeline(session([st('bob', 'todevice.received', 13, { messageId: 'm1' }), utd('bob', 14)]), 'alice', 'bob'));
    expect(rows.map((r) => [r.lane, r.step.kind])).toEqual([
      ['sender', 'share.encrypt'], ['sender', 'todevice.batch'], ['sender', 'event.sent'], ['receiver', 'todevice.received'], ['receiver', 'event.utd'],
    ]);
    expect(rows.map((r) => r.deltaUs)).toEqual([null, 1_000_000, 1_000_000, 1_000_000, 1_000_000]);
  });

  it('links the batch to its receipt and the sent event to its UTD, both ends', () => {
    const rows = steps(buildTimeline(session([st('bob', 'todevice.received', 13, { messageId: 'm1' }), utd('bob', 14)]), 'alice', 'bob'));
    expect(rows.map((r) => r.link)).toEqual([
      undefined,
      { dir: 'out', text: 'received 2.0s' },
      { dir: 'out', text: 'UTD 2.0s' },
      { dir: 'in', text: 'batch +2.0s' },
      { dir: 'in', text: 'sent +2.0s' },
    ]);
  });

  it('marks a batch never received, and a link back in time as clock skew', () => {
    const missing = steps(buildTimeline(session([utd('bob', 14)]), 'alice', 'bob'));
    expect(missing.find((r) => r.step.kind === 'todevice.batch')?.link).toEqual({ dir: 'out', text: 'not received', missing: true });
    const skewed = steps(buildTimeline(session([utd('bob', 5)]), 'alice', 'bob'));
    expect(skewed.find((r) => r.step.kind === 'event.sent')?.link?.text).toBe('UTD clock skew?');
  });

  it('draws no link with one lane, and folds repeated UTD attempts', () => {
    const rows = buildTimeline(session([utd('bob', 14), utd('bob', 14.05)]), undefined, 'bob');
    expect(rows).toEqual([expect.objectContaining({ kind: 'step', lane: 'receiver', link: undefined })]);
  });

  it('inserts gap rows and folds Olm steps and long plain runs', () => {
    const shares = Array.from({ length: FOLD_MIN }, (_, i) => st('alice', 'todevice.http', 20 + i, { sessionId: 'S', status: '200' }));
    const rows = buildTimeline(session([utd('bob', 300)], [...shares]), 'alice', 'bob');
    expect(rows.map((r) => r.kind)).toEqual(['step', 'step', 'step', 'fold', 'gap', 'step']);
    expect(rows[3]).toMatchObject({ kind: 'fold', lane: 'sender', label: `${FOLD_MIN} steps · 00:00:20–00:00:27` });
    expect(rows[4]).toEqual({ kind: 'gap', us: (300 - 27) * 1_000_000 });

    const olm = buildTimeline(session([st('bob', 'olm.decrypt_failed', 13, { senderKey: 'ALICEKEY' }), utd('bob', 14)]), 'alice', 'bob');
    expect(olm.find((r) => r.kind === 'fold')).toMatchObject({ lane: 'receiver', label: '1 Olm step' });
  });
});

describe('sessionLanes', () => {
  it('the sender, and the main device as receiver, else the first loaded receiver', () => {
    const devices = [alice(), dev('bob', BOB_PHONE, [utd('bob', 14)]), dev('laptop', BOB_LAPTOP, [utd('laptop', 13)])];
    const s = buildCryptoModel(devices).find((x) => x.sessionId === 'S')!;
    const lanes = (mainId: string) => {
      const { sender, receiver, receiverRef } = sessionLanes(s, devices, mainId);
      return [sender?.id, receiver?.id, receiverRef?.loadedId];
    };
    expect(lanes('bob')).toEqual(['alice', 'bob', 'bob']);
    expect(lanes('alice')).toEqual(['alice', 'laptop', 'laptop']);
  });
});

describe('shareRecipients', () => {
  it('each user with their devices, the given user first, devices counted once', () => {
    const steps = [
      st('alice', 'share.encrypt', 1, { recipients: [['@carol:c.org', 'C1'], ['@bob:b.org', 'BOBPHONE']] }),
      st('alice', 'share.encrypt', 2, { recipients: [['@bob:b.org', 'BOBPHONE'], ['@bob:b.org', 'BOBLAPTOP']] }),
      st('alice', 'todevice.batch', 3),
    ];
    expect(shareRecipients(steps, '@bob:b.org')).toEqual({
      users: [['@bob:b.org', ['BOBPHONE', 'BOBLAPTOP']], ['@carol:c.org', ['C1']]],
      deviceCount: 3,
    });
    expect(shareRecipients([], undefined)).toEqual({ users: [], deviceCount: 0 });
  });
});

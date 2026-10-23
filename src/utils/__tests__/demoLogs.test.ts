import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEMO_PEER, fetchDemoLog } from '../demoLogs';
import { deviceFromFile } from '../crypto/loadDevice';
import { buildCryptoModel } from '../crypto/buildCryptoModel';

const demo = (name: string) => deviceFromFile(name, new Uint8Array(readFileSync(`public/demo/${name}`)));

describe('fetchDemoLog', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches a demo log from the app', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('log'));
    expect(new TextDecoder().decode(await fetchDemoLog('demo.log'))).toBe('log');
    expect(String(fetchSpy.mock.calls[0][0])).toMatch(/demo\/demo\.log$/);
  });

  it('throws on an HTTP error', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('', { status: 404 }));
    await expect(fetchDemoLog('demo.log')).rejects.toThrow('HTTP 404');
  });
});

describe('the demo conversation', () => {
  it('pairs each demo with the other', () => {
    expect(DEMO_PEER['demo.log']).toBe('demo-web.log');
    expect(DEMO_PEER['demo-web.log']).toBe('demo.log');
  });

  it('links Alice on Element X and Bob on Element Web: one session per outcome', async () => {
    const [ex, ew] = await Promise.all([demo('demo.log'), demo('demo-web.log')]);
    expect(ex.identity).toMatchObject({ userId: '@alice:example.org', deviceId: 'ALICEPHONE' });
    expect(ew.identity).toMatchObject({ userId: '@bob:example.org', deviceId: 'BOBWEB' });
    const sessions = buildCryptoModel([ex, ew], { includeHealthy: true });
    const outcomes = sessions.map((s) => [
      s.sender.loadedId,
      s.utds.map((u) => `${u.resolution.state === 'resolved' ? u.resolution.by : 'unresolved'} ${u.analytics.category}`).join() || 'key received',
    ]);
    expect(outcomes).toEqual(expect.arrayContaining([
      ['demo.log', 'key received'],
      ['demo.log', 'late_key not_reported'],
      ['demo.log', 'unresolved reported'],
      ['demo-web.log', 'late_key reported'],
      ['demo-web.log', 'key received'],
    ]));
    expect(sessions).toHaveLength(5);
    // Every key sent to the other loaded device arrived there.
    const toPeer = sessions.flatMap((s) => s.deliveries.filter((d) => d.receiverId));
    expect(toPeer).toHaveLength(4);
    expect(toPeer.every((d) => d.received)).toBe(true);
  });
});

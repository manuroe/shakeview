/**
 * Benchmarks for UTD extraction on a large mixed log: most lines are not crypto,
 * a few thousand are UTDs and room keys, as in a real 200k-line archive.
 *
 * Run with: npm run bench
 */
import { beforeEach, describe, bench } from 'vitest';
import { parseLogFile } from '../../logParser';
import { extractSteps } from '../steps';
import { buildCryptoModel } from '../buildCryptoModel';
import type { CryptoDevice, CryptoStep } from '../types';

const lines: string[] = [];
for (let i = 0; i < 50_000; i++) {
  const ts = new Date(Date.UTC(2026, 8, 8, 6, 0, 0) + i * 100).toISOString().replace('Z', '000Z');
  if (i % 25 === 0) {
    lines.push(`${ts}  WARN matrix_sdk_crypto::machine: Failed to decrypt a room event: Can't find the room key to decrypt the event, withheld code: None | crates/matrix-sdk-crypto/src/machine/mod.rs:2516 | spans: decrypt_room_event{room_id="!r:a.org" event_id="$ev${i % 2000}" sender="@alice:a.org" sender_key=Some("curve25519:K") session_id="S${i % 300}" message_index=${i % 7}}`);
  } else if (i % 25 === 1) {
    lines.push(`${ts}  INFO matrix_sdk_crypto::store: Received a new megolm room key | crates/matrix-sdk-crypto/src/store/mod.rs:703 | spans: handle_decrypted_to_device_event{sender_key="curve25519:K" event_type="m.room_key"} > handle_key{room_id="!r:a.org" session_id="S${(i + 7) % 300}" message_index=0}`);
  } else {
    lines.push(`${ts} DEBUG matrix_sdk::sliding_sync: unrelated line ${i} | crates/matrix-sdk/src/sliding_sync/mod.rs:1`);
  }
}
const parsed = parseLogFile(lines.join('\n')).rawLogLines;

// Element X crypto lines with their real span chains (UTD, backup lookup, room key): each reads several span fields.
const spanTs = (i: number) => new Date(Date.UTC(2026, 9, 13, 16, 0, 0) + i * 10).toISOString().replace('Z', '000Z');
const ROOM = '!room-cce672fdf3cf:domain-60fc0bb7.org';
const NOTIFY = `root > get_notification{room_id="${ROOM}" event_id="$event-10f139a56c2c"} > retry_decryption`;
// 6k, not more: under CodSpeed's simulation one longer run blocks the worker past Vitest's 60 s RPC timeout.
const spanLines = Array.from({ length: 6_000 }, (_, i) => [
  `${spanTs(i)}  WARN matrix_sdk_crypto::machine: Failed to decrypt a room event: Can't find the room key to decrypt the event, withheld code: None | crates/matrix-sdk-crypto/src/machine/mod.rs:2516 | spans: ${NOTIFY} > decrypt_room_event{room_id="${ROOM}" sender="@user-0bb8c8918e88:domain-60fc0bb7.org" event_id="$event-${i}" origin_server_ts="2026-09-17T16:45:03.048Z" algorithm="m.megolm.v1.aes-sha2" sender_key=Some("curve25519:3fHdx8Sv0/UkvVTIwPio/iobDBDivyufU4BN3cxBQVY") session_id="S${i % 6000}" message_index=0}`,
  `${spanTs(i)} DEBUG matrix_sdk::http_client: Got response | crates/matrix-sdk/src/http_client/mod.rs:219 | spans: send{config=RequestConfig { timeout: Some(15s), read_timeout: 60s, retry_limit: 3, max_retry_time: 5s } request_id="REQ-${i}" method=GET uri="https://matrix-client.domain-60fc0bb7.org/_matrix/client/v3/room_keys/keys/${ROOM}/S${i % 6000}" status=200 response_size="838B"}`,
  `${spanTs(i)}  INFO matrix_sdk_crypto::store: Received a new megolm room key | crates/matrix-sdk-crypto/src/store/mod.rs:706 | spans: ${NOTIFY} > run_fixed_iterations > sync_once{conn_id="encryption" timeout=3000} > handle_response > receive_to_device_event{sender="@user-0bb8c8918e88:domain-60fc0bb7.org" event_type="m.room.encrypted" message_id="7d825321b0544febaabd864e2020bda3"} > handle_decrypted_to_device_event{sender_key="curve25519:3fHdx8Sv0/UkvVTIwPio/iobDBDivyufU4BN3cxBQVY" event_type="m.room_key"} > handle_key{room_id="${ROOM}" session_id="S${i % 6000}" message_index=0}`,
][i % 3]);
const spanParsed = parseLogFile(spanLines.join('\n')).rawLogLines;
const steps = extractSteps(parsed, { archive: 'bench', file: 'bench.log' });
const device = { id: 'bench', entries: [], identity: {}, steps, coverage: [] };

// A big room: the sender shares 40 sessions, each batch to 500 devices that are
// not loaded; two loaded receivers with 30k steps each and a UTD per session.
const step = (kind: CryptoStep['kind'], ts: number, keys: CryptoStep['keys']): CryptoStep =>
  ({ kind, role: 'either', ts, line: { archive: 'b', file: 'f', line: ts }, text: kind, keys });
const bigSender: CryptoDevice = {
  id: 'sender', entries: [], identity: { userId: '@s:d', deviceId: 'S' }, coverage: [],
  steps: Array.from({ length: 40 }, (_, s) => step('todevice.batch', s * 1000, {
    sessionId: `S${s}`, requestId: `r${s}`,
    messages: Array.from({ length: 500 }, (_, m) => ({ messageId: `m${s}-${m}`, userId: `@u${m}:d`, deviceId: `D${m}` })),
  })),
};
const bigReceiver = (id: string): CryptoDevice => ({
  id, entries: [], identity: { userId: `@${id}:d`, deviceId: id }, coverage: [],
  steps: [
    ...Array.from({ length: 30_000 }, (_, i) => step('todevice.received', i, { messageId: `x${i}` })),
    ...Array.from({ length: 40 }, (_, s) => step('event.utd', s * 1000 + 5, { sessionId: `S${s}`, eventId: `$e${s}`, reason: 'missing_key', error: 'e' })),
  ].sort((a, b) => a.ts - b.ts),
});
const bigRoom = [bigSender, bigReceiver('R1'), bigReceiver('R2')];

// One busy Element X device: ~45k steps over 6k sessions, every session built (as /decryption does).
const busySteps: CryptoStep[] = [
  ...Array.from({ length: 18_600 }, (_, i) => step('event.utd', i * 1000, { sessionId: `S${i % 6000}`, eventId: `$e${i % 9000}`, reason: 'missing_key', error: 'e' })),
  ...Array.from({ length: 6_200 }, (_, i) => step('roomkey.received', i * 3000 + 1, { sessionId: `S${i % 6000}`, toDeviceType: 'm.room_key' })),
  ...Array.from({ length: 6_200 }, (_, i) => step('backup.imported', i * 3000 + 2, { sessionIds: [`S${i % 6000}`] })),
  ...Array.from({ length: 12_500 }, (_, i) => step('backup.download', i * 1500 + 3, { sessionId: `S${i % 6000}`, ok: true })),
].sort((a, b) => a.ts - b.ts);
const busy: CryptoDevice = { id: 'busy', entries: [], identity: {}, steps: busySteps, coverage: [] };

describe('crypto extraction', () => {
  // CodSpeed's simulation runner chains a suite's runs on microtasks only, so the worker never
  // reaches its event loop: this suite takes minutes there, past Vitest's 60 s RPC timeout
  // ("Timeout calling onTaskUpdate"). It awaits beforeEach before every run, outside the
  // measurement; Vitest's own bench runner ignores hooks.
  beforeEach(() => new Promise<void>((resolve) => { setTimeout(resolve, 0); }));
  bench('buildCryptoModel: big room, 40 sessions × 500 recipients, 2 × 30k-step receivers', () => {
    buildCryptoModel(bigRoom);
  }, { iterations: 3 });
  bench('buildCryptoModel: one 45k-step device, 6k sessions, includeHealthy', () => {
    buildCryptoModel([busy], { includeHealthy: true });
  }, { iterations: 3 });
  bench('extractSteps: 50k lines', () => {
    extractSteps(parsed, { archive: 'bench', file: 'bench.log' });
  });
  bench('extractSteps: 6k Element X crypto lines with span chains', () => {
    extractSteps(spanParsed, { archive: 'bench', file: 'bench.log' });
  }, { iterations: 3 });
  bench('buildCryptoModel: 2k UTD lines over 300 sessions', () => {
    buildCryptoModel([device]);
  });
});

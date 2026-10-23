import { describe, it, expect } from 'vitest';
import { parseLogFile } from '../../logParser';
import { extractSteps } from '../steps';
import { CRYPTO_WASM_PRETTY_ENTRY } from '../../../test/fixtures';

const SRC = { archive: 'a.tar.gz', file: 'logs.log' };
const stepsOf = (text: string) => extractSteps(parseLogFile(text).rawLogLines, SRC);
const only = (text: string) => {
  const steps = stepsOf(text);
  expect(steps).toHaveLength(1);
  return steps[0];
};

const SEND_RAW = 'send_raw{room_id="!r:a.org" transaction_id="txn1" is_room_encrypted=true}';
const WASM_AT = '    at /home/runner/.cargo/git/checkouts/matrix-rust-sdk-5cafb5792f78b8d1/f333a32/crates/matrix-sdk-crypto/src/machine/mod.rs:2516';

describe('extractSteps — sender side', () => {
  it('share.encrypt (Rust compact)', () => {
    const s = only(`2026-09-08T06:55:14.024000Z  INFO matrix_sdk_crypto::session_manager::group_sessions: Trying to encrypt a room key recipients={"@bob:b.org": {"BOBPHONE", "BOBLAPTOP"}} message_index=0 room_id="!r:a.org" | crates/matrix-sdk-crypto/src/session_manager/group_sessions/mod.rs:486 | spans: ${SEND_RAW} > share_room_key{session_id="SESS"}`);
    expect(s.kind).toBe('share.encrypt');
    expect(s.role).toBe('sender');
    expect(s.line).toEqual({ archive: 'a.tar.gz', file: 'logs.log', line: 1 });
    expect(s.keys).toMatchObject({
      sessionId: 'SESS', roomId: '!r:a.org', messageIndex: 0, transactionId: 'txn1',
      recipients: [['@bob:b.org', 'BOBPHONE'], ['@bob:b.org', 'BOBLAPTOP']],
    });
    expect(s.text).toContain('Trying to encrypt a room key');
    expect(s.text).not.toContain('| spans:');
  });

  it('todevice.batch', () => {
    const s = only(`2026-09-08T06:55:14.082000Z  INFO matrix_sdk_crypto::session_manager::group_sessions: Created batch of to-device messages of type m.room.encrypted request_id="req1" message_list=[("msg1", "@bob:b.org", "BOBLAPTOP")] | crates/matrix-sdk-crypto/src/session_manager/group_sessions/mod.rs:631 | spans: ${SEND_RAW} > share_room_key{session_id="SESS"}`);
    expect(s.kind).toBe('todevice.batch');
    expect(s.keys).toMatchObject({
      sessionId: 'SESS', requestId: 'req1', toDeviceType: 'm.room.encrypted', transactionId: 'txn1',
      messages: [{ messageId: 'msg1', userId: '@bob:b.org', deviceId: 'BOBLAPTOP' }],
    });
  });

  it('todevice.http from a Rust response, not from other requests', () => {
    const s = only('2026-09-08T06:55:15.914000Z DEBUG matrix_sdk::http_client: Got response | crates/matrix-sdk/src/http_client/mod.rs:197 | spans: send{request_id="REQ-1" method=PUT uri="https://a.org/_matrix/client/v3/sendToDevice/m.room.encrypted/req1" request_size="2B" status=200 response_size="2B"}');
    expect(s.kind).toBe('todevice.http');
    expect(s.keys).toMatchObject({ requestId: 'req1', status: '200' });
    expect(stepsOf('2026-09-08T06:55:15.914000Z DEBUG matrix_sdk::http_client: Got response | crates/matrix-sdk/src/http_client/mod.rs:197 | spans: send{request_id="REQ-2" method=GET uri="https://a.org/_matrix/client/v3/sync" status=200}')).toEqual([]);
  });

  it('todevice.http from an Element Web FetchHttpApi response', () => {
    const s = only('2026-09-08T06:55:15.914Z D FetchHttpApi: <-- PUT https://a.org/_matrix/client/v3/sendToDevice/m.room.encrypted/req1 [107ms 200]');
    expect(s.keys).toMatchObject({ requestId: 'req1', status: '200' });
  });

  it('todevice.sent (marking as sent, and session marked shared)', () => {
    expect(only('2026-09-08T06:55:15.923000Z  INFO matrix_sdk_crypto::olm::group_sessions::outbound: Marking to-device request carrying a room key or a withheld as sent request_id="req1" | crates/matrix-sdk-crypto/src/olm/group_sessions/outbound.rs:457').keys)
      .toMatchObject({ requestId: 'req1' });
    expect(only('2026-09-08T06:55:15.923000Z DEBUG matrix_sdk_crypto::olm::group_sessions::outbound: All m.room_key and withheld to-device requests were sent out, marking session as shared. session_id="SESS" room_id="!r:a.org" | crates/matrix-sdk-crypto/src/olm/group_sessions/outbound.rs:476').keys)
      .toMatchObject({ sessionId: 'SESS', roomId: '!r:a.org' });
  });

  it('event.sent (Element X send_raw span, Element Web message)', () => {
    expect(only('2026-09-08T06:55:16.198000Z  INFO matrix_sdk::room::futures: Sent event in room | crates/matrix-sdk/src/room/futures.rs:243 | spans: send_raw{room_id="!r:a.org" transaction_id="txn1" is_room_encrypted=true event_id="$ev1"}').keys)
      .toMatchObject({ eventId: '$ev1', transactionId: 'txn1', roomId: '!r:a.org' });
    expect(only('2026-09-08T06:55:16.198Z D Event sent to !r:a.org with event id $ev1').keys)
      .toMatchObject({ eventId: '$ev1', roomId: '!r:a.org' });
  });

  it('backup.upload reads the session ids', () => {
    const s = only('2026-09-08T06:55:20.952000Z  INFO matrix_sdk_crypto::backups: Successfully created a room keys backup request key_count=1 keys={"!r:a.org": {"ALICEKEY": {"SESS"}}} backup_key=MegolmV1BackupKey { key: "K", version: Some("1") } | crates/matrix-sdk-crypto/src/backups/mod.rs:539');
    expect(s.kind).toBe('backup.upload');
    expect(s.keys.sessionIds).toEqual(['SESS']);
  });

  it('share.encrypt (Element Web, Rust via crypto-wasm): event fields on the next line', () => {
    const s = only([
      '2026-09-29T07:06:20.700Z I INFO matrix_sdk_crypto::session_manager::group_sessions: Trying to encrypt a room key',
      '    recipients={"@bob:b.org": {"BOBPHONE"}} message_index=0 room_id="!r:a.org" session_id="SESS"',
      WASM_AT,
      '    in matrix_sdk_crypto::session_manager::group_sessions::share_room_key with room_id="!r:a.org"',
    ].join('\n'));
    expect(s.kind).toBe('share.encrypt');
    expect(s.keys).toMatchObject({ sessionId: 'SESS', messageIndex: 0, roomId: '!r:a.org' });
  });

  it('session.rotate from the crypto-wasm fixture', () => {
    const s = only(CRYPTO_WASM_PRETTY_ENTRY);
    expect(s.kind).toBe('session.rotate');
    expect(s.keys.sessionId).toBe('CCJQ');
  });
});

describe('extractSteps — receiver side', () => {
  it('todevice.received (Rust compact and pretty)', () => {
    expect(only('2026-09-08T06:55:21.000000Z DEBUG matrix_sdk_crypto::machine: Received a to-device event | crates/matrix-sdk-crypto/src/machine/mod.rs:1673 | spans: receive_sync_changes > receive_to_device_event{sender="@alice:a.org" event_type="m.room.encrypted" message_id="msg1"}').keys)
      .toMatchObject({ messageId: 'msg1', userId: '@alice:a.org', toDeviceType: 'm.room.encrypted' });
    expect(only([
      '2026-09-08T06:55:21.000Z D DEBUG matrix_sdk_crypto::machine: Received a to-device event',
      WASM_AT,
      '    in matrix_sdk_crypto::machine::receive_to_device_event with sender="@alice:a.org" event_type="m.room.encrypted" message_id="msg1"',
      '    in matrix_sdk_crypto::machine::receive_sync_changes',
    ].join('\n')).keys).toMatchObject({ messageId: 'msg1' });
  });

  it('roomkey.received carries type, first known index and sender key', () => {
    const line = (type: string) => `2026-09-08T06:55:21.010000Z  INFO matrix_sdk_crypto::store: Received a new megolm room key | crates/matrix-sdk-crypto/src/store/mod.rs:703 | spans: receive_to_device_event{sender="@alice:a.org" event_type="m.room.encrypted" message_id="msg1"} > handle_decrypted_to_device_event{sender_key="curve25519:ALICEKEY" event_type="${type}"} > add_room_key{algorithm="m.megolm.v1.aes-sha2"} > handle_key{room_id="!r:a.org" session_id="SESS" message_index=4 shared_history=false}`;
    expect(only(line('m.room_key')).keys).toMatchObject({
      sessionId: 'SESS', roomId: '!r:a.org', firstKnownIndex: 4, toDeviceType: 'm.room_key', senderKey: 'ALICEKEY', userId: '@alice:a.org',
    });
    expect(only(line('m.forwarded_room_key')).keys.toDeviceType).toBe('m.forwarded_room_key');
  });

  it('bundle.received', () => {
    expect(only('2026-09-08T06:55:21.020000Z DEBUG matrix_sdk_crypto::machine: Received a room key bundle event DecryptedOlmV1Event { sender: "@alice:a.org" } | crates/matrix-sdk-crypto/src/machine/mod.rs:1537').kind)
      .toBe('bundle.received');
  });

  it('roomkey.received also covers a merged or upgraded key, not a discarded one', () => {
    const spans = '| crates/matrix-sdk-crypto/src/store/mod.rs:735 | spans: handle_decrypted_to_device_event{sender_key="curve25519:ALICEKEY" event_type="m.forwarded_room_key"} > handle_key{room_id="!r:a.org" session_id="SESS" message_index=0}';
    expect(only(`2026-09-08T06:55:21.010000Z  INFO matrix_sdk_crypto::store: Received a megolm room key that we have a worse version of, merging ${spans}`).kind).toBe('roomkey.received');
    expect(only(`2026-09-08T06:55:21.010000Z  INFO matrix_sdk_crypto::store: Upgrading a previously-received megolm session with new ratchet ${spans}`).keys)
      .toMatchObject({ sessionId: 'SESS', firstKnownIndex: 0, toDeviceType: 'm.forwarded_room_key' });
    expect(stepsOf(`2026-09-08T06:55:21.010000Z  INFO matrix_sdk_crypto::store: Received a megolm room key that we already have, discarding ${spans}`)).toEqual([]);
  });

  it('withheld.received reads session and code from the Debug content', () => {
    const s = only('2026-09-08T06:55:21.030000Z DEBUG matrix_sdk_crypto::machine: Processing `m.room_key.withheld` event content=MegolmV1AesSha2(RoomKeyWithheldContent { room_id: "!r:a.org", session_id: "SESS", code: Unverified }) | crates/matrix-sdk-crypto/src/machine/mod.rs:1117');
    expect(s.keys).toMatchObject({ sessionId: 'SESS', withheldCode: 'Unverified' });
  });

  it('withheld.received for m.no_olm: no session, the sender key and the variant as code', () => {
    const s = only('2026-09-08T06:55:21.030000Z DEBUG matrix_sdk_crypto::machine: Processing `m.room_key.withheld` event event.content=MegolmV1AesSha2(NoOlm(NoOlmWithheldContent { sender_key: "curve25519:ALICEKEY", from_device: Some("ALICEPHONE"), .. })) | crates/matrix-sdk-crypto/src/machine/mod.rs:1117');
    expect(s.keys).toEqual({ senderKey: 'ALICEKEY', withheldCode: 'NoOlm' });
  });

  it('backup.download from the Element X per-session GET: 200 found, 404 not in backup, uploads ignored', () => {
    const send = (method: string, path: string, status: string) =>
      `send{config=RequestConfig { timeout: Some(15s), retry_limit: 3 } request_id="REQ-7" method=${method} uri="https://a.org/_matrix/client/v3/room_keys/keys${path}" status=${status} response_size="838B"}`;
    const steps = stepsOf([
      `2026-09-08T06:55:22.000000Z DEBUG matrix_sdk::http_client: Got response | crates/matrix-sdk/src/http_client/mod.rs:219 | spans: ${send('GET', '/!r:a.org/SE%2FSS', '200')}`,
      `2026-09-08T06:55:23.000000Z ERROR matrix_sdk::http_client: Error while sending request: Api(Server(MatrixError(Error { status_code: 404, body: Standard(StandardErrorBody { kind: NotFound, message: "No room_keys found" }) }))) | crates/matrix-sdk/src/http_client/mod.rs:200 | spans: ${send('GET', '/!r:a.org/SESS2', '404')}`,
      `2026-09-08T06:55:24.000000Z DEBUG matrix_sdk::http_client: Got response | crates/matrix-sdk/src/http_client/mod.rs:219 | spans: ${send('PUT', '', '200')}`,
    ].join('\n'));
    expect(steps.map((s) => [s.kind, s.keys.roomId, s.keys.sessionId, s.keys.ok])).toEqual([
      ['backup.download', '!r:a.org', 'SE/SS', true],
      ['backup.download', '!r:a.org', 'SESS2', false],
    ]);
  });

  it('backup.download (Rust) and the js-sdk per-session downloader outcomes', () => {
    expect(only('2026-09-08T06:55:22.000000Z DEBUG matrix_sdk::encryption::tasks: Performing backup download download_request=RoomKeyDownloadRequest { room_id: "!r:a.org", event_id: "$ev1", session_id: "SESS" } | crates/matrix-sdk/src/encryption/tasks.rs:428').keys)
      .toMatchObject({ sessionId: 'SESS' });
    const web = stepsOf([
      '2026-09-08T06:55:22.131Z D [PerSessionKeyBackupDownloader] Checking key backup for session SESS',
      '2026-09-08T06:55:22.200Z D [PerSessionKeyBackupDownloader] Got key from backup for sessionId:SESS',
      '2026-09-08T06:55:22.242Z I [PerSessionKeyBackupDownloader] No luck requesting key backup for session SESS: M_NOT_FOUND: MatrixError: [404] No room_keys found',
    ].join('\n'));
    expect(web.map((s) => [s.kind, s.keys.sessionId, s.keys.ok])).toEqual([
      ['backup.download', 'SESS', undefined],
      ['backup.download', 'SESS', true],
      ['backup.download', 'SESS', false],
    ]);
  });

  it('backup.imported reads every imported session id', () => {
    const s = only('2026-09-08T15:11:19.458000Z  INFO matrix_sdk_crypto::store: Successfully imported room keys total_count=2 imported_count=2 room_keys={"!r:a.org": {"ALICEKEY": {"SESS", "SESS2"}}} | crates/matrix-sdk-crypto/src/store/mod.rs:1594');
    expect(s.keys.sessionIds).toEqual(['SESS', 'SESS2']);
  });

  it('event.utd (Rust compact): ids, index, sender key, reason', () => {
    const s = only('2026-09-08T06:55:22.130000Z  WARN matrix_sdk_crypto::machine: Failed to decrypt a room event: Can\'t find the room key to decrypt the event, withheld code: None | crates/matrix-sdk-crypto/src/machine/mod.rs:2516 | spans: decrypt_room_event{room_id="!r:a.org" event_id="$ev1" sender="@alice:a.org" sender_key=Some("curve25519:ALICEKEY") session_id="SESS" message_index=0}');
    expect(s.kind).toBe('event.utd');
    expect(s.keys).toMatchObject({
      eventId: '$ev1', roomId: '!r:a.org', sessionId: 'SESS', messageIndex: 0, senderKey: 'ALICEKEY',
      userId: '@alice:a.org', reason: 'missing_key',
      error: "Can't find the room key to decrypt the event, withheld code: None",
    });
  });

  it('event.utd (crypto-wasm pretty) classifies an invalid payload', () => {
    const s = only([
      '2026-09-08T06:55:22.130Z W WARN matrix_sdk_crypto::machine: Failed to decrypt a room event: unexpected end of hex escape at line 1 column 114',
      WASM_AT,
      '    in matrix_sdk_crypto::machine::decrypt_room_event with room_id="!r:a.org" sender="@alice:a.org" event_id="$ev1" origin_server_ts="2026-09-08T06:55:13.756Z" algorithm="m.megolm.v1.aes-sha2" sender_key=Some("curve25519:ALICEKEY") session_id="SESS" message_index=0',
    ].join('\n'));
    expect(s.keys).toMatchObject({ eventId: '$ev1', sessionId: 'SESS', senderKey: 'ALICEKEY', reason: 'invalid_payload' });
  });

  it('history sharing on the receiver: bundle received (room from its content), no bundle, rejected', () => {
    expect(only('2026-09-08T14:11:05.163000Z DEBUG matrix_sdk_crypto::machine: Received a room key bundle event DecryptedOlmV1Event { sender: "@alice:a.org", content: RoomKeyBundleContent { room_id: "!r:a.org", file: EncryptedFile { url: "mxc://a.org/x" } } } | crates/matrix-sdk-crypto/src/machine/mod.rs:1537 | spans: receive_to_device_event{sender="@alice:a.org" event_type="m.room.encrypted" message_id="m9"}').keys)
      .toMatchObject({ roomId: '!r:a.org', userId: '@alice:a.org' });
    expect(only('2026-09-08T11:55:56.483000Z  INFO matrix_sdk::room::shared_room_history: No room key bundle from inviter found | crates/matrix-sdk/src/room/shared_room_history.rs:233 | spans: join_room_by_id{room_id="!r:a.org"} > maybe_accept_key_bundle{inviter="@alice:a.org" room_id="!r:a.org"}'))
      .toMatchObject({ kind: 'bundle.missing', keys: { roomId: '!r:a.org', userId: '@alice:a.org' } });
    expect(only('2026-09-08T11:55:56.483000Z  WARN matrix_sdk_crypto::store: Received a completely empty room key bundle | crates/matrix-sdk-crypto/src/store/mod.rs:1796'))
      .toMatchObject({ kind: 'bundle.rejected', keys: { error: 'Received a completely empty room key bundle' } });
  });

  it('history sharing on the inviter: Rust spans and js-sdk LogSpan prefixes', () => {
    const span = '| crates/matrix-sdk/src/room/shared_room_history.rs:64 | spans: share_room_history{room_id="!r:a.org" user_id="@bob:b.org"}';
    expect(only(`2026-09-08T12:00:00.000000Z  INFO matrix_sdk::room::shared_room_history: Sharing message history ${span}`))
      .toMatchObject({ kind: 'history.shared', role: 'sender', keys: { roomId: '!r:a.org', userId: '@bob:b.org' } });
    expect(only(`2026-09-08T12:00:01.000000Z  INFO matrix_sdk::room::shared_room_history: Uploaded encrypted key blob media_url="mxc://a.org/x" shared_keys=812 withheld_keys=3 ${span}`))
      .toMatchObject({ kind: 'history.uploaded', keys: { roomId: '!r:a.org', count: 812, withheldCount: 3 } });
    expect(only('2026-09-08T12:00:00.000Z I [shareRoomHistoryWithUser(!r:a.org, @bob:b.org)] No keys to share'))
      .toMatchObject({ kind: 'history.not_shared', keys: { roomId: '!r:a.org', userId: '@bob:b.org', error: 'no keys to share' } });
    expect(only('2026-09-08T12:00:00.000Z D Not sharing message history as the room history visibility is currently unshared'))
      .toMatchObject({ kind: 'history.not_shared', keys: { error: 'the room history visibility is currently unshared' } });
  });

  it('when a failed event was sent: Rust origin_server_ts (ISO or epoch ms), js-sdk ts=', () => {
    const rust = (ts: string) => only(`2026-09-08T06:55:22.130000Z  WARN matrix_sdk_crypto::machine: Failed to decrypt a room event: Can't find the room key to decrypt the event, withheld code: None | crates/matrix-sdk-crypto/src/machine/mod.rs:2516 | spans: decrypt_room_event{room_id="!r:a.org" event_id="$ev1" origin_server_ts=${ts} sender="@alice:a.org" session_id="SESS" message_index=0}`).keys.eventTs;
    expect(rust('"2026-01-16T17:05:40.792Z"')).toBe(Date.parse('2026-01-16T17:05:40.792Z') * 1000);
    expect(rust('MilliSecondsSinceUnixEpoch(1768583140792)')).toBe(1768583140792 * 1000);
    expect(only("2026-09-08T06:55:22.132Z W Error decrypting event (id=$ev1 type=m.room.encrypted sender=@alice:a.org room=!r:a.org ts=2024-06-18T15:50:48.756Z): DecryptionError[msg: The sender's device has not sent us the keys for this message., sender_key: ALICEKEY, session_id: SESS]").keys.eventTs)
      .toBe(Date.parse('2024-06-18T15:50:48.756Z') * 1000);
  });

  it('backup state: Rust backups and recovery, iOS recovery, js-sdk backup manager; broken backup', () => {
    const state = (text: string) => only(text).keys;
    expect(state('2026-09-08T11:35:41.445000Z  INFO matrix_sdk::encryption::backups: Backup state changed from Unknown to Enabled | crates/matrix-sdk/src/encryption/backups/mod.rs:546')).toMatchObject({ backupState: 'enabled' });
    expect(state('2026-09-08T11:35:42.380000Z  INFO matrix_sdk::encryption::recovery: Recovery state changed from Unknown to Enabled | crates/matrix-sdk/src/encryption/recovery/mod.rs:698')).toMatchObject({ backupState: 'recovery-enabled' });
    expect(state('2026-09-08T10:24:57.403000Z  INFO elementx: Recovery state changed to: enabled, setting local state to enabled | SecureBackupController.swift:80')).toMatchObject({ backupState: 'recovery-enabled' });
    expect(state('2026-09-08T10:24:57.403Z D [RustBackupManager] Found usable key backup v4: enabling key backups')).toMatchObject({ backupState: 'enabled', backupVersion: '4' });
    expect(state('2026-09-08T10:24:57.403Z D [RustBackupManager] No key backup present on server: disabling key backup')).toMatchObject({ backupState: 'none' });
    expect(state('2026-09-08T10:24:57.403Z D [RustBackupManager] Key backup present on server but not trusted: disabling key backup')).toMatchObject({ backupState: 'untrusted' });
    expect(only("2026-09-08T10:24:57.403Z D [RustBackupManager] Failed to decrypt megolm session from backup The MAC of the ciphertext didn't pass validation").kind).toBe('backup.broken');
  });

  it('room.joined: completing a join on this device', () => {
    expect(only('2026-09-04T11:54:55.127000Z  INFO matrix_sdk::client: Completing room join room_id="!r:a.org" pre_join_room_info=Some(PreJoinRoomInfo { inviter: None }) | crates/matrix-sdk/src/client/mod.rs:1500'))
      .toMatchObject({ kind: 'room.joined', keys: { roomId: '!r:a.org' } });
  });

  it('event.utd (js-sdk Error decrypting event)', () => {
    const s = only("2026-09-08T06:55:22.132Z W Error decrypting event (id=$ev1 type=m.room.encrypted sender=@alice:a.org room=!r:a.org ts=2026-09-08T06:55:13.756Z): DecryptionError[msg: The sender's device has not sent us the keys for this message., sender_key: ALICEKEY, session_id: SESS]");
    expect(s.keys).toMatchObject({
      eventId: '$ev1', userId: '@alice:a.org', roomId: '!r:a.org', senderKey: 'ALICEKEY', sessionId: 'SESS', reason: 'missing_key',
    });
  });

  it('event.redecrypted and redecrypt.failed', () => {
    expect(only('2026-09-08T06:56:00.000Z I Decrypted event on retry (id=$ev1 type=m.room.message sender=@alice:a.org room=!r:a.org ts=2026-09-08T06:55:13.756Z)').keys.eventId)
      .toBe('$ev1');
    expect(only('2026-09-08T06:56:00.000000Z  WARN matrix_sdk::event_cache::redecryptor: Failed to redecrypt an event despite receiving a room key or request to redecrypt event_id="$ev1" | crates/matrix-sdk/src/event_cache/redecryptor.rs:627 | spans: retry_decryption{room_id="!r:a.org" session_id="SESS"}').keys)
      .toMatchObject({ sessionId: 'SESS', eventId: '$ev1' });
    expect(only('2026-10-15T17:41:26.826000Z TRACE matrix_sdk::event_cache::redecryptor: Successfully redecrypted events event_ids={"$ev1", "$ev2"} | crates/matrix-sdk/src/event_cache/redecryptor.rs:741 | spans: retry_decryption_for_events'))
      .toMatchObject({ kind: 'event.redecrypted', keys: { eventIds: ['$ev1', '$ev2'] } });
  });

  it('timeline.handled and utd.reported: what UTD analytics see on Element X', () => {
    expect(only('2026-10-15T17:41:05.824000Z TRACE matrix_sdk_ui::timeline::event_handler: Handling remote event | crates/matrix-sdk-ui/src/timeline/event_handler.rs:653 | spans: live_update_handler{room_id="!r:a.org" focus="live" prefix="live"} > handle_event{event_id="$ev1" position=End { origin: Sync }}'))
      .toMatchObject({ kind: 'timeline.handled', keys: { eventId: '$ev1' } });
    expect(only('2026-10-15T17:41:26.936000Z DEBUG elementx: onUtd for event $ev1, timeToDecryptMs: 21112 |  | spans: build{room_id="!r:a.org"}'))
      .toMatchObject({ kind: 'utd.reported', keys: { eventId: '$ev1', timeToDecryptMs: 21112 } });
    expect(only('2026-10-15T17:42:26.936000Z DEBUG elementx: onUtd for event $ev1, timeToDecryptMs: null |  |').keys.timeToDecryptMs).toBe(-1);
  });

  it('a js-sdk failure is marked as such (Element Web analytics rules)', () => {
    expect(only('2026-09-08T06:55:22.132Z W Error decrypting event (id=$ev1 type=m.room.encrypted sender=@alice:a.org room=!r:a.org ts=2026-09-08T06:55:13.756Z): DecryptionError[msg: x, sender_key: K, session_id: S]').text)
      .toMatch(/^Error decrypting event/);
  });

  it('olm.decrypt_failed and olm.unwedge carry the sender key', () => {
    expect(only('2026-09-08T06:55:21.000000Z  WARN matrix_sdk_crypto::olm::account: Failed to decrypt a non-pre-key message with all available sessions errors_by_olm_session=[] | crates/matrix-sdk-crypto/src/olm/account.rs:1354 | spans: receive_to_device_event{sender="@alice:a.org" event_type="m.room.encrypted" message_id="msg1"} > decrypt_olm_v1{sender="@alice:a.org" sender_key="curve25519:ALICEKEY"}').keys)
      .toMatchObject({ senderKey: 'ALICEKEY', userId: '@alice:a.org', messageId: 'msg1' });
    expect(only('2026-09-08T06:55:21.000000Z  INFO matrix_sdk_crypto::session_manager::sessions: Marking session to be unwedged sender_key="curve25519:ALICEKEY" | crates/matrix-sdk-crypto/src/session_manager/sessions.rs:112').keys.senderKey)
      .toBe('ALICEKEY');
  });

  it('olm and key-request housekeeping rows; Olm sessions established and /keys/query attach to no session, so are not steps', () => {
    const kinds = stepsOf([
      '2026-09-08T06:55:21.000000Z  INFO matrix_sdk_crypto::session_manager::sessions: Established new Olm sessions sessions={} | crates/matrix-sdk-crypto/src/session_manager/sessions.rs:562',
      '2026-09-08T06:55:21.001000Z DEBUG matrix_sdk_crypto::session_manager::sessions: Received a `/keys/claim` response request_id="c1" | crates/matrix-sdk-crypto/src/session_manager/sessions.rs:450',
      '2026-09-08T06:55:21.002000Z DEBUG matrix_sdk_crypto::identities::manager: Handling a `/keys/query` response | crates/matrix-sdk-crypto/src/identities/manager.rs:135',
      '2026-09-08T06:55:21.003000Z DEBUG matrix_sdk_crypto::gossiping::machine: Serving a room key request | crates/matrix-sdk-crypto/src/gossiping/machine.rs:495 | spans: handle_supported_key_request{user_id="@bob:b.org" device_id="BOBPHONE" room_id="!r:a.org" session_id="SESS"}',
    ].join('\n')).map((s) => s.kind);
    expect(kinds).toEqual(['olm.claim', 'keyrequest.served']);
  });

  it('olm.claim keeps why an Olm session could not be created, and with whom', () => {
    expect(only('2026-09-08T06:55:21.000000Z  WARN matrix_sdk_crypto::session_manager::sessions: Error creating Olm session user_id="@bob:b.org" device_id="BOBPHONE" error=InvalidSignature { one_time_key: SignedKey { key: "curve25519:X" } } | crates/matrix-sdk-crypto/src/session_manager/sessions.rs:530').keys)
      .toEqual({ userId: '@bob:b.org', deviceId: 'BOBPHONE', error: 'InvalidSignature' });
  });

  it('ignores lines that are not crypto steps', () => {
    expect(stepsOf('2026-09-08T06:55:21.000000Z  INFO matrix_sdk::sync: nothing to see | crates/x.rs:1')).toEqual([]);
  });

  it('tags merged lines with their own source file', () => {
    const [line] = parseLogFile("2026-09-08T06:55:22.132Z W Error decrypting event (id=$ev1 type=m.room.encrypted sender=@alice:a.org room=!r:a.org ts=2026-09-08T06:55:13.756Z): DecryptionError[msg: x, sender_key: K, session_id: S]").rawLogLines;
    const [s] = extractSteps([{ ...line, sourceFile: 'logs-0003.log.gz' }], SRC);
    expect(s.line.file).toBe('logs-0003.log.gz');
  });
});

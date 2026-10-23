/**
 * Synthetic sender/receiver logs in Element X (Rust compact) format, modelled on
 * the wording of real rageshakes. Alice's ALICEPHONE shares session SESS with
 * Bob's BOBLAPTOP only; Bob's BOBPHONE gets a UTD for $ev1.
 */
import type { ArchiveEntry } from '../../../stores/archiveStore';

const SEND_RAW = 'send_raw{room_id="!r:a.org" transaction_id="txn1" is_room_encrypted=true}';

export const SENDER_LOG = [
  `2026-09-08T06:55:14.024000Z  INFO matrix_sdk_crypto::session_manager::group_sessions: Trying to encrypt a room key recipients={"@bob:b.org": {"BOBLAPTOP"}} message_index=0 room_id="!r:a.org" | crates/matrix-sdk-crypto/src/session_manager/group_sessions/mod.rs:486 | spans: ${SEND_RAW} > share_room_key{session_id="SESS"}`,
  `2026-09-08T06:55:14.082000Z  INFO matrix_sdk_crypto::session_manager::group_sessions: Created batch of to-device messages of type m.room.encrypted request_id="req1" message_list=[("msg1", "@bob:b.org", "BOBLAPTOP")] | crates/matrix-sdk-crypto/src/session_manager/group_sessions/mod.rs:631 | spans: ${SEND_RAW} > share_room_key{session_id="SESS"}`,
  '2026-09-08T06:55:15.914000Z DEBUG matrix_sdk::http_client: Got response | crates/matrix-sdk/src/http_client/mod.rs:197 | spans: send{request_id="REQ-1" method=PUT uri="https://a.org/_matrix/client/v3/sendToDevice/m.room.encrypted/req1" request_size="2B" status=200 response_size="2B"}',
  '2026-09-08T06:55:15.923000Z DEBUG matrix_sdk_crypto::olm::group_sessions::outbound: All m.room_key and withheld to-device requests were sent out, marking session as shared. session_id="SESS" room_id="!r:a.org" | crates/matrix-sdk-crypto/src/olm/group_sessions/outbound.rs:476',
  '2026-09-08T06:55:16.198000Z  INFO matrix_sdk::room::futures: Sent event in room | crates/matrix-sdk/src/room/futures.rs:243 | spans: send_raw{room_id="!r:a.org" transaction_id="txn1" is_room_encrypted=true event_id="$ev1"}',
].join('\n');

export const RECEIVER_LOG = [
  '2026-09-08T06:55:10.000000Z  INFO matrix_sdk::sync: sync started | crates/matrix-sdk/src/sync.rs:1',
  '2026-09-08T06:55:22.130000Z  WARN matrix_sdk_crypto::machine: Failed to decrypt a room event: Can\'t find the room key to decrypt the event, withheld code: None | crates/matrix-sdk-crypto/src/machine/mod.rs:2516 | spans: decrypt_room_event{room_id="!r:a.org" event_id="$ev1" sender="@alice:a.org" sender_key=Some("curve25519:ALICEKEY") session_id="SESS" message_index=0}',
  '2026-09-08T06:58:00.000000Z  INFO matrix_sdk::sync: still syncing | crates/matrix-sdk/src/sync.rs:1',
].join('\n');

/** A second UTD on BOBPHONE, for session SESS2, fixed 20s later by a late m.room_key. */
export const RECEIVER_LATE_LINES = [
  '2026-09-08T06:59:00.000000Z  WARN matrix_sdk_crypto::machine: Failed to decrypt a room event: Can\'t find the room key to decrypt the event, withheld code: None | crates/matrix-sdk-crypto/src/machine/mod.rs:2516 | spans: decrypt_room_event{room_id="!r:a.org" event_id="$ev2" sender="@alice:a.org" sender_key=Some("curve25519:ALICEKEY") session_id="SESS2" message_index=0}',
  '2026-09-08T06:59:20.000000Z  INFO matrix_sdk_crypto::store: Received a new megolm room key | crates/matrix-sdk-crypto/src/store/mod.rs:703 | spans: receive_to_device_event{sender="@alice:a.org" event_type="m.room.encrypted" message_id="msg9"} > handle_decrypted_to_device_event{sender_key="curve25519:ALICEKEY" event_type="m.room_key"} > add_room_key{algorithm="m.megolm.v1.aes-sha2"} > handle_key{room_id="!r:a.org" session_id="SESS2" message_index=0 shared_history=false}',
].join('\n');

export const SENDER_DETAILS = JSON.stringify({
  user_text: 'I sent a UTD',
  data: { user_id: '@alice:a.org', device_id: 'ALICEPHONE', device_keys: 'curve25519:ALICEKEY, ed25519:ALICEED' },
});

export const RECEIVER_DETAILS = JSON.stringify({
  user_text: 'UTD from alice',
  data: { user_id: '@bob:b.org', device_id: 'BOBPHONE', device_keys: 'curve25519:BOBKEY, ed25519:BOBED' },
});

/** An uncompressed archive entry (no `.gz`, so no decompression). */
export function entry(name: string, text: string): ArchiveEntry {
  return { name, data: new TextEncoder().encode(text) };
}

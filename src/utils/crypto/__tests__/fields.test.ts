import { describe, it, expect } from 'vitest';
import { parseLogFile } from '../../logParser';
import {
  fieldIn, field, spanField, intField, curveKey, stringsAtDepth, parseRecipients, parseMessageList,
} from '../fields';

const one = (text: string) => parseLogFile(text).rawLogLines[0];

const RUST =
  '2026-09-08T06:55:14.024000Z  INFO matrix_sdk_crypto::session_manager::group_sessions: Trying to encrypt a room key message_index=0 room_id="!r:a.org" | crates/matrix-sdk-crypto/src/session_manager/group_sessions/mod.rs:486 | spans: send_raw{room_id="!r:a.org" transaction_id="txn1"} > share_room_key{session_id="SESS"}';

const WEB = [
  '2026-09-08T06:55:14.024Z D DEBUG matrix_sdk_crypto::session_manager::group_sessions: Trying to encrypt a room key',
  '    message_index=3 room_id="!r:a.org"',
  '    at /home/runner/.cargo/git/checkouts/matrix-rust-sdk-5cafb5792f78b8d1/f333a32/crates/matrix-sdk-crypto/src/session_manager/group_sessions/mod.rs:486',
  '    in matrix_sdk_crypto::session_manager::group_sessions::share_room_key with session_id="SESS"',
  '    in matrix_sdk::room::send_raw with transaction_id="txn9"',
].join('\n');

describe('fieldIn', () => {
  it('reads a quoted value', () => {
    expect(fieldIn('a x="1 2" y=3', 'x')).toBe('1 2');
  });
  it('reads a balanced nested value', () => {
    expect(fieldIn('r={"@u:d": {"A", "B"}} n=1', 'r')).toBe('{"@u:d": {"A", "B"}}');
  });
  it('does not match a longer key', () => {
    expect(fieldIn('old_session_id="A" session_id="B"', 'session_id')).toBe('B');
  });
  it('stops at the closing brace of the enclosing span', () => {
    expect(fieldIn('share_room_key{session_id="S"}', 'session_id')).toBe('S');
  });
  it('returns undefined when absent', () => {
    expect(fieldIn('a=1', 'b')).toBeUndefined();
  });
});

describe('field / spanField', () => {
  it('reads event fields, then span fields (Rust compact)', () => {
    const line = one(RUST);
    expect(field(line, 'message_index')).toBe('0');
    expect(field(line, 'room_id')).toBe('!r:a.org');
    expect(field(line, 'session_id')).toBe('SESS');
    expect(spanField(line, 'send_raw', 'transaction_id')).toBe('txn1');
  });
  it('reads continuation-line fields and `in` spans (Element Web pretty)', () => {
    const line = one(WEB);
    expect(field(line, 'message_index')).toBe('3');
    expect(field(line, 'session_id')).toBe('SESS');
    expect(spanField(line, 'send_raw', 'transaction_id')).toBe('txn9');
  });
  it('returns undefined for an absent span', () => {
    expect(spanField(one(RUST), 'nope', 'x')).toBeUndefined();
    expect(field(one(RUST), 'nope')).toBeUndefined();
  });
});

describe('value parsers', () => {
  it('intField', () => {
    expect(intField('0')).toBe(0);
    expect(intField('x')).toBeUndefined();
    expect(intField(undefined)).toBeUndefined();
  });
  it('curveKey unwraps Some("curve25519:…") and plain forms', () => {
    expect(curveKey('Some("curve25519:abc+/=")')).toBe('abc+/=');
    expect(curveKey('curve25519:xyz')).toBe('xyz');
    expect(curveKey('xyz')).toBe('xyz');
    expect(curveKey(undefined)).toBeUndefined();
    expect(curveKey('None')).toBeUndefined();
  });
  it('stringsAtDepth reads session ids out of a room → sender key → sessions map', () => {
    expect(stringsAtDepth('{"!r": {"K": {"S1", "S2"}}}', 3)).toEqual(['S1', 'S2']);
    expect(stringsAtDepth(undefined, 3)).toEqual([]);
  });
  it('parseRecipients pairs users with their devices', () => {
    expect(parseRecipients('{"@a:d": {"A1", "A2"}, "@b:d": {"B1"}}')).toEqual([
      ['@a:d', 'A1'], ['@a:d', 'A2'], ['@b:d', 'B1'],
    ]);
    expect(parseRecipients(undefined)).toEqual([]);
  });
  it('parseMessageList reads (msgid, user, device) tuples', () => {
    expect(parseMessageList('[("m1", "@a:d", "A1"), ("m2", "@b:d", "B1")]')).toEqual([
      { messageId: 'm1', userId: '@a:d', deviceId: 'A1' },
      { messageId: 'm2', userId: '@b:d', deviceId: 'B1' },
    ]);
    expect(parseMessageList(undefined)).toEqual([]);
  });
});

import type { CryptoStep, UtdReason } from './types';

/**
 * Sort a UTD failure text (Rust `Failed to decrypt a room event: {e}` or the
 * js-sdk `DecryptionError[msg: …]`) into a reason class, so failures worded by
 * different SDKs count together.
 *
 * @example classifyUtd("Can't find the room key to decrypt the event") // 'missing_key'
 */
export function classifyUtd(error: string): UtdReason {
  if (/unknown message index/i.test(error)) return 'unknown_index';
  if (/room key to decrypt|has not sent us the keys|MissingRoomKey|withheld/i.test(error)) return 'missing_key';
  if (/trust requirement/i.test(error)) return 'trust_requirement';
  // serde_json errors end with "at line N column M": the plaintext decrypted but did not parse.
  if (/at line \d+ column \d+|EOF while parsing|invalid type|missing field/i.test(error)) return 'invalid_payload';
  return 'other';
}

/**
 * The withheld code of a failure, so a withheld key reads as the sender's choice.
 *
 * @example withheldCode('…, withheld code: Some(Unverified)') // 'Unverified'
 */
export function withheldCode(error: string): string | undefined {
  return /withheld code: Some\(([^)]+)\)/.exec(error)?.[1];
}

/**
 * The failure of one event that says what fails now: the latest with a specific
 * reason (a key that arrived turns a missing key into, say, a bad payload), else
 * the first. One rule, so /archive's counts and /decryption's model agree.
 *
 * @example decisiveFailure([missingKeyAt10s, badPayloadAt20s, otherAt30s]) // badPayloadAt20s
 */
export function decisiveFailure(failures: readonly CryptoStep[]): CryptoStep {
  for (let i = failures.length - 1; i >= 0; i--) {
    const r = failures[i].keys.reason;
    if (r && r !== 'other') return failures[i];
  }
  return failures[0];
}

import { describe, it, expect } from 'vitest';
import { classifyUtd, withheldCode } from '../classifyUtd';

describe('classifyUtd', () => {
  it.each([
    ["Can't find the room key to decrypt the event, withheld code: None", 'missing_key'],
    ["The sender's device has not sent us the keys for this message.", 'missing_key'],
    ['The message was encrypted using an unknown message index, first known index 5, index of the message 2', 'unknown_index'],
    ['decryption failed because trust requirement not satisfied: unverified', 'trust_requirement'],
    ['unexpected end of hex escape at line 1 column 114', 'invalid_payload'],
    ['something else entirely', 'other'],
  ])('%s → %s', (error, reason) => {
    expect(classifyUtd(error)).toBe(reason);
  });
});

describe('withheldCode', () => {
  it('reads Some(code)', () => {
    expect(withheldCode("Can't find the room key to decrypt the event, withheld code: Some(Unverified)")).toBe('Unverified');
  });
  it('is undefined for None', () => {
    expect(withheldCode("Can't find the room key to decrypt the event, withheld code: None")).toBeUndefined();
  });
});

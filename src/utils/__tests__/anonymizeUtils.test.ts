import { describe, it, expect } from 'vitest';
import {
  ANONYMIZED_LOG_MARKER,
  buildAnonymizationDictionary,
  buildAnonymizationDictionaryFromTexts,
  applyAnonymization,
  applyUnanonymization,
  anonymizeLogLine,
  unanonymizeLogLine,
  detectAnonymizedLog,
  stripAnonymizedMarker,
  buildCompiledUnanonymizer,
  decodeIdentifier,
} from '../anonymizeUtils';
import type { AnonymizationDictionary } from '../../types/log.types';
import { createParsedLogLine } from '../../test/fixtures';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Salt used across tests. Aliases are salt-dependent, so tests assert on the
 *  hash *format* (and round-trips) rather than exact hash values. */
const SALT = 'test-salt';

// Alias formats produced by the hash-based builder (see buildAnonymizationDictionary).
const USER_RE = /^@user-[0-9a-f]{12}:domain-[0-9a-f]{8}\.org$/;
const ROOM_ALIAS_RE = /^#room_alias-[0-9a-f]{12}:domain-[0-9a-f]{8}\.org$/;
const ROOM_RE = /^!room-[0-9a-f]{12}:domain-[0-9a-f]{8}\.org$/;
const ROOM_MODERN_RE = /^!room-[0-9a-f]{12}$/;
const EVENT_RE = /^\$event-[0-9a-f]{12}:domain-[0-9a-f]{8}\.org$/;
const EVENT_MODERN_RE = /^\$event-[0-9a-f]{12}$/;
const DOMAIN_RE = /^domain-[0-9a-f]{8}\.org$/;

/** Build a minimal ParsedLogLine whose rawText contains the given message. */
function makeLine(lineNumber: number, message: string) {
  return createParsedLogLine({
    lineNumber,
    rawText: `2024-01-15T10:00:00.000000Z INFO ${message}`,
    message: `2024-01-15T10:00:00.000000Z INFO ${message}`,
    strippedMessage: message,
  });
}

// ---------------------------------------------------------------------------
// buildAnonymizationDictionary — identifier detection
// ---------------------------------------------------------------------------

describe('buildAnonymizationDictionary', () => {
  it('produces empty maps for logs with no Matrix identifiers', async () => {
    const dict = await buildAnonymizationDictionary([makeLine(0, 'hello world no ids here')], SALT);
    expect(dict.forward).toEqual({});
    expect(dict.reverse).toEqual({});
  });

  it('replaces a user ID with the @user-<hash>:domain-<hash>.org format', async () => {
    const dict = await buildAnonymizationDictionary([makeLine(0, '@alice:matrix.example.org joined')], SALT);
    const alias = dict.forward['@alice:matrix.example.org'];
    expect(alias).toMatch(USER_RE);
    expect(dict.reverse[alias]).toBe('@alice:matrix.example.org');
  });

  it('assigns the same alias when the same user ID appears multiple times', async () => {
    const dict = await buildAnonymizationDictionary([
      makeLine(0, '@alice:example.org sent a message'),
      makeLine(1, '@alice:example.org sent another message'),
    ], SALT);
    const userAliases = Object.values(dict.forward).filter((v) => v.startsWith('@user'));
    expect(userAliases.length).toBe(1);
    expect(userAliases[0]).toMatch(USER_RE);
  });

  it('assigns different aliases for different user IDs, sharing the domain', async () => {
    const dict = await buildAnonymizationDictionary([
      makeLine(0, '@alice:example.org and @bob:example.org'),
    ], SALT);
    const alice = dict.forward['@alice:example.org'];
    const bob = dict.forward['@bob:example.org'];
    expect(alice).toMatch(USER_RE);
    expect(bob).toMatch(USER_RE);
    expect(alice).not.toBe(bob);
    // Same server → same domain component.
    expect(alice.split(':')[1]).toBe(bob.split(':')[1]);
  });

  it('replaces a room alias with the #room_alias-<hash>:domain-<hash>.org format', async () => {
    const dict = await buildAnonymizationDictionary([makeLine(0, '#general:example.org')], SALT);
    const alias = dict.forward['#general:example.org'];
    expect(alias).toMatch(ROOM_ALIAS_RE);
    expect(dict.reverse[alias]).toBe('#general:example.org');
  });

  it('replaces a room ID (with domain) with the !room-<hash>:domain-<hash>.org format', async () => {
    const dict = await buildAnonymizationDictionary([makeLine(0, '!abc123:example.org')], SALT);
    const alias = dict.forward['!abc123:example.org'];
    expect(alias).toMatch(ROOM_RE);
    expect(dict.reverse[alias]).toBe('!abc123:example.org');
  });

  it('replaces a modern room ID (no domain, min 10 chars) with !room-<hash>', async () => {
    const dict = await buildAnonymizationDictionary([makeLine(0, '!VkdmKnrz9stD0mzv2QrS3sP joined')], SALT);
    const alias = dict.forward['!VkdmKnrz9stD0mzv2QrS3sP'];
    expect(alias).toMatch(ROOM_MODERN_RE);
    expect(dict.reverse[alias]).toBe('!VkdmKnrz9stD0mzv2QrS3sP');
  });

  it('replaces an event ID (with domain) with the $event-<hash>:domain-<hash>.org format', async () => {
    const dict = await buildAnonymizationDictionary([makeLine(0, '$ev1:example.org')], SALT);
    const alias = dict.forward['$ev1:example.org'];
    expect(alias).toMatch(EVENT_RE);
    expect(dict.reverse[alias]).toBe('$ev1:example.org');
  });

  it('replaces a modern event ID (no domain, min 10 chars) with $event-<hash>', async () => {
    const dict = await buildAnonymizationDictionary([makeLine(0, '$VkdmKnrz9stD0mzv2QrS3sP redacted')], SALT);
    const alias = dict.forward['$VkdmKnrz9stD0mzv2QrS3sP'];
    expect(alias).toMatch(EVENT_MODERN_RE);
    expect(dict.reverse[alias]).toBe('$VkdmKnrz9stD0mzv2QrS3sP');
  });

  it('shares the same domain alias across different identifier types', async () => {
    const dict = await buildAnonymizationDictionary([
      makeLine(0, '@alice:example.org in !room1:example.org'),
    ], SALT);
    const domain = dict.forward['example.org'];
    expect(domain).toMatch(DOMAIN_RE);
    // Both @alice and !room1 reference example.org → same domain component.
    expect(dict.forward['@alice:example.org'].split(':')[1]).toBe(domain);
    expect(dict.forward['!room1:example.org'].split(':')[1]).toBe(domain);
  });

  it('registers the bare domain so standalone occurrences are replaced', async () => {
    const dict = await buildAnonymizationDictionary([
      makeLine(0, '@alice:matrix.example.org did something on matrix.example.org'),
    ], SALT);
    expect(dict.forward['matrix.example.org']).toMatch(DOMAIN_RE);
  });

  it('handles port-bearing server names with bijective dictionary', async () => {
    const dict = await buildAnonymizationDictionary([makeLine(0, '@alice:example.org:8448')], SALT);
    const bareDomain = dict.forward['example.org'];
    expect(bareDomain).toMatch(DOMAIN_RE);
    // Port-bearing variant gets its own forward + reverse entry for bijectivity.
    expect(dict.forward['example.org:8448']).toBe(`${bareDomain}:8448`);
    expect(dict.reverse[`${bareDomain}:8448`]).toBe('example.org:8448');
    // The user ID also gets the port alias: hashed user token + the ported domain.
    const userAlias = dict.forward['@alice:example.org:8448'];
    expect(userAlias).toMatch(/^@user-[0-9a-f]{12}:/);
    expect(userAlias.endsWith(`:${bareDomain}:8448`)).toBe(true);
    expect(dict.reverse[userAlias]).toBe('@alice:example.org:8448');
  });

  it('handles user IDs with uppercase letters in the localpart (legacy servers)', async () => {
    const dict = await buildAnonymizationDictionary([makeLine(0, '@Bob:matrix.org and @ALICE:matrix.org')], SALT);
    const bob = dict.forward['@Bob:matrix.org'];
    const alice = dict.forward['@ALICE:matrix.org'];
    expect(bob).toMatch(USER_RE);
    expect(alice).toMatch(USER_RE);
    expect(bob).not.toBe(alice);
  });

  it('scans continuation lines for identifiers', async () => {
    const line = createParsedLogLine({
      lineNumber: 0,
      rawText: '2024-01-15T10:00:00.000000Z ERROR error detail',
      message: '2024-01-15T10:00:00.000000Z ERROR error detail',
      strippedMessage: 'error detail',
      continuationLines: ['  user @alice:example.org was involved'],
    });
    const dict = await buildAnonymizationDictionary([line], SALT);
    expect(dict.forward['@alice:example.org']).toMatch(USER_RE);
  });

  it('is deterministic: same input + salt yields identical aliases', async () => {
    const lines = [makeLine(0, '@alice:matrix.org in !room1:matrix.org via #general:matrix.org')];
    const a = await buildAnonymizationDictionary(lines, 'team-secret');
    const b = await buildAnonymizationDictionary(lines, 'team-secret');
    expect(a.forward).toEqual(b.forward);
    expect(a.reverse).toEqual(b.reverse);
  });

  it('salt sensitivity: a different salt produces a different alias', async () => {
    const lines = [makeLine(0, '@alice:matrix.org')];
    const a = await buildAnonymizationDictionary(lines, 'salt-a');
    const b = await buildAnonymizationDictionary(lines, 'salt-b');
    expect(a.forward['@alice:matrix.org']).not.toBe(b.forward['@alice:matrix.org']);
  });

  it('buildAnonymizationDictionaryFromTexts builds from raw strings across blobs', async () => {
    const dict = await buildAnonymizationDictionaryFromTexts(
      ['@alice:matrix.org joined', 'later @bob:matrix.org left'],
      SALT,
    );
    expect(dict.forward['@alice:matrix.org']).toMatch(USER_RE);
    expect(dict.forward['@bob:matrix.org']).toMatch(USER_RE);
    // same server → shared domain component
    expect(dict.forward['@alice:matrix.org'].split(':')[1]).toBe(
      dict.forward['@bob:matrix.org'].split(':')[1],
    );
  });

  it('gives an identifier inside a permalink the same alias as the bare identifier', async () => {
    // Regression: the room-alias pattern swallowed the URL fragment, so
    // `matrix.to/#/!room1:…` registered `#/!room1:…` as a separate room alias.
    const dict = await buildAnonymizationDictionaryFromTexts([
      '!room1:example.org #lobby:example.org',
      'https://matrix.to/#/!room1:example.org https://matrix.to/#/#lobby:example.org',
      'https://app.element.io/#/room/!room1:example.org',
      'element-call/index.html#?roomId=!room1:example.org',
    ], SALT);
    expect(Object.keys(dict.forward).sort()).toEqual(['!room1:example.org', '#lobby:example.org', 'example.org']);
    expect(applyAnonymization('https://matrix.to/#/!room1:example.org', dict))
      .toBe(`https://matrix.to/#/${dict.forward['!room1:example.org']}`);
  });
});

describe('buildAnonymizationDictionary — percent-encoded identifiers', () => {
  /** Assert `encoded` got the alias of `plain`, written back in `encoded`'s shape
   *  (same sigil spelling, no literal `:`). Checked through the decoder, so the
   *  test does not re-implement the encoding. */
  function expectLinked(dict: AnonymizationDictionary, encoded: string, plain: string) {
    const alias = dict.forward[encoded];
    expect(dict.forward[plain]).toBeDefined();
    expect(decodeIdentifier(alias)).toBe(dict.forward[plain]);
    expect(alias[0]).toBe(encoded[0]);
    expect(alias).not.toContain(':');
  }

  it('maps an encoded identifier to the encoded alias of the plain identifier', async () => {
    const dict = await buildAnonymizationDictionaryFromTexts([
      '@alice:example.org !room1:example.org #lobby:example.org $event1:example.org',
      '?userId=%40alice%3Aexample.org&roomId=%21room1%3Aexample.org',
      'https://matrix.to/#/%23lobby%3Aexample.org/%24event1%3Aexample.org',
    ], SALT);
    expectLinked(dict, '%40alice%3Aexample.org', '@alice:example.org');
    expectLinked(dict, '%21room1%3Aexample.org', '!room1:example.org');
    expectLinked(dict, '%23lobby%3Aexample.org', '#lobby:example.org');
    expectLinked(dict, '%24event1%3Aexample.org', '$event1:example.org');
    expect(dict.forward['%21room1%3Aexample.org']).toMatch(/^%21room-[0-9a-f]{12}%3Adomain-[0-9a-f]{8}\.org$/);
  });

  it('decodes escaped localpart characters and ports before hashing', async () => {
    // Modern (domainless) room ids are base64: `+` and `/` arrive as %2B / %2F.
    const dict = await buildAnonymizationDictionaryFromTexts([
      '!AbCdEf+gh/IjKl @bob:example.org:8448',
      'roomId=%21AbCdEf%2Bgh%2FIjKl userId=%40bob%3Aexample.org%3A8448',
    ], SALT);
    expectLinked(dict, '%21AbCdEf%2Bgh%2FIjKl', '!AbCdEf+gh/IjKl');
    expectLinked(dict, '%40bob%3Aexample.org%3A8448', '@bob:example.org:8448');
  });

  it('links an unescaped `!` sigil followed by an encoded colon', async () => {
    // encodeURIComponent and Android Uri.encode leave `!` as is.
    const text = '!abcdefghijklmnop:example.org roomId=!abcdefghijklmnop%3Aexample.org';
    const dict = await buildAnonymizationDictionaryFromTexts([text], SALT);
    expectLinked(dict, '!abcdefghijklmnop%3Aexample.org', '!abcdefghijklmnop:example.org');
    const anonymized = applyAnonymization(text, dict);
    expect(applyUnanonymization(anonymized, dict)).toBe(text);
    expect(buildCompiledUnanonymizer(dict)(anonymized)).toBe(text);
  });

  it('links double-encoded identifiers (an encoded URL inside a URL)', async () => {
    const text = '!room1:example.org returnUrl=https%253A%252F%252Fx.org%253FroomId%253D%2521room1%253Aexample.org';
    const dict = await buildAnonymizationDictionaryFromTexts([text], SALT);
    const alias = dict.forward['%2521room1%253Aexample.org'];
    expect(decodeIdentifier(alias)).toBe(dict.forward['!room1:example.org']);
    expect(alias.startsWith('%2521room-')).toBe(true);
    const anonymized = applyAnonymization(text, dict);
    expect(anonymized).not.toContain('room1');
    expect(applyUnanonymization(anonymized, dict)).toBe(text);
  });

  it('anonymizes an encoded identifier seen only in its encoded form', async () => {
    const text = 'index.html#?userId=%40alice%3Aexample.org&roomId=%21room1%3Aexample.org&widgetId=w1';
    const dict = await buildAnonymizationDictionaryFromTexts([text], SALT);
    const anonymized = applyAnonymization(text, dict);
    expect(anonymized).not.toContain('alice');
    expect(anonymized).not.toContain('room1');
    expect(applyUnanonymization(anonymized, dict)).toBe(text);
    expect(buildCompiledUnanonymizer(dict)(anonymized)).toBe(text);
    // Only what the text holds is in the dictionary, not the decoded spellings.
    expect(Object.keys(dict.forward).sort()).toEqual(['%21room1%3Aexample.org', '%40alice%3Aexample.org', 'example.org']);
  });

  it('never runs an encoded match across URL separators or fragments', async () => {
    const dict = await buildAnonymizationDictionaryFromTexts([
      '!abcdefghijklmnop:example.org @alice:example.org',
      // `#/room/!id` nested in an encoded URL is a fragment, not a room alias.
      'parentUrl=https%3A%2F%2Fapp.element.io%2F%23%2Froom%2F%21abcdefghijklmnop%3Aexample.org',
      // `&` and `=` end the room id: alice is a separate identifier.
      'roomId=%21x%26userId%3D%40alice%3Aexample.org',
    ], SALT);
    expectLinked(dict, '%21abcdefghijklmnop%3Aexample.org', '!abcdefghijklmnop:example.org');
    expectLinked(dict, '%40alice%3Aexample.org', '@alice:example.org');
    expect(Object.keys(dict.forward).filter((k) => k.startsWith('%23'))).toEqual([]);
  });

  it('leaves URL-encoded prose containing `!` or `$` alone', async () => {
    const text = 'msg=Hi%21%20How%20are%20you%20doing price=%2410%20000%20000%20000';
    const dict = await buildAnonymizationDictionaryFromTexts([text], SALT);
    expect(dict.forward).toEqual({});
  });

  it('accepts only the localpart characters the plain pattern accepts', async () => {
    // `~` is legal in a room ID but not in a user ID; non-ASCII only in an alias.
    const dict = await buildAnonymizationDictionaryFromTexts([
      '@alice~bob:example.org userId=%40alice~bob%3Aexample.org',
      '!r%C3%A9:example.org roomId=%21r%C3%A9%3Aexample.org',
    ], SALT);
    expect(dict.forward).toEqual({});
    const linked = await buildAnonymizationDictionaryFromTexts([
      '!a~b:example.org roomId=%21a~b%3Aexample.org',
      '#caf%C3%A9:example.org alias=%23caf%C3%A9%3Aexample.org',
    ], SALT);
    expectLinked(linked, '%21a~b%3Aexample.org', '!a~b:example.org');
    expectLinked(linked, '%23caf%C3%A9%3Aexample.org', '#caf%C3%A9:example.org');
  });

  it('matches encoded IPv6 server names', async () => {
    const dict = await buildAnonymizationDictionaryFromTexts(['!room1:[::1] roomId=%21room1%3A%5B%3A%3A1%5D'], SALT);
    expectLinked(dict, '%21room1%3A%5B%3A%3A1%5D', '!room1:[::1]');
  });

  it('accepts two spellings of the same encoded identifier', async () => {
    // `%3a` vs `%3A` decode to the same id: one alias, not a collision error.
    const dict = await buildAnonymizationDictionaryFromTexts(['%21room1%3Aexample.org %21room1%3aexample.org'], SALT);
    expect(dict.forward['%21room1%3aexample.org']).toBe(dict.forward['%21room1%3Aexample.org']);
  });
});

// ---------------------------------------------------------------------------
// applyAnonymization / applyUnanonymization
// ---------------------------------------------------------------------------

describe('applyAnonymization', () => {
  it('replaces known identifiers in text', async () => {
    const dict = await buildAnonymizationDictionary([makeLine(0, '@alice:example.org')], SALT);
    const alias = dict.forward['@alice:example.org'];
    const result = applyAnonymization('user @alice:example.org logged in', dict);
    expect(result).toBe(`user ${alias} logged in`);
  });

  it('replaces all occurrences in a single string', async () => {
    const dict = await buildAnonymizationDictionary([makeLine(0, '@alice:example.org')], SALT);
    const alias = dict.forward['@alice:example.org'];
    const result = applyAnonymization('@alice:example.org and @alice:example.org', dict);
    expect(result).toBe(`${alias} and ${alias}`);
  });

  it('replaces standalone domain when it was seen inside a Matrix identifier', async () => {
    const dict = await buildAnonymizationDictionary([makeLine(0, '@alice:example.org')], SALT);
    const domain = dict.forward['example.org'];
    const result = applyAnonymization('connected to example.org server', dict);
    expect(result).toBe(`connected to ${domain} server`);
  });

  it('does not modify text with no known identifiers', async () => {
    const dict = await buildAnonymizationDictionary([makeLine(0, '@alice:example.org')], SALT);
    const result = applyAnonymization('nothing relevant here', dict);
    expect(result).toBe('nothing relevant here');
  });

  it('handles empty text', async () => {
    const dict = await buildAnonymizationDictionary([makeLine(0, '@alice:example.org')], SALT);
    expect(applyAnonymization('', dict)).toBe('');
  });
});

describe('applyUnanonymization', () => {
  it('restores original identifiers from aliases', async () => {
    const dict = await buildAnonymizationDictionary([makeLine(0, '@alice:example.org')], SALT);
    const anonymized = applyAnonymization('@alice:example.org', dict);
    const restored = applyUnanonymization(anonymized, dict);
    expect(restored).toBe('@alice:example.org');
  });

  it('restores multiple different identifiers', async () => {
    const dict = await buildAnonymizationDictionary([
      makeLine(0, '@alice:example.org in !room1:example.org'),
    ], SALT);
    const text = '@alice:example.org joined !room1:example.org';
    const anonymized = applyAnonymization(text, dict);
    const restored = applyUnanonymization(anonymized, dict);
    expect(restored).toBe(text);
  });

  it('does not consume URI path when restoring identifiers embedded in URLs', async () => {
    // Regression: the old regex `(?::[^\s]+)?` consumed the `/messages` suffix,
    // so `!room-<hash>:domain-<hash>.org/messages` was treated as one token and
    // not found in reverse[]. The fixed regex stops at `/`.
    const dict = await buildAnonymizationDictionary([makeLine(0, '!room1:example.org')], SALT);
    const uri = '/_matrix/client/v3/rooms/!room1:example.org/messages';
    const anonymized = applyAnonymization(uri, dict);
    const restored = applyUnanonymization(anonymized, dict);
    expect(restored).toBe(uri);
  });

  it('round-trips port-bearing server names', async () => {
    const dict = await buildAnonymizationDictionary([makeLine(0, '@alice:example.org:8448')], SALT);
    const text = 'connect to @alice:example.org:8448';
    const anonymized = applyAnonymization(text, dict);
    const restored = applyUnanonymization(anonymized, dict);
    expect(restored).toBe(text);
  });

  it('restores identifiers followed by common trailing punctuation', async () => {
    // Regression: the old regex excluded `.` from the server suffix, so
    // `@user-<hash>:domain-<hash>.org` was matched as only `@user-<hash>:domain-<hash>`
    // and the reverse lookup failed, leaving the token partially un-restored.
    const dict = await buildAnonymizationDictionary([
      makeLine(0, '@alice:example.org joined !room1:example.org'),
    ], SALT);
    const anonymized = applyAnonymization('@alice:example.org, !room1:example.org)', dict);
    const restored = applyUnanonymization(anonymized, dict);
    expect(restored).toBe('@alice:example.org, !room1:example.org)');
  });

  it('round-trips identifiers inside matrix.to and Element Web permalinks', async () => {
    const text = [
      'https://matrix.to/#/!room1:example.org/$event1:example.org?via=example.org',
      'https://matrix.to/#/#lobby:example.org https://matrix.to/#/@alice:example.org',
      'https://app.element.io/#/room/!room1:example.org',
    ].join(' ');
    const dict = await buildAnonymizationDictionaryFromTexts([text], SALT);
    const anonymized = applyAnonymization(text, dict);
    expect(applyUnanonymization(anonymized, dict)).toBe(text);
    expect(buildCompiledUnanonymizer(dict)(anonymized)).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// buildCompiledUnanonymizer
// ---------------------------------------------------------------------------

describe('buildCompiledUnanonymizer', () => {
  it('restores identifiers in plain text', async () => {
    const dict = await buildAnonymizationDictionary([makeLine(0, '@alice:example.org')], SALT);
    const restore = buildCompiledUnanonymizer(dict);
    const anonymized = applyAnonymization('@alice:example.org', dict);
    expect(restore(anonymized)).toBe('@alice:example.org');
  });

  it('does not consume URI path when restoring identifiers embedded in URLs', async () => {
    const dict = await buildAnonymizationDictionary([makeLine(0, '!room1:example.org')], SALT);
    const restore = buildCompiledUnanonymizer(dict);
    const anonymized = applyAnonymization('/_matrix/rooms/!room1:example.org/messages', dict);
    expect(restore(anonymized)).toBe('/_matrix/rooms/!room1:example.org/messages');
  });

  it('restores identifiers followed by common trailing punctuation', async () => {
    // Regression: `candidateRe` used `[^\s/]+` which included trailing `,` or `)`
    // in the match, so `@user-<hash>:domain-<hash>.org,` was not found in reverse[]
    // and the identifier was left un-restored.
    const dict = await buildAnonymizationDictionary([
      makeLine(0, '@alice:example.org joined !room1:example.org'),
    ], SALT);
    const restore = buildCompiledUnanonymizer(dict);
    const anonymized = applyAnonymization('@alice:example.org, !room1:example.org)', dict);
    expect(restore(anonymized)).toBe('@alice:example.org, !room1:example.org)');
  });
});

// ---------------------------------------------------------------------------
// anonymizeLogLine / unanonymizeLogLine
// ---------------------------------------------------------------------------

describe('anonymizeLogLine', () => {
  it('anonymizes rawText, message, and strippedMessage', async () => {
    const line = makeLine(1, '@alice:example.org joined !room1:example.org');
    const dict = await buildAnonymizationDictionary([line], SALT);
    const alias = dict.forward['@alice:example.org'];
    const result = anonymizeLogLine(line, dict);

    expect(result.rawText).toContain(alias);
    expect(result.message).toContain(alias);
    expect(result.strippedMessage).toContain(alias);
    expect(result.strippedMessage).not.toContain('@alice:example.org');
  });

  it('anonymizes continuation lines', async () => {
    const line = createParsedLogLine({
      lineNumber: 0,
      rawText: '2024-01-15T10:00:00.000000Z ERROR error',
      message: '2024-01-15T10:00:00.000000Z ERROR error',
      strippedMessage: 'error',
      continuationLines: ['  user @alice:example.org'],
    });
    const dict = await buildAnonymizationDictionary([line], SALT);
    const alias = dict.forward['@alice:example.org'];
    const result = anonymizeLogLine(line, dict);
    expect(result.continuationLines?.[0]).toBe(`  user ${alias}`);
  });

  it('preserves lineNumber, timestamps, level, filePath, sourceLineNumber unchanged', async () => {
    const line = createParsedLogLine({
      lineNumber: 42,
      isoTimestamp: '2024-01-15T10:00:00.000000Z',
      displayTime: '10:00:00.000000',
      level: 'WARN',
      filePath: 'src/client.rs',
      sourceLineNumber: 99,
      rawText: '2024-01-15T10:00:00.000000Z WARN @alice:example.org thing',
      message: '2024-01-15T10:00:00.000000Z WARN @alice:example.org thing',
      strippedMessage: '@alice:example.org thing',
    });
    const dict = await buildAnonymizationDictionary([line], SALT);
    const result = anonymizeLogLine(line, dict);

    expect(result.lineNumber).toBe(42);
    expect(result.isoTimestamp).toBe('2024-01-15T10:00:00.000000Z');
    expect(result.displayTime).toBe('10:00:00.000000');
    expect(result.level).toBe('WARN');
    expect(result.filePath).toBe('src/client.rs');
    expect(result.sourceLineNumber).toBe(99);
  });
});

describe('unanonymizeLogLine', () => {
  it('restores all text fields round-trip', async () => {
    const original = makeLine(0, '@alice:example.org in !room1:example.org');
    const dict = await buildAnonymizationDictionary([original], SALT);
    const anonymized = anonymizeLogLine(original, dict);
    const restored = unanonymizeLogLine(anonymized, dict);

    expect(restored.rawText).toBe(original.rawText);
    expect(restored.message).toBe(original.message);
    expect(restored.strippedMessage).toBe(original.strippedMessage);
  });
});

// ---------------------------------------------------------------------------
// detectAnonymizedLog / stripAnonymizedMarker
// ---------------------------------------------------------------------------

describe('detectAnonymizedLog', () => {
  it('returns true when marker is the first non-empty line', () => {
    const content = `${ANONYMIZED_LOG_MARKER}\n2024-01-15T10:00:00Z INFO hello`;
    expect(detectAnonymizedLog(content)).toBe(true);
  });

  it('returns true even with leading blank lines', () => {
    const content = `\n  \n${ANONYMIZED_LOG_MARKER}\n2024-01-15T10:00:00Z INFO hello`;
    expect(detectAnonymizedLog(content)).toBe(true);
  });

  it('returns false for a normal log without marker', () => {
    expect(detectAnonymizedLog('2024-01-15T10:00:00Z INFO hello')).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(detectAnonymizedLog('')).toBe(false);
  });

  it('returns false when marker appears on a non-first line', () => {
    const content = `2024-01-15T10:00:00Z INFO hello\n${ANONYMIZED_LOG_MARKER}`;
    expect(detectAnonymizedLog(content)).toBe(false);
  });

  it('still recognises the legacy pre-rename marker', () => {
    const content = '# [rageshake-viewer-anonymized]\n2024-01-15T10:00:00Z INFO hello';
    expect(detectAnonymizedLog(content)).toBe(true);
  });
});

describe('stripAnonymizedMarker', () => {
  it('removes the marker and following LF', () => {
    const rest = '2024-01-15T10:00:00Z INFO hello\n';
    expect(stripAnonymizedMarker(`${ANONYMIZED_LOG_MARKER}\n${rest}`)).toBe(rest);
  });

  it('removes the legacy pre-rename marker', () => {
    const rest = '2024-01-15T10:00:00Z INFO hello\n';
    expect(stripAnonymizedMarker(`# [rageshake-viewer-anonymized]\n${rest}`)).toBe(rest);
  });

  it('removes CRLF variant', () => {
    const rest = '2024-01-15T10:00:00Z INFO hello\r\n';
    expect(stripAnonymizedMarker(`${ANONYMIZED_LOG_MARKER}\r\n${rest}`)).toBe(rest);
  });

  it('removes marker when preceded by blank lines, preserving blanks before it', () => {
    const rest = '2024-01-15T10:00:00Z INFO hello\n';
    const content = `\n  \n${ANONYMIZED_LOG_MARKER}\n${rest}`;
    expect(stripAnonymizedMarker(content)).toBe(`\n  \n${rest}`);
  });

  it('leaves content unchanged when marker is absent', () => {
    const content = '2024-01-15T10:00:00Z INFO normal log';
    expect(stripAnonymizedMarker(content)).toBe(content);
  });
});

// ---------------------------------------------------------------------------
// Round-trip: anonymize → unanonymize → original
// ---------------------------------------------------------------------------

describe('round-trip anonymization', () => {
  it('recovers identical text after anonymize + unanonymize using backup lines', async () => {
    const lines = [
      makeLine(0, '@alice:matrix.org joined !room1:matrix.org via #general:matrix.org'),
      makeLine(1, '$VkdmKnrz9stD0mzv2QrS3sP was sent in !room1:matrix.org by @alice:matrix.org'),
    ];
    const dict = await buildAnonymizationDictionary(lines, SALT);
    const anonymized = lines.map((l) => anonymizeLogLine(l, dict));
    // Restore using the reverse dict (simulating loaded-from-file scenario)
    const restored = anonymized.map((l) => unanonymizeLogLine(l, dict));

    restored.forEach((r, i) => {
      expect(r.rawText).toBe(lines[i].rawText);
      expect(r.strippedMessage).toBe(lines[i].strippedMessage);
    });
  });

  it('different domains get different aliases', async () => {
    const lines = [
      makeLine(0, '@alice:server-a.org and @bob:server-b.org'),
    ];
    const dict = await buildAnonymizationDictionary(lines, SALT);
    const domA = dict.forward['server-a.org'];
    const domB = dict.forward['server-b.org'];
    expect(domA).toMatch(DOMAIN_RE);
    expect(domB).toMatch(DOMAIN_RE);
    expect(domA).not.toBe(domB);
    // Each user carries its own server's domain component.
    expect(dict.forward['@alice:server-a.org'].split(':')[1]).toBe(domA);
    expect(dict.forward['@bob:server-b.org'].split(':')[1]).toBe(domB);
  });

  it('does not treat single-char or no-dot hostnames as Matrix server names', async () => {
    // Identifiers where the server part is a bare digit or single label (no dot)
    // should NOT be recognized as Matrix IDs. Without this guard, a log line
    // containing e.g. "#channel:0" would put "0" into the dictionary as a bare
    // domain, causing every "0" digit in every other line (e.g. timestamps) to
    // be replaced with a domain alias.
    const lines = [
      makeLine(0, '#channel:0 @service:1 !room_id:localhost something'),
    ];
    const dict = await buildAnonymizationDictionary(lines, SALT);
    expect(dict.forward['0']).toBeUndefined();
    expect(dict.forward['1']).toBeUndefined();
    expect(dict.forward['localhost']).toBeUndefined();
    // Timestamps must not be corrupted
    const timestamp = '2026-03-19T15:00:06.547102Z';
    expect(applyAnonymization(timestamp, dict)).toBe(timestamp);
  });
});

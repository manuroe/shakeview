/**
 * Performance benchmarks for the anonymization utility functions.
 *
 * The core algorithm scans text with a fixed compiled regex (MATRIX_IDENTIFIER_RE)
 * and resolves matches via Map lookup, making the per-line cost O(text_length)
 * regardless of dictionary size. A single benchmark at 10K lines is sufficient
 * to exercise a realistic dictionary and catch regressions without running for
 * too long on CI.
 *
 * Run with: npm run bench
 */
import { describe, bench } from 'vitest';
import {
  buildAnonymizationDictionary,
  buildCompiledAnonymizer,
  buildCompiledUnanonymizer,
} from '../anonymizeUtils';
import type { ParsedLogLine } from '../../types/log.types';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * A pool of realistic Matrix server names. Using only a handful forces the
 * dictionary to contain bare domain entries (the phase-2 split/join path) as
 * well as composite user/room/event IDs, mirroring real log diversity.
 */
const SERVERS = [
  'matrix.org',
  'example.com',
  'homeserver.local',
  'chat.company.io',
  'staging.matrix.example.org',
];

/**
 * Modern base64url-style event IDs (no domain suffix) — these exercise the
 * `(?:%2[14]|[!$])[A-Za-z0-9…]{10,}` path in MATRIX_IDENTIFIER_RE.
 */
const MODERN_EVENT_IDS = [
  '$abcdefghijklmnopqrstuvwx',
  '$ZYXWVUTSRQPONMLKJIHGFEDCBA',
  '$1234567890abcdef1234567890',
  '$QUERTYuiopasdfg12345xyzABC',
];

/**
 * Generate a single ParsedLogLine that contains a realistic mix of Matrix
 * identifiers. The identifiers are drawn from the pool with a modulo so that
 * every N-th line reuses an earlier identifier — this ensures the compiled
 * regex must perform actual replacements across the whole text, and the
 * dictionary grows to a realistic size (uniqueUsers × servers combinations).
 *
 * @param index - Line index, used to derive identifier variants.
 */
function makeAnonymizableLine(index: number): ParsedLogLine {
  const server = SERVERS[index % SERVERS.length];
  const localpart = `user_${index % 50}`; // 50 unique users → reuse after 50 lines
  const roomLocal = `room_${index % 20}`; // 20 unique rooms
  const eventIdx = index % MODERN_EVENT_IDS.length;
  const eventId = MODERN_EVENT_IDS[eventIdx];

  const userId = `@${localpart}:${server}`;
  const roomId = `!${roomLocal}ABCDE12345:${server}`;
  const message =
    `Processing event ${eventId} for ${userId} in ${roomId} on ${server}` +
    ` (request #${index})`;
  const isoTimestamp = '2025-01-15T10:00:00.000000Z';

  return {
    lineNumber: index,
    rawText: `${isoTimestamp} INFO ${message}`,
    isoTimestamp,
    timestampUs: 1_736_935_200_000_000 + index * 100_000,
    displayTime: '10:00:00.000',
    level: 'INFO',
    message: `${isoTimestamp} INFO ${message}`,
    strippedMessage: message,
  };
}

// ---------------------------------------------------------------------------
// Pre-built fixtures (computed once, outside bench callbacks)
// ---------------------------------------------------------------------------

const LINE_COUNT = 10_000;

/** 10 K lines with realistic Matrix identifiers. */
const lines10k: ParsedLogLine[] = Array.from({ length: LINE_COUNT }, (_, i) =>
  makeAnonymizableLine(i),
);

/** Dictionary and compiled functions built once and reused across bench runs. */
const dict10k = await buildAnonymizationDictionary(lines10k, '');
const compiledAnonymizer10k = buildCompiledAnonymizer(dict10k);

/** Pre-anonymized lines for the unanonymizer benchmark. */
const anonymizedLines10k = lines10k.map((l) => ({
  ...l,
  rawText: compiledAnonymizer10k(l.rawText),
  message: compiledAnonymizer10k(l.message),
  strippedMessage: compiledAnonymizer10k(l.strippedMessage),
}));

const compiledUnanonymizer10k = buildCompiledUnanonymizer(dict10k);

// ---------------------------------------------------------------------------
// Benchmarks
// ---------------------------------------------------------------------------

describe('anonymizeUtils Performance (10K lines)', () => {
  bench('buildAnonymizationDictionary: 10K lines', async () => {
    await buildAnonymizationDictionary(lines10k, '');
  });

  bench('buildCompiledAnonymizer: compile from 10K-line dictionary', () => {
    buildCompiledAnonymizer(dict10k);
  });

  bench('compiled anonymizer: apply to 10K lines', () => {
    for (const l of lines10k) {
      compiledAnonymizer10k(l.rawText);
      compiledAnonymizer10k(l.message);
      compiledAnonymizer10k(l.strippedMessage);
    }
  });

  bench('compiled unanonymizer: apply to 10K anonymized lines', () => {
    for (const l of anonymizedLines10k) {
      compiledUnanonymizer10k(l.rawText);
      compiledUnanonymizer10k(l.message);
      compiledUnanonymizer10k(l.strippedMessage);
    }
  });
});

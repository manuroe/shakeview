import { describe, it, expect } from 'vitest';
import { isAnalyzableEntry, computeArchiveSummary, utdsByFile } from '../archiveSummary';

describe('isAnalyzableEntry', () => {
  it('accepts .log.gz entries', () => {
    expect(isAnalyzableEntry('logs.2026-04-12-09.log.gz')).toBe(true);
  });

  it('accepts .log entries', () => {
    expect(isAnalyzableEntry('console.log')).toBe(true);
  });

  it('accepts paths with a directory prefix', () => {
    expect(isAnalyzableEntry('2026-04-14_ID/logs.2026-04-12-09.log.gz')).toBe(true);
  });

  it('rejects .json files', () => {
    expect(isAnalyzableEntry('details.json')).toBe(false);
  });

  it('rejects the rageshake server\'s details.log.gz', () => {
    expect(isAnalyzableEntry('details.log.gz')).toBe(false);
    expect(isAnalyzableEntry('2026-04-14_ID/details.log.gz')).toBe(false);
  });

  it('rejects files with no extension', () => {
    expect(isAnalyzableEntry('README')).toBe(false);
  });

  it('is case-insensitive for the extension', () => {
    expect(isAnalyzableEntry('CONSOLE.LOG')).toBe(true);
    expect(isAnalyzableEntry('CONSOLE.LOG.GZ')).toBe(true);
  });
});

describe('computeArchiveSummary', () => {
  it('counts total lines, errors, warnings, HTTP requests, upload/download bytes, and status codes', () => {
    const log = [
      '2026-01-15T10:00:00.000000Z  INFO [tag] first info line',
      '2026-01-15T10:00:01.000000Z  WARN [tag] a warning message',
      '2026-01-15T10:00:02.000000Z ERROR [tag] an error message',
      '2026-01-15T10:00:03.000000Z  INFO [matrix-rust-sdk] conn_id="c1" send{request_id="r1" method=GET uri="https://example.com/" request_size="1024"}',
      '2026-01-15T10:00:04.000000Z  INFO [matrix-rust-sdk] conn_id="c1" send{request_id="r1" method=GET uri="https://example.com/" request_size="1024" status=200 response_size="8192" request_duration=100ms}',
    ].join('\n');

    const summary = computeArchiveSummary(log);

    expect(summary.totalLines).toBeGreaterThanOrEqual(5);
    expect(summary.errorCount).toBe(1);
    expect(summary.warnCount).toBe(1);
    expect(summary.sentryCount).toBe(0);
    expect(summary.httpCount).toBe(1);
    expect(summary.totalUploadBytes).toBe(1024);
    expect(summary.totalDownloadBytes).toBe(8192);
    expect(summary.statusCodes['200']).toBe(1);
  });

  it('throws for an empty log (parseLogFile validates input)', () => {
    // parseLogFile rejects empty input; callers are responsible for try/catch
    // (ArchiveView's background loop handles this gracefully).
    expect(() => computeArchiveSummary('')).toThrow();
  });

  it('returns zeros for a log with no errors, warnings, or HTTP', () => {
    const log = [
      '2026-01-15T10:00:00.000000Z  INFO [tag] all is fine',
      '2026-01-15T10:00:01.000000Z  INFO [tag] still fine',
    ].join('\n');

    const summary = computeArchiveSummary(log);
    expect(summary.errorCount).toBe(0);
    expect(summary.warnCount).toBe(0);
    expect(summary.sentryCount).toBe(0);
    expect(summary.httpCount).toBe(0);
    expect(summary.totalUploadBytes).toBe(0);
    expect(summary.totalDownloadBytes).toBe(0);
    expect(summary.statusCodes).toEqual({});
    expect(summary.totalLines).toBe(2);
  });

  it('records client-error status key for requests with client errors', () => {
    const log = [
      '2026-01-15T10:00:00.000000Z  INFO [matrix-rust-sdk] conn_id="c1" send{request_id="r1" method=GET uri="https://example.com/"}',
      '2026-01-15T10:00:01.000000Z ERROR [matrix-rust-sdk] Error while sending request reqwest::Error source: TimedOut send{request_id="r1" method=GET uri="https://example.com/"}',
    ].join('\n');

    const summary = computeArchiveSummary(log);
    expect(summary.statusCodes['client-error']).toBe(1);
  });

  /** A Rust UTD of `id` in room session S, at `time` on 2026-09-08. */
  const failed = (id: string, time = '06:55:22') => `2026-09-08T${time}.130000Z  WARN matrix_sdk_crypto::machine: Failed to decrypt a room event: Can't find the room key to decrypt the event, withheld code: None | crates/matrix-sdk-crypto/src/machine/mod.rs:2516 | spans: decrypt_room_event{event_id="${id}" session_id="S" message_index=0}`;

  it('counts distinct UTD events and their reasons', () => {
    const text = [
      "2026-09-08T06:55:22.130000Z  WARN matrix_sdk_crypto::machine: Failed to decrypt a room event: Can't find the room key to decrypt the event, withheld code: None | crates/matrix-sdk-crypto/src/machine/mod.rs:2516 | spans: decrypt_room_event{event_id=\"$ev1\" session_id=\"S\" message_index=0}",
      "2026-09-08T06:55:23.130000Z  WARN matrix_sdk_crypto::machine: Failed to decrypt a room event: Can't find the room key to decrypt the event, withheld code: None | crates/matrix-sdk-crypto/src/machine/mod.rs:2516 | spans: decrypt_room_event{event_id=\"$ev1\" session_id=\"S\" message_index=0}",
    ].join('\n');
    const summary = computeArchiveSummary(text);
    expect(summary.utdCount).toBe(1);
    expect(summary.utdReasons.missing_key).toBe(1);
  });

  it('counts reported UTDs over the whole archive, in the file of the first failure', () => {
    const a = computeArchiveSummary([failed('$ev1'), failed('$ev2')].join('\n'), 'a.log');
    // The app's report of $ev1 is only in the next file.
    const b = computeArchiveSummary('2026-09-08T07:00:30.000000Z DEBUG elementx: onUtd for event $ev1, timeToDecryptMs: null |  |', 'b.log');
    const utds = utdsByFile(new Map([['a.log', a], ['b.log', b]]));
    expect(utds.get('a.log')).toEqual({ count: 2, reported: 1, byReason: { missing_key: 2 } });
    expect(utds.get('b.log')).toBeUndefined();
  });

  it('counts a UTD retried across an hourly boundary once, in the file it first failed', () => {
    const a = computeArchiveSummary(failed('$ev1'), 'a.log');
    const b = computeArchiveSummary([
      failed('$ev1', '07:00:05'),
      '2026-09-08T07:00:30.000000Z DEBUG elementx: onUtd for event $ev1, timeToDecryptMs: null |  |',
    ].join('\n'), 'b.log');
    // Each file alone sees the UTD: the archive-wide count credits only the first.
    expect([a.utdCount, b.utdCount]).toEqual([1, 1]);
    // Summaries in any order: the first failure decides, not the map order.
    const utds = utdsByFile(new Map([['b.log', b], ['a.log', a]]));
    expect(utds.get('a.log')).toEqual({ count: 1, reported: 1, byReason: { missing_key: 1 } });
    expect(utds.get('b.log')).toBeUndefined();
  });

  it('cannot tell reported UTDs without timeline logs', () => {
    expect(utdsByFile(new Map([['a.log', computeArchiveSummary(failed('$ev1'), 'a.log')]])).get('a.log'))
      .toEqual({ count: 1, reported: null, byReason: { missing_key: 1 } });
  });
});

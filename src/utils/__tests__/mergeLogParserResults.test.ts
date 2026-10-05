import { describe, it, expect } from 'vitest';
import { mergeLogParserResults, type NamedLogParserResult } from '../mergeLogParserResults';
import type { LogParserResult, ParsedLogLine, HttpRequest, SyncRequest, LifecycleEvent } from '../../types/log.types';
import type { TimestampMicros } from '../../types/time.types';

function line(n: number): ParsedLogLine {
  return {
    lineNumber: n,
    rawText: `line ${n}`,
    isoTimestamp: '2026-04-14T08:00:00.000000Z' as ParsedLogLine['isoTimestamp'],
    timestampUs: 0 as ParsedLogLine['timestampUs'],
    displayTime: '08:00:00',
    level: 'INFO',
    message: `line ${n}`,
    strippedMessage: `line ${n}`,
  };
}

function http(send: number, resp: number): HttpRequest {
  return {
    requestId: `r${send}`, method: 'GET', uri: '/x', status: '200',
    requestSizeString: '', responseSizeString: '', requestSize: 0, responseSize: 0,
    requestDurationMs: 0, sendLineNumber: send, responseLineNumber: resp,
  };
}

function file(name: string, lines: number, reqs: HttpRequest[], connIds: string[]): NamedLogParserResult {
  const result: LogParserResult = {
    requests: [], httpRequests: reqs, connectionIds: connIds,
    rawLogLines: Array.from({ length: lines }, (_, i) => line(i + 1)),
    sentryEvents: [{ platform: 'android', lineNumber: 2, message: 'boom' }],
  };
  return { name, result };
}

describe('mergeLogParserResults', () => {
  it('renumbers Element Web request ids in time order across files', () => {
    // logs-0000 is the NEWEST page load but comes first, as the archive lists it.
    const webFile = (name: string, baseUs: number): NamedLogParserResult => {
      const rawLogLines = [1, 2, 3].map((n) => ({ ...line(n), timestampUs: (baseUs + n) as TimestampMicros }));
      const reqs = [{ ...http(1, 2), requestId: '1' }, { ...http(3, 0), requestId: '2', uri: '/sync' }];
      const sync: SyncRequest = { ...reqs[1], connId: '', timeout: undefined };
      return { name, result: { requests: [sync], httpRequests: reqs, connectionIds: [], rawLogLines, sentryEvents: [] } };
    };
    const merged = mergeLogParserResults([webFile('logs-0000.log', 2_000), webFile('logs-0001.log', 1_000)]);
    // Older file (logs-0001, lines 4-6 once rebased) gets 1-2, newer gets 3-4.
    expect(merged.httpRequests.map((r) => [r.requestId, r.sendLineNumber])).toEqual([['1', 4], ['2', 6], ['3', 1], ['4', 3]]);
    expect(merged.requests.map((r) => [r.requestId, r.sendLineNumber])).toEqual([['2', 6], ['4', 3]]);
  });

  it('keeps SDK request ids as logged', () => {
    const merged = mergeLogParserResults([file('08.log', 3, [http(1, 2)], []), file('09.log', 3, [http(1, 2)], [])]);
    expect(merged.httpRequests.map((r) => r.requestId)).toEqual(['r1', 'r1']);
  });

  it('rebases line numbers and keeps request refs consistent', () => {
    const merged = mergeLogParserResults([
      file('08.log', 3, [http(1, 2)], ['room-list']),
      file('09.log', 2, [http(1, 2)], ['sliding']),
    ]);

    // 3 + 2 lines, globally unique and contiguous
    expect(merged.rawLogLines.map((l) => l.lineNumber)).toEqual([1, 2, 3, 4, 5]);
    // second file's request refs shifted by 3
    expect(merged.httpRequests.map((r) => [r.sendLineNumber, r.responseLineNumber])).toEqual([[1, 2], [4, 5]]);
    // sentry line of second file shifted by 3
    expect(merged.sentryEvents.map((e) => e.lineNumber)).toEqual([2, 5]);
    // connection ids unioned
    expect(merged.connectionIds.sort()).toEqual(['room-list', 'sliding']);
    // provenance tagged
    expect(merged.rawLogLines[0].sourceFile).toBe('08.log');
    expect(merged.rawLogLines[4].sourceFile).toBe('09.log');
  });

  it('steps the offset by the highest line number, not the line count', () => {
    // A real parsed file has gaps: continuation lines are folded into their
    // predecessor, so the last line's number exceeds the line count. Stepping by
    // the count would overlap the next file onto this one's tail.
    const withGaps: LogParserResult = {
      requests: [], httpRequests: [], connectionIds: [],
      rawLogLines: [line(1), line(2), line(7)], // 3 lines, highest number 7
      sentryEvents: [{ platform: 'android', lineNumber: 7, message: 'boom' }],
    };
    const second: LogParserResult = {
      requests: [], httpRequests: [], connectionIds: [],
      rawLogLines: [line(1), line(2)],
      sentryEvents: [],
    };

    const merged = mergeLogParserResults([
      { name: '08.log', result: withGaps },
      { name: '09.log', result: second },
    ]);

    const numbers = merged.rawLogLines.map((l) => l.lineNumber);
    expect(numbers).toEqual([1, 2, 7, 8, 9]);
    expect(new Set(numbers).size).toBe(numbers.length); // no collisions
    expect(merged.sentryEvents.map((e) => e.lineNumber)).toEqual([7]);
  });

  it('clears line references that point past the last parsed line', () => {
    // A request's response can be logged on a folded continuation line, so its
    // reference can exceed every rawLogLine number — the offset must clear it too.
    const first: LogParserResult = {
      requests: [], httpRequests: [http(1, 9)], connectionIds: [],
      rawLogLines: [line(1), line(2)],
      sentryEvents: [],
    };
    const second: LogParserResult = {
      requests: [], httpRequests: [http(1, 2)], connectionIds: [],
      rawLogLines: [line(1), line(2)],
      sentryEvents: [],
    };

    const merged = mergeLogParserResults([
      { name: '08.log', result: first },
      { name: '09.log', result: second },
    ]);

    // Second file starts at 10, clear of the first file's response ref at 9.
    expect(merged.rawLogLines.map((l) => l.lineNumber)).toEqual([1, 2, 10, 11]);
    expect(merged.httpRequests.map((r) => [r.sendLineNumber, r.responseLineNumber])).toEqual([[1, 9], [10, 11]]);
  });

  it('rebases lifecycle event line numbers by the same per-file offset', () => {
    const lc = (lineNumber: number): LifecycleEvent => ({
      kind: 'coldStart', platform: 'ios', lineNumber, timestampUs: 0 as TimestampMicros,
    });
    const fileA: LogParserResult = {
      requests: [], httpRequests: [], connectionIds: [],
      rawLogLines: Array.from({ length: 3 }, (_, i) => line(i + 1)),
      sentryEvents: [], lifecycleEvents: [lc(2)],
    };
    const fileB: LogParserResult = {
      requests: [], httpRequests: [], connectionIds: [],
      rawLogLines: Array.from({ length: 2 }, (_, i) => line(i + 1)),
      sentryEvents: [], lifecycleEvents: [lc(1)],
    };

    const merged = mergeLogParserResults([
      { name: '08.log', result: fileA },
      { name: '09.log', result: fileB },
    ]);

    // fileB's event (line 1) shifts by fileA's 3 lines → line 4.
    expect(merged.lifecycleEvents.map((e) => e.lineNumber)).toEqual([2, 4]);
  });

  it('tags the single-file case and leaves numbers untouched', () => {
    const merged = mergeLogParserResults([file('only.log', 2, [http(1, 2)], [])]);
    expect(merged.rawLogLines.map((l) => l.lineNumber)).toEqual([1, 2]);
    expect(merged.rawLogLines.every((l) => l.sourceFile === 'only.log')).toBe(true);
  });

  it('returns an empty result for an empty file list', () => {
    const merged = mergeLogParserResults([]);
    expect(merged.rawLogLines).toEqual([]);
    expect(merged.httpRequests).toEqual([]);
    expect(merged.connectionIds).toEqual([]);
  });

  it('interleaves lines from different processes by timestamp', () => {
    const at = (n: number, ts: number): ParsedLogLine => ({
      ...line(n),
      timestampUs: ts as ParsedLogLine['timestampUs'],
    });
    // Two processes covering the same hour; console at 100/300µs, nse at 200/400µs.
    const consoleResult: LogParserResult = {
      requests: [], httpRequests: [http(1, 2)], connectionIds: [],
      rawLogLines: [at(1, 100), at(2, 300)], sentryEvents: [],
    };
    const nseResult: LogParserResult = {
      requests: [], httpRequests: [http(1, 2)], connectionIds: [],
      rawLogLines: [at(1, 200), at(2, 400)], sentryEvents: [],
    };

    const merged = mergeLogParserResults([
      { name: 'console.2026-04-14-08.log.gz', result: consoleResult },
      { name: 'nse.2026-04-14-08.log.gz', result: nseResult },
    ]);

    // Lines interleaved by time, not grouped by file.
    expect(merged.rawLogLines.map((l) => l.timestampUs)).toEqual([100, 200, 300, 400]);
    expect(merged.rawLogLines.map((l) => l.sourceFile)).toEqual([
      'console.2026-04-14-08.log.gz',
      'nse.2026-04-14-08.log.gz',
      'console.2026-04-14-08.log.gz',
      'nse.2026-04-14-08.log.gz',
    ]);
    // Requests sorted by send time: console send (line 1, 100µs) before nse send (line 3, 200µs).
    expect(merged.httpRequests.map((r) => r.sendLineNumber)).toEqual([1, 3]);
  });

  it('keeps a zero-timestamp orphan line with its originating section', () => {
    const at = (n: number, ts: number): ParsedLogLine => ({
      ...line(n),
      timestampUs: ts as ParsedLogLine['timestampUs'],
    });
    // fileA: positive, orphan (ts 0), positive; fileB: a positive line in between.
    const fileA: LogParserResult = {
      requests: [], httpRequests: [], connectionIds: [],
      rawLogLines: [at(1, 10), at(2, 0), at(3, 30)], sentryEvents: [],
    };
    const fileB: LogParserResult = {
      requests: [], httpRequests: [], connectionIds: [],
      rawLogLines: [at(1, 20)], sentryEvents: [],
    };

    const merged = mergeLogParserResults([
      { name: 'a.log', result: fileA },
      { name: 'b.log', result: fileB },
    ]);

    // The orphan (ts 0) carries fileA's last positive ts (10), so it stays right
    // after a.log's 10µs line instead of jumping to the front.
    expect(merged.rawLogLines.map((l) => [l.sourceFile, l.timestampUs])).toEqual([
      ['a.log', 10],
      ['a.log', 0],
      ['b.log', 20],
      ['a.log', 30],
    ]);
  });

  it('leaves a 0 line reference (incomplete request) un-offset', () => {
    // sendLineNumber/responseLineNumber of 0 means "no line" — must stay 0, not
    // become the file offset, or it would point at an unrelated line.
    const merged = mergeLogParserResults([
      file('08.log', 3, [http(1, 0)], []),
      file('09.log', 2, [http(0, 2)], []),
    ]);
    expect(merged.httpRequests.map((r) => [r.sendLineNumber, r.responseLineNumber])).toEqual([
      [1, 0],
      [0, 5],
    ]);
  });

  it('offsets sync (connId) request line refs and keeps 0 sentinels', () => {
    const sync = (send: number, resp: number): SyncRequest => ({ ...http(send, resp), connId: 'room-list' });
    const withSync = (name: string, lines: number, reqs: SyncRequest[]): NamedLogParserResult => ({
      name,
      result: {
        requests: reqs,
        httpRequests: [],
        connectionIds: [],
        rawLogLines: Array.from({ length: lines }, (_, i) => line(i + 1)),
        sentryEvents: [],
      },
    });

    const merged = mergeLogParserResults([
      withSync('08.log', 2, [sync(1, 2)]),
      withSync('09.log', 2, [sync(0, 0)]), // incomplete sync request → refs stay 0
    ]);

    expect(merged.requests.map((r) => [r.sendLineNumber, r.responseLineNumber])).toEqual([
      [1, 2],
      [0, 0],
    ]);
  });
});

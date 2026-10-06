/**
 * Unit tests for computeSummaryStats.
 *
 * The function is pure — no React, no store, no network — so we can drive it
 * with simple fixture data and assert on concrete output values.
 */
import { describe, it, expect } from 'vitest';
import { computeSummaryStats } from '../summaryStats';
import {
  createParsedLogLine,
  createHttpRequest,
  createSyncRequest,
} from '../../test/fixtures';
import type { ParsedLogLine } from '../../types/log.types';
import type { TimestampMicros } from '../../types/time.types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_US = 1_700_000_000_000_000 as TimestampMicros;
const STEP_US = 5_000_000 as TimestampMicros; // 5 s per line

/** Build N log lines with deterministic timestamps starting from BASE_US. */
function makeLines(count: number): ParsedLogLine[] {
  return Array.from({ length: count }, (_, i) =>
    createParsedLogLine({
      lineNumber: i,
      timestampUs: (BASE_US + i * STEP_US) as TimestampMicros,
    })
  );
}

/** Build a precomputed lineNumberIndex as a Map, like logStore does. */
function buildIndex(lines: ParsedLogLine[]): Map<number, ParsedLogLine> {
  const map = new Map<number, ParsedLogLine>();
  for (const line of lines) map.set(line.lineNumber, line);
  return map;
}

const EMPTY_RESULT = computeSummaryStats([], [], [], [], [], null, null, null, new Map());

// ---------------------------------------------------------------------------
// Empty / no-data
// ---------------------------------------------------------------------------

describe('computeSummaryStats — no data', () => {
  it('returns all-zero stats when rawLogLines is empty', () => {
    expect(EMPTY_RESULT.totalLogLines).toBe(0);
    expect(EMPTY_RESULT.errors).toBe(0);
    expect(EMPTY_RESULT.warnings).toBe(0);
    expect(EMPTY_RESULT.httpRequestsWithTimestamps).toHaveLength(0);
    expect(EMPTY_RESULT.sentryEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Log line counting and time range filtering
// ---------------------------------------------------------------------------

describe('computeSummaryStats — totalLogLines', () => {
  it('counts all lines when no time filter is active', () => {
    const lines = makeLines(7);
    const result = computeSummaryStats(lines, [], [], [], [], null, null, null, buildIndex(lines));
    expect(result.totalLogLines).toBe(7);
  });

  it('counts only lines within a local time range', () => {
    const lines = makeLines(5);
    // Include only lines 1–3 (indices 1, 2, 3)
    const localRange = {
      startUs: lines[1].timestampUs,
      endUs: lines[3].timestampUs,
    };
    const result = computeSummaryStats(lines, [], [], [], [], null, null, localRange, buildIndex(lines));
    expect(result.totalLogLines).toBe(3);
    expect(result.filteredLogLines[0].lineNumber).toBe(1);
    expect(result.filteredLogLines[2].lineNumber).toBe(3);
  });

  it('counts only lines within the global ISO time filter', () => {
    const lines = makeLines(10);
    // Global filter: lines 3–7 inclusive
    const startIso = lines[3].isoTimestamp;
    const endIso = lines[7].isoTimestamp;
    const result = computeSummaryStats(lines, [], [], [], [], startIso, endIso, null, buildIndex(lines));
    expect(result.totalLogLines).toBe(5);
    expect(result.filteredLogLines[0].lineNumber).toBe(3);
    expect(result.filteredLogLines[4].lineNumber).toBe(7);
  });

  it('local zoom overrides global ISO filter', () => {
    const lines = makeLines(10);
    const startIso = lines[0].isoTimestamp; // global = full range
    const endIso = lines[9].isoTimestamp;
    // Local zoom narrows to lines 4–6
    const localRange = {
      startUs: lines[4].timestampUs,
      endUs: lines[6].timestampUs,
    };
    const result = computeSummaryStats(lines, [], [], [], [], startIso, endIso, localRange, buildIndex(lines));
    expect(result.totalLogLines).toBe(3);
    expect(result.filteredLogLines[0].lineNumber).toBe(4);
  });

  it('sets timeSpan from first and last filtered lines', () => {
    const lines = makeLines(5);
    const result = computeSummaryStats(lines, [], [], [], [], null, null, null, buildIndex(lines));
    expect(result.timeSpan.start).toBe(lines[0].displayTime);
    expect(result.timeSpan.end).toBe(lines[4].displayTime);
  });
});

// ---------------------------------------------------------------------------
// Error and warning counting
// ---------------------------------------------------------------------------

describe('computeSummaryStats — error / warning counts', () => {
  it('counts ERROR and WARN lines correctly', () => {
    const lines = [
      createParsedLogLine({ lineNumber: 0, timestampUs: BASE_US, level: 'ERROR', message: 'Oops' }),
      createParsedLogLine({ lineNumber: 1, timestampUs: (BASE_US + STEP_US) as TimestampMicros, level: 'WARN', message: 'Careful' }),
      createParsedLogLine({ lineNumber: 2, timestampUs: (BASE_US + 2 * STEP_US) as TimestampMicros, level: 'INFO', message: 'All good' }),
      createParsedLogLine({ lineNumber: 3, timestampUs: (BASE_US + 3 * STEP_US) as TimestampMicros, level: 'ERROR', message: 'Oops' }),
    ];
    const result = computeSummaryStats(lines, [], [], [], [], null, null, null, buildIndex(lines));
    expect(result.errors).toBe(2);
    expect(result.warnings).toBe(1);
  });

  it('groups duplicate error messages and sorts by frequency', () => {
    const lines = [
      createParsedLogLine({ lineNumber: 0, timestampUs: BASE_US, level: 'ERROR', message: 'Timeout' }),
      createParsedLogLine({ lineNumber: 1, timestampUs: (BASE_US + STEP_US) as TimestampMicros, level: 'ERROR', message: 'Timeout' }),
      createParsedLogLine({ lineNumber: 2, timestampUs: (BASE_US + 2 * STEP_US) as TimestampMicros, level: 'ERROR', message: 'Unique error' }),
    ];
    const result = computeSummaryStats(lines, [], [], [], [], null, null, null, buildIndex(lines));
    expect(result.errorsByType[0].type).toBe('Timeout');
    expect(result.errorsByType[0].count).toBe(2);
    expect(result.errorsByType[1].type).toBe('Unique error');
  });

  it('groups warnings that differ only by their trailing JSON payload (Element Web)', () => {
    const msg = (room: string) => `2026-09-29T07:06:20.662Z W Falling back to unread room {"roomId":"${room}"}`;
    const lines = [
      createParsedLogLine({ lineNumber: 0, timestampUs: BASE_US, level: 'WARN', message: msg('!a:example.org') }),
      createParsedLogLine({ lineNumber: 1, timestampUs: (BASE_US + STEP_US) as TimestampMicros, level: 'WARN', message: msg('!b:example.org') }),
    ];
    const result = computeSummaryStats(lines, [], [], [], [], null, null, null, buildIndex(lines));
    expect(result.warningsByType).toEqual([{ type: 'Falling back to unread room {…}', count: 2 }]);
  });

  it('caps errorsByType at 5 entries', () => {
    const lines = Array.from({ length: 10 }, (_, i) =>
      createParsedLogLine({
        lineNumber: i,
        timestampUs: (BASE_US + i * STEP_US) as TimestampMicros,
        level: 'ERROR',
        message: `Error type ${i}`,
      })
    );
    const result = computeSummaryStats(lines, [], [], [], [], null, null, null, buildIndex(lines));
    expect(result.errorsByType.length).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// HTTP error by status
// ---------------------------------------------------------------------------

describe('computeSummaryStats — httpErrorsByStatus', () => {
  it('counts 4xx and 5xx HTTP errors', () => {
    const rawLines = makeLines(6);
    const index = buildIndex(rawLines);

    const requests = [
      createHttpRequest({ requestId: 'R1', status: '200', responseLineNumber: 0 }),
      createHttpRequest({ requestId: 'R2', status: '404', responseLineNumber: 1 }),
      createHttpRequest({ requestId: 'R3', status: '500', responseLineNumber: 2 }),
      createHttpRequest({ requestId: 'R4', status: '500', responseLineNumber: 3 }),
    ];

    const result = computeSummaryStats(rawLines, requests, [], [], [], null, null, null, index);

    const statusTypes = result.httpErrorsByStatus.map((e) => e.status);
    expect(statusTypes).toContain('500');
    expect(statusTypes).toContain('404');
    expect(statusTypes).not.toContain('200');

    const fiveHundred = result.httpErrorsByStatus.find((e) => e.status === '500');
    expect(fiveHundred?.count).toBe(2);
  });

  it('excludes 2xx and 3xx from httpErrorsByStatus', () => {
    const rawLines = makeLines(3);
    const index = buildIndex(rawLines);

    const requests = [
      createHttpRequest({ requestId: 'R1', status: '200', responseLineNumber: 0 }),
      createHttpRequest({ requestId: 'R2', status: '301', responseLineNumber: 1 }),
    ];

    const result = computeSummaryStats(rawLines, requests, [], [], [], null, null, null, index);
    expect(result.httpErrorsByStatus).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Slowest HTTP requests
// ---------------------------------------------------------------------------

describe('computeSummaryStats — slowestHttpRequests', () => {
  it('returns requests sorted by duration, longest first', () => {
    const rawLines = makeLines(4);
    const index = buildIndex(rawLines);

    const requests = [
      createHttpRequest({ requestId: 'R1', uri: '/rooms', requestDurationMs: 100, responseLineNumber: 0 }),
      createHttpRequest({ requestId: 'R2', uri: '/messages', requestDurationMs: 5000, responseLineNumber: 1 }),
      createHttpRequest({ requestId: 'R3', uri: '/profile', requestDurationMs: 200, responseLineNumber: 2 }),
    ];

    const result = computeSummaryStats(rawLines, requests, [], [], [], null, null, null, index);
    expect(result.slowestHttpRequests[0].duration).toBe(5000);
    expect(result.slowestHttpRequests[0].id).toBe('R2');
  });

  it('excludes /sync requests from the slowest list', () => {
    const rawLines = makeLines(3);
    const index = buildIndex(rawLines);

    const requests = [
      createHttpRequest({ requestId: 'SYNC', uri: '/sync', requestDurationMs: 99999, responseLineNumber: 0 }),
      createHttpRequest({ requestId: 'OTHER', uri: '/rooms', requestDurationMs: 50, responseLineNumber: 1 }),
    ];

    const result = computeSummaryStats(rawLines, requests, [], [], [], null, null, null, index);
    const ids = result.slowestHttpRequests.map((r) => r.id);
    expect(ids).not.toContain('SYNC');
    expect(ids).toContain('OTHER');
  });

  it('caps slowestHttpRequests at 10 entries', () => {
    const rawLines = makeLines(20);
    const index = buildIndex(rawLines);

    const requests = rawLines.map((_, i) =>
      createHttpRequest({
        requestId: `R${i}`,
        uri: `/path/${i}`,
        requestDurationMs: i * 10,
        responseLineNumber: i,
      })
    );

    const result = computeSummaryStats(rawLines, requests, [], [], [], null, null, null, index);
    expect(result.slowestHttpRequests.length).toBeLessThanOrEqual(10);
  });
});

// ---------------------------------------------------------------------------
// Sync requests by connection
// ---------------------------------------------------------------------------

describe('computeSummaryStats — syncRequestsByConnection', () => {
  it('groups sync requests by connId and sorts descending', () => {
    const rawLines = makeLines(5);
    const index = buildIndex(rawLines);

    const syncRequests = [
      createSyncRequest({ requestId: 'S1', connId: 'room-list', responseLineNumber: 0 }),
      createSyncRequest({ requestId: 'S2', connId: 'room-list', responseLineNumber: 1 }),
      createSyncRequest({ requestId: 'S3', connId: 'encryption', responseLineNumber: 2 }),
    ];

    const result = computeSummaryStats(
      rawLines, [], syncRequests, ['room-list', 'encryption'], [], null, null, null, index
    );

    expect(result.syncRequestsByConnection[0].connId).toBe('room-list');
    expect(result.syncRequestsByConnection[0].count).toBe(2);
    expect(result.syncRequestsByConnection[1].connId).toBe('encryption');
    expect(result.syncRequestsByConnection[1].count).toBe(1);
  });

  it('omits connections with zero requests from the result', () => {
    const rawLines = makeLines(2);
    const index = buildIndex(rawLines);


    const syncRequests = [
      createSyncRequest({ requestId: 'S1', connId: 'active', responseLineNumber: 0 }),
    ];

    const result = computeSummaryStats(
      rawLines, [], syncRequests, ['active', 'idle'], [], null, null, null, index
    );

    const connIds = result.syncRequestsByConnection.map((s) => s.connId);
    expect(connIds).toContain('active');
    expect(connIds).not.toContain('idle');
  });
});

describe('computeSummaryStats — lifecycleEvents', () => {
  it('filters lifecycle events to the active local time range', () => {
    const lines = makeLines(5);
    const index = buildIndex(lines);
    const lifecycleEvents = [
      { kind: 'coldStart' as const, platform: 'ios' as const, lineNumber: 0, timestampUs: lines[0].timestampUs },
      { kind: 'foreground' as const, platform: 'ios' as const, lineNumber: 2, timestampUs: lines[2].timestampUs },
      { kind: 'background' as const, platform: 'ios' as const, lineNumber: 4, timestampUs: lines[4].timestampUs },
    ];
    // Local zoom to lines 1–3: only the middle event (line 2) falls inside.
    const localRange = { startUs: lines[1].timestampUs, endUs: lines[3].timestampUs };

    const result = computeSummaryStats(
      lines, [], [], [], [], null, null, localRange, index, lifecycleEvents
    );

    expect(result.lifecycleEvents.map((e) => e.lineNumber)).toEqual([2]);
  });
});

// ---------------------------------------------------------------------------
// Top failed URLs
// ---------------------------------------------------------------------------

describe('computeSummaryStats — topFailedUrls', () => {
  it('groups failed requests by URI with their statuses', () => {
    const rawLines = makeLines(5);
    const index = buildIndex(rawLines);

    const requests = [
      createHttpRequest({ requestId: 'R1', uri: '/sync', status: '500', responseLineNumber: 0 }),
      createHttpRequest({ requestId: 'R2', uri: '/sync', status: '502', responseLineNumber: 1 }),
      createHttpRequest({ requestId: 'R3', uri: '/upload', status: '400', responseLineNumber: 2 }),
    ];

    const result = computeSummaryStats(rawLines, requests, [], [], [], null, null, null, index);

    const syncEntry = result.topFailedUrls.find((u) => u.uri === '/sync');
    expect(syncEntry?.count).toBe(2);
    expect(Array.from(syncEntry?.statuses ?? [])).toEqual(expect.arrayContaining(['500', '502']));
  });

  it('caps topFailedUrls at 5 entries', () => {
    const rawLines = makeLines(10);
    const index = buildIndex(rawLines);

    const requests = rawLines.map((line, i) =>
      createHttpRequest({
        requestId: `R${i}`,
        uri: `/path/${i}`,
        status: '500',
        responseLineNumber: line.lineNumber,
      })
    );

    const result = computeSummaryStats(rawLines, requests, [], [], [], null, null, null, index);
    expect(result.topFailedUrls.length).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// Upload / download byte totals
// ---------------------------------------------------------------------------

describe('computeSummaryStats — byte totals', () => {
  it('sums requestSize and responseSize for completed requests', () => {
    const rawLines = makeLines(3);
    const index = buildIndex(rawLines);

    const requests = [
      createHttpRequest({ requestId: 'R1', status: '200', requestSize: 100, responseSize: 500, responseLineNumber: 1 }),
      createHttpRequest({ requestId: 'R2', status: '200', requestSize: 200, responseSize: 1000, responseLineNumber: 2 }),
    ];

    const result = computeSummaryStats(rawLines, requests, [], [], [], null, null, null, index);
    expect(result.totalUploadBytes).toBe(300);
    expect(result.totalDownloadBytes).toBe(1500);
  });
});

// ---------------------------------------------------------------------------
// httpRequestsWithTimestamps — start-based chart semantics
// ---------------------------------------------------------------------------

describe('computeSummaryStats — httpRequestsWithTimestamps', () => {
  it('filters completed requests by send timestamp for the summary chart', () => {
    const rawLines = makeLines(6);
    const index = buildIndex(rawLines);

    const startedInsideRange = createHttpRequest({
      requestId: 'STARTS-IN',
      status: '200',
      requestSize: 100,
      responseSize: 300,
      sendLineNumber: 1,
      responseLineNumber: 4,
    });
    const respondedInsideRange = createHttpRequest({
      requestId: 'RESPONDS-IN',
      status: '500',
      requestSize: 200,
      responseSize: 400,
      sendLineNumber: 0,
      responseLineNumber: 2,
    });

    const localRange = {
      startUs: rawLines[1].timestampUs,
      endUs: rawLines[2].timestampUs,
    };

    const result = computeSummaryStats(
      rawLines,
      [startedInsideRange, respondedInsideRange],
      [],
      [],
      [],
      null,
      null,
      localRange,
      index,
    );

    expect(result.httpRequestsWithTimestamps).toEqual([
      {
        requestId: 'STARTS-IN',
        status: '200',
        timestampUs: rawLines[1].timestampUs,
        uri: 'https://matrix.example.org/_matrix/client/v3/sync?request=1',
      },
    ]);
    expect(result.httpRequestCount).toBe(1);
    expect(result.totalUploadBytes).toBe(100);
    expect(result.totalDownloadBytes).toBe(300);
  });

  it('plots retried requests at attempt start timestamps', () => {
    const rawLines = makeLines(5);
    const index = buildIndex(rawLines);

    const retriedRequest = createHttpRequest({
      requestId: 'RETRY-STARTS',
      status: '200',
      sendLineNumber: 0,
      responseLineNumber: 4,
      numAttempts: 2,
      attemptOutcomes: ['503', '200'],
      attemptTimestampsUs: [rawLines[0].timestampUs, rawLines[2].timestampUs],
    });

    const result = computeSummaryStats(rawLines, [retriedRequest], [], [], [], null, null, null, index);

    expect(result.httpRequestsWithTimestamps).toEqual([
      {
        requestId: 'RETRY-STARTS',
        status: '503',
        timestampUs: rawLines[0].timestampUs,
        uri: 'https://matrix.example.org/_matrix/client/v3/sync?request=0',
      },
      {
        requestId: 'RETRY-STARTS',
        status: '200',
        timestampUs: rawLines[2].timestampUs,
        uri: 'https://matrix.example.org/_matrix/client/v3/sync?request=0',
      },
    ]);
    expect(result.httpRequestCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// httpRequestCount — unique request headline count
// ---------------------------------------------------------------------------

describe('computeSummaryStats — httpRequestCount', () => {
  it('counts requests with valid start timestamps plus incomplete requests', () => {
    const rawLines = makeLines(4);
    const index = buildIndex(rawLines);

    const completed = createHttpRequest({ requestId: 'R1', status: '200', responseLineNumber: 1 });
    // responseLineNumber 999 no longer matters for the chart headline because
    // phase 1 counts requests by send/start timestamp.
    const missingResponseTimestamp = createHttpRequest({ requestId: 'R2', status: '200', responseLineNumber: 999 });
    const incomplete = createHttpRequest({ requestId: 'R3', status: '', sendLineNumber: 2, responseLineNumber: 0 });
    const missingStartTimestamp = createHttpRequest({ requestId: 'R4', status: '200', sendLineNumber: 999, responseLineNumber: 1 });

    const result = computeSummaryStats(
      rawLines,
      [completed, missingResponseTimestamp, incomplete, missingStartTimestamp],
      [],
      [],
      [],
      null,
      null,
      null,
      index,
    );

    expect(result.httpRequestCount).toBe(3); // 2 started requests + 1 incomplete
  });

  it('counts client-error requests towards httpRequestCount', () => {
    const rawLines = makeLines(3);
    const index = buildIndex(rawLines);

    const clientError = createHttpRequest({ requestId: 'CE', clientError: 'TimedOut', responseLineNumber: 1 });
    const result = computeSummaryStats(rawLines, [clientError], [], [], [], null, null, null, index);
    expect(result.httpRequestCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// topFailedUrls — clientError and non-numeric attemptOutcomes
// ---------------------------------------------------------------------------

describe('computeSummaryStats — topFailedUrls with client errors', () => {
  it('includes requests with clientError in topFailedUrls', () => {
    const rawLines = makeLines(3);
    const index = buildIndex(rawLines);

    const req = createHttpRequest({
      requestId: 'CE',
      uri: '/rooms/join',
      clientError: 'TimedOut',
      responseLineNumber: 1,
    });

    const result = computeSummaryStats(rawLines, [req], [], [], [], null, null, null, index);
    const entry = result.topFailedUrls.find((u) => u.uri === '/rooms/join');
    expect(entry?.count).toBe(1);
    expect(entry?.statuses).toContain('Client Error');
  });

  it('includes non-numeric attemptOutcomes as Client Error in topFailedUrls', () => {
    const rawLines = makeLines(3);
    const index = buildIndex(rawLines);

    const req = createHttpRequest({
      requestId: 'RETRY',
      uri: '/send',
      status: '200',
      responseLineNumber: 2,
      numAttempts: 2,
      attemptOutcomes: ['TimedOut', '200'],
    });

    const result = computeSummaryStats(rawLines, [req], [], [], [], null, null, null, index);
    const entry = result.topFailedUrls.find((u) => u.uri === '/send');
    expect(entry?.statuses).toContain('Client Error');
  });

  it('does not count Incomplete attemptOutcomes as Client Error in topFailedUrls', () => {
    // 'Incomplete' is a parser placeholder for unknown intermediate outcomes and must
    // not inflate Top Failed URLs with a spurious 'Client Error' entry.
    const rawLines = makeLines(3);
    const index = buildIndex(rawLines);

    const req = createHttpRequest({
      requestId: 'RETRY_INC',
      uri: '/send/incomplete',
      status: '200',
      responseLineNumber: 2,
      numAttempts: 2,
      attemptOutcomes: ['Incomplete', '200'],
    });

    const result = computeSummaryStats(rawLines, [req], [], [], [], null, null, null, index);
    const entry = result.topFailedUrls.find((u) => u.uri === '/send/incomplete');
    expect(entry).toBeUndefined();
  });

  it('maps Incomplete intermediate chart entries to empty status, not client-error', () => {
    // An 'Incomplete' placeholder in attemptOutcomes must produce an empty-string
    // status (treated as incomplete in the chart) rather than 'client-error'.
    const rawLines = makeLines(5);
    const index = buildIndex(rawLines);

    const req = createHttpRequest({
      requestId: 'RETRY_INC_CHART',
      uri: '/send/incomplete-chart',
      status: '200',
      responseLineNumber: 2,
      numAttempts: 2,
      attemptOutcomes: ['Incomplete', '200'],
      attemptTimestampsUs: [
        rawLines[0].timestampUs,
        rawLines[1].timestampUs,
      ],
    });

    const result = computeSummaryStats(rawLines, [req], [], [], [], null, null, null, index);
    const intermediateEntry = result.httpRequestsWithTimestamps.find(
      (e) => e.requestId === 'RETRY_INC_CHART' && e.status === ''
    );
    expect(intermediateEntry).toBeDefined();
    expect(intermediateEntry?.timestampUs).toBe(rawLines[0].timestampUs);
    const clientErrorEntry = result.httpRequestsWithTimestamps.find(
      (e) => e.requestId === 'RETRY_INC_CHART' && e.status === 'client-error'
    );
    expect(clientErrorEntry).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// httpRequestsWithBandwidth
// ---------------------------------------------------------------------------

describe('computeSummaryStats — httpRequestsWithBandwidth', () => {
  it('includes completed requests with both upload and download bytes', () => {
    const rawLines = makeLines(3);
    const index = buildIndex(rawLines);

    const req = createHttpRequest({
      requestId: 'R1',
      requestSize: 200,
      responseSize: 1000,
      sendLineNumber: 0,
      responseLineNumber: 1,
    });

    const result = computeSummaryStats(rawLines, [req], [], [], [], null, null, null, index);

    expect(result.httpRequestsWithBandwidth).toHaveLength(1);
    expect(result.httpRequestsWithBandwidth[0].uploadBytes).toBe(200);
    expect(result.httpRequestsWithBandwidth[0].downloadBytes).toBe(1000);
    // Completed requests use sendLineNumber (start-based) not responseLineNumber.
    expect(result.httpRequestsWithBandwidth[0].timestampUs).toBe(rawLines[0].timestampUs);
  });

  it('preserves the URI on each entry', () => {
    const rawLines = makeLines(3);
    const index = buildIndex(rawLines);

    const req = createHttpRequest({
      requestId: 'R1',
      uri: 'https://matrix.example.org/_matrix/client/v3/rooms',
      requestSize: 100,
      responseSize: 500,
      sendLineNumber: 0,
      responseLineNumber: 1,
    });

    const result = computeSummaryStats(rawLines, [req], [], [], [], null, null, null, index);

    expect(result.httpRequestsWithBandwidth[0].uri).toBe(
      'https://matrix.example.org/_matrix/client/v3/rooms',
    );
  });

  it('includes in-flight requests with upload bytes only (downloadBytes = 0)', () => {
    const rawLines = makeLines(3);
    const index = buildIndex(rawLines);

    // No responseLineNumber → in-flight / incomplete
    const req = createHttpRequest({
      requestId: 'R2',
      status: '',
      requestSize: 300,
      responseSize: 0,
      sendLineNumber: 1,
      responseLineNumber: 0,
    });

    const result = computeSummaryStats(rawLines, [req], [], [], [], null, null, null, index);

    expect(result.httpRequestsWithBandwidth).toHaveLength(1);
    expect(result.httpRequestsWithBandwidth[0].uploadBytes).toBe(300);
    expect(result.httpRequestsWithBandwidth[0].downloadBytes).toBe(0);
    expect(result.httpRequestsWithBandwidth[0].timestampUs).toBe(rawLines[1].timestampUs);
  });

  it('excludes requests where both requestSize and responseSize are zero', () => {
    const rawLines = makeLines(3);
    const index = buildIndex(rawLines);

    const req = createHttpRequest({
      requestId: 'R3',
      requestSize: 0,
      responseSize: 0,
      sendLineNumber: 0,
      responseLineNumber: 1,
    });

    const result = computeSummaryStats(rawLines, [req], [], [], [], null, null, null, index);

    expect(result.httpRequestsWithBandwidth).toHaveLength(0);
  });

  it('excludes requests whose timestamp falls outside the active time range', () => {
    const rawLines = makeLines(5);
    const index = buildIndex(rawLines);

    // Line 4 is outside the range we will specify (lines 0-2)
    const inRange = createHttpRequest({
      requestId: 'IN',
      requestSize: 100,
      responseSize: 500,
      sendLineNumber: 0,
      responseLineNumber: 1,
    });
    const outOfRange = createHttpRequest({
      requestId: 'OUT',
      requestSize: 200,
      responseSize: 800,
      sendLineNumber: 3,
      responseLineNumber: 4,
    });

    const localRange = {
      startUs: rawLines[0].timestampUs,
      endUs: rawLines[2].timestampUs,
    };

    const result = computeSummaryStats(
      rawLines,
      [inRange, outOfRange],
      [],
      [],
      [],
      null,
      null,
      localRange,
      index,
    );

    expect(result.httpRequestsWithBandwidth).toHaveLength(1);
    expect(result.httpRequestsWithBandwidth[0].uploadBytes).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// httpRequestSpans — concurrent in-flight chart data
// ---------------------------------------------------------------------------

describe('computeSummaryStats — httpRequestSpans', () => {
  it('returns empty array when there are no HTTP requests', () => {
    const rawLines = makeLines(3);
    const index = buildIndex(rawLines);
    const result = computeSummaryStats(rawLines, [], [], [], [], null, null, null, index);
    expect(result.httpRequestSpans).toHaveLength(0);
  });

  it('resolves startUs and endUs for a completed request', () => {
    const rawLines = makeLines(4);
    const index = buildIndex(rawLines);

    const req = createHttpRequest({
      requestId: 'R-1',
      status: '200',
      sendLineNumber: 0,
      responseLineNumber: 2,
    });

    const result = computeSummaryStats(rawLines, [req], [], [], [], null, null, null, index);

    expect(result.httpRequestSpans).toHaveLength(1);
    expect(result.httpRequestSpans[0].startUs).toBe(rawLines[0].timestampUs);
    expect(result.httpRequestSpans[0].endUs).toBe(rawLines[2].timestampUs);
    expect(result.httpRequestSpans[0].status).toBe('200');
    expect(result.httpRequestSpans[0].timeout).toBeUndefined();
  });

  it('prefers attemptTimestampsUs[0] over sendLineNumber for startUs', () => {
    const rawLines = makeLines(4);
    const index = buildIndex(rawLines);

    // attemptTimestampsUs[0] points to line 1, sendLineNumber to line 0
    const req = createHttpRequest({
      requestId: 'R-2',
      status: '200',
      sendLineNumber: 0,
      responseLineNumber: 3,
      attemptTimestampsUs: [rawLines[1].timestampUs, rawLines[2].timestampUs],
      numAttempts: 2,
    });

    const result = computeSummaryStats(rawLines, [req], [], [], [], null, null, null, index);

    expect(result.httpRequestSpans[0].startUs).toBe(rawLines[1].timestampUs);
    expect(result.httpRequestSpans[0].endUs).toBe(rawLines[3].timestampUs);
  });

  it('sets endUs to null for an incomplete request (no responseLineNumber)', () => {
    const rawLines = makeLines(3);
    const index = buildIndex(rawLines);

    const req = createHttpRequest({
      requestId: 'R-incomplete',
      status: '',
      sendLineNumber: 0,
      responseLineNumber: 0, // 0 = no response yet
    });

    const result = computeSummaryStats(rawLines, [req], [], [], [], null, null, null, index);

    expect(result.httpRequestSpans).toHaveLength(1);
    expect(result.httpRequestSpans[0].endUs).toBeNull();
    expect(result.httpRequestSpans[0].status).toBe('');
  });

  it('maps clientError to "client-error" status', () => {
    const rawLines = makeLines(3);
    const index = buildIndex(rawLines);

    const req = createHttpRequest({
      requestId: 'R-err',
      status: '',
      clientError: 'TimedOut',
      sendLineNumber: 0,
      responseLineNumber: 2,
    });

    const result = computeSummaryStats(rawLines, [req], [], [], [], null, null, null, index);

    expect(result.httpRequestSpans[0].status).toBe('client-error');
  });

  it('carries timeout from matching sync request', () => {
    const rawLines = makeLines(4);
    const index = buildIndex(rawLines);

    const syncReq = createSyncRequest({
      requestId: 'S-1',
      status: '200',
      sendLineNumber: 0,
      responseLineNumber: 3,
      timeout: 30_000,
    });

    const result = computeSummaryStats(
      rawLines,
      [syncReq],
      [syncReq],
      ['conn-1'],
      [],
      null,
      null,
      null,
      index,
    );

    expect(result.httpRequestSpans[0].timeout).toBe(30_000);
  });

  it('produces one span per logical request (retried request is not expanded)', () => {
    const rawLines = makeLines(6);
    const index = buildIndex(rawLines);

    const retriedReq = createHttpRequest({
      requestId: 'R-retry',
      status: '200',
      sendLineNumber: 0,
      responseLineNumber: 5,
      numAttempts: 3,
      attemptTimestampsUs: [rawLines[0].timestampUs, rawLines[2].timestampUs, rawLines[4].timestampUs],
      attemptOutcomes: ['503', '503', '200'],
    });

    const result = computeSummaryStats(rawLines, [retriedReq], [], [], [], null, null, null, index);

    // Spans are always one-per-request, unlike httpRequestsWithTimestamps which expands retries
    expect(result.httpRequestSpans).toHaveLength(1);
    expect(result.httpRequestSpans[0].startUs).toBe(rawLines[0].timestampUs);
    expect(result.httpRequestSpans[0].endUs).toBe(rawLines[5].timestampUs);
  });
});

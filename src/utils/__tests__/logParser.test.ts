/**
 * Unit tests for logParser.ts
 * Tests parsing correctness, edge cases, and error handling.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { locatePrettySourceRef, parseAllHttpRequests, parseLogFile } from '../logParser';
import { ParsingError } from '../errorHandling';
import { CRYPTO_WASM_PRETTY_ENTRY } from '../../test/fixtures';

// Sample log line formats from real rageshake logs
const SEND_LINE = '2026-01-26T17:02:25.042916Z DEBUG matrix_sdk::http_client::native: Sending request num_attempt=1 | crates/matrix-sdk/src/http_client/native.rs:78 | spans: root > sync_once{conn_id="room-list"} > send{request_id="REQ-62" method=POST uri="https://matrix-client.matrix.org/_matrix/client/unstable/org.matrix.simplified_msc3575/sync" request_size="5.9k"}';
const SEND_LINE_WITH_TIMEOUT = SEND_LINE.replace('sync_once{conn_id="room-list"}', 'sync_once{conn_id="room-list" timeout=0}');
const SEND_LINE_WITH_URI_TIMEOUT = SEND_LINE.replace(
  'org.matrix.simplified_msc3575/sync"',
  'org.matrix.simplified_msc3575/sync?timeout=30000"'
);

const RESPONSE_LINE = '2026-01-26T17:02:25.416416Z DEBUG matrix_sdk::http_client: Got response | crates/matrix-sdk/src/http_client/mod.rs:210 | spans: root > next_sync_with_lock{store_generation=55} > sync_once{conn_id="encryption"} > send{request_id="REQ-63" method=POST uri="https://matrix-client.matrix.org/_matrix/client/unstable/org.matrix.simplified_msc3575/sync" request_size="113B" status=200 response_size="7.4k" request_duration=359.998542ms}';

const INFO_LINE = '2026-01-26T17:02:25.038968Z  INFO elementx: Received sync service update: running | ClientProxy.swift:1055 | spans: root';

// Client-error log line (TimedOut): send{} in spans but no request_size
const CLIENT_ERROR_TIMEOUT_LINE = '2026-01-26T17:02:55.100000Z ERROR matrix_sdk::http_client: Error while sending request: Reqwest(reqwest::Error { kind: Request, url: "https://matrix-client.matrix.org/_matrix/client/v3/rooms/!room:matrix.org/members", source: TimedOut }) | crates/matrix-sdk/src/http_client/mod.rs:218 | spans: root > send{request_id="REQ-99" method=GET uri="https://matrix-client.matrix.org/_matrix/client/v3/rooms/!room:matrix.org/members"}';

// Client-error log line (ConnectError)
const CLIENT_ERROR_CONNECT_LINE = '2026-01-26T17:02:56.000000Z ERROR matrix_sdk::http_client: Error while sending request: Reqwest(reqwest::Error { kind: Connect, url: "https://matrix-client.matrix.org/_matrix/client/v3/keys/upload", source: ConnectError("tcp connect error", ...) }) | crates/matrix-sdk/src/http_client/mod.rs:218 | spans: root > send{request_id="REQ-100" method=POST uri="https://matrix-client.matrix.org/_matrix/client/v3/keys/upload"}';

// Retry test fixtures: REQ-1096 with 3 send attempts followed by a TimedOut error.
// Timestamps chosen to give known inter-attempt gaps.
const RETRY_URI = 'https://example.org/_matrix/client/v3/rooms/!room:example.org/messages';
const RETRY_SEND_1 = `2026-03-11T08:15:10.000000Z DEBUG matrix_sdk::http_client::native: Sending request num_attempt=1 | crates/matrix-sdk/src/http_client/native.rs:78 | spans: root > send{request_id="REQ-1096" method=GET uri="${RETRY_URI}"}`;
const RETRY_SEND_2 = `2026-03-11T08:15:40.000000Z DEBUG matrix_sdk::http_client::native: Sending request num_attempt=2 | crates/matrix-sdk/src/http_client/native.rs:78 | spans: root > send{request_id="REQ-1096" method=GET uri="${RETRY_URI}"}`;
const RETRY_SEND_3 = `2026-03-11T08:16:10.000000Z DEBUG matrix_sdk::http_client::native: Sending request num_attempt=3 | crates/matrix-sdk/src/http_client/native.rs:78 | spans: root > send{request_id="REQ-1096" method=GET uri="${RETRY_URI}"}`;
const RETRY_ERROR  = `2026-03-11T08:16:40.000000Z ERROR matrix_sdk::http_client: Error while sending request: Reqwest(reqwest::Error { kind: Request, url: "${RETRY_URI}", source: TimedOut }) | crates/matrix-sdk/src/http_client/mod.rs:218 | spans: root > send{request_id="REQ-1096" method=GET uri="${RETRY_URI}"}`;
const RETRY_RESPONSE_200 = `2026-03-11T08:15:42.000000Z DEBUG matrix_sdk::http_client: Got response | crates/matrix-sdk/src/http_client/mod.rs:210 | spans: root > send{request_id="REQ-1096" method=GET uri="${RETRY_URI}" request_size="0" status=200 response_size="2k" request_duration=2000ms}`;
// Real-world SDK behavior: the num_attempt=2 "Sending request" line carries span context
// accumulated from the first attempt (status=503, response_size, request_duration).
// Without the fix this line is mistaken for a 503 response by HTTP_RESP_RE.
const RETRY_SEND_2_WITH_503_SPAN = `2026-03-11T08:15:40.000000Z DEBUG matrix_sdk::http_client::native: Sending request num_attempt=2 | crates/matrix-sdk/src/http_client/native.rs:78 | spans: root > send{request_id="REQ-1096" method=GET uri="${RETRY_URI}" request_size="0" status=503 response_size="71B" request_duration=30000ms}`;
// "Got response" line that carries both the 503 span context and the final 200 response
// data in the same span field list (SDK accumulates fields from each nested span).
const RETRY_RESPONSE_200_WITH_503_SPAN = `2026-03-11T08:15:42.000000Z DEBUG matrix_sdk::http_client: Got response | crates/matrix-sdk/src/http_client/mod.rs:214 | spans: root > send{request_id="REQ-1096" method=GET uri="${RETRY_URI}" request_size="0" status=503 response_size="71B" request_duration=30000ms status=200 response_size="2k" request_duration=2000ms}`;

// Since matrix-rust-sdk b8b4e9bb9 ("Outline span creation in HttpClient::send") the send{} span
// opens with config=RequestConfig { … } — braces and all — before request_id.
const CONFIG_SPAN = 'send{config=RequestConfig { timeout: Some(30s), read_timeout: 60s, retry_limit: 3 } request_id=';
const SEND_LINE_WITH_CONFIG = '2026-08-10T12:06:54.898000Z DEBUG matrix_sdk::http_client::native: Sending request num_attempt=1 | crates/matrix-sdk/src/http_client/native.rs:83 | spans: send_outgoing_requests > keys_upload{request_id="ced2a588c2784712943fe4231e622bf6"} > ' + CONFIG_SPAN + '"REQ-385" method=POST uri="https://matrix-client.matrix.org/_matrix/client/v3/keys/upload" request_size="587B"}';
const RESPONSE_LINE_WITH_CONFIG = '2026-08-10T12:06:55.057000Z DEBUG matrix_sdk::http_client: Got response | crates/matrix-sdk/src/http_client/mod.rs:197 | spans: send_outgoing_requests > keys_upload{request_id="ced2a588c2784712943fe4231e622bf6"} > ' + CONFIG_SPAN + '"REQ-385" method=POST uri="https://matrix-client.matrix.org/_matrix/client/v3/keys/upload" request_size="587B" status=400 response_size="598B" request_duration=158.972542ms}';

// Send line for REQ-99 (appears before the error)
const SEND_LINE_REQ99 = '2026-01-26T17:02:45.000000Z  INFO matrix_sdk::http_client::native: Sending request | crates/matrix-sdk/src/http_client/native.rs:89 | spans: root > send{request_id="REQ-99" method=GET uri="https://matrix-client.matrix.org/_matrix/client/v3/rooms/!room:matrix.org/members" request_size="0"}';

// Send line for REQ-100 (appears before the connect error)
const SEND_LINE_REQ100 = '2026-01-26T17:02:55.990000Z  INFO matrix_sdk::http_client::native: Sending request | crates/matrix-sdk/src/http_client/native.rs:89 | spans: root > send{request_id="REQ-100" method=POST uri="https://matrix-client.matrix.org/_matrix/client/v3/keys/upload" request_size="512"}';

// Send line without request_size= in span (observed with some API error paths in the SDK).
const SEND_LINE_NO_REQUEST_SIZE = '2026-03-11T12:52:18.399611Z DEBUG matrix_sdk::http_client::native: Sending request num_attempt=1 | crates/matrix-sdk/src/http_client/native.rs:78 | spans: keys_query{request_id="0c7a35d0af474b258f4699e4fe0e7f38"} > update_state_after_keys_query > send{request_id="REQ-18" method=GET uri="https://matrix-client.matrix.org/_matrix/client/v3/user/@user:matrix.org/account_data/m.secret_storage.default_key"}';

// Error response line for REQ-18 that carries a 404 status in its span but no request_size=.
const HTTP_ERROR_404_LINE = '2026-03-11T12:52:18.485177Z ERROR matrix_sdk::http_client: Error while sending request: Api(Server(ClientApi(Error { status_code: 404, body: Standard(StandardErrorBody { kind: NotFound, message: "Account data not found" }) }))) | crates/matrix-sdk/src/http_client/mod.rs:218 | spans: keys_query{request_id="0c7a35d0af474b258f4699e4fe0e7f38"} > update_state_after_keys_query > send{request_id="REQ-18" method=GET uri="https://matrix-client.matrix.org/_matrix/client/v3/user/@user:matrix.org/account_data/m.secret_storage.default_key" status=404 response_size="58B" request_duration=85.251916ms}';

describe('logParser', () => {
  describe('parseAllHttpRequests', () => {
    describe('basic parsing', () => {
      it('parses a complete request-response pair', () => {
        const logContent = `${SEND_LINE}\n${RESPONSE_LINE.replace('REQ-63', 'REQ-62')}`;
        const result = parseAllHttpRequests(logContent);

        expect(result.httpRequests).toHaveLength(1);
        expect(result.httpRequests[0]).toMatchObject({
          requestId: 'REQ-62',
          method: 'POST',
          uri: expect.stringContaining('/sync'),
          status: '200',
          requestSizeString: '5.9k',
          responseSizeString: '7.4k',
          requestSize: Math.round(5.9 * 1024),  // 6042
          responseSize: Math.round(7.4 * 1024), // 7578
          sendLineNumber: 1,
          responseLineNumber: 2,
        });
        expect(result.httpRequests[0].requestDurationMs).toBe(360); // 359.998542ms rounded
      });

      it('parses send-only requests (incomplete)', () => {
        const result = parseAllHttpRequests(SEND_LINE);

        expect(result.httpRequests).toHaveLength(1);
        expect(result.httpRequests[0]).toMatchObject({
          requestId: 'REQ-62',
          method: 'POST',
          uri: expect.stringContaining('/sync'),
          status: '',
          sendLineNumber: 1,
          responseLineNumber: 0,
        });
      });

      it('parses response-only entries (late join)', () => {
        const result = parseAllHttpRequests(RESPONSE_LINE);

        expect(result.httpRequests).toHaveLength(1);
        expect(result.httpRequests[0]).toMatchObject({
          requestId: 'REQ-63',
          status: '200',
          sendLineNumber: 0,
          responseLineNumber: 1,
        });
      });

      it('parses a pair whose send{} span starts with config=RequestConfig { … }', () => {
        const result = parseAllHttpRequests(`${SEND_LINE_WITH_CONFIG}\n${RESPONSE_LINE_WITH_CONFIG}`);

        expect(result.httpRequests).toHaveLength(1);
        expect(result.httpRequests[0]).toMatchObject({
          requestId: 'REQ-385',
          method: 'POST',
          uri: expect.stringContaining('/keys/upload'),
          status: '400',
          requestSizeString: '587B',
          responseSizeString: '598B',
          sendLineNumber: 1,
          responseLineNumber: 2,
        });
      });

      it('matches send and response by request_id', () => {
        // Send first, then response
        const content = [
          SEND_LINE.replace('REQ-62', 'REQ-100'),
          INFO_LINE, // Non-HTTP line in between
          RESPONSE_LINE.replace('REQ-63', 'REQ-100'),
        ].join('\n');

        const result = parseAllHttpRequests(content);

        expect(result.httpRequests).toHaveLength(1);
        expect(result.httpRequests[0].sendLineNumber).toBe(1);
        expect(result.httpRequests[0].responseLineNumber).toBe(3);
      });
    });

    describe('rawLogLines parsing', () => {
      it('parses all non-empty lines into rawLogLines', () => {
        const content = `${INFO_LINE}\n\n${SEND_LINE}`;
        const result = parseAllHttpRequests(content);

        expect(result.rawLogLines).toHaveLength(2);
        expect(result.rawLogLines[0].lineNumber).toBe(1);
        expect(result.rawLogLines[1].lineNumber).toBe(3);
      });

      it('extracts ISO timestamps correctly', () => {
        const result = parseAllHttpRequests(INFO_LINE);

        expect(result.rawLogLines).toHaveLength(1);
        expect(result.rawLogLines[0].isoTimestamp).toBe('2026-01-26T17:02:25.038968Z');
      });

      it('extracts log level correctly', () => {
        const logLines = [
          '2026-01-01T00:00:00.000000Z TRACE message',
          '2026-01-01T00:00:00.000000Z DEBUG message',
          '2026-01-01T00:00:00.000000Z  INFO message',
          '2026-01-01T00:00:00.000000Z  WARN message',
          '2026-01-01T00:00:00.000000Z ERROR message',
        ].join('\n');

        const result = parseAllHttpRequests(logLines);

        expect(result.rawLogLines[0].level).toBe('TRACE');
        expect(result.rawLogLines[1].level).toBe('DEBUG');
        expect(result.rawLogLines[2].level).toBe('INFO');
        expect(result.rawLogLines[3].level).toBe('WARN');
        expect(result.rawLogLines[4].level).toBe('ERROR');
      });

      it('returns UNKNOWN for unrecognized log levels', () => {
        const result = parseAllHttpRequests('2026-01-01T00:00:00.000000Z CUSTOM message');

        expect(result.rawLogLines[0].level).toBe('UNKNOWN');
      });

      it('calculates timestampUs in microseconds', () => {
        const result = parseAllHttpRequests(INFO_LINE);

        expect(result.rawLogLines[0].timestampUs).toBeGreaterThan(0);
        // 2026-01-26T17:02:25.038968Z should be in the ballpark of ~1769 trillion microseconds
        expect(result.rawLogLines[0].timestampUs).toBeGreaterThan(1_700_000_000_000_000);
      });

      it('extracts displayTime (time-only portion)', () => {
        const result = parseAllHttpRequests(INFO_LINE);

        expect(result.rawLogLines[0].displayTime).toBe('17:02:25.038968');
      });

      it('strips message prefix correctly', () => {
        const result = parseAllHttpRequests(INFO_LINE);

        // Should have the timestamp and INFO stripped
        expect(result.rawLogLines[0].strippedMessage).not.toMatch(/^2026-01-26T/);
        expect(result.rawLogLines[0].strippedMessage).toContain('elementx');
      });

      it('extracts source path and line number for rust entries', () => {
        const result = parseAllHttpRequests(SEND_LINE);

        expect(result.rawLogLines[0].filePath).toBe('crates/matrix-sdk/src/http_client/native.rs');
        expect(result.rawLogLines[0].sourceLineNumber).toBe(78);
      });

      it('extracts source path and line number for swift entries', () => {
        const result = parseAllHttpRequests(INFO_LINE);

        expect(result.rawLogLines[0].filePath).toBe('ClientProxy.swift');
        expect(result.rawLogLines[0].sourceLineNumber).toBe(1055);
      });

      it('leaves source fields undefined when no source marker exists', () => {
        const result = parseAllHttpRequests('2026-01-01T00:00:00.000000Z  INFO no source marker here');

        expect(result.rawLogLines[0].filePath).toBeUndefined();
        expect(result.rawLogLines[0].sourceLineNumber).toBeUndefined();
      });
    });

    describe('multi-line log entries', () => {
      // Reproduces the real-world case from the bug report: a Rust ERROR that spans
      // many physical lines followed by a normal INFO line on its own line.
      const MULTI_LINE_ERROR = [
        '2026-04-01T09:18:52.057456Z ERROR matrix_sdk_ui::sync_service: Error while processing room list in sync service: Some(',
        '    RoomList(',
        '        SlidingSync(',
        '            Http(',
        '                Api(',
        '                    Server(',
        '                        ClientApi(',
        '                            Error {',
        '                                status_code: 404,',
        '                                body: Standard(',
        '                                    StandardErrorBody {',
        '                                        kind: NotFound,',
        '                                        message: "Could not find room_version for !aroomid:example.org",',
        '                                    },',
        '                                ),',
        '                            },',
        '                        ),',
        '                    ),',
        '                ),',
        '            ),',
        '        ),',
        '    ),',
        ') | crates/matrix-sdk-ui/src/sync_service.rs:426',
        '2026-04-01T09:18:52.059145Z  INFO matrix_sdk_ui::sync_service: Entering the offline mode | crates/matrix-sdk-ui/src/sync_service.rs:160 | spans: supervisor task',
      ].join('\n');

      it('groups continuation lines into the parent entry', () => {
        const result = parseAllHttpRequests(MULTI_LINE_ERROR);

        // 23 physical lines → 2 logical log entries (1 ERROR + 1 INFO)
        expect(result.rawLogLines).toHaveLength(2);
      });

      it('stores continuation lines on the parent entry', () => {
        const result = parseAllHttpRequests(MULTI_LINE_ERROR);
        const errorEntry = result.rawLogLines[0];

        // 22 continuation lines (all physical lines after the first)
        expect(errorEntry.continuationLines).toHaveLength(22);
        // First continuation line is the indent of "RoomList("
        expect(errorEntry.continuationLines[0]).toContain('RoomList(');
        // One of the continuation lines contains the NotFound message
        expect(errorEntry.continuationLines.some((l) => l.includes('NotFound'))).toBe(true);
      });

      it('includes continuation text in rawText for search matching', () => {
        const result = parseAllHttpRequests(MULTI_LINE_ERROR);
        const errorEntry = result.rawLogLines[0];

        // rawText must span all physical lines so text search can find "NotFound"
        expect(errorEntry.rawText).toContain('NotFound');
        expect(errorEntry.rawText).toContain('sync_service.rs:426');
      });

      it('preserves correct level and timestamp on the parent entry', () => {
        const result = parseAllHttpRequests(MULTI_LINE_ERROR);
        const errorEntry = result.rawLogLines[0];

        expect(errorEntry.level).toBe('ERROR');
        expect(errorEntry.isoTimestamp).toBe('2026-04-01T09:18:52.057456Z');
        expect(errorEntry.lineNumber).toBe(1);
      });

      it('parses the following single-line entry independently', () => {
        const result = parseAllHttpRequests(MULTI_LINE_ERROR);
        const infoEntry = result.rawLogLines[1];

        expect(infoEntry.level).toBe('INFO');
        expect(infoEntry.continuationLines).toBeUndefined();
        expect(infoEntry.isoTimestamp).toBe('2026-04-01T09:18:52.059145Z');
      });

      it('single-line entries have no continuationLines property', () => {
        const result = parseAllHttpRequests(INFO_LINE);

        expect(result.rawLogLines[0].continuationLines).toBeUndefined();
      });

      it('orphaned continuation lines before any timestamp become standalone UNKNOWN entries', () => {
        // A log that begins with non-timestamped lines before the first real entry.
        const content = [
          '    some preamble text with no timestamp',
          '    another orphaned line',
          INFO_LINE,
        ].join('\n');

        const result = parseAllHttpRequests(content);

        // First orphaned line creates a standalone UNKNOWN entry; the second orphaned
        // line is folded into it as a continuation (lastEntry is set after the first).
        // The INFO line becomes the second entry.
        expect(result.rawLogLines).toHaveLength(2);
        expect(result.rawLogLines[0].level).toBe('UNKNOWN');
        expect(result.rawLogLines[0].rawText).toContain('some preamble text with no timestamp');
        expect(result.rawLogLines[0].rawText).toContain('another orphaned line');
        expect(result.rawLogLines[0].isoTimestamp).toBe('');
        // The real INFO entry is parsed correctly.
        expect(result.rawLogLines[1].level).toBe('INFO');
      });

      it('does not fold continuation lines across a blank-line boundary', () => {
        // A blank line between the ERROR and a non-timestamped line must prevent
        // the latter from being folded into the ERROR entry.
        const content = [
          '2026-04-01T09:00:00.000000Z ERROR first entry first line',
          '    continuation of first entry',
          '',
          '    this line is after a blank line and must NOT be a continuation',
          '2026-04-01T09:00:01.000000Z INFO second entry',
        ].join('\n');

        const result = parseAllHttpRequests(content);

        // The ERROR entry should only have 1 continuation line (not 2)
        const errorEntry = result.rawLogLines[0];
        expect(errorEntry.level).toBe('ERROR');
        expect(errorEntry.continuationLines).toHaveLength(1);
        expect(errorEntry.continuationLines[0]).toContain('continuation of first entry');

        // The post-blank non-timestamped line becomes a standalone UNKNOWN entry
        expect(result.rawLogLines[1].level).toBe('UNKNOWN');
        expect(result.rawLogLines[1].rawText).toContain('this line is after a blank line');

        // The INFO line is a normal third entry
        expect(result.rawLogLines[2].level).toBe('INFO');
      });
    });

    describe('duration parsing', () => {
      it('parses millisecond durations', () => {
        const line = RESPONSE_LINE.replace('359.998542ms', '100.5ms');
        const result = parseAllHttpRequests(line);

        expect(result.httpRequests[0].requestDurationMs).toBe(101); // Rounded
      });

      it('parses second durations', () => {
        const line = RESPONSE_LINE.replace('359.998542ms', '2.5s');
        const result = parseAllHttpRequests(line);

        expect(result.httpRequests[0].requestDurationMs).toBe(2500);
      });

      it('handles sub-millisecond durations', () => {
        const line = RESPONSE_LINE.replace('359.998542ms', '0.5ms');
        const result = parseAllHttpRequests(line);

        expect(result.httpRequests[0].requestDurationMs).toBe(1); // Rounded up
      });
    });

    describe('multiple requests', () => {
      it('parses multiple concurrent requests', () => {
        const content = [
          SEND_LINE.replace('REQ-62', 'REQ-1'),
          SEND_LINE.replace('REQ-62', 'REQ-2'),
          RESPONSE_LINE.replace('REQ-63', 'REQ-1'),
          RESPONSE_LINE.replace('REQ-63', 'REQ-2'),
        ].join('\n');

        const result = parseAllHttpRequests(content);

        expect(result.httpRequests).toHaveLength(2);
        expect(result.httpRequests.map(r => r.requestId).sort()).toEqual(['REQ-1', 'REQ-2']);
      });

      it('sorts requests by sendLineNumber, not by Map insertion order', () => {
        // REQ-B response appears first (line 1) → inserted into Map first.
        // REQ-A and REQ-C sends follow (lines 2-3).
        // REQ-B send appears last (line 4), so its sendLineNumber is the highest.
        //
        // Map insertion order:         B, A, C
        // Expected after sort by sendLineNumber: A(2), C(3), B(4)
        //
        // If the sort were absent the result would be [B, A, C], not [A, C, B].
        const content = [
          RESPONSE_LINE.replace('REQ-63', 'REQ-B'),  // line 1 — response only for B
          SEND_LINE.replace('REQ-62', 'REQ-A'),      // line 2 — send for A
          SEND_LINE.replace('REQ-62', 'REQ-C'),      // line 3 — send for C
          SEND_LINE.replace('REQ-62', 'REQ-B'),      // line 4 — send for B (late)
        ].join('\n');

        const result = parseAllHttpRequests(content);

        expect(result.httpRequests).toHaveLength(3);
        expect(result.httpRequests[0].requestId).toBe('REQ-A'); // sendLineNumber=2
        expect(result.httpRequests[1].requestId).toBe('REQ-C'); // sendLineNumber=3
        expect(result.httpRequests[2].requestId).toBe('REQ-B'); // sendLineNumber=4
      });
    });

    describe('regression: response before send (late-arriving send)', () => {
      it('correctly pairs response-first with its subsequent send line', () => {
        // In real logs the response occasionally appears before the send
        // (e.g. when log buffering flushes out of order). The parser must
        // handle this: the request should have both sendLineNumber and responseLineNumber.
        const responseFirst = RESPONSE_LINE.replace('REQ-63', 'REQ-X');
        const sendLater = SEND_LINE.replace('REQ-62', 'REQ-X');
        const content = [responseFirst, sendLater].join('\n');

        const result = parseAllHttpRequests(content);

        expect(result.httpRequests).toHaveLength(1);
        expect(result.httpRequests[0].requestId).toBe('REQ-X');
        // Response at line 1, send at line 2
        expect(result.httpRequests[0].responseLineNumber).toBe(1);
        expect(result.httpRequests[0].sendLineNumber).toBe(2);
        // Status and method are populated from the first seen line (response)
        expect(result.httpRequests[0].status).toBe('200');
        expect(result.httpRequests[0].method).toBe('POST');
      });

      it('does not duplicate the request when paired in reverse order', () => {
        const responseFirst = RESPONSE_LINE.replace('REQ-63', 'REQ-Y');
        const sendLater = SEND_LINE.replace('REQ-62', 'REQ-Y');
        const content = [responseFirst, sendLater].join('\n');

        const result = parseAllHttpRequests(content);

        expect(result.httpRequests).toHaveLength(1);
      });
    });

    describe('regression: duplicate request_id', () => {
      it('creates a separate record for each request when the same request_id is sent twice', () => {
        // When the client reuses the same request_id for two distinct requests,
        // both should appear as independent records in the parsed output.
        const send1 = SEND_LINE.replace('REQ-62', 'DUPE');
        const send2 = SEND_LINE.replace('REQ-62', 'DUPE');
        const content = [send1, send2].join('\n');

        const result = parseAllHttpRequests(content);

        // Both records should appear
        expect(result.httpRequests).toHaveLength(2);
        // Chronological order: first send at line 1, second at line 2
        expect(result.httpRequests[0].sendLineNumber).toBe(1);
        expect(result.httpRequests[1].sendLineNumber).toBe(2);
      });

      it('pairs responses by method/uri when duplicate request_id sends are in-flight', () => {
        const sendA = SEND_LINE
          .replace('REQ-62', 'DUPE-MATCH')
          .replace('method=POST', 'method=GET')
          .replace('/sync"', '/profile"');
        const sendB = SEND_LINE
          .replace('REQ-62', 'DUPE-MATCH')
          .replace('/sync"', '/keys/query"');
        const responseA = RESPONSE_LINE
          .replace('REQ-63', 'DUPE-MATCH')
          .replace('method=POST', 'method=GET')
          .replace('/sync"', '/profile"');
        const responseB = RESPONSE_LINE
          .replace('REQ-63', 'DUPE-MATCH')
          .replace('/sync"', '/keys/query"');

        // If pairing were purely "last unmatched", responseA would incorrectly attach to sendB.
        const content = [sendA, sendB, responseA, responseB].join('\n');
        const result = parseAllHttpRequests(content);

        expect(result.httpRequests).toHaveLength(2);

        const byUri = new Map(result.httpRequests.map(req => [req.uri, req]));
        expect(byUri.get('https://matrix-client.matrix.org/_matrix/client/unstable/org.matrix.simplified_msc3575/profile')?.sendLineNumber).toBe(1);
        expect(byUri.get('https://matrix-client.matrix.org/_matrix/client/unstable/org.matrix.simplified_msc3575/profile')?.responseLineNumber).toBe(3);
        expect(byUri.get('https://matrix-client.matrix.org/_matrix/client/unstable/org.matrix.simplified_msc3575/keys/query')?.sendLineNumber).toBe(2);
        expect(byUri.get('https://matrix-client.matrix.org/_matrix/client/unstable/org.matrix.simplified_msc3575/keys/query')?.responseLineNumber).toBe(4);
      });

      it('falls back to the most recent unmatched send when response method/uri does not match', () => {
        const sendA = SEND_LINE
          .replace('REQ-62', 'DUPE-FALLBACK')
          .replace('/sync"', '/path-a"');
        const sendB = SEND_LINE
          .replace('REQ-62', 'DUPE-FALLBACK')
          .replace('/sync"', '/path-b"');
        const unknownResponse = RESPONSE_LINE
          .replace('REQ-63', 'DUPE-FALLBACK')
          .replace('method=POST', 'method=DELETE')
          .replace('/sync"', '/path-unknown"');

        const result = parseAllHttpRequests([sendA, sendB, unknownResponse].join('\n'));

        expect(result.httpRequests).toHaveLength(2);
        expect(result.httpRequests[0].sendLineNumber).toBe(1);
        expect(result.httpRequests[0].responseLineNumber).toBe(0);
        expect(result.httpRequests[1].sendLineNumber).toBe(2);
        expect(result.httpRequests[1].responseLineNumber).toBe(3);
      });

      it('does not attach a send to an incompatible response-only record', () => {
        const responseA = RESPONSE_LINE
          .replace('REQ-63', 'DUPE-SEND-PAIR')
          .replace('method=POST', 'method=GET')
          .replace('/sync"', '/a"');
        const responseB = RESPONSE_LINE
          .replace('REQ-63', 'DUPE-SEND-PAIR')
          .replace('/sync"', '/b"');
        const sendC = SEND_LINE
          .replace('REQ-62', 'DUPE-SEND-PAIR')
          .replace('/sync"', '/c"');

        const result = parseAllHttpRequests([responseA, responseB, sendC].join('\n'));

        // Keep both response-only records intact; create a new send-only record for /c.
        expect(result.httpRequests).toHaveLength(3);

        const byUri = new Map(result.httpRequests.map(req => [req.uri, req]));
        expect(byUri.get('https://matrix-client.matrix.org/_matrix/client/unstable/org.matrix.simplified_msc3575/a')?.responseLineNumber).toBe(1);
        expect(byUri.get('https://matrix-client.matrix.org/_matrix/client/unstable/org.matrix.simplified_msc3575/a')?.sendLineNumber).toBe(0);
        expect(byUri.get('https://matrix-client.matrix.org/_matrix/client/unstable/org.matrix.simplified_msc3575/b')?.responseLineNumber).toBe(2);
        expect(byUri.get('https://matrix-client.matrix.org/_matrix/client/unstable/org.matrix.simplified_msc3575/b')?.sendLineNumber).toBe(0);
        expect(byUri.get('https://matrix-client.matrix.org/_matrix/client/unstable/org.matrix.simplified_msc3575/c')?.sendLineNumber).toBe(3);
        expect(byUri.get('https://matrix-client.matrix.org/_matrix/client/unstable/org.matrix.simplified_msc3575/c')?.responseLineNumber).toBe(0);
      });
    });

    describe('error handling', () => {
      it('throws ParsingError for empty input', () => {
        expect(() => parseAllHttpRequests('')).toThrow(ParsingError);
        expect(() => parseAllHttpRequests('   ')).toThrow(ParsingError);
      });

      it('throws ParsingError for file with no timestamps', () => {
        const noTimestamps = Array(150).fill('some random text without timestamps').join('\n');
        
        expect(() => parseAllHttpRequests(noTimestamps)).toThrow(ParsingError);
      });

      it('accepts a valid log dominated by long multi-line stack traces', () => {
        // A log with a few timestamped entries each followed by many continuation
        // lines (e.g. a Rust error with a 300-line stack trace). The continuation
        // lines must not inflate the denominator and cause a false rejection.
        const header = '2026-01-01T00:00:00.000000Z ERROR matrix-rust-sdk error occurred';
        const continuationLines = Array(300).fill('    at some::module::function (src/lib.rs:42)');
        const block = [header, ...continuationLines].join('\n');

        // Two such blocks = 602 physical lines, but only 2 logical entries.
        const content = [block, block].join('\n');

        const result = parseAllHttpRequests(content);
        expect(result.rawLogLines).toHaveLength(2);
        // Each entry must have its 300 continuation lines.
        expect(result.rawLogLines[0].continuationLines).toHaveLength(300);
        expect(result.rawLogLines[1].continuationLines).toHaveLength(300);
      });

      it('accepts file with mostly valid timestamps', () => {
        const lines = [
          ...Array(50).fill('no timestamp line'),
          ...Array(100).fill('2026-01-01T00:00:00.000000Z INFO valid line'),
        ];
        
        // Should not throw because >10% have timestamps
        const result = parseAllHttpRequests(lines.join('\n'));
        expect(result.rawLogLines.length).toBeGreaterThan(0);
      });
    });

    describe('edge cases', () => {
      it('handles lines without send{ pattern efficiently', () => {
        const content = Array(1000).fill(INFO_LINE).join('\n');
        const result = parseAllHttpRequests(content);

        expect(result.httpRequests).toHaveLength(0);
        expect(result.rawLogLines).toHaveLength(1000);
      });

      it('handles malformed request lines gracefully', () => {
        const malformed = '2026-01-01T00:00:00.000000Z DEBUG send{request_id="REQ-1" method=';
        
        const result = parseAllHttpRequests(`${INFO_LINE}\n${malformed}`);
        expect(result.httpRequests).toHaveLength(0); // Malformed should not match
      });

      it('handles special characters in URI', () => {
        const lineWithParams = SEND_LINE.replace(
          'uri="https://matrix-client.matrix.org/_matrix/client/unstable/org.matrix.simplified_msc3575/sync"',
          'uri="https://example.com/path?foo=bar&baz=qux%20encoded"'
        );
        
        const result = parseAllHttpRequests(lineWithParams);
        expect(result.httpRequests[0].uri).toContain('foo=bar');
      });
    });

    describe('client-side transport errors', () => {
      it('parses a client error line with a preceding send (TimedOut)', () => {
        const content = [SEND_LINE_REQ99, CLIENT_ERROR_TIMEOUT_LINE].join('\n');
        const result = parseAllHttpRequests(content);

        expect(result.httpRequests).toHaveLength(1);
        expect(result.httpRequests[0]).toMatchObject({
          requestId: 'REQ-99',
          method: 'GET',
          uri: 'https://matrix-client.matrix.org/_matrix/client/v3/rooms/!room:matrix.org/members',
          status: '',
          clientError: 'TimedOut',
          sendLineNumber: 1,
          responseLineNumber: 2,
        });
      });

      it('parses a client error line with no preceding send (error-only)', () => {
        const result = parseAllHttpRequests(CLIENT_ERROR_TIMEOUT_LINE);

        expect(result.httpRequests).toHaveLength(1);
        expect(result.httpRequests[0]).toMatchObject({
          requestId: 'REQ-99',
          method: 'GET',
          clientError: 'TimedOut',
          status: '',
          sendLineNumber: 0,
          responseLineNumber: 1,
        });
      });

      it('parses a POST client error whose span carries request_size', () => {
        // The SDK records request_size for POST/PUT/PATCH before sending, so the span of a
        // transport error on those methods ends with request_size=, not uri=.
        const err = CLIENT_ERROR_CONNECT_LINE.replace('/keys/upload"}', '/keys/upload" request_size="512"}');
        const result = parseAllHttpRequests([SEND_LINE_REQ100, err].join('\n'));

        expect(result.httpRequests).toHaveLength(1);
        expect(result.httpRequests[0]).toMatchObject({
          requestId: 'REQ-100',
          clientError: 'ConnectError',
          sendLineNumber: 1,
          responseLineNumber: 2,
        });
      });

      it('parses a client error whose send{} span starts with config=RequestConfig { … }', () => {
        const result = parseAllHttpRequests(CLIENT_ERROR_TIMEOUT_LINE.replace('send{request_id=', CONFIG_SPAN));

        expect(result.httpRequests).toHaveLength(1);
        expect(result.httpRequests[0]).toMatchObject({
          requestId: 'REQ-99',
          method: 'GET',
          clientError: 'TimedOut',
          responseLineNumber: 1,
        });
      });

      it('extracts ConnectError source label', () => {
        const content = [SEND_LINE_REQ100, CLIENT_ERROR_CONNECT_LINE].join('\n');
        const result = parseAllHttpRequests(content);

        expect(result.httpRequests).toHaveLength(1);
        expect(result.httpRequests[0].clientError).toBe('ConnectError');
      });

      it('computes request duration from timestamps for client-error requests', () => {
        // SEND_LINE_REQ99 timestamp: 2026-01-26T17:02:45.000000Z
        // CLIENT_ERROR_TIMEOUT_LINE timestamp: 2026-01-26T17:02:55.100000Z  → 10100ms elapsed
        const content = [SEND_LINE_REQ99, CLIENT_ERROR_TIMEOUT_LINE].join('\n');
        const result = parseAllHttpRequests(content);

        expect(result.httpRequests[0].requestDurationMs).toBe(10100);
      });

      it('does not set clientError for normal incomplete requests (send only)', () => {
        const result = parseAllHttpRequests(SEND_LINE);

        expect(result.httpRequests[0].clientError).toBeUndefined();
        expect(result.httpRequests[0].status).toBe('');
      });

      it('does not override an already-completed request with a client error', () => {
        // Response arrives first, then an error arrives for the same id (unusual but possible)
        const responseLine = RESPONSE_LINE.replace('REQ-63', 'REQ-99')
          .replace('/sync"', '/rooms/!room:matrix.org/members"')
          .replace('method=POST', 'method=GET')
          .replace('request_size="113B"', 'request_size="0"');
        const content = [responseLine, CLIENT_ERROR_TIMEOUT_LINE].join('\n');
        const result = parseAllHttpRequests(content);

        // The response-only record should not be overwritten; a second record is created
        expect(result.httpRequests).toHaveLength(2);
        const completed = result.httpRequests.find(r => r.status === '200');
        expect(completed).toBeDefined();
        expect(completed?.clientError).toBeUndefined();
      });
    });

    describe('HTTP error responses without request_size in span', () => {
      it('parses a 404 error response line that omits request_size', () => {
        const result = parseAllHttpRequests(HTTP_ERROR_404_LINE);

        expect(result.httpRequests).toHaveLength(1);
        expect(result.httpRequests[0]).toMatchObject({
          requestId: 'REQ-18',
          method: 'GET',
          uri: 'https://matrix-client.matrix.org/_matrix/client/v3/user/@user:matrix.org/account_data/m.secret_storage.default_key',
          status: '404',
          requestSizeString: '',
          responseSizeString: '58B',
          requestDurationMs: 85,
          sendLineNumber: 0,
          responseLineNumber: 1,
        });
        expect(result.httpRequests[0].clientError).toBeUndefined();
      });

      it('parses a send line that omits request_size', () => {
        const result = parseAllHttpRequests(SEND_LINE_NO_REQUEST_SIZE);

        expect(result.httpRequests).toHaveLength(1);
        expect(result.httpRequests[0]).toMatchObject({
          requestId: 'REQ-18',
          method: 'GET',
          status: '',
          sendLineNumber: 1,
          responseLineNumber: 0,
        });
      });

      it('pairs a send line (no request_size) with its 404 error response', () => {
        const content = [SEND_LINE_NO_REQUEST_SIZE, HTTP_ERROR_404_LINE].join('\n');
        const result = parseAllHttpRequests(content);

        expect(result.httpRequests).toHaveLength(1);
        expect(result.httpRequests[0]).toMatchObject({
          requestId: 'REQ-18',
          method: 'GET',
          status: '404',
          responseSizeString: '58B',
          requestDurationMs: 85,
          sendLineNumber: 1,
          responseLineNumber: 2,
        });
        expect(result.httpRequests[0].clientError).toBeUndefined();
      });
    });
  });

  describe('retry attempts (num_attempt)', () => {
    it('defaults numAttempts to 1 when num_attempt is absent', () => {
      const result = parseAllHttpRequests(SEND_LINE_REQ99);

      expect(result.httpRequests[0].numAttempts).toBe(1);
      expect(result.httpRequests[0].attemptTimestampsUs).toHaveLength(1);
    });

    it('records numAttempts=1 for a single num_attempt=1 send line', () => {
      const result = parseAllHttpRequests(SEND_LINE);

      expect(result.httpRequests[0].numAttempts).toBe(1);
      expect(result.httpRequests[0].attemptTimestampsUs).toHaveLength(1);
    });

    it('collapses three retry sends + client-error into one record', () => {
      const content = [RETRY_SEND_1, RETRY_SEND_2, RETRY_SEND_3, RETRY_ERROR].join('\n');
      const result = parseAllHttpRequests(content);

      expect(result.httpRequests).toHaveLength(1);
      const req = result.httpRequests[0];
      expect(req.requestId).toBe('REQ-1096');
      expect(req.numAttempts).toBe(3);
      expect(req.clientError).toBe('TimedOut');
      // sendLineNumber must point to the FIRST attempt
      expect(req.sendLineNumber).toBe(1);
      expect(req.responseLineNumber).toBe(4);
    });

    it('backfills attemptOutcomes with clientError when all retries time out with no intermediate response', () => {
      // Real-world case: SDK emits 3 send lines with no "Got response" between them,
      // then a final TimedOut error. The retry-send spans carry no status= field
      // because there was never a response line to accumulate from. The parser must
      // infer the intermediate outcomes from the final clientError.
      const content = [RETRY_SEND_1, RETRY_SEND_2, RETRY_SEND_3, RETRY_ERROR].join('\n');
      const result = parseAllHttpRequests(content);

      const req = result.httpRequests[0];
      expect(req.numAttempts).toBe(3);
      // All three attempts timed out — outcoms array must have 3 entries
      expect(req.attemptOutcomes).toHaveLength(3);
      expect(req.attemptOutcomes).toEqual(['TimedOut', 'TimedOut', 'TimedOut']);
    });

    it('records a timestamp per attempt for separator positioning', () => {
      const content = [RETRY_SEND_1, RETRY_SEND_2, RETRY_SEND_3, RETRY_ERROR].join('\n');
      const result = parseAllHttpRequests(content);

      const ts = result.httpRequests[0].attemptTimestampsUs!;
      expect(ts).toHaveLength(3);
      // Attempt 2 is 30 000 ms after attempt 1
      expect((ts[1] - ts[0]) / 1000).toBeCloseTo(30000, 0);
      // Attempt 3 is 30 000 ms after attempt 2
      expect((ts[2] - ts[1]) / 1000).toBeCloseTo(30000, 0);
    });

    it('collapses two retry sends + 200 response into one record', () => {
      const content = [RETRY_SEND_1, RETRY_SEND_2, RETRY_RESPONSE_200].join('\n');
      const result = parseAllHttpRequests(content);

      expect(result.httpRequests).toHaveLength(1);
      const req = result.httpRequests[0];
      expect(req.numAttempts).toBe(2);
      expect(req.status).toBe('200');
      expect(req.clientError).toBeUndefined();
      // sendLineNumber must point to the first send
      expect(req.sendLineNumber).toBe(1);
    });

    it('does not collapse sends for different request_ids', () => {
      const otherSend = RETRY_SEND_2.replace('REQ-1096', 'REQ-9999');
      const content = [RETRY_SEND_1, otherSend].join('\n');
      const result = parseAllHttpRequests(content);

      expect(result.httpRequests).toHaveLength(2);
    });

    it('captures intermediate client error as attemptOutcomes[0] when response span present', () => {
      // Intermediate error line (TimedOut client error) between attempt 1 send and attempt 2 send
      const INTERMEDIATE_ERROR = `2026-03-11T08:15:40.000000Z ERROR matrix_sdk::http_client: Error while sending request: Reqwest(reqwest::Error { kind: Request, url: "${RETRY_URI}", source: TimedOut }) | crates/matrix-sdk/src/http_client/mod.rs:218 | spans: root > send{request_id="REQ-1096" method=GET uri="${RETRY_URI}"}`;
      const content = [RETRY_SEND_1, INTERMEDIATE_ERROR, RETRY_SEND_2, RETRY_RESPONSE_200].join('\n');
      const result = parseAllHttpRequests(content);

      expect(result.httpRequests).toHaveLength(1);
      const req = result.httpRequests[0];
      expect(req.numAttempts).toBe(2);
      expect(req.status).toBe('200');
      expect(req.attemptOutcomes).toHaveLength(2);
      expect(req.attemptOutcomes![0]).toBe('TimedOut');
      expect(req.attemptOutcomes![1]).toBe('200');
    });

    it('captures intermediate HTTP response as attemptOutcomes[0] and [1] for three attempts', () => {
      // Attempt 1 → TimedOut, attempt 2 → 503, attempt 3 → 200
      const INTERMEDIATE_ERROR = `2026-03-11T08:15:40.000000Z ERROR matrix_sdk::http_client: Error while sending request: Reqwest(reqwest::Error { kind: Request, url: "${RETRY_URI}", source: TimedOut }) | crates/matrix-sdk/src/http_client/mod.rs:218 | spans: root > send{request_id="REQ-1096" method=GET uri="${RETRY_URI}"}`;
      const RESPONSE_503 = `2026-03-11T08:16:10.000000Z DEBUG matrix_sdk::http_client: Got response | crates/matrix-sdk/src/http_client/mod.rs:210 | spans: root > send{request_id="REQ-1096" method=GET uri="${RETRY_URI}" request_size="0" status=503 response_size="0" request_duration=30000ms}`;
      const content = [RETRY_SEND_1, INTERMEDIATE_ERROR, RETRY_SEND_2, RESPONSE_503, RETRY_SEND_3, RETRY_RESPONSE_200].join('\n');
      const result = parseAllHttpRequests(content);

      expect(result.httpRequests).toHaveLength(1);
      const req = result.httpRequests[0];
      expect(req.numAttempts).toBe(3);
      expect(req.attemptOutcomes).toHaveLength(3);
      expect(req.attemptOutcomes![0]).toBe('TimedOut');
      expect(req.attemptOutcomes![1]).toBe('503');
      expect(req.attemptOutcomes![2]).toBe('200');
      // Since intermediate responses are present, requestDurationMs reflects total elapsed time
      // (from attemptTimestampsUs[0] to final response timestamp), not just the last HTTP call.
      expect(req.requestDurationMs).toBeGreaterThan(2000); // >2s total (RETRY_RESPONSE_200 is 2000ms)
    });

    it('treats num_attempt=2 line with accumulated 503 span context as a retry send, not a response', () => {
      // Real SDK behavior: the "Sending request num_attempt=2" line has the 503 span data
      // from the previous attempt already in its span context. HTTP_RESP_RE must not treat
      // it as a response — the retry-fold logic must run instead.
      const content = [RETRY_SEND_1, RETRY_SEND_2_WITH_503_SPAN, RETRY_RESPONSE_200_WITH_503_SPAN].join('\n');
      const result = parseAllHttpRequests(content);

      expect(result.httpRequests).toHaveLength(1);
      const req = result.httpRequests[0];
      expect(req.requestId).toBe('REQ-1096');
      expect(req.numAttempts).toBe(2);
      expect(req.status).toBe('200');
      expect(req.requestDurationMs).toBeGreaterThan(0);
      // sendLineNumber must point to the first send (line 1), not the retry line
      expect(req.sendLineNumber).toBe(1);
      // The 503 baked into the retry-send span must be captured so bar segments are colored
      expect(req.attemptOutcomes).toEqual(['503', '200']);
    });

    it('uses last status/duration when "Got response" span contains duplicate fields from a retry', () => {
      // The final "Got response" line carries both the 503 span context (from the prior
      // attempt) and the 200 outcome in the same span field list. The parser must use
      // the last occurrence of status=, response_size=, and request_duration=.
      const content = [RETRY_SEND_1, RETRY_RESPONSE_200_WITH_503_SPAN].join('\n');
      const result = parseAllHttpRequests(content);

      expect(result.httpRequests).toHaveLength(1);
      const req = result.httpRequests[0];
      expect(req.status).toBe('200');
      expect(req.requestDurationMs).toBe(2000); // last duration (2000ms), not the first (30000ms)
      expect(req.responseSizeString).toBe('2k'); // last response_size, not '71B'
    });
  });
});

describe('parseLogFile', () => {
    it('extracts sync requests with connId', () => {
      // Both lines must have the same conn_id for consistent extraction
      const sendLine = SEND_LINE;
      const responseLine = RESPONSE_LINE.replace('REQ-63', 'REQ-62').replace('conn_id="encryption"', 'conn_id="room-list"');
      const content = [sendLine, responseLine].join('\n');

      const result = parseLogFile(content);

      expect(result.requests).toHaveLength(1);
      expect(result.requests[0].connId).toBe('room-list');
    });

    it('extracts unique connectionIds', () => {
      // Two different sync requests with different connIds
      const roomListSend = SEND_LINE.replace('REQ-62', 'REQ-1');
      const roomListResponse = RESPONSE_LINE.replace('REQ-63', 'REQ-1').replace('conn_id="encryption"', 'conn_id="room-list"');
      const encryptionSend = SEND_LINE.replace('REQ-62', 'REQ-2').replace('conn_id="room-list"', 'conn_id="encryption"');
      const encryptionResponse = RESPONSE_LINE.replace('REQ-63', 'REQ-2');
      
      const content = [roomListSend, roomListResponse, encryptionSend, encryptionResponse].join('\n');

      const result = parseLogFile(content);

      expect(result.connectionIds).toContain('room-list');
      expect(result.connectionIds).toContain('encryption');
    });

    it('filters to only sync URIs', () => {
      const nonSyncLine = SEND_LINE.replace('/sync', '/rooms/123/messages');
      const content = [
        SEND_LINE,
        nonSyncLine.replace('REQ-62', 'REQ-99'),
      ].join('\n');

      const result = parseLogFile(content);

      // Only the sync request should be in requests
      expect(result.requests).toHaveLength(1);
      expect(result.requests[0].uri).toContain('/sync');
    });

    it('passes through rawLogLines from parseAllHttpRequests', () => {
      const content = [INFO_LINE, SEND_LINE].join('\n');
      const result = parseLogFile(content);

      expect(result.rawLogLines).toHaveLength(2);
    });

    it('extracts sync timeout when present', () => {
      const responseLine = RESPONSE_LINE.replace('REQ-63', 'REQ-62').replace('conn_id="encryption"', 'conn_id="room-list"');
      const content = [SEND_LINE_WITH_TIMEOUT, responseLine].join('\n');

      const result = parseLogFile(content);

      expect(result.requests).toHaveLength(1);
      expect(result.requests[0].timeout).toBe(0);
    });

    it('extracts sync timeout from URI query param when not in span attributes', () => {
      const responseLine = RESPONSE_LINE.replace('REQ-63', 'REQ-62').replace('conn_id="encryption"', 'conn_id="room-list"');
      const content = [SEND_LINE_WITH_URI_TIMEOUT, responseLine].join('\n');

      const result = parseLogFile(content);

      expect(result.requests).toHaveLength(1);
      expect(result.requests[0].timeout).toBe(30000);
    });

    it('keeps sync timeout undefined when not present', () => {
      const responseLine = RESPONSE_LINE.replace('REQ-63', 'REQ-62').replace('conn_id="encryption"', 'conn_id="room-list"');
      const content = [SEND_LINE, responseLine].join('\n');

      const result = parseLogFile(content);

      expect(result.requests).toHaveLength(1);
      expect(result.requests[0].timeout).toBeUndefined();
    });

    it('forwards sentryEvents from parseAllHttpRequests', () => {
      const iosLine = '2026-01-15T10:00:00.110000Z  WARN [matrix-rust-sdk] Sentry detected a crash in the previous run: 865038c59b224a91a09ff62b1b56767d';
      const androidLine = '2026-01-15T10:00:22.390000Z  WARN [matrix-rust-sdk] Sending error to Sentry';
      const content = [INFO_LINE, iosLine, androidLine].join('\n');

      const result = parseLogFile(content);

      expect(result.sentryEvents).toHaveLength(2);
    });

    it('skips lifecycle detection on an unparseable (epoch-zero) timestamp', () => {
      // isoToMicros returns 0 both for a genuinely unparseable timestamp and for
      // the literal Unix epoch — either way, 0 means "absent" and must not be
      // treated as a real lifecycle transition.
      const epochLine = '1970-01-01T00:00:00.000000Z  WARN [matrix-rust-sdk] Application will resign active';
      const result = parseLogFile(epochLine);

      expect(result.lifecycleEvents).toHaveLength(0);
    });
  });

  describe('sentry event detection', () => {
    const IOS_LINE = '2026-01-15T10:00:00.110000Z  WARN [matrix-rust-sdk] Sentry detected a crash in the previous run: 865038c59b224a91a09ff62b1b56767d';
    const ANDROID_LINE = '2026-01-15T10:00:22.390000Z  WARN [matrix-rust-sdk] Sending error to Sentry';

    it('detects iOS crash report and extracts sentry ID and URL', () => {
      const result = parseAllHttpRequests(IOS_LINE);

      expect(result.sentryEvents).toHaveLength(1);
      const event = result.sentryEvents[0];
      expect(event.platform).toBe('ios');
      expect(event.sentryId).toBe('865038c59b224a91a09ff62b1b56767d');
      expect(event.sentryUrl).toBe(
        'https://sentry.tools.element.io/organizations/element/issues/?project=44&query=865038c59b224a91a09ff62b1b56767d'
      );
      expect(event.lineNumber).toBe(1);
    });

    it('detects Android "Sending error to Sentry" line', () => {
      const result = parseAllHttpRequests(ANDROID_LINE);

      expect(result.sentryEvents).toHaveLength(1);
      const event = result.sentryEvents[0];
      expect(event.platform).toBe('android');
      expect(event.sentryId).toBeUndefined();
      expect(event.sentryUrl).toBeUndefined();
      expect(event.lineNumber).toBe(1);
    });

    it('detects multiple sentry events in a single log', () => {
      const content = [INFO_LINE, IOS_LINE, ANDROID_LINE].join('\n');
      const result = parseAllHttpRequests(content);

      expect(result.sentryEvents).toHaveLength(2);
      expect(result.sentryEvents[0].platform).toBe('ios');
      expect(result.sentryEvents[1].platform).toBe('android');
    });

    it('does not produce false positives on regular log lines', () => {
      const content = [INFO_LINE, SEND_LINE, RESPONSE_LINE].join('\n');
      const result = parseAllHttpRequests(content);

      expect(result.sentryEvents).toHaveLength(0);
    });

    it('returns empty sentryEvents when log has no sentry lines', () => {
      const result = parseAllHttpRequests(INFO_LINE);
      expect(result.sentryEvents).toHaveLength(0);
    });
  });

describe('Element Web logs', () => {
  // Shape of an Element Web rageshake: `<ISO> <D|I|W|E> <message>`, request lines
  // from matrix-js-sdk's FetchHttpApi, crypto-wasm lines repeating the Rust level.
  const SYNC = 'https://matrix.example.org/_matrix/client/v3/sync?timeout=30000';
  const VERSIONS = 'https://matrix.example.org/_matrix/client/versions';
  const WEB_LOG = [
    `2026-09-28T15:36:15.417Z I FetchHttpApi: --> GET ${SYNC}`,
    `2026-09-28T15:36:15.500Z I FetchHttpApi: --> GET ${VERSIONS}`,
    `2026-09-28T15:36:15.508Z I FetchHttpApi: <-- GET ${VERSIONS} [8ms TypeError: NetworkError when attempting to fetch resource.]`,
    `2026-09-28T15:36:16.296Z I FetchHttpApi: <-- GET ${SYNC} [879ms 200]`,
    `2026-09-28T15:36:16.300Z I FetchHttpApi: --> GET ${SYNC}`,
    '2026-09-28T15:36:16.400Z W WARN matrix_sdk_crypto::machine: Failed to decrypt a room event',
    '2026-09-28T15:36:16.500Z E sync /sync error fetch failed',
    '2026-09-28T15:36:16.600Z D DEBUG matrix_sdk_crypto::olm: debug line',
  ].join('\n');

  it('maps single-letter levels and drops the repeated Rust level from the message', () => {
    const lines = parseAllHttpRequests(WEB_LOG).rawLogLines;
    expect(lines.map((l) => l.level)).toEqual(['INFO', 'INFO', 'INFO', 'INFO', 'INFO', 'WARN', 'ERROR', 'DEBUG']);
    expect(lines[5].strippedMessage).toBe('matrix_sdk_crypto::machine: Failed to decrypt a room event');
    expect(lines[6].strippedMessage).toBe('sync /sync error fetch failed');
  });

  it('pairs FetchHttpApi requests by method+url, oldest open send first', () => {
    const reqs = parseAllHttpRequests(WEB_LOG).httpRequests;
    expect(reqs).toHaveLength(3);
    expect(reqs[0]).toMatchObject({ method: 'GET', uri: SYNC, status: '200', requestDurationMs: 879, sendLineNumber: 1, responseLineNumber: 4 });
    expect(reqs[1]).toMatchObject({
      uri: VERSIONS,
      status: '',
      clientError: 'TypeError: NetworkError when attempting to fetch resource.',
      requestDurationMs: 8,
      sendLineNumber: 2,
      responseLineNumber: 3,
    });
    // The second sync send never got its response: incomplete, like an unanswered SDK send.
    expect(reqs[2]).toMatchObject({ uri: SYNC, status: '', sendLineNumber: 5, responseLineNumber: 0 });
    // No id in web lines: requests are numbered in send order.
    expect(reqs.map((r) => r.requestId)).toEqual(['1', '2', '3']);
  });

  it('does not pair a response with a send from before a page reload', () => {
    const reqs = parseAllHttpRequests([
      `2026-09-28T15:36:15.000Z D FetchHttpApi: --> GET ${SYNC}`,
      '2026-09-28T15:36:20.000Z D Vector starting at https://app.element.io/',
      `2026-09-28T15:36:21.000Z D FetchHttpApi: --> GET ${SYNC}`,
      `2026-09-28T15:36:22.000Z D FetchHttpApi: <-- GET ${SYNC} [1000ms 200]`,
    ].join('\n')).httpRequests;
    // The pre-reload send stays incomplete; the response belongs to line 3.
    expect(reqs.map((r) => [r.sendLineNumber, r.responseLineNumber])).toEqual([[1, 0], [3, 4]]);
  });

  it('pairs every response of the web demo log with its own send', () => {
    const { httpRequests, rawLogLines } = parseAllHttpRequests(readFileSync('public/demo/demo-web.log', 'utf8'));
    const tsByLine = new Map(rawLogLines.map((l) => [l.lineNumber, l.timestampUs]));
    const paired = httpRequests.filter((r) => r.sendLineNumber > 0 && r.responseLineNumber > 0);
    expect(paired.length).toBeGreaterThan(60);
    // The logged duration is the send→response gap (ms), so a wrong pairing shows up here.
    for (const r of paired) {
      const gapMs = (tsByLine.get(r.responseLineNumber)! - tsByLine.get(r.sendLineNumber)!) / 1000;
      expect(Math.abs(gapMs - r.requestDurationMs), `request ${r.requestId}`).toBeLessThanOrEqual(2);
    }
  });

  it('keeps a response whose send predates the log', () => {
    const reqs = parseAllHttpRequests(`2026-09-28T15:36:16.296Z I FetchHttpApi: <-- GET ${SYNC} [879ms 404]`).httpRequests;
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toMatchObject({ status: '404', sendLineNumber: 0, responseLineNumber: 1 });
  });

  it('detects web page load and presence lifecycle events', () => {
    const log = [
      '2026-09-28T15:36:15.000Z I Vector starting at https://app.element.io/',
      '2026-09-28T15:36:20.000Z D Presence: online',
      '2026-09-28T15:39:20.000Z D Presence: unavailable',
    ].join('\n');
    expect(parseAllHttpRequests(log).lifecycleEvents.map((e) => [e.kind, e.platform, e.lineNumber])).toEqual([
      ['coldStart', 'web', 1],
      ['foreground', 'web', 2],
      ['background', 'web', 3],
    ]);
  });

  it('lists web /sync requests as sync requests', () => {
    expect(parseLogFile(WEB_LOG).requests.map((r) => r.timeout)).toEqual([30000, 30000]);
  });

  it('reads the source location of a crypto-wasm line from its pretty-format `at` line', () => {
    const [line] = parseLogFile(CRYPTO_WASM_PRETTY_ENTRY).rawLogLines;
    expect(line.filePath).toBe('crates/matrix-sdk-crypto/src/session_manager/group_sessions/share_strategy.rs');
    expect(line.sourceLineNumber).toBe(211);
  });

  it('maps a crates.io `at` path (release crypto-wasm builds) onto the repo crate path', () => {
    const [line] = parseLogFile([
      '2026-01-15T10:00:06.800Z W WARN matrix_sdk_crypto::machine: Failed to decrypt a room event',
      '    at /home/runner/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/matrix-sdk-crypto-0.18.0/src/machine/mod.rs:1912',
    ].join('\n')).rawLogLines;
    expect(line.filePath).toBe('crates/matrix-sdk-crypto/src/machine/mod.rs');
    expect(line.sourceLineNumber).toBe(1912);
    // The bare `matrix-sdk` crate has no suffix before its version.
    const [bare] = parseLogFile([
      '2026-01-15T10:00:06.800Z D DEBUG matrix_sdk: hi',
      '    at /r/.cargo/registry/src/index.crates.io-1949cf8c/matrix-sdk-0.18.0/src/client/mod.rs:7',
    ].join('\n')).rawLogLines;
    expect(bare.filePath).toBe('crates/matrix-sdk/src/client/mod.rs');
  });

  it('locates the pretty-format source ref on its `at` line for the viewer to link', () => {
    const [line] = parseLogFile(CRYPTO_WASM_PRETTY_ENTRY).rawLogLines;
    const ref = locatePrettySourceRef(line.continuationLines!, line.filePath!, line.sourceLineNumber!);
    expect(ref?.lineIndex).toBe(1);
    const atLine = line.continuationLines![1];
    expect(atLine.slice(ref!.start, ref!.end)).toBe(
      '/home/runner/.cargo/git/checkouts/matrix-rust-sdk-5cafb5792f78b8d1/f333a32/crates/matrix-sdk-crypto/src/session_manager/group_sessions/share_strategy.rs:211',
    );
    // A different location (e.g. from a `| … |` first line) is not on any continuation line.
    expect(locatePrettySourceRef(line.continuationLines!, 'crates/x.rs', 1)).toBeNull();
  });

  it('ignores a pretty-format `at` line from another git dependency', () => {
    const [line] = parseLogFile([
      '2026-09-29T07:06:20.662Z D DEBUG ruma: hi',
      '    at /home/runner/.cargo/git/checkouts/ruma-1a2b3c/abc1234/crates/ruma-events/src/x.rs:9',
    ].join('\n')).rawLogLines;
    expect(line.filePath).toBeUndefined();
  });
});

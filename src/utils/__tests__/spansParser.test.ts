import { describe, it, expect } from 'vitest';
import { parseSpans, spanSegments, spanFilterValue } from '../spansParser';

// Real lines shaped like ../sample.log.
const line = (tail: string) =>
  `2026-04-12T20:16:41.614Z DEBUG matrix_sdk::client::builder: msg | crates/matrix-sdk/src/client/builder/mod.rs:545 | spans: ${tail}`;

describe('parseSpans', () => {
  it('returns [] when the line has no spans suffix', () => {
    expect(parseSpans('2026-04-12T20:16:41Z INFO matrix_sdk::x: no span here | mod.rs:1 |')).toEqual([]);
  });

  it('parses a chain of field-less spans', () => {
    expect(parseSpans(line('root > build'))).toEqual([
      { name: 'root', fields: {} },
      { name: 'build', fields: {} },
    ]);
  });

  it('parses space-separated fields and strips surrounding quotes', () => {
    const spans = parseSpans(line('root > send{request_id="REQ-0" method=GET uri="https://a/b" status=200}'));
    expect(spans[1]).toEqual({
      name: 'send',
      fields: { request_id: 'REQ-0', method: 'GET', uri: 'https://a/b', status: '200' },
    });
  });

  it('keeps a space inside a span name (Swift-injected spans)', () => {
    expect(parseSpans(line('root > Global proxy'))).toEqual([
      { name: 'root', fields: {} },
      { name: 'Global proxy', fields: {} },
    ]);
  });

  it('drops empty tokens from the double-space of an unrecorded field', () => {
    // `pos` declared but not yet recorded → renders as a double space.
    const spans = parseSpans(line('root > sync_once{conn_id="encryption"  timeout=30000}'));
    expect(spans[1].fields).toEqual({ conn_id: 'encryption', timeout: '30000' });
  });

  it('keeps a space inside an escaped quote (Debug-formatted value)', () => {
    const spans = parseSpans(line('root > op{err="bad \\"a b\\" x" code=500}'));
    expect(spans[1].fields).toEqual({ err: 'bad \\"a b\\" x', code: '500' });
  });

  it('keeps a quoted string inside an Ident(...) value intact (no space-split)', () => {
    const spans = parseSpans(line('root > build{homeserver=HomeserverUrl("https://domain1.org/")}'));
    expect(spans[1].fields).toEqual({ homeserver: 'HomeserverUrl("https://domain1.org/")' });
  });

  it('handles a background-task chain that does not start at root', () => {
    const spans = parseSpans(line('send{request_id="REQ-7" method=GET}'));
    expect(spans).toEqual([{ name: 'send', fields: { request_id: 'REQ-7', method: 'GET' } }]);
  });

  it('parses a deep chain (mixed field-less and fielded spans)', () => {
    const spans = parseSpans(
      line('root > next_sync_with_lock{store_generation=43} > sync_once{conn_id="encryption"} > send_outgoing_requests > keys_query{request_id="abc"}'),
    );
    expect(spans.map((s) => s.name)).toEqual([
      'root', 'next_sync_with_lock', 'sync_once', 'send_outgoing_requests', 'keys_query',
    ]);
    expect(spans[1].fields).toEqual({ store_generation: '43' });
    expect(spans[3].fields).toEqual({});
  });

  it('only scans the first physical line', () => {
    const multiline = `${line('root > build')}\nContinuation | spans: fake > wrong`;
    expect(parseSpans(multiline).map((s) => s.name)).toEqual(['root', 'build']);
  });
});

describe('spanSegments', () => {
  it('returns [] for a line with no spans', () => {
    expect(spanSegments('2026-04-12T20:16:41Z INFO x: no span | y.rs:1 |')).toEqual([]);
  });

  it('returns each whole span segment verbatim (used as the filter value)', () => {
    expect(spanSegments(line('root > send{request_id="REQ-0" method=GET status=200}'))).toEqual([
      'root',
      'send{request_id="REQ-0" method=GET status=200}',
    ]);
  });

  it('keeps the full fields incl. the double-space of an unrecorded field', () => {
    expect(spanSegments(line('root > sync_once{conn_id="encryption"  timeout=30000}'))[1]).toBe(
      'sync_once{conn_id="encryption"  timeout=30000}',
    );
  });
});

describe('spanFilterValue', () => {
  it('returns a field-less segment unchanged', () => {
    expect(spanFilterValue('root')).toBe('root');
  });

  it('reduces a fielded segment to name + first field (stable across renderings)', () => {
    // Matches both `send{request_id="req-073" method=GET}` and the later
    // `send{request_id="req-073" method=GET status=200 ...}` rendering.
    expect(spanFilterValue('send{request_id="req-073" method=GET status=200}')).toBe(
      'send{request_id="req-073"',
    );
  });

  it('stretches the prefix through request_id when it is not the first field', () => {
    // Since matrix-rust-sdk b8b4e9bb9 send{} opens with config=RequestConfig { … },
    // which is identical for every request — stopping at it would filter in every
    // HTTP line instead of this one request's.
    const segment = 'send{config=RequestConfig { timeout: Some(30s), retry_limit: 3 } request_id="req-073" method=GET status=200}';
    expect(spanFilterValue(segment)).toBe(
      'send{config=RequestConfig { timeout: Some(30s), retry_limit: 3 } request_id="req-073"',
    );
    expect(segment.startsWith(spanFilterValue(segment))).toBe(true);
  });

  it('falls back to the name for an empty field body', () => {
    expect(spanFilterValue('op{}')).toBe('op');
  });
});

describe('spanSegments — tracing pretty format (Element Web crypto-wasm)', () => {
  const pretty = [
    '2026-09-29T07:06:20.662Z D DEBUG matrix_sdk_crypto::session_manager::group_sessions::share_strategy: Rotating room key to protect room history',
    '    device_removed=true visibility_changed=false algorithm_changed=false',
    '    at /home/runner/.cargo/git/checkouts/matrix-rust-sdk-5cafb5792f78b8d1/f333a32/crates/matrix-sdk-crypto/src/session_manager/group_sessions/share_strategy.rs:211',
    '    in matrix_sdk_crypto::session_manager::group_sessions::share_strategy::collect_session_recipients',
    '    in matrix_sdk_crypto::session_manager::group_sessions::share_room_key with room_id="!room-af33e3161742:example.org" session_id="CCJQ"',
  ].join('\n');

  it('reads the `in …` lines root first, keeping the last path segment as the name', () => {
    expect(spanSegments(pretty)).toEqual([
      'share_room_key{room_id="!room-af33e3161742:example.org" session_id="CCJQ"}',
      'collect_session_recipients',
    ]);
    expect(parseSpans(pretty)[0]).toEqual({
      name: 'share_room_key',
      fields: { room_id: '!room-af33e3161742:example.org', session_id: 'CCJQ' },
    });
  });

  it('returns [] for a multi-line entry with no `in …` line', () => {
    expect(spanSegments('2026-09-29T07:06:20.662Z W Failed\n    at Object.foo (bundle.js:1:2)')).toEqual([]);
  });
});

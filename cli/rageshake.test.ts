import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync, strToU8 } from 'fflate';
import { buildTar } from '../src/utils/tarWriter';
import { ingest, cmdPrecheck, cmdSummary, cmdGrep, cmdSlice, cmdOverview, cmdHttp, cmdCycles, resolveRange, run } from './rageshake';
import { resolveServePath, parseServeArgs, DEFAULT_PORT } from './serve';
import type { LogParserResult } from '../src/types/log.types';

const RAW_LOG = [
  '2026-01-15T10:00:00.000000Z  INFO [matrix-rust-sdk] Sentry configured (enabled: true)',
  '2026-01-15T10:00:01.000000Z ERROR [matrix-rust-sdk] Failed to send to @alice:example.org in !abc123defg456:example.org',
  '2026-01-15T10:00:02.000000Z  WARN [matrix-rust-sdk] retry scheduled',
].join('\n');

const ANON_LOG = [
  '# [shakeview-anonymized]',
  '2026-01-15T10:00:00.000000Z  INFO [matrix-rust-sdk] Sentry configured (enabled: true)',
  '2026-01-15T10:00:01.000000Z ERROR [matrix-rust-sdk] Failed to send to @user-0123456789ab:domain-01234567.org in !room-0123456789ab:domain-01234567.org',
  '2026-01-15T10:00:02.000000Z  WARN [matrix-rust-sdk] retry scheduled',
].join('\n');

const HTTP_LOG = [
  '# [shakeview-anonymized]',
  '2026-01-15T10:00:00.000000Z INFO [matrix-rust-sdk] send{request_id="r1" method=GET uri="https://matrix/_matrix/client/v3/sync" request_size="0"}',
  '2026-01-15T10:00:00.500000Z INFO [matrix-rust-sdk] send{request_id="r1" method=GET uri="https://matrix/_matrix/client/v3/sync" request_size="0" status=200 response_size="100" request_duration=500ms}',
  '2026-01-15T10:00:01.000000Z INFO [matrix-rust-sdk] send{request_id="r2" method=POST uri="https://matrix/_matrix/media/v3/upload" request_size="10"}',
  '2026-01-15T10:00:01.500000Z INFO [matrix-rust-sdk] send{request_id="r2" method=POST uri="https://matrix/_matrix/media/v3/upload" request_size="10" status=500 response_size="20" request_duration=500ms}',
].join('\n');

// A second process' log, so `http` has two files to tell apart. One request, on
// its own line 1 — the same number HTTP_LOG's first request carries.
const NSE_HTTP_LOG = [
  '# [shakeview-anonymized]',
  '2026-01-15T10:00:02.000000Z INFO [matrix-rust-sdk] send{request_id="r3" method=GET uri="https://matrix/_matrix/client/v3/keys/query" request_size="0"}',
  '2026-01-15T10:00:02.500000Z INFO [matrix-rust-sdk] send{request_id="r3" method=GET uri="https://matrix/_matrix/client/v3/keys/query" request_size="0" status=200 response_size="30" request_duration=500ms}',
].join('\n');

// iOS lifecycle markers: cold start + two foreground/background cycles (5 events).
const CYCLE_LOG = [
  '# [shakeview-anonymized]',
  '2026-01-15T10:00:00.000000Z INFO [MXLog] Sentry configured (enabled: true)',
  '2026-01-15T10:00:01.000000Z INFO [MXLog] Application did become active',
  '2026-01-15T10:00:02.000000Z INFO [MXLog] Application will resign active',
  '2026-01-15T10:00:03.000000Z INFO [MXLog] Application did become active',
  '2026-01-15T10:00:04.000000Z INFO [MXLog] Application will resign active',
].join('\n');

const DETAILS = JSON.stringify({
  user_text: 'App crashed on launch',
  report_url: 'https://github.com/element-hq/element-ios/issues/1234',
  data: { user_id: '@user-0123456789ab:domain-01234567.org', Version: '25.1.0', sdk_sha: 'abc1234' },
});

function buildArchive(logText: string): Uint8Array {
  return gzipSync(buildTar([
    { name: 'details.json', data: strToU8(DETAILS) },
    { name: 'console.2026-01-15-10.log.gz', data: gzipSync(strToU8(logText)) },
  ]));
}

// Logcat lines carry no year, so the parser infers one from today's date:
// January is never ahead of the current month, so it always resolves to the
// current year. Pinning the tracing fixture to that same year keeps the two
// clocks a fixed distance apart whenever this suite runs.
const LOGCAT_MD = '01-15';
const LOGCAT_YEAR = String(new Date().getFullYear());

/** Archive pairing a UTC tracing log ending at 10:00:02 with a logcat dump. */
function buildLogcatArchive(logcatText: string): Uint8Array {
  const tracing = [
    '# [shakeview-anonymized]',
    `${LOGCAT_YEAR}-${LOGCAT_MD}T10:00:00.000000Z  INFO [matrix-rust-sdk] Sentry configured (enabled: true)`,
    `${LOGCAT_YEAR}-${LOGCAT_MD}T10:00:02.000000Z  WARN [matrix-rust-sdk] retry scheduled`,
  ].join('\n');
  return gzipSync(buildTar([
    { name: 'details.json', data: strToU8(DETAILS) },
    { name: `console.${LOGCAT_YEAR}-${LOGCAT_MD}-10.log.gz`, data: gzipSync(strToU8(tracing)) },
    { name: 'logcat.log.gz', data: gzipSync(strToU8(logcatText)) },
  ]));
}

describe('rageshake CLI', () => {
  it('precheck fails on raw identifiers and passes on anonymized archive', () => {
    const raw = cmdPrecheck(ingest(buildArchive(RAW_LOG), 'raw.tar.gz'));
    expect(raw.ok).toBe(false);
    expect(raw.report).toContain('user-id');

    const anon = cmdPrecheck(ingest(buildArchive(ANON_LOG), 'anon.tar.gz'));
    expect(anon.ok).toBe(true);
    expect(anon.report).toContain('alias signal');
  });

  it('precheck flags percent-encoded raw identifiers and accepts encoded aliases', () => {
    const url = (userId: string, roomId: string) => `2026-01-15T10:00:00.000000Z ERROR [ElementCall] index.html#?userId=${userId}&roomId=${roomId}`;
    const raw = cmdPrecheck(ingest(strToU8(url('%40alice%3Aexample.org', '%21abcdefgh%3Aexample.org')), 'raw.log'));
    expect(raw.ok).toBe(false);
    expect(raw.report).toContain('user-id');
    expect(raw.report).toContain('room-id');

    const anon = cmdPrecheck(ingest(strToU8(url('%40user-0123456789ab%3Adomain-01234567.org', '%21room-0123456789ab%3Adomain-01234567.org')), 'anon.log'));
    expect(anon.ok).toBe(true);
  });

  it('precheck passes anonymized permalinks (the #/ fragment is not a room alias)', () => {
    const bytes = strToU8([
      '# [shakeview-anonymized]',
      '2026-09-29T15:36:15.377Z I The message is https://matrix.to/#/!room-56b8a38cf0f0:domain-d40e97c9.org/$event-dd06b04bbd34?via=domain-60fc0bb7.org',
      '2026-09-29T15:36:16.000Z I Switching to https://app.element.io/#/room/!room-56b8a38cf0f0:domain-d40e97c9.org',
    ].join('\n'));
    expect(cmdPrecheck(ingest(bytes, 'web.log')).report).toMatch(/^PASS/);
  });

  it('precheck fails when no anonymization evidence exists', () => {
    const bytes = strToU8('2026-01-15T10:00:00.000000Z INFO nothing identifiable here');
    expect(cmdPrecheck(ingest(bytes, 'plain.log')).ok).toBe(false);
  });

  it('precheck warns when a dropped member was a log file', () => {
    const archive = gzipSync(buildTar([
      { name: '2026-01-15_100000-ABCD/details.json', data: strToU8(DETAILS) },
      { name: '2026-01-15_100000-ABCD/console.2026-01-15-10.log.gz', data: gzipSync(strToU8(ANON_LOG)) },
      { name: '2026-01-15_100000-ABCD/console.2026-01-15-09.log.gz.removed', data: strToU8('Removed by shakeview anonymization: …\n') },
      { name: '2026-01-15_100000-ABCD/screenshot.png.removed', data: strToU8('Removed by shakeview anonymization: …\n') },
    ]));
    const report = cmdPrecheck(ingest(archive, 'anon.tar.gz'));
    expect(report.ok).toBe(true);
    expect(report.report).toContain('console.2026-01-15-09.log.gz');
    // An image is not a partial view of the logs: it must not raise the warning.
    expect(report.report).not.toContain('screenshot.png');
  });

  it('summary reports details.json fields and per-file counts', () => {
    const summary = JSON.parse(cmdSummary(ingest(buildArchive(ANON_LOG), 'anon.tar.gz')));
    expect(summary.details.userText).toBe('App crashed on launch');
    expect(summary.details.version).toBe('25.1.0');
    expect(summary.details.sdkSha).toBe('abc1234');
    expect(summary.details.reportUrl).toBe('https://github.com/element-hq/element-ios/issues/1234');
    expect(summary.files).toHaveLength(1);
    expect(summary.files[0].name).toBe('console.2026-01-15-10.log.gz');
    expect(summary.files[0].errors).toBe(1);
    expect(summary.totals.warnings).toBe(1);
    expect(summary.lifecycle.lastColdStart).toContain('2026-01-15T10:00:00');
    // Identity fields are omitted to avoid leaking a stable device_id (which the
    // anonymizer never rewrites) into LLM-bound output.
    expect(summary.details.deviceId).toBeUndefined();
    expect(summary.details.userId).toBeUndefined();
    // Nothing was dropped by the anonymizer, so the key stays out of the output.
    expect(summary.removedFiles).toBeUndefined();
  });

  it('summary names the members the anonymizer dropped', () => {
    const archive = gzipSync(buildTar([
      { name: '2026-01-15_100000-ABCD/details.json', data: strToU8(DETAILS) },
      { name: '2026-01-15_100000-ABCD/console.2026-01-15-10.log.gz', data: gzipSync(strToU8(ANON_LOG)) },
      { name: '2026-01-15_100000-ABCD/screenshot.png.removed', data: strToU8('Removed by shakeview anonymization: …\n') },
    ]));
    const summary = JSON.parse(cmdSummary(ingest(archive, 'anon.tar.gz')));
    expect(summary.removedFiles).toEqual(['screenshot.png']);
    // The marker is not a log: it must not appear in the per-file table.
    expect(summary.files).toHaveLength(1);
  });

  it('rejects binary (null-byte) input as not a text log', () => {
    const binary = new Uint8Array([0x41, 0x00, 0x42, 0x00]);
    expect(() => ingest(binary, 'weird.log')).toThrow(/not a valid text log/);
  });

  it('clamps --last to the first log timestamp, not epoch', () => {
    const out = cmdSlice(ingest(buildArchive(ANON_LOG), 'anon.tar.gz'), { last: '999d' });
    expect(out).toContain('2026-01-15T10:00:00');
    expect(out).not.toContain('1970');
  });

  it('grep finds matching lines with line numbers', () => {
    const out = cmdGrep(ingest(buildArchive(ANON_LOG), 'anon.tar.gz'), ['retry scheduled'], {});
    expect(out).toContain('# "retry scheduled" 1');
    expect(out).toContain('WARN');
    expect(out).toContain('retry scheduled');
  });

  it('grep matches ANY of several patterns and counts each separately', () => {
    // One call replaces the per-pattern shell loop: three patterns, one archive
    // parse, and a dud pattern stays visible instead of hiding in a total.
    const out = cmdGrep(ingest(buildArchive(ANON_LOG), 'anon.tar.gz'),
      ['retry scheduled', 'Sentry configured', 'never-logged'], {});
    expect(out).toContain('"retry scheduled" 1');
    expect(out).toContain('"Sentry configured" 1');
    expect(out).toContain('"never-logged" 0');
    expect(out).toContain('— 2 lines');
    expect(out).toContain('retry scheduled');
    expect(out).toContain('Sentry configured');
  });

  it('grep --count reports a distribution and a pasteable peak window, no log lines', () => {
    const out = cmdGrep(ingest(buildArchive(ANON_LOG), 'anon.tar.gz'), ['matrix-rust-sdk'], { count: true });
    expect(out).toContain('"matrix-rust-sdk" 3');
    expect(out).toContain('# peak');
    expect(out).toMatch(/--from \d{4}-\d{2}-\d{2}T.* --to \d{4}-\d{2}-\d{2}T/);
    // The probe must not carry line payloads — that is the whole point of it.
    expect(out).not.toContain('retry scheduled');
  });

  it('grep separates "absent from this window" from "never logged"', () => {
    const ing = ingest(buildArchive(ANON_LOG), 'anon.tar.gz');
    // "Sentry configured" is at 10:00:00, excluded by a window starting at 10:00:02.
    const narrowed = cmdGrep(ing, ['Sentry configured'], { since: '2026-01-15T10:00:02Z' });
    expect(narrowed).toContain('0 in range, 1 in full log');
    expect(narrowed).toContain('widen');
    // A pattern that is genuinely absent must not suggest widening.
    const absent = cmdGrep(ing, ['never-logged'], { since: '2026-01-15T10:00:02Z' });
    expect(absent).toContain('never logged');
    expect(absent).not.toContain('widen');
    // Unfiltered, a zero result gets no hint at all: there is no window to blame.
    expect(cmdGrep(ing, ['never-logged'], {})).not.toContain('in full log');
  });

  it('--width truncates the message and --width 0 restores it in full', () => {
    const longLine = ['# [shakeview-anonymized]',
      `2026-01-15T10:00:00.000000Z INFO [matrix-rust-sdk] ${'x'.repeat(500)} TAILMARK`].join('\n');
    const ing = ingest(buildArchive(longLine), 'anon.tar.gz');
    expect(cmdGrep(ing, ['xxx'], { width: '60' })).not.toContain('TAILMARK');
    expect(cmdGrep(ing, ['xxx'], { width: '60' })).toContain('…');
    expect(cmdGrep(ing, ['xxx'], { width: '0' })).toContain('TAILMARK');
    // Default is 200, so a 500-char payload is cut without asking.
    expect(cmdGrep(ing, ['xxx'], {})).not.toContain('TAILMARK');
  });

  it('drops the "| spans:" chain by default and --spans puts it back', () => {
    const spanLog = ['# [shakeview-anonymized]',
      '2026-01-15T10:00:00.000000Z DEBUG matrix_sdk::http_client: Got response'
      + ' | crates/matrix-sdk/src/http_client/mod.rs:197'
      + ' | spans: next_sync_with_lock > sync_once{conn_id="encryption" pos="0/m7224201017~2.7224201025"}',
    ].join('\n');
    const ing = ingest(buildArchive(spanLog), 'anon.tar.gz');
    const bare = cmdGrep(ing, ['Got response'], {});
    expect(bare).toContain('Got response');
    expect(bare).toContain('http_client/mod.rs:197'); // source location kept — reports need it
    expect(bare).not.toContain('spans:');
    expect(bare).not.toContain('pos=');
    // The chain is 49% of an average SDK line, so dropping it must not truncate.
    expect(bare).not.toContain('…');
    expect(cmdGrep(ing, ['Got response'], { spans: true })).toContain('next_sync_with_lock');
    // Non-SDK lines (Android logcat) have no chain: the change is a no-op there.
    expect(cmdGrep(ingest(buildArchive(ANON_LOG), 'anon.tar.gz'), ['retry scheduled'], {}))
      .toContain('retry scheduled');
  });

  it('collapses lines that only differ in the dropped spans chain', () => {
    // Sliding-sync churn: same message, a new pos= cursor every time. Once the
    // chain is dropped these render identically, so the duplicate collapsing has
    // to key on the printed text — otherwise the noisiest case in a rageshake
    // prints N identical rows, exactly what dropping the chain was meant to fix.
    const log = ['# [shakeview-anonymized]',
      ...Array.from({ length: 4 }, (_, i) =>
        `2026-01-15T10:00:0${i}.000000Z DEBUG matrix_sdk::sliding_sync: Sync response`
        + ' | crates/matrix-sdk/src/sliding_sync/mod.rs:42'
        + ` | spans: sync_once{pos="0/m722420101${i}"}`),
    ].join('\n');
    const ing = ingest(buildArchive(log), 'anon.tar.gz');
    // Count the source location, not the pattern: the header echoes the pattern.
    const rows = (out: string): number => (out.match(/sliding_sync\/mod\.rs:42/g) ?? []).length;
    const collapsed = cmdGrep(ing, ['Sync response'], {});
    expect(collapsed).toContain('... 3 duplicated lines ...');
    expect(rows(collapsed)).toBe(1);
    // With the chain kept the lines really are distinct, so collapsing them
    // would hide the cursor the caller asked to see.
    const kept = cmdGrep(ing, ['Sync response'], { spans: true });
    expect(kept).not.toContain('duplicated lines');
    expect(rows(kept)).toBe(4);
  });

  it('emits a file legend only for the files the emitted page actually cites', () => {
    const consoleLog = ['# [shakeview-anonymized]',
      '2026-01-15T10:00:00.000000Z INFO [matrix-rust-sdk] console hit'].join('\n');
    const nseLog = ['# [shakeview-anonymized]',
      '2026-01-15T10:00:01.000000Z INFO [matrix-rust-sdk] nse hit'].join('\n');
    const archive = gzipSync(buildTar([
      { name: 'console.2026-01-15-10.log.gz', data: gzipSync(strToU8(consoleLog)) },
      { name: 'nse.2026-01-15-10.log.gz', data: gzipSync(strToU8(nseLog)) },
    ]));
    const ing = ingest(archive, 'merged.tar.gz');
    const both = cmdGrep(ing, ['hit'], {});
    expect(both).toContain('console.2026-01-15-10.log.gz');
    expect(both).toContain('nse.2026-01-15-10.log.gz');
    // A page citing one file must not expand the other — the legend is what keeps
    // a 60-log archive from paying for every filename on every call.
    const one = cmdGrep(ing, ['nse hit'], {});
    expect(one).toContain('nse.2026-01-15-10.log.gz');
    expect(one).not.toContain('console.2026-01-15-10.log.gz');
    // Single-file archives get neither tag nor legend.
    expect(cmdGrep(ingest(buildArchive(ANON_LOG), 'anon.tar.gz'), ['retry'], {})).not.toContain('# files:');
  });

  it('prints line numbers as counted inside their own file, not merged', () => {
    // A deep link names one log and a line inside it, so the viewer opens that log
    // alone instead of merging every log in the archive to resolve the number.
    const consoleLog = ['# [shakeview-anonymized]',
      '2026-01-15T10:00:00.000000Z INFO [matrix-rust-sdk] first console line',
      '2026-01-15T10:00:02.000000Z INFO [matrix-rust-sdk] second console line',
      '2026-01-15T10:00:04.000000Z INFO [matrix-rust-sdk] third console line'].join('\n');
    const nseLog = ['# [shakeview-anonymized]',
      '2026-01-15T10:00:01.000000Z INFO [matrix-rust-sdk] first nse line',
      '2026-01-15T10:00:03.000000Z INFO [matrix-rust-sdk] second nse line'].join('\n');
    const ing = ingest(gzipSync(buildTar([
      { name: 'console.2026-01-15-10.log.gz', data: gzipSync(strToU8(consoleLog)) },
      { name: 'nse.2026-01-15-10.log.gz', data: gzipSync(strToU8(nseLog)) },
    ])), 'merged.tar.gz');

    const out = cmdGrep(ing, ['second'], {});

    // Both files number their own lines from 1 (parseLogFile strips the
    // anonymization marker), so each file's second line is 2. Merged numbering
    // would have put the nse line at 5, past the console file's 3 lines.
    expect(out).toMatch(/\[2\|f1\].*second console line/);
    expect(out).toMatch(/\[2\|f2\].*second nse line/);
  });

  it('--since accepts an absolute ISO timestamp (equivalent to --from)', () => {
    const ing = ingest(buildArchive(ANON_LOG), 'anon.tar.gz');
    const out = cmdSlice(ing, { since: '2026-01-15T10:00:02Z' });
    expect(out).toContain('retry scheduled'); // 10:00:02 WARN kept
    expect(out).not.toContain('Sentry configured'); // 10:00:00 INFO excluded
  });

  it('--since rejects a value that is neither an anchor nor an ISO timestamp', () => {
    const ing = ingest(buildArchive(ANON_LOG), 'anon.tar.gz');
    expect(() => cmdSlice(ing, { since: 'yesterday' })).toThrow(/invalid --since/);
  });

  it('summary ranks files by noise and caps the per-file table with --top', () => {
    const noisy = ['# [shakeview-anonymized]',
      '2026-01-15T10:00:00.000000Z ERROR [matrix-rust-sdk] boom one',
      '2026-01-15T10:00:01.000000Z ERROR [matrix-rust-sdk] boom two'].join('\n');
    const quiet = ['# [shakeview-anonymized]',
      '2026-01-15T10:00:00.000000Z INFO [matrix-rust-sdk] all good'].join('\n');
    const mid = ['# [shakeview-anonymized]',
      '2026-01-15T10:00:00.000000Z WARN [matrix-rust-sdk] heads up'].join('\n');
    const archive = gzipSync(buildTar([
      { name: 'console.2026-01-15-08.log.gz', data: gzipSync(strToU8(quiet)) },
      { name: 'console.2026-01-15-09.log.gz', data: gzipSync(strToU8(mid)) },
      { name: 'console.2026-01-15-10.log.gz', data: gzipSync(strToU8(noisy)) },
    ]));
    const ing = ingest(archive, 'multi.tar.gz');
    const full = JSON.parse(cmdSummary(ing, { top: 'all' }));
    expect(full.files).toHaveLength(3);
    expect(full.filesOmitted).toBeUndefined();
    // Noisiest (2 errors) ranks first regardless of chronological order.
    expect(full.files[0].name).toBe('console.2026-01-15-10.log.gz');
    const capped = JSON.parse(cmdSummary(ing, { top: '2' }));
    expect(capped.filesOmitted).toBe(1);
    // The two kept must be the noisiest two, in noise order — guards against
    // slicing before sorting (which would still pass a length-only check).
    expect(capped.files.map((f: { name: string }) => f.name)).toEqual([
      'console.2026-01-15-10.log.gz',
      'console.2026-01-15-09.log.gz',
    ]);
  });

  it('grep rejects a malformed --from timestamp instead of treating it as epoch', () => {
    const ing = ingest(buildArchive(ANON_LOG), 'anon.tar.gz');
    expect(() => cmdGrep(ing, ['retry'], { from: 'not-a-date' })).toThrow(/invalid --from/);
  });

  it('distinguishes no matches from an offset past the end', () => {
    const ing = ingest(buildArchive(ANON_LOG), 'anon.tar.gz');
    expect(cmdGrep(ing, ['no-such-text-anywhere'], {})).toContain('# no matching lines');
    // "retry scheduled" matches one line; offset 5 is past the single match.
    expect(cmdGrep(ing, ['retry scheduled'], { offset: '5' })).toContain('past the end');
  });

  it('does not report phantom gaps for timestamp-interleaved merged logs', () => {
    // Two processes whose lines interleave in time: after merge the array is
    // timestamp-ordered but per-file lineNumbers are not, so a lineNumber-delta
    // gap would fire between adjacent merged entries. Index-delta must not.
    const consoleLog = [
      '# [shakeview-anonymized]',
      '2026-01-15T10:00:00.000000Z INFO [matrix-rust-sdk] console line one',
      '2026-01-15T10:00:02.000000Z INFO [matrix-rust-sdk] console line two',
    ].join('\n');
    const nseLog = [
      '# [shakeview-anonymized]',
      '2026-01-15T10:00:01.000000Z INFO [matrix-rust-sdk] nse line one',
    ].join('\n');
    const archive = gzipSync(buildTar([
      { name: 'console.2026-01-15-10.log.gz', data: gzipSync(strToU8(consoleLog)) },
      { name: 'nse.2026-01-15-10.log.gz', data: gzipSync(strToU8(nseLog)) },
    ]));
    const out = cmdSlice(ingest(archive, 'merged.tar.gz'), {});
    expect(out).not.toMatch(/\.\.\. \d+ lines \.\.\./);
  });

  it('applies --offset to overview tree output', () => {
    const ing = ingest(buildArchive(ANON_LOG), 'anon.tar.gz');
    const full = cmdOverview(ing, {});
    const offset = cmdOverview(ing, { limit: '1', offset: '1' });
    // First body node of the full tree must be gone once we skip it.
    const firstNode = full.split('\n').find((l) => !l.startsWith('#'));
    expect(firstNode).toBeDefined();
    expect(offset.split('\n')).not.toContain(firstNode);
  });

  it('preserves the anonymized flag through ingest (marker not pre-stripped)', () => {
    expect(ingest(buildArchive(ANON_LOG), 'anon.tar.gz').merged.isAnonymized).toBe(true);
  });

  it('throws a clear error when the resolved time window is inverted', () => {
    const ing = ingest(buildArchive(ANON_LOG), 'anon.tar.gz');
    expect(() => cmdSlice(ing, { from: '2026-01-15T10:00:02Z', to: '2026-01-15T10:00:00Z' }))
      .toThrow(/empty time window/);
  });

  it('http --errors selects failed requests by numeric status', () => {
    const out = cmdHttp(ingest(buildArchive(HTTP_LOG), 'anon.tar.gz'), { errors: true });
    expect(out).toContain('# 1 requests (failures only)');
    expect(out).toContain('/upload');
    expect(out).not.toContain('/sync');
  });

  it('http cites each request with its line inside its own file, plus the legend', () => {
    // Both logs hold a request on their own line 1, so the number alone cannot say
    // which log it is in — hence the tag and the legend that expands it. Merged
    // numbering would have put the nse request at 5, past console's 4 lines, and
    // no viewer link could resolve that without re-merging the whole archive.
    const ing = ingest(gzipSync(buildTar([
      { name: 'console.2026-01-15-10.log.gz', data: gzipSync(strToU8(HTTP_LOG)) },
      { name: 'nse.2026-01-15-10.log.gz', data: gzipSync(strToU8(NSE_HTTP_LOG)) },
    ])), 'merged.tar.gz');

    const out = cmdHttp(ing, {});

    expect(out).toContain('# files: f1=console.2026-01-15-10.log.gz · f2=nse.2026-01-15-10.log.gz');
    expect(out).toMatch(/\/sync .*\[line 1\|f1\]/);
    expect(out).toMatch(/\/keys\/query .*\[line 1\|f2\]/);
    expect(out).not.toContain('[line 5');
  });

  it('rejects a time window when the log has no parseable timestamps', () => {
    const merged = {
      rawLogLines: [], httpRequests: [], requests: [], connectionIds: [], sentryEvents: [], lifecycleEvents: [],
    } as unknown as LogParserResult;
    expect(() => resolveRange(merged, { last: '10m' }, () => {})).toThrow(/no parseable timestamps/);
  });

  it('warns that --since is ignored (not "full range") when the anchor is missing', () => {
    // ANON_LOG has a cold start but no background event.
    const out = cmdSlice(ingest(buildArchive(ANON_LOG), 'anon.tar.gz'), { since: 'last-background' });
    expect(out).toContain('ignoring --since');
    expect(out).not.toContain('showing the full range');
  });

  it('http distinguishes no requests from an offset past the end', () => {
    const ing = ingest(buildArchive(ANON_LOG), 'anon.tar.gz'); // ANON_LOG has no HTTP requests
    expect(cmdHttp(ing, {})).toContain('# 0 requests');
    const demo = ingest(buildArchive(HTTP_LOG), 'anon.tar.gz');
    expect(cmdHttp(demo, { offset: '99' })).toContain('past the end');
  });

  it('http says why an empty result is empty', () => {
    const ing = ingest(buildArchive(HTTP_LOG), 'anon.tar.gz');
    // Window sits after both requests but inside the log, so the range is valid
    // and simply empty — the case the hint exists for.
    const windowed = cmdHttp(ing, { from: '2026-01-15T10:00:01.200000Z' });
    expect(windowed).toContain('2 requests in the full log');
    expect(windowed).toContain('widen');
    // --errors with a window that has no failures must offer dropping the filter.
    expect(cmdHttp(ing, { errors: true, to: '2026-01-15T10:00:00.900000Z' })).toContain('drop --errors');
    // A log with no HTTP at all says so instead of pointing at the window.
    expect(cmdHttp(ingest(buildArchive(ANON_LOG), 'anon.tar.gz'), { errors: true }))
      .toContain('no HTTP requests in this log at all');
  });

  it('summary stays bounded on a log with many distinct error types', () => {
    // Word suffixes, not digits: error types are grouped after numeric
    // normalisation, so "failure 1".."failure 8" would collapse into one type.
    // computeSummaryStats keeps only the 5 most frequent, so --top does not (and
    // must not) claim to widen this table.
    const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
    const many = ['# [shakeview-anonymized]',
      ...words.map((w, i) => `2026-01-15T10:00:0${i}.000000Z ERROR [matrix-rust-sdk] failure ${w}`),
    ].join('\n');
    const ing = ingest(buildArchive(many), 'anon.tar.gz');
    expect(JSON.parse(cmdSummary(ing, {})).errorsByType).toHaveLength(5);
    expect(JSON.parse(cmdSummary(ing, { top: 'all' })).errorsByType).toHaveLength(5);
  });

  it('line output defaults to 50 entries, keeping it in the same band as the trees', () => {
    // At the old default of 200 a 2-minute slice returned ~43k chars while every
    // other command sat between 4k and 8k — that gap is what made walking --limit
    // down the rational move. Pin the default so it cannot drift back.
    const log = ['# [shakeview-anonymized]',
      ...Array.from({ length: 120 }, (_, i) =>
        `2026-01-15T10:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000000Z INFO [matrix-rust-sdk] event ${i}`),
    ].join('\n');
    const ing = ingest(buildArchive(log), 'anon.tar.gz');
    const out = cmdSlice(ing, {});
    expect(out).toContain('# 70 more entries — next: --offset 50');
    expect(out).toContain('event 49');
    expect(out).not.toContain('event 50');
    // An explicit --limit still overrides it.
    expect(cmdSlice(ing, { limit: '120' })).toContain('event 119');
  });

  it('summary per-file table defaults to 5 files and drops the archive-id prefix', () => {
    const files = Array.from({ length: 8 }, (_, i) => ({
      name: `2026-01-15_101010-ABCDEFGH/console.2026-01-15-${String(10 + i).padStart(2, '0')}.log.gz`,
      data: gzipSync(strToU8(ANON_LOG)),
    }));
    const summary = JSON.parse(cmdSummary(ingest(gzipSync(buildTar(files)), 'anon.tar.gz')));
    expect(summary.files).toHaveLength(5);
    expect(summary.filesOmitted).toBe(3);
    // The directory prefix is identical on every row, so it is not carried.
    expect(summary.files[0].name).not.toContain('/');
    expect(summary.files[0].name).toMatch(/^console\./);
  });

  it('summary output is minified, not pretty-printed', () => {
    // Indentation cost ~15% of every summary call for no reader benefit.
    const out = cmdSummary(ingest(buildArchive(ANON_LOG), 'anon.tar.gz'));
    expect(out).not.toContain('\n');
    expect(JSON.parse(out).totals.warnings).toBe(1);
  });

  it('cmdCycles lists only markers and counts the rest', () => {
    // CYCLE_LOG is 1 cold start + 2 foreground/background pairs. Only the cold
    // start is a point-in-time signal; the others are durations already rendered
    // as segments, so listing them was the same data printed twice.
    const out = cmdCycles(ingest(buildArchive(CYCLE_LOG), 'anon.tar.gz'), {});
    expect(out).toContain('5 lifecycle events (ios)');
    expect(out).toContain('foreground 2');   // counted...
    expect(out).toContain('background 2');
    expect(out).toContain('[line 1]');       // ...cold start listed...
    expect(out).not.toContain('[line 2]');   // ...foreground not listed as a marker
    expect(out).toContain('# app-state segments');
  });

  it('cmdCycles pages markers with --offset', () => {
    // Four cold starts on lines 1–4 so there is something to page through.
    const log = ['# [shakeview-anonymized]',
      ...Array.from({ length: 4 }, (_, i) =>
        `2026-01-15T10:00:0${i}.000000Z INFO [MXLog] Sentry configured (enabled: true)`),
    ].join('\n');
    const ing = ingest(buildArchive(log), 'anon.tar.gz');
    const recent = cmdCycles(ing, { limit: '2' });
    expect(recent).toContain('[line 4]');
    expect(recent).not.toContain('[line 1]'); // oldest is off the recent page
    const older = cmdCycles(ing, { limit: '2', offset: '2' });
    expect(older).toContain('[line 1]');
    expect(older).not.toContain('[line 4]');
    // Offset beyond the end is reported, not silently blank.
    expect(cmdCycles(ing, { limit: '2', offset: '99' })).toContain('past the end');
  });

  it('cmdCycles collapses long background/refresh runs but keeps foreground', () => {
    // Six refresh wakes while backgrounded, then a real foreground session. The
    // churn must collapse to one row; the foreground session must survive intact.
    const lines = ['# [shakeview-anonymized]',
      '2026-01-15T10:00:00.000000Z INFO [MXLog] Application will resign active'];
    for (let i = 0; i < 6; i++) {
      lines.push(`2026-01-15T10:${String(10 + i * 5).padStart(2, '0')}:00.000000Z INFO [MXLog] Started background app refresh`);
      lines.push(`2026-01-15T10:${String(10 + i * 5).padStart(2, '0')}:05.000000Z INFO [MXLog] Background app refresh finished`);
    }
    lines.push('2026-01-15T11:00:00.000000Z INFO [MXLog] Application did become active');
    lines.push('2026-01-15T11:05:00.000000Z INFO [MXLog] Application will resign active');
    const out = cmdCycles(ingest(buildArchive(lines.join('\n')), 'anon.tar.gz'), {});
    expect(out).toMatch(/background\+refresh ×\d+/);
    expect(out).toContain('foreground');
    // Contiguity is what makes dropping each row's end timestamp safe.
    expect(out).toContain('contiguous through');
    // A short run must NOT collapse: two segments stay readable as themselves.
    const short = ['# [shakeview-anonymized]',
      '2026-01-15T10:00:00.000000Z INFO [MXLog] Application will resign active',
      '2026-01-15T10:10:00.000000Z INFO [MXLog] Started background app refresh',
      '2026-01-15T10:10:05.000000Z INFO [MXLog] Background app refresh finished'].join('\n');
    expect(cmdCycles(ingest(buildArchive(short), 'anon.tar.gz'), {})).not.toContain('background+refresh');
  });

  it('validates the command before touching the filesystem', () => {
    // Path does not exist; an unknown command / missing grep pattern must still
    // return the usage message instead of throwing an IO error.
    expect(run(['frobnicate', '/no/such/file']).code).toBe(2);
    expect(run(['frobnicate', '/no/such/file']).output).toContain('unknown command');
    expect(run(['grep', '/no/such/file']).output).toContain('grep needs at least one pattern');
  });

  it('run passes every positional after the path to grep as a pattern', () => {
    // Guards the variadic wiring end to end: if only the first positional reached
    // cmdGrep, the extra patterns would be dropped silently and the caller would
    // see a plausible but incomplete result.
    const file = join(mkdtempSync(join(tmpdir(), 'rageshake-cli-')), 'anon.tar.gz');
    writeFileSync(file, buildArchive(ANON_LOG));
    const { code, output } = run(['grep', file, 'retry scheduled', 'Sentry configured', '--count']);
    expect(code).toBe(0);
    expect(output).toContain('"retry scheduled" 1');
    expect(output).toContain('"Sentry configured" 1');
  });

  it('fails fast when an analyzable archive member is unreadable', () => {
    const broken = gzipSync(buildTar([
      { name: 'details.json', data: strToU8(DETAILS) },
      { name: 'console.2026-01-15-10.log.gz', data: strToU8('this is not gzip') },
    ]));
    expect(() => ingest(broken, 'anon.tar.gz')).toThrow(/not valid gzip/);
  });

  it('skips unrelated binary members without failing', () => {
    const withImage = gzipSync(buildTar([
      { name: 'console.2026-01-15-10.log.gz', data: gzipSync(strToU8(ANON_LOG)) },
      { name: 'screenshot.png', data: new Uint8Array([0x89, 0x50, 0x00, 0x01]) },
    ]));
    const ing = ingest(withImage, 'anon.tar.gz');
    expect(ing.files).toHaveLength(1);
    expect(ing.textEntries.some((t) => t.name === 'screenshot.png')).toBe(false);
  });

  it('run returns usage on missing args', () => {
    expect(run([]).code).toBe(2);
    expect(run([]).output).toContain('Commands:');
  });

  it('aligns a device-local logcat clock onto the UTC tracing logs', () => {
    // Tracing log ends 10:00:02 UTC; logcat (threadtime, no year, device on
    // UTC+2) ends at 12:00:40 local — both captured at submission time.
    const ing = ingest(buildLogcatArchive([
      `${LOGCAT_MD} 12:00:10.000  100  100 D Tag: first`,
      `${LOGCAT_MD} 12:00:40.000  100  100 D Tag: last`,
    ].join('\n')), 'anon.tar.gz');

    // 2h 38s of raw difference rounds to the quarter hour: exactly -2h.
    expect(ing.logcatSkewUs).toBe(-2 * 3600e6);
    const logcatLines = ing.files.find((f) => f.name === 'logcat.log.gz')!.result.rawLogLines;
    expect(logcatLines[logcatLines.length - 1].isoTimestamp).toBe(`${LOGCAT_YEAR}-${LOGCAT_MD}T10:00:40.000000Z`);
    // The shift is announced in the files legend, never silent.
    const output = cmdGrep(ing, ['Tag'], {});
    expect(output).toContain('device-local times shifted -2h to UTC');
  });

  it('leaves a same-clock logcat untouched', () => {
    // Logcat ends 38 seconds after the tracing log — capture jitter, not a
    // timezone.
    const ing = ingest(buildLogcatArchive([
      `${LOGCAT_MD} 10:00:10.000  100  100 D Tag: first`,
      `${LOGCAT_MD} 10:00:40.000  100  100 D Tag: last`,
    ].join('\n')), 'anon.tar.gz');

    expect(ing.logcatSkewUs).toBe(0);
    const logcatLines = ing.files.find((f) => f.name === 'logcat.log.gz')!.result.rawLogLines;
    expect(logcatLines[logcatLines.length - 1].isoTimestamp).toBe(`${LOGCAT_YEAR}-${LOGCAT_MD}T10:00:40.000000Z`);
    // No shift means no legend note.
    expect(cmdGrep(ing, ['Tag'], {})).not.toContain('shifted');
  });

  it('lastseen lists targets quietest-first with silence gaps', () => {
    const log = [
      '# [shakeview-anonymized]',
      '2026-01-15T10:00:00.000000Z DEBUG matrix_sdk::event_cache: handling update',
      '2026-01-15T10:00:01.000000Z DEBUG matrix_sdk::sliding_sync: tick',
      '2026-01-15T10:00:02.000000Z DEBUG matrix_sdk::event_cache: handling update',
      '2026-01-15T10:00:30.000000Z DEBUG matrix_sdk::sliding_sync: tick',
    ].join('\n');
    const output = run(['lastseen', writeTmpArchive(buildArchive(log))]).output;

    // The wedged-looking target (last line 28s before the end) floats to the top.
    const eventCacheAt = output.indexOf('matrix_sdk::event_cache');
    const slidingSyncAt = output.indexOf('matrix_sdk::sliding_sync');
    expect(eventCacheAt).toBeGreaterThan(-1);
    expect(slidingSyncAt).toBeGreaterThan(-1);
    expect(eventCacheAt).toBeLessThan(slidingSyncAt);
    expect(output).toContain('silent');
    expect(output).toContain('(2 lines)');
  });
});

/** Write an archive to a temp file and return its path (for `run`). */
function writeTmpArchive(bytes: Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), 'rageshake-cli-'));
  const path = join(dir, 'archive.tar.gz');
  writeFileSync(path, bytes);
  return path;
}

describe('serve', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'serve-'));
  writeFileSync(join(dataRoot, 'rageshake.tar.gz'), 'x');

  it('resolves a file inside the served directory', () => {
    expect(resolveServePath('/rageshake.tar.gz', dataRoot)).toBe(join(dataRoot, 'rageshake.tar.gz'));
  });

  it('refuses to escape the served directory', () => {
    // A crafted link must not reach files outside the two roots, raw or encoded.
    expect(resolveServePath('/../../.ssh/id_rsa', dataRoot)).toBeNull();
    expect(resolveServePath('/%2e%2e/%2e%2e/.ssh/id_rsa', dataRoot)).toBeNull();
    expect(resolveServePath('/nope/%ZZ', dataRoot)).toBeNull();
    expect(resolveServePath('/missing.tar.gz', dataRoot)).toBeNull();
  });

  it('refuses dot files and dot directories inside it', () => {
    // A normalizing client turns /../.gitignore into /.gitignore, which resolves
    // *inside* the root — the served directory's own .git/.env must stay unreadable.
    writeFileSync(join(dataRoot, '.gitignore'), 'x');
    expect(resolveServePath('/.gitignore', dataRoot)).toBeNull();
    expect(resolveServePath('/.git/config', dataRoot)).toBeNull();
    expect(resolveServePath('/sub/.env', dataRoot)).toBeNull();
  });

  it('parses its own args, defaulting the directory and the port', () => {
    expect(parseServeArgs([])).toEqual({ dir: resolve('.'), port: DEFAULT_PORT });
    // A bare directory must survive the flag filtering — the port index is not 0.
    expect(parseServeArgs([dataRoot])).toEqual({ dir: dataRoot, port: DEFAULT_PORT });
    expect(parseServeArgs(['--port', '9000'])).toEqual({ dir: resolve('.'), port: 9000 });
    expect(parseServeArgs([dataRoot, '--port', '9000'])).toEqual({ dir: dataRoot, port: 9000 });
    expect(() => parseServeArgs(['--port', 'abc'])).toThrow(/integer/);
    expect(() => parseServeArgs(['--port', '70000'])).toThrow(/integer/);
  });
});

import { describe, expect, it } from 'vitest';
import { parseDetailsJson, rustSdkShaFromLogs } from '../detailsJson';
import { isValidPublicHomeserver, mxcToThumbnailUrl, userInitial } from '../matrixProfile';

describe('parseDetailsJson', () => {
  it('extracts the fields shown by the archive-style details panel', () => {
    const details = parseDetailsJson(JSON.stringify({
      user_text: 'The app crashed',
      report_url: 'https://github.com/element-hq/element-ios/issues/1234',
      data: {
        user_id: '@alice:matrix.org',
        device_id: 'ABC123',
        device_keys: 'curve25519:key',
        base_bundle_identifier: 'io.element.app',
        Version: '1.2.3',
        sdk_sha: 'deadbeef',
      },
    }));

    expect(details).toEqual({
      userText: 'The app crashed',
      userId: '@alice:matrix.org',
      deviceId: 'ABC123',
      deviceKeys: 'curve25519:key',
      appId: 'io.element.app',
      version: '1.2.3',
      sdkSha: 'deadbeef',
      cryptoVersion: null,
      reportUrl: 'https://github.com/element-hq/element-ios/issues/1234',
    });
  });

  it('reads Element Web\'s top-level app name and crypto version', () => {
    const details = parseDetailsJson(JSON.stringify({
      app: 'element-web',
      data: { Version: '1ee97aafa800-js-19b6c36aa554', crypto_version: 'Rust SDK 0.18.0 (e5f8295), Vodozemac 0.10.0' },
    }));

    expect(details).toMatchObject({
      appId: 'element-web',
      version: '1ee97aafa800-js-19b6c36aa554',
      sdkSha: null,
      cryptoVersion: 'Rust SDK 0.18.0 (e5f8295), Vodozemac 0.10.0',
    });
  });

  it('returns null for malformed JSON', () => {
    expect(parseDetailsJson('{not valid json')).toBeNull();
  });
});

describe('matrixProfile helpers', () => {
  it('converts MXC URIs to thumbnail URLs', () => {
    expect(mxcToThumbnailUrl('matrix.org', 'mxc://example.com/media-id')).toBe(
      'https://matrix.org/_matrix/media/v3/thumbnail/example.com/media-id?width=96&height=96&method=crop'
    );
  });

  it('returns the first visible user letter', () => {
    expect(userInitial('@alice:matrix.org')).toBe('A');
  });

  it('accepts public domains and rejects localhost-style hosts', () => {
    expect(isValidPublicHomeserver('matrix.org')).toBe(true);
    expect(isValidPublicHomeserver('localhost')).toBe(false);
  });
});

describe('rustSdkShaFromLogs', () => {
  it('reads the matrix-rust-sdk commit from a crypto-wasm checkout path', () => {
    const lines = [{ rawText: '2026-09-29T07:06:20.000Z I no path here' }, { rawText: [
    '2026-09-29T07:06:20.662Z D DEBUG matrix_sdk_crypto::session_manager::group_sessions::share_strategy: Rotating room key to protect room history',
    '    device_removed=true visibility_changed=false algorithm_changed=false',
    '    at /home/runner/.cargo/git/checkouts/matrix-rust-sdk-5cafb5792f78b8d1/f333a32/crates/matrix-sdk-crypto/src/session_manager/group_sessions/share_strategy.rs:211',
    '    in matrix_sdk_crypto::session_manager::group_sessions::share_strategy::collect_session_recipients',
    '    in matrix_sdk_crypto::session_manager::group_sessions::share_room_key with room_id="!room-af33e3161742:example.org" session_id="CCJQ"',
  ].join('\n') }];
    expect(rustSdkShaFromLogs(lines)).toBe('f333a32');
  });

  it('prefers the newest line when the archive spans builds', () => {
    const at = (sha: string) => ({ rawText: `x\n    at /r/.cargo/git/checkouts/matrix-rust-sdk-5cafb579/${sha}/crates/a.rs:1` });
    expect(rustSdkShaFromLogs([at('aaaaaaa'), at('bbbbbbb')])).toBe('bbbbbbb');
  });

  it('returns null when no line names a checkout', () => {
    expect(rustSdkShaFromLogs([{ rawText: '2026-09-29T07:06:20.000Z I hello' }])).toBeNull();
  });
});

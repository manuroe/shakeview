import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseDetailsJson, rustSdkShaFromLogs } from '../detailsJson';
import { clearMatrixProfiles, fetchMatrixProfile, isValidPublicHomeserver, mxcToThumbnailUrl, userInitial } from '../matrixProfile';
import { CRYPTO_WASM_PRETTY_ENTRY } from '../../test/fixtures';

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

describe('fetchMatrixProfile', () => {
  afterEach(() => {
    clearMatrixProfiles();
    vi.restoreAllMocks();
  });

  it('never asks an anonymized alias domain, nor a subdomain or port of one', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}'));
    for (const userId of ['@user-0bb8c8918e88:domain-60fc0bb7.org', '@u:matrix.domain-60fc0bb7.org', '@u:domain-60fc0bb7.org:8448']) {
      expect(await fetchMatrixProfile(userId)).toBeNull();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('asks a real domain that merely looks alike', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ displayname: 'Alice' })));
    expect(await fetchMatrixProfile('@alice:domain-example.org')).toEqual({ displayName: 'Alice', avatarHttpUrl: null });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('forgets a failure, even one thrown before the request is sent, so the next fetch retries', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementationOnce(() => { throw new TypeError('blocked'); })
      .mockResolvedValue(new Response(JSON.stringify({ displayname: 'Alice' })));
    expect(await fetchMatrixProfile('@alice:matrix.org')).toBeNull();
    expect(await fetchMatrixProfile('@alice:matrix.org')).toEqual({ displayName: 'Alice', avatarHttpUrl: null });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe('rustSdkShaFromLogs', () => {
  it('reads the matrix-rust-sdk commit from a crypto-wasm checkout path', () => {
    const lines = [{ rawText: '2026-09-29T07:06:20.000Z I no path here' }, { rawText: CRYPTO_WASM_PRETTY_ENTRY }];
    expect(rustSdkShaFromLogs(lines)).toBe('f333a32');
  });

  it('prefers the newest line when the archive spans builds', () => {
    const at = (sha: string) => ({ rawText: `x\n    at /r/.cargo/git/checkouts/matrix-rust-sdk-5cafb579/${sha}/crates/a.rs:1` });
    expect(rustSdkShaFromLogs([at('aaaaaaa'), at('bbbbbbb')])).toBe('bbbbbbb');
  });

  it('reads the commit under a custom CARGO_HOME', () => {
    const line = { rawText: 'x\n    at /usr/local/cargo/git/checkouts/matrix-rust-sdk-5cafb579/f333a32/crates/matrix-sdk-crypto/src/olm/session.rs:42' };
    expect(rustSdkShaFromLogs([line])).toBe('f333a32');
  });

  it('returns null when a newer crates.io build follows an older git build', () => {
    const git = { rawText: 'x\n    at /r/.cargo/git/checkouts/matrix-rust-sdk-5cafb579/aaaaaaa/crates/a.rs:1' };
    const registry = { rawText: 'x\n    at /r/.cargo/registry/src/index.crates.io-1949cf8c/matrix-sdk-crypto-0.18.0/src/machine/mod.rs:1' };
    // The newest build names only a crate version: the older sha would be stale.
    expect(rustSdkShaFromLogs([git, registry])).toBeNull();
    expect(rustSdkShaFromLogs([registry, git])).toBe('aaaaaaa');
  });

  it('returns null when no line names a checkout', () => {
    expect(rustSdkShaFromLogs([{ rawText: '2026-09-29T07:06:20.000Z I hello' }])).toBeNull();
  });
});

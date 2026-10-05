import { describe, expect, it } from 'vitest';
import { parseDetailsJson } from '../detailsJson';
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
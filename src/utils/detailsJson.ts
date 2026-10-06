import type { ListingDetails } from '../types/listing';
import { RUST_SDK_REGISTRY_PATH_RE } from './logParser';

/**
 * Parses the subset of `details.json` fields shown in the archive-style UI.
 *
 * @example
 * const details = parseDetailsJson('{"user_text":"Crash","data":{"user_id":"@alice:example.com"}}');
 * console.log(details?.userId); // '@alice:example.com'
 */
export function parseDetailsJson(text: string): ListingDetails | null {
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    const data = (typeof json['data'] === 'object' && json['data'] !== null
      ? json['data']
      : {}) as Record<string, unknown>;
    const getString = (value: unknown): string | null => (
      typeof value === 'string' && value.length > 0 ? value : null
    );
    return {
      userText: getString(json['user_text']),
      userId: getString(data['user_id']),
      deviceId: getString(data['device_id']),
      deviceKeys: getString(data['device_keys']),
      // Element Web reports its app name top-level (`"app": "element-web"`), not in data.
      appId: getString(data['base_bundle_identifier']) ?? getString(data['app_id']) ?? getString(json['app']),
      version: getString(data['Version']),
      sdkSha: getString(data['sdk_sha']),
      cryptoVersion: getString(data['crypto_version']),
      reportUrl: getString(json['report_url']),
    };
  } catch {
    return null;
  }
}

// matrix-sdk-crypto-wasm builds against a git checkout of matrix-rust-sdk, and its
// tracing source paths keep that checkout dir: `<CARGO_HOME>/git/checkouts/matrix-rust-sdk-<h>/<sha>/crates/…`.
// CARGO_HOME is `~/.cargo` by default but configurable (`/usr/local/cargo` in Docker images),
// so only the stable `git/checkouts/…` suffix is matched.
const RUST_SDK_CHECKOUT_RE = /\/git\/checkouts\/matrix-rust-sdk-[0-9a-f]+\/([0-9a-f]{7,40})\//;

/**
 * The matrix-rust-sdk commit an Element Web build ran, read from its crypto-wasm log
 * lines. Web's `details.json` has no `sdk_sha`, only `crypto_version`, which names a
 * crypto-wasm commit rather than the SDK one. Scans newest first and stops at the
 * newest SDK source path: an archive can span app updates, and details.json describes
 * the build that sent it. Returns null when that newest path is a crates.io one
 * (release builds name only the crate version) or when no line carries a path.
 *
 * @example
 * rustSdkShaFromLogs([{ rawText: '    at /home/runner/.cargo/git/checkouts/matrix-rust-sdk-5cafb579/f333a32/crates/a.rs:1' }]);
 * // 'f333a32'
 */
export function rustSdkShaFromLogs(lines: readonly { readonly rawText: string }[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const { rawText } = lines[i];
    if (rawText.includes('/checkouts/matrix-rust-sdk-')) {
      const m = rawText.match(RUST_SDK_CHECKOUT_RE);
      if (m) return m[1];
    }
    // A newer release build: its SDK commit is unknown, so an older checkout sha would be stale.
    if (rawText.includes('/registry/src/') && RUST_SDK_REGISTRY_PATH_RE.test(rawText)) return null;
  }
  return null;
}

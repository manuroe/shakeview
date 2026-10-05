import type { ListingDetails } from '../types/listing';

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
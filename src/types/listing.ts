/**
 * Shared types for remote rageshake listing pages rendered by the extension.
 */

/**
 * A single file entry discovered on a remote `/api/listing/*` page.
 */
export interface ListingEntry {
  /** Display name shown in the listing table. */
  readonly name: string;
  /** Absolute HTTPS URL of the file on the rageshake server. */
  readonly url: string;
}

/**
 * Selected metadata extracted from a listing page's `details.json` file.
 */
export interface ListingDetails {
  readonly userText: string | null;
  readonly userId: string | null;
  readonly deviceId: string | null;
  readonly deviceKeys: string | null;
  readonly appId: string | null;
  readonly version: string | null;
  readonly sdkSha: string | null;
  /**
   * Element Web's crypto stack, e.g. "Rust SDK 0.18.0 (e5f8295), Vodozemac 0.10.0".
   * Web has no `sdk_sha`; this is the only pointer to the Rust crypto code it ran.
   */
  readonly cryptoVersion: string | null;
  /** Link back to the report on the rageshake server, for citing a source in analysis notes. */
  readonly reportUrl: string | null;
}

/**
 * Optional Matrix profile information resolved from a homeserver profile API.
 */
export interface MatrixProfile {
  readonly displayName: string | null;
  readonly avatarHttpUrl: string | null;
}
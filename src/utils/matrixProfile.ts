/**
 * Utilities shared by archive-like views that enrich `details.json` with Matrix profile data.
 *
 * @example
 * const url = mxcToThumbnailUrl('matrix.org', 'mxc://example.com/media');
 * console.log(url?.includes('/_matrix/media/')); // true
 */
import type { MatrixProfile } from '../types/listing';
import { isDomainAlias } from './anonymizeUtils';

const PUBLIC_HOMESERVER_PATTERN = /^[a-zA-Z][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}(?::\d{1,5})?$/;

/**
 * Converts an `mxc://` URI to a homeserver thumbnail URL, so an avatar can be shown with a plain `<img>`.
 *
 * @example mxcToThumbnailUrl('matrix.org', 'mxc://example.com/abc') // 'https://matrix.org/_matrix/media/v3/thumbnail/example.com/abc?width=96&height=96&method=crop'
 */
export function mxcToThumbnailUrl(homeserver: string, mxcUrl: string): string | null {
  if (!mxcUrl.startsWith('mxc://')) return null;
  const path = mxcUrl.slice('mxc://'.length);
  const slash = path.indexOf('/');
  if (slash < 0) return null;
  const mediaServer = path.slice(0, slash);
  const mediaId = path.slice(slash + 1);
  return `https://${homeserver}/_matrix/media/v3/thumbnail/${encodeURIComponent(mediaServer)}/${encodeURIComponent(mediaId)}?width=96&height=96&method=crop`;
}

/**
 * Returns the first visible letter of a Matrix user ID: the avatar placeholder when there is no picture.
 *
 * @example userInitial('@alice:matrix.org') // 'A'
 */
export function userInitial(userId: string): string {
  const atIndex = userId.indexOf('@');
  const colonIndex = userId.indexOf(':', atIndex);
  if (atIndex < 0 || colonIndex < 0) return userId[0]?.toUpperCase() ?? '?';
  return userId[atIndex + 1]?.toUpperCase() ?? '?';
}

/**
 * Checks that a homeserver looks like a public domain name before fetching from it.
 *
 * @example isValidPublicHomeserver('localhost') // false
 */
export function isValidPublicHomeserver(homeserver: string): boolean {
  return PUBLIC_HOMESERVER_PATTERN.test(homeserver);
}

// One request per user per page load: /decryption lane headers re-render on every session switch.
const profiles = new Map<string, Promise<MatrixProfile | null>>();

/**
 * Forget every fetched profile, so each test mocks its own homeserver response.
 *
 * @example clearMatrixProfiles();
 */
export function clearMatrixProfiles(): void {
  profiles.clear();
}

/**
 * The profile of `userId` from their homeserver, fetched once per page load, so views can show a
 * face and a name next to a Matrix ID. `null` when the homeserver can't be reached or must not be:
 * only public-looking domains are asked (crafted logs must not reach unexpected hosts), never an
 * anonymized alias (`domain-<hash>.org`), which could be a real domain and would leak the user id.
 *
 * @example (await fetchMatrixProfile('@alice:matrix.org'))?.displayName // 'Alice'
 */
export function fetchMatrixProfile(userId: string): Promise<MatrixProfile | null> {
  const cached = profiles.get(userId);
  if (cached) return cached;
  const colonIndex = userId.indexOf(':', 1);
  const homeserver = colonIndex < 0 ? '' : userId.slice(colonIndex + 1);
  // The alias is the last two labels (a subdomain or a port may follow the anonymizer's rewrite).
  const domain = homeserver.replace(/:\d+$/, '').split('.').slice(-2).join('.');
  if (!isValidPublicHomeserver(homeserver) || isDomainAlias(domain)) return Promise.resolve(null);
  const request = (async () => {
    const response = await fetch(`https://${homeserver}/_matrix/client/v3/profile/${encodeURIComponent(userId)}`);
    if (!response.ok) return null;
    const json = (await response.json()) as Record<string, unknown>;
    return {
      displayName: typeof json['displayname'] === 'string' ? json['displayname'] : null,
      avatarHttpUrl: typeof json['avatar_url'] === 'string' ? mxcToThumbnailUrl(homeserver, json['avatar_url']) : null,
    };
  })().catch(() => {
    // Offline or CORS: forget the failure, so the next fetch of this user (a later mount) retries.
    // A reaction, so it runs after the set below even when the request throws before its first await.
    profiles.delete(userId);
    return null;
  });
  profiles.set(userId, request);
  return request;
}
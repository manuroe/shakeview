import type { AnonymizationDictionary } from '../types/log.types';
import { applyUnanonymization, decodeIdentifier, isIdentifierAlias, MATRIX_IDENTIFIER_RE } from './anonymizeUtils';

/** What the anonymise page knows about one file it anonymised. */
export interface DeanonymizeSource {
  /** Download name of the anonymised file, as a report's deep links cite it. */
  readonly anonymizedName: string;
  readonly dict: AnonymizationDictionary;
  /** URL the raw archive can be fetched from in this browser; null for single logs. */
  readonly rawUrl: string | null;
}

/** A shakeview deep link: anything with a hash route, e.g. `http://127.0.0.1:7357/#/logs?archive=…`. */
const VIEWER_LINK_RE = /https?:\/\/[^\s)<>"'`]*#\/[^\s)<>"'`]*/g;

/**
 * Reverse a report written about anonymised rageshakes, using the mappings of
 * every file the page anonymised.
 *
 * Aliases are a pure function of (identifier, salt), so mappings built from
 * different archives with one salt never disagree: they merge into one.
 *
 * @example
 * ```ts
 * unanonymizeReport('@user-0123456789ab:domain-01234567.org left', [{ anonymizedName, dict, rawUrl: null }]);
 * // '@alice:example.org left'
 * ```
 */
export function unanonymizeReport(report: string, sources: readonly DeanonymizeSource[]): string {
  const reverse: Record<string, string> = {};
  const forward: Record<string, string> = {};
  for (const s of sources) {
    Object.assign(reverse, s.dict.reverse);
    Object.assign(forward, s.dict.forward);
  }
  return applyUnanonymization(report, { forward, reverse });
}

/**
 * Repoint deep links into an archive the page holds the raw copy of at this app
 * (`appBase`) with that copy, so they open the real log at the same file and
 * line — anonymisation keeps both unchanged in archives. Other links stay as is.
 *
 * Only for display: the raw copy's `blob:` URL dies with the tab, so a saved or
 * copied report keeps its original links.
 *
 * @example
 * ```ts
 * repointViewerLinks('[x](http://127.0.0.1:7357/#/logs?archive=/c/r-anonym.tar.gz&line=3)',
 *   [{ anonymizedName: 'r-anonym.tar.gz', dict, rawUrl: 'blob:https://a/1' }], 'https://a/');
 * // '[x](https://a/#/logs?archive=blob%3Ahttps%3A%2F%2Fa%2F1&line=3)'
 * ```
 */
export function repointViewerLinks(text: string, sources: readonly DeanonymizeSource[], appBase: string): string {
  const rawUrls = new Map<string, string>();
  for (const s of sources) if (s.rawUrl) rawUrls.set(s.anonymizedName, s.rawUrl);

  return text.replace(VIEWER_LINK_RE, (link) => {
    const route = link.slice(link.indexOf('#') + 1);
    const q = route.indexOf('?');
    if (q < 0) return link;
    const params = new URLSearchParams(route.slice(q + 1));
    const rawUrl = rawUrls.get(params.get('archive')?.split('/').pop() ?? '');
    if (!rawUrl) return link;
    params.set('archive', rawUrl);
    return `${appBase}#${route.slice(0, q)}?${params.toString()}`;
  });
}

/**
 * Distinct aliases still in `text` after reversing: identifiers no loaded
 * mapping knows. Non-zero means the rageshake loaded is not the one the text
 * was written about, or it was anonymised with another salt (another browser
 * or install) — a mismatch that would otherwise leave the text silently
 * unchanged.
 *
 * @example
 * ```ts
 * countUnresolvedAliases('@user-0123456789ab:domain-01234567.org and @alice:example.org'); // 1
 * ```
 */
export function countUnresolvedAliases(text: string): number {
  // Same scan as the CLI's precheck. Fresh regex instance so its lastIndex is ours.
  const seen = new Set<string>();
  for (const [id] of text.matchAll(new RegExp(MATRIX_IDENTIFIER_RE.source, 'g'))) {
    const decoded = decodeIdentifier(id);
    if (isIdentifierAlias(decoded)) seen.add(decoded);
  }
  return seen.size;
}

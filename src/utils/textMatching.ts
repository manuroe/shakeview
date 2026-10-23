import type React from 'react';
import { createElement } from 'react';

/**
 * Finds indices of items that match a query string.
 *
 * @param items - Array of items to search through
 * @param query - The search/filter query string
 * @param caseSensitive - Whether to perform case-sensitive matching
 * @param getText - Function to extract searchable text from each item
 * @returns Set of matching item indices
 *
 * @example
 * ```ts
 * const matches = findMatchingIndices(
 *   logLines,
 *   'error',
 *   false,
 *   (line) => line.rawText
 * );
 * // Returns Set<number> of indices where 'error' appears
 * ```
 */
export function findMatchingIndices<T>(
  items: readonly T[],
  query: string,
  caseSensitive: boolean,
  getText: (item: T) => string
): Set<number> {
  if (!query.trim()) return new Set<number>();

  const normalizedQuery = caseSensitive ? query : query.toLowerCase();
  const indices = new Set<number>();

  items.forEach((item, index) => {
    const text = getText(item);
    const haystack = caseSensitive ? text : text.toLowerCase();
    if (haystack.includes(normalizedQuery)) {
      indices.add(index);
    }
  });

  return indices;
}

/**
 * Expands a set of matching indices to include context lines before and after.
 *
 * @param matchingIndices - Set of indices that matched the query
 * @param totalCount - Total number of items in the collection
 * @param contextLines - Number of lines to include before and after each match
 * @returns Set of indices including context lines
 *
 * @example
 * ```ts
 * // If line 50 matches and contextLines is 3:
 * // Returns Set containing lines 47, 48, 49, 50, 51, 52, 53
 * const expanded = expandWithContext(new Set([50]), 100, 3);
 * ```
 */
export function expandWithContext(
  matchingIndices: Set<number>,
  totalCount: number,
  contextLines: number
): Set<number> {
  if (contextLines === 0) return matchingIndices;

  const expanded = new Set<number>();
  matchingIndices.forEach((matchIndex) => {
    const start = Math.max(0, matchIndex - contextLines);
    const end = Math.min(totalCount - 1, matchIndex + contextLines);
    for (let i = start; i <= end; i++) {
      expanded.add(i);
    }
  });

  return expanded;
}

/**
 * Options for text highlighting.
 */
export interface HighlightOptions {
  /** The query string to highlight */
  query: string;
  /** Whether to use case-sensitive matching */
  caseSensitive: boolean;
  /** CSS class name for the highlight mark element */
  highlightClassName?: string;
  /** Prefix for React keys (should be unique per line) */
  keyPrefix: string;
}

/**
 * Highlights occurrences of a query within text, returning React nodes.
 *
 * @param text - The text to search and highlight within
 * @param options - Highlighting options
 * @returns Array of React nodes with <mark> elements for matches
 *
 * @example
 * ```tsx
 * const highlighted = highlightText('Error: connection failed', {
 *   query: 'error',
 *   caseSensitive: false,
 *   keyPrefix: 'line-42',
 *   highlightClassName: 'search-highlight'
 * });
 * // Returns: [<mark>Error</mark>, ': connection failed']
 * ```
 */
export function highlightText(text: string, options: HighlightOptions): React.ReactNode[] {
  const { query, caseSensitive, highlightClassName = 'search-highlight', keyPrefix } = options;

  if (!query.trim()) {
    return [text];
  }

  const normalizedQuery = caseSensitive ? query : query.toLowerCase();
  const searchableText = caseSensitive ? text : text.toLowerCase();

  // Check if there are any matches first
  if (!searchableText.includes(normalizedQuery)) {
    return [text];
  }

  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let searchIndex = 0;

  while ((searchIndex = searchableText.indexOf(normalizedQuery, lastIndex)) !== -1) {
    // Add text before match
    if (searchIndex > lastIndex) {
      parts.push(
        createElement('span', { key: `${keyPrefix}-text-${lastIndex}` }, text.substring(lastIndex, searchIndex))
      );
    }
    // Add highlighted match (using original case from text)
    parts.push(
      createElement(
        'mark',
        { key: `${keyPrefix}-mark-${searchIndex}`, className: highlightClassName },
        text.substring(searchIndex, searchIndex + query.length)
      )
    );
    lastIndex = searchIndex + query.length;
  }

  // Add remaining text after last match
  if (lastIndex < text.length) {
    parts.push(createElement('span', { key: `${keyPrefix}-text-${lastIndex}` }, text.substring(lastIndex)));
  }

  return parts.length > 0 ? parts : [text];
}

/**
 * Checks if text contains a query string.
 *
 * @param text - The text to search within
 * @param query - The query string to find
 * @param caseSensitive - Whether to use case-sensitive matching
 * @returns true if query is found in text
 */
export function textContains(text: string, query: string, caseSensitive: boolean): boolean {
  if (!query.trim()) return false;
  const normalizedQuery = caseSensitive ? query : query.toLowerCase();
  const haystack = caseSensitive ? text : text.toLowerCase();
  return haystack.includes(normalizedQuery);
}

/**
 * HTTP Status Code color utilities.
 * Uses CSS variables from foundation.css for theme support.
 */

/** Known status codes with specific colors in foundation.css */
const KNOWN_CODES = new Set([
  200, 201, 202, 204,
  301, 302, 304, 307, 308,
  400, 401, 403, 404, 405, 408, 409, 410, 422, 429,
  500, 501, 502, 503, 504,
]);

/**
 * Get the CSS variable name for an HTTP status code.
 * Falls back to category fallback (e.g., --http-2xx) for unknown codes.
 */
export function getHttpStatusColorVar(status: string | number): string {
  const code = typeof status === 'string' ? parseInt(status, 10) : status;

  if (isNaN(code)) return '--http-incomplete';

  if (KNOWN_CODES.has(code)) {
    return `--http-${code}`;
  }

  // Fall back to category
  if (code >= 500) return '--http-5xx';
  if (code >= 400) return '--http-4xx';
  if (code >= 300) return '--http-3xx';
  if (code >= 200) return '--http-2xx';

  return '--http-incomplete';
}

// Fallback colors matching foundation.css light theme (using Map for eslint compliance)
const codeFallbackColors = new Map<number, string>([
  [200, '#166534'],
  [201, '#1e8b47'],
  [202, '#229e51'],
  [204, '#1a783e'],
  [301, '#127e8f'],
  [302, '#1490a4'],
  [304, '#17a2b8'],
  [307, '#0f6c7b'],
  [308, '#0d5a66'],
  [400, '#d97706'],
  [401, '#b66405'],
  [403, '#a55a05'],
  [404, '#c86d06'],
  [405, '#5f3403'],
  [408, '#4e2b02'],
  [409, '#824704'],
  [410, '#3d2102'],
  [422, '#713e03'],
  [429, '#945104'],
  [500, '#a855f7'],
  [501, '#7b0be5'],
  [502, '#9d3ff6'],
  [503, '#9229f5'],
  [504, '#8613f4'],
]);

// Category fallback colors
const categoryFallbackColors = new Map<string, string>([
  ['success', '#166534'],
  ['redirect', '#17a2b8'],
  ['clientError', '#d97706'],
  ['serverError', '#a855f7'],
  ['incomplete', '#7b8667'],
]);

/**
 * Get the actual color value for an HTTP status code.
 * Returns CSS variable reference for browser use (e.g., "var(--http-404)").
 * Falls back to hardcoded colors for SSR/tests where CSS vars aren't available.
 */
export function getHttpStatusColor(status: string | number): string {
  const varName = getHttpStatusColorVar(status);
  const code = typeof status === 'string' ? parseInt(status, 10) : status;

  // In browser, return CSS variable reference for theme support
  if (typeof document !== 'undefined') {
    return `var(${varName})`;
  }

  // Fallback for SSR or when CSS not available
  if (!isNaN(code) && codeFallbackColors.has(code)) {
    return codeFallbackColors.get(code)!;
  }

  const category = getHttpStatusCategory(status);
  return categoryFallbackColors.get(category) ?? '#7b8667';
}

/**
 * Get status category for an HTTP status code.
 */
export function getHttpStatusCategory(status: string | number): 'success' | 'redirect' | 'clientError' | 'serverError' | 'incomplete' {
  const code = typeof status === 'string' ? parseInt(status, 10) : status;

  if (isNaN(code)) return 'incomplete';
  if (code >= 500) return 'serverError';
  if (code >= 400) return 'clientError';
  if (code >= 300) return 'redirect';
  if (code >= 200) return 'success';

  return 'incomplete';
}

/**
 * Get all unique status codes from a list and their colors.
 * Useful for building chart legends.
 */
export function getStatusCodeLegend(statusCodes: string[]): Array<{ code: string; color: string }> {
  const unique = [...new Set(statusCodes)].sort((a, b) => {
    const numA = parseInt(a, 10);
    const numB = parseInt(b, 10);
    const aIsNum = !Number.isNaN(numA);
    const bIsNum = !Number.isNaN(numB);
    if (!aIsNum && bIsNum) return 1;
    if (aIsNum && !bIsNum) return -1;
    if (!aIsNum && !bIsNum) return 0;
    return numA - numB;
  });
  return unique.map(code => ({
    code,
    color: getHttpStatusColor(code),
  }));
}

/**
 * Get the CSS class suffix for an HTTP status code badge.
 * Returns the class name without the 'badge' prefix (e.g., "Http404", "Http2xx").
 * Use with Table.module.css badge classes.
 */
export function getHttpStatusBadgeClass(status: string | number): string {
  if (status === 'Client Error') return 'ClientError';

  const code = typeof status === 'string' ? parseInt(status, 10) : status;

  if (isNaN(code)) return 'Incomplete';

  if (KNOWN_CODES.has(code)) {
    return `Http${code}`;
  }

  // Fall back to category
  if (code >= 500) return 'Http5xx';
  if (code >= 400) return 'Http4xx';
  if (code >= 300) return 'Http3xx';
  if (code >= 200) return 'Http2xx';

  return 'Incomplete';
}

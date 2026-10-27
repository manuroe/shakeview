import { extractCategory } from './listingEntries';

/**
 * Maps each process (log stream) to a colour so merged multi-process logs can
 * be told apart at a glance. The process name is the filename's leading token
 * (`console`, `nse`, `shareextension`, …) — see {@link extractCategory}.
 */

// ponytail: fixed palette, distinct hues that read on both the light and dark
// log backgrounds. Wraps if there are ever more processes than colours.
const PALETTE = [
  '#0dbd8b', // Element green: the main app lane, matching the Compound accent
  '#3b82f6', // blue
  '#f59e0b', // amber
  '#ec4899', // pink
  '#8b5cf6', // violet
  '#14b8a6', // teal
  '#ef4444', // red
  '#a3a30a', // olive
];

/**
 * Base colour of the main app (console) lane. The app-state bars are shades of
 * this — see `appStateColors`. Matches the colour the `console` process gets
 * from {@link buildProcessColorMap} (it sorts first), so the app lane reads as
 * "the green stream" just like in multi-process view.
 */
export const APP_LANE_COLOR = PALETTE[0];

/** Process name of the main app stream (its lane carries the app-state colours). */
export const CONSOLE_PROCESS = 'console';

/** Convert `#rrggbb` (or `#rgb`) to HSL with h in [0,360), s/l in [0,1]. */
function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const n = parseInt(full, 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  const d = max - min;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
  }
  return { h, s, l };
}

/**
 * Shade a base colour by shifting lightness (and optionally saturation),
 * returning an `hsl(...)` string. Lightness is clamped to [0.12, 0.92] so shades
 * stay legible on both light and dark chart backgrounds. Generic so any lane's
 * base colour can be varied the same way.
 *
 * @example
 * shadeColor('#3b82f6', -0.18); // darker blue → 'hsl(217, 91%, 42%)'
 */
export function shadeColor(hex: string, deltaL: number, deltaS = 0): string {
  const { h, s, l } = hexToHsl(hex);
  const l2 = Math.min(0.92, Math.max(0.12, l + deltaL));
  const s2 = Math.min(1, Math.max(0, s + deltaS));
  return `hsl(${Math.round(h)}, ${Math.round(s2 * 100)}%, ${Math.round(l2 * 100)}%)`;
}

/** The process name for a source file (its leading filename token). */
export function processOf(sourceFile: string): string {
  return extractCategory(sourceFile);
}

/**
 * Builds a stable process → colour map from the given source-file names.
 * Processes are sorted by name so colour assignment is deterministic regardless
 * of load order.
 */
export function buildProcessColorMap(sourceFiles: readonly string[]): Map<string, string> {
  const processes = [...new Set(sourceFiles.map(processOf))].sort();
  const map = new Map<string, string>();
  processes.forEach((process, i) => map.set(process, PALETTE[i % PALETTE.length]));
  return map;
}

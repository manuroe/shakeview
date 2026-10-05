import type { LifecycleEvent, LifecycleEventKind } from '../types/log.types';
import type { TimestampMicros } from '../types/time.types';
import { shadeColor } from './processColors';

/**
 * Lifecycle kinds rendered as vertical lines on the charts — the two genuinely
 * point-in-time signals. Background/foreground/refresh are durations and are
 * shown as the app-state band instead (see {@link deriveAppStateSegments}).
 */
export const MARKER_KINDS = ['coldStart', 'crash'] as const;
export type MarkerKind = (typeof MARKER_KINDS)[number];

/**
 * Colour token (CSS custom property) for each vertical marker. Reuses the shared
 * `foundation.css` tokens so markers stay theme-aware; no hard-coded hex.
 *
 * @example
 * const stroke = MARKER_COLOR['crash']; // 'var(--log-level-error)'
 */
export const MARKER_COLOR: Record<MarkerKind, string> = {
  coldStart: 'var(--color-success)',
  crash: 'var(--log-level-error)',
};

/** Human-readable label for each vertical marker, used in the Help legend. */
export const MARKER_LABEL: Record<MarkerKind, string> = {
  coldStart: 'Cold start',
  crash: 'Crash',
};

/** True when a lifecycle kind is drawn as a vertical marker line. */
export function isMarkerKind(kind: LifecycleEventKind): kind is MarkerKind {
  return (MARKER_KINDS as readonly LifecycleEventKind[]).includes(kind);
}

/**
 * App-lifecycle states colouring the log-activity bars on the log chart:
 * foreground (app active), background (backgrounded and still logging),
 * backgroundWorking (a labeled background task, e.g. a background refresh).
 * These colour the bars where the app logged; silence (no logs) is left empty
 * and reads as "idle / doing nothing".
 */
export type AppState = 'foreground' | 'background' | 'backgroundWorking';

/**
 * Derive the per-state bar colours as shades of a lane's base colour, so the
 * app-state bars keep the lane's colour identity (blue = the app/console
 * stream). Lightness ramp by prominence: **foreground darkest** (most active),
 * **backgroundWorking** a clearly lighter mid tone, **background lightest** and
 * faded (recedes). The same mechanism can colour any future per-process lane
 * from its own base colour.
 *
 * @example
 * appStateColors('#3b82f6'); // → { foreground: dark blue, 'backgroundWorking': mid blue, background: pale blue }
 */
export function appStateColors(baseColor: string): Record<AppState, string> {
  return {
    foreground: shadeColor(baseColor, -0.18),
    backgroundWorking: shadeColor(baseColor, 0.12),
    background: shadeColor(baseColor, 0.28, -0.15),
  };
}

/** Human-readable label for each app-state, used in hover titles + Help legend. */
export const APP_STATE_LABEL: Record<AppState, string> = {
  foreground: 'Foreground',
  background: 'Background',
  backgroundWorking: 'Background refresh',
};

type Platform = LifecycleEvent['platform'];

/**
 * One detection rule: a log message matches this rule when it contains every
 * string in `includes`. Multiple `includes` strings act as an AND-anchor (e.g.
 * the short Android token `onPause` is anchored on `MainActivity` to avoid
 * matching unrelated prose).
 */
interface LifecycleRule {
  readonly kind: LifecycleEventKind;
  readonly platform: Platform;
  readonly includes: readonly string[];
}

/**
 * Per-platform message substrings emitted by Element X and Element Web at
 * lifecycle moments, confirmed against the iOS (MXLog), Android (Timber) and
 * element-web sources.
 *
 * The Android retrospective `Sending error to Sentry` line is intentionally NOT
 * a crash rule — it is a generic error report, not necessarily a crash, and is
 * already surfaced as a Sentry event.
 */
const RULES: readonly LifecycleRule[] = [
  // iOS (MXLog). Distinctive full phrases — low false-positive risk.
  // Uses the retrospective "detected a crash in the previous run" line: at the
  // actual crash the app is dying and the live crash log rarely reaches the
  // shared rageshake, so the next-launch line is the reliable signal. It also
  // surfaces as a Sentry event (Reports table) — the duplicate is intentional;
  // the red marker is the at-a-glance signal.
  { kind: 'crash', platform: 'ios', includes: ['Sentry detected a crash'] },
  {
    kind: 'coldStart',
    platform: 'ios',
    includes: ['Sentry configured (enabled:'],
  },
  {
    kind: 'background',
    platform: 'ios',
    includes: ['Application will resign active'],
  },
  {
    kind: 'foreground',
    platform: 'ios',
    includes: ['Application did become active'],
  },
  // Background app refresh is an interval — split boundaries drive the
  // backgroundWorking state segment (see deriveAppStateSegments).
  {
    kind: 'backgroundRefreshStart',
    platform: 'ios',
    includes: ['Started background app refresh'],
  },
  {
    kind: 'backgroundRefreshEnd',
    platform: 'ios',
    includes: ['Background app refresh finished'],
  },

  // Android (Timber). Short tokens are anchored on the `MainActivity` tag.
  { kind: 'crash', platform: 'android', includes: ['FATAL EXCEPTION'] },
  { kind: 'crash', platform: 'android', includes: ['Uncaught exception:'] },
  {
    kind: 'coldStart',
    platform: 'android',
    includes: ['MainActivity', 'onCreate, with savedInstanceState:'],
  },
  {
    kind: 'background',
    platform: 'android',
    includes: ['MainActivity', 'onPause'],
  },
  {
    kind: 'foreground',
    platform: 'android',
    includes: ['MainActivity', 'onResume'],
  },

  // Element Web (matrix-js-sdk logger → rageshake console capture).
  // One page load = one rageshake instance = one logs-NNNN file.
  { kind: 'coldStart', platform: 'web', includes: ['Vector starting at '] },
  // Presence is driven by UserActivity: online on the first input after idle,
  // unavailable after 3 min without mouse/keyboard/focus. Idle, not tab-hidden:
  // the page's visibility change itself is never logged.
  { kind: 'foreground', platform: 'web', includes: ['Presence: online'] },
  { kind: 'background', platform: 'web', includes: ['Presence: unavailable'] },
  // Logged on beforeunload, then an async flush: often lost, but when present it
  // ends the session instead of letting it read as foreground until the next load.
  { kind: 'background', platform: 'web', includes: ['element-web closing'] },
];

/** Escape regex metacharacters so a literal substring can go in an alternation. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Cheap candidacy gate run before the full rule scan: a line can only match a
 * rule if it contains that rule's anchor (first `includes`) token, so a single
 * native regex pass rules out ~all non-lifecycle lines in one shot instead of
 * ~N `String.includes` scans each. Derived from RULES (deduped anchors) so it
 * can't drift out of sync. `detectLifecycleKind` runs on every parsed log line,
 * so this is a hot path.
 */
const PREFILTER = new RegExp(
  [...new Set(RULES.map((r) => r.includes[0]))].map(escapeRegExp).join('|'),
);

/**
 * Classify a single log message into a lifecycle event kind, or `null` when the
 * line is not a lifecycle transition. Matches on per-platform message
 * substrings; the platform is inferred from which rule matched, so combined
 * (merged) logs work without relying on global platform detection.
 *
 * @example
 * detectLifecycleKind('… Application will resign active');
 * // → { kind: 'background', platform: 'ios' }
 * detectLifecycleKind('… MainActivity: onResume');
 * // → { kind: 'foreground', platform: 'android' }
 * detectLifecycleKind('… Sending a message');
 * // → null
 */
export function detectLifecycleKind(
  message: string,
): { kind: LifecycleEventKind; platform: Platform } | null {
  if (!PREFILTER.test(message)) return null;
  for (const rule of RULES) {
    if (rule.includes.every((s) => message.includes(s))) {
      return { kind: rule.kind, platform: rule.platform };
    }
  }
  return null;
}

/** Latest timestamp among events whose kind matches, or `null` when none do.
 * Selected by timestamp (not array order) so merged/rotated logs still yield the
 * most recent one. */
function lastEventUs(
  events: readonly LifecycleEvent[],
  matches: (kind: LifecycleEventKind) => boolean,
): TimestampMicros | null {
  let latest: TimestampMicros | null = null;
  for (const event of events) {
    if (matches(event.kind) && (latest === null || event.timestampUs > latest)) {
      latest = event.timestampUs;
    }
  }
  return latest;
}

/**
 * Timestamp of the most recent cold start, or `null` when none was detected.
 * Backs the "Since last cold start" time-range preset.
 *
 * @example
 * lastColdStartUs([{ kind: 'coldStart', timestampUs: 100, … }, { kind: 'coldStart', timestampUs: 500, … }]); // → 500
 */
export function lastColdStartUs(events: readonly LifecycleEvent[]): TimestampMicros | null {
  return lastEventUs(events, (k) => k === 'coldStart');
}

/**
 * Timestamp of the most recent moment the app entered the foreground — a resume
 * (`foreground`) or a launch (`coldStart`, which also foregrounds). Backs the
 * "Since last foreground" time-range preset.
 *
 * @example
 * lastForegroundUs([{ kind: 'coldStart', timestampUs: 100, … }, { kind: 'foreground', timestampUs: 900, … }]); // → 900
 */
export function lastForegroundUs(events: readonly LifecycleEvent[]): TimestampMicros | null {
  return lastEventUs(events, (k) => k === 'foreground' || k === 'coldStart');
}

/** A contiguous span during which the app was in a single {@link AppState}. */
export interface AppStateSegment {
  readonly startUs: number;
  readonly endUs: number;
  readonly state: AppState;
}

/**
 * The app state at a timestamp, or `null` when it falls outside every segment
 * (undetermined). Binary search over the sorted, non-overlapping segments from
 * {@link deriveAppStateSegments}. Used to colour per-row lane stripes on the
 * logs / http_requests screens.
 *
 * @example
 * appStateAt([{ startUs: 0, endUs: 50, state: 'foreground' }], 30); // → 'foreground'
 */
export function appStateAt(
  segments: readonly AppStateSegment[],
  ts: number,
): AppState | null {
  let lo = 0;
  let hi = segments.length - 1;
  let candidate = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].startUs <= ts) {
      candidate = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (candidate === -1) return null;
  const seg = segments[candidate];
  return ts < seg.endUs ? seg.state : null;
}

/** Map a lifecycle event to the state it puts the app into, or `null` when the
 * event does not drive the state band. `crash` is `null`: our iOS crash signal
 * is the *retrospective* "detected a crash in the previous run" line, which
 * fires at launch and describes the PREVIOUS session — it must not terminate the
 * current session's state. A real crash needs no terminator either: the app
 * stops logging, so the activity bars stop on their own. */
function stateForKind(kind: LifecycleEventKind): AppState | null {
  switch (kind) {
    case 'coldStart':
    case 'foreground':
      return 'foreground';
    case 'background':
    case 'backgroundRefreshEnd':
      return 'background';
    case 'backgroundRefreshStart':
      return 'backgroundWorking';
    case 'crash':
      return null;
  }
}

/**
 * Segment the timeline into app-state spans (foreground / background /
 * backgroundWorking). The log chart renders each span as log-activity bars
 * (a bar wherever the app logged, coloured by state), so silence is left empty.
 *
 * Pass the FULL event list plus the visible `[minUs, maxUs]` window. The state
 * active at `minUs` is *carried in* from the last transition at or before it, so
 * the band stays correct when the window contains no transition (e.g. after
 * zooming in). The region before the very first event is left uncovered (we
 * don't invent a state we can't observe). Repeated same-state events collapse.
 * Input order is free.
 *
 * @example
 * // Window [50,150] with no in-window transition inherits foreground from t=0:
 * deriveAppStateSegments([
 *   { kind: 'foreground', timestampUs: 0, … },
 *   { kind: 'background', timestampUs: 200, … },
 * ], 50, 150);
 * // → [{ startUs: 50, endUs: 150, state: 'foreground' }]
 */
export function deriveAppStateSegments(
  events: readonly LifecycleEvent[],
  minUs: number,
  maxUs: number,
): readonly AppStateSegment[] {
  // Only events that drive a state participate; others (crash) are ignored here.
  const ordered = [...events]
    .filter((e) => stateForKind(e.kind) !== null)
    .sort((a, b) => a.timestampUs - b.timestampUs);
  const segments: AppStateSegment[] = [];
  let state: AppState | null = null;
  let i = 0;

  // Carry-in: replay transitions at or before the window start to get its state.
  for (; i < ordered.length && ordered[i].timestampUs <= minUs; i++) {
    state = stateForKind(ordered[i].kind);
  }

  let segStart = minUs;
  const close = (endUs: number) => {
    if (state !== null && endUs > segStart) {
      segments.push({ startUs: segStart, endUs, state });
    }
  };

  for (; i < ordered.length; i++) {
    const event = ordered[i];
    if (event.timestampUs >= maxUs) break; // transitions at/after window end don't split it
    const next = stateForKind(event.kind);
    if (next === state) continue; // no transition — keep the open segment
    close(event.timestampUs);
    state = next;
    segStart = event.timestampUs;
  }
  close(maxUs);
  return segments;
}

import { describe, it, expect } from 'vitest';
import {
  detectLifecycleKind,
  lastColdStartUs,
  lastForegroundUs,
  deriveAppStateSegments,
  appStateAt,
} from '../lifecycleEvents';
import type { LifecycleEvent, LifecycleEventKind } from '../../types/log.types';
import type { TimestampMicros } from '../../types/time.types';

/** Build a minimal lifecycle event for the aggregate-helper tests. */
function ev(kind: LifecycleEventKind, timestampUs: number): LifecycleEvent {
  return {
    kind,
    platform: 'ios',
    lineNumber: 1,
    timestampUs: timestampUs as TimestampMicros,
  };
}

describe('detectLifecycleKind', () => {
  it('detects iOS lifecycle transitions', () => {
    expect(detectLifecycleKind('2026-01-15T10:00:00Z INFO [matrix-rust-sdk] Application will resign active'))
      .toEqual({ kind: 'background', platform: 'ios' });
    expect(detectLifecycleKind('… Application did become active'))
      .toEqual({ kind: 'foreground', platform: 'ios' });
    expect(detectLifecycleKind('… Sentry configured (enabled: true)'))
      .toEqual({ kind: 'coldStart', platform: 'ios' });
    expect(detectLifecycleKind('… Sentry detected a crash in the previous run: abc123'))
      .toEqual({ kind: 'crash', platform: 'ios' });
    expect(detectLifecycleKind('… Started background app refresh'))
      .toEqual({ kind: 'backgroundRefreshStart', platform: 'ios' });
    expect(detectLifecycleKind('… Background app refresh finished'))
      .toEqual({ kind: 'backgroundRefreshEnd', platform: 'ios' });
  });

  it('detects Android lifecycle transitions (MainActivity-anchored)', () => {
    expect(detectLifecycleKind('… [android] MainActivity: onPause'))
      .toEqual({ kind: 'background', platform: 'android' });
    expect(detectLifecycleKind('… [android] MainActivity: onResume'))
      .toEqual({ kind: 'foreground', platform: 'android' });
    expect(detectLifecycleKind('… MainActivity: onCreate, with savedInstanceState: false'))
      .toEqual({ kind: 'coldStart', platform: 'android' });
    expect(detectLifecycleKind('… FATAL EXCEPTION main')).toEqual({ kind: 'crash', platform: 'android' });
    expect(detectLifecycleKind('… Uncaught exception: NullPointerException'))
      .toEqual({ kind: 'crash', platform: 'android' });
  });

  it('detects Element Web page load and presence changes', () => {
    expect(detectLifecycleKind('2026-09-29T15:36:15.377Z I Vector starting at https://app.element.io/'))
      .toEqual({ kind: 'coldStart', platform: 'web' });
    expect(detectLifecycleKind('2026-09-29T15:36:20.000Z D Presence: online'))
      .toEqual({ kind: 'foreground', platform: 'web' });
    expect(detectLifecycleKind('2026-09-29T15:39:20.000Z D Presence: unavailable'))
      .toEqual({ kind: 'background', platform: 'web' });
    expect(detectLifecycleKind('2026-10-03T07:04:59.426Z D element-web closing'))
      .toEqual({ kind: 'background', platform: 'web' });
  });

  it('returns null for non-lifecycle lines', () => {
    expect(detectLifecycleKind('… Sending a message to !room:example.org')).toBeNull();
    expect(detectLifecycleKind('… Initial sync complete: 42 rooms')).toBeNull();
  });

  it('does not match a bare token without its MainActivity anchor (false-positive guard)', () => {
    expect(detectLifecycleKind('… discussing the onResume callback in docs')).toBeNull();
  });

  it('returns null when the anchor token appears but no rule fully matches', () => {
    // Contains the "MainActivity" anchor (passes the cheap prefilter) but none of
    // the paired tokens (onCreate/onPause/onResume), so every rule's `every` check
    // fails and the scan falls through to null.
    expect(detectLifecycleKind('… MainActivity: onStart')).toBeNull();
  });
});

describe('lastColdStartUs', () => {
  it('returns null when there are no cold starts', () => {
    expect(lastColdStartUs([])).toBeNull();
    expect(lastColdStartUs([ev('background', 10), ev('crash', 20)])).toBeNull();
  });

  it('returns the single cold start timestamp', () => {
    expect(lastColdStartUs([ev('coldStart', 100)])).toBe(100);
  });

  it('returns the latest cold start by timestamp, not array order', () => {
    const events = [ev('coldStart', 500), ev('foreground', 600), ev('coldStart', 100)];
    expect(lastColdStartUs(events)).toBe(500);
  });
});

describe('lastForegroundUs', () => {
  it('returns null when the app never foregrounded', () => {
    expect(lastForegroundUs([])).toBeNull();
    expect(lastForegroundUs([ev('background', 10)])).toBeNull();
  });

  it('counts both a resume (foreground) and a launch (coldStart), latest wins', () => {
    // resume after cold start → the resume is the last foreground
    expect(lastForegroundUs([ev('coldStart', 100), ev('foreground', 900)])).toBe(900);
    // no resume → the launch itself is the last foreground
    expect(lastForegroundUs([ev('coldStart', 100), ev('background', 500)])).toBe(100);
  });
});

describe('deriveAppStateSegments', () => {
  it('segments a foreground → background → foreground sequence', () => {
    const events = [ev('coldStart', 0), ev('background', 50), ev('foreground', 80)];
    expect(deriveAppStateSegments(events, 0, 100)).toEqual([
      { startUs: 0, endUs: 50, state: 'foreground' },
      { startUs: 50, endUs: 80, state: 'background' },
      { startUs: 80, endUs: 100, state: 'foreground' },
    ]);
  });

  it('brackets a background refresh as a working span within a background span', () => {
    const events = [
      ev('background', 10),
      ev('backgroundRefreshStart', 20),
      ev('backgroundRefreshEnd', 40),
    ];
    expect(deriveAppStateSegments(events, 0, 60)).toEqual([
      { startUs: 10, endUs: 20, state: 'background' },
      { startUs: 20, endUs: 40, state: 'backgroundWorking' },
      { startUs: 40, endUs: 60, state: 'background' },
    ]);
  });

  it('leaves the pre-first-event region uncovered and ignores crash (retrospective)', () => {
    // crash must NOT terminate the state — it is the previous-run line at launch.
    const events = [ev('coldStart', 20), ev('crash', 60)];
    expect(deriveAppStateSegments(events, 0, 100)).toEqual([
      { startUs: 20, endUs: 100, state: 'foreground' },
    ]);
  });

  it('collapses repeated same-state events', () => {
    const events = [ev('background', 10), ev('background', 30), ev('foreground', 50)];
    expect(deriveAppStateSegments(events, 0, 60)).toEqual([
      { startUs: 10, endUs: 50, state: 'background' },
      { startUs: 50, endUs: 60, state: 'foreground' },
    ]);
  });

  it('carries in the state when the window has no in-window transitions', () => {
    // Zoomed window [50,150]: no event inside, but foreground was set at t=0.
    const events = [ev('foreground', 0), ev('background', 200)];
    expect(deriveAppStateSegments(events, 50, 150)).toEqual([
      { startUs: 50, endUs: 150, state: 'foreground' },
    ]);
  });

  it('carries in state and still applies an in-window transition', () => {
    const events = [ev('foreground', 0), ev('background', 100)];
    expect(deriveAppStateSegments(events, 50, 150)).toEqual([
      { startUs: 50, endUs: 100, state: 'foreground' },
      { startUs: 100, endUs: 150, state: 'background' },
    ]);
  });

  it('returns no segments when there are no events', () => {
    expect(deriveAppStateSegments([], 0, 100)).toEqual([]);
  });
});

describe('appStateAt', () => {
  const segments = [
    { startUs: 0, endUs: 50, state: 'foreground' as const },
    { startUs: 50, endUs: 80, state: 'background' as const },
    { startUs: 90, endUs: 120, state: 'backgroundWorking' as const },
  ];

  it('returns the state of the containing segment', () => {
    expect(appStateAt(segments, 30)).toBe('foreground');
    expect(appStateAt(segments, 50)).toBe('background'); // startUs inclusive
    expect(appStateAt(segments, 100)).toBe('backgroundWorking');
  });

  it('returns null outside any segment (gaps, before, after)', () => {
    expect(appStateAt(segments, 85)).toBeNull(); // gap between 80 and 90
    expect(appStateAt(segments, 120)).toBeNull(); // endUs exclusive
    expect(appStateAt([], 10)).toBeNull();
  });
});

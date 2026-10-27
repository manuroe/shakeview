/**
 * Pure chart math helpers extracted from useChartInteraction.
 *
 * Keeping these as standalone functions lets us unit-test coordinate math
 * and edge-snapping in isolation without setting up SVG mouse events or
 * the @visx/event dependency.
 */

import type { TimestampMicros } from '../types/time.types';

/**
 * Convert a pixel x-coordinate inside the chart area to a microsecond timestamp.
 *
 * @param x - Pixel offset from the left edge of the chart area (0 = left edge, xMax = right edge)
 * @param xMax - Total pixel width of the chart area
 * @param minTime - Timestamp (µs) represented by x = 0
 * @param maxTime - Timestamp (µs) represented by x = xMax
 * @returns Interpolated timestamp in microseconds
 */
export function xToTime(
  x: number,
  xMax: number,
  minTime: TimestampMicros,
  maxTime: TimestampMicros
): TimestampMicros {
  if (xMax <= 0) return minTime;
  const progress = x / xMax;
  const timeRange = maxTime - minTime;
  return (minTime + progress * timeRange) as TimestampMicros;
}

/**
 * Snap a raw selection range to the data edges when either boundary falls within
 * one bucket's time span of minTime / maxTime.
 *
 * This handles the common case where the user drags to the very first or last
 * visible bar but the computed time lands slightly inside the bucket boundary.
 *
 * @param rawStart - Unsnapped start timestamp (µs)
 * @param rawEnd   - Unsnapped end timestamp (µs)
 * @param minTime  - Minimum data timestamp (µs) — the left data edge
 * @param maxTime  - Maximum data timestamp (µs) — the right data edge
 * @param bucketTimeSpan - Duration of one bucket in microseconds
 * @returns [snappedStart, snappedEnd] pair with edges applied if within threshold
 */
export function snapToEdge(
  rawStart: TimestampMicros,
  rawEnd: TimestampMicros,
  minTime: TimestampMicros,
  maxTime: TimestampMicros,
  bucketTimeSpan: number
): [TimestampMicros, TimestampMicros] {
  const startTime =
    rawStart - minTime < bucketTimeSpan ? minTime : rawStart;
  const endTime =
    maxTime - rawEnd < bucketTimeSpan ? maxTime : rawEnd;
  return [startTime, endTime];
}

/**
 * Left margin of every time-axis chart, wide enough for the widest y-axis
 * labels ("976.6 KB"). Shared so stacked charts on a page start their time
 * axes at the same x and line up.
 */
export const CHART_MARGIN_LEFT = 60;

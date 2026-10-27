import { useMemo, useCallback } from 'react';
import type { TimestampMicros } from '../types/time.types';
import { MICROS_PER_SECOND, MICROS_PER_MILLISECOND } from '../types/time.types';
import { BaseActivityChart, type ActivityBucket } from './BaseActivityChart';
import {
  getBucketKey,
  getBucketColor,
  getBucketLabel,
  sortStatusCodes,
} from '../utils/httpStatusBuckets';
import { HttpConcurrencyChart } from './HttpConcurrencyChart';

import type { HttpRequestWithTimestamp, HttpRequestSpan, LifecycleEvent } from '../types/log.types';
// Re-exported so that existing consumers importing from this module are unaffected.
export type { HttpRequestWithTimestamp } from '../types/log.types';
export type { HttpRequestSpan } from '../types/log.types';

import type { SelectionRange } from '../hooks/useChartInteraction';

interface HttpActivityChartProps {
  httpRequests: readonly HttpRequestWithTimestamp[];
  /** Time range to use for the chart - must match LogActivityChart for alignment */
  timeRange: { minTime: TimestampMicros; maxTime: TimestampMicros };
  /**
   * Per-request time spans required by stepArea display mode.  Each entry
   * carries the start and end timestamp for one logical request so the chart
   * can compute how many requests overlap at each time bucket.
   */
  httpRequestSpans?: readonly HttpRequestSpan[];
  /**
   * `'histogram'` (default) — stacked bar chart; one bar segment per data point.
   * `'stepArea'` — stacked step-function area chart.
   */
  displayMode?: 'histogram' | 'stepArea';
  /** Callback when user selects a time range. Values are in microseconds. */
  onTimeRangeSelected?: (startUs: TimestampMicros, endUs: TimestampMicros) => void;
  onResetZoom?: () => void;
  /** Mirrored cursor time from a sibling chart (microseconds). */
  externalCursorTime?: number | null;
  /** Mirrored selection from a sibling chart. */
  externalSelection?: SelectionRange | null;
  /** Fired as the cursor moves across this chart. */
  onCursorMove?: (timeUs: number | null) => void;
  /** Fired as a drag selection changes on this chart. */
  onSelectionChange?: (selection: SelectionRange | null) => void;
  /** App-lifecycle events drawn as vertical markers. */
  markers?: readonly LifecycleEvent[];
}

interface HttpBucket extends ActivityBucket {
  /** Counts per individual status code (e.g., "200", "404", "500") */
  counts: Record<string, number>;
}


export function HttpActivityChart({
  httpRequests,
  timeRange,
  httpRequestSpans,
  displayMode = 'histogram',
  onTimeRangeSelected,
  onResetZoom,
  externalCursorTime,
  externalSelection,
  onCursorMove,
  onSelectionChange,
  markers,
}: HttpActivityChartProps) {
  // Helper to format timestamp as HH:MM:SS in UTC (converts from microseconds)
  const formatTime = useCallback((timestampUs: number): string => {
    const date = new Date(timestampUs / MICROS_PER_MILLISECOND);
    return date.toISOString().split('T')[1].split('.')[0]; // Gets HH:MM:SS in UTC
  }, []);

  const chartData = useMemo(() => {
    // In stepArea mode the histogram is not rendered; skip expensive bucketing.
    if (displayMode === 'stepArea') {
      return {
        buckets: [] as HttpBucket[],
        maxCount: 0,
        minTime: timeRange.minTime,
        maxTime: timeRange.maxTime,
        statusCodes: [] as string[],
      };
    }

    const { minTime, maxTime } = timeRange;

    if (minTime === 0 && maxTime === 0) {
      return {
        buckets: [] as HttpBucket[],
        maxCount: 0,
        minTime: 0 as TimestampMicros,
        maxTime: 0 as TimestampMicros,
        statusCodes: [] as string[],
      };
    }

    const dataTimeRange = maxTime - minTime;

    // Calculate bucket size to display ~100 bars (in microseconds)
    // Must match LogActivityChart's bucket calculation for alignment
    const targetBars = 100;
    let bucketSize = MICROS_PER_SECOND; // Start with 1 second
    if (dataTimeRange > 0) {
      bucketSize = Math.max(MICROS_PER_SECOND, Math.ceil(dataTimeRange / targetBars));
    }

    // Track all unique status codes
    const allStatusCodes = new Set<string>();

    // Create buckets for the entire time range
    const bucketMap = new Map<number, HttpBucket>();

    // Initialize all buckets in the time range
    const firstBucketKey = Math.floor(minTime / bucketSize) * bucketSize;
    const lastBucketKey = Math.floor(maxTime / bucketSize) * bucketSize;

    for (let bucketKey = firstBucketKey; bucketKey <= lastBucketKey; bucketKey += bucketSize) {
      bucketMap.set(bucketKey, {
        timestamp: bucketKey,
        timeLabel: formatTime(bucketKey),
        counts: {},
        total: 0,
      });
    }

    // Fill buckets with HTTP request data
    httpRequests.forEach((req) => {
      const time = req.timestampUs;
      const bucketKey = Math.floor(time / bucketSize) * bucketSize;

      const bucket = bucketMap.get(bucketKey);
      if (bucket) {
        // Resolve to bucket key (sync subtypes get synthetic keys)
        const statusCode = getBucketKey(req);
        allStatusCodes.add(statusCode);
        bucket.counts[statusCode] = (bucket.counts[statusCode] || 0) + 1;
        bucket.total++;
      }
    });

    // Convert to sorted array
    const dataBuckets = Array.from(bucketMap.values()).sort((a, b) => a.timestamp - b.timestamp);
    const dataMaxCount = Math.max(...dataBuckets.map((b) => b.total), 1);

    // Sort status codes: 5xx first (top of stack), then 4xx, 3xx, 2xx, incomplete last
    const sortedStatusCodes = sortStatusCodes(Array.from(allStatusCodes));

    return { buckets: dataBuckets, maxCount: dataMaxCount, minTime, maxTime, statusCodes: sortedStatusCodes };
  }, [displayMode, httpRequests, timeRange, formatTime]);

  const getCategoryColor = useCallback((code: string) => getBucketColor(code), []);

  const getCategoryCount = useCallback((bucket: HttpBucket, code: string) => bucket.counts[code] || 0, []);

  const renderTooltipContent = useCallback(
    (bucket: HttpBucket) => (
      <>
        {[...chartData.statusCodes].reverse().map((code) => {
          const count = bucket.counts[code] || 0;
          if (count === 0) return null;
          return (
            <div key={code} style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '1px' }}>
              <span
                style={{
                  display: 'inline-block',
                  width: '6px',
                  height: '6px',
                  backgroundColor: getBucketColor(code),
                  borderRadius: '1px',
                }}
              />
              <span style={{ fontSize: '10px' }}>
                {getBucketLabel(code)}: {count}
              </span>
            </div>
          );
        })}
        <div style={{ marginTop: '2px', paddingTop: '2px', borderTop: '1px solid #555', fontSize: '10px' }}>
          Total: {bucket.total}
        </div>
      </>
    ),
    [chartData.statusCodes]
  );

  // stepArea mode: delegate to the step-function area chart.
  if (displayMode === 'stepArea') {
    return (
      <HttpConcurrencyChart
        httpRequestSpans={httpRequestSpans ?? []}
        timeRange={timeRange}
        onTimeRangeSelected={onTimeRangeSelected}
        onResetZoom={onResetZoom}
        externalCursorTime={externalCursorTime}
        externalSelection={externalSelection}
        onCursorMove={onCursorMove}
        onSelectionChange={onSelectionChange}
        markers={markers}
      />
    );
  }

  if (httpRequests.length === 0) {
    return (
      <div className="chart-empty" style={{ padding: '20px', textAlign: 'center', color: '#666' }}>
        No HTTP request data to display
      </div>
    );
  }

  return (
    <BaseActivityChart
      buckets={chartData.buckets}
      maxCount={chartData.maxCount}
      minTime={chartData.minTime}
      maxTime={chartData.maxTime}
      categories={chartData.statusCodes}
      getCategoryColor={getCategoryColor}
      getCategoryCount={getCategoryCount}
      renderTooltipContent={renderTooltipContent}
      onTimeRangeSelected={onTimeRangeSelected}
      onResetZoom={onResetZoom}
      emptyMessage="No HTTP request data to display"
      externalCursorTime={externalCursorTime}
      externalSelection={externalSelection}
      onCursorMove={onCursorMove}
      onSelectionChange={onSelectionChange}
      markers={markers}
    />
  );
}

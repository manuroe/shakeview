import { useMemo, useCallback } from 'react';
import type { TimestampMicros } from '../types/time.types';
import { MICROS_PER_SECOND, MICROS_PER_MILLISECOND } from '../types/time.types';
import type { BandwidthRequestEntry, BandwidthRequestSpan, LifecycleEvent } from '../types/log.types';
import { renderBandwidthTooltip, type BandwidthBucket } from './BandwidthChartTooltip';
import type { SelectionRange } from '../hooks/useChartInteraction';
import { BandwidthConcurrencyChart } from './BandwidthConcurrencyChart';
import { BandwidthHistogramChart } from './BandwidthHistogramChart';
import { getBucketKey, sortStatusCodes } from '../utils/httpStatusBuckets';

interface BandwidthChartProps {
  /** Bandwidth data points to chart, one per HTTP request. */
  requests: readonly BandwidthRequestEntry[];
  /** Request spans used by in-flight mode to build step-function stacked areas. */
  bandwidthRequestSpans?: readonly BandwidthRequestSpan[];
  /** Histogram = stacked bar chart; stepArea = stacked step-function area chart. */
  displayMode?: 'histogram' | 'stepArea';
  /**
   * Time range for the chart — should match the sibling activity charts
   * (LogActivityChart, HttpActivityChart) so that all three are aligned.
   */
  timeRange: { readonly minTime: TimestampMicros; readonly maxTime: TimestampMicros };
  /** Callback when user drag-selects a time range. Values are in microseconds. */
  onTimeRangeSelected?: (startUs: TimestampMicros, endUs: TimestampMicros) => void;
  /** Callback when user double-clicks to reset zoom. */
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

/**
 * Bandwidth chart component.
 *
 * Plots HTTP bandwidth (upload and download bytes) as a **mirrored diverging bar chart**:
 * upload bytes (sent) stack **above** the zero line; download bytes (received) stack
 * **below** it.  Each direction is broken down by HTTP status bucket and coloured with
 * the same palette as `HttpActivityChart`, giving a coherent cross-chart colour language.
 *
 * Data is aggregated into ~100 time buckets matching the `HttpActivityChart` resolution so
 * bandwidth peaks align with request-count peaks when both charts are displayed together
 * in `SummaryView`.
 *
 * @example
 * <BandwidthChart
 *   requests={stats.httpRequestsWithBandwidth}
 *   timeRange={stats.chartTimeRange}
 *   onTimeRangeSelected={handleTimeRangeSelected}
 *   onResetZoom={handleResetZoom}
 * />
 */
export function BandwidthChart({
  requests,
  bandwidthRequestSpans,
  displayMode = 'histogram',
  timeRange,
  onTimeRangeSelected,
  onResetZoom,
  externalCursorTime,
  externalSelection,
  onCursorMove,
  onSelectionChange,
  markers,
}: BandwidthChartProps) {
  const formatTime = useCallback((timestampUs: number): string => {
    const date = new Date(timestampUs / MICROS_PER_MILLISECOND);
    return date.toISOString().split('T')[1].split('.')[0]; // HH:MM:SS in UTC
  }, []);

  const chartData = useMemo(() => {
    // In stepArea mode the bandwidth histogram is not rendered; skip expensive bucketing.
    if (displayMode === 'stepArea') {
      return {
        buckets: [] as BandwidthBucket[],
        maxDownload: 0,
        maxUpload: 0,
        statusKeys: [] as string[],
        minTime: timeRange.minTime,
        maxTime: timeRange.maxTime,
      };
    }

    const { minTime, maxTime } = timeRange;

    if (minTime === 0 && maxTime === 0) {
      return {
        buckets: [] as BandwidthBucket[],
        maxDownload: 0,
        maxUpload: 0,
        statusKeys: [] as string[],
        minTime: 0 as TimestampMicros,
        maxTime: 0 as TimestampMicros,
      };
    }

    // Use the same bucket resolution as HttpActivityChart (~100 bars) so that
    // the two charts are visually aligned when compared side-by-side.
    const dataTimeRange = maxTime - minTime;
    const targetBars = 100;
    let bucketSize = MICROS_PER_SECOND;
    if (dataTimeRange > 0) {
      bucketSize = Math.max(MICROS_PER_SECOND, Math.ceil(dataTimeRange / targetBars));
    }

    // Initialise all bucket slots up-front so empty buckets appear as zero-height
    // bars, keeping the time axis continuous.
    const bucketMap = new Map<number, BandwidthBucket>();
    const firstBucketKey = Math.floor(minTime / bucketSize) * bucketSize;
    const lastBucketKey = Math.floor(maxTime / bucketSize) * bucketSize;
    for (let k = firstBucketKey; k <= lastBucketKey; k += bucketSize) {
      bucketMap.set(k, {
        timestamp: k,
        timeLabel: formatTime(k),
        total: 0,
        totalDownload: 0,
        totalUpload: 0,
        downloadByStatus: {},
        uploadByStatus: {},
      });
    }

    const allStatusKeys = new Set<string>();

    for (const req of requests) {
      const k = Math.floor(req.timestampUs / bucketSize) * bucketSize;
      const bucket = bucketMap.get(k);
      if (bucket) {
        const statusKey = getBucketKey({ status: req.status, timeout: req.timeout });
        allStatusKeys.add(statusKey);
        bucket.downloadByStatus[statusKey] =
          (bucket.downloadByStatus[statusKey] ?? 0) + req.downloadBytes;
        bucket.uploadByStatus[statusKey] =
          (bucket.uploadByStatus[statusKey] ?? 0) + req.uploadBytes;
        bucket.totalDownload += req.downloadBytes;
        bucket.totalUpload += req.uploadBytes;
        bucket.total += req.downloadBytes + req.uploadBytes;
      }
    }

    const dataBuckets = Array.from(bucketMap.values()).sort((a, b) => a.timestamp - b.timestamp);
    const maxDownload = Math.max(...dataBuckets.map((b) => b.totalDownload), 1);
    const maxUpload = Math.max(...dataBuckets.map((b) => b.totalUpload), 1);
    const statusKeys = sortStatusCodes(Array.from(allStatusKeys));

    return { buckets: dataBuckets, maxDownload, maxUpload, statusKeys, minTime, maxTime };
  }, [displayMode, requests, timeRange, formatTime]);

  const renderTooltipContent = useCallback(
    (bucket: BandwidthBucket) => renderBandwidthTooltip(bucket),
    [],
  );

  if (displayMode === 'stepArea') {
    return (
      <BandwidthConcurrencyChart
        bandwidthRequestSpans={bandwidthRequestSpans ?? []}
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

  if (requests.length === 0) {
    return (
      <div className="chart-empty" style={{ padding: '20px', textAlign: 'center', color: '#666' }}>
        No bandwidth data to display
      </div>
    );
  }

  return (
    <BandwidthHistogramChart
      buckets={chartData.buckets}
      maxDownload={chartData.maxDownload}
      maxUpload={chartData.maxUpload}
      statusKeys={chartData.statusKeys}
      minTime={chartData.minTime}
      maxTime={chartData.maxTime}
      renderTooltipContent={renderTooltipContent}
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

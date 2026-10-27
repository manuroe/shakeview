import { useMemo, useCallback } from 'react';
import type { ParsedLogLine, LogLevel, SentryEvent, LifecycleEvent } from '../types/log.types';
import type { TimestampMicros } from '../types/time.types';
import { MICROS_PER_SECOND, MICROS_PER_MILLISECOND } from '../types/time.types';
import { getMinMaxTimestamps } from '../utils/timeUtils';
import { BaseActivityChart, type ActivityBucket, type ActivityLane, type ActivityLaneSegment } from './BaseActivityChart';
import type { SelectionRange } from '../hooks/useChartInteraction';
import { useLogStore } from '../stores/logStore';
import { buildProcessColorMap, processOf, APP_LANE_COLOR, CONSOLE_PROCESS } from '../utils/processColors';
import { deriveAppStateSegments, appStateColors, APP_STATE_LABEL } from '../utils/lifecycleEvents';
import { bucketActivityRuns } from '../utils/activityLanes';

interface LogActivityChartProps {
  logLines: readonly ParsedLogLine[];
  sentryEvents?: readonly SentryEvent[];
  /** App-lifecycle events: coldStart/crash render as vertical markers; the
   * others drive the app-state band merged into the console lane. */
  markers?: readonly LifecycleEvent[];
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
}

type ChartCategory = LogLevel | 'SENTRY';

interface LogBucket extends ActivityBucket {
  counts: Record<ChartCategory, number>;
}

const LOG_LEVEL_COLORS: Record<ChartCategory, string> = {
  TRACE: 'var(--log-level-trace)',
  DEBUG: 'var(--log-level-debug)',
  INFO: 'var(--log-level-info)',
  WARN: 'var(--log-level-warn)',
  ERROR: 'var(--log-level-error)',
  UNKNOWN: 'var(--log-level-unknown)',
  SENTRY: 'var(--color-sentry)',
};

const LOG_LEVEL_ORDER: ChartCategory[] = ['SENTRY', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE', 'UNKNOWN'];

export function LogActivityChart({ logLines, sentryEvents, markers, onTimeRangeSelected, onResetZoom, externalCursorTime, externalSelection, onCursorMove, onSelectionChange }: LogActivityChartProps) {
  // Helper to format timestamp as HH:MM:SS in UTC (converts from microseconds)
  const formatTime = useCallback((timestampUs: number): string => {
    const date = new Date(timestampUs / MICROS_PER_MILLISECOND);
    return date.toISOString().split('T')[1].split('.')[0]; // Gets HH:MM:SS in UTC
  }, []);

  const chartData = useMemo(() => {
    if (logLines.length === 0) {
      return { buckets: [] as LogBucket[], maxCount: 0, minTime: 0 as TimestampMicros, maxTime: 0 as TimestampMicros };
    }

    const sentryLineNumbers = new Set((sentryEvents ?? []).map(e => e.lineNumber));

    // Find time range (all in microseconds) via getMinMaxTimestamps, which
    // skips lines with timestampUs <= 0 (orphaned continuation lines that appear
    // before the first timestamped entry) and avoids Math.min/max spread that
    // can throw on very large arrays.
    const { min: dataMinTime, max: dataMaxTime } = getMinMaxTimestamps(logLines);

    if (dataMinTime === 0 && dataMaxTime === 0) {
      return { buckets: [] as LogBucket[], maxCount: 0, minTime: 0 as TimestampMicros, maxTime: 0 as TimestampMicros };
    }
    const timeRange = dataMaxTime - dataMinTime;

    // Calculate bucket size to display ~100 bars (in microseconds)
    const targetBars = 100;
    let bucketSize = MICROS_PER_SECOND; // Start with 1 second
    if (timeRange > 0) {
      bucketSize = Math.max(MICROS_PER_SECOND, Math.ceil(timeRange / targetBars));
    }

    // Create buckets for the entire time range
    const bucketMap = new Map<number, LogBucket>();

    // Initialize all buckets in the time range
    const firstBucketKey = Math.floor(dataMinTime / bucketSize) * bucketSize;
    const lastBucketKey = Math.floor(dataMaxTime / bucketSize) * bucketSize;

    for (let bucketKey = firstBucketKey; bucketKey <= lastBucketKey; bucketKey += bucketSize) {
      bucketMap.set(bucketKey, {
        timestamp: bucketKey,
        timeLabel: formatTime(bucketKey),
        counts: {
          TRACE: 0,
          DEBUG: 0,
          INFO: 0,
          WARN: 0,
          ERROR: 0,
          UNKNOWN: 0,
          SENTRY: 0,
        },
        total: 0,
      });
    }

    // Fill buckets with log data; Sentry lines get their own category
    logLines.forEach((line) => {
      const bucketKey = Math.floor(line.timestampUs / bucketSize) * bucketSize;
      const bucket = bucketMap.get(bucketKey);
      if (bucket) {
        const category: ChartCategory = sentryLineNumbers.has(line.lineNumber) ? 'SENTRY' : line.level;
        bucket.counts[category]++;
        bucket.total++;
      }
    });

    // Convert to sorted array
    const dataBuckets = Array.from(bucketMap.values()).sort((a, b) => a.timestamp - b.timestamp);
    const dataMaxCount = Math.max(...dataBuckets.map((b) => b.total));

    return { buckets: dataBuckets, maxCount: dataMaxCount, minTime: dataMinTime, maxTime: dataMaxTime };
  }, [logLines, sentryEvents, formatTime]);

  // Per-process "is this process logging, when" lanes, shown under the bars
  // only when several processes are merged (e.g. console + nse). Reuses the same
  // colour map as the line stripes / request rows.
  const loadedEntryNames = useLogStore((state) => state.loadedEntryNames);
  const processColorMap = useMemo(() => buildProcessColorMap(loadedEntryNames), [loadedEntryNames]);
  // Full (unfiltered) lifecycle events for the state band: the band needs the
  // state carried in from before the visible window, which the time-filtered
  // `markers` prop (used only for the in-window vertical lines) does not have.
  const allLifecycleEvents = useLogStore((state) => state.lifecycleEvents);

  const lanes = useMemo<ActivityLane[] | undefined>(() => {
    if (logLines.length === 0) return undefined;
    const { min, max } = getMinMaxTimestamps(logLines);
    // getMinMaxTimestamps returns 0/0 only when no line has a positive timestamp.
    if (max === 0) return undefined;
    const range = max - min;
    const bucketSize = range > 0 ? Math.max(MICROS_PER_SECOND, Math.ceil(range / 100)) : MICROS_PER_SECOND;

    // Group positive log timestamps by process in one pass; also keep the full
    // set for the app lane's activity when there is no distinct console stream.
    const tsByProcess = new Map<string, number[]>();
    const allTsUs: number[] = [];
    for (const line of logLines) {
      if (line.timestampUs <= 0) continue;
      allTsUs.push(line.timestampUs);
      if (!line.sourceFile) continue;
      const proc = processOf(line.sourceFile);
      let arr = tsByProcess.get(proc);
      if (!arr) {
        arr = [];
        tsByProcess.set(proc, arr);
      }
      arr.push(line.timestampUs);
    }

    const stateSegments = deriveAppStateSegments(allLifecycleEvents, min, max);
    const hasState = stateSegments.length > 0;
    const built: ActivityLane[] = [];

    // App-state lane — only when lifecycle state exists. Merged into the console
    // stream (on iOS the console process is the main app): draw a bar wherever
    // the app logged, coloured by the state at that moment. Silence is left
    // empty (idle); no background track so gaps don't read as a state.
    //
    // App-stream activity: the console stream when present; else the whole log
    // for a single-process (or untagged) log; else — a multi-process log with no
    // console — there is no identifiable app stream, so skip the lane rather than
    // let a non-app process (e.g. nse) drive it. Mirrors makeRowStripeColorer.
    const appActivityTs =
      tsByProcess.get(CONSOLE_PROCESS) ?? (processColorMap.size > 1 ? null : allTsUs);
    if (hasState && appActivityTs) {
      const appRuns = bucketActivityRuns(appActivityTs, min, max, bucketSize);
      const stateColor = appStateColors(APP_LANE_COLOR);
      const appSegments: ActivityLaneSegment[] = [];
      for (const seg of stateSegments) {
        for (const run of appRuns) {
          const s = Math.max(run.startUs, seg.startUs);
          const e = Math.min(run.endUs, seg.endUs);
          if (e < s) continue; // no overlap
          // Zero-width intersection (e === s): keep it only for a genuine
          // single-point run strictly inside the segment (an isolated log line,
          // which BaseActivityChart still draws as a 1px bar). Drop pure boundary
          // touches — a run ending exactly at a segment edge — which would
          // otherwise render as a phantom 1px bar at every state transition.
          if (e === s && (s === seg.startUs || s === seg.endUs)) continue;
          appSegments.push({
            startUs: s,
            endUs: e,
            color: stateColor[seg.state],
            title: `${APP_STATE_LABEL[seg.state]} · ${formatTime(s)}–${formatTime(e)}`,
          });
        }
      }
      if (appSegments.length > 0) {
        built.push({ label: 'app', color: 'var(--border-light)', segments: appSegments, showTrack: false });
      }
    }

    // Per-process presence lanes (multi-process logs only). When the app-state
    // lane is present it represents the console stream, so console is skipped;
    // otherwise console is shown here as a plain presence lane (original view).
    if (processColorMap.size > 1) {
      for (const [proc, color] of processColorMap) {
        if (hasState && proc === CONSOLE_PROCESS) continue;
        const runs = bucketActivityRuns(tsByProcess.get(proc) ?? [], min, max, bucketSize);
        const segments: ActivityLaneSegment[] = runs.map((r) => ({
          startUs: r.startUs,
          endUs: r.endUs,
          title: `${proc} · ${formatTime(r.startUs)}–${formatTime(r.endUs)} · ${r.count} lines`,
        }));
        built.push({ label: proc, color, segments });
      }
    }

    return built.length > 0 ? built : undefined;
  }, [allLifecycleEvents, logLines, processColorMap, formatTime]);

  const getCategoryColor = useCallback((level: ChartCategory) => LOG_LEVEL_COLORS[level], []);

  const getCategoryCount = useCallback((bucket: LogBucket, level: ChartCategory) => bucket.counts[level], []);

  const renderTooltipContent = useCallback(
    (bucket: LogBucket) => (
      <>
        {LOG_LEVEL_ORDER.map((level) => {
          const count = bucket.counts[level];
          if (count === 0) return null;
          return (
            <div key={level} style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '1px' }}>
              <span
                style={{
                  display: 'inline-block',
                  width: '6px',
                  height: '6px',
                  backgroundColor: LOG_LEVEL_COLORS[level],
                  borderRadius: '1px',
                }}
              />
              <span style={{ fontSize: '10px' }}>
                {level === 'SENTRY' ? 'Sentry' : level}: {count}
              </span>
            </div>
          );
        })}
        <div style={{ marginTop: '2px', paddingTop: '2px', borderTop: '1px solid #555', fontSize: '10px' }}>
          Total: {bucket.total}
        </div>
      </>
    ),
    []
  );

  return (
    <BaseActivityChart
      buckets={chartData.buckets}
      maxCount={chartData.maxCount}
      minTime={chartData.minTime}
      maxTime={chartData.maxTime}
      categories={LOG_LEVEL_ORDER}
      getCategoryColor={getCategoryColor}
      getCategoryCount={getCategoryCount}
      renderTooltipContent={renderTooltipContent}
      onTimeRangeSelected={onTimeRangeSelected}
      onResetZoom={onResetZoom}
      emptyMessage="No log data to display"
      externalCursorTime={externalCursorTime}
      externalSelection={externalSelection}
      onCursorMove={onCursorMove}
      onSelectionChange={onSelectionChange}
      lanes={lanes}
      markers={markers}
    />
  );
}

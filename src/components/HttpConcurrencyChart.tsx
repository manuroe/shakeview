import { useMemo, useCallback } from 'react';
import { Group } from '@visx/group';
import { Area, Line } from '@visx/shape';
import { scaleLinear } from '@visx/scale';
import { AxisBottom, AxisLeft } from '@visx/axis';
import { useTooltip } from '@visx/tooltip';
import { curveStepAfter } from 'd3-shape';
import type { TimestampMicros } from '../types/time.types';
import { MICROS_PER_MILLISECOND } from '../types/time.types';
import type { HttpRequestSpan, LifecycleEvent } from '../types/log.types';
import type { SelectionRange } from '../hooks/useChartInteraction';
import { LifecycleMarkers } from './LifecycleMarkers';
import { computeStepPoints, getCountAtTime } from '../utils/concurrencyUtils';
import { getBucketKey, getBucketColor, getBucketLabel, sortStatusCodes } from '../utils/httpStatusBuckets';
import { useStepChartInteraction } from '../hooks/useStepChartInteraction';
import { useElementWidth } from '../hooks/useElementWidth';

// Re-export for consumers that need the type alongside the component.
export type { StepPoint } from '../utils/concurrencyUtils';

interface HttpConcurrencyChartProps {
  /** Per-request time spans, each with precise start/end timestamps. */
  httpRequestSpans: readonly HttpRequestSpan[];
  /** Time range that defines the chart's x-axis domain, shared with sibling charts. */
  timeRange: { minTime: TimestampMicros; maxTime: TimestampMicros };
  /** Callback when user drag-selects a time range. */
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
  /** App-lifecycle events drawn as full-height vertical markers. */
  markers?: readonly LifecycleEvent[];
  /** Chart height in pixels. */
  height?: number;
}

interface TooltipStatusCount {
  readonly key: string;
  readonly count: number;
}

interface TooltipData {
  readonly timeUs: number;
  readonly total: number;
  /** Per-status counts in display order (reversed from stack order so highest is first). */
  readonly statusCounts: readonly TooltipStatusCount[];
}


const SVG_WIDTH = 800;
const MARGIN = { top: 10, right: 10, bottom: 30, left: 50 };

/**
 * Step-function area chart for the "Show in-flight" concurrent mode on the /summary screen.
 *
 * Unlike the bar histogram, this chart uses the precise `startUs`/`endUs` timestamps
 * from `HttpRequestSpan` to compute an exact concurrency waveform — no bucketing
 * approximation.  The area rises exactly when a request begins and drops exactly when
 * it completes.
 */
export function HttpConcurrencyChart({
  httpRequestSpans,
  timeRange,
  onTimeRangeSelected,
  onResetZoom,
  externalCursorTime,
  externalSelection,
  onCursorMove,
  onSelectionChange,
  markers,
  height = 120,
}: HttpConcurrencyChartProps) {
  const { minTime, maxTime } = timeRange;

  const [widthRef, svgWidth] = useElementWidth(SVG_WIDTH);
  const xMax = svgWidth - MARGIN.left - MARGIN.right;
  const yMax = height - MARGIN.top - MARGIN.bottom;

  // ── Step-function data preparation ───────────────────────────────────────
  /** Total concurrency at each event boundary — used for y-scale domain. */
  const stepPoints = useMemo(
    () => computeStepPoints(httpRequestSpans, minTime, maxTime),
    [httpRequestSpans, minTime, maxTime],
  );

  /** Ordered status-bucket keys derived from the spans (same ordering as bar mode). */
  const orderedKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const span of httpRequestSpans) keys.add(getBucketKey(span));
    return sortStatusCodes(Array.from(keys));
  }, [httpRequestSpans]);

  /** Per-key step points for each status bucket. */
  const stepPointsByKey = useMemo(() => {
    const map = new Map<string, ReturnType<typeof computeStepPoints>>();
    const grouped = new Map<string, typeof httpRequestSpans[number][]>();
    for (const key of orderedKeys) grouped.set(key, []);
    for (const span of httpRequestSpans) {
      const k = getBucketKey(span);
      grouped.get(k)?.push(span);
    }
    for (const key of orderedKeys) {
      map.set(key, computeStepPoints(grouped.get(key) ?? [], minTime, maxTime));
    }
    return map;
  }, [orderedKeys, httpRequestSpans, minTime, maxTime]);

  /**
   * Unified timeline merging all per-key event boundaries.
   * Each point carries the cumulative `y0` and `y1` for every key so that
   * each `Area` layer can be rendered independently without re-scanning.
   */
  const stackedLayers = useMemo(() => {
    // Collect every time breakpoint from all key series.
    const allTimes = new Set([minTime, maxTime]);
    for (const pts of stepPointsByKey.values()) {
      for (const p of pts) allTimes.add(p.timeUs);
    }
    const sortedTimes = Array.from(allTimes).sort((a, b) => a - b);

    // Precompute per-key counts at each time in `sortedTimes` once (O(keys × times)).
    const countsByKey = new Map<string, number[]>();
    for (const key of orderedKeys) {
      const pts = stepPointsByKey.get(key) ?? [];
      const counts: number[] = [];
      for (const timeUs of sortedTimes) {
        counts.push(getCountAtTime(pts, timeUs));
      }
      countsByKey.set(key, counts);
    }

    // Build stacked layers using cumulative prefix sums so each key's y0/y1
    // is derived in O(keys × times) instead of O(keys² × times).
    const cumulativeAtTime = new Array<number>(sortedTimes.length).fill(0);

    return orderedKeys.map((key) => {
      const counts = countsByKey.get(key) ?? [];
      const points = sortedTimes.map((timeUs, idx) => {
        const y0 = cumulativeAtTime[idx];
        const countHere = counts[idx] ?? 0;
        const y1 = y0 + countHere;
        cumulativeAtTime[idx] = y1;
        return { timeUs, y0, y1 };
      });
      return {
        key,
        color: getBucketColor(key),
        points,
      };
    });
  }, [orderedKeys, stepPointsByKey, minTime, maxTime]);

  const maxCount = useMemo(
    () => Math.max(...stepPoints.map((p) => p.count), 1),
    [stepPoints],
  );

  const xScale = useMemo(
    () =>
      scaleLinear<number>({
        domain: [minTime, maxTime],
        range: [0, xMax],
        clamp: true,
      }),
    [minTime, maxTime, xMax],
  );

  const yScale = useMemo(
    () =>
      scaleLinear<number>({
        domain: [0, maxCount],
        range: [yMax, 0],
        nice: true,
      }),
    [maxCount, yMax],
  );

  const formatTime = useCallback((timestampUs: number): string => {
    const date = new Date(timestampUs / MICROS_PER_MILLISECOND);
    return date.toISOString().split('T')[1].split('.')[0];
  }, []);

  // ── Tooltip ──────────────────────────────────────────────────────────────
  const { tooltipData, tooltipLeft, tooltipTop, showTooltip, hideTooltip } =
    useTooltip<TooltipData>();

  // ── Interaction ─────────────────────────────────────────────────────────
  /** Returns tooltip data at the given chart timestamp; chart-specific logic. */
  const getTooltipData = useCallback(
    (timeUs: number): TooltipData => {
      const total = getCountAtTime(stepPoints, timeUs);
      const statusCounts = [...orderedKeys]
        .reverse()
        .map((key) => ({ key, count: getCountAtTime(stepPointsByKey.get(key) ?? [], timeUs) }))
        .filter((s) => s.count > 0);
      return { timeUs, total, statusCounts };
    },
    [stepPoints, orderedKeys, stepPointsByKey],
  );

  const {
    svgRef,
    cursorX,
    cursorTimeUs,
    isSelecting,
    selectionStart,
    selectionEnd,
    timeToX,
    handleMouseMove,
    handleMouseDown,
    handleMouseUp,
    handleMouseLeave,
    handleDoubleClick,
    hasExternalSelection,
  } = useStepChartInteraction({
    xMax,
    svgWidth: svgWidth,
    marginLeft: MARGIN.left,
    minTime,
    maxTime,
    externalCursorTime,
    externalSelection,
    onCursorMove,
    onSelectionChange,
    onTimeRangeSelected,
    onResetZoom,
    getTooltipData,
    showTooltip,
    hideTooltip,
  });

  // ── Empty state ────────────────────────────────────────────────────────────
  if (stepPoints.length === 0) {
    return (
      <div className="chart-empty" style={{ padding: '20px', textAlign: 'center', color: '#666' }}>
        No in-flight request data to display
      </div>
    );
  }

  const activeCursorX = cursorX !== undefined ? cursorX - MARGIN.left : undefined;
  const activeCursorTime = cursorTimeUs !== undefined ? formatTime(cursorTimeUs) : undefined;

  return (
    <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
      <div ref={widthRef} style={{ flex: 1, minWidth: 0 }}>
        <svg
          ref={svgRef}
          width="100%"
          height={height}
          viewBox={`0 0 ${svgWidth} ${height}`}
          style={{ display: 'block' }}
        >
          <Group left={MARGIN.left} top={MARGIN.top}>
            {/* Stacked area fills — one layer per status bucket (bottom to top) */}
            {stackedLayers.map((layer) => (
              <Area
                key={layer.key}
                data={layer.points}
                x={(d) => xScale(d.timeUs)}
                y1={(d) => yScale(d.y1)}
                y0={(d) => yScale(d.y0)}
                curve={curveStepAfter}
                fill={layer.color}
                fillOpacity={0.7}
              />
            ))}

            {/* Axes */}
            <AxisBottom
              top={yMax}
              scale={xScale}
              tickFormat={() => ''}
              stroke="#666"
              tickStroke="#666"
            />
            <AxisLeft
              scale={yScale}
              stroke="#666"
              tickStroke="#666"
              numTicks={4}
              tickLabelProps={() => ({
                fill: '#666',
                fontSize: 11,
                textAnchor: 'end',
                dx: -4,
              })}
            />

            {/* Start/end time labels */}
            <text x={0} y={yMax + 16} textAnchor="start" fontSize={10} fill="#666" pointerEvents="none">
              {formatTime(minTime)}
            </text>
            <text x={xMax} y={yMax + 16} textAnchor="end" fontSize={10} fill="#666" pointerEvents="none">
              {formatTime(maxTime)}
            </text>

            {/* Invisible overlay for mouse events */}
            <rect
              width={xMax}
              height={yMax}
              fill="transparent"
              onMouseDown={handleMouseDown}
              onMouseUp={handleMouseUp}
              onMouseMove={handleMouseMove}
              onDoubleClick={handleDoubleClick}
              onMouseLeave={handleMouseLeave}
              style={{ cursor: isSelecting ? 'col-resize' : 'crosshair' }}
            />

            {/* App-lifecycle markers */}
            <LifecycleMarkers markers={markers} timeToX={timeToX} bottomY={yMax} />

            {/* Selection: two cursor lines + highlighted band */}
            {isSelecting && selectionStart && selectionEnd && (
              <>
                <rect
                  x={Math.min(selectionStart.x, selectionEnd.x) - MARGIN.left}
                  y={0}
                  width={Math.abs(selectionEnd.x - selectionStart.x)}
                  height={yMax}
                  fill="var(--color-primary)"
                  fillOpacity={0.2}
                  pointerEvents="none"
                />
                <Line
                  from={{ x: selectionStart.x - MARGIN.left, y: 0 }}
                  to={{ x: selectionStart.x - MARGIN.left, y: yMax }}
                  stroke="var(--color-primary)"
                  strokeWidth={2}
                  pointerEvents="none"
                />
                <Line
                  from={{ x: selectionEnd.x - MARGIN.left, y: 0 }}
                  to={{ x: selectionEnd.x - MARGIN.left, y: yMax }}
                  stroke="var(--color-primary)"
                  strokeWidth={2}
                  pointerEvents="none"
                />
                <text x={selectionStart.x - MARGIN.left} y={yMax + 20} textAnchor="middle" fontSize={11} fill="var(--color-primary)" fontWeight="bold" pointerEvents="none">
                  {formatTime(selectionStart.time)}
                </text>
                <text x={selectionEnd.x - MARGIN.left} y={yMax + 20} textAnchor="middle" fontSize={11} fill="var(--color-primary)" fontWeight="bold" pointerEvents="none">
                  {formatTime(selectionEnd.time)}
                </text>
              </>
            )}

            {/* Local cursor line + time label */}
            {!isSelecting && activeCursorX !== undefined && (
              <>
                <Line
                  from={{ x: activeCursorX, y: 0 }}
                  to={{ x: activeCursorX, y: yMax }}
                  stroke="#666"
                  strokeWidth={1}
                  pointerEvents="none"
                  strokeDasharray="4,2"
                />
                <text x={activeCursorX} y={yMax + 20} textAnchor="middle" fontSize={11} fill="var(--text-primary)" fontWeight="bold" pointerEvents="none">
                  {activeCursorTime}
                </text>
              </>
            )}

            {/* External cursor: mirrored crosshair from a sibling chart */}
            {!isSelecting && !hasExternalSelection && cursorX === undefined && externalCursorTime !== null && externalCursorTime !== undefined && (
              <>
                <Line
                  from={{ x: timeToX(externalCursorTime), y: 0 }}
                  to={{ x: timeToX(externalCursorTime), y: yMax }}
                  stroke="#666"
                  strokeWidth={1}
                  pointerEvents="none"
                  strokeDasharray="4,2"
                />
                <text x={timeToX(externalCursorTime)} y={yMax + 20} textAnchor="middle" fontSize={11} fill="var(--text-primary)" fontWeight="bold" pointerEvents="none">
                  {formatTime(externalCursorTime)}
                </text>
              </>
            )}

            {/* External selection: mirrored selection band from a sibling chart */}
            {!isSelecting && externalSelection !== null && externalSelection !== undefined && (() => {
              const selStartX = timeToX(Math.min(externalSelection.startUs, externalSelection.endUs));
              const selEndX = timeToX(Math.max(externalSelection.startUs, externalSelection.endUs));
              return (
                <>
                  <rect x={selStartX} y={0} width={selEndX - selStartX} height={yMax} fill="var(--color-primary)" fillOpacity={0.2} pointerEvents="none" />
                  <Line from={{ x: selStartX, y: 0 }} to={{ x: selStartX, y: yMax }} stroke="var(--color-primary)" strokeWidth={2} pointerEvents="none" />
                  <Line from={{ x: selEndX, y: 0 }} to={{ x: selEndX, y: yMax }} stroke="var(--color-primary)" strokeWidth={2} pointerEvents="none" />
                  <text x={selStartX} y={yMax + 20} textAnchor="middle" fontSize={11} fill="var(--color-primary)" fontWeight="bold" pointerEvents="none">
                    {formatTime(Math.min(externalSelection.startUs, externalSelection.endUs))}
                  </text>
                  <text x={selEndX} y={yMax + 20} textAnchor="middle" fontSize={11} fill="var(--color-primary)" fontWeight="bold" pointerEvents="none">
                    {formatTime(Math.max(externalSelection.startUs, externalSelection.endUs))}
                  </text>
                </>
              );
            })()}
          </Group>
        </svg>

        {/* Tooltip — always pinned to the SVG top at the cursor x-position */}
        {!isSelecting && tooltipData && tooltipLeft !== undefined && tooltipTop !== undefined && (
          <div
            style={{
              position: 'fixed',
              left: Math.max(0, Math.min(tooltipLeft + 12, Math.max(0, window.innerWidth - 200))),
              top: tooltipTop,
              backgroundColor: 'rgba(0,0,0,0.85)',
              color: 'white',
              padding: '4px 6px',
              borderRadius: '3px',
              fontSize: '11px',
              pointerEvents: 'none',
              lineHeight: '1.3',
              zIndex: 1000,
            }}
          >
            {tooltipData.statusCounts.map(({ key, count }) => (
              <div key={key} style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '1px' }}>
                <span style={{ display: 'inline-block', width: '6px', height: '6px', backgroundColor: getBucketColor(key), borderRadius: '1px' }} />
                <span style={{ fontSize: '10px' }}>{getBucketLabel(key)}: {count}</span>
              </div>
            ))}
            <div style={{ marginTop: '2px', paddingTop: '2px', borderTop: '1px solid #555', fontSize: '10px' }}>
              In-flight: {tooltipData.total}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

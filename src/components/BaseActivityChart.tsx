import { useMemo, useCallback, useEffect, type ReactNode } from 'react';
import { AxisBottom, AxisLeft } from '@visx/axis';
import { Group } from '@visx/group';
import { scaleBand, scaleLinear } from '@visx/scale';
import { Bar, Line } from '@visx/shape';
import { useTooltip } from '@visx/tooltip';
import type { TimestampMicros } from '../types/time.types';
import { MICROS_PER_MILLISECOND } from '../types/time.types';
import { useChartInteraction } from '../hooks/useChartInteraction';
import type { SelectionRange } from '../hooks/useChartInteraction';
import type { LifecycleEvent } from '../types/log.types';
import { LifecycleMarkers } from './LifecycleMarkers';
import { useElementWidth } from '../hooks/useElementWidth';
import { CHART_MARGIN_LEFT } from '../utils/chartUtils';

/** Generic bucket structure for activity charts */
export interface ActivityBucket {
  timestamp: number;
  timeLabel: string;
  total: number;
}

/** A filled run within an activity lane (binary presence over a time span). */
export interface ActivityLaneSegment {
  readonly startUs: number;
  readonly endUs: number;
  /** Tooltip text shown on hover. */
  readonly title: string;
  /** Per-segment fill override; falls back to the lane's `color` when omitted.
   * Used by the app-state bars to colour each span by state. */
  readonly color?: string;
}

/**
 * A binary presence track rendered under the bars on the same time axis — e.g.
 * "which process was logging, when". Only the log chart uses these.
 */
export interface ActivityLane {
  readonly label: string;
  readonly color: string;
  readonly segments: readonly ActivityLaneSegment[];
  /** Draw the faint full-width background track behind the segments (default
   * true). The app lane sets this false so silent gaps stay empty rather than
   * reading as a state. */
  readonly showTrack?: boolean;
}

/** Lane geometry (SVG units within the chart's viewBox). */
const LANE_HEIGHT = 6;
const LANE_GAP = 4;
const LANE_AREA_GAP = 8;

interface BaseActivityChartProps<TBucket extends ActivityBucket, TCategory extends string> {
  /** Buckets of time-aggregated data */
  buckets: TBucket[];
  /** Maximum count across all buckets (for y-axis scaling) */
  maxCount: number;
  /** Minimum time in microseconds */
  minTime: TimestampMicros;
  /** Maximum time in microseconds */
  maxTime: TimestampMicros;
  /** Ordered list of categories to render (determines stacking order) */
  categories: TCategory[];
  /** Get the color for a category */
  getCategoryColor: (category: TCategory) => string;
  /** Get the count for a category from a bucket */
  getCategoryCount: (bucket: TBucket, category: TCategory) => number;
  /** Render custom tooltip content */
  renderTooltipContent: (bucket: TBucket, categories: TCategory[]) => ReactNode;
  /** Callback when user selects a time range. Values are in microseconds. */
  onTimeRangeSelected?: (startUs: TimestampMicros, endUs: TimestampMicros) => void;
  /** Callback when user double-clicks to reset zoom */
  onResetZoom?: () => void;
  /** Empty state message */
  emptyMessage?: string;
  /** Chart height in pixels */
  height?: number;
  /** Optional formatter for y-axis tick labels. Defaults to visx's built-in number format.
   * Use this to display KB/MB/GB labels for byte-valued charts. */
  yAxisTickFormat?: (value: { valueOf(): number }) => string;
  /** Left margin in pixels. Increase when y-axis labels are wider than default (e.g. byte labels). Defaults to 50. */
  marginLeft?: number;
  /**
   * When provided, renders a mirrored crosshair at this time position so the
   * user can see where the cursor is on a sibling chart. Only shown when this
   * chart is not locally active (no local cursor and not selecting).
   */
  externalCursorTime?: number | null;
  /**
   * When provided, renders a mirrored selection band so the user can see the
   * drag selection happening on a sibling chart. Only shown when this chart is
   * not currently being used for a local selection.
   */
  externalSelection?: SelectionRange | null;
  /** Fired as the cursor moves across this chart (see `useChartInteraction`). */
  onCursorMove?: (timeUs: number | null) => void;
  /** Fired as a drag selection changes on this chart (see `useChartInteraction`). */
  onSelectionChange?: (selection: SelectionRange | null) => void;
  /**
   * Optional binary presence lanes drawn under the bars, sharing the time axis.
   * When present the x-axis and cursors shift below the lanes. Used by the log
   * chart to show per-process activity; omit elsewhere.
   */
  lanes?: ActivityLane[];
  /** App-lifecycle events drawn as full-height vertical markers. */
  markers?: readonly LifecycleEvent[];
}

/**
 * Base component for stacked bar activity charts.
 * Used by LogActivityChart and HttpActivityChart.
 */
export function BaseActivityChart<TBucket extends ActivityBucket, TCategory extends string>({
  buckets,
  maxCount,
  minTime,
  maxTime,
  categories,
  getCategoryColor,
  getCategoryCount,
  renderTooltipContent,
  onTimeRangeSelected,
  onResetZoom,
  emptyMessage = 'No data to display',
  height = 120,
  yAxisTickFormat,
  marginLeft = CHART_MARGIN_LEFT,
  externalCursorTime,
  externalSelection,
  onCursorMove,
  onSelectionChange,
  lanes,
  markers,
}: BaseActivityChartProps<TBucket, TCategory>) {
  const { tooltipData, tooltipLeft, tooltipTop, showTooltip, hideTooltip } = useTooltip<TBucket>();
  const tooltipOffsetLeft = 12;

  // Helper to format timestamp as HH:MM:SS in UTC (converts from microseconds)
  const formatTime = useCallback((timestampUs: number): string => {
    const date = new Date(timestampUs / MICROS_PER_MILLISECOND);
    return date.toISOString().split('T')[1].split('.')[0]; // Gets HH:MM:SS in UTC
  }, []);

  const [widthRef, width] = useElementWidth(800);
  const margin = useMemo(() => ({ top: 10, right: 10, bottom: 30, left: marginLeft }), [marginLeft]);
  const xMax = width - margin.left - margin.right;
  const yMax = height - margin.top - margin.bottom;

  // Presence lanes (if any) sit between the bars (which keep using yMax) and the
  // x-axis, which shifts down to `axisTop`. With no lanes, axisTop === yMax so
  // every other chart renders exactly as before.
  const laneRows = lanes ?? [];
  const lanesHeight = laneRows.length ? LANE_AREA_GAP + laneRows.length * (LANE_HEIGHT + LANE_GAP) : 0;
  const axisTop = yMax + lanesHeight;
  const svgHeight = height + lanesHeight;

  // Scales
  const xScale = useMemo(
    () =>
      scaleBand<string>({
        domain: buckets.map((d) => d.timeLabel),
        range: [0, xMax],
        padding: 0,
      }),
    [buckets, xMax]
  );

  const yScale = useMemo(
    () =>
      scaleLinear<number>({
        domain: [0, maxCount],
        range: [yMax, 0],
        nice: true,
      }),
    [maxCount, yMax]
  );

  const getBucketAtIndex = useCallback(
    (index: number): TBucket | undefined => buckets[index],
    [buckets]
  );

  const { state, handlers, svgRef } = useChartInteraction<TBucket>({
    marginLeft: margin.left,
    xMax,
    minTime,
    maxTime,
    formatTime,
    hideTooltip,
    onTimeRangeSelected,
    onResetZoom,
    getBucketAtIndex,
    xScaleStep: xScale.step(),
    bucketCount: buckets.length,
    onCursorMove,
    onSelectionChange,
  });

  /** Convert a microsecond timestamp to an SVG x-coordinate within the chart area.
   * Clamps the input to [minTime, maxTime] so external times outside the chart's
   * domain never produce negative or overflow x values.
   */
  const timeToX = useCallback(
    (timeUs: number): number => {
      if (maxTime === minTime) return 0;
      const clampedTimeUs = Math.max(minTime, Math.min(maxTime, timeUs));
      return ((clampedTimeUs - minTime) / (maxTime - minTime)) * xMax;
    },
    [minTime, maxTime, xMax],
  );

  const { cursorX, cursorTimeLabel, isSelecting, selectionStart, selectionEnd } = state;
  const hasExternalSelection = externalSelection !== null && externalSelection !== undefined;

  /**
   * Returns the bucket whose time slot contains the given timestamp.
   * Used to look up data for the externally-provided cursor position so that
   * this chart can show its own tooltip while a sibling chart is being hovered.
   */
  const getBucketAtExternalTime = useCallback(
    (timeUs: number): TBucket | undefined => {
      if (buckets.length === 0) return undefined;
      // Return undefined when the external time is outside this chart's range to
      // avoid showing a misleading tooltip clamped to the first or last bucket.
      if (timeUs < minTime || timeUs > maxTime) return undefined;
      const x = timeToX(timeUs);
      if (x < 0 || x > xMax) return undefined;
      const index = Math.max(0, Math.min(buckets.length - 1, Math.floor(x / xScale.step())));
      return buckets[index];
    },
    [buckets, minTime, maxTime, timeToX, xScale, xMax],
  );

  // When a sibling chart drives the cursor, show this chart's own tooltip at
  // the same time position so the user can compare data across all charts.
  useEffect(() => {
    if (
      externalCursorTime === null ||
      externalCursorTime === undefined ||
      hasExternalSelection ||
      isSelecting ||
      cursorX !== undefined
    ) {
      // Clear any external-cursor tooltip only when no local interaction is
      // keeping the tooltip open (local hover or selection).
      if (cursorX === undefined && !isSelecting) {
        hideTooltip();
      }
      return;
    }

    const svg = svgRef.current;
    if (!svg) {
      hideTooltip();
      return;
    }

    const bucket = getBucketAtExternalTime(externalCursorTime);
    if (!bucket) {
      hideTooltip();
      return;
    }

    // Convert the chart-space coordinate to viewport coordinates using the
    // SVG's actual screen transform. This matches the browser's rendering even
    // when the viewBox is letterboxed or otherwise not scaled by svgRect.width.
    const viewBoxX = timeToX(externalCursorTime) + margin.left;
    const ctm = typeof svg.getScreenCTM === 'function' ? svg.getScreenCTM() : null;
    let tooltipScreenX: number | null = null;
    let tooltipScreenY: number | null = null;

    if (ctm && typeof svg.createSVGPoint === 'function') {
      const svgPoint = svg.createSVGPoint();
      svgPoint.x = viewBoxX;
      svgPoint.y = 0;
      const transformedPoint = svgPoint.matrixTransform(ctm);
      tooltipScreenX = transformedPoint.x;
      tooltipScreenY = transformedPoint.y;
    }

    // Fallback for environments where getScreenCTM is unavailable.
    if (tooltipScreenX === null || tooltipScreenY === null) {
      const svgRect = svg.getBoundingClientRect();
      const scale = svgRect.width / width;
      tooltipScreenX = svgRect.left + viewBoxX * scale;
      tooltipScreenY = svgRect.top;
    }

    showTooltip({
      tooltipData: bucket,
      tooltipLeft: tooltipScreenX,
      tooltipTop: tooltipScreenY,
    });
  }, [externalCursorTime, hasExternalSelection, isSelecting, cursorX, getBucketAtExternalTime, timeToX, margin, width, svgRef, showTooltip, hideTooltip]);

  if (buckets.length === 0) {
    return (
      <div className="chart-empty" style={{ padding: '20px', textAlign: 'center', color: '#666' }}>
        {emptyMessage}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
      <div ref={widthRef} style={{ flex: 1, minWidth: 0 }}>
        <svg ref={svgRef} width="100%" height={svgHeight} viewBox={`0 0 ${width} ${svgHeight}`} style={{ display: 'block' }}>
          <Group left={margin.left} top={margin.top}>
            {/* Render stacked bars */}
            {buckets.map((bucket) => {
              const barX = xScale(bucket.timeLabel) ?? 0;
              const barWidth = xScale.bandwidth();
              let currentY = yMax;

              return (
                <Group key={bucket.timestamp}>
                  {categories.map((category) => {
                    const count = getCategoryCount(bucket, category);
                    if (count === 0) return null;

                    const barHeight = yMax - yScale(count);
                    const barY = currentY - barHeight;

                    const bar = (
                      <Bar
                        key={category}
                        x={barX}
                        y={barY}
                        width={barWidth}
                        height={barHeight}
                        fill={getCategoryColor(category)}
                        opacity={0.9}
                      >
                        <title>{`${bucket.timeLabel} - ${category}: ${count}`}</title>
                      </Bar>
                    );

                    currentY = barY;
                    return bar;
                  })}
                </Group>
              );
            })}

            {/* Per-process presence lanes, under the bars on the shared time axis. */}
            {laneRows.map((lane, i) => {
              const laneY = yMax + LANE_AREA_GAP + i * (LANE_HEIGHT + LANE_GAP);
              return (
                <Group key={`lane-${i}-${lane.label}`}>
                  <text
                    x={-6}
                    y={laneY + LANE_HEIGHT - 1}
                    textAnchor="end"
                    fontSize={10}
                    fill="var(--text-muted, #888)"
                    pointerEvents="none"
                  >
                    {lane.label}
                  </text>
                  {lane.showTrack !== false && (
                    <rect x={0} y={laneY} width={xMax} height={LANE_HEIGHT} rx={2} fill="var(--border-light, #ddd)" />
                  )}
                  {lane.segments.map((seg, j) => {
                    const x0 = timeToX(seg.startUs);
                    const x1 = timeToX(seg.endUs);
                    return (
                      <rect key={j} x={x0} y={laneY} width={Math.max(1, x1 - x0)} height={LANE_HEIGHT} rx={2} fill={seg.color ?? lane.color}>
                        <title>{seg.title}</title>
                      </rect>
                    );
                  })}
                </Group>
              );
            })}

            {/* App-lifecycle markers, full chart height (bars + lanes). */}
            <LifecycleMarkers markers={markers} timeToX={timeToX} bottomY={axisTop} />

            {/* Invisible overlay for mouse events - must be after bars to be on top.
                Covers only the bars area (not the lanes below) so each lane segment
                keeps its own hover title; the crosshair lines still draw to axisTop. */}
            <rect
              width={xMax}
              height={yMax}
              fill="transparent"
              onMouseDown={handlers.handleMouseDown}
              onMouseUp={handlers.handleMouseUp}
              onMouseMove={(e) => handlers.handleMouseMove(e, showTooltip)}
              onDoubleClick={handlers.handleDoubleClick}
              onMouseLeave={handlers.handleMouseLeave}
              style={{ cursor: isSelecting ? 'col-resize' : 'crosshair' }}
            />

            {/* Axes */}
            <AxisBottom
              top={axisTop}
              scale={xScale}
              tickFormat={() => ''} // Hide automatic ticks
              stroke="#666"
              tickStroke="#666"
              tickLabelProps={() => ({
                fill: '#666',
                fontSize: 10,
                textAnchor: 'middle',
              })}
            />

            {/* Manual start and end time labels - use actual min/max times from data */}
            {buckets.length > 0 && (
              <>
                {/* Start time label - actual minimum time */}
                <text
                  x={xScale(buckets[0].timeLabel) ?? 0}
                  y={axisTop + 16}
                  textAnchor="start"
                  fontSize={10}
                  fill="#666"
                  pointerEvents="none"
                >
                  {formatTime(minTime)}
                </text>
                {/* End time label - actual maximum time */}
                <text
                  x={(xScale(buckets[buckets.length - 1].timeLabel) ?? 0) + (xScale.bandwidth() ?? 0)}
                  y={axisTop + 16}
                  textAnchor="end"
                  fontSize={10}
                  fill="#666"
                  pointerEvents="none"
                >
                  {formatTime(maxTime)}
                </text>
              </>
            )}
            <AxisLeft
              scale={yScale}
              stroke="#666"
              tickStroke="#666"
              numTicks={4}
              tickFormat={yAxisTickFormat}
              tickLabelProps={() => ({
                fill: '#666',
                fontSize: 11,
                textAnchor: 'end',
                dx: -4,
              })}
            />

            {/* Selection mode: two cursors and highlighted area */}
            {isSelecting && selectionStart && selectionEnd && (
              <>
                {/* Highlighted selection area */}
                <rect
                  x={Math.min(selectionStart.x, selectionEnd.x) - margin.left}
                  y={0}
                  width={Math.abs(selectionEnd.x - selectionStart.x)}
                  height={axisTop}
                  fill="var(--color-primary)"
                  fillOpacity={0.2}
                  pointerEvents="none"
                />
                {/* Start cursor */}
                <Line
                  from={{ x: selectionStart.x - margin.left, y: 0 }}
                  to={{ x: selectionStart.x - margin.left, y: axisTop }}
                  stroke="var(--color-primary)"
                  strokeWidth={2}
                  pointerEvents="none"
                />
                {/* End cursor */}
                <Line
                  from={{ x: selectionEnd.x - margin.left, y: 0 }}
                  to={{ x: selectionEnd.x - margin.left, y: axisTop }}
                  stroke="var(--color-primary)"
                  strokeWidth={2}
                  pointerEvents="none"
                />
                {/* Time labels */}
                <text
                  x={selectionStart.x - margin.left}
                  y={axisTop + 20}
                  textAnchor="middle"
                  fontSize={11}
                  fill="var(--color-primary)"
                  fontWeight="bold"
                  pointerEvents="none"
                >
                  {formatTime(selectionStart.time)}
                </text>
                <text
                  x={selectionEnd.x - margin.left}
                  y={axisTop + 20}
                  textAnchor="middle"
                  fontSize={11}
                  fill="var(--color-primary)"
                  fontWeight="bold"
                  pointerEvents="none"
                >
                  {formatTime(selectionEnd.time)}
                </text>
              </>
            )}

            {/* Normal mode: single cursor line and tooltip */}
            {!isSelecting && tooltipData && cursorX !== undefined && (
              <>
                <Line
                  from={{ x: cursorX - margin.left, y: 0 }}
                  to={{ x: cursorX - margin.left, y: axisTop }}
                  stroke="#666"
                  strokeWidth={1}
                  pointerEvents="none"
                  strokeDasharray="4,2"
                />
                {/* Time label on x-axis */}
                <text
                  x={cursorX - margin.left}
                  y={axisTop + 20}
                  textAnchor="middle"
                  fontSize={11}
                  fill="var(--text-primary)"
                  fontWeight="bold"
                  pointerEvents="none"
                >
                  {cursorTimeLabel}
                </text>
              </>
            )}

            {/* External cursor: mirrored crosshair from a sibling chart */}
            {!isSelecting && !hasExternalSelection && cursorX === undefined && externalCursorTime !== null && externalCursorTime !== undefined && (
              <>
                <Line
                  from={{ x: timeToX(externalCursorTime), y: 0 }}
                  to={{ x: timeToX(externalCursorTime), y: axisTop }}
                  stroke="#666"
                  strokeWidth={1}
                  pointerEvents="none"
                  strokeDasharray="4,2"
                />
                <text
                  x={timeToX(externalCursorTime)}
                  y={axisTop + 20}
                  textAnchor="middle"
                  fontSize={11}
                  fill="var(--text-primary)"
                  fontWeight="bold"
                  pointerEvents="none"
                >
                  {formatTime(externalCursorTime)}
                </text>
              </>
            )}

            {/* External selection: mirrored selection band from a sibling chart.
                 Normalize start/end so the rect has a non-negative width even if the
                 sibling passed an inverted range. */}
            {!isSelecting && externalSelection !== null && externalSelection !== undefined && (() => {
              const selStartX = timeToX(Math.min(externalSelection.startUs, externalSelection.endUs));
              const selEndX = timeToX(Math.max(externalSelection.startUs, externalSelection.endUs));
              return (
              <>
                <rect
                  x={selStartX}
                  y={0}
                  width={selEndX - selStartX}
                  height={axisTop}
                  fill="var(--color-primary)"
                  fillOpacity={0.2}
                  pointerEvents="none"
                />
                <Line
                  from={{ x: selStartX, y: 0 }}
                  to={{ x: selStartX, y: axisTop }}
                  stroke="var(--color-primary)"
                  strokeWidth={2}
                  pointerEvents="none"
                />
                <Line
                  from={{ x: selEndX, y: 0 }}
                  to={{ x: selEndX, y: axisTop }}
                  stroke="var(--color-primary)"
                  strokeWidth={2}
                  pointerEvents="none"
                />
                <text
                  x={selStartX}
                  y={axisTop + 20}
                  textAnchor="middle"
                  fontSize={11}
                  fill="var(--color-primary)"
                  fontWeight="bold"
                  pointerEvents="none"
                >
                  {formatTime(Math.min(externalSelection.startUs, externalSelection.endUs))}
                </text>
                <text
                  x={selEndX}
                  y={axisTop + 20}
                  textAnchor="middle"
                  fontSize={11}
                  fill="var(--color-primary)"
                  fontWeight="bold"
                  pointerEvents="none"
                >
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
              left: Math.max(0, Math.min(tooltipLeft + tooltipOffsetLeft, Math.max(0, window.innerWidth - 200))),
              top: tooltipTop,
              backgroundColor: 'rgba(0, 0, 0, 0.85)',
              color: 'white',
              padding: '4px 6px',
              borderRadius: '3px',
              fontSize: '11px',
              pointerEvents: 'none',
              lineHeight: '1.3',
              zIndex: 1000,
            }}
          >
            {renderTooltipContent(tooltipData, categories)}
          </div>
        )}
      </div>
    </div>
  );
}

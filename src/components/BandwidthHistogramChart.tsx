import { useMemo, useCallback, useEffect } from 'react';
import { AxisLeft } from '@visx/axis';
import { Group } from '@visx/group';
import { scaleBand, scaleLinear } from '@visx/scale';
import { Bar, Line } from '@visx/shape';
import { useTooltip } from '@visx/tooltip';
import type { TimestampMicros } from '../types/time.types';
import { MICROS_PER_MILLISECOND } from '../types/time.types';
import { useChartInteraction } from '../hooks/useChartInteraction';
import type { SelectionRange } from '../hooks/useChartInteraction';
import { getBucketColor } from '../utils/httpStatusBuckets';
import { formatBytes } from '../utils/sizeUtils';
import type { BandwidthBucket } from './BandwidthChartTooltip';
import type { LifecycleEvent } from '../types/log.types';
import { LifecycleMarkers } from './LifecycleMarkers';

const SVG_WIDTH = 800;

interface BandwidthHistogramChartProps {
  /** Time-bucketed bandwidth data, one entry per histogram bar. */
  readonly buckets: readonly BandwidthBucket[];
  /** Greatest total download bytes across all buckets — sets the y-axis domain for the bottom zone (below the zero line). */
  readonly maxDownload: number;
  /** Greatest total upload bytes across all buckets — sets the y-axis domain for the top zone (above the zero line). */
  readonly maxUpload: number;
  /** Ordered status-bucket keys that appear in this dataset, used to determine stack order. */
  readonly statusKeys: readonly string[];
  /** Earliest chart timestamp in microseconds. */
  readonly minTime: TimestampMicros;
  /** Latest chart timestamp in microseconds. */
  readonly maxTime: TimestampMicros;
  /** Render the tooltip for the hovered bucket. */
  readonly renderTooltipContent: (bucket: BandwidthBucket) => React.ReactNode;
  /** Callback when user drag-selects a time range. Values are in microseconds. */
  readonly onTimeRangeSelected?: (startUs: TimestampMicros, endUs: TimestampMicros) => void;
  /** Callback when user double-clicks to reset zoom. */
  readonly onResetZoom?: () => void;
  /** Chart height in pixels. */
  readonly height?: number;
  /** Left margin in pixels — increase for wider y-axis byte labels. */
  readonly marginLeft?: number;
  /** Mirrored cursor time from a sibling chart (microseconds). */
  readonly externalCursorTime?: number | null;
  /** Mirrored selection from a sibling chart. */
  readonly externalSelection?: SelectionRange | null;
  /** Fired as the cursor moves across this chart. */
  readonly onCursorMove?: (timeUs: number | null) => void;
  /** Fired as a drag selection changes on this chart. */
  readonly onSelectionChange?: (selection: SelectionRange | null) => void;
  /** App-lifecycle events drawn as full-height vertical markers. */
  readonly markers?: readonly LifecycleEvent[];
}

/**
 * Mirrored diverging stacked bar chart for bandwidth data.
 *
 * Upload bytes (sent) stack **above** the centre zero line; download bytes
 * (received) stack **below** it.  Each direction is broken down by HTTP status
 * bucket and coloured with the same palette as `HttpActivityChart`, so the two
 * charts are visually coherent at a glance.
 *
 * The y-axis uses `formatBytes(|value|)` so that both the upper and lower halves
 * display positive human-readable labels (B / KB / MB).
 *
 * Interaction (cursor sync, drag-to-zoom, external selection mirroring) uses
 * the same `useChartInteraction` hook as `BaseActivityChart`.
 *
 * @example
 * <BandwidthHistogramChart
 *   buckets={chartData.buckets}
 *   maxDownload={chartData.maxDownload}
 *   maxUpload={chartData.maxUpload}
 *   statusKeys={chartData.statusKeys}
 *   minTime={chartData.minTime}
 *   maxTime={chartData.maxTime}
 *   renderTooltipContent={renderBandwidthTooltip}
 *   onTimeRangeSelected={handleTimeRangeSelected}
 * />
 */
export function BandwidthHistogramChart({
  buckets,
  maxDownload,
  maxUpload,
  statusKeys,
  minTime,
  maxTime,
  renderTooltipContent,
  onTimeRangeSelected,
  onResetZoom,
  height = 140,
  marginLeft = 60,
  externalCursorTime,
  externalSelection,
  onCursorMove,
  onSelectionChange,
  markers,
}: BandwidthHistogramChartProps) {
  const { tooltipData, tooltipLeft, tooltipTop, showTooltip, hideTooltip } =
    useTooltip<BandwidthBucket>();

  const tooltipOffsetLeft = 12;

  const margin = useMemo(
    () => ({ top: 10, right: 10, bottom: 30, left: marginLeft }),
    [marginLeft],
  );

  const xMax = SVG_WIDTH - margin.left - margin.right;
  const yMax = height - margin.top - margin.bottom;

  const formatTime = useCallback((timestampUs: number): string => {
    const date = new Date(timestampUs / MICROS_PER_MILLISECOND);
    return date.toISOString().split('T')[1].split('.')[0];
  }, []);

  const xScale = useMemo(
    () =>
      scaleBand<string>({
        domain: buckets.map((d) => d.timeLabel),
        range: [0, xMax],
        paddingInner: 0.08,
        paddingOuter: 0,
      }),
    [buckets, xMax],
  );

  /**
   * Fixed pixel y-coordinate of the zero line.
   * Upload (↑ send) occupies the top 25% of the chart area; download (↓ receive) the bottom 75%.
   * This keeps upload legible even when its magnitude is much smaller than download.
   */
  const zeroY = yMax * 0.25;

  /** Maps upload bytes to pixel y: 0 → zeroY (baseline), maxUpload → 0 (top). */
  const uploadScale = useMemo(
    () => scaleLinear<number>({ domain: [0, maxUpload || 1], range: [zeroY, 0], nice: true }),
    [maxUpload, zeroY],
  );

  /** Maps download bytes to pixel y: 0 → zeroY (baseline), maxDownload → yMax (bottom). */
  const downloadScale = useMemo(
    () => scaleLinear<number>({ domain: [0, maxDownload || 1], range: [zeroY, yMax], nice: true }),
    [maxDownload, zeroY, yMax],
  );

  const getBucketAtIndex = useCallback(
    (index: number): BandwidthBucket | undefined => buckets[index],
    [buckets],
  );

  const { state, handlers, svgRef } = useChartInteraction<BandwidthBucket>({
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

  const timeToX = useCallback(
    (timeUs: number): number => {
      if (maxTime === minTime) return 0;
      const clamped = Math.max(minTime, Math.min(maxTime, timeUs));
      return ((clamped - minTime) / (maxTime - minTime)) * xMax;
    },
    [minTime, maxTime, xMax],
  );

  const { cursorX, cursorTimeLabel, isSelecting, selectionStart, selectionEnd } = state;

  const hasExternalSelection =
    externalSelection !== null && externalSelection !== undefined;

  const getBucketAtExternalTime = useCallback(
    (timeUs: number): BandwidthBucket | undefined => {
      if (buckets.length === 0) return undefined;
      if (timeUs < minTime || timeUs > maxTime) return undefined;
      const x = timeToX(timeUs);
      if (x < 0 || x > xMax) return undefined;
      const index = Math.max(0, Math.min(buckets.length - 1, Math.floor(x / xScale.step())));
      return buckets[index];
    },
    [buckets, minTime, maxTime, timeToX, xScale, xMax],
  );

  useEffect(() => {
    if (
      externalCursorTime === null ||
      externalCursorTime === undefined ||
      hasExternalSelection ||
      isSelecting ||
      cursorX !== undefined
    ) {
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

    if (tooltipScreenX === null || tooltipScreenY === null) {
      const svgRect = svg.getBoundingClientRect();
      const scale = svgRect.width / SVG_WIDTH;
      tooltipScreenX = svgRect.left + viewBoxX * scale;
      tooltipScreenY = svgRect.top;
    }

    showTooltip({
      tooltipData: bucket,
      tooltipLeft: tooltipScreenX,
      tooltipTop: tooltipScreenY,
    });
  }, [
    externalCursorTime,
    hasExternalSelection,
    isSelecting,
    cursorX,
    getBucketAtExternalTime,
    timeToX,
    margin,
    svgRef,
    showTooltip,
    hideTooltip,
  ]);

  if (buckets.length === 0) {
    return (
      <div className="chart-empty" style={{ padding: '20px', textAlign: 'center', color: '#666' }}>
        No bandwidth data to display
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <svg
          ref={svgRef}
          width="100%"
          height={height}
          viewBox={`0 0 ${SVG_WIDTH} ${height}`}
          style={{ display: 'block' }}
        >
          <Group left={margin.left} top={margin.top}>
            {/* ── Mirrored stacked bars ───────────────────────────────── */}
            {buckets.map((bucket) => {
              const barX = xScale(bucket.timeLabel) ?? 0;
              const barWidth = xScale.bandwidth();

              // Upload segments stacked upward from the zero line (↑ above)
              let cumulativeUpload = 0;
              const uploadBars = statusKeys.map((key) => {
                const bytes = bucket.uploadByStatus[key] ?? 0;
                if (bytes === 0) return null;
                const barTop = uploadScale(cumulativeUpload + bytes);
                const barHeight = Math.max(0, uploadScale(cumulativeUpload) - barTop);
                cumulativeUpload += bytes;
                return (
                  <Bar
                    key={`ul-${key}`}
                    x={barX}
                    y={barTop}
                    width={barWidth}
                    height={barHeight}
                    fill={getBucketColor(key)}
                    opacity={0.7}
                  >
                    <title>{`${bucket.timeLabel} ↑ ${key}: ${formatBytes(bytes)}`}</title>
                  </Bar>
                );
              });

              // Download segments stacked downward from the zero line (↓ below)
              let cumulativeDownload = 0;
              const downloadBars = statusKeys.map((key) => {
                const bytes = bucket.downloadByStatus[key] ?? 0;
                if (bytes === 0) return null;
                const barTop = downloadScale(cumulativeDownload);
                const barHeight = Math.max(0, downloadScale(cumulativeDownload + bytes) - barTop);
                cumulativeDownload += bytes;
                return (
                  <Bar
                    key={`dl-${key}`}
                    x={barX}
                    y={barTop}
                    width={barWidth}
                    height={barHeight}
                    fill={getBucketColor(key)}
                    opacity={0.9}
                  >
                    <title>{`${bucket.timeLabel} ↓ ${key}: ${formatBytes(bytes)}`}</title>
                  </Bar>
                );
              });

              return (
                <Group key={bucket.timestamp}>
                  {uploadBars}
                  {downloadBars}
                </Group>
              );
            })}

            {/* ── Upload zone tint (top 25%: above zero) ────────────── */}
            <rect
              x={0}
              y={0}
              width={xMax}
              height={zeroY}
              fill="currentColor"
              opacity={0.04}
              pointerEvents="none"
            />

            {/* ── Centre zero line ────────────────────────────────────── */}
            <line
              x1={0}
              y1={zeroY}
              x2={xMax}
              y2={zeroY}
              stroke="var(--color-border, #888)"
              strokeWidth={2}
              pointerEvents="none"
            />

            {/* ── Direction labels (right edge) ─────────────────────── */}
            <text x={xMax - 4} y={10} textAnchor="end" fontSize={10} fill="#888" pointerEvents="none">
              ↑ Upload
            </text>
            <text x={xMax - 4} y={yMax - 4} textAnchor="end" fontSize={10} fill="#888" pointerEvents="none">
              ↓ Download
            </text>

            {/* ── Invisible overlay for mouse events ─────────────────── */}
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

            {/* App-lifecycle markers */}
            <LifecycleMarkers markers={markers} timeToX={timeToX} bottomY={yMax} />

            {/* ── Bottom axis line + time labels ───────────────────────── */}
            <line x1={0} y1={yMax} x2={xMax} y2={yMax} stroke="#666" strokeWidth={1} pointerEvents="none" />

            {buckets.length > 0 && (
              <>
                <text
                  x={xScale(buckets[0].timeLabel) ?? 0}
                  y={yMax + 16}
                  textAnchor="start"
                  fontSize={10}
                  fill="#666"
                  pointerEvents="none"
                >
                  {formatTime(minTime)}
                </text>
                <text
                  x={(xScale(buckets[buckets.length - 1].timeLabel) ?? 0) + xScale.bandwidth()}
                  y={yMax + 16}
                  textAnchor="end"
                  fontSize={10}
                  fill="#666"
                  pointerEvents="none"
                >
                  {formatTime(maxTime)}
                </text>
              </>
            )}

            {/* ── Y-axis: upload half (above zero) ────────────────────── */}
            <AxisLeft
              scale={uploadScale}
              tickValues={uploadScale.ticks(2).filter((v) => v > 0)}
              stroke="#666"
              tickStroke="#666"
              tickFormat={(value) => formatBytes(value.valueOf())}
              tickLabelProps={() => ({ fill: '#666', fontSize: 11, textAnchor: 'end', dx: -4 })}
            />
            {/* ── Y-axis: download half (below zero) ──────────────────── */}
            <AxisLeft
              scale={downloadScale}
              tickValues={downloadScale.ticks(4).filter((v) => v > 0)}
              stroke="#666"
              tickStroke="#666"
              tickFormat={(value) => formatBytes(value.valueOf())}
              tickLabelProps={() => ({ fill: '#666', fontSize: 11, textAnchor: 'end', dx: -4 })}
            />
            <text x={-8} y={zeroY + 4} textAnchor="end" fontSize={11} fill="#666" pointerEvents="none">0</text>

            {/* ── Selection mode: two cursor lines + highlighted band ── */}
            {isSelecting && selectionStart && selectionEnd && (
              <>
                <rect
                  x={Math.min(selectionStart.x, selectionEnd.x) - margin.left}
                  y={0}
                  width={Math.abs(selectionEnd.x - selectionStart.x)}
                  height={yMax}
                  fill="var(--color-primary)"
                  fillOpacity={0.2}
                  pointerEvents="none"
                />
                <Line
                  from={{ x: selectionStart.x - margin.left, y: 0 }}
                  to={{ x: selectionStart.x - margin.left, y: yMax }}
                  stroke="var(--color-primary)"
                  strokeWidth={2}
                  pointerEvents="none"
                />
                <Line
                  from={{ x: selectionEnd.x - margin.left, y: 0 }}
                  to={{ x: selectionEnd.x - margin.left, y: yMax }}
                  stroke="var(--color-primary)"
                  strokeWidth={2}
                  pointerEvents="none"
                />
                <text
                  x={selectionStart.x - margin.left}
                  y={yMax + 20}
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
                  y={yMax + 20}
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

            {/* ── Normal mode: single cursor line ─────────────────────── */}
            {!isSelecting && tooltipData && cursorX !== undefined && (
              <>
                <Line
                  from={{ x: cursorX - margin.left, y: 0 }}
                  to={{ x: cursorX - margin.left, y: yMax }}
                  stroke="#666"
                  strokeWidth={1}
                  pointerEvents="none"
                  strokeDasharray="4,2"
                />
                <text
                  x={Math.max(10, Math.min(xMax - 10, cursorX - margin.left))}
                  y={yMax + 16}
                  textAnchor="middle"
                  fontSize={11}
                  fill="#333"
                  fontWeight="bold"
                  pointerEvents="none"
                >
                  {cursorTimeLabel}
                </text>
              </>
            )}

            {/* ── External cursor ──────────────────────────────────────── */}
            {!isSelecting &&
              !hasExternalSelection &&
              cursorX === undefined &&
              externalCursorTime !== null &&
              externalCursorTime !== undefined && (
                <>
                  <Line
                    from={{ x: timeToX(externalCursorTime), y: 0 }}
                    to={{ x: timeToX(externalCursorTime), y: yMax }}
                    stroke="#666"
                    strokeWidth={1}
                    pointerEvents="none"
                    strokeDasharray="4,2"
                  />
                  <text
                    x={Math.max(10, Math.min(xMax - 10, timeToX(externalCursorTime)))}
                    y={yMax + 16}
                    textAnchor="middle"
                    fontSize={11}
                    fill="#333"
                    fontWeight="bold"
                    pointerEvents="none"
                  >
                    {formatTime(externalCursorTime)}
                  </text>
                </>
              )}

            {/* ── External selection band ──────────────────────────────── */}
            {!isSelecting &&
              externalSelection !== null &&
              externalSelection !== undefined &&
              (() => {
                const selStartX = timeToX(
                  Math.min(externalSelection.startUs, externalSelection.endUs),
                );
                const selEndX = timeToX(
                  Math.max(externalSelection.startUs, externalSelection.endUs),
                );
                return (
                  <>
                    <rect
                      x={selStartX}
                      y={0}
                      width={selEndX - selStartX}
                      height={yMax}
                      fill="var(--color-primary)"
                      fillOpacity={0.2}
                      pointerEvents="none"
                    />
                    <Line
                      from={{ x: selStartX, y: 0 }}
                      to={{ x: selStartX, y: yMax }}
                      stroke="var(--color-primary)"
                      strokeWidth={2}
                      pointerEvents="none"
                    />
                    <Line
                      from={{ x: selEndX, y: 0 }}
                      to={{ x: selEndX, y: yMax }}
                      stroke="var(--color-primary)"
                      strokeWidth={2}
                      pointerEvents="none"
                    />
                    <text
                      x={selStartX}
                      y={yMax + 20}
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
                      y={yMax + 20}
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

        {/* ── Tooltip — always pinned to the SVG top at the cursor x-position ── */}
        {!isSelecting &&
          tooltipData &&
          tooltipLeft !== undefined &&
          tooltipTop !== undefined && (
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
              {renderTooltipContent(tooltipData)}
            </div>
          )}
      </div>
    </div>
  );
}

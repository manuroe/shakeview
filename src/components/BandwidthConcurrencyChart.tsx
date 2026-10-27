import { useMemo, useCallback } from 'react';
import { Group } from '@visx/group';
import { Area, Line } from '@visx/shape';
import { scaleLinear } from '@visx/scale';
import { AxisLeft } from '@visx/axis';
import { useTooltip } from '@visx/tooltip';
import { curveStepAfter } from 'd3-shape';
import type { BandwidthRequestSpan, LifecycleEvent } from '../types/log.types';
import type { TimestampMicros } from '../types/time.types';
import { MICROS_PER_MILLISECOND } from '../types/time.types';
import type { SelectionRange } from '../hooks/useChartInteraction';
import { LifecycleMarkers } from './LifecycleMarkers';
import { formatBytes } from '../utils/sizeUtils';
import type { StepPoint } from '../utils/concurrencyUtils';
import { getCountAtTime } from '../utils/concurrencyUtils';
import { useStepChartInteraction } from '../hooks/useStepChartInteraction';
import { getBucketKey, getBucketColor, getBucketLabel, sortStatusCodes } from '../utils/httpStatusBuckets';
import { useElementWidth } from '../hooks/useElementWidth';
import { CHART_MARGIN_LEFT } from '../utils/chartUtils';

interface BandwidthConcurrencyChartProps {
  /** Per-request time spans, each with precise start/end timestamps and byte counts. */
  bandwidthRequestSpans: readonly BandwidthRequestSpan[];
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

interface LayerPoint {
  readonly timeUs: number;
  /** Lower value in the data domain (e.g. cumulative bytes below this layer). */
  readonly y0: number;
  /** Upper value in the data domain for this layer (e.g. cumulative bytes including this layer). */
  readonly y1: number;
}

interface TooltipStatusEntry {
  readonly key: string;
  readonly downloadBytes: number;
  readonly uploadBytes: number;
}

interface TooltipData {
  readonly timeUs: number;
  readonly totalDownload: number;
  readonly totalUpload: number;
  /** Per-status counts in display order (highest-priority first). */
  readonly statusEntries: readonly TooltipStatusEntry[];
}

const SVG_WIDTH = 800;
const MARGIN = { top: 10, right: 10, bottom: 30, left: CHART_MARGIN_LEFT };

function computeStepSeries(
  spans: readonly BandwidthRequestSpan[],
  minTime: TimestampMicros,
  maxTime: TimestampMicros,
  pickBytes: (span: BandwidthRequestSpan) => number,
): StepPoint[] {
  const deltas = new Map<number, number>();
  const addDelta = (t: number, d: number): void => {
    deltas.set(t, (deltas.get(t) ?? 0) + d);
  };

  for (const span of spans) {
    const bytes = pickBytes(span);
    if (bytes <= 0) continue;

    const startUs = Math.max(minTime, span.startUs);
    const endUs = Math.min(maxTime, span.endUs ?? maxTime);
    if (endUs <= startUs) continue;

    addDelta(startUs, bytes);
    addDelta(endUs, -bytes);
  }

  const sortedTimes = Array.from(deltas.keys()).sort((a, b) => a - b);
  const points: StepPoint[] = [{ timeUs: minTime, count: 0 }];
  let running = 0;

  for (const t of sortedTimes) {
    if (t > minTime) points.push({ timeUs: t, count: running });
    running += deltas.get(t) ?? 0;
    points.push({ timeUs: t, count: Math.max(0, running) });
  }

  if (points[points.length - 1]?.timeUs !== maxTime) {
    points.push({ timeUs: maxTime, count: Math.max(0, running) });
  }

  return points.sort((a, b) => a.timeUs - b.timeUs);
}

/**
 * Renders tooltip content for the concurrent bandwidth chart.
 *
 * Shows per-status byte breakdowns under separate Download and Upload sections,
 * matching the layout used by `BandwidthChartTooltip.renderBandwidthTooltip`.
 */
function renderConcurrencyTooltip(data: TooltipData): React.ReactElement {
  return (
    <>
      {data.statusEntries.filter((e) => e.uploadBytes > 0).length > 0 && (
        <>
          <div style={{ fontSize: '10px', color: '#aaa', marginBottom: '1px' }}>↑ Upload</div>
          {data.statusEntries
            .filter((e) => e.uploadBytes > 0)
            .map((entry) => (
              <div key={`ul-${entry.key}`} style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '1px' }}>
                <span style={{ display: 'inline-block', width: '6px', height: '6px', backgroundColor: getBucketColor(entry.key), borderRadius: '1px', flexShrink: 0 }} />
                <span style={{ fontSize: '10px' }}>{getBucketLabel(entry.key)}: {formatBytes(entry.uploadBytes)}</span>
              </div>
            ))}
        </>
      )}
      {data.statusEntries.filter((e) => e.downloadBytes > 0).length > 0 && (
        <>
          <div style={{ fontSize: '10px', color: '#aaa', marginTop: data.statusEntries.some((e) => e.uploadBytes > 0) ? '3px' : 0, marginBottom: '1px' }}>↓ Download</div>
          {data.statusEntries
            .filter((e) => e.downloadBytes > 0)
            .map((entry) => (
              <div key={`dl-${entry.key}`} style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '1px' }}>
                <span style={{ display: 'inline-block', width: '6px', height: '6px', backgroundColor: getBucketColor(entry.key), borderRadius: '1px', flexShrink: 0 }} />
                <span style={{ fontSize: '10px' }}>{getBucketLabel(entry.key)}: {formatBytes(entry.downloadBytes)}</span>
              </div>
            ))}
        </>
      )}
      {(data.totalDownload > 0 || data.totalUpload > 0) && (
        <div style={{ marginTop: '3px', paddingTop: '2px', borderTop: '1px solid #555', fontSize: '10px' }}>
          {data.totalDownload > 0 && <span>↓ {formatBytes(data.totalDownload)}</span>}
          {data.totalDownload > 0 && data.totalUpload > 0 && <span style={{ margin: '0 4px', color: '#aaa' }}>·</span>}
          {data.totalUpload > 0 && <span>↑ {formatBytes(data.totalUpload)}</span>}
        </div>
      )}
    </>
  );
}

/**
 * Step-function area chart for the "Show in-flight" concurrent mode on the /summary screen.
 *
 * Unlike the bar histogram, this chart uses the precise `startUs`/`endUs` timestamps
 * from `BandwidthRequestSpan` to compute an exact in-flight waveform — no bucketing
 * approximation.
 *
 * The chart is **mirrored**: upload bytes (sent) stack **above** the zero line
 * using the HTTP status colour palette; download bytes (received) stack **below** the zero
 * line with the same colours.  This matches the `BandwidthHistogramChart` layout so
 * both chart modes are visually coherent.
 *
 * Interaction model mirrors `HttpConcurrencyChart`: drag-to-zoom, cursor sync, and
 * external selection mirroring are all supported via the same prop surface.
 */
export function BandwidthConcurrencyChart({
  bandwidthRequestSpans,
  timeRange,
  onTimeRangeSelected,
  onResetZoom,
  externalCursorTime,
  externalSelection,
  onCursorMove,
  onSelectionChange,
  markers,
  height = 140,
}: BandwidthConcurrencyChartProps) {
  const { minTime, maxTime } = timeRange;
  const [widthRef, svgWidth] = useElementWidth(SVG_WIDTH);
  const xMax = svgWidth - MARGIN.left - MARGIN.right;
  const yMax = height - MARGIN.top - MARGIN.bottom;

  // ── Ordered status keys from all spans ───────────────────────────────────
  const orderedKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const span of bandwidthRequestSpans) keys.add(getBucketKey(span));
    return sortStatusCodes(Array.from(keys));
  }, [bandwidthRequestSpans]);

  // ── Per-status step series (download + upload) ───────────────────────────
  /** Spans grouped by status key — built once and shared by both download and upload series. */
  const spansByKey = useMemo(() => {
    const grouped = new Map<string, BandwidthRequestSpan[]>();
    for (const key of orderedKeys) grouped.set(key, []);
    for (const span of bandwidthRequestSpans) grouped.get(getBucketKey(span))?.push(span);
    return grouped;
  }, [orderedKeys, bandwidthRequestSpans]);

  const downloadSeriesByKey = useMemo(
    () =>
      new Map(
        orderedKeys.map((key) => [
          key,
          computeStepSeries(spansByKey.get(key) ?? [], minTime, maxTime, (s) => s.downloadBytes),
        ]),
      ),
    [orderedKeys, spansByKey, minTime, maxTime],
  );

  const uploadSeriesByKey = useMemo(
    () =>
      new Map(
        orderedKeys.map((key) => [
          key,
          computeStepSeries(spansByKey.get(key) ?? [], minTime, maxTime, (s) => s.uploadBytes),
        ]),
      ),
    [orderedKeys, spansByKey, minTime, maxTime],
  );

  /**
   * Unified timeline for download layers — cumulative download bytes rendered below the zero line.
   * y0/y1 are positive data values; `downloadScale` maps them into the bottom zone of the chart.
   */
  const downloadLayers = useMemo(() => {
    const allTimes = new Set([minTime, maxTime]);
    for (const pts of downloadSeriesByKey.values()) {
      for (const p of pts) allTimes.add(p.timeUs);
    }
    const sortedTimes = Array.from(allTimes).sort((a, b) => a - b);

    const countsByKey = new Map<string, number[]>();
    for (const key of orderedKeys) {
      const pts = downloadSeriesByKey.get(key) ?? [];
      countsByKey.set(key, sortedTimes.map((t) => getCountAtTime(pts, t)));
    }

    const cumulative = new Array<number>(sortedTimes.length).fill(0);
    return orderedKeys.map((key) => {
      const counts = countsByKey.get(key) ?? [];
      const points: LayerPoint[] = sortedTimes.map((timeUs, idx) => {
        const y0 = cumulative[idx];
        const y1 = y0 + (counts[idx] ?? 0);
        cumulative[idx] = y1;
        return { timeUs, y0, y1 };
      });
      return { key, color: getBucketColor(key), points };
    });
  }, [orderedKeys, downloadSeriesByKey, minTime, maxTime]);

  /**
   * Unified timeline for upload layers — positive domain (above zero).
   * Each layer's y0/y1 values represent cumulative upload bytes in data units,
   * mapped to pixel y via `uploadScale` which places them in the top 25% zone.
   */
  const uploadLayers = useMemo(() => {
    const allTimes = new Set([minTime, maxTime]);
    for (const pts of uploadSeriesByKey.values()) {
      for (const p of pts) allTimes.add(p.timeUs);
    }
    const sortedTimes = Array.from(allTimes).sort((a, b) => a - b);

    const countsByKey = new Map<string, number[]>();
    for (const key of orderedKeys) {
      const pts = uploadSeriesByKey.get(key) ?? [];
      countsByKey.set(key, sortedTimes.map((t) => getCountAtTime(pts, t)));
    }

    const cumulative = new Array<number>(sortedTimes.length).fill(0);
    return orderedKeys.map((key) => {
      const counts = countsByKey.get(key) ?? [];
      const points: LayerPoint[] = sortedTimes.map((timeUs, idx) => {
        const y0 = cumulative[idx];
        const y1 = cumulative[idx] + (counts[idx] ?? 0);
        cumulative[idx] = y1;
        return { timeUs, y0, y1 };
      });
      return { key, color: getBucketColor(key), points };
    });
  }, [orderedKeys, uploadSeriesByKey, minTime, maxTime]);

  const maxDownload = useMemo(() => {
    let max = 1;
    for (const layer of downloadLayers) {
      for (const point of layer.points) {
        if (point.y1 > max) max = point.y1;
      }
    }
    return max;
  }, [downloadLayers]);

  const maxUpload = useMemo(() => {
    let max = 1;
    for (const layer of uploadLayers) {
      for (const point of layer.points) {
        if (point.y1 > max) max = point.y1;
      }
    }
    return max;
  }, [uploadLayers]);

  const hasData = useMemo(
    () => bandwidthRequestSpans.some((s) => s.uploadBytes > 0 || s.downloadBytes > 0),
    [bandwidthRequestSpans],
  );

  const xScale = useMemo(
    () => scaleLinear<number>({ domain: [minTime, maxTime], range: [0, xMax], clamp: true }),
    [minTime, maxTime, xMax],
  );

  /**
   * Fixed pixel y-coordinate of the zero line.
   * Upload (↑ send) occupies the top 25% of the chart area; download (↓ receive) the bottom 75%.
   * This keeps upload legible even when much smaller than download.
   */
  const zeroY = yMax * 0.25;

  /** Maps upload bytes to pixel y: 0 → zeroY (baseline), maxUpload → 0 (top). */
  const uploadScale = useMemo(
    () => scaleLinear<number>({ domain: [0, maxUpload], range: [zeroY, 0], nice: true }),
    [maxUpload, zeroY],
  );

  /** Maps download bytes to pixel y: 0 → zeroY (baseline), maxDownload → yMax (bottom). */
  const downloadScale = useMemo(
    () => scaleLinear<number>({ domain: [0, maxDownload], range: [zeroY, yMax], nice: true }),
    [maxDownload, zeroY, yMax],
  );

  const formatTime = useCallback((timestampUs: number): string => {
    const date = new Date(timestampUs / MICROS_PER_MILLISECOND);
    return date.toISOString().split('T')[1].split('.')[0];
  }, []);

  // ── Tooltip ──────────────────────────────────────────────────────────────
  const { tooltipData, tooltipLeft, tooltipTop, showTooltip, hideTooltip } =
    useTooltip<TooltipData>();

  // ── Interaction ─────────────────────────────────────────────────────────
  /** Reversed key order for tooltip — computed once per orderedKeys change, not on every mouse-move. */
  const reversedKeys = useMemo(() => [...orderedKeys].reverse(), [orderedKeys]);

  const getTooltipData = useCallback(
    (timeUs: number): TooltipData => {
      let totalDownload = 0;
      let totalUpload = 0;
      const statusEntries: TooltipStatusEntry[] = [];
      for (const key of reversedKeys) {
        const dl = getCountAtTime(downloadSeriesByKey.get(key) ?? [], timeUs);
        const ul = getCountAtTime(uploadSeriesByKey.get(key) ?? [], timeUs);
        totalDownload += dl;
        totalUpload += ul;
        if (dl > 0 || ul > 0) statusEntries.push({ key, downloadBytes: dl, uploadBytes: ul });
      }
      return { timeUs, totalDownload, totalUpload, statusEntries };
    },
    [reversedKeys, downloadSeriesByKey, uploadSeriesByKey],
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
  if (!hasData) {
    return (
      <div className="chart-empty" style={{ padding: '20px', textAlign: 'center', color: '#666' }}>
        No in-flight bandwidth data to display
      </div>
    );
  }

  const activeCursorX = cursorX !== undefined ? cursorX - MARGIN.left : undefined;
  const activeCursorTimeUs = cursorTimeUs !== undefined ? cursorTimeUs : undefined;

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
            {/* ── Upload layers (above zero, own scale top 25%) ────── */}
            {uploadLayers.map((layer) => (
              <Area<LayerPoint>
                key={`ul-${layer.key}`}
                data={layer.points}
                x={(d) => xScale(d.timeUs)}
                y0={(d) => uploadScale(d.y0)}
                y1={(d) => uploadScale(d.y1)}
                curve={curveStepAfter}
                fill={layer.color}
                fillOpacity={0.7}
              />
            ))}

            {/* ── Download layers (below zero, own scale bottom 75%) ── */}
            {downloadLayers.map((layer) => (
              <Area<LayerPoint>
                key={`dl-${layer.key}`}
                data={layer.points}
                x={(d) => xScale(d.timeUs)}
                y0={(d) => downloadScale(d.y0)}
                y1={(d) => downloadScale(d.y1)}
                curve={curveStepAfter}
                fill={layer.color}
                fillOpacity={0.7}
              />
            ))}

            {/* ── Upload zone tint (top 25%) ──────────────────────────── */}
            <rect x={0} y={0} width={xMax} height={zeroY} fill="currentColor" opacity={0.04} pointerEvents="none" />

            {/* ── Centre zero line ───────────────────────────────────── */}
            <line
              x1={0}
              y1={zeroY}
              x2={xMax}
              y2={zeroY}
              stroke="var(--color-border, #888)"
              strokeWidth={2}
              pointerEvents="none"
            />

            {/* ── Direction labels (right edge) ───────────────────────── */}
            <text x={xMax - 4} y={10} textAnchor="end" fontSize={10} fill="#888" pointerEvents="none">
              ↑ Upload
            </text>
            <text x={xMax - 4} y={yMax - 4} textAnchor="end" fontSize={10} fill="#888" pointerEvents="none">
              ↓ Download
            </text>

            <AxisLeft
              scale={uploadScale}
              tickValues={uploadScale.ticks(2).filter((v) => v > 0)}
              stroke="#666"
              tickStroke="#666"
              tickFormat={(value) => formatBytes(value.valueOf())}
              tickLabelProps={() => ({ fill: '#666', fontSize: 11, textAnchor: 'end', dx: -4 })}
            />
            <AxisLeft
              scale={downloadScale}
              tickValues={downloadScale.ticks(4).filter((v) => v > 0)}
              stroke="#666"
              tickStroke="#666"
              tickFormat={(value) => formatBytes(value.valueOf())}
              tickLabelProps={() => ({ fill: '#666', fontSize: 11, textAnchor: 'end', dx: -4 })}
            />
            <text x={-8} y={zeroY + 4} textAnchor="end" fontSize={11} fill="#666" pointerEvents="none">0</text>

            {/* Start/end time labels */}
            <line x1={0} y1={yMax} x2={xMax} y2={yMax} stroke="#666" strokeWidth={1} pointerEvents="none" />
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
                {activeCursorTimeUs !== undefined && (
                  <text
                    x={Math.max(10, Math.min(xMax - 10, activeCursorX))}
                    y={yMax + 16}
                    textAnchor="middle"
                    fontSize={11}
                    fill="var(--text-primary)"
                    fontWeight="bold"
                    pointerEvents="none"
                  >
                    {formatTime(activeCursorTimeUs)}
                  </text>
                )}
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
                <text
                  x={Math.max(10, Math.min(xMax - 10, timeToX(externalCursorTime)))}
                  y={yMax + 16}
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
            {renderConcurrencyTooltip(tooltipData)}
          </div>
        )}
      </div>
    </div>
  );
}

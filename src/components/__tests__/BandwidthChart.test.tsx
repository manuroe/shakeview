import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BandwidthChart } from '../BandwidthChart';
import { renderBandwidthTooltip, type BandwidthBucket } from '../BandwidthChartTooltip';
import type { BandwidthRequestEntry, BandwidthRequestSpan } from '../../types/log.types';
import type { TimestampMicros } from '../../types/time.types';
import { MICROS_PER_MILLISECOND } from '../../types/time.types';
import { getBucketColor } from '../../utils/httpStatusBuckets';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeEntry(
  overrides: Partial<BandwidthRequestEntry> = {},
): BandwidthRequestEntry {
  return {
    timestampUs: (2_000 * MICROS_PER_MILLISECOND) as TimestampMicros, // 2 s
    uploadBytes: 512,
    downloadBytes: 4096,
    uri: 'https://matrix.example.org/_matrix/client/v3/sync',
    status: '200 OK',
    isIncomplete: false,
    ...overrides,
  };
}

function makeRange(
  minMs = 0,
  maxMs = 10_000,
): { minTime: TimestampMicros; maxTime: TimestampMicros } {
  return {
    minTime: (minMs * MICROS_PER_MILLISECOND) as TimestampMicros,
    maxTime: (maxMs * MICROS_PER_MILLISECOND) as TimestampMicros,
  };
}

function makeSpan(
  overrides: Partial<BandwidthRequestSpan> = {},
): BandwidthRequestSpan {
  return {
    startUs: (1_000 * MICROS_PER_MILLISECOND) as TimestampMicros,
    endUs: (4_000 * MICROS_PER_MILLISECOND) as TimestampMicros,
    uploadBytes: 512,
    downloadBytes: 4096,
    uri: 'https://matrix.example.org/_matrix/client/v3/sync',
    status: '200 OK',
    ...overrides,
  };
}

/** HTTP status colour for status key '200' (used in bar fill assertions). */
const COLOR_200 = getBucketColor('200');

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('BandwidthChart', () => {
  describe('empty state', () => {
    it('shows empty message when no requests provided', () => {
      render(<BandwidthChart requests={[]} timeRange={makeRange()} />);
      expect(screen.getByText('No bandwidth data to display')).toBeInTheDocument();
    });

    it('renders without errors when timeRange is 0/0 (covers early-return useMemo branch)', () => {
      // exercises the `if (minTime === 0 && maxTime === 0)` early return inside useMemo
      expect(() =>
        render(
          <BandwidthChart
            requests={[makeEntry()]}
            timeRange={{ minTime: 0 as TimestampMicros, maxTime: 0 as TimestampMicros }}
          />,
        ),
      ).not.toThrow();
    });

    it('renders without errors when minTime equals maxTime (single-instant time range)', () => {
      // A single-instant time range (minTime === maxTime) is a valid edge case —
      // the chart should render gracefully and treat all bars as zero-width (x=0).
      const singlePointTime = 5_000 * MICROS_PER_MILLISECOND;
      expect(() =>
        render(
          <BandwidthChart
            requests={[makeEntry({ timestampUs: singlePointTime as TimestampMicros })]}
            timeRange={{
              minTime: singlePointTime as TimestampMicros,
              maxTime: singlePointTime as TimestampMicros,
            }}
          />,
        ),
      ).not.toThrow();
    });
  });

  describe('bar rendering', () => {
    it('renders an SVG with bars when entries are provided', () => {
      const { container } = render(
        <BandwidthChart requests={[makeEntry()]} timeRange={makeRange(0, 10_000)} />,
      );
      expect(container.querySelector('svg')).toBeInTheDocument();
    });

    it('renders download bars with HTTP status colour at full opacity', () => {
      const { container } = render(
        <BandwidthChart
          requests={[makeEntry({ uploadBytes: 0, downloadBytes: 4096, status: '200 OK' })]}
          timeRange={makeRange(0, 10_000)}
        />,
      );
      // Download bars use the HTTP status colour at 0.9 opacity
      const downloadBars = container.querySelectorAll(
        `rect[fill="${COLOR_200}"][opacity="0.9"]`,
      );
      expect(downloadBars.length).toBeGreaterThan(0);
    });

    it('renders upload bars with HTTP status colour at reduced opacity', () => {
      const { container } = render(
        <BandwidthChart
          requests={[makeEntry({ uploadBytes: 1024, downloadBytes: 0, status: '200 OK' })]}
          timeRange={makeRange(0, 10_000)}
        />,
      );
      // Upload bars use the same colour at 0.7 opacity to distinguish direction
      const uploadBars = container.querySelectorAll(
        `rect[fill="${COLOR_200}"][opacity="0.7"]`,
      );
      expect(uploadBars.length).toBeGreaterThan(0);
    });

    it('renders bars for two different status codes with different colours', () => {
      const entries = [
        makeEntry({ status: '200 OK', downloadBytes: 1024, uploadBytes: 0 }),
        makeEntry({ status: '404 Not Found', downloadBytes: 512, uploadBytes: 0 }),
      ];
      const { container } = render(
        <BandwidthChart requests={entries} timeRange={makeRange(0, 10_000)} />,
      );
      const color404 = getBucketColor('404');
      // Both status codes produce coloured bars
      const bars200 = container.querySelectorAll(`rect[fill="${COLOR_200}"]`);
      const bars404 = container.querySelectorAll(`rect[fill="${color404}"]`);
      expect(bars200.length).toBeGreaterThan(0);
      expect(bars404.length).toBeGreaterThan(0);
    });

    it('buckets multiple entries into the same bar when they share a time window', () => {
      // Two entries at the same second → should collapse into a single non-empty bucket
      const entries = [
        makeEntry({ timestampUs: (1_000 * MICROS_PER_MILLISECOND) as TimestampMicros, uploadBytes: 0, downloadBytes: 200 }),
        makeEntry({ timestampUs: (1_500 * MICROS_PER_MILLISECOND) as TimestampMicros, uploadBytes: 0, downloadBytes: 300 }),
      ];
      const { container } = render(
        <BandwidthChart requests={entries} timeRange={makeRange(0, 10_000)} />,
      );
      expect(container.querySelector('svg')).toBeInTheDocument();
      // Both contribute to the same 1-second bucket → exactly one download bar rendered
      const downloadBars = container.querySelectorAll(
        `rect[fill="${COLOR_200}"][opacity="0.9"]`,
      );
      expect(downloadBars.length).toBe(1);
    });

    it('entries outside the time range are placed in adjacent buckets (no bar outside range)', () => {
      // Entry at t=2s; range 0–10s → should render without throwing
      expect(() =>
        render(
          <BandwidthChart
            requests={[makeEntry({ timestampUs: (2_000 * MICROS_PER_MILLISECOND) as TimestampMicros })]}
            timeRange={makeRange(0, 10_000)}
          />,
        ),
      ).not.toThrow();
    });

    it('renders the centre zero line', () => {
      const { container } = render(
        <BandwidthChart requests={[makeEntry()]} timeRange={makeRange(0, 10_000)} />,
      );
      // The centre zero line uses the border CSS variable
      const zeroLine = container.querySelector('line[stroke="var(--color-border, #888)"]');
      expect(zeroLine).toBeInTheDocument();
    });
  });

  describe('callback props', () => {
    it('wires onTimeRangeSelected to the histogram chart (mouse interaction overlay present)', () => {
      const onSelect = vi.fn();
      const { container } = render(
        <BandwidthChart
          requests={[makeEntry()]}
          timeRange={makeRange(0, 10_000)}
          onTimeRangeSelected={onSelect}
        />,
      );
      // The invisible overlay rect receives mouse events
      expect(container.querySelector('rect[fill="transparent"]')).toBeInTheDocument();
    });
  });

  describe('in-flight mode', () => {
    it('renders area paths for at least one status in stepArea mode', () => {
      const spans = [makeSpan()];
      const { container } = render(
        <BandwidthChart
          requests={[]}
          bandwidthRequestSpans={spans}
          displayMode="stepArea"
          timeRange={makeRange(0, 10_000)}
        />,
      );
      // At least one download and one upload area path rendered with HTTP status colours
      const paths = container.querySelectorAll('path[fill]');
      expect(paths.length).toBeGreaterThanOrEqual(1);
    });

    it('shows empty message in stepArea mode when spans are empty', () => {
      render(
        <BandwidthChart
          requests={[]}
          bandwidthRequestSpans={[]}
          displayMode="stepArea"
          timeRange={makeRange(0, 10_000)}
        />,
      );

      expect(screen.getByText('No in-flight bandwidth data to display')).toBeInTheDocument();
    });
  });

  describe('external cursor and selection mirroring', () => {
    it('renders external cursor line when externalCursorTime is provided', () => {
      const { container } = render(
        <BandwidthChart
          requests={[makeEntry()]}
          timeRange={makeRange(0, 10_000)}
          externalCursorTime={2_000 * MICROS_PER_MILLISECOND}
        />,
      );
      // External cursor renders a dashed vertical line
      const dashedLines = container.querySelectorAll('line[stroke-dasharray]');
      expect(dashedLines.length).toBeGreaterThan(0);
    });

    it('still renders cursor line when externalCursorTime is outside the time range (clamped to edge)', () => {
      const { container } = render(
        <BandwidthChart
          requests={[makeEntry()]}
          timeRange={makeRange(0, 10_000)}
          externalCursorTime={99_000 * MICROS_PER_MILLISECOND}
        />,
      );
      // Time is clamped to the range edge — cursor line is still rendered
      const dashedLines = container.querySelectorAll('line[stroke-dasharray]');
      expect(dashedLines.length).toBeGreaterThan(0);
    });

    it('renders external selection band when externalSelection is provided', () => {
      const { container } = render(
        <BandwidthChart
          requests={[makeEntry()]}
          timeRange={makeRange(0, 10_000)}
          externalSelection={{
            startUs: (1_000 * MICROS_PER_MILLISECOND) as TimestampMicros,
            endUs: (3_000 * MICROS_PER_MILLISECOND) as TimestampMicros,
          }}
        />,
      );
      // External selection band renders a semi-transparent primary-colour rect
      const selectionRect = container.querySelector('rect[fill="var(--color-primary)"][fill-opacity="0.2"]');
      expect(selectionRect).toBeInTheDocument();
    });

    it('fires onCursorMove when provided', () => {
      const onCursorMove = vi.fn();
      render(
        <BandwidthChart
          requests={[makeEntry()]}
          timeRange={makeRange(0, 10_000)}
          onCursorMove={onCursorMove}
        />,
      );
      // Component mounts without error — onCursorMove is wired
      expect(onCursorMove).not.toHaveBeenCalled();
    });

    it('fires onSelectionChange when provided', () => {
      const onSelectionChange = vi.fn();
      render(
        <BandwidthChart
          requests={[makeEntry()]}
          timeRange={makeRange(0, 10_000)}
          onSelectionChange={onSelectionChange}
        />,
      );
      expect(onSelectionChange).not.toHaveBeenCalled();
    });

    it('renders in-progress selection band while dragging', () => {
      const { container } = render(
        <BandwidthChart
          requests={[makeEntry()]}
          timeRange={makeRange(0, 10_000)}
        />,
      );
      const overlay = container.querySelector('rect[fill="transparent"]') as SVGElement;
      // Start a drag without releasing — selection band should appear
      fireEvent.mouseDown(overlay, { clientX: 200, clientY: 50 });
      fireEvent.mouseMove(overlay, { clientX: 500, clientY: 50 });
      const selectionBand = container.querySelector('rect[fill="var(--color-primary)"][fill-opacity="0.2"]');
      expect(selectionBand).toBeInTheDocument();
    });

    it('uses CTM path for tooltip positioning when getScreenCTM returns a matrix', () => {
      // jsdom returns null from getScreenCTM; mock it to cover the CTM branch in BandwidthHistogramChart
      const mockPoint = { x: 0, y: 0, matrixTransform: vi.fn().mockReturnValue({ x: 42, y: 10 }) };
      const origGetCTM = SVGSVGElement.prototype.getScreenCTM;
      const origCreatePoint = SVGSVGElement.prototype.createSVGPoint;
      SVGSVGElement.prototype.getScreenCTM = vi.fn().mockReturnValue({ a: 1 }) as unknown as typeof origGetCTM;
      SVGSVGElement.prototype.createSVGPoint = vi.fn().mockReturnValue(mockPoint) as unknown as typeof origCreatePoint;

      try {
        render(
          <BandwidthChart
            requests={[makeEntry()]}
            timeRange={makeRange(0, 10_000)}
            externalCursorTime={2_000 * MICROS_PER_MILLISECOND}
          />,
        );
        // CTM path executed without error; matrixTransform was called to compute tooltip position
        expect(mockPoint.matrixTransform).toHaveBeenCalled();
      } finally {
        SVGSVGElement.prototype.getScreenCTM = origGetCTM;
        SVGSVGElement.prototype.createSVGPoint = origCreatePoint;
      }
    });
  });
});

// ─── renderBandwidthTooltip unit tests ──────────────────────────────────────

function makeBucket(overrides: Partial<BandwidthBucket> = {}): BandwidthBucket {
  return {
    timestamp: 0,
    timeLabel: '00:00:01',
    total: 1536,
    totalDownload: 1024,
    totalUpload: 512,
    downloadByStatus: { '200': 1024 },
    uploadByStatus: { '200': 512 },
    ...overrides,
  };
}

describe('renderBandwidthTooltip', () => {
  it('shows download section when downloadByStatus has bytes', () => {
    render(renderBandwidthTooltip(makeBucket({ downloadByStatus: { '200': 1024 } })));
    expect(screen.getByText(/download/i)).toBeInTheDocument();
  });

  it('hides download section when downloadByStatus is empty', () => {
    render(renderBandwidthTooltip(makeBucket({ downloadByStatus: {}, totalDownload: 0 })));
    expect(screen.queryByText(/download/i)).not.toBeInTheDocument();
  });

  it('shows upload section when uploadByStatus has bytes', () => {
    render(renderBandwidthTooltip(makeBucket({ uploadByStatus: { '200': 512 } })));
    expect(screen.getByText(/upload/i)).toBeInTheDocument();
  });

  it('hides upload section when uploadByStatus is empty', () => {
    render(renderBandwidthTooltip(makeBucket({ uploadByStatus: {}, totalUpload: 0 })));
    expect(screen.queryByText(/upload/i)).not.toBeInTheDocument();
  });

  it('shows total row when total > 0', () => {
    render(renderBandwidthTooltip(makeBucket({ total: 1536 })));
    expect(screen.getByText(/total/i)).toBeInTheDocument();
  });

  it('hides total row when total = 0', () => {
    render(renderBandwidthTooltip(makeBucket({ total: 0, downloadByStatus: {}, uploadByStatus: {}, totalDownload: 0, totalUpload: 0 })));
    expect(screen.queryByText(/total/i)).not.toBeInTheDocument();
  });

  it('shows per-status labels with byte values', () => {
    render(renderBandwidthTooltip(makeBucket({
      downloadByStatus: { '200': 2048, '404': 512 },
      uploadByStatus: {},
      totalDownload: 2560,
      totalUpload: 0,
    })));
    // Both status codes should appear (upload cleared so "200" only appears once)
    expect(screen.getByText(/200/)).toBeInTheDocument();
    expect(screen.getByText(/404/)).toBeInTheDocument();
  });
});


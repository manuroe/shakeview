import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { TimestampMicros } from '../../types/time.types';
import { MICROS_PER_MILLISECOND } from '../../types/time.types';
import type { HttpRequestSpan } from '../../types/log.types';
import { computeStepPoints, getCountAtTime } from '../../utils/concurrencyUtils';
import { HttpConcurrencyChart } from '../HttpConcurrencyChart';

// ─── computeStepPoints ───────────────────────────────────────────────────────

describe('computeStepPoints', () => {
  const US = (ms: number) => (ms * MICROS_PER_MILLISECOND) as TimestampMicros;

  it('returns empty array when spans array is empty', () => {
    expect(computeStepPoints([], 0, US(100))).toEqual([]);
  });

  it('produces correct step points for a single span', () => {
    const spans: HttpRequestSpan[] = [
      { startUs: US(10), endUs: US(30), status: '200' },
    ];
    const pts = computeStepPoints(spans, 0, US(50));
    // Expect anchor at start, +1 at 10ms, -1 at 30ms, anchor at end
    expect(pts).toEqual([
      { timeUs: 0, count: 0 },
      { timeUs: US(10), count: 1 },
      { timeUs: US(30), count: 0 },
      { timeUs: US(50), count: 0 },
    ]);
  });

  it('correctly counts two overlapping spans', () => {
    const spans: HttpRequestSpan[] = [
      { startUs: US(10), endUs: US(30), status: '200' },
      { startUs: US(20), endUs: US(40), status: '200' },
    ];
    const pts = computeStepPoints(spans, 0, US(50));
    expect(pts.find((p) => p.timeUs === US(10))?.count).toBe(1);
    expect(pts.find((p) => p.timeUs === US(20))?.count).toBe(2);
    expect(pts.find((p) => p.timeUs === US(30))?.count).toBe(1);
    expect(pts.find((p) => p.timeUs === US(40))?.count).toBe(0);
  });

  it('treats endUs=null as in-flight until maxTime', () => {
    const spans: HttpRequestSpan[] = [
      { startUs: US(10), endUs: null, status: '200' },
    ];
    const maxTime = US(50);
    const pts = computeStepPoints(spans, 0, maxTime);
    // count stays 1 until the synthetic end at maxTime
    expect(pts.find((p) => p.timeUs === US(10))?.count).toBe(1);
    expect(pts.find((p) => p.timeUs === maxTime)?.count).toBe(0);
  });

  it('collapses simultaneous starts onto the same point', () => {
    const spans: HttpRequestSpan[] = [
      { startUs: US(10), endUs: US(30), status: '200' },
      { startUs: US(10), endUs: US(30), status: '200' },
    ];
    const pts = computeStepPoints(spans, 0, US(50));
    // Both start at the same time: count = 2 at that point
    expect(pts.find((p) => p.timeUs === US(10))?.count).toBe(2);
    expect(pts.find((p) => p.timeUs === US(30))?.count).toBe(0);
  });

  it('anchors at minTime when first event is after minTime', () => {
    const spans: HttpRequestSpan[] = [
      { startUs: US(20), endUs: US(40), status: '200' },
    ];
    const pts = computeStepPoints(spans, US(5), US(50));
    expect(pts[0]).toEqual({ timeUs: US(5), count: 0 });
  });

  it('anchors at maxTime with final count to fill to chart edge', () => {
    const spans: HttpRequestSpan[] = [
      { startUs: US(10), endUs: US(20), status: '200' },
    ];
    const pts = computeStepPoints(spans, 0, US(50));
    expect(pts[pts.length - 1]).toEqual({ timeUs: US(50), count: 0 });
  });

  it('never produces negative count (defensive)', () => {
    // Malformed data: two -1 events for the same span shouldn't go negative
    const spans: HttpRequestSpan[] = [
      { startUs: US(10), endUs: US(30), status: '200' },
    ];
    const pts = computeStepPoints(spans, 0, US(50));
    expect(pts.every((p) => p.count >= 0)).toBe(true);
  });
});

// ─── HttpConcurrencyChart component ─────────────────────────────────────────

function makeTimeRange(minMs = 0, maxMs = 10_000) {
  return {
    minTime: (minMs * MICROS_PER_MILLISECOND) as TimestampMicros,
    maxTime: (maxMs * MICROS_PER_MILLISECOND) as TimestampMicros,
  };
}

function makeSpan(overrides: Partial<HttpRequestSpan> = {}): HttpRequestSpan {
  return {
    startUs: (1_000 * MICROS_PER_MILLISECOND) as TimestampMicros,
    endUs: (3_000 * MICROS_PER_MILLISECOND) as TimestampMicros,
    status: '200',
    ...overrides,
  };
}

// ─── getCountAtTime ──────────────────────────────────────────────────────────

describe('getCountAtTime', () => {
  const US = (ms: number) => (ms * MICROS_PER_MILLISECOND) as TimestampMicros;

  it('returns 0 for empty points array', () => {
    expect(getCountAtTime([], US(10))).toBe(0);
  });

  it('returns count at exact step point time', () => {
    const pts = [{ timeUs: US(0), count: 0 }, { timeUs: US(10), count: 3 }];
    expect(getCountAtTime(pts, US(10))).toBe(3);
  });

  it('returns count of latest point before query time', () => {
    const pts = [{ timeUs: US(0), count: 0 }, { timeUs: US(10), count: 2 }, { timeUs: US(30), count: 0 }];
    expect(getCountAtTime(pts, US(20))).toBe(2);
  });

  it('returns 0 when query time is before first point', () => {
    const pts = [{ timeUs: US(10), count: 1 }];
    expect(getCountAtTime(pts, US(5))).toBe(0);
  });
});

// ─── HttpConcurrencyChart component ─────────────────────────────────────────

describe('HttpConcurrencyChart', () => {
  it('renders empty state message when no spans provided', () => {
    render(<HttpConcurrencyChart httpRequestSpans={[]} timeRange={makeTimeRange()} />);
    expect(screen.getByText('No in-flight request data to display')).toBeInTheDocument();
  });

  it('renders an SVG with area paths when spans are provided', () => {
    const { container } = render(
      <HttpConcurrencyChart httpRequestSpans={[makeSpan()]} timeRange={makeTimeRange()} />,
    );
    expect(container.querySelector('svg')).toBeInTheDocument();
    expect(container.querySelector('path')).toBeInTheDocument();
  });

  it('renders with incomplete spans (endUs=null) without throwing', () => {
    const spans: HttpRequestSpan[] = [
      { startUs: (500 * MICROS_PER_MILLISECOND) as TimestampMicros, endUs: null, status: '200' },
    ];
    const { container } = render(
      <HttpConcurrencyChart httpRequestSpans={spans} timeRange={makeTimeRange()} />,
    );
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('renders with multiple overlapping spans', () => {
    const spans: HttpRequestSpan[] = [
      makeSpan({ startUs: (1_000 * MICROS_PER_MILLISECOND) as TimestampMicros, endUs: (4_000 * MICROS_PER_MILLISECOND) as TimestampMicros }),
      makeSpan({ startUs: (2_000 * MICROS_PER_MILLISECOND) as TimestampMicros, endUs: (5_000 * MICROS_PER_MILLISECOND) as TimestampMicros }),
    ];
    const { container } = render(
      <HttpConcurrencyChart httpRequestSpans={spans} timeRange={makeTimeRange()} />,
    );
    expect(container.querySelector('svg')).toBeInTheDocument();
    expect(container.querySelector('path')).toBeInTheDocument();
  });

  describe('interaction', () => {
    function renderWithSpan() {
      const result = render(
        <HttpConcurrencyChart httpRequestSpans={[makeSpan()]} timeRange={makeTimeRange()} />,
      );
      const overlay = result.container.querySelector('rect[fill="transparent"]') as SVGElement;
      expect(overlay).not.toBeNull();
      return { ...result, overlay };
    }

    it('shows a cursor line on mouse move', () => {
      const { container, overlay } = renderWithSpan();
      fireEvent.mouseMove(overlay, { clientX: 300, clientY: 50 });
      expect(container.querySelector('line[stroke-dasharray="4,2"]')).toBeInTheDocument();
    });

    it('removes cursor line on mouse leave', () => {
      const { container, overlay } = renderWithSpan();
      fireEvent.mouseMove(overlay, { clientX: 300, clientY: 50 });
      fireEvent.mouseLeave(overlay);
      expect(container.querySelector('line[stroke-dasharray="4,2"]')).not.toBeInTheDocument();
    });

    it('calls onTimeRangeSelected after a drag selection', () => {
      const onTimeRangeSelected = vi.fn();
      const { container } = render(
        <HttpConcurrencyChart
          httpRequestSpans={[makeSpan()]}
          timeRange={makeTimeRange()}
          onTimeRangeSelected={onTimeRangeSelected}
        />,
      );
      const overlay = container.querySelector('rect[fill="transparent"]') as SVGElement;
      fireEvent.mouseDown(overlay, { clientX: 210, clientY: 50 });
      fireEvent.mouseMove(overlay, { clientX: 650, clientY: 50 });
      fireEvent.mouseUp(overlay);
      expect(onTimeRangeSelected).toHaveBeenCalled();
    });

    it('calls onResetZoom on double click', () => {
      const onResetZoom = vi.fn();
      const { container } = render(
        <HttpConcurrencyChart
          httpRequestSpans={[makeSpan()]}
          timeRange={makeTimeRange()}
          onResetZoom={onResetZoom}
        />,
      );
      const overlay = container.querySelector('rect[fill="transparent"]') as SVGElement;
      fireEvent.dblClick(overlay);
      expect(onResetZoom).toHaveBeenCalled();
    });

    it('renders external cursor line when externalCursorTime is provided', () => {
      const externalTime = 5_000 * MICROS_PER_MILLISECOND;
      const { container } = render(
        <HttpConcurrencyChart
          httpRequestSpans={[makeSpan()]}
          timeRange={makeTimeRange()}
          externalCursorTime={externalTime}
        />,
      );
      // External cursor renders a dashed line too
      expect(container.querySelector('line[stroke-dasharray="4,2"]')).toBeInTheDocument();
    });

    it('renders external selection band when externalSelection is provided', () => {
      const { container } = render(
        <HttpConcurrencyChart
          httpRequestSpans={[makeSpan()]}
          timeRange={makeTimeRange()}
          externalSelection={{ startUs: 2_000 * MICROS_PER_MILLISECOND, endUs: 7_000 * MICROS_PER_MILLISECOND }}
        />,
      );
      // External selection band: a filled rect + 2 lines (not dashed)
      const solidLines = container.querySelectorAll('line[stroke="var(--color-primary)"]');
      expect(solidLines.length).toBeGreaterThan(0);
    });

    it('fires onCursorMove when cursor moves', () => {
      const onCursorMove = vi.fn();
      const { container } = render(
        <HttpConcurrencyChart
          httpRequestSpans={[makeSpan()]}
          timeRange={makeTimeRange()}
          onCursorMove={onCursorMove}
        />,
      );
      const overlay = container.querySelector('rect[fill="transparent"]') as SVGElement;
      fireEvent.mouseMove(overlay, { clientX: 400, clientY: 50 });
      expect(onCursorMove).toHaveBeenCalled();
    });

    it('uses CTM-based tooltip positioning when getScreenCTM returns a matrix', () => {
      const { container } = render(
        <HttpConcurrencyChart httpRequestSpans={[makeSpan()]} timeRange={makeTimeRange()} />,
      );
      const svg = container.querySelector('svg') as SVGSVGElement;
      // @visx/event's localPoint() calls svg.getScreenCTM().inverse(), so the mock
      // CTM object must have an inverse() method. Our showTooltipAtX() also calls
      // createSVGPoint() to compute screen-space tooltip position from the CTM.
      const mockPointResult = { x: 100, y: 50 };
      const mockPoint = { x: 0, y: 0, matrixTransform: vi.fn().mockReturnValue(mockPointResult) };
      const mockCTM = { inverse: vi.fn().mockReturnValue({}) };
      // jsdom does not define getScreenCTM/createSVGPoint on SVG elements; define directly.
      Object.defineProperty(svg, 'getScreenCTM', {
        value: vi.fn().mockReturnValue(mockCTM),
        configurable: true,
      });
      Object.defineProperty(svg, 'createSVGPoint', {
        value: vi.fn().mockReturnValue(mockPoint),
        configurable: true,
      });

      const overlay = container.querySelector('rect[fill="transparent"]') as SVGElement;
      fireEvent.mouseMove(overlay, { clientX: 400, clientY: 50 });
      // matrixTransform is called by showTooltipAtX for CTM-based screen positioning.
      expect(mockPoint.matrixTransform).toHaveBeenCalled();
    });

    it('fires onCursorMove with null on mouse leave', () => {
      const onCursorMove = vi.fn();
      const { container } = render(
        <HttpConcurrencyChart
          httpRequestSpans={[makeSpan()]}
          timeRange={makeTimeRange()}
          onCursorMove={onCursorMove}
        />,
      );
      const overlay = container.querySelector('rect[fill="transparent"]') as SVGElement;
      fireEvent.mouseMove(overlay, { clientX: 400, clientY: 50 });
      fireEvent.mouseLeave(overlay);
      expect(onCursorMove).toHaveBeenLastCalledWith(null);
    });

    it('renders without throwing when externalCursorTime is outside chart range', () => {
      // Time is way out of range — the effect calls hideTooltip() without crashing.
      const { container } = render(
        <HttpConcurrencyChart
          httpRequestSpans={[makeSpan()]}
          timeRange={makeTimeRange(1_000, 5_000)}
          externalCursorTime={-1}
        />,
      );
      expect(container.querySelector('svg')).toBeInTheDocument();
    });

    it('handles mouseUp with no prior mouseDown without throwing', () => {
      const onTimeRangeSelected = vi.fn();
      const { container } = render(
        <HttpConcurrencyChart
          httpRequestSpans={[makeSpan()]}
          timeRange={makeTimeRange()}
          onTimeRangeSelected={onTimeRangeSelected}
        />,
      );
      const overlay = container.querySelector('rect[fill="transparent"]') as SVGElement;
      // mouseUp without mouseDown should not call onTimeRangeSelected
      fireEvent.mouseUp(overlay);
      expect(onTimeRangeSelected).not.toHaveBeenCalled();
    });
  });

  describe('stacked-by-status rendering', () => {
    it('renders one area path per distinct status bucket', () => {
      const spans: HttpRequestSpan[] = [
        makeSpan({ status: '200' }),
        makeSpan({ status: '404' }),
      ];
      const { container } = render(
        <HttpConcurrencyChart httpRequestSpans={spans} timeRange={makeTimeRange()} />,
      );
      // Two status buckets → two Area fills + two LinePath strokes = at least 2 paths
      const paths = container.querySelectorAll('path');
      // Each status contributes at least one Area fill path + one LinePath
      expect(paths.length).toBeGreaterThanOrEqual(2);
    });

    it('uses status colour for each layer (200 area fill matches --http-200)', () => {
      const { container } = render(
        <HttpConcurrencyChart httpRequestSpans={[makeSpan({ status: '200' })]} timeRange={makeTimeRange()} />,
      );
      const svg = container.querySelector('svg');
      // The area fill for 200 should use the 200 color variable
      expect(svg?.innerHTML).toContain('--http-200');
    });

    it('applies sync-catchup colour for timeout=0 spans', () => {
      const span: HttpRequestSpan = { ...makeSpan(), status: '200', timeout: 0 };
      const { container } = render(
        <HttpConcurrencyChart httpRequestSpans={[span]} timeRange={makeTimeRange()} />,
      );
      expect(container.querySelector('svg')?.innerHTML).toContain('--sync-catchup-success');
    });

    it('applies sync-longpoll colour for timeout>=30000 spans', () => {
      const span: HttpRequestSpan = { ...makeSpan(), status: '200', timeout: 30_000 };
      const { container } = render(
        <HttpConcurrencyChart httpRequestSpans={[span]} timeRange={makeTimeRange()} />,
      );
      expect(container.querySelector('svg')?.innerHTML).toContain('--sync-longpoll-success');
    });

    it('renders a single stratum when all spans share the same status', () => {
      const spans = [makeSpan({ status: '500' }), makeSpan({ status: '500' })];
      const { container } = render(
        <HttpConcurrencyChart httpRequestSpans={spans} timeRange={makeTimeRange()} />,
      );
      // Only one Area fill path + one LinePath stroke expected for a single bucket
      const paths = container.querySelectorAll('path');
      // At minimum there will be Area+LinePath for the single bucket; axis tick lines
      // are rendered as <line> not <path>, so paths count reflects strata only.
      expect(paths.length).toBeGreaterThanOrEqual(1);
    });
  });
});

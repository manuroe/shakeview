import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { TimestampMicros } from '../../types/time.types';
import { MICROS_PER_MILLISECOND } from '../../types/time.types';
import type { BandwidthRequestSpan } from '../../types/log.types';
import { BandwidthConcurrencyChart } from '../BandwidthConcurrencyChart';

function makeRange(minMs = 0, maxMs = 10_000): { minTime: TimestampMicros; maxTime: TimestampMicros } {
  return {
    minTime: (minMs * MICROS_PER_MILLISECOND) as TimestampMicros,
    maxTime: (maxMs * MICROS_PER_MILLISECOND) as TimestampMicros,
  };
}

function makeSpan(overrides: Partial<BandwidthRequestSpan> = {}): BandwidthRequestSpan {
  return {
    startUs: (1_000 * MICROS_PER_MILLISECOND) as TimestampMicros,
    endUs: (4_000 * MICROS_PER_MILLISECOND) as TimestampMicros,
    uploadBytes: 1024,
    downloadBytes: 4096,
    uri: 'https://matrix.example.org/_matrix/client/v3/keys/upload',
    status: '200 OK',
    ...overrides,
  };
}

describe('BandwidthConcurrencyChart', () => {
  it('shows empty message when there are no spans with bytes', () => {
    render(
      <BandwidthConcurrencyChart
        bandwidthRequestSpans={[]}
        timeRange={makeRange()}
      />,
    );
    expect(screen.getByText('No in-flight bandwidth data to display')).toBeInTheDocument();
  });

  it('renders stacked area paths when spans are provided', () => {
    const { container } = render(
      <BandwidthConcurrencyChart
        bandwidthRequestSpans={[makeSpan()]}
        timeRange={makeRange()}
      />,
    );
    expect(container.querySelector('svg')).toBeInTheDocument();
    // Each status key produces one download layer and one upload layer.
    const areas = container.querySelectorAll('path[fill]');
    expect(areas.length).toBeGreaterThanOrEqual(2);
  });

  it('supports incomplete spans (endUs=null)', () => {
    const { container } = render(
      <BandwidthConcurrencyChart
        bandwidthRequestSpans={[makeSpan({ endUs: null })]}
        timeRange={makeRange()}
      />,
    );
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('renders when upload is zero and download is present', () => {
    const { container } = render(
      <BandwidthConcurrencyChart
        bandwidthRequestSpans={[makeSpan({ uploadBytes: 0, downloadBytes: 4096 })]}
        timeRange={makeRange()}
      />,
    );
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('ignores malformed spans where end is before start', () => {
    const { container } = render(
      <BandwidthConcurrencyChart
        bandwidthRequestSpans={[
          makeSpan({
            startUs: (7_000 * MICROS_PER_MILLISECOND) as TimestampMicros,
            endUs: (2_000 * MICROS_PER_MILLISECOND) as TimestampMicros,
            uploadBytes: 2048,
            downloadBytes: 1024,
          }),
        ]}
        timeRange={makeRange()}
      />,
    );
    expect(container.querySelector('svg')).toBeInTheDocument();
  });
});

// ─── BandwidthConcurrencyChart interaction ────────────────────────────────────

describe('BandwidthConcurrencyChart interaction', () => {
  function renderWithSpan() {
    const result = render(
      <BandwidthConcurrencyChart
        bandwidthRequestSpans={[makeSpan()]}
        timeRange={makeRange()}
      />,
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
      <BandwidthConcurrencyChart
        bandwidthRequestSpans={[makeSpan()]}
        timeRange={makeRange()}
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
      <BandwidthConcurrencyChart
        bandwidthRequestSpans={[makeSpan()]}
        timeRange={makeRange()}
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
      <BandwidthConcurrencyChart
        bandwidthRequestSpans={[makeSpan()]}
        timeRange={makeRange()}
        externalCursorTime={externalTime}
      />,
    );
    expect(container.querySelector('line[stroke-dasharray="4,2"]')).toBeInTheDocument();
  });

  it('renders external selection band when externalSelection is provided', () => {
    const { container } = render(
      <BandwidthConcurrencyChart
        bandwidthRequestSpans={[makeSpan()]}
        timeRange={makeRange()}
        externalSelection={{ startUs: 2_000 * MICROS_PER_MILLISECOND, endUs: 7_000 * MICROS_PER_MILLISECOND }}
      />,
    );
    const solidLines = container.querySelectorAll('line[stroke="var(--color-primary)"]');
    expect(solidLines.length).toBeGreaterThan(0);
  });

  it('fires onCursorMove when cursor moves', () => {
    const onCursorMove = vi.fn();
    const { container } = render(
      <BandwidthConcurrencyChart
        bandwidthRequestSpans={[makeSpan()]}
        timeRange={makeRange()}
        onCursorMove={onCursorMove}
      />,
    );
    const overlay = container.querySelector('rect[fill="transparent"]') as SVGElement;
    fireEvent.mouseMove(overlay, { clientX: 400, clientY: 50 });
    expect(onCursorMove).toHaveBeenCalled();
  });

  it('fires onCursorMove with null on mouse leave', () => {
    const onCursorMove = vi.fn();
    const { container } = render(
      <BandwidthConcurrencyChart
        bandwidthRequestSpans={[makeSpan()]}
        timeRange={makeRange()}
        onCursorMove={onCursorMove}
      />,
    );
    const overlay = container.querySelector('rect[fill="transparent"]') as SVGElement;
    fireEvent.mouseMove(overlay, { clientX: 400, clientY: 50 });
    fireEvent.mouseLeave(overlay);
    expect(onCursorMove).toHaveBeenLastCalledWith(null);
  });

  it('renders without throwing when externalCursorTime is outside chart range', () => {
    const { container } = render(
      <BandwidthConcurrencyChart
        bandwidthRequestSpans={[makeSpan()]}
        timeRange={makeRange(1_000, 5_000)}
        externalCursorTime={-1}
      />,
    );
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('handles mouseUp with no prior mouseDown without throwing', () => {
    const onTimeRangeSelected = vi.fn();
    const { container } = render(
      <BandwidthConcurrencyChart
        bandwidthRequestSpans={[makeSpan()]}
        timeRange={makeRange()}
        onTimeRangeSelected={onTimeRangeSelected}
      />,
    );
    const overlay = container.querySelector('rect[fill="transparent"]') as SVGElement;
    fireEvent.mouseUp(overlay);
    expect(onTimeRangeSelected).not.toHaveBeenCalled();
  });

  it('uses CTM-based tooltip positioning when getScreenCTM returns a matrix', () => {
    const { container } = render(
      <BandwidthConcurrencyChart bandwidthRequestSpans={[makeSpan()]} timeRange={makeRange()} />,
    );
    const svg = container.querySelector('svg') as SVGSVGElement;
    const mockPointResult = { x: 100, y: 50 };
    const mockPoint = { x: 0, y: 0, matrixTransform: vi.fn().mockReturnValue(mockPointResult) };
    const mockCTM = { inverse: vi.fn().mockReturnValue({}) };
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
    expect(mockPoint.matrixTransform).toHaveBeenCalled();
  });

  it('renders in-progress selection band while dragging', () => {
    const { container } = render(
      <BandwidthConcurrencyChart
        bandwidthRequestSpans={[makeSpan()]}
        timeRange={makeRange()}
      />,
    );
    const overlay = container.querySelector('rect[fill="transparent"]') as SVGElement;
    // Start a drag without releasing — selection band should appear
    fireEvent.mouseDown(overlay, { clientX: 200, clientY: 50 });
    fireEvent.mouseMove(overlay, { clientX: 500, clientY: 50 });
    const selectionBand = container.querySelector('rect[fill="var(--color-primary)"][fill-opacity="0.2"]');
    expect(selectionBand).toBeInTheDocument();
  });
});

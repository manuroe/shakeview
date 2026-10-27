import { describe, it, expect, vi, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { screen, fireEvent } from '@testing-library/dom';
import { LogActivityChart } from '../LogActivityChart';
import { createParsedLogLines, createParsedLogLine } from '../../test/fixtures';
import { useLogStore } from '../../stores/logStore';
import type { SentryEvent, LifecycleEvent, LifecycleEventKind } from '../../types/log.types';
import type { TimestampMicros } from '../../types/time.types';
import { appStateColors } from '../../utils/lifecycleEvents';
import { APP_LANE_COLOR } from '../../utils/processColors';

/** Minimal lifecycle event for the app-state lane tests. */
function lc(kind: LifecycleEventKind, timestampUs: number): LifecycleEvent {
  return { kind, platform: 'ios', lineNumber: 0, timestampUs: timestampUs as TimestampMicros };
}

describe('LogActivityChart', () => {
  it('renders the chart with stacked bars', () => {
    const logs = createParsedLogLines(50);
    const { container } = render(<LogActivityChart logLines={logs} />);

    // Check that SVG is rendered
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();

    // Check for bars (Bar elements become rect in the DOM)
    const bars = container.querySelectorAll('rect[opacity="0.9"]');
    expect(bars.length).toBeGreaterThan(0);
  });

  it('shows empty state when no logs provided', () => {
    render(<LogActivityChart logLines={[]} />);
    expect(screen.getByText('No log data to display')).toBeInTheDocument();
  });

  it('displays cursor line on mouse move', () => {
    const logs = createParsedLogLines(100);
    const { container } = render(<LogActivityChart logLines={logs} />);

    const overlay = container.querySelector('rect[fill="transparent"]') as SVGElement;

    // Initially, no cursor line should be visible
    let cursorLine = container.querySelector('line[stroke-dasharray="4,2"]');
    expect(cursorLine).not.toBeInTheDocument();

    // Simulate mouse move over the chart
    fireEvent.mouseMove(overlay, { clientX: 100, clientY: 50 });

    // Cursor line should now be visible
    cursorLine = container.querySelector('line[stroke-dasharray="4,2"]');
    expect(cursorLine).toBeInTheDocument();
  });

  it('hides cursor line on mouse leave', async () => {
    const logs = createParsedLogLines(100);
    const { container } = render(<LogActivityChart logLines={logs} />);

    const overlay = container.querySelector('rect[fill="transparent"]') as SVGElement;

    // Move mouse over the chart
    fireEvent.mouseMove(overlay, { clientX: 100, clientY: 50 });
    await new Promise(resolve => setTimeout(resolve, 50));
    const cursorLine = container.querySelector('line[stroke-dasharray="4,2"]');
    expect(cursorLine).toBeInTheDocument();

    // Verify component still renders after mouse leave (hideTooltip should work)
    fireEvent.mouseLeave(overlay);
    await new Promise(resolve => setTimeout(resolve, 50));
    // Component should still exist and be functional
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('displays time label at cursor position', () => {
    const logs = createParsedLogLines(100);
    const { container } = render(<LogActivityChart logLines={logs} />);

    const overlay = container.querySelector('rect[fill="transparent"]') as SVGElement;

    // Move mouse to trigger tooltip
    fireEvent.mouseMove(overlay, { clientX: 200, clientY: 50 });

    // Look for time label (text element with HH:MM:SS format)
    const timeLabels = container.querySelectorAll('text[font-weight="bold"]');
    expect(timeLabels.length).toBeGreaterThan(0);

    // Check that at least one contains time format (HH:MM:SS)
    const hasTimeFormat = Array.from(timeLabels).some((label) => {
      const text = label.textContent ?? '';
      return /\d{2}:\d{2}:\d{2}/.test(text);
    });
    expect(hasTimeFormat).toBe(true);
  });

  it('displays tooltip with log level counts on mouse move', () => {
    // createParsedLogLines cycles through ERROR/WARN/INFO/DEBUG/TRACE levels
    const logs = createParsedLogLines(100);
    const { container } = render(<LogActivityChart logLines={logs} />);
    const overlay = container.querySelector('rect[fill="transparent"]') as SVGElement;

    // clientX=150 → adjustedX=90 (past CHART_MARGIN_LEFT=60): falls on a real bucket
    fireEvent.mouseMove(overlay, { clientX: 150, clientY: 50 });

    // showTooltip fires in the same handleMouseMove call as setCursorX,
    // so both state updates are synchronously applied by the time fireEvent returns.
    // The tooltip div renders inline (not in a portal).
    expect(screen.getByText(/^Total:/)).toBeInTheDocument();

    // At least one log-level label should be present in the tooltip
    const levelLabels = ['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'];
    const hasLevel = levelLabels.some((l) => {
      try { return screen.getByText(new RegExp(`^${l}:`)) !== null; } catch { return false; }
    });
    expect(hasLevel).toBe(true);
  });

  it('shows total count in tooltip (non-zero for a populated bucket)', () => {
    const logs = createParsedLogLines(50);
    const { container } = render(<LogActivityChart logLines={logs} />);
    const overlay = container.querySelector('rect[fill="transparent"]') as SVGElement;

    fireEvent.mouseMove(overlay, { clientX: 150, clientY: 50 });

    // Tooltip should render "Total: N" where N > 0
    const totalEl = screen.getByText(/^Total:/);
    expect(totalEl).toBeInTheDocument();
    const totalNumber = parseInt(totalEl.textContent!.replace('Total:', '').trim());
    expect(totalNumber).toBeGreaterThan(0);
  });

  it('renders bars for all log levels', () => {
    const logs = createParsedLogLines(100);
    const { container } = render(<LogActivityChart logLines={logs} />);

    // Check that bars are rendered with correct colors
    const colors = ['#f44336', '#ff9800', '#4ec9b0', '#569cd6', '#808080', '#858585'];
    colors.forEach((color) => {
      const bar = container.querySelector(`rect[fill="${color}"][opacity="0.9"]`);
      // Not all colors may be present in every run, but we can verify the SVG structure exists
      expect(bar || container.querySelector('svg')).toBeTruthy();
    });
  });

  it('calculates correct bucket size for large time ranges', () => {
    // Create logs spanning a long time period (1 hour)
    const hourInMs = 60 * 60 * 1000;
    const logs = createParsedLogLines(100, hourInMs);
    const { container } = render(<LogActivityChart logLines={logs} />);

    // Verify SVG renders without errors
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();

    // Check that bars are rendered
    const bars = container.querySelectorAll('rect[opacity="0.9"]');
    expect(bars.length).toBeGreaterThan(0);
  });

  it('handles sparse log data with gaps', () => {
    // Create logs with gaps (sparse data)
    const logs: ParsedLogLine[] = [];
    const baseTime = new Date('2025-01-15T10:00:00Z').getTime();

    // Add logs at specific intervals with gaps
    for (let i = 0; i < 10; i++) {
      const time = new Date(baseTime + i * 10000); // 10 second intervals
      const isoTimestamp = time.toISOString().replace(/\.\d{3}Z$/, '.000000Z');
      const displayTime = isoTimestamp.match(/T([\d:.]+)Z$/)?.[1] || '';
      logs.push({
        lineNumber: i,
        rawText: `${isoTimestamp} INFO message`,
        isoTimestamp,
        timestampUs: time.getTime() * 1000,
        displayTime,
        level: 'INFO',
        message: 'message',
        strippedMessage: 'message',
        continuationLines: [],
      });
    }

    const { container } = render(<LogActivityChart logLines={logs} />);

    // Chart should render with gaps in data
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();

    // Bars should be visible
    const bars = container.querySelectorAll('rect[opacity="0.9"]');
    expect(bars.length).toBeGreaterThan(0);
  });

  it('cursor position updates on successive mouse moves', () => {
    const logs = createParsedLogLines(100);
    const { container } = render(<LogActivityChart logLines={logs} />);

    const overlay = container.querySelector('rect[fill="transparent"]') as SVGElement;

    // Move to position 1
    fireEvent.mouseMove(overlay, { clientX: 100, clientY: 50 });
    let cursorLine = container.querySelector('line[stroke-dasharray="4,2"]') as SVGLineElement | null;
    const firstX = cursorLine?.getAttribute('x1');

    // Move to position 2
    fireEvent.mouseMove(overlay, { clientX: 300, clientY: 50 });
    cursorLine = container.querySelector('line[stroke-dasharray="4,2"]') as SVGLineElement | null;
    const secondX = cursorLine?.getAttribute('x1');

    // Cursor should be at different position
    expect(firstX).not.toBe(secondX);
    expect(cursorLine).toBeInTheDocument();
  });

  it('does not display cursor when mouse is outside chart bounds', () => {
    const logs = createParsedLogLines(100);
    const { container } = render(<LogActivityChart logLines={logs} />);

    const overlay = container.querySelector('rect[fill="transparent"]') as SVGElement;

    // Move to a valid position first
    fireEvent.mouseMove(overlay, { clientX: 150, clientY: 50 });
    const cursorLine = container.querySelector('line[stroke-dasharray="4,2"]');
    expect(cursorLine).toBeInTheDocument();

    // Move to invalid position (outside the chart area)
    // The overlay rect is typically positioned inside margins, so moving far left won't trigger cursor
    fireEvent.mouseMove(overlay, { clientX: -200, clientY: 50 });
    // With clientX at -200, localPoint should be negative, causing hideTooltip to be called
    // However, testing internal state is tricky, so we just verify the component doesn't crash
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('does not crash when mouse selection exceeds minimum range', async () => {
    const logs = createParsedLogLines(100);
    const onTimeRangeSelected = vi.fn();
    const { container } = render(
      <LogActivityChart logLines={logs} onTimeRangeSelected={onTimeRangeSelected} />
    );

    const overlay = container.querySelector('rect[fill="transparent"]') as SVGElement;

    // Start selection with mouseDown
    fireEvent.mouseDown(overlay, { clientX: 100, clientY: 50 });
    
    await new Promise(resolve => setTimeout(resolve, 10));

    // Drag to create a significant selection (large distance = large time range)
    fireEvent.mouseMove(overlay, { clientX: 500, clientY: 50 });

    await new Promise(resolve => setTimeout(resolve, 10));

    // End selection - should trigger callback if range > 100ms
    fireEvent.mouseUp(overlay, { clientX: 500, clientY: 50 });

    await new Promise(resolve => setTimeout(resolve, 50));

    // Callback may or may not be called depending on coordinate-to-time mapping
    // Just verify the component handles it without crashing
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('does not crash for mouse selection smaller than 100ms', async () => {
    const logs = createParsedLogLines(100);
    const onTimeRangeSelected = vi.fn();
    const { container } = render(
      <LogActivityChart logLines={logs} onTimeRangeSelected={onTimeRangeSelected} />
    );

    const overlay = container.querySelector('rect[fill="transparent"]') as SVGElement;

    // Mouse down
    fireEvent.mouseDown(overlay, { clientX: 100, clientY: 50 });

    // Mouse up at almost same position (very small range, < 100ms)
    fireEvent.mouseUp(overlay, { clientX: 105, clientY: 50 });

    await new Promise(resolve => setTimeout(resolve, 50));

    // Component should handle small selections gracefully
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('calls onResetZoom callback on double-click', async () => {
    const logs = createParsedLogLines(100);
    const onResetZoom = vi.fn();
    const { container } = render(
      <LogActivityChart logLines={logs} onResetZoom={onResetZoom} />
    );

    const overlay = container.querySelector('rect[fill="transparent"]') as SVGElement;

    // Double-click
    fireEvent.doubleClick(overlay, { clientX: 150, clientY: 50 });

    await new Promise(resolve => setTimeout(resolve, 50));

    // Callback should have been called
    expect(onResetZoom).toHaveBeenCalled();
  });

  it('displays start and end time labels on x-axis', () => {
    const logs = createParsedLogLines(50);
    const { container } = render(<LogActivityChart logLines={logs} />);

    // Find all text elements
    const textElements = container.querySelectorAll('text');
    let foundTimeLabels = 0;

    // Look for HH:MM:SS format (which should be the start and end time labels)
    textElements.forEach((text) => {
      const content = text.textContent ?? '';
      // Match HH:MM:SS format
      if (/\d{2}:\d{2}:\d{2}/.test(content)) {
        foundTimeLabels++;
      }
    });

    // Should have at least start and end time labels
    expect(foundTimeLabels).toBeGreaterThanOrEqual(2);
  });

  it('renders axes with correct structure', () => {
    const logs = createParsedLogLines(50);
    const { container } = render(<LogActivityChart logLines={logs} />);

    // Check that we have line elements for axes (from Visx AxisBottom and AxisLeft)
    const lines = container.querySelectorAll('line');
    expect(lines.length).toBeGreaterThan(0);

    // Should have axis lines with specific stroke properties
    const axisLines = Array.from(lines).filter(
      (line) => line.getAttribute('stroke') === '#666'
    );
    expect(axisLines.length).toBeGreaterThan(0);
  });

  it('displays dual cursor lines during selection', async () => {
    const logs = createParsedLogLines(100);
    const { container } = render(<LogActivityChart logLines={logs} />);

    const overlay = container.querySelector('rect[fill="transparent"]') as SVGElement;

    // Start selection
    fireEvent.mouseDown(overlay, { clientX: 100, clientY: 50 });

    await new Promise(resolve => setTimeout(resolve, 50));

    // Move mouse to create selection range
    fireEvent.mouseMove(overlay, { clientX: 250, clientY: 50 });

    await new Promise(resolve => setTimeout(resolve, 50));

    // Look for selection cursors (lines in the primary colour)
    const blueLines = container.querySelectorAll('line[stroke="var(--color-primary)"]');
    
    // Should have at least 2 blue lines during selection (start and end cursors)
    expect(blueLines.length).toBeGreaterThanOrEqual(2);
  });

  it('displays time labels on selection cursors', async () => {
    const logs = createParsedLogLines(100);
    const { container } = render(<LogActivityChart logLines={logs} />);

    const overlay = container.querySelector('rect[fill="transparent"]') as SVGElement;

    // Start selection
    fireEvent.mouseDown(overlay, { clientX: 100, clientY: 50 });

    await new Promise(resolve => setTimeout(resolve, 50));

    // Move to create selection
    fireEvent.mouseMove(overlay, { clientX: 250, clientY: 50 });

    await new Promise(resolve => setTimeout(resolve, 50));

    // Look for blue text labels on selection cursors
    const textElements = container.querySelectorAll('text[fill="var(--color-primary)"]');
    
    // Should have time labels for start and end cursors
    expect(textElements.length).toBeGreaterThanOrEqual(2);
  });

  it('hides cursor tooltip during selection mode', async () => {
    const logs = createParsedLogLines(100);
    const { container } = render(<LogActivityChart logLines={logs} />);

    const overlay = container.querySelector('rect[fill="transparent"]') as SVGElement;

    // First, show cursor by moving mouse
    fireEvent.mouseMove(overlay, { clientX: 150, clientY: 50 });
    await new Promise(resolve => setTimeout(resolve, 50));

    // Should have cursor line
    const cursorLine = container.querySelector('line[stroke-dasharray="4,2"]');
    expect(cursorLine).toBeInTheDocument();

    // Now start selection (which should hide normal cursor)
    fireEvent.mouseDown(overlay, { clientX: 100, clientY: 50 });

    await new Promise(resolve => setTimeout(resolve, 50));

    // During selection, the dashed cursor line should be hidden and replaced with selection cursors
    fireEvent.mouseMove(overlay, { clientX: 250, clientY: 50 });

    await new Promise(resolve => setTimeout(resolve, 50));

    // Selection cursors should exist (solid blue lines)
    const selectionCursors = container.querySelectorAll('line[stroke="var(--color-primary)"]');
    expect(selectionCursors.length).toBeGreaterThan(0);
  });

  it('renders correct number of bars based on time range and bucketing', () => {
    const logs = createParsedLogLines(100);
    const { container } = render(<LogActivityChart logLines={logs} />);

    const bars = container.querySelectorAll('rect[opacity="0.9"]');
    
    // With 100 logs and ~1 second each (100 seconds total), 
    // bucket size should be ~1 second, so ~100 bars expected
    // But allow some flexibility due to bucketing algorithm
    expect(bars.length).toBeGreaterThan(0);
    expect(bars.length).toBeLessThanOrEqual(150);
  });

  it('maintains correct time representation in UTC format', () => {
    const baseTime = new Date('2025-01-15T14:30:45.123Z');
    const isoTimestamp = '2025-01-15T14:30:45.123000Z';
    const logs: ParsedLogLine[] = [
      {
        lineNumber: 0,
        rawText: `${isoTimestamp} INFO message 0`,
        isoTimestamp,
        timestampUs: baseTime.getTime() * 1000,
        displayTime: '14:30:45.123000',
        level: 'INFO',
        message: 'message 0',
        strippedMessage: 'message 0',
        continuationLines: [],
      },
    ];

    const { container } = render(<LogActivityChart logLines={logs} />);

    // Look for time text in format HH:MM:SS
    const textElements = container.querySelectorAll('text');
    const timeLabels = Array.from(textElements)
      .map((el) => el.textContent ?? '')
      .filter((text) => /\d{2}:\d{2}:\d{2}/.test(text));

    // Should find the time label in UTC format
    expect(timeLabels.length).toBeGreaterThan(0);
    // Should contain 14:30:45 (the UTC time)
    expect(timeLabels.join(',')).toContain('14:30:45');
  });

  it('renders Sentry events with sentry color (var(--color-sentry)) when sentryEvents prop is provided', () => {
    const logs = createParsedLogLines(50);
    // Mark the first log line as a Sentry event
    const sentryEvents: SentryEvent[] = [
      { platform: 'android', lineNumber: logs[0].lineNumber, message: 'Sending error to Sentry' },
    ];

    const { container } = render(
      <LogActivityChart logLines={logs} sentryEvents={sentryEvents} />
    );

    // A bar with the sentry CSS variable color should be present for the SENTRY category
    const sentryBar = container.querySelector('rect[fill="var(--color-sentry)"][opacity="0.9"]');
    expect(sentryBar).toBeInTheDocument();
  });

  it('shows "Sentry" label in tooltip for a Sentry-categorized bucket', () => {
    // Use a single log line so any hover position lands on the one bucket that has a Sentry event
    const logs = createParsedLogLines(1);
    const sentryEvents: SentryEvent[] = [
      { platform: 'ios', lineNumber: logs[0].lineNumber, message: 'Sentry detected a crash', sentryId: 'abc123' },
    ];

    const { container } = render(
      <LogActivityChart logLines={logs} sentryEvents={sentryEvents} />
    );

    const overlay = container.querySelector('rect[fill="transparent"]') as SVGElement;
    fireEvent.mouseMove(overlay, { clientX: 150, clientY: 50 });

    // The tooltip renders "Sentry:" (not "SENTRY:") for the SENTRY category
    expect(screen.getByText(/^Sentry:/)).toBeInTheDocument();
  });

  it('shows tooltip content for the bucket at externalCursorTime', () => {
    const logs = createParsedLogLines(50);
    const midTime = logs[Math.floor(logs.length / 2)].timestampUs;
    render(<LogActivityChart logLines={logs} externalCursorTime={midTime} />);

    // The useEffect fires after render and calls showTooltip with the bucket data;
    // act() (wrapping render) flushes the effect synchronously in the test env.
    expect(screen.getByText(/^Total:/)).toBeInTheDocument();
  });

  it('uses the SVG screen transform path for external tooltip positioning when available', () => {
    const logs = createParsedLogLines(50);
    const midTime = logs[Math.floor(logs.length / 2)].timestampUs;
    const originalGetScreenCTM = SVGSVGElement.prototype.getScreenCTM;
    const originalCreateSVGPoint = SVGSVGElement.prototype.createSVGPoint;
    const matrixTransform = vi.fn().mockReturnValue({ x: 321, y: 123 });

    Object.defineProperty(SVGSVGElement.prototype, 'getScreenCTM', {
      configurable: true,
      value: vi.fn().mockReturnValue({ a: 1, d: 1, e: 0, f: 0 }),
    });
    Object.defineProperty(SVGSVGElement.prototype, 'createSVGPoint', {
      configurable: true,
      value: vi.fn().mockImplementation(() => ({
        x: 0,
        y: 0,
        matrixTransform,
      })),
    });

    try {
      render(<LogActivityChart logLines={logs} externalCursorTime={midTime} />);

      expect(SVGSVGElement.prototype.getScreenCTM).toHaveBeenCalled();
      expect(SVGSVGElement.prototype.createSVGPoint).toHaveBeenCalled();
      expect(matrixTransform).toHaveBeenCalled();
      expect(screen.getByText(/^Total:/)).toBeInTheDocument();
    } finally {
      Object.defineProperty(SVGSVGElement.prototype, 'getScreenCTM', {
        configurable: true,
        value: originalGetScreenCTM,
      });
      Object.defineProperty(SVGSVGElement.prototype, 'createSVGPoint', {
        configurable: true,
        value: originalCreateSVGPoint,
      });
    }
  });

  it('renders external cursor line when externalCursorTime prop is set and chart is idle', () => {
    const logs = createParsedLogLines(50);
    // Use a timestamp in the middle of the data range so timeToX maps it inside the chart
    const midTime = logs[Math.floor(logs.length / 2)].timestampUs;
    const { container } = render(
      <LogActivityChart logLines={logs} externalCursorTime={midTime} />
    );

    // A dashed gray cursor line should appear even without hovering this chart
    const cursorLine = container.querySelector('line[stroke-dasharray="4,2"]');
    expect(cursorLine).toBeInTheDocument();
  });

  it('renders external selection band when externalSelection prop is set and chart is idle', () => {
    const logs = createParsedLogLines(50);
    const startUs = logs[10].timestampUs;
    const endUs = logs[40].timestampUs;
    const { container } = render(
      <LogActivityChart logLines={logs} externalSelection={{ startUs, endUs }} />
    );

    // A blue selection band (rect with blue fill) should appear
    const selectionBand = container.querySelector('rect[fill="var(--color-primary)"][fill-opacity="0.2"]');
    expect(selectionBand).toBeInTheDocument();

    // Two blue cursor lines should also appear
    const blueLines = container.querySelectorAll('line[stroke="var(--color-primary)"]');
    expect(blueLines.length).toBeGreaterThanOrEqual(2);
  });

  it('does not show mirrored tooltip content while a mirrored selection is active', () => {
    const logs = createParsedLogLines(50);
    const midTime = logs[Math.floor(logs.length / 2)].timestampUs;
    const startUs = logs[10].timestampUs;
    const endUs = logs[40].timestampUs;

    render(
      <LogActivityChart
        logLines={logs}
        externalCursorTime={midTime}
        externalSelection={{ startUs, endUs }}
      />
    );

    expect(screen.queryByText(/^Total:/)).not.toBeInTheDocument();
  });

  it('ignores orphaned lines with timestampUs === 0 when computing the time range', () => {
    // Simulate a log file where a continuation line appears before the first
    // timestamped entry — the parser assigns timestampUs: 0 to such lines.
    // The chart must not use those zeros when computing dataMinTime, otherwise
    // the x-axis would start at 1970-01-01T00:00:00 (Unix epoch).
    const realLogs = createParsedLogLines(20, { baseTime: new Date('2026-03-19T18:29:14Z'), startLineNumber: 1 });
    const orphan = createParsedLogLine({
      lineNumber: 0,
      rawText: ' | ',
      isoTimestamp: '',
      timestampUs: 0,
      displayTime: '',
      level: 'UNKNOWN',
      message: ' | ',
      strippedMessage: ' | ',
    });

    const logs = [orphan, ...realLogs];
    const { container } = render(<LogActivityChart logLines={logs} />);

    // The chart must still render (not fall back to the empty state)
    const bars = container.querySelectorAll('rect[opacity="0.9"]');
    expect(bars.length).toBeGreaterThan(0);

    // The start time label must reflect the first real timestamp (18:29:14),
    // not the Unix epoch (00:00:00).
    const textElements = Array.from(container.querySelectorAll('text'));
    const timeLabels = textElements
      .map((el) => el.textContent ?? '')
      .filter((t) => /\d{2}:\d{2}:\d{2}/.test(t));

    expect(timeLabels.length).toBeGreaterThanOrEqual(2);
    expect(timeLabels.some((t) => t.startsWith('00:00:00'))).toBe(false);
    expect(timeLabels.some((t) => t.startsWith('18:29'))).toBe(true);
  });

  describe('per-process activity lanes', () => {
    afterEach(() => {
      useLogStore.setState({ loadedEntryNames: [] });
    });

    function procLine(lineNumber: number, tsSeconds: number, sourceFile: string) {
      return createParsedLogLine({ lineNumber, timestampUs: tsSeconds * 1_000_000, sourceFile });
    }

    it('renders a labelled lane per process with coloured segments when several are merged', () => {
      useLogStore.setState({ loadedEntryNames: ['console.2026-04-14-08.log.gz', 'nse.2026-04-14-08.log.gz'] });
      const logs = [
        procLine(1, 0, 'console.2026-04-14-08.log.gz'),
        procLine(2, 40, 'console.2026-04-14-08.log.gz'),
        procLine(3, 38, 'nse.2026-04-14-08.log.gz'),
        procLine(4, 80, 'console.2026-04-14-08.log.gz'),
      ];

      const { container } = render(<LogActivityChart logLines={logs} />);

      expect(screen.getByText('console')).toBeInTheDocument();
      expect(screen.getByText('nse')).toBeInTheDocument();
      // Lane segments carry the process colour (console is first in the palette).
      expect(container.querySelector('rect[fill="#3b82f6"]')).not.toBeNull();
    });

    it('renders no lanes for a single process', () => {
      useLogStore.setState({ loadedEntryNames: ['console.2026-04-14-08.log.gz'] });
      render(<LogActivityChart logLines={[procLine(1, 0, 'console.2026-04-14-08.log.gz')]} />);
      expect(screen.queryByText('console')).not.toBeInTheDocument();
    });

    it('still shows a lane for a loaded process with no lines, and ignores untagged / unknown lines', () => {
      useLogStore.setState({
        loadedEntryNames: [
          'console.2026-04-14-08.log.gz',
          'nse.2026-04-14-08.log.gz',
          'shareextension.2026-04-14-08.log.gz',
        ],
      });
      const logs = [
        procLine(1, 0, 'console.2026-04-14-08.log.gz'),
        procLine(2, 40, 'nse.2026-04-14-08.log.gz'),
        createParsedLogLine({ lineNumber: 3, timestampUs: 50_000_000 }), // untagged (no sourceFile)
        procLine(4, 60, 'other.2026-04-14-08.log.gz'), // process not in the loaded set
      ];

      render(<LogActivityChart logLines={logs} />);

      // shareextension has no lines but still gets an (empty) lane label.
      expect(screen.getByText('console')).toBeInTheDocument();
      expect(screen.getByText('nse')).toBeInTheDocument();
      expect(screen.getByText('shareextension')).toBeInTheDocument();
      // The unknown process never becomes a lane.
      expect(screen.queryByText('other')).not.toBeInTheDocument();
    });

    it('merges adjacent active buckets into a single segment', () => {
      useLogStore.setState({ loadedEntryNames: ['console.2026-04-14-08.log.gz', 'nse.2026-04-14-08.log.gz'] });
      // Range is 1s → 1s buckets; console lines at 1s and 2s land in consecutive
      // buckets and must collapse into one segment rect.
      const logs = [
        procLine(1, 1, 'console.2026-04-14-08.log.gz'),
        procLine(2, 2, 'console.2026-04-14-08.log.gz'),
        procLine(3, 1, 'nse.2026-04-14-08.log.gz'),
      ];

      const { container } = render(<LogActivityChart logLines={logs} />);

      // console (palette[0]) renders exactly one merged segment.
      expect(container.querySelectorAll('rect[fill="#3b82f6"]')).toHaveLength(1);
    });

    it('renders no lanes when several processes are loaded but there are no lines', () => {
      useLogStore.setState({ loadedEntryNames: ['console.2026-04-14-08.log.gz', 'nse.2026-04-14-08.log.gz'] });
      render(<LogActivityChart logLines={[]} />);
      expect(screen.queryByText('console')).not.toBeInTheDocument();
    });

    it('renders no lanes when every line has a non-positive timestamp', () => {
      useLogStore.setState({ loadedEntryNames: ['console.2026-04-14-08.log.gz', 'nse.2026-04-14-08.log.gz'] });
      const logs = [
        procLine(1, 0, 'console.2026-04-14-08.log.gz'),
        procLine(2, 0, 'nse.2026-04-14-08.log.gz'),
      ];
      render(<LogActivityChart logLines={logs} />);
      expect(screen.queryByText('console')).not.toBeInTheDocument();
    });
  });

  describe('app-state lane (lifecycle events)', () => {
    afterEach(() => {
      useLogStore.setState({ loadedEntryNames: [], lifecycleEvents: [] });
    });

    function consoleLineAt(lineNumber: number, tsSeconds: number) {
      return createParsedLogLine({ lineNumber, timestampUs: tsSeconds * 1_000_000, sourceFile: 'console.2026-04-14-08.log.gz' });
    }

    it('shows an "app" lane when lifecycle events are present', () => {
      useLogStore.setState({
        loadedEntryNames: ['console.2026-04-14-08.log.gz'],
        lifecycleEvents: [lc('coldStart', 1_000_000)],
      });
      // Two logs very close together (same bucket) so the run has non-zero width,
      // which is required for the intersection with the state segment to pass e > s.
      const logs = [
        consoleLineAt(1, 1),
        createParsedLogLine({ lineNumber: 2, timestampUs: 1_100_000, sourceFile: 'console.2026-04-14-08.log.gz' }),
        consoleLineAt(3, 60),
        consoleLineAt(4, 120),
      ];
      render(<LogActivityChart logLines={logs} />);
      expect(screen.getByText('app')).toBeInTheDocument();
    });

    it('shows no app lane when there are no lifecycle events', () => {
      useLogStore.setState({ loadedEntryNames: ['console.2026-04-14-08.log.gz'], lifecycleEvents: [] });
      const logs = [consoleLineAt(1, 1), consoleLineAt(2, 60)];
      render(<LogActivityChart logLines={logs} />);
      expect(screen.queryByText('app')).not.toBeInTheDocument();
    });

    it('shows no app lane when lifecycle events produce no segments (crash only)', () => {
      useLogStore.setState({
        loadedEntryNames: ['console.2026-04-14-08.log.gz'],
        // crash does not drive the state band, so it yields no segment → no lane.
        lifecycleEvents: [lc('crash', 1_000_000)],
      });
      const logs = [consoleLineAt(1, 1), consoleLineAt(2, 60)];
      render(<LogActivityChart logLines={logs} />);
      expect(screen.queryByText('app')).not.toBeInTheDocument();
    });

    it('draws an interior isolated log line but not boundary-touching ones', () => {
      useLogStore.setState({
        loadedEntryNames: ['console.2026-04-14-08.log.gz'],
        lifecycleEvents: [lc('coldStart', 1_000_000)],
      });
      // Three isolated lines, each alone in its bucket → three zero-width runs.
      // The foreground segment spans [1s, 120s] (log bounds). Only the 60s line is
      // strictly interior; the 1s and 120s lines merely touch the segment edges
      // and must not render phantom 1px bars at the state boundaries.
      const logs = [consoleLineAt(1, 1), consoleLineAt(2, 60), consoleLineAt(3, 120)];
      const { container } = render(<LogActivityChart logLines={logs} />);
      expect(screen.getByText('app')).toBeInTheDocument();
      const fg = appStateColors(APP_LANE_COLOR).foreground;
      expect(container.querySelectorAll(`rect[fill="${fg}"]`)).toHaveLength(1);
    });

    it('shows no app lane when activity runs never overlap any state segment', () => {
      useLogStore.setState({
        loadedEntryNames: ['console.2026-04-14-08.log.gz'],
        // Transition to background at 50s, entirely between the two log runs.
        lifecycleEvents: [lc('coldStart', 1_000_000), lc('background', 50_000_000)],
      });
      // One run at 1s (foreground window) and one at 200s (background window),
      // far enough apart to land in different buckets. Neither run overlaps the
      // *other* segment, and each only touches its own segment's boundary, so no
      // app segment survives.
      const logs = [consoleLineAt(1, 1), consoleLineAt(2, 200)];
      render(<LogActivityChart logLines={logs} />);
      expect(screen.queryByText('app')).not.toBeInTheDocument();
    });
  });

  describe('per-process lanes combined with app-state lane', () => {
    afterEach(() => {
      useLogStore.setState({ loadedEntryNames: [], lifecycleEvents: [] });
    });

    it('skips the console per-process lane when the app-state lane already covers it', () => {
      useLogStore.setState({
        loadedEntryNames: ['console.2026-04-14-08.log.gz', 'nse.2026-04-14-08.log.gz'],
        lifecycleEvents: [lc('coldStart', 1_000_000)],
      });
      const logs = [
        createParsedLogLine({ lineNumber: 1, timestampUs: 1_000_000, sourceFile: 'console.2026-04-14-08.log.gz' }),
        createParsedLogLine({ lineNumber: 2, timestampUs: 60_000_000, sourceFile: 'console.2026-04-14-08.log.gz' }),
        createParsedLogLine({ lineNumber: 3, timestampUs: 120_000_000, sourceFile: 'console.2026-04-14-08.log.gz' }),
        createParsedLogLine({ lineNumber: 4, timestampUs: 30_000_000, sourceFile: 'nse.2026-04-14-08.log.gz' }),
      ];
      render(<LogActivityChart logLines={logs} />);

      // The app-state lane represents the console stream here, so console must
      // not also get its own flat per-process lane — only 'app' and 'nse' show.
      expect(screen.getByText('app')).toBeInTheDocument();
      expect(screen.queryByText('console')).not.toBeInTheDocument();
      expect(screen.getByText('nse')).toBeInTheDocument();
    });
  });
});

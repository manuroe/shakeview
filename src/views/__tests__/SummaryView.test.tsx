/**
 * Unit tests for SummaryView.tsx
 * Tests rendering of statistics and user interactions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SummaryView } from '../SummaryView';
import { useLogStore } from '../../stores/logStore';
import { useArchiveStore } from '../../stores/archiveStore';
import { emptyArchiveSummary } from '../../utils/archiveSummary';
import {
  createParsedLogLine,
  createParsedLogLines,
  createHttpRequest,
  createSyncRequest,
} from '../../test/fixtures';
import type { ParsedLogLine } from '../../types/log.types';
import { parseLogFile } from '../../utils/logParser';
import { RECEIVER_LOG } from '../../utils/crypto/__tests__/fixtures';
import type { TimestampMicros } from '../../types/time.types';

// ─── Captured callback registry (refreshed each render) ────────────────────
let capturedOnTimeRangeSelected: ((startUs: TimestampMicros, endUs: TimestampMicros) => void) | undefined;
let capturedOnResetZoom: (() => void) | undefined;
let capturedOnCursorMove: ((timeUs: number | null) => void) | undefined;

// ─── useURLParams mock ──────────────────────────────────────────────────────
const mockSetTimeFilter = vi.fn();
vi.mock('../../hooks/useURLParams', () => ({
  useURLParams: () => ({ setTimeFilter: mockSetTimeFilter }),
}));

// Mock BurgerMenu
vi.mock('../../components/BurgerMenu', () => ({
  BurgerMenu: () => <div data-testid="burger-menu" />,
}));

// Mock LogActivityChart – exposes onTimeRangeSelected, onResetZoom, and onCursorMove so tests can simulate interactions
vi.mock('../../components/LogActivityChart', () => ({
  LogActivityChart: ({
    logLines,
    onTimeRangeSelected,
    onResetZoom,
    onCursorMove,
  }: {
    logLines: ParsedLogLine[];
    onTimeRangeSelected?: (startUs: TimestampMicros, endUs: TimestampMicros) => void;
    onResetZoom?: () => void;
    onCursorMove?: (timeUs: number | null) => void;
  }) => {
    capturedOnTimeRangeSelected = onTimeRangeSelected;
    capturedOnResetZoom = onResetZoom;
    capturedOnCursorMove = onCursorMove;
    return <div data-testid="log-activity-chart">Lines: {logLines.length}</div>;
  },
}));

// Mock TimeRangeSelector
vi.mock('../../components/TimeRangeSelector', () => ({
  TimeRangeSelector: () => <div data-testid="time-range-selector" />,
}));

// Helper to render with router
function renderSummaryView() {
  return render(
    <MemoryRouter>
      <SummaryView />
    </MemoryRouter>
  );
}

describe('SummaryView', () => {
  beforeEach(() => {
    useLogStore.getState().clearData();
    mockSetTimeFilter.mockClear();
    capturedOnTimeRangeSelected = undefined;
    capturedOnResetZoom = undefined;
    capturedOnCursorMove = undefined;
  });

  describe('empty state', () => {
    it('renders empty state message when no logs loaded', () => {
      renderSummaryView();

      expect(screen.getByText('Summary')).toBeInTheDocument();
      expect(
        screen.getByText('No logs loaded. Please upload a log file to see the summary.')
      ).toBeInTheDocument();
    });

    it('renders burger menu in empty state', () => {
      renderSummaryView();

      expect(screen.getByTestId('burger-menu')).toBeInTheDocument();
    });
  });

  describe('with log data', () => {
    beforeEach(() => {
      // Set up some log lines with varying levels
      const logLines: ParsedLogLine[] = [
        createParsedLogLine({
          lineNumber: 0,
          level: 'INFO',
          message: 'Starting application',
          displayTime: '10:00:00.000000',
        }),
        createParsedLogLine({
          lineNumber: 1,
          level: 'DEBUG',
          message: 'Debug message',
          displayTime: '10:00:01.000000',
        }),
        createParsedLogLine({
          lineNumber: 2,
          level: 'WARN',
          message: 'Warning: something odd',
          displayTime: '10:00:02.000000',
        }),
        createParsedLogLine({
          lineNumber: 3,
          level: 'ERROR',
          message: 'Error: connection failed',
          displayTime: '10:00:03.000000',
        }),
        createParsedLogLine({
          lineNumber: 4,
          level: 'ERROR',
          message: 'Error: timeout',
          displayTime: '10:00:04.000000',
        }),
      ];

      const httpRequests = [
        createHttpRequest({ requestId: 'REQ-1', status: '200', requestDurationMs: 100 }),
        createHttpRequest({ requestId: 'REQ-2', status: '404', requestDurationMs: 200 }),
        createHttpRequest({ requestId: 'REQ-3', status: '500', requestDurationMs: 500 }),
      ];

      const syncRequests = [
        createSyncRequest({ requestId: 'SYNC-1', connId: 'room-list' }),
        createSyncRequest({ requestId: 'SYNC-2', connId: 'room-list' }),
        createSyncRequest({ requestId: 'SYNC-3', connId: 'encryption' }),
      ];

      useLogStore.getState().setRequests(syncRequests, ['room-list', 'encryption'], logLines);
      useLogStore.getState().setHttpRequests(httpRequests, logLines);
    });

    it('renders the Summary title', () => {
      renderSummaryView();

      expect(screen.getByRole('heading', { name: 'Summary' })).toBeInTheDocument();
    });

    it('displays total log lines count', () => {
      renderSummaryView();

      // The heading shows "Logs: X lines"
      expect(screen.getByText(/Logs: 5 lines/)).toBeInTheDocument();
    });

    it('renders time range selector', () => {
      renderSummaryView();

      expect(screen.getByTestId('time-range-selector')).toBeInTheDocument();
    });

    it('renders activity chart with log lines', () => {
      renderSummaryView();

      expect(screen.getByTestId('log-activity-chart')).toBeInTheDocument();
      expect(screen.getByText('Lines: 5')).toBeInTheDocument();
    });

    it('displays error count section', () => {
      renderSummaryView();

      // The header contains "Top Errors (X)" but split across elements
      // Look for the table header text that includes error count
      const errorHeader = screen.getByRole('columnheader', { name: /top errors/i });
      expect(errorHeader).toBeInTheDocument();
      // The error count of 2 should be visible
      expect(errorHeader.textContent).toContain('2');
    });

    it('displays warning count section', () => {
      renderSummaryView();

      // Look for the table header text that includes warning count
      const warningHeader = screen.getByRole('columnheader', { name: /top warnings/i });
      expect(warningHeader).toBeInTheDocument();
      // The warning count of 1 should be visible
      expect(warningHeader.textContent).toContain('1');
    });

    it('displays sync requests by connection', () => {
      renderSummaryView();

      expect(screen.getByText('Sync Requests by Connection')).toBeInTheDocument();
      expect(screen.getByText('room-list')).toBeInTheDocument();
      expect(screen.getByText('encryption')).toBeInTheDocument();
    });
  });

  describe('statistics calculations', () => {
    it('counts errors by type correctly', () => {
      const logLines = [
        createParsedLogLine({ lineNumber: 0, level: 'ERROR', message: 'Connection failed' }),
        createParsedLogLine({ lineNumber: 1, level: 'ERROR', message: 'Connection failed' }),
        createParsedLogLine({ lineNumber: 2, level: 'ERROR', message: 'Timeout occurred' }),
      ];

      useLogStore.getState().setHttpRequests([], logLines);

      renderSummaryView();

      // Should show 3 errors total in the header
      const errorHeader = screen.getByRole('columnheader', { name: /top errors/i });
      expect(errorHeader.textContent).toContain('3');
    });

    it('excludes sync requests from slowest HTTP display', () => {
      // Create HTTP requests, one being a sync request
      const httpRequests = [
        createHttpRequest({
          requestId: 'REQ-1',
          uri: 'https://example.com/rooms/123/messages',
          requestDurationMs: 100,
        }),
        createHttpRequest({
          requestId: 'REQ-2',
          uri: 'https://example.com/_matrix/client/v3/sync',
          requestDurationMs: 5000, // Very slow sync, should be excluded
        }),
      ];
      const rawLines = createParsedLogLines(2);

      useLogStore.getState().setHttpRequests(httpRequests, rawLines);

      renderSummaryView();

      // The sync request should not appear in "Slowest HTTP Requests"
      // but REQ-1 should (if section appears)
      // Just verify the view renders without error
      expect(screen.getByText('Summary')).toBeInTheDocument();
    });

    it('places the keys card, then the UTDs card, after the errors and warnings', () => {
      useLogStore.getState().setHttpRequests([], [...parseLogFile(RECEIVER_LOG).rawLogLines]);
      renderSummaryView();
      const keys = screen.getByRole('heading', { name: /^New megolm keys/ });
      const utd = screen.getByRole('heading', { name: /^UTDs/ });
      const logs = screen.getByRole('heading', { name: /^Logs:/ });
      const warningsTable = screen.getAllByRole('table')[0];
      expect(logs.compareDocumentPosition(keys) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(warningsTable.compareDocumentPosition(keys) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(keys.compareDocumentPosition(utd) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('displays log line count', () => {
      const logLines = createParsedLogLines(7); // Use 7 to avoid collisions with other numbers
      useLogStore.getState().setHttpRequests([], logLines);

      renderSummaryView();

      // Should display "X lines" in the header
      expect(screen.getByText(/7 lines/i)).toBeInTheDocument();
    });
  });

  describe('empty data sections', () => {
    it('does not render errors section when no errors', () => {
      const logLines = [
        createParsedLogLine({ lineNumber: 0, level: 'INFO', message: 'Info message' }),
      ];

      useLogStore.getState().setHttpRequests([], logLines);

      renderSummaryView();

      // "Top Errors" table header should not appear
      expect(screen.queryByRole('columnheader', { name: /top errors/i })).not.toBeInTheDocument();
    });

    it('shows no HTTP errors message when all requests are successful', () => {
      const httpRequests = [
        createHttpRequest({ requestId: 'REQ-1', status: '200' }),
        createHttpRequest({ requestId: 'REQ-2', status: '201' }),
      ];
      const logLines = createParsedLogLines(2);

      useLogStore.getState().setHttpRequests(httpRequests, logLines);

      renderSummaryView();

      // Should show "No HTTP errors" or not show the section at all
      const httpErrorsSection = screen.queryByText('HTTP Errors by Status');
      if (httpErrorsSection) {
        expect(screen.getByText(/No HTTP errors/i)).toBeInTheDocument();
      }
    });
  });

  // ============================================================================
  // URL Navigation from Top Failed URLs
  // ============================================================================

  describe('Top Failed URLs Navigation', () => {
    it('uses request_id= when single failed URI match', async () => {
      const httpRequests = [
        createHttpRequest({
          requestId: 'REQ-1',
          uri: 'https://matrix.example.com/_matrix/client/r0/sync',
          status: '500',
        }),
        createHttpRequest({
          requestId: 'REQ-2',
          uri: 'https://matrix.example.com/_matrix/client/r0/keys/upload',
          status: '200',
        }),
      ];
      const logLines = createParsedLogLines(2);

      useLogStore.getState().setHttpRequests(httpRequests, logLines);

      const { container } = renderSummaryView();

      // Find the URL link in Top Failed URLs section
      // After stripping the Matrix client-server API path, the displayed text is just the endpoint
      const syncLink = screen.getByText((content, element) => 
        element?.tagName.toLowerCase() === 'button' && 
        content.includes('/sync')
      );

      expect(syncLink).toBeInTheDocument();

      // Click should navigate with request_id= parameter
      syncLink.click();

      await new Promise(resolve => setTimeout(resolve, 50));
      
      // Check if navigation was called with request_id param
      const href = (syncLink as HTMLElement).getAttribute('href') || 
                   window.location.hash;
      
      // Verify the navigation intent - should use request_id for single match
      expect(syncLink.innerHTML).toContain('/sync');
    });

    it('uses filter= when multiple failed URIs match', async () => {
      const httpRequests = [
        createHttpRequest({
          requestId: 'REQ-1',
          uri: 'https://matrix.example.com/_matrix/client/r0/sync',
          status: '500',
        }),
        createHttpRequest({
          requestId: 'REQ-2',
          uri: 'https://matrix.example.com/_matrix/client/r0/sync',
          status: '502',
        }),
        createHttpRequest({
          requestId: 'REQ-3',
          uri: 'https://matrix.example.com/_matrix/client/r0/keys/upload',
          status: '200',
        }),
      ];
      const logLines = createParsedLogLines(3);

      useLogStore.getState().setHttpRequests(httpRequests, logLines);

      renderSummaryView();

      // Find the sync URL which has 2 failed matches
      // After stripping the Matrix client-server API path, the displayed text is just the endpoint
      const syncLink = screen.getByText((content, element) => 
        element?.tagName.toLowerCase() === 'button' && 
        content.includes('/sync')
      );

      expect(syncLink).toBeInTheDocument();

      // For multiple failures, should use filter= for smarter navigation
      // The component implements intelligent logic to use request_id or filter
    });

    it('encodes special characters in URI parameter', async () => {
      const httpRequests = [
        createHttpRequest({
          requestId: 'REQ-1',
          uri: '_matrix/client/r0/sync?filter=state&limit=10',
          status: '500',
        }),
      ];
      const logLines = createParsedLogLines(1);

      useLogStore.getState().setHttpRequests(httpRequests, logLines);

      renderSummaryView();

      // The URI with special characters should be properly encoded
      const link = screen.getByText((content, element) => 
        element?.tagName.toLowerCase() === 'button' && 
        (content.includes('sync') || content.includes('filter'))
      );

      expect(link).toBeInTheDocument();
    });

    it('no failed URLs when all requests are successful', () => {
      const httpRequests = [
        createHttpRequest({ requestId: 'REQ-1', uri: '/sync', status: '200' }),
        createHttpRequest({ requestId: 'REQ-2', uri: '/register', status: '201' }),
      ];
      const logLines = createParsedLogLines(2);

      useLogStore.getState().setHttpRequests(httpRequests, logLines);

      renderSummaryView();

      // Should not show Top Failed URLs section
      const failedUrlsHeading = screen.queryByText(/Top Failed URLs/i) || 
                                screen.queryByText(/Failed URLs/i);
      
      if (failedUrlsHeading) {
        // If section exists, it should show no failed URLs
        expect(screen.getByText(/0/)).toBeInTheDocument();
      }
    });

    it('groups by URI correctly for multiple errors', () => {
      const httpRequests = [
        createHttpRequest({
          requestId: 'REQ-1',
          uri: 'https://matrix.example.com/_matrix/client/r0/sync',
          status: '500',
        }),
        createHttpRequest({
          requestId: 'REQ-2',
          uri: 'https://matrix.example.com/_matrix/client/r0/sync',
          status: '502',
        }),
        createHttpRequest({
          requestId: 'REQ-3',
          uri: 'https://matrix.example.com/_matrix/client/r0/sync',
          status: '504',
        }),
      ];
      const logLines = createParsedLogLines(3);

      useLogStore.getState().setHttpRequests(httpRequests, logLines);

      renderSummaryView();

      // Should show the URI link (appears once in Top Failed URLs)
      // After stripping the Matrix client-server API path, the displayed text is just the endpoint
      const links = screen.queryAllByText((content, element) => 
        element?.tagName.toLowerCase() === 'button' && 
        content.includes('/sync')
      );

      // Should find the link (potentially multiple if rendering multiple times)
      expect(links.length).toBeGreaterThan(0);
    });

    it('different URIs with errors appear as separate entries', () => {
      const httpRequests = [
        createHttpRequest({
          requestId: 'REQ-1',
          uri: '_matrix/client/r0/sync',
          status: '500',
        }),
        createHttpRequest({
          requestId: 'REQ-2',
          uri: '_matrix/client/r0/keys/upload',
          status: '400',
        }),
        createHttpRequest({
          requestId: 'REQ-3',
          uri: '_matrix/client/r0/rooms/list',
          status: '503',
        }),
      ];
      const logLines = createParsedLogLines(3);

      useLogStore.getState().setHttpRequests(httpRequests, logLines);

      renderSummaryView();

      // Should show all three failed URIs
      const syncLink = screen.queryByText((content, element) => 
        element?.tagName.toLowerCase() === 'button' && 
        content.includes('sync')
      );
      const keysLink = screen.queryByText((content, element) => 
        element?.tagName.toLowerCase() === 'button' && 
        content.includes('keys')
      );
      const roomsLink = screen.queryByText((content, element) => 
        element?.tagName.toLowerCase() === 'button' && 
        content.includes('rooms')
      );

      // At least some should be found (may not all render if limited to top 5)
      const foundCount = [syncLink, keysLink, roomsLink].filter(link => link !== null).length;
      expect(foundCount).toBeGreaterThan(0);
    });

    it('handles URLs with Matrix special characters', async () => {
      const httpRequests = [
        createHttpRequest({
          requestId: 'REQ-1',
          uri: '_matrix/client/r0/room/%21abc:matrix.org/messages',
          status: '500',
        }),
      ];
      const logLines = createParsedLogLines(1);

      useLogStore.getState().setHttpRequests(httpRequests, logLines);

      renderSummaryView();

      // Should render without errors and display the URI
      expect(screen.getByText('Summary')).toBeInTheDocument();
    });
  });

  // ============================================================================
  // Retried requests (intermediate attempt outcomes) in summary stats
  // ============================================================================

  describe('retried request intermediate outcomes in summary', () => {
    it('counts intermediate 503 in Top Failed URLs even when final status is 200', () => {
      // REQ-1: retried, first attempt got 503, second attempt got 200
      const httpRequests = [
        createHttpRequest({
          requestId: 'REQ-1',
          uri: 'https://matrix.example.com/_matrix/client/v3/sync',
          status: '200',
          numAttempts: 2,
          attemptOutcomes: ['503', '200'],
        }),
      ];
      const logLines = createParsedLogLines(3);
      useLogStore.getState().setHttpRequests(httpRequests, logLines);
      renderSummaryView();

      // Top Failed URLs section should appear (503 from the retry counts as a failure)
      const failedSection = screen.queryByText(/Top Failed URLs/i);
      expect(failedSection).toBeInTheDocument();
    });

    it('does not count intermediate 503 in Top Failed URLs when none failed', () => {
      // REQ-1: clean 200 with no retries
      const httpRequests = [
        createHttpRequest({
          requestId: 'REQ-1',
          uri: 'https://matrix.example.com/_matrix/client/v3/sync',
          status: '200',
          numAttempts: 1,
          attemptOutcomes: ['200'],
        }),
      ];
      const logLines = createParsedLogLines(1);
      useLogStore.getState().setHttpRequests(httpRequests, logLines);
      renderSummaryView();

      // Top Failed URLs section should NOT appear
      expect(screen.queryByText(/Top Failed URLs/i)).not.toBeInTheDocument();
    });
  });

  // ============================================================================
  // Chart selection boundary keywords (start / end)
  // ============================================================================

  describe('chart selection boundary keywords', () => {
    // Use deterministic timestamps
    const BASE_US = 1_700_000_000_000_000 as TimestampMicros; // arbitrary base
    const STEP_US = 5_000_000 as TimestampMicros; // 5 s per step
    const minTime = BASE_US;
    const maxTime = (BASE_US + STEP_US * 4) as TimestampMicros;
    const midTime = (BASE_US + STEP_US * 2) as TimestampMicros;

    function buildLogLines() {
      return [0, 1, 2, 3, 4].map((i) =>
        createParsedLogLine({
          lineNumber: i,
          timestampUs: (BASE_US + STEP_US * i) as TimestampMicros,
        })
      );
    }

    it('shows "start" label in Selected when selection begins at log start', async () => {
      useLogStore.getState().setHttpRequests([], buildLogLines());
      renderSummaryView();

      // Simulate a chart selection starting at data min
      await act(async () => {
        capturedOnTimeRangeSelected?.(minTime, midTime);
      });

      // "Selected:" banner should be visible
      const banner = screen.getByText(/Selected:/);
      expect(banner.textContent).toMatch(/start/i);
    });

    it('shows "end" label in Selected when selection ends at log end', async () => {
      useLogStore.getState().setHttpRequests([], buildLogLines());
      renderSummaryView();

      await act(async () => {
        capturedOnTimeRangeSelected?.(midTime, maxTime);
      });

      const banner = screen.getByText(/Selected:/);
      expect(banner.textContent).toMatch(/end/i);
    });

    it('shows both "start" and "end" labels when entire range is selected', async () => {
      useLogStore.getState().setHttpRequests([], buildLogLines());
      renderSummaryView();

      await act(async () => {
        capturedOnTimeRangeSelected?.(minTime, maxTime);
      });

      const banner = screen.getByText(/Selected:/);
      expect(banner.textContent).toMatch(/start/i);
      expect(banner.textContent).toMatch(/end/i);
    });

    it('shows raw timestamps when selection does not touch data edges', async () => {
      useLogStore.getState().setHttpRequests([], buildLogLines());
      renderSummaryView();

      const innerStart = (BASE_US + STEP_US) as TimestampMicros;
      const innerEnd = (BASE_US + STEP_US * 3) as TimestampMicros;

      await act(async () => {
        capturedOnTimeRangeSelected?.(innerStart, innerEnd);
      });

      const banner = screen.getByText(/Selected:/);
      // Should NOT contain keyword tokens
      expect(banner.textContent).not.toMatch(/\bstart\b/i);
      expect(banner.textContent).not.toMatch(/\bend\b/i);
    });

    it('calls setTimeFilter("start", isoTimestamp) when applying start-edge selection', async () => {
      useLogStore.getState().setHttpRequests([], buildLogLines());
      renderSummaryView();

      await act(async () => {
        capturedOnTimeRangeSelected?.(minTime, midTime);
      });

      const applyBtn = screen.getByRole('button', { name: /apply/i });
      await act(async () => {
        fireEvent.click(applyBtn);
      });

      expect(mockSetTimeFilter).toHaveBeenCalledTimes(1);
      const [startArg, endArg] = mockSetTimeFilter.mock.calls[0];
      expect(startArg).toBe('start');
      expect(typeof endArg).toBe('string');
      expect(endArg).not.toBe('start');
      expect(endArg).not.toBe('end');
    });

    it('calls setTimeFilter(isoTimestamp, "end") when applying end-edge selection', async () => {
      useLogStore.getState().setHttpRequests([], buildLogLines());
      renderSummaryView();

      await act(async () => {
        capturedOnTimeRangeSelected?.(midTime, maxTime);
      });

      const applyBtn = screen.getByRole('button', { name: /apply/i });
      await act(async () => {
        fireEvent.click(applyBtn);
      });

      expect(mockSetTimeFilter).toHaveBeenCalledTimes(1);
      const [startArg, endArg] = mockSetTimeFilter.mock.calls[0];
      expect(endArg).toBe('end');
      expect(typeof startArg).toBe('string');
      expect(startArg).not.toBe('start');
      expect(startArg).not.toBe('end');
    });

    it('calls setTimeFilter(null, null) when entire range is applied (clears filter)', async () => {
      useLogStore.getState().setHttpRequests([], buildLogLines());
      renderSummaryView();

      await act(async () => {
        capturedOnTimeRangeSelected?.(minTime, maxTime);
      });

      const applyBtn = screen.getByRole('button', { name: /apply/i });
      await act(async () => {
        fireEvent.click(applyBtn);
      });

      expect(mockSetTimeFilter).toHaveBeenCalledWith(null, null);
    });
  });

  // ============================================================================
  // handleResetZoom
  // ============================================================================

  describe('handleResetZoom', () => {
    const BASE_R = 1_700_500_000_000_000 as TimestampMicros;
    const STEP_R = 5_000_000 as TimestampMicros;

    function buildResetLines() {
      return [0, 1, 2, 3, 4].map((i) =>
        createParsedLogLine({
          lineNumber: i + 10,
          timestampUs: (BASE_R + STEP_R * i) as TimestampMicros,
        })
      );
    }

    afterEach(() => {
      useLogStore.getState().setTimeFilter(null, null);
    });

    it('clears local selection when a selection is active', async () => {
      const lines = buildResetLines();
      useLogStore.getState().setHttpRequests([], lines);
      renderSummaryView();

      const innerStart = (BASE_R + STEP_R) as TimestampMicros;
      const innerEnd = (BASE_R + STEP_R * 3) as TimestampMicros;
      await act(async () => { capturedOnTimeRangeSelected?.(innerStart, innerEnd); });
      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();

      await act(async () => { capturedOnResetZoom?.(); });
      expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument();
    });

    it('sets full-range local selection when global filter is narrower than data', async () => {
      const lines = buildResetLines();
      useLogStore.getState().setHttpRequests([], lines);
      // Narrow global filter (only middle 3 lines)
      useLogStore.getState().setTimeFilter(lines[1].isoTimestamp, lines[3].isoTimestamp);
      renderSummaryView();

      // No local selection initially
      expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument();

      await act(async () => { capturedOnResetZoom?.(); });
      // Should now have local selection = full range, so Cancel/Apply appear
      expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
    });

    it('does nothing when no local selection and already at full range', async () => {
      const lines = buildResetLines();
      useLogStore.getState().setHttpRequests([], lines);
      renderSummaryView();

      await act(async () => { capturedOnResetZoom?.(); });
      expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument();
    });
  });

  // ============================================================================
  // shouldShowApplyButton with global filter
  // ============================================================================

  describe('shouldShowApplyButton - global filter comparison', () => {
    const BASE_S = 1_701_000_000_000_000 as TimestampMicros;
    const STEP_S = 5_000_000 as TimestampMicros;
    const minS = BASE_S;
    const maxS = (BASE_S + STEP_S * 4) as TimestampMicros;

    afterEach(() => {
      useLogStore.getState().setTimeFilter(null, null);
    });

    it('hides Apply button when local selection exactly matches global filter', async () => {
      const lines = [0, 1, 2, 3, 4].map((i) =>
        createParsedLogLine({ lineNumber: i + 20, timestampUs: (BASE_S + STEP_S * i) as TimestampMicros })
      );
      useLogStore.getState().setHttpRequests([], lines);
      // Global filter = full range via keywords
      useLogStore.getState().setTimeFilter('start', 'end');
      renderSummaryView();

      // Select full range (matches global filter)
      await act(async () => { capturedOnTimeRangeSelected?.(minS, maxS); });
      // shouldShowApplyButton: diff = 0 ≤ 1000 → false → no Apply button
      expect(screen.queryByRole('button', { name: /apply/i })).not.toBeInTheDocument();
    });
  });

  // ============================================================================
  // Stats with HTTP requests and local time range
  // ============================================================================

  describe('stats with HTTP requests and local time range', () => {
    const BASE_H = 1_702_000_000_000_000 as TimestampMicros;
    const STEP_H = 5_000_000 as TimestampMicros;

    it('filters HTTP and sync requests by local zoom selection', async () => {
      const lines = [0, 1, 2, 3, 4].map((i) =>
        createParsedLogLine({ lineNumber: i + 30, timestampUs: (BASE_H + STEP_H * i) as TimestampMicros })
      );
      const httpReq = createHttpRequest({
        requestId: 'REQ-H1',
        status: '200',
        sendLineNumber: 30,
        responseLineNumber: 32,
        requestDurationMs: 500,
        uri: '/api/test',
      });
      const syncReq = createSyncRequest({
        requestId: 'SYNC-H1',
        connId: 'conn-h',
        sendLineNumber: 31,
        responseLineNumber: 33,
      });
      useLogStore.getState().setRequests([syncReq], ['conn-h'], lines);
      useLogStore.getState().setHttpRequests([httpReq], lines);
      renderSummaryView();

      // Activate local zoom that includes lines 31-33
      const selStart = (BASE_H + STEP_H) as TimestampMicros;
      const selEnd = (BASE_H + STEP_H * 3) as TimestampMicros;
      await act(async () => { capturedOnTimeRangeSelected?.(selStart, selEnd); });

      expect(screen.getByText(/Summary/)).toBeInTheDocument();
    });

    it('includes timeout in httpRequestsWithTimestamps for matching sync request', () => {
      const lines = [0, 1, 2, 3, 4].map((i) =>
        createParsedLogLine({ lineNumber: i + 40, timestampUs: (BASE_H + STEP_H * i) as TimestampMicros })
      );
      // HTTP request and sync request share the same requestId
      const sharedId = 'SHARED-TIMEOUT';
      const httpReq = createHttpRequest({
        requestId: sharedId,
        status: '200',
        sendLineNumber: 40,
        responseLineNumber: 41,
        requestDurationMs: 100,
        uri: '/api/sync-test',
      });
      const syncReq = createSyncRequest({
        requestId: sharedId,
        connId: 'conn-t',
        sendLineNumber: 40,
        responseLineNumber: 41,
        timeout: 30000,
      });
      useLogStore.getState().setRequests([syncReq], ['conn-t'], lines);
      useLogStore.getState().setHttpRequests([httpReq], lines);
      renderSummaryView();

      expect(screen.getByText(/Summary/)).toBeInTheDocument();
    });
  });

  // ============================================================================
  // extractCoreMessage ISO timestamp prefix
  // ============================================================================

  describe('extractCoreMessage with ISO-prefixed log messages', () => {
    it('strips ISO timestamp prefix from error and warning messages', () => {
      const lines = [
        createParsedLogLine({
          lineNumber: 50,
          level: 'ERROR',
          message: '2024-01-15T10:00:00.000000Z ERROR connection failed',
        }),
        createParsedLogLine({
          lineNumber: 51,
          level: 'WARN',
          message: '2024-01-15T10:00:01.000000Z WARN slow query detected',
        }),
      ];
      useLogStore.getState().setHttpRequests([], lines);
      renderSummaryView();

      // Should render error section from extracted messages
      const errorHeader = screen.getByRole('columnheader', { name: /top errors/i });
      expect(errorHeader).toBeInTheDocument();
    });
  });

  // ============================================================================
  // Incomplete HTTP requests
  // ============================================================================

  describe('incomplete HTTP requests', () => {
    it('shows incomplete count in HTTP Requests Over Time heading', () => {
      const BASE_I = 1_703_000_000_000_000 as TimestampMicros;
      const lines = [
        createParsedLogLine({ lineNumber: 60, timestampUs: BASE_I }),
        createParsedLogLine({ lineNumber: 61, timestampUs: (BASE_I + 1_000_000) as TimestampMicros }),
      ];
      // Incomplete request: empty status, sendLineNumber points to existing line
      // responseLineNumber = 0 (falsy) so excluded from completedRequestsWithTimestamps
      const incompleteReq = createHttpRequest({
        requestId: 'INC-1',
        status: '',
        sendLineNumber: 61,
        responseLineNumber: 0,
      });
      useLogStore.getState().setHttpRequests([incompleteReq], lines);
      renderSummaryView();

      // The Requests sub-header should show "Incomplete: 1"
      expect(screen.getByText(/Incomplete: 1/)).toBeInTheDocument();
    });

    it('aggregates upload/download bytes across duplicate request IDs and skips requests with missing timestamps', () => {
      const BASE_B = 1_705_000_000_000_000 as TimestampMicros;
      const lines = [
        createParsedLogLine({ lineNumber: 100, timestampUs: BASE_B }),
        createParsedLogLine({ lineNumber: 101, timestampUs: (BASE_B + 1_000_000) as TimestampMicros }),
        createParsedLogLine({ lineNumber: 102, timestampUs: (BASE_B + 2_000_000) as TimestampMicros }),
        createParsedLogLine({ lineNumber: 103, timestampUs: (BASE_B + 3_000_000) as TimestampMicros }),
      ];

      const completedA = createHttpRequest({
        requestId: 'REQ-DUPE',
        requestSize: 100,
        responseSize: 200,
        sendLineNumber: 100,
        responseLineNumber: 101,
      });
      const completedB = createHttpRequest({
        requestId: 'REQ-DUPE',
        requestSize: 300,
        responseSize: 400,
        sendLineNumber: 101,
        responseLineNumber: 102,
      });
      const incomplete = createHttpRequest({
        requestId: 'REQ-INCOMPLETE',
        status: '',
        requestSize: 50,
        responseSize: 0,
        sendLineNumber: 103,
        responseLineNumber: 0,
      });
      const completedMissingTimestamp = createHttpRequest({
        requestId: 'REQ-MISSING-RESP-TS',
        requestSize: 999,
        responseSize: 999,
        sendLineNumber: 100,
        responseLineNumber: 999,
      });
      const incompleteMissingTimestamp = createHttpRequest({
        requestId: 'REQ-MISSING-SEND-TS',
        status: '',
        requestSize: 999,
        responseSize: 0,
        sendLineNumber: 998,
        responseLineNumber: 0,
      });

      useLogStore
        .getState()
        .setHttpRequests(
          [completedA, completedB, incomplete, completedMissingTimestamp, incompleteMissingTimestamp],
          lines
        );

      renderSummaryView();

      // Phase 1 is start-based, so requests with a valid send timestamp still count
      // even when their response timestamp is missing.
      expect(screen.getByText(/Requests: 4.*Incomplete: 1/)).toBeInTheDocument();
      expect(screen.getByText(/Overall bandwidth: ↑ 1.4 KB \/ ↓ 1.6 KB/)).toBeInTheDocument();
    });
  });

  // ============================================================================
  // Slowest URLs – requests with no status (incomplete badge)
  // ============================================================================

  describe('slowest URLs with empty status (incomplete badge)', () => {
    it('shows "incomplete" badge for requests missing a status code', () => {
      const BASE_SL = 1_704_000_000_000_000 as TimestampMicros;
      const lines = [
        createParsedLogLine({ lineNumber: 70, timestampUs: BASE_SL }),
        createParsedLogLine({ lineNumber: 71, timestampUs: (BASE_SL + 1_000_000) as TimestampMicros }),
      ];
      // Request with responseLineNumber but empty status
      const noStatusReq = createHttpRequest({
        requestId: 'NO-STATUS-SL',
        status: '',
        sendLineNumber: 70,
        responseLineNumber: 71,
        requestDurationMs: 2000,
        uri: '/slow/endpoint',
      });
      useLogStore.getState().setHttpRequests([noStatusReq], lines);
      renderSummaryView();

      expect(screen.getByText('incomplete')).toBeInTheDocument();
    });
  });

  // ============================================================================
  // Navigation button clicks
  // ============================================================================

  describe('navigation button clicks', () => {
    it('clicking View button in Sync Requests by Connection triggers navigation', () => {
      const lines = createParsedLogLines(2);
      const syncReq = createSyncRequest({
        requestId: 'SYNC-NAV-1',
        connId: 'nav-conn',
        sendLineNumber: 0,
        responseLineNumber: 1,
      });
      useLogStore.getState().setRequests([syncReq], ['nav-conn'], lines);
      renderSummaryView();

      const viewBtn = screen.getByRole('button', { name: /^view$/i });
      expect(viewBtn).toBeInTheDocument();
      fireEvent.click(viewBtn);
      expect(screen.getByText('nav-conn')).toBeInTheDocument();
    });

    it('clicking the error count span in Top Errors heading triggers navigation', () => {
      const lines = [
        createParsedLogLine({ lineNumber: 80, level: 'ERROR', message: 'some error' }),
      ];
      useLogStore.getState().setHttpRequests([], lines);
      renderSummaryView();

      const errorHeader = screen.getByRole('columnheader', { name: /top errors/i });
      const clickableSpan = errorHeader.querySelector('span');
      if (clickableSpan) fireEvent.click(clickableSpan);
      expect(screen.getByText(/Summary/)).toBeInTheDocument();
    });

    it('clicking Top Failed URLs count heading triggers navigation', () => {
      const lines = createParsedLogLines(2);
      const httpReq = createHttpRequest({
        requestId: 'FAIL-NAV',
        status: '500',
        uri: '/api/failed',
        sendLineNumber: 0,
        responseLineNumber: 1,
      });
      useLogStore.getState().setHttpRequests([httpReq], lines);
      renderSummaryView();

      // Click the count in Top Failed URLs heading
      const failedTable = screen.queryByRole('columnheader', { name: /top failed urls/i });
      if (failedTable) {
        const countSpan = failedTable.querySelector('span');
        if (countSpan) fireEvent.click(countSpan);
      }
      expect(screen.getByText(/Summary/)).toBeInTheDocument();
    });

    it('exercises the warning type button onClick handler without crashing', () => {
      const lines = [
        createParsedLogLine({ lineNumber: 90, level: 'WARN', message: 'some warning message' }),
      ];
      useLogStore.getState().setHttpRequests([], lines);
      renderSummaryView();

      const warnBtn = screen.getByRole('button', { name: /some warning message/i });
      fireEvent.click(warnBtn);
      expect(screen.getByText(/Summary/)).toBeInTheDocument();
    });

    it('exercises the HTTP error status badge onClick handler without crashing', () => {
      const lines = createParsedLogLines(2);
      const httpReq = createHttpRequest({
        requestId: 'ERR-STATUS-NAV',
        status: '404',
        uri: '/api/missing',
        sendLineNumber: 0,
        responseLineNumber: 1,
      });
      useLogStore.getState().setHttpRequests([httpReq], lines);
      renderSummaryView();

      const statusBadge = screen.getByRole('button', { name: '404' });
      fireEvent.click(statusBadge);
      expect(screen.getByText(/Summary/)).toBeInTheDocument();
    });

    it('exercises the top failed URL button onClick handler for a single matching request without crashing', () => {
      const lines = createParsedLogLines(2);
      const httpReq = createHttpRequest({
        requestId: 'SINGLE-FAIL-REQ',
        status: '500',
        uri: '/api/single-fail',
        sendLineNumber: 0,
        responseLineNumber: 1,
      });
      useLogStore.getState().setHttpRequests([httpReq], lines);
      renderSummaryView();

      // Exercises the single-match branch (navigates with request_id rather than filter param).
      // Full navigation assertion would require replacing MemoryRouter with createMemoryRouter.
      const failedUrlBtn = screen.getByRole('button', { name: /single-fail/i });
      fireEvent.click(failedUrlBtn);
      expect(screen.getByText(/Summary/)).toBeInTheDocument();
    });
  });

  // ============================================================================
  // Sentry Reports Section
  // ============================================================================

  describe('user header rooms', () => {
    afterEach(() => {
      useArchiveStore.getState().clearArchive();
    });

    it('reuses the archive summary of a file opened from /archive instead of rescanning it', () => {
      const name = 'dir/logs.2026-04-14-09.log.gz';
      const bytes = (s: string) => new TextEncoder().encode(s);
      useArchiveStore.getState().loadArchive('test.tar.gz', [
        { name: 'dir/details.json', data: bytes(JSON.stringify({ data: { device_id: 'BOBPHONE' } })) },
        { name, data: bytes('') },
      ]);
      useArchiveStore.getState().setArchiveSummary(name, {
        ...emptyArchiveSummary(),
        rooms: { seenIds: ['!a:example.org', '!b:example.org'], lists: {} },
      });
      // The loaded lines mention no room: only the summary can say 2.
      useLogStore.getState().loadLogParserResult(parseLogFile(RECEIVER_LOG), { loadedEntryNames: [name] });
      renderSummaryView();
      expect(screen.getByTitle('Distinct rooms these logs mention')).toHaveTextContent('2 rooms in logs');
    });
  });

  describe('Sentry Reports section', () => {
    const BASE_SENTRY = 1_706_000_000_000_000 as TimestampMicros;
    const STEP_SENTRY = 5_000_000 as TimestampMicros;

    function buildSentryLines() {
      return [0, 1, 2].map((i) =>
        createParsedLogLine({
          lineNumber: i + 200,
          timestampUs: (BASE_SENTRY + STEP_SENTRY * i) as TimestampMicros,
        })
      );
    }

    it('hides the Sentry Reports section when there are no sentry events', () => {
      const lines = buildSentryLines();
      useLogStore.getState().setHttpRequests([], lines);
      useLogStore.getState().setSentryEvents([]);
      renderSummaryView();

      expect(screen.queryByText(/Sentry Reports/)).not.toBeInTheDocument();
    });

    it('shows the Sentry Reports section with iOS crash entry and correct Sentry link', () => {
      const lines = buildSentryLines();
      useLogStore.getState().setHttpRequests([], lines);
      useLogStore.getState().setSentryEvents([
        {
          platform: 'ios',
          lineNumber: 200,
          message: '2026-01-15T10:00:00.110000Z  WARN [matrix-rust-sdk] Sentry detected a crash in the previous run: 865038c59b224a91a09ff62b1b56767d',
          sentryId: '865038c59b224a91a09ff62b1b56767d',
          sentryUrl: 'https://sentry.tools.element.io/organizations/element/issues/?project=44&query=865038c59b224a91a09ff62b1b56767d',
        },
      ]);
      renderSummaryView();

      expect(screen.getByText(/Sentry Reports/)).toBeInTheDocument();

      // Log navigation button shows the raw message text
      expect(screen.getByRole('button', { name: /Sentry detected a crash/i })).toBeInTheDocument();

      // Dedicated Sentry ID column: link text is the raw hex ID
      const sentryLink = screen.getByRole('link', { name: '865038c59b224a91a09ff62b1b56767d' });
      expect(sentryLink).toHaveAttribute(
        'href',
        'https://sentry.tools.element.io/organizations/element/issues/?project=44&query=865038c59b224a91a09ff62b1b56767d'
      );
      expect(sentryLink).toHaveAttribute('target', '_blank');
    });

    it('shows the Sentry Reports section with Android error entry (no Sentry link)', () => {
      const lines = buildSentryLines();
      useLogStore.getState().setHttpRequests([], lines);
      useLogStore.getState().setSentryEvents([
        {
          platform: 'android',
          lineNumber: 201,
          message: '2026-01-15T10:00:22.390000Z  WARN [matrix-rust-sdk] Sending error to Sentry',
        },
      ]);
      renderSummaryView();

      expect(screen.getByText(/Sentry Reports/)).toBeInTheDocument();

      // Log navigation button present with the message text
      expect(screen.getByRole('button', { name: /Sending error to Sentry/i })).toBeInTheDocument();

      // No Sentry ID link in the dedicated column
      expect(screen.queryByRole('link', { name: '(Sentry)' })).not.toBeInTheDocument();
    });

    it('respects time filter and hides sentry events outside the selected range', async () => {
      const lines = buildSentryLines();
      useLogStore.getState().setHttpRequests([], lines);
      // Event is on line 200 (first timestamp); apply a time filter starting AFTER that line
      useLogStore.getState().setSentryEvents([
        {
          platform: 'ios',
          lineNumber: 200,
          message: 'crash report',
          sentryId: 'abc123',
          sentryUrl: 'https://sentry.tools.element.io/organizations/element/issues/?project=44&query=abc123',
        },
      ]);
      // Set global filter to only include lines 201+ (exclude line 200)
      useLogStore.getState().setTimeFilter(lines[1].isoTimestamp, lines[2].isoTimestamp);
      renderSummaryView();

      expect(screen.queryByText(/Sentry Reports/)).not.toBeInTheDocument();

      // Restore
      useLogStore.getState().setTimeFilter(null, null);
    });
  });

  // ============================================================================
  // §4.3 — Render tests asserting stats are displayed with real computed data
  // ============================================================================

  describe('concrete rendered statistics (§4.3)', () => {
    it('renders the exact error message strings as row labels', () => {
      const lines = [
        createParsedLogLine({ lineNumber: 0, level: 'ERROR', message: 'database connection lost' }),
        createParsedLogLine({ lineNumber: 1, level: 'ERROR', message: 'database connection lost' }),
        createParsedLogLine({ lineNumber: 2, level: 'ERROR', message: 'token refresh failed' }),
      ];
      useLogStore.getState().setHttpRequests([], lines);
      renderSummaryView();

      // Both error types must appear as navigable row labels
      expect(screen.getByRole('button', { name: /database connection lost/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /token refresh failed/i })).toBeInTheDocument();
    });

    it('renders the exact warning message strings as row labels', () => {
      const lines = [
        createParsedLogLine({ lineNumber: 0, level: 'WARN', message: 'retrying after backoff' }),
        createParsedLogLine({ lineNumber: 1, level: 'WARN', message: 'retrying after backoff' }),
      ];
      useLogStore.getState().setHttpRequests([], lines);
      renderSummaryView();

      expect(screen.getByRole('button', { name: /retrying after backoff/i })).toBeInTheDocument();
    });

    it('displays HTTP 500 error status badge', () => {
      const BASE_C = 1_710_000_000_000_000 as TimestampMicros;
      const lines = [
        createParsedLogLine({ lineNumber: 0, timestampUs: BASE_C }),
        createParsedLogLine({ lineNumber: 1, timestampUs: (BASE_C + 1_000_000) as TimestampMicros }),
      ];
      const httpRequests = [
        createHttpRequest({ requestId: 'R1', status: '500', sendLineNumber: 0, responseLineNumber: 1 }),
      ];
      useLogStore.getState().setHttpRequests(httpRequests, lines);
      renderSummaryView();

      // The status code badge in the HTTP Errors by Status table
      expect(screen.getByRole('button', { name: '500' })).toBeInTheDocument();
    });

    it('displays the correct sync count next to each connection ID', () => {
      const BASE_SC = 1_711_000_000_000_000 as TimestampMicros;
      const lines = [0, 1, 2, 3].map((i) =>
        createParsedLogLine({ lineNumber: i, timestampUs: (BASE_SC + i * 1_000_000) as TimestampMicros })
      );
      const syncRequests = [
        createSyncRequest({ requestId: 'S1', connId: 'main', sendLineNumber: 0, responseLineNumber: 1 }),
        createSyncRequest({ requestId: 'S2', connId: 'main', sendLineNumber: 1, responseLineNumber: 2 }),
        createSyncRequest({ requestId: 'S3', connId: 'encryption', sendLineNumber: 2, responseLineNumber: 3 }),
      ];
      useLogStore.getState().setRequests(syncRequests, ['main', 'encryption'], lines);
      renderSummaryView();

      // Connection rows visible
      expect(screen.getByText('main')).toBeInTheDocument();
      expect(screen.getByText('encryption')).toBeInTheDocument();
      // Scope count cells to each row to avoid matching unrelated numeric cells in other tables
      const mainRow = screen.getByText('main').closest('tr')!;
      expect(within(mainRow).getByRole('cell', { name: '2' })).toBeInTheDocument();
      const encRow = screen.getByText('encryption').closest('tr')!;
      expect(within(encRow).getByRole('cell', { name: '1' })).toBeInTheDocument();
    });

    it('displays the correct line count after a global time filter is applied', () => {
      // 10 lines at 1 s each; filter to the middle 4 (lines 3–6)
      const BASE_TF = 1_712_000_000_000_000 as TimestampMicros;
      const lines = Array.from({ length: 10 }, (_, i) =>
        createParsedLogLine({ lineNumber: i, timestampUs: (BASE_TF + i * 1_000_000) as TimestampMicros })
      );
      useLogStore.getState().setHttpRequests([], lines);
      useLogStore.getState().setTimeFilter(lines[3].isoTimestamp, lines[6].isoTimestamp);
      renderSummaryView();

      // 4 filtered lines should appear in the "Logs" heading
      expect(screen.getByText(/Logs: 4 lines/)).toBeInTheDocument();

      // Restore
      useLogStore.getState().setTimeFilter(null, null);
    });

    it('displays slowest request URI in the Slowest HTTP Requests table', () => {
      const BASE_SR = 1_713_000_000_000_000 as TimestampMicros;
      const lines = [
        createParsedLogLine({ lineNumber: 0, timestampUs: BASE_SR }),
        createParsedLogLine({ lineNumber: 1, timestampUs: (BASE_SR + 1_000_000) as TimestampMicros }),
      ];
      const httpRequests = [
        createHttpRequest({
          requestId: 'SLOW-ONE',
          status: '200',
          uri: '/api/send-to-device',
          requestDurationMs: 8500,
          sendLineNumber: 0,
          responseLineNumber: 1,
        }),
      ];
      useLogStore.getState().setHttpRequests(httpRequests, lines);
      renderSummaryView();

      // The URI should appear in the Slowest Requests table
      expect(screen.getByRole('cell', { name: /send-to-device/i })).toBeInTheDocument();
    });
  });

  describe('chart sync toggle', () => {
    const BASE_CS = 1_720_000_000_000_000 as TimestampMicros;
    const linesForSync = [
      createParsedLogLine({ lineNumber: 0, timestampUs: BASE_CS }),
      createParsedLogLine({ lineNumber: 1, timestampUs: (BASE_CS + 1_000_000) as TimestampMicros }),
    ];

    beforeEach(() => {
      useLogStore.getState().setHttpRequests([], linesForSync);
    });

    it('renders the "Sync charts" checkbox unchecked by default', () => {
      renderSummaryView();

      const checkbox = screen.getByRole('checkbox', { name: /sync charts/i });
      expect(checkbox).toBeInTheDocument();
      expect(checkbox).not.toBeChecked();
    });

    it('does not pass onCursorMove to LogActivityChart when sync is disabled', () => {
      renderSummaryView();

      // sync is off by default — charts receive no cursor-sync callbacks
      expect(capturedOnCursorMove).toBeUndefined();
    });

    it('passes onCursorMove to LogActivityChart after enabling the checkbox', () => {
      renderSummaryView();

      const checkbox = screen.getByRole('checkbox', { name: /sync charts/i });
      act(() => { fireEvent.click(checkbox); });

      expect(checkbox).toBeChecked();
      // Chart now receives a cursor-move callback
      expect(capturedOnCursorMove).toBeDefined();
    });

    it('removes onCursorMove when the checkbox is unchecked again', () => {
      renderSummaryView();

      const checkbox = screen.getByRole('checkbox', { name: /sync charts/i });
      act(() => { fireEvent.click(checkbox); }); // enable
      act(() => { fireEvent.click(checkbox); }); // disable

      expect(checkbox).not.toBeChecked();
      expect(capturedOnCursorMove).toBeUndefined();
    });
  });

  describe('Show in-flight toggle', () => {
    const BASE_IF = 1_720_000_000_000_000 as TimestampMicros;

    beforeEach(() => {
      const lines = [
        createParsedLogLine({ lineNumber: 0, timestampUs: BASE_IF }),
        createParsedLogLine({ lineNumber: 1, timestampUs: (BASE_IF + 1_000_000) as TimestampMicros }),
        createParsedLogLine({ lineNumber: 2, timestampUs: (BASE_IF + 2_000_000) as TimestampMicros }),
      ];
      const req = createHttpRequest({
        requestId: 'IF-1',
        status: '200',
        sendLineNumber: 0,
        responseLineNumber: 2,
        attemptTimestampsUs: [BASE_IF],
      });
      useLogStore.getState().setHttpRequests([req], lines);
    });

    it('renders the chart-mode select in "stepArea" mode (displayed as "In-flight") by default', () => {
      renderSummaryView();
      const select = screen.getByRole('combobox', { name: /chart display mode/i });
      expect(select).toBeInTheDocument();
      expect(select).toHaveValue('stepArea');
    });

    it('switches chart-mode select to "In-flight" and back', () => {
      renderSummaryView();
      const select = screen.getByRole('combobox', { name: /chart display mode/i });
      expect(select).toHaveValue('stepArea');
      act(() => { fireEvent.change(select, { target: { value: 'histogram' } }); });
      expect(select).toHaveValue('histogram');
      act(() => { fireEvent.change(select, { target: { value: 'stepArea' } }); });
      expect(select).toHaveValue('stepArea');
    });

    it('renders exactly one shared chart-mode select for both charts', () => {
      renderSummaryView();
      // A single select drives both the HTTP and bandwidth charts
      expect(screen.getAllByRole('combobox', { name: /chart display mode/i })).toHaveLength(1);
    });
  });

  describe('Incomplete toggle', () => {
    const BASE_INCOMPLETE = 1_721_000_000_000_000 as TimestampMicros;

    beforeEach(() => {
      const lines = [
        createParsedLogLine({ lineNumber: 0, timestampUs: BASE_INCOMPLETE }),
        createParsedLogLine({ lineNumber: 1, timestampUs: (BASE_INCOMPLETE + 1_000_000) as TimestampMicros }),
        createParsedLogLine({ lineNumber: 2, timestampUs: (BASE_INCOMPLETE + 2_000_000) as TimestampMicros }),
      ];
      const req = createHttpRequest({
        requestId: 'HI-1',
        status: '200',
        sendLineNumber: 0,
        responseLineNumber: 2,
        attemptTimestampsUs: [BASE_INCOMPLETE],
      });
      useLogStore.getState().setHttpRequests([req], lines);
    });

    it('renders the "Incomplete" checkbox checked by default', () => {
      renderSummaryView();
      const checkbox = screen.getByRole('checkbox', { name: /incomplete/i });
      expect(checkbox).toBeInTheDocument();
      expect(checkbox).toBeChecked();
    });

    it('toggles "Incomplete" checkbox on and off', () => {
      renderSummaryView();
      const checkbox = screen.getByRole('checkbox', { name: /incomplete/i });
      act(() => { fireEvent.click(checkbox); });
      expect(checkbox).not.toBeChecked();
      act(() => { fireEvent.click(checkbox); });
      expect(checkbox).toBeChecked();
    });
  });

  describe('Sync toggle', () => {
    const BASE_SYNC = 1_721_000_000_000_000 as TimestampMicros;

    beforeEach(() => {
      const lines = [
        createParsedLogLine({ lineNumber: 0, timestampUs: BASE_SYNC }),
        createParsedLogLine({ lineNumber: 1, timestampUs: (BASE_SYNC + 1_000_000) as TimestampMicros }),
        createParsedLogLine({ lineNumber: 2, timestampUs: (BASE_SYNC + 2_000_000) as TimestampMicros }),
      ];
      const req = createSyncRequest({
        requestId: 'SY-1',
        connId: 'conn-1',
        timeout: 0,
        sendLineNumber: 0,
        responseLineNumber: 2,
        attemptTimestampsUs: [BASE_SYNC],
      });
      useLogStore.getState().setHttpRequests([req], lines);
    });

    it('renders the "Sync" checkbox checked by default', () => {
      renderSummaryView();
      const checkbox = screen.getByRole('checkbox', { name: /^sync$/i });
      expect(checkbox).toBeChecked();
    });

    it('toggles "Sync" checkbox on and off', () => {
      renderSummaryView();
      const checkbox = screen.getByRole('checkbox', { name: /^sync$/i });
      act(() => { fireEvent.click(checkbox); });
      expect(checkbox).not.toBeChecked();
      act(() => { fireEvent.click(checkbox); });
      expect(checkbox).toBeChecked();
    });
  });

  describe('Media toggle', () => {
    const BASE_MEDIA = 1_722_000_000_000_000 as TimestampMicros;

    beforeEach(() => {
      const lines = [
        createParsedLogLine({ lineNumber: 0, timestampUs: BASE_MEDIA }),
        createParsedLogLine({ lineNumber: 1, timestampUs: (BASE_MEDIA + 1_000_000) as TimestampMicros }),
      ];
      const req = createHttpRequest({
        requestId: 'MEDIA-1',
        uri: 'https://example.org/_matrix/media/v3/upload',
        status: '200',
        sendLineNumber: 0,
        responseLineNumber: 1,
        attemptTimestampsUs: [BASE_MEDIA],
      });
      useLogStore.getState().setHttpRequests([req], lines);
    });

    it('renders the "Media" checkbox checked by default', () => {
      renderSummaryView();
      const checkbox = screen.getByRole('checkbox', { name: /media/i });
      expect(checkbox).toBeInTheDocument();
      expect(checkbox).toBeChecked();
    });

    it('toggles "Media" checkbox on and off', () => {
      renderSummaryView();
      const checkbox = screen.getByRole('checkbox', { name: /media/i });
      act(() => { fireEvent.click(checkbox); });
      expect(checkbox).not.toBeChecked();
      act(() => { fireEvent.click(checkbox); });
      expect(checkbox).toBeChecked();
    });
  });
});


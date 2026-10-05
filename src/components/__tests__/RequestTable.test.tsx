/**
 * Unit tests for RequestTable.tsx
 * Tests rendering, user interactions, and edge cases.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RequestTable } from '../RequestTable';
import type { RequestTableProps, ColumnDef } from '../RequestTable';
import { useLogStore } from '../../stores/logStore';
import { createHttpRequest, createParsedLogLine } from '../../test/fixtures';
// Mock the virtualizer hook used by RequestTable.
// Inlined here (not via a helper import) because vi.mock factories are hoisted
// before import bindings are initialised, so imported helper functions are not
// safe to call inside a vi.mock factory.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number; estimateSize: () => number }) => ({
    getTotalSize: () => opts.count * opts.estimateSize(),
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, i) => {
        const size = opts.estimateSize();
        const start = i * size;
        return {
          index: i,
          key: i,
          start,
          size,
          end: start + size,
        };
      }),
    measureElement: () => {},
    measure: () => {},
    measurementsCache: [],
  }),
}));

// Spy on navigate to verify onExpand routing
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const mod = await importOriginal<typeof import('react-router-dom')>();
  return { ...mod, useNavigate: () => mockNavigate };
});

vi.mock('../../views/LogDisplayView', () => ({
  LogDisplayView: vi.fn(({ onClose, onExpand, requestFilter, lineRange, logLines }) => (
    <div data-testid="log-display-view">
      <span data-testid="log-display-request-filter">{requestFilter ?? ''}</span>
      <span data-testid="log-display-lines">{(logLines as { lineNumber: number }[] | undefined)?.map((l) => l.lineNumber).join(',')}</span>
      <span data-testid="log-display-line-range">{lineRange ? 'line-range-set' : 'line-range-unset'}</span>
      <button onClick={onClose}>Close</button>
      <button onClick={onExpand}>Expand</button>
    </div>
  )),
}));

// Mock BurgerMenu
vi.mock('../BurgerMenu', () => ({
  BurgerMenu: () => <div data-testid="burger-menu" />,
}));

// Mutable flag controlling hasExplicitScale returned by the useURLParams mock.
// Tests that need hasExplicitScale:true write to this before rendering.
let _hasExplicitScale = false;

// Mock useURLParams to directly update store (simulating App.tsx URL→Store sync)
vi.mock('../../hooks/useURLParams', () => ({
  useURLParams: () => ({
    setLogFilter: (filter: string | null) => {
      useLogStore.getState().setLogFilter(filter);
    },
    setStatusFilter: (codes: Set<string> | null) => {
      useLogStore.getState().setStatusFilter(codes);
    },
    setTimeFilter: () => {},
    setScale: (scale: number) => {
      useLogStore.getState().setTimelineScale(scale);
    },
    setRequestId: () => {},
    hasExplicitScale: _hasExplicitScale,
  }),
}));

// Default columns for testing
const defaultColumns: ColumnDef[] = [
  { id: 'requestId', label: 'Request ID', getValue: (r) => r.requestId },
  { id: 'method', label: 'Method', getValue: (r) => r.method },
  { id: 'status', label: 'Status', getValue: (r) => r.status },
];

// Create default props factory
function createProps(overrides: Partial<RequestTableProps> = {}): RequestTableProps {
  return {
    title: 'Test Requests',
    columns: defaultColumns,
    filteredRequests: [],
    totalCount: 0,
    showIncomplete: false,
    onShowIncompleteChange: vi.fn(),
    msPerPixel: 10,
    availableStatusCodes: ['200', '404', '500'],
    ...overrides,
  };
}

// Wrapper to provide router context
function renderWithRouter(ui: React.ReactElement, initialEntries: string[] = ['/http_requests']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      {ui}
    </MemoryRouter>
  );
}

describe('RequestTable', () => {
  beforeEach(() => {
    useLogStore.getState().clearData();
    // Reset location hash
    window.location.hash = '';
  });

  describe('rendering', () => {
    it('renders the title', () => {
      renderWithRouter(<RequestTable {...createProps({ title: 'My Requests' })} />);

      expect(screen.getByText('My Requests')).toBeInTheDocument();
    });

    it('renders column headers', () => {
      renderWithRouter(<RequestTable {...createProps()} />);

      expect(screen.getByText('Request ID')).toBeInTheDocument();
      expect(screen.getByText('Method')).toBeInTheDocument();
      expect(screen.getByText('Status')).toBeInTheDocument();
    });

    it('renders the incomplete checkbox', () => {
      renderWithRouter(<RequestTable {...createProps({ showIncomplete: true })} />);

      const checkbox = screen.getByRole('checkbox', { name: /incomplete/i });
      expect(checkbox).toBeInTheDocument();
      expect(checkbox).toBeChecked();
    });

    it('renders the /sync checkbox enabled by default', () => {
      renderWithRouter(<RequestTable {...createProps()} />);

      const syncCheckbox = screen.getByRole('checkbox', { name: '/sync' });
      expect(syncCheckbox).toBeInTheDocument();
      expect(syncCheckbox).toBeChecked();
    });

    it('renders request count stats', () => {
      renderWithRouter(<RequestTable {...createProps({ 
        filteredRequests: createRequests(3),
        totalCount: 5 
      })} />);

      expect(screen.getByText('3')).toBeInTheDocument();
      expect(screen.getByText('5')).toBeInTheDocument();
    });

    it('renders empty message when no requests', () => {
      renderWithRouter(<RequestTable {...createProps({ 
        filteredRequests: [],
        emptyMessage: 'Nothing to display' 
      })} />);

      expect(screen.getByText('Nothing to display')).toBeInTheDocument();
    });

    it('renders default empty message', () => {
      renderWithRouter(<RequestTable {...createProps({ filteredRequests: [] })} />);

      expect(screen.getByText('No requests found')).toBeInTheDocument();
    });

    it('keeps scroll containers mounted when transitioning through empty filtered state', () => {
      const requests = createRequests(2);
      const rawLines = [
        createParsedLogLine({ lineNumber: 0, timestampUs: 1700000000000000 }),
        createParsedLogLine({ lineNumber: 1, timestampUs: 1700000001000000 }),
        createParsedLogLine({ lineNumber: 2, timestampUs: 1700000002000000 }),
        createParsedLogLine({ lineNumber: 3, timestampUs: 1700000003000000 }),
      ];
      useLogStore.getState().setHttpRequests(requests, rawLines);

      const { rerender } = renderWithRouter(
        <RequestTable {...createProps({ filteredRequests: [requests[0]], totalCount: 2 })} />
      );

      const initialWrapper = screen.getByTestId('request-table-scroll-wrapper');
      const initialLeft = screen.getByTestId('request-table-left-scroll');
      const initialRight = screen.getByTestId('request-table-right-scroll');

      rerender(
        <MemoryRouter initialEntries={['/http_requests']}>
          <RequestTable {...createProps({ filteredRequests: [], totalCount: 2 })} />
        </MemoryRouter>
      );

      expect(screen.getByText('No requests found')).toBeInTheDocument();
      expect(screen.getByTestId('request-table-scroll-wrapper')).toBe(initialWrapper);
      expect(screen.getByTestId('request-table-left-scroll')).toBe(initialLeft);
      expect(screen.getByTestId('request-table-right-scroll')).toBe(initialRight);
      expect(initialWrapper).toHaveStyle({ display: 'none' });

      rerender(
        <MemoryRouter initialEntries={['/http_requests']}>
          <RequestTable {...createProps({ filteredRequests: [requests[1]], totalCount: 2 })} />
        </MemoryRouter>
      );

      expect(screen.queryByText('No requests found')).not.toBeInTheDocument();
      expect(screen.getByTestId('request-table-scroll-wrapper')).toBe(initialWrapper);
      expect(screen.getByTestId('request-table-left-scroll')).toBe(initialLeft);
      expect(screen.getByTestId('request-table-right-scroll')).toBe(initialRight);
      expect(initialWrapper.style.display).toBe('');
    });

    it('renders headerSlot when provided', () => {
      renderWithRouter(<RequestTable {...createProps({
        headerSlot: <div data-testid="custom-slot">Custom Header</div>
      })} />);

      expect(screen.getByTestId('custom-slot')).toBeInTheDocument();
    });

    it('renders timeline scale selector', () => {
      renderWithRouter(<RequestTable {...createProps({ msPerPixel: 25 })} />);

      const scaleButton = screen.getByTitle('Timeline scale');
      expect(scaleButton).toHaveTextContent('1px = 25ms');
    });
  });

  describe('interactions', () => {
    it('calls onShowIncompleteChange when checkbox is toggled', () => {
      const onShowIncompleteChange = vi.fn();
      renderWithRouter(<RequestTable {...createProps({ 
        showIncomplete: true,
        onShowIncompleteChange
      })} />);

      const checkbox = screen.getByRole('checkbox', { name: /incomplete/i });
      fireEvent.click(checkbox);

      expect(onShowIncompleteChange).toHaveBeenCalledWith(false);
    });

    it('hides /sync requests when /sync checkbox is unchecked', () => {
      const requests = [
        createHttpRequest({
          requestId: 'SYNC-REQ',
          uri: 'https://matrix.example.org/_matrix/client/v3/sync?since=abc',
          sendLineNumber: 0,
          responseLineNumber: 1,
        }),
        createHttpRequest({
          requestId: 'NONSYNC-REQ',
          uri: 'https://matrix.example.org/_matrix/client/v3/rooms/!room:example.org/messages',
          sendLineNumber: 2,
          responseLineNumber: 3,
        }),
      ];
      const rawLines = [
        createParsedLogLine({ lineNumber: 0, timestampUs: 1700000000000000 }),
        createParsedLogLine({ lineNumber: 1, timestampUs: 1700000001000000 }),
        createParsedLogLine({ lineNumber: 2, timestampUs: 1700000002000000 }),
        createParsedLogLine({ lineNumber: 3, timestampUs: 1700000003000000 }),
      ];
      useLogStore.getState().setHttpRequests(requests, rawLines);

      renderWithRouter(<RequestTable {...createProps({ filteredRequests: requests, totalCount: 2 })} />);

      expect(screen.getByText('SYNC-REQ')).toBeInTheDocument();
      expect(screen.getByText('NONSYNC-REQ')).toBeInTheDocument();
      expect(document.getElementById('shown-count')).toHaveTextContent('2');

      const syncCheckbox = screen.getByRole('checkbox', { name: '/sync' });
      fireEvent.click(syncCheckbox);

      expect(screen.queryByText('SYNC-REQ')).not.toBeInTheDocument();
      expect(screen.getByText('NONSYNC-REQ')).toBeInTheDocument();
      expect(document.getElementById('shown-count')).toHaveTextContent('1');
    });

    it('updates timeline scale when selector changes', () => {
      renderWithRouter(<RequestTable {...createProps({ msPerPixel: 10 })} />);

      // Open the dropdown
      const scaleButton = screen.getByTitle('Timeline scale');
      fireEvent.click(scaleButton);

      // Click the 50ms option
      const option = screen.getByText('1px = 50ms');
      fireEvent.click(option);

      expect(useLogStore.getState().timelineScale).toBe(50);
    });

    it('highlights both left and right panels on row hover', () => {
      const requests = createRequests(2);
      const rawLines = [
        createParsedLogLine({ lineNumber: 0, timestampUs: 1700000000000000 }),
        createParsedLogLine({ lineNumber: 1, timestampUs: 1700000001000000 }),
        createParsedLogLine({ lineNumber: 2, timestampUs: 1700000002000000 }),
        createParsedLogLine({ lineNumber: 3, timestampUs: 1700000003000000 }),
      ];
      useLogStore.getState().setHttpRequests(requests, rawLines);

      const { container } = renderWithRouter(<RequestTable {...createProps({ 
        filteredRequests: requests, 
        totalCount: 2 
      })} />);

      // Get the first row in the left panel
      // Row keys now use sendLineNumber || responseLineNumber (not requestId).
      // For REQ-0 with sendLineNumber=0 (falsy), rowKey = responseLineNumber=1.
      const leftRow = container.querySelector('[data-row-id="sticky-1"]');
      const rightRow = container.querySelector('[data-row-id="waterfall-1"]');

      expect(leftRow).toBeInTheDocument();
      expect(rightRow).toBeInTheDocument();

      // Simulate hover on left panel row
      fireEvent.mouseEnter(leftRow!);

      // Both rows should have the row-hovered class
      expect(leftRow?.classList.contains('row-hovered')).toBe(true);
      expect(rightRow?.classList.contains('row-hovered')).toBe(true);

      // Simulate mouse leave
      fireEvent.mouseLeave(leftRow!);

      // Both rows should not have the row-hovered class
      expect(leftRow?.classList.contains('row-hovered')).toBe(false);
      expect(rightRow?.classList.contains('row-hovered')).toBe(false);
    });

    it('highlights both panels when hovering waterfall row', () => {
      const requests = createRequests(2);
      const rawLines = [
        createParsedLogLine({ lineNumber: 0, timestampUs: 1700000000000000 }),
        createParsedLogLine({ lineNumber: 1, timestampUs: 1700000001000000 }),
        createParsedLogLine({ lineNumber: 2, timestampUs: 1700000002000000 }),
        createParsedLogLine({ lineNumber: 3, timestampUs: 1700000003000000 }),
      ];
      useLogStore.getState().setHttpRequests(requests, rawLines);

      const { container } = renderWithRouter(<RequestTable {...createProps({ 
        filteredRequests: requests, 
        totalCount: 2 
      })} />);

      // Row keys use sendLineNumber || responseLineNumber.
      // REQ-1 has sendLineNumber=2, so rowKey=2.
      const leftRow = container.querySelector('[data-row-id="sticky-2"]');
      const rightRow = container.querySelector('[data-row-id="waterfall-2"]');

      // Simulate hover on waterfall row
      fireEvent.mouseEnter(rightRow!);

      // Both rows should be highlighted
      expect(leftRow?.classList.contains('row-hovered')).toBe(true);
      expect(rightRow?.classList.contains('row-hovered')).toBe(true);

      // Simulate mouse leave on waterfall row
      fireEvent.mouseLeave(rightRow!);

      // Both rows should lose highlight
      expect(leftRow?.classList.contains('row-hovered')).toBe(false);
      expect(rightRow?.classList.contains('row-hovered')).toBe(false);
    });
  });

  describe('request row rendering', () => {
    it('renders request rows with column values', () => {
      const requests = [
        createHttpRequest({ requestId: 'REQ-1', method: 'GET', status: '200' }),
        createHttpRequest({ requestId: 'REQ-2', method: 'POST', status: '404' }),
      ];
      const rawLines = [
        createParsedLogLine({ lineNumber: 0, timestampUs: 1700000000000000 }),
        createParsedLogLine({ lineNumber: 1, timestampUs: 1700000001000000 }),
      ];
      useLogStore.getState().setHttpRequests(requests, rawLines);

      renderWithRouter(<RequestTable {...createProps({ 
        filteredRequests: requests, 
        totalCount: 2 
      })} />);

      expect(screen.getByText('REQ-1')).toBeInTheDocument();
      expect(screen.getByText('REQ-2')).toBeInTheDocument();
      expect(screen.getByText('GET')).toBeInTheDocument();
      expect(screen.getByText('POST')).toBeInTheDocument();
    });

    it('renders requests without status as incomplete', () => {
      const requests = [
        createHttpRequest({ requestId: 'REQ-1', status: '' }),
      ];
      const rawLines = [createParsedLogLine({ lineNumber: 0 })];
      useLogStore.getState().setHttpRequests(requests, rawLines);
      
      // Custom column that shows "Incomplete" for empty status
      const columnsWithIncompleteDisplay: ColumnDef[] = [
        { id: 'status', label: 'Status', getValue: (r) => r.status || 'Incomplete' },
      ];

      renderWithRouter(<RequestTable {...createProps({ 
        columns: columnsWithIncompleteDisplay,
        filteredRequests: requests, 
        totalCount: 1 
      })} />);

      expect(screen.getAllByText('Incomplete').length).toBeGreaterThan(0);
    });
  });

  describe('status filter dropdown', () => {
    it('renders StatusFilterDropdown with available codes', () => {
      renderWithRouter(<RequestTable {...createProps({ 
        availableStatusCodes: ['200', '201', '404']
      })} />);

      // StatusFilterDropdown shows "All Status" by default
      expect(screen.getByText('All Status')).toBeInTheDocument();
    });
  });

  describe('containerClassName', () => {
    it('applies containerClassName to app wrapper', () => {
      const { container } = renderWithRouter(<RequestTable {...createProps({ 
        containerClassName: 'http-view'
      })} />);

      expect(container.querySelector('.app.http-view')).toBeInTheDocument();
    });

    it('applies default app class when no containerClassName', () => {
      const { container } = renderWithRouter(<RequestTable {...createProps()} />);

      expect(container.querySelector('.app')).toBeInTheDocument();
    });
  });

  describe('expanded log viewer', () => {
    beforeEach(() => {
      mockNavigate.mockClear();
    });

    it('passes quoted requestFilter and no lineRange to embedded LogDisplayView', async () => {
      const req = createHttpRequest({
        requestId: 'REQ-18',
        sendLineNumber: 10,
        responseLineNumber: 20,
      });
      const rawLines = Array.from({ length: 25 }, (_, i) =>
        createParsedLogLine({ lineNumber: i, timestampUs: 1700000000000000 + i * 1000000 })
      );
      useLogStore.getState().setHttpRequests([req], rawLines);

      renderWithRouter(<RequestTable {...createProps({ filteredRequests: [req], totalCount: 1 })} />);

      act(() => {
        useLogStore.setState({
          openLogViewerIds: new Set<number>([10]),
          expandedRows: new Set<number>([10]),
        });
      });

      expect(await screen.findByTestId('log-display-view')).toBeInTheDocument();
      expect(screen.getByTestId('log-display-request-filter')).toHaveTextContent('"REQ-18"');
      expect(screen.getByTestId('log-display-line-range')).toHaveTextContent('line-range-unset');
    });

    it('navigates to /logs with quoted filter=requestId on onExpand', async () => {
      const req = createHttpRequest({
        requestId: 'REQ-LOG',
        sendLineNumber: 10,
        responseLineNumber: 20,
      });
      const rawLines = Array.from({ length: 25 }, (_, i) =>
        createParsedLogLine({ lineNumber: i, timestampUs: 1700000000000000 + i * 1000000 })
      );
      useLogStore.getState().setHttpRequests([req], rawLines);

      renderWithRouter(<RequestTable {...createProps({ filteredRequests: [req], totalCount: 1 })} />);

      // Open the log viewer programmatically (rowKey = sendLineNumber=10)
      act(() => {
        useLogStore.setState({
          openLogViewerIds: new Set<number>([10]),
          expandedRows: new Set<number>([10]),
        });
      });

      // The mocked LogDisplayView should be visible
      expect(await screen.findByTestId('log-display-view')).toBeInTheDocument();

      // Click Expand
      fireEvent.click(screen.getByText('Expand'));

      // Should navigate to /logs with filter set to the request ID, without start_line/end_line params
      expect(mockNavigate).toHaveBeenCalledTimes(1);
      const navigatedUrl: string = mockNavigate.mock.calls[0][0] as string;
      expect(navigatedUrl).toMatch(/^\/logs\?/);
      expect(navigatedUrl).toContain('filter=%22REQ-LOG%22');
      expect(navigatedUrl).not.toContain('start_line');
      expect(navigatedUrl).not.toContain('end_line');
    });

    it('shows only the send and response lines of an Element Web request', async () => {
      const req = createHttpRequest({ requestId: '1', sendLineNumber: 10, responseLineNumber: 20 });
      const rawLines = Array.from({ length: 25 }, (_, i) =>
        createParsedLogLine({ lineNumber: i, timestampUs: 1700000000000000 + i * 1000000 })
      );
      useLogStore.getState().setHttpRequests([req], rawLines);

      renderWithRouter(<RequestTable {...createProps({ filteredRequests: [req], totalCount: 1 })} />);
      act(() => {
        useLogStore.setState({
          openLogViewerIds: new Set<number>([10]),
          expandedRows: new Set<number>([10]),
        });
      });

      expect(await screen.findByTestId('log-display-lines')).toHaveTextContent(/^10,20$/);
      expect(screen.getByTestId('log-display-request-filter')).toBeEmptyDOMElement();

      fireEvent.click(screen.getByText('Expand'));
      const navigatedUrl: string = mockNavigate.mock.calls[0][0] as string;
      expect(navigatedUrl).toContain('line=10-20');
      expect(navigatedUrl).not.toContain('filter=');
    });
  });

  // ============================================================================
  // Log Filter Integration Tests
  // ============================================================================

  describe('Log Filter SearchInput', () => {
    it('renders SearchInput when showLogFilter is true', () => {
      renderWithRouter(<RequestTable {...createProps({ 
        showLogFilter: true,
        filteredRequests: createRequests(2),
        totalCount: 2,
      })} />);

      const filterInput = screen.getByPlaceholderText('Filter logs...');
      expect(filterInput).toBeInTheDocument();
    });

    it('does not render SearchInput when showLogFilter is false', () => {
      renderWithRouter(<RequestTable {...createProps({ 
        showLogFilter: false,
        filteredRequests: createRequests(2),
        totalCount: 2,
      })} />);

      const filterInput = screen.queryByPlaceholderText('Filter logs...');
      expect(filterInput).not.toBeInTheDocument();
    });

    it('renders SearchInput by default (showLogFilter defaults to true)', () => {
      renderWithRouter(<RequestTable {...createProps({ 
        filteredRequests: createRequests(2),
        totalCount: 2,
      })} />);

      const filterInput = screen.getByPlaceholderText('Filter logs...');
      expect(filterInput).toBeInTheDocument();
    });
  });

  describe('Log Filter Value Sync', () => {
    it('syncs SearchInput value to store via debounce', async () => {
      const requests = createRequests(5);
      const rawLines = Array.from({ length: 10 }, (_, i) => 
        createParsedLogLine({ lineNumber: i, timestampUs: 1700000000000000 + i * 1000000 })
      );
      useLogStore.getState().setHttpRequests(requests, rawLines);

      renderWithRouter(<RequestTable {...createProps({ 
        showLogFilter: true,
        filteredRequests: requests,
        totalCount: 5,
      })} />);

      const filterInput = screen.getByPlaceholderText('Filter logs...') as HTMLInputElement;
      
      // Type in the input
      fireEvent.change(filterInput, { target: { value: 'sync' } });
      
      // Should not sync immediately (debounced 300ms)
      expect(useLogStore.getState().logFilter).toBeNull();

      // Wait for debounce to complete
      await new Promise(resolve => setTimeout(resolve, 350));

      // Now it should be synced to store
      expect(useLogStore.getState().logFilter).toBe('sync');
    });

    it('debounces rapid typing - no intermediate filters', async () => {
      const requests = createRequests(5);
      const rawLines = Array.from({ length: 10 }, (_, i) => 
        createParsedLogLine({ lineNumber: i, timestampUs: 1700000000000000 + i * 1000000 })
      );
      useLogStore.getState().setHttpRequests(requests, rawLines);

      renderWithRouter(<RequestTable {...createProps({ 
        showLogFilter: true,
        filteredRequests: requests,
        totalCount: 5,
      })} />);

      const filterInput = screen.getByPlaceholderText('Filter logs...') as HTMLInputElement;
      
      // Rapid typing
      fireEvent.change(filterInput, { target: { value: 's' } });
      await new Promise(resolve => setTimeout(resolve, 50));
      fireEvent.change(filterInput, { target: { value: 'sy' } });
      await new Promise(resolve => setTimeout(resolve, 50));
      fireEvent.change(filterInput, { target: { value: 'syn' } });
      await new Promise(resolve => setTimeout(resolve, 50));
      fireEvent.change(filterInput, { target: { value: 'sync' } });
      
      // All typed within 150ms, so debounce not yet triggered
      expect(useLogStore.getState().logFilter).toBeNull();

      // Wait for debounce
      await new Promise(resolve => setTimeout(resolve, 350));

      // Should only apply final value after debounce
      expect(useLogStore.getState().logFilter).toBe('sync');
    });

    it('clears filter when SearchInput is cleared', async () => {
      const requests = createRequests(5);
      const rawLines = Array.from({ length: 10 }, (_, i) => 
        createParsedLogLine({ lineNumber: i, timestampUs: 1700000000000000 + i * 1000000 })
      );
      useLogStore.getState().setHttpRequests(requests, rawLines);
      useLogStore.getState().setLogFilter('sync');

      renderWithRouter(<RequestTable {...createProps({ 
        showLogFilter: true,
        filteredRequests: requests,
        totalCount: 5,
      })} />);

      const filterInput = screen.getByPlaceholderText('Filter logs...') as HTMLInputElement;
      expect(filterInput.value).toBe('sync');

      // Click clear button
      const clearButton = screen.getByLabelText('Clear input');
      fireEvent.click(clearButton);

      // Wait for debounce to trigger sync
      await new Promise(resolve =>  setTimeout(resolve, 350));

      expect(useLogStore.getState().logFilter).toBeNull();
      expect(filterInput.value).toBe('');
    });
  });

  describe('Log Filter Store to Input Sync', () => {
    it('syncs store changes back to SearchInput', async () => {
      const requests = createRequests(5);
      const rawLines = Array.from({ length: 10 }, (_, i) => 
        createParsedLogLine({ lineNumber: i, timestampUs: 1700000000000000 + i * 1000000 })
      );
      useLogStore.getState().setHttpRequests(requests, rawLines);

      renderWithRouter(<RequestTable {...createProps({ 
        showLogFilter: true,
        filteredRequests: requests,
        totalCount: 5,
      })} />);

      const filterInput = screen.getByPlaceholderText('Filter logs...') as HTMLInputElement;
      expect(filterInput.value).toBe('');

      // Change filter in store (e.g., via URL parameter)
      useLogStore.getState().setLogFilter('keys');

      // Wait for input to reflect store change
      await waitFor(() => {
        expect(filterInput.value).toBe('keys');
      });
    });

    it('clears input when store filter is cleared', async () => {
      const requests = createRequests(5);
      const rawLines = Array.from({ length: 10 }, (_, i) => 
        createParsedLogLine({ lineNumber: i, timestampUs: 1700000000000000 + i * 1000000 })
      );
      useLogStore.getState().setHttpRequests(requests, rawLines);
      useLogStore.getState().setLogFilter('sync');

      renderWithRouter(<RequestTable {...createProps({ 
        showLogFilter: true,
        filteredRequests: requests,
        totalCount: 5,
      })} />);

      const filterInput = screen.getByPlaceholderText('Filter logs...') as HTMLInputElement;
      expect(filterInput.value).toBe('sync');

      // Clear filter from store
      useLogStore.getState().setLogFilter(null);

      // Wait for input to be cleared
      await waitFor(() => {
        expect(filterInput.value).toBe('');
      });
    });
  });

  describe('Log Filter with Special Characters', () => {
    it('handles Matrix URIs with underscores and slashes', async () => {
      const requests = createRequests(5);
      const rawLines = Array.from({ length: 10 }, (_, i) => 
        createParsedLogLine({ lineNumber: i, timestampUs: 1700000000000000 + i * 1000000 })
      );
      useLogStore.getState().setHttpRequests(requests, rawLines);

      renderWithRouter(<RequestTable {...createProps({ 
        showLogFilter: true,
        filteredRequests: requests,
        totalCount: 5,
      })} />);

      const filterInput = screen.getByPlaceholderText('Filter logs...') as HTMLInputElement;
      const uri = '_matrix/client/r0/sync';
      
      fireEvent.change(filterInput, { target: { value: uri } });

      await new Promise(resolve => setTimeout(resolve, 350));

      expect(useLogStore.getState().logFilter).toBe(uri);
    });

    it('handles filter with query parameters', async () => {
      const requests = createRequests(5);
      const rawLines = Array.from({ length: 10 }, (_, i) => 
        createParsedLogLine({ lineNumber: i, timestampUs: 1700000000000000 + i * 1000000 })
      );
      useLogStore.getState().setHttpRequests(requests, rawLines);

      renderWithRouter(<RequestTable {...createProps({ 
        showLogFilter: true,
        filteredRequests: requests,
        totalCount: 5,
      })} />);

      const filterInput = screen.getByPlaceholderText('Filter logs...') as HTMLInputElement;
      const uri = '/sync?filter=state&limit=10';
      
      fireEvent.change(filterInput, { target: { value: uri } });

      await new Promise(resolve => setTimeout(resolve, 350));

      expect(useLogStore.getState().logFilter).toBe(uri);
    });

    it('handles filter with spaces', async () => {
      const requests = createRequests(5);
      const rawLines = Array.from({ length: 10 }, (_, i) => 
        createParsedLogLine({ lineNumber: i, timestampUs: 1700000000000000 + i * 1000000 })
      );
      useLogStore.getState().setHttpRequests(requests, rawLines);

      renderWithRouter(<RequestTable {...createProps({ 
        showLogFilter: true,
        filteredRequests: requests,
        totalCount: 5,
      })} />);

      const filterInput = screen.getByPlaceholderText('Filter logs...') as HTMLInputElement;
      const uri = 'room list sync';
      
      fireEvent.change(filterInput, { target: { value: uri } });

      await new Promise(resolve => setTimeout(resolve, 350));

      expect(useLogStore.getState().logFilter).toBe(uri);
    });
  });

  describe('Log Filter Escaping Behavior', () => {
    it('Escape key clears the filter input', async () => {
      const requests = createRequests(5);
      const rawLines = Array.from({ length: 10 }, (_, i) => 
        createParsedLogLine({ lineNumber: i, timestampUs: 1700000000000000 + i * 1000000 })
      );
      useLogStore.getState().setHttpRequests(requests, rawLines);

      renderWithRouter(<RequestTable {...createProps({ 
        showLogFilter: true,
        filteredRequests: requests,
        totalCount: 5,
      })} />);

      const filterInput = screen.getByPlaceholderText('Filter logs...') as HTMLInputElement;
      
      fireEvent.change(filterInput, { target: { value: 'sync' } });

      await new Promise(resolve => setTimeout(resolve, 350));
      
      expect(useLogStore.getState().logFilter).toBe('sync');

      // Press Escape
      fireEvent.keyDown(filterInput, { key: 'Escape' });

      await new Promise(resolve => setTimeout(resolve, 350));

      expect(useLogStore.getState().logFilter).toBeNull();
      expect(filterInput.value).toBe('');
    });
  });

  describe('Log Filter Persistence', () => {
    it('filter persists when other properties change', async () => {
      const requests = createRequests(5);
      const rawLines = Array.from({ length: 10 }, (_, i) => 
        createParsedLogLine({ lineNumber: i, timestampUs: 1700000000000000 + i * 1000000 })
      );
      useLogStore.getState().setHttpRequests(requests, rawLines);
      useLogStore.getState().setLogFilter('sync');

      const { rerender } = renderWithRouter(<RequestTable {...createProps({ 
        showLogFilter: true,
        filteredRequests: requests,
        totalCount: 5,
        msPerPixel: 10,
      })} />);

      expect(useLogStore.getState().logFilter).toBe('sync');

      // Change timeline scale
      useLogStore.getState().setTimelineScale(25);

      rerender(
        <MemoryRouter initialEntries={['/http_requests']}>
          <RequestTable {...createProps({ 
            showLogFilter: true,
            filteredRequests: requests,
            totalCount: 5,
            msPerPixel: 25,
          })} />
        </MemoryRouter>
      );

      // Filter should still be there
      expect(useLogStore.getState().logFilter).toBe('sync');

      const filterInput = screen.getByPlaceholderText('Filter logs...') as HTMLInputElement;
      expect(filterInput.value).toBe('sync');
    });
  });

  describe('collapse idle periods', () => {
    it('is checked by default', () => {
      renderWithRouter(<RequestTable {...createProps()} />);
      const checkbox = screen.getByRole('checkbox', { name: /collapse idle/i });
      expect(checkbox).toBeChecked();
    });

    it('unchecks when clicked (exercises setCollapseIdlePeriods onChange)', () => {
      renderWithRouter(<RequestTable {...createProps()} />);
      const checkbox = screen.getByRole('checkbox', { name: /collapse idle/i });
      fireEvent.click(checkbox);
      expect(checkbox).not.toBeChecked();
    });

    it('renders gap overlay label when idle gap exceeds collapse threshold', () => {
      const BASE_TS = 1_700_000_000_000_000;
      const req1 = createHttpRequest({ requestId: 'GAP-A', sendLineNumber: 0, responseLineNumber: 1, requestDurationMs: 500 });
      const req2 = createHttpRequest({ requestId: 'GAP-B', sendLineNumber: 2, responseLineNumber: 3, requestDurationMs: 500 });
      const rawLines = [
        createParsedLogLine({ lineNumber: 0, timestampUs: BASE_TS }),
        createParsedLogLine({ lineNumber: 1, timestampUs: BASE_TS + 500_000 }),
        createParsedLogLine({ lineNumber: 2, timestampUs: BASE_TS + 10_000_000 }),
        createParsedLogLine({ lineNumber: 3, timestampUs: BASE_TS + 10_500_000 }),
      ];
      useLogStore.getState().setHttpRequests([req1, req2], rawLines);

      renderWithRouter(<RequestTable {...createProps({ filteredRequests: [req1, req2], totalCount: 2, msPerPixel: 10 })} />);

      // The gap overlay span has a title starting with "No HTTP activity"
      const gapLabel = document.querySelector('[title^="No HTTP activity"]');
      expect(gapLabel).toBeInTheDocument();
    });
  });

  describe('row click handlers', () => {
    it('clicking a sticky row fires handleWaterfallRowClick without throwing', () => {
      const requests = createRequests(1);
      const rawLines = [
        createParsedLogLine({ lineNumber: 0, timestampUs: 1700000000000000 }),
        createParsedLogLine({ lineNumber: 1, timestampUs: 1700000001000000 }),
      ];
      useLogStore.getState().setHttpRequests(requests, rawLines);

      const { container } = renderWithRouter(<RequestTable {...createProps({ filteredRequests: requests, totalCount: 1 })} />);

      const row = container.querySelector('[data-row-id="sticky-1"]');
      expect(row).toBeInTheDocument();
      // handleWaterfallRowClick early-returns (no ref) but onClick arrow fn is exercised
      fireEvent.click(row!);
    });

    it('clicking a waterfall row fires handleWaterfallRowClick without throwing', () => {
      const requests = createRequests(1);
      const rawLines = [
        createParsedLogLine({ lineNumber: 0, timestampUs: 1700000000000000 }),
        createParsedLogLine({ lineNumber: 1, timestampUs: 1700000001000000 }),
      ];
      useLogStore.getState().setHttpRequests(requests, rawLines);

      const { container } = renderWithRouter(<RequestTable {...createProps({ filteredRequests: requests, totalCount: 1 })} />);

      const row = container.querySelector('[data-row-id="waterfall-1"]');
      expect(row).toBeInTheDocument();
      fireEvent.click(row!);
    });
  });

  describe('renderBarOverlay integration', () => {
    it('invokes renderBarOverlay for complete (non-incomplete) requests', () => {
      const req = createHttpRequest({ requestId: 'OVERLAY-REQ', status: '200', sendLineNumber: 0, responseLineNumber: 1 });
      const rawLines = [
        createParsedLogLine({ lineNumber: 0, timestampUs: 1700000000000000 }),
        createParsedLogLine({ lineNumber: 1, timestampUs: 1700000001000000 }),
      ];
      useLogStore.getState().setHttpRequests([req], rawLines);

      const renderBarOverlay = vi.fn().mockReturnValue(<div data-testid="bar-overlay" />);
      renderWithRouter(<RequestTable {...createProps({ filteredRequests: [req], totalCount: 1, renderBarOverlay })} />);

      expect(renderBarOverlay).toHaveBeenCalled();
      expect(screen.getByTestId('bar-overlay')).toBeInTheDocument();
    });
  });

  describe('log viewer close', () => {
    it('closes log viewer when onClose is called', async () => {
      const req = createHttpRequest({ requestId: 'REQ-CLOSE-TEST', sendLineNumber: 10, responseLineNumber: 20 });
      const rawLines = Array.from({ length: 25 }, (_, i) =>
        createParsedLogLine({ lineNumber: i, timestampUs: 1700000000000000 + i * 1000000 })
      );
      useLogStore.getState().setHttpRequests([req], rawLines);

      renderWithRouter(<RequestTable {...createProps({ filteredRequests: [req], totalCount: 1 })} />);

      act(() => {
        useLogStore.setState({
          openLogViewerIds: new Set<number>([10]),
          expandedRows: new Set<number>([10]),
        });
      });

      expect(await screen.findByTestId('log-display-view')).toBeInTheDocument();
      fireEvent.click(screen.getByText('Close'));
      expect(screen.queryByTestId('log-display-view')).not.toBeInTheDocument();
    });
  });

  describe('waterfall focus mode (focusModeColumnIds)', () => {
    const focusColumns: ColumnDef[] = [
      { id: 'requestId', label: 'Request', getValue: (r) => r.requestId },
      { id: 'uri', label: 'URI', getValue: (r) => r.uri },
      { id: 'method', label: 'Method', getValue: (r) => r.method },
    ];

    it('shows collapse toggle button when focusModeColumnIds is provided', () => {
      renderWithRouter(
        <RequestTable
          {...createProps({ columns: focusColumns, focusModeColumnIds: ['requestId'] })}
        />
      );
      expect(screen.getByRole('button', { name: /expand left panel/i })).toBeInTheDocument();
    });

    it('does not show collapse toggle button when focusModeColumnIds is absent', () => {
      renderWithRouter(<RequestTable {...createProps({ columns: focusColumns })} />);
      expect(screen.queryByRole('button', { name: /collapse left panel|expand left panel/i })).not.toBeInTheDocument();
    });

    it('starts collapsed (waterfallFocus=true) and expands on toggle click', () => {
      renderWithRouter(
        <RequestTable
          {...createProps({ columns: focusColumns, focusModeColumnIds: ['requestId'] })}
        />
      );
      // Initially collapsed — only focus column header visible
      expect(screen.getByText('Request')).toBeInTheDocument();
      expect(screen.queryByText('URI')).not.toBeInTheDocument();
      expect(screen.queryByText('Method')).not.toBeInTheDocument();

      // Click to expand
      fireEvent.click(screen.getByRole('button', { name: /expand left panel/i }));

      // All columns now visible
      expect(screen.getByText('URI')).toBeInTheDocument();
      expect(screen.getByText('Method')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /collapse left panel/i })).toBeInTheDocument();
    });

    it('surfaces hidden column values in last visible cell tooltip when collapsed', () => {
      const req = createHttpRequest({
        requestId: 'REQ-FOCUS',
        uri: '/example/path',
        method: 'POST',
        sendLineNumber: 10,
        responseLineNumber: 11,
        status: '200',
      });
      useLogStore.getState().setHttpRequests([req], [
        createParsedLogLine({ lineNumber: 10 }),
        createParsedLogLine({ lineNumber: 11 }),
      ]);

      const focusCols: ColumnDef[] = [
        { id: 'requestId', label: 'Request', getValue: (r) => r.requestId },
        { id: 'uri', label: 'URI', className: 'uri', getValue: (r) => r.uri },
        { id: 'method', label: 'Method', getValue: (r) => r.method },
      ];

      renderWithRouter(
        <RequestTable
          {...createProps({
            columns: focusCols,
            filteredRequests: [req],
            totalCount: 1,
            focusModeColumnIds: ['requestId', 'uri'],
          })}
        />
      );

      // In collapsed mode the last focus column (URI) title should include the hidden method value
      const uriCells = document.querySelectorAll('[title]');
      const uriCell = Array.from(uriCells).find((el) =>
        el.getAttribute('title')?.includes('/example/path')
      );
      expect(uriCell?.getAttribute('title')).toContain('POST');
    });

    it('surfaces hidden column values on requestId cell when it is the only visible column', () => {
      const req = createHttpRequest({
        requestId: 'REQ-SINGLE',
        uri: '/sync',
        method: 'GET',
        sendLineNumber: 20,
        responseLineNumber: 21,
        status: '200',
      });
      useLogStore.getState().setHttpRequests([req], [
        createParsedLogLine({ lineNumber: 20 }),
        createParsedLogLine({ lineNumber: 21 }),
      ]);

      const singleFocusCols: ColumnDef[] = [
        { id: 'requestId', label: 'Request', getValue: (r) => r.requestId },
        { id: 'uri', label: 'URI', getValue: (r) => r.uri },
      ];

      renderWithRouter(
        <RequestTable
          {...createProps({
            columns: singleFocusCols,
            filteredRequests: [req],
            totalCount: 1,
            focusModeColumnIds: ['requestId'],
          })}
        />
      );

      // requestId is the only visible column — its title should include the hidden URI value
      const idCell = document.querySelector(`[data-testid="request-id-REQ-SINGLE"]`);
      expect(idCell?.getAttribute('title')).toContain('/sync');
    });
  });
});

// Helper to create requests for tests
function createRequests(count: number) {
  return Array.from({ length: count }, (_, i) => 
    createHttpRequest({ 
      requestId: `REQ-${i}`,
      sendLineNumber: i * 2,
      responseLineNumber: i * 2 + 1,
    })
  );
}

describe('RequestTable — multi-attempt segment rendering', () => {
  beforeEach(() => {
    useLogStore.getState().clearData();
  });

  it('renders colored segment divs inside the bar for a fully-resolved retry request', () => {
    const BASE_TS = 1_700_000_000_000_000;
    const req = createHttpRequest({
      requestId: 'RETRY-REQ',
      uri: 'https://example.org/rooms/messages',
      status: '200',
      sendLineNumber: 0,
      responseLineNumber: 5,
      requestDurationMs: 62000,
      numAttempts: 2,
      attemptTimestampsUs: [BASE_TS, BASE_TS + 30_000_000] as unknown as readonly import('../../types/time.types').TimestampMicros[],
      attemptOutcomes: ['TimedOut', '200'],
    });
    const rawLines = [
      createParsedLogLine({ lineNumber: 0, timestampUs: BASE_TS }),
      createParsedLogLine({ lineNumber: 5, timestampUs: BASE_TS + 62_000_000 }),
    ];
    useLogStore.getState().setHttpRequests([req], rawLines);

    renderWithRouter(
      <RequestTable
        {...createProps({ filteredRequests: [req], totalCount: 1, msPerPixel: 10 })}
      />
    );

    // The bar should contain 2 attempt segment divs (one per attempt)
    const segments = document.querySelectorAll('[data-testid="attempt-segment"]');
    expect(segments.length).toBeGreaterThanOrEqual(2);
  });

  it('shows per-attempt durations and total in the waterfall duration label for retry requests', () => {
    const BASE_TS = 1_700_000_000_000_000;
    // Attempt 1: 30 000 ms (TimedOut), Attempt 2: 32 000 ms (200 OK), total: 62 000 ms
    const req = createHttpRequest({
      requestId: 'RETRY-TOOLTIP',
      uri: 'https://example.org/rooms/messages',
      status: '200',
      sendLineNumber: 0,
      responseLineNumber: 5,
      requestDurationMs: 62000,
      numAttempts: 2,
      attemptTimestampsUs: [BASE_TS, BASE_TS + 30_000_000] as unknown as readonly import('../../types/time.types').TimestampMicros[],
      attemptOutcomes: ['TimedOut', '200'],
    });
    const rawLines = [
      createParsedLogLine({ lineNumber: 0, timestampUs: BASE_TS }),
      createParsedLogLine({ lineNumber: 5, timestampUs: BASE_TS + 62_000_000 }),
    ];
    useLogStore.getState().setHttpRequests([req], rawLines);

    renderWithRouter(
      <RequestTable
        {...createProps({ filteredRequests: [req], totalCount: 1, msPerPixel: 10 })}
      />
    );

    // The duration label next to the bar should list each attempt with its own duration
    const expectedLabel = '↻2: TimedOut (30000ms) → 200 (32000ms) — 62000ms';
    const durationSpans = Array.from(document.querySelectorAll('span')).filter(
      (el) => el.textContent === expectedLabel
    );
    expect(durationSpans.length).toBeGreaterThanOrEqual(1);
  });
});

describe('RequestTable — auto-scale effect', () => {
  // Two short-duration requests with a sub-threshold gap (< 5 s).
  // totalActiveMs = 100+100 = 200 ms; containerWidth = 800 px.
  // raw = 200/800 = 0.25 → snaps to step 5 (different from default 10).
  const BASE_TS = 1_700_000_000_000_000;
  function setupRequests() {
    const requests = [
      createHttpRequest({ requestId: 'AS-1', sendLineNumber: 0, responseLineNumber: 1, requestDurationMs: 100 }),
      createHttpRequest({ requestId: 'AS-2', sendLineNumber: 2, responseLineNumber: 3, requestDurationMs: 100 }),
    ];
    const rawLines = [
      createParsedLogLine({ lineNumber: 0, timestampUs: BASE_TS }),
      createParsedLogLine({ lineNumber: 1, timestampUs: BASE_TS + 100_000 }),
      createParsedLogLine({ lineNumber: 2, timestampUs: BASE_TS + 1_000_000 }),
      createParsedLogLine({ lineNumber: 3, timestampUs: BASE_TS + 1_100_000 }),
    ];
    useLogStore.getState().setHttpRequests(requests, rawLines);
    return requests;
  }

  beforeEach(() => {
    _hasExplicitScale = false;
    useLogStore.getState().clearData();
    // Mock clientWidth so the resize effect sets containerWidth to 800 immediately.
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => 800,
    });
  });

  afterEach(() => {
    _hasExplicitScale = false;
    // Restore clientWidth to the jsdom default (0)
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => 0,
    });
  });

  it('applies auto-scale when containerWidth > 0 and no explicit scale', () => {
    const requests = setupRequests();
    renderWithRouter(
      <RequestTable {...createProps({ filteredRequests: requests, totalCount: 2, msPerPixel: 10 })} />
    );
    // Scale should have been set to 5 (snapped from raw ≈ 0.25)
    expect(useLogStore.getState().timelineScale).toBe(5);
  });

  it('skips auto-scale when hasExplicitScale is true', () => {
    const requests = setupRequests();
    _hasExplicitScale = true;
    useLogStore.getState().setTimelineScale(10); // pre-set the store value
    renderWithRouter(
      <RequestTable {...createProps({ filteredRequests: requests, totalCount: 2, msPerPixel: 10 })} />
    );
    expect(useLogStore.getState().timelineScale).toBe(10); // unchanged
  });

  it('skips auto-scale when computeAutoScale returns null (no timestamps)', () => {
    // Requests present but rawLines not loaded → lineNumberIndex is empty → timestamps = 0 → filtered out
    const requests = [
      createHttpRequest({ requestId: 'NO-TS', sendLineNumber: 0, responseLineNumber: 1 }),
    ];
    useLogStore.getState().setTimelineScale(10);
    renderWithRouter(
      <RequestTable {...createProps({ filteredRequests: requests, totalCount: 1, msPerPixel: 10 })} />
    );
    expect(useLogStore.getState().timelineScale).toBe(10); // unchanged
  });

  it('applies auto-scale only once per mount (autoScaleApplied guard)', () => {
    const requests = setupRequests();
    const { rerender } = renderWithRouter(
      <RequestTable {...createProps({ filteredRequests: requests, totalCount: 2, msPerPixel: 10 })} />
    );
    expect(useLogStore.getState().timelineScale).toBe(5); // auto-scale fired

    // Update scale in store to simulate user adjusting it
    act(() => { useLogStore.getState().setTimelineScale(50); });

    // Rerender with different requests — timeData dep changes, effect re-runs, but guard blocks
    const moreRequests = [
      createHttpRequest({ requestId: 'AS-3', sendLineNumber: 0, responseLineNumber: 1, requestDurationMs: 100 }),
    ];
    rerender(
      <MemoryRouter initialEntries={['/http_requests']}>
        <RequestTable {...createProps({ filteredRequests: moreRequests, totalCount: 1, msPerPixel: 50 })} />
      </MemoryRouter>
    );
    // Scale should still be 50 (guard prevented re-fire)
    expect(useLogStore.getState().timelineScale).toBe(50);
  });
});

describe('RequestTable — process colours (merged multi-process logs)', () => {
  beforeEach(() => {
    useLogStore.getState().clearData();
  });

  it('shows a legend and tints rows by process when several processes are merged', () => {
    const reqs = [
      createHttpRequest({ requestId: 'A', sendLineNumber: 10, responseLineNumber: 11 }),
      createHttpRequest({ requestId: 'B', sendLineNumber: 20, responseLineNumber: 21 }),
    ];
    const lineA = createParsedLogLine({ lineNumber: 10, sourceFile: 'console.2026-04-14-08.log.gz' });
    const lineB = createParsedLogLine({ lineNumber: 20, sourceFile: 'nse.2026-04-14-08.log.gz' });
    useLogStore.setState({
      rawLogLines: [lineA, lineB],
      lineNumberIndex: new Map([[10, lineA], [20, lineB]]),
      loadedEntryNames: ['console.2026-04-14-08.log.gz', 'nse.2026-04-14-08.log.gz'],
    });

    renderWithRouter(<RequestTable {...createProps({ filteredRequests: reqs, totalCount: 2 })} />);

    const legend = screen.getByLabelText('Process colour legend');
    expect(legend).toHaveTextContent('console');
    expect(legend).toHaveTextContent('nse');

    const rowA = document.querySelector('[data-row-id="sticky-10"]') as HTMLElement;
    // Stripe is on the inner sticky-row element (above its opaque background).
    const stickyA = rowA.querySelector('div') as HTMLElement;
    expect(stickyA.style.boxShadow).toContain('inset');
  });

  it('shows no legend for a single process', () => {
    const reqs = [createHttpRequest({ requestId: 'A', sendLineNumber: 10, responseLineNumber: 11 })];
    const lineA = createParsedLogLine({ lineNumber: 10, sourceFile: 'console.2026-04-14-08.log.gz' });
    useLogStore.setState({
      rawLogLines: [lineA],
      lineNumberIndex: new Map([[10, lineA]]),
      loadedEntryNames: ['console.2026-04-14-08.log.gz'],
    });

    renderWithRouter(<RequestTable {...createProps({ filteredRequests: reqs, totalCount: 1 })} />);

    expect(screen.queryByLabelText('Process colour legend')).not.toBeInTheDocument();
  });
});

/**
 * Tests for ListingView.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ListingView } from '../ListingView';
import { useListingStore } from '../../stores/listingStore';
import { clearMatrixProfiles } from '../../utils/matrixProfile';

const {
  mockNavigate,
  mockOpenMergedEntries,
  mockFetchExtensionFileBytes,
} = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockOpenMergedEntries: vi.fn(),
  mockFetchExtensionFileBytes: vi.fn(),
}));

vi.mock('../../components/BurgerMenu', () => ({
  BurgerMenu: () => <div data-testid="burger-menu" />,
}));

vi.mock('../../utils/extensionFileLoader', () => ({
  fetchExtensionFileBytes: mockFetchExtensionFileBytes,
}));

vi.mock('../../utils/openMergedLogs', () => ({
  openMergedEntries: mockOpenMergedEntries,
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

type RuntimeMessage =
  | { readonly type: 'fetchListing'; readonly listingUrl: string }
  | { readonly type: 'fetchDetails'; readonly detailsUrl: string }
  | { readonly type: 'fetchAndSummarize'; readonly url: string };

interface ListingEntryFixture {
  readonly name: string;
  readonly url: string;
}

const LISTING_URL = 'https://rageshakes.example.com/api/listing/2026-03-04/DEMO0001/';
const DETAILS_URL = `${LISTING_URL}details.json`;

const DEFAULT_ENTRIES: readonly ListingEntryFixture[] = [
  { name: 'details.json', url: DETAILS_URL },
  { name: 'console.2026-03-04-10.log.gz', url: `${LISTING_URL}console.2026-03-04-10.log.gz` },
  { name: 'logcat.log.gz', url: `${LISTING_URL}logcat.log.gz` },
  { name: 'screenshot.png', url: `${LISTING_URL}screenshot.png` },
];

function makeSummary(totalLines = 5) {
  return {
    totalLines,
    errorCount: 1,
    warnCount: 2,
    sentryCount: 3,
    httpCount: 4,
    totalUploadBytes: 1024,
    totalDownloadBytes: 2048,
    statusCodes: { '200': 2, '404': 1 },
    utdCount: 0,
    utdReasons: {},
    cryptoSteps: [],
  };
}

function makeExtensionRuntime(handler: (message: RuntimeMessage) => Promise<unknown>): typeof chrome {
  return {
    runtime: {
      sendMessage: handler,
    },
  } as unknown as typeof chrome;
}

function installExtensionRuntime(options?: {
  readonly entries?: readonly ListingEntryFixture[];
  readonly detailsText?: string;
  readonly summary?: ReturnType<typeof makeSummary>;
  readonly onMessage?: (message: RuntimeMessage) => void;
  readonly failListing?: boolean;
  readonly failDetails?: boolean;
  readonly failSummaryUrls?: readonly string[];
  readonly rejectListing?: boolean;
  readonly rejectDetails?: boolean;
  readonly rejectSummaryUrls?: readonly string[];
}): ReturnType<typeof vi.fn> {
  const sendMessage = vi.fn(async (message: RuntimeMessage) => {
    options?.onMessage?.(message);
    if (message.type === 'fetchListing') {
      if (options?.rejectListing) throw new Error('listing rejected');
      if (options?.failListing) return { ok: false, error: 'listing failed' };
      return {
        ok: true,
        entries: options?.entries ?? DEFAULT_ENTRIES,
        detailsUrl: DETAILS_URL,
      };
    }
    if (message.type === 'fetchDetails') {
      if (options?.rejectDetails) throw new Error('details rejected');
      if (options?.failDetails) return { ok: false, error: 'details failed' };
      return {
        ok: true,
        text:
          options?.detailsText ??
          JSON.stringify({
            user_text: 'The app crashed',
            data: {
              user_id: '@alice:example.com',
              device_id: 'ABC123',
              device_keys: 'curve25519:key',
              base_bundle_identifier: 'io.element.app',
              Version: '1.2.3',
              sdk_sha: 'deadbeef',
            },
          }),
      };
    }
    if (message.type === 'fetchAndSummarize') {
      if (options?.rejectSummaryUrls?.includes(message.url)) {
        throw new Error('summary rejected');
      }
      if (options?.failSummaryUrls?.includes(message.url)) {
        return { ok: false, error: 'summary failed' };
      }
      return {
        ok: true,
        summary: options?.summary ?? makeSummary(),
      };
    }
  });

  globalThis.chrome = makeExtensionRuntime(sendMessage);
  return sendMessage;
}

function renderListingView(initialEntry = `/listing?listingUrl=${encodeURIComponent(LISTING_URL)}`) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/listing" element={<ListingView />} />
        <Route path="/summary" element={<div data-testid="summary-view" />} />
        <Route path="/logs" element={<div data-testid="logs-view" />} />
        <Route path="/" element={<div data-testid="landing-view" />} />
      </Routes>
    </MemoryRouter>
  );
}

let originalFetch: typeof global.fetch | undefined;
let originalOpen: typeof window.open;
let originalCreateObjectURL: typeof URL.createObjectURL;
let originalRevokeObjectURL: typeof URL.revokeObjectURL;

beforeEach(() => {
  useListingStore.getState().clearListing();
  useListingStore.setState({ allVisited: {}, visitedEntries: new Set() });
  vi.clearAllMocks();

  mockOpenMergedEntries.mockResolvedValue('/summary');
  mockFetchExtensionFileBytes.mockResolvedValue(new TextEncoder().encode('raw log text'));

  originalFetch = global.fetch;
  originalOpen = window.open;
  originalCreateObjectURL = URL.createObjectURL;
  originalRevokeObjectURL = URL.revokeObjectURL;

  global.fetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ displayname: 'Alice', avatar_url: 'mxc://example.com/abc123' }), {
      status: 200,
    })
  );
  window.open = vi.fn().mockReturnValue({ closed: false } as Window);
  URL.createObjectURL = vi.fn().mockReturnValue('blob:test-url');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  clearMatrixProfiles();
  global.fetch = originalFetch as typeof global.fetch;
  window.open = originalOpen;
  URL.createObjectURL = originalCreateObjectURL ?? ((() => '') as typeof URL.createObjectURL);
  URL.revokeObjectURL = originalRevokeObjectURL ?? ((() => {}) as typeof URL.revokeObjectURL);
  if ('chrome' in globalThis) {
    // @ts-expect-error test cleanup for injected global
    delete globalThis.chrome;
  }
  vi.restoreAllMocks();
});

describe('ListingView', () => {
  it('redirects to the landing page when opened without a listingUrl and no cached listing', () => {
    renderListingView('/listing');

    expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true });
    expect(screen.queryByText('Listing')).not.toBeInTheDocument();
  });

  it('renders cached entries with a fallback label when listingUrl is invalid and chrome is unavailable', () => {
    useListingStore.getState().loadListing('not a valid url', DEFAULT_ENTRIES);

    renderListingView('/listing?listingUrl=not%20a%20valid%20url');

    expect(screen.getByText('Listing')).toBeInTheDocument();
    expect(screen.getByText('4 files')).toBeInTheDocument();
  });

  it('loads the listing, renders the archive-style table, and shows the details panel', async () => {
    installExtensionRuntime();

    renderListingView();

    await waitFor(() => {
      expect(screen.getByText('2026-03-04/DEMO0001')).toBeInTheDocument();
    });

    expect(screen.getByText('4 files')).toBeInTheDocument();
    expect(screen.getByText('console.2026-03-04-10.log.gz')).toBeInTheDocument();
    expect(screen.getByText('details.json')).toBeInTheDocument();
    expect(screen.getAllByText('screenshot.png').length).toBeGreaterThanOrEqual(1);

    await waitFor(() => {
      expect(useListingStore.getState().listingSummaries.size).toBe(2);
    });

    expect(screen.getByText('The app crashed')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /@alice:example\.com/i })).toHaveAttribute(
      'href',
      expect.stringContaining('matrix.to')
    );
    expect(screen.getByText('io.element.app')).toBeInTheDocument();
    expect(screen.getByText('1.2.3')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /deadbeef/i })).toHaveAttribute(
      'href',
      'https://github.com/matrix-org/matrix-rust-sdk/commit/deadbeef'
    );

    await waitFor(() => {
      expect(screen.getByText('Alice')).toBeInTheDocument();
    });
  });

  it('sorts dated logs before undated entries', async () => {
    installExtensionRuntime({
      entries: [
        { name: 'details.json', url: DETAILS_URL },
        { name: 'console.2026-03-04-09.log.gz', url: `${LISTING_URL}console.2026-03-04-09.log.gz` },
        { name: 'console.2026-03-04-10.log.gz', url: `${LISTING_URL}console.2026-03-04-10.log.gz` },
      ],
    });

    renderListingView();

    await waitFor(() => {
      expect(screen.getByText('3 files')).toBeInTheDocument();
    });

    const rows = screen.getAllByRole('row');
    expect(rows[1]).toHaveTextContent('console.2026-03-04-10.log.gz');
    expect(rows[2]).toHaveTextContent('console.2026-03-04-09.log.gz');
    expect(rows[3]).toHaveTextContent('details.json');
  });

  it('renders 5xx and non-numeric status chips from cached summaries', () => {
    useListingStore.getState().loadListing(LISTING_URL, [
      { name: 'console.2026-03-04-10.log.gz', url: `${LISTING_URL}console.2026-03-04-10.log.gz` },
    ]);
    useListingStore.getState().setListingSummary('console.2026-03-04-10.log.gz', {
      ...makeSummary(),
      statusCodes: {
        '500': 1,
        'client-error': 2,
        incomplete: 3,
      },
    });

    renderListingView();

    expect(screen.getByText('500')).toBeInTheDocument();
    expect(screen.getByText('client-error')).toBeInTheDocument();
    expect(screen.getByText('incomplete')).toBeInTheDocument();
  });

  it('opens dated logs inside the viewer summary route', async () => {
    installExtensionRuntime();
    mockOpenMergedEntries.mockResolvedValue('/summary');

    renderListingView();

    const button = await screen.findByRole('button', { name: /open console\.2026-03-04-10\.log\.gz/i });
    await act(async () => {
      fireEvent.click(button);
    });

    expect(mockOpenMergedEntries).toHaveBeenCalledWith(['console.2026-03-04-10.log.gz']);
    expect(mockNavigate).toHaveBeenCalledWith('/summary');
  });

  it('does not navigate when opening a single entry yields no route', async () => {
    installExtensionRuntime();
    mockOpenMergedEntries.mockResolvedValue(null);

    renderListingView();

    const button = await screen.findByRole('button', { name: /open console\.2026-03-04-10\.log\.gz/i });
    await act(async () => {
      fireEvent.click(button);
    });

    expect(mockOpenMergedEntries).toHaveBeenCalledWith(['console.2026-03-04-10.log.gz']);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('opens undated logs inside the viewer logs route', async () => {
    installExtensionRuntime();
    mockOpenMergedEntries.mockResolvedValue('/logs');

    renderListingView();

    const button = await screen.findByRole('button', { name: /open logcat\.log\.gz/i });
    await act(async () => {
      fireEvent.click(button);
    });

    expect(mockNavigate).toHaveBeenCalledWith('/logs');
  });

  it('opens non-log entries directly in the browser', async () => {
    installExtensionRuntime();

    renderListingView();

    const button = await screen.findByRole('button', { name: /open details\.json/i });
    await act(async () => {
      fireEvent.click(button);
    });

    expect(window.open).toHaveBeenCalledWith(DETAILS_URL, '_blank', 'noopener,noreferrer');
  });

  it('opens raw log text in a blob URL', async () => {
    installExtensionRuntime();

    renderListingView();

    const button = await screen.findByRole('button', { name: /open raw text of console\.2026-03-04-10\.log\.gz/i });
    await act(async () => {
      fireEvent.click(button);
    });

    expect(mockFetchExtensionFileBytes).toHaveBeenCalledWith(
      `${LISTING_URL}console.2026-03-04-10.log.gz`,
      'console.2026-03-04-10.log.gz'
    );
    expect(URL.createObjectURL).toHaveBeenCalled();
  });

  it('revokes the raw blob immediately when the popup is blocked', async () => {
    installExtensionRuntime();
    window.open = vi.fn().mockReturnValue(null);

    renderListingView();

    const button = await screen.findByRole('button', { name: /open raw text of console\.2026-03-04-10\.log\.gz/i });
    await act(async () => {
      fireEvent.click(button);
    });

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-url');
  });

  it('renders PNG gallery cards and opens PNG files directly', async () => {
    installExtensionRuntime();

    renderListingView();

    const allButtons = await screen.findAllByRole('button', { name: /open screenshot\.png/i });
    const galleryButton = allButtons.find((candidate) => candidate.querySelector('img'));

    expect(galleryButton).toBeTruthy();
    await act(async () => {
      fireEvent.click(galleryButton!);
    });

    expect(window.open).toHaveBeenCalledWith(
      `${LISTING_URL}screenshot.png`,
      '_blank',
      'noopener,noreferrer'
    );
  });

  it('navigates back to landing when fetchListing fails', async () => {
    installExtensionRuntime({ failListing: true });

    renderListingView();

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true });
    });
  });

  it('navigates back to landing when fetchListing rejects', async () => {
    installExtensionRuntime({ rejectListing: true });

    renderListingView();

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true });
    });
  });

  it('does not render the details panel when fetchDetails fails', async () => {
    installExtensionRuntime({ failDetails: true });

    renderListingView();

    await waitFor(() => {
      expect(screen.getByText('4 files')).toBeInTheDocument();
    });

    expect(screen.queryByText('The app crashed')).not.toBeInTheDocument();
  });

  it('clears parsed details when fetchDetails rejects', async () => {
    installExtensionRuntime({ rejectDetails: true });

    renderListingView();

    await waitFor(() => {
      expect(screen.getByText('4 files')).toBeInTheDocument();
    });

    expect(screen.queryByText('The app crashed')).not.toBeInTheDocument();
  });

  it('does not fetch a Matrix profile for invalid homeserver values', async () => {
    installExtensionRuntime({
      detailsText: JSON.stringify({
        data: {
          user_id: '@alice:localhost',
        },
      }),
    });

    renderListingView();

    await waitFor(() => {
      expect(screen.getByText('details.json')).toBeInTheDocument();
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('preserves cached summaries when revisiting the same listing', async () => {
    const sendMessageCalls: RuntimeMessage[] = [];
    installExtensionRuntime({ onMessage: (message) => sendMessageCalls.push(message) });
    useListingStore.getState().loadListing(LISTING_URL, DEFAULT_ENTRIES);
    useListingStore.getState().setListingSummary('console.2026-03-04-10.log.gz', makeSummary(99));

    renderListingView();

    await waitFor(() => {
      expect(screen.getByText('99')).toBeInTheDocument();
    });

    expect(sendMessageCalls.filter((message) => message.type === 'fetchAndSummarize')).toHaveLength(1);
  });

  it('stores a zero summary when the background summarize request fails', async () => {
    installExtensionRuntime({ failSummaryUrls: [`${LISTING_URL}console.2026-03-04-10.log.gz`] });

    renderListingView();

    await waitFor(() => {
      expect(useListingStore.getState().listingSummaries.get('console.2026-03-04-10.log.gz')?.totalLines).toBe(0);
    });
  });

  it('stores a zero summary when the background summarize request rejects', async () => {
    globalThis.chrome = makeExtensionRuntime(async (message) => {
      if (message.type === 'fetchListing') {
        return { ok: true, entries: DEFAULT_ENTRIES, detailsUrl: DETAILS_URL };
      }
      if (message.type === 'fetchDetails') {
        return { ok: false, error: 'details failed' };
      }
      throw new Error('summary rejected');
    });

    renderListingView();

    await waitFor(() => {
      expect(useListingStore.getState().listingSummaries.get('console.2026-03-04-10.log.gz')?.totalLines).toBe(0);
    });
  });

  describe('multi-select open', () => {
    it('opens the ticked files merged via openMergedEntries', async () => {
      installExtensionRuntime();
      mockOpenMergedEntries.mockResolvedValue('/summary');
      renderListingView();

      const checkbox = await screen.findByRole('checkbox', { name: /select console\.2026-03-04-10/i });
      fireEvent.click(checkbox);

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /open 1 file together/i }));
      });

      expect(mockOpenMergedEntries).toHaveBeenCalledWith(['console.2026-03-04-10.log.gz']);
      expect(mockNavigate).toHaveBeenCalledWith('/summary');
    });

    it('select-all then Clear toggles the action bar', async () => {
      installExtensionRuntime();
      renderListingView();

      const selectAll = await screen.findByRole('checkbox', { name: /select all log files/i });
      fireEvent.click(selectAll);
      // console.*.log.gz + logcat.log.gz are analyzable → 2 files
      expect(screen.getByRole('button', { name: /open 2 files together/i })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /^clear$/i }));
      expect(screen.queryByRole('button', { name: /open .* together/i })).not.toBeInTheDocument();
    });

    it('unticking a file and toggling select-all off both clear the selection', async () => {
      installExtensionRuntime();
      renderListingView();

      const cb = await screen.findByRole('checkbox', { name: /select console\.2026-03-04-10/i });
      fireEvent.click(cb); // tick
      expect(screen.getByRole('button', { name: /open 1 file together/i })).toBeInTheDocument();
      fireEvent.click(cb); // untick
      expect(screen.queryByRole('button', { name: /open .* together/i })).not.toBeInTheDocument();

      const selectAll = screen.getByRole('checkbox', { name: /select all log files/i });
      fireEvent.click(selectAll); // all ticked
      expect(screen.getByRole('button', { name: /open 2 files together/i })).toBeInTheDocument();
      fireEvent.click(selectAll); // toggle off → cleared
      expect(screen.queryByRole('button', { name: /open .* together/i })).not.toBeInTheDocument();
    });

    it('does not navigate when opening yields no route', async () => {
      installExtensionRuntime();
      mockOpenMergedEntries.mockResolvedValue(null);
      renderListingView();

      const checkbox = await screen.findByRole('checkbox', { name: /select console\.2026-03-04-10/i });
      fireEvent.click(checkbox);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /open 1 file together/i }));
      });

      expect(mockOpenMergedEntries).toHaveBeenCalled();
      expect(mockNavigate).not.toHaveBeenCalled();
    });
  });
});
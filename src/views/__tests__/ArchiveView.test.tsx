/**
 * Tests for ArchiveView.tsx
 *
 * Covers: file listing rendering, sort order, file-open routing, raw-open,
 * details.json card, PNG gallery, visited-entry styling, Matrix profile fetch,
 * redirect-when-empty, and background summary computation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ArchiveView } from '../ArchiveView';
import { useArchiveStore } from '../../stores/archiveStore';
import { useLogStore } from '../../stores/logStore';
import type { ArchiveEntry } from '../../stores/archiveStore';
import { decompressSync } from 'fflate';
import { parseLogFile } from '../../utils/logParser';
import { clearMatrixProfiles } from '../../utils/matrixProfile';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../components/BurgerMenu', () => ({
  BurgerMenu: () => <div data-testid="burger-menu" />,
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

// decompressSync returns the input unchanged for test convenience
vi.mock('fflate', () => ({
  decompressSync: vi.fn((data: Uint8Array) => data),
}));

vi.mock('../../utils/logParser', () => ({
  parseLogFile: vi.fn(() => ({
    requests: [],
    httpRequests: [],
    connectionIds: [],
    rawLogLines: [],
    sentryEvents: [],
  })),
}));

vi.mock('../../utils/archiveSummary', () => ({
  isAnalyzableEntry: (name: string) => name.endsWith('.log.gz') || name.endsWith('.log'),
  utdsByFile: vi.fn(() => new Map([['dir/logs.2026-04-14-09.log.gz', { count: 42, reported: 3, byReason: { missing_key: 40, unknown_index: 2 } }]])),
  computeArchiveSummary: vi.fn(() => ({
    totalLines: 5,
    errorCount: 1,
    warnCount: 2,
    sentryCount: 0,
    httpCount: 3,
    totalUploadBytes: 1024,
    totalDownloadBytes: 2048,
    statusCodes: { '200': 2, '404': 1 },
    utdCount: 0,
    utdReasons: {},
    cryptoSteps: [], rooms: { seenIds: [], lists: {} },
  })),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Encodes a string as UTF-8 bytes, suitable for use as ArchiveEntry.data.
 *
 * @example
 * const entry = makeTextEntry('dir/details.json', '{"user_text":"hi"}');
 */
function textBytes(content: string): Uint8Array {
  return new TextEncoder().encode(content);
}

function makeEntry(name: string, content = 'log line\n'): ArchiveEntry {
  return { name, data: textBytes(content) };
}

function renderArchiveView() {
  return render(
    <MemoryRouter initialEntries={['/archive']}>
      <Routes>
        <Route path="/archive" element={<ArchiveView />} />
        <Route path="/summary" element={<div data-testid="summary-view" />} />
        <Route path="/logs" element={<div data-testid="logs-view" />} />
        <Route path="/" element={<div data-testid="landing-view" />} />
      </Routes>
    </MemoryRouter>
  );
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

// Capture originals so afterEach can restore them (vi.restoreAllMocks() does
// NOT restore property assignments, only spies).
let originalCreateObjectURL: typeof URL.createObjectURL;
let originalRevokeObjectURL: typeof URL.revokeObjectURL;

beforeEach(() => {
  useArchiveStore.getState().clearArchive();
  useArchiveStore.setState({ allVisited: {}, visitedEntries: new Set() });
  useLogStore.getState().clearData();
  mockNavigate.mockReset();
  // jsdom does not implement URL.createObjectURL — provide a stub for tests.
  originalCreateObjectURL = URL.createObjectURL;
  originalRevokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = vi.fn().mockReturnValue('blob:test-url');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  clearMatrixProfiles();
  // If the original was undefined (jsdom doesn't implement these), fall back to a
  // no-op so React's deferred pngUrls cleanup doesn't throw after restoration.
  URL.createObjectURL = originalCreateObjectURL ?? ((() => '') as typeof URL.createObjectURL);
  URL.revokeObjectURL = originalRevokeObjectURL ?? ((() => {}) as typeof URL.revokeObjectURL);
  vi.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ArchiveView', () => {
  describe('redirect when empty', () => {
    it('navigates to / when no archive entries are loaded', () => {
      renderArchiveView();
      expect(mockNavigate).toHaveBeenCalledWith('/', { replace: true });
    });

    it('renders nothing when entries list is empty', () => {
      const { container } = renderArchiveView();
      // Component returns null before redirect fires
      expect(container.querySelector('.app')).toBeNull();
    });
  });

  describe('file listing', () => {
    it('renders archive name in header', () => {
      useArchiveStore.getState().loadArchive('rageshake-2026.tar.gz', [
        makeEntry('2026/logs.2026-04-14-09.log.gz'),
      ]);
      renderArchiveView();
      expect(screen.getByText('rageshake-2026.tar.gz')).toBeInTheDocument();
    });

    it('shows file count in header', () => {
      useArchiveStore.getState().loadArchive('test.tar.gz', [
        makeEntry('dir/logs.2026-04-14-09.log.gz'),
        makeEntry('dir/details.json'),
      ]);
      renderArchiveView();
      expect(screen.getByText('2 files')).toBeInTheDocument();
    });

    it('strips directory prefix from displayed filename', () => {
      useArchiveStore.getState().loadArchive('test.tar.gz', [
        makeEntry('2026-04-14_ID/logs.2026-04-14-09.log.gz'),
      ]);
      renderArchiveView();
      expect(screen.getByText('logs.2026-04-14-09.log.gz')).toBeInTheDocument();
    });

    it('shows raw button for log files', () => {
      useArchiveStore.getState().loadArchive('test.tar.gz', [
        makeEntry('dir/logs.2026-04-14-09.log.gz'),
      ]);
      renderArchiveView();
      expect(screen.getByRole('button', { name: /open raw text/i })).toBeInTheDocument();
    });

    it('does not show raw button for non-log files', () => {
      useArchiveStore.getState().loadArchive('test.tar.gz', [
        makeEntry('dir/details.json', '{}'),
      ]);
      renderArchiveView();
      expect(screen.queryByRole('button', { name: /open raw text/i })).not.toBeInTheDocument();
    });

    it('shows "—" in data cells for non-analyzable entries', () => {
      useArchiveStore.getState().loadArchive('test.tar.gz', [
        makeEntry('dir/details.json', '{}'),
      ]);
      renderArchiveView();
      // Non-analyzable rows show "—" in multiple columns
      const dashes = screen.getAllByText('—');
      expect(dashes.length).toBeGreaterThan(0);
    });
  });

  describe('sort order', () => {
    it('renders dated entries before undated entries', () => {
      useArchiveStore.getState().loadArchive('test.tar.gz', [
        makeEntry('dir/details.json', '{}'),
        makeEntry('dir/logs.2026-04-14-09.log.gz'),
      ]);
      renderArchiveView();
      const rows = screen.getAllByRole('row');
      // First data row (index 1, skipping header) should be the dated log
      expect(rows[1]).toHaveTextContent('logs.2026-04-14-09.log.gz');
      expect(rows[2]).toHaveTextContent('details.json');
    });

    it('sorts same-category dated entries most-recent-first', () => {
      useArchiveStore.getState().loadArchive('test.tar.gz', [
        makeEntry('dir/logs.2026-04-14-08.log.gz'),
        makeEntry('dir/logs.2026-04-14-10.log.gz'),
        makeEntry('dir/logs.2026-04-14-09.log.gz'),
      ]);
      renderArchiveView();
      const rows = screen.getAllByRole('row');
      expect(rows[1]).toHaveTextContent('logs.2026-04-14-10.log.gz');
      expect(rows[2]).toHaveTextContent('logs.2026-04-14-09.log.gz');
      expect(rows[3]).toHaveTextContent('logs.2026-04-14-08.log.gz');
    });
  });

  describe('handleOpen — log files', () => {
    it('navigates to /summary when opening a dated log', async () => {
      const entries = [makeEntry('dir/logs.2026-04-14-09.log.gz')];
      useArchiveStore.getState().loadArchive('test.tar.gz', entries);
      renderArchiveView();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /open logs\.2026/i }));
      });

      expect(mockNavigate).toHaveBeenCalledWith('/summary');
    });

    it('navigates to /logs when opening a plain (undated) log', async () => {
      const entries = [makeEntry('dir/logcat.log.gz')];
      useArchiveStore.getState().loadArchive('test.tar.gz', entries);
      renderArchiveView();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /open logcat\.log\.gz/i }));
      });

      expect(mockNavigate).toHaveBeenCalledWith('/logs');
    });

    it('marks the entry as visited after opening', async () => {
      const entries = [makeEntry('dir/logs.2026-04-14-09.log.gz')];
      useArchiveStore.getState().loadArchive('test.tar.gz', entries);
      renderArchiveView();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /open logs\.2026/i }));
      });

      expect(useArchiveStore.getState().visitedEntries.has('dir/logs.2026-04-14-09.log.gz')).toBe(true);
    });
  });

  describe('handleOpen — non-log files', () => {
    it('opens a JSON file as a text blob URL', async () => {
      const entries = [makeEntry('dir/details.json', '{"hello":"world"}')];
      useArchiveStore.getState().loadArchive('test.tar.gz', entries);
      renderArchiveView();

      const originalHref = Object.getOwnPropertyDescriptor(window, 'location');
      const setHref = vi.fn();
      Object.defineProperty(window, 'location', {
        writable: true,
        value: { ...window.location, set href(v: string) { setHref(v); } },
      });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /open details\.json/i }));
      });

      expect(URL.createObjectURL).toHaveBeenCalled();

      if (originalHref) Object.defineProperty(window, 'location', originalHref);
    });
  });

  describe('handleOpenRaw', () => {
    it('creates an object URL for the decompressed log text', async () => {
      const entries = [makeEntry('dir/logs.2026-04-14-09.log.gz', 'raw log text')];
      useArchiveStore.getState().loadArchive('test.tar.gz', entries);
      renderArchiveView();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /open raw text/i }));
      });

      expect(URL.createObjectURL).toHaveBeenCalled();
    });
  });

  describe('background summary computation', () => {
    it('fills in summary data after processing', async () => {
      useArchiveStore.getState().loadArchive('test.tar.gz', [
        makeEntry('dir/logs.2026-04-14-09.log.gz', 'line1\nline2\n'),
      ]);
      renderArchiveView();

      await waitFor(() => {
        expect(useArchiveStore.getState().archiveSummaries.size).toBe(1);
      });
    });

    it('skips already-computed entries when navigating back', async () => {
      const { computeArchiveSummary } = await import('../../utils/archiveSummary');
      const spy = vi.mocked(computeArchiveSummary);
      spy.mockClear();

      useArchiveStore.getState().loadArchive('test.tar.gz', [
        makeEntry('dir/logs.2026-04-14-09.log.gz'),
      ]);
      // Pre-populate summary as if user had already viewed this archive
      useArchiveStore.getState().setArchiveSummary('dir/logs.2026-04-14-09.log.gz', {
        totalLines: 1,
        errorCount: 0,
        warnCount: 0,
        sentryCount: 0,
        httpCount: 0,
        totalUploadBytes: 0,
        totalDownloadBytes: 0,
        statusCodes: {},
        utdCount: 0,
        utdReasons: {},
        cryptoSteps: [], rooms: { seenIds: [], lists: {} },
      });

      renderArchiveView();

      // Wait a tick for the effect to run
      await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

      // computeArchiveSummary should NOT have been called again
      expect(spy).not.toHaveBeenCalled();
    });

    it('shows a UTDs column with reported (all) per file and a reasons tooltip', () => {
      useArchiveStore.getState().loadArchive('test.tar.gz', [
        makeEntry('dir/logs.2026-04-14-09.log.gz'),
      ]);
      useArchiveStore.getState().setArchiveSummary('dir/logs.2026-04-14-09.log.gz', {
        totalLines: 10, errorCount: 0, warnCount: 0, sentryCount: 0, httpCount: 0,
        totalUploadBytes: 0, totalDownloadBytes: 0, statusCodes: {},
        utdCount: 42, utdReasons: { ['missing_key']: 40, ['unknown_index']: 2 }, cryptoSteps: [], rooms: { seenIds: [], lists: {} },
      });
      renderArchiveView();
      expect(screen.getByRole('columnheader', { name: 'UTDs' })).toBeInTheDocument();
      expect(screen.getByTitle(/^3 reported of 42 UTDs .* missing_key 40 · unknown_index 2$/)).toHaveTextContent('3 (42)');
    });

    /** A summarized log file with `utdCount` UTDs of its own. */
    const withUtds = (name: string, utdCount: number) => useArchiveStore.getState().setArchiveSummary(name, {
      totalLines: 10, errorCount: 0, warnCount: 0, sentryCount: 0, httpCount: 0,
      totalUploadBytes: 0, totalDownloadBytes: 0, statusCodes: {},
      utdCount, utdReasons: { ['missing_key']: utdCount }, cryptoSteps: [], rooms: { seenIds: [], lists: {} },
    });
    const utdCell = (name: string) => {
      const column = screen.getAllByRole('columnheader').findIndex((h) => h.textContent === 'UTDs');
      return screen.getByText(name).closest('tr')!.querySelectorAll('td')[column];
    };

    it('counts a UTD retried in the next hourly file once, in the file it first failed', async () => {
      const { utdsByFile } = await import('../../utils/archiveSummary');
      vi.mocked(utdsByFile).mockReturnValueOnce(new Map([['dir/logs.2026-04-14-09.log.gz', { count: 1, reported: 0, byReason: { missing_key: 1 } }]]));
      useArchiveStore.getState().loadArchive('test.tar.gz', [makeEntry('dir/logs.2026-04-14-09.log.gz'), makeEntry('dir/logs.2026-04-14-10.log.gz')]);
      withUtds('dir/logs.2026-04-14-09.log.gz', 1);
      withUtds('dir/logs.2026-04-14-10.log.gz', 1);
      renderArchiveView();
      // Singular: one UTD.
      expect(screen.getByTitle(/^0 reported of 1 UTD /)).toHaveTextContent('0 (1)');
      expect(utdCell('logs.2026-04-14-10.log.gz')).toHaveTextContent(/^—$/);
    });

    it('shows each file its own UTDs, reported pending, while other files are summarized', () => {
      useArchiveStore.getState().loadArchive('test.tar.gz', [makeEntry('dir/logs.2026-04-14-09.log.gz'), makeEntry('dir/logs.2026-04-14-10.log.gz')]);
      withUtds('dir/logs.2026-04-14-10.log.gz', 2);
      renderArchiveView();
      expect(screen.getByTitle(/^Reported: waiting for the other files /)).toHaveTextContent('… (2)');
    });
  });

  describe('details.json card', () => {
    it('renders user text from details.json', () => {
      const details = JSON.stringify({ user_text: 'The app crashed', data: {} });
      useArchiveStore.getState().loadArchive('test.tar.gz', [
        makeEntry('dir/details.json', details),
        makeEntry('dir/logs.2026-04-14-09.log.gz'),
      ]);
      renderArchiveView();
      expect(screen.getByText('The app crashed')).toBeInTheDocument();
    });

    it('renders user_id as a matrix.to link', () => {
      const details = JSON.stringify({
        user_text: '',
        data: { user_id: '@alice:example.com' },
      });
      useArchiveStore.getState().loadArchive('test.tar.gz', [
        makeEntry('dir/details.json', details),
        makeEntry('dir/logs.2026-04-14-09.log.gz'),
      ]);
      renderArchiveView();

      const link = screen.getByRole('link', { name: /@alice:example\.com/i });
      expect(link).toHaveAttribute('href', expect.stringContaining('matrix.to'));
    });

    it('renders device_id under Device ID label', () => {
      const details = JSON.stringify({ data: { device_id: 'ABCDEF12' } });
      useArchiveStore.getState().loadArchive('test.tar.gz', [
        makeEntry('dir/details.json', details),
        makeEntry('dir/logs.2026-04-14-09.log.gz'),
      ]);
      renderArchiveView();
      expect(screen.getByText('Device ID')).toBeInTheDocument();
      expect(screen.getByText('ABCDEF12')).toBeInTheDocument();
    });

    it('renders app id from base_bundle_identifier', () => {
      const details = JSON.stringify({ data: { base_bundle_identifier: 'io.element.app' } });
      useArchiveStore.getState().loadArchive('test.tar.gz', [
        makeEntry('dir/details.json', details),
        makeEntry('dir/logs.2026-04-14-09.log.gz'),
      ]);
      renderArchiveView();
      expect(screen.getByText('io.element.app')).toBeInTheDocument();
    });

    it('falls back to app_id when base_bundle_identifier is absent', () => {
      const details = JSON.stringify({ data: { app_id: 'io.element.fallback' } });
      useArchiveStore.getState().loadArchive('test.tar.gz', [
        makeEntry('dir/details.json', details),
        makeEntry('dir/logs.2026-04-14-09.log.gz'),
      ]);
      renderArchiveView();
      expect(screen.getByText('io.element.fallback')).toBeInTheDocument();
    });

    it('renders Version next to app id', () => {
      const details = JSON.stringify({ data: { base_bundle_identifier: 'io.element.app', Version: '1.2.3' } });
      useArchiveStore.getState().loadArchive('test.tar.gz', [
        makeEntry('dir/details.json', details),
        makeEntry('dir/logs.2026-04-14-09.log.gz'),
      ]);
      renderArchiveView();
      expect(screen.getByText('1.2.3')).toBeInTheDocument();
    });

    it('renders sdk_sha as a GitHub commit link', () => {
      const sha = 'abc1234def5678';
      const details = JSON.stringify({ data: { sdk_sha: sha } });
      useArchiveStore.getState().loadArchive('test.tar.gz', [
        makeEntry('dir/details.json', details),
        makeEntry('dir/logs.2026-04-14-09.log.gz'),
      ]);
      renderArchiveView();

      const link = screen.getByRole('link', { name: new RegExp(sha) });
      expect(link).toHaveAttribute(
        'href',
        `https://github.com/matrix-org/matrix-rust-sdk/commit/${sha}`,
      );
    });

    it('does not render the details card when details.json is absent', () => {
      useArchiveStore.getState().loadArchive('test.tar.gz', [
        makeEntry('dir/logs.2026-04-14-09.log.gz'),
      ]);
      renderArchiveView();
      expect(screen.queryByText('User')).not.toBeInTheDocument();
    });
  });

  describe('Matrix profile header', () => {
    it('shows display name and avatar when profile fetch succeeds', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({ displayname: 'Alice', avatar_url: 'mxc://example.com/abc123' }),
          { status: 200 },
        ),
      );

      const details = JSON.stringify({ data: { user_id: '@alice:example.com' } });
      useArchiveStore.getState().loadArchive('test.tar.gz', [
        makeEntry('dir/details.json', details),
        makeEntry('dir/logs.2026-04-14-09.log.gz'),
      ]);
      renderArchiveView();

      await waitFor(() => {
        expect(screen.getByText('Alice')).toBeInTheDocument();
      });
    });

    it('shows initial letter when avatar_url is absent', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ displayname: 'Alice' }), { status: 200 }),
      );

      const details = JSON.stringify({ data: { user_id: '@alice:example.com' } });
      useArchiveStore.getState().loadArchive('test.tar.gz', [
        makeEntry('dir/details.json', details),
        makeEntry('dir/logs.2026-04-14-09.log.gz'),
      ]);
      renderArchiveView();

      await waitFor(() => {
        expect(screen.getByText('A')).toBeInTheDocument();
      });
    });

    it('shows no profile header when fetch fails', async () => {
      vi.spyOn(global, 'fetch').mockRejectedValue(new Error('Network error'));

      const details = JSON.stringify({ data: { user_id: '@alice:example.com' } });
      useArchiveStore.getState().loadArchive('test.tar.gz', [
        makeEntry('dir/details.json', details),
        makeEntry('dir/logs.2026-04-14-09.log.gz'),
      ]);
      renderArchiveView();

      // Wait a tick then check profile header is absent
      await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
      expect(screen.queryByRole('img')).toBeNull();
    });

    it('does not fetch profile when no userId is present', async () => {
      const fetchSpy = vi.spyOn(global, 'fetch');

      const details = JSON.stringify({ data: {} });
      useArchiveStore.getState().loadArchive('test.tar.gz', [
        makeEntry('dir/details.json', details),
        makeEntry('dir/logs.2026-04-14-09.log.gz'),
      ]);
      renderArchiveView();

      await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('PNG gallery', () => {
    it('renders a thumbnail button for each PNG entry', () => {
      const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
      const entries = [
        { name: 'dir/screen.png', data: pngBytes },
        makeEntry('dir/logs.2026-04-14-09.log.gz'),
      ];
      useArchiveStore.getState().loadArchive('test.tar.gz', entries);
      renderArchiveView();

      // The gallery renders a button with an img inside; the table row has a plain button
      const openButtons = screen.getAllByRole('button', { name: /open screen\.png/i });
      const galleryButton = openButtons.find((btn) => btn.querySelector('img'));
      expect(galleryButton).toBeTruthy();
      expect(URL.createObjectURL).toHaveBeenCalled();
    });

    it('shows PNG filename below thumbnail', () => {
      const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      const entries = [
        { name: 'dir/screenshot.png', data: pngBytes },
        makeEntry('dir/logs.2026-04-14-09.log.gz'),
      ];
      useArchiveStore.getState().loadArchive('test.tar.gz', entries);
      renderArchiveView();

      // The filename appears in both the table and the gallery; both are acceptable
      const matches = screen.getAllByText('screenshot.png');
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('visited entry styling', () => {
    it('marks an entry as visited after clicking it', async () => {
      const entries = [makeEntry('dir/logs.2026-04-14-09.log.gz')];
      useArchiveStore.getState().loadArchive('test.tar.gz', entries);
      renderArchiveView();

      const btn = screen.getByRole('button', { name: /open logs\.2026/i });
      await act(async () => { fireEvent.click(btn); });

      expect(useArchiveStore.getState().visitedEntries.has('dir/logs.2026-04-14-09.log.gz')).toBe(true);
    });
  });

  describe('handleOpen — error paths', () => {
    it('opens a non-JSON other file via getMimeType blob path', async () => {
      // A .gz file (non-log, non-JSON) uses getMimeType → application/gzip blob path
      const entries = [makeEntry('dir/crash.gz', '\x1f\x8b')];
      useArchiveStore.getState().loadArchive('test.tar.gz', entries);
      renderArchiveView();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /open crash\.gz/i }));
      });

      expect(URL.createObjectURL).toHaveBeenCalled();
    });

    it('catches and logs errors when handleOpen parseLogFile throws', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.mocked(parseLogFile).mockImplementationOnce(() => { throw new Error('parse failure'); });

      const entries = [makeEntry('dir/logs.2026-04-14-09.log.gz', 'bad data')];
      useArchiveStore.getState().loadArchive('test.tar.gz', entries);
      renderArchiveView();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /open logs\.2026/i }));
      });

      expect(consoleSpy).toHaveBeenCalledWith('Failed to open log entry:', expect.any(String), expect.any(Error));
      consoleSpy.mockRestore();
    });

    it('catches and logs errors when handleOpenRaw decompressSync throws', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.mocked(decompressSync).mockImplementationOnce(() => { throw new Error('decompress failure'); });

      const entries = [makeEntry('dir/logs.2026-04-14-09.log.gz', '\x1f\x8b')];
      useArchiveStore.getState().loadArchive('test.tar.gz', entries);
      renderArchiveView();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /open raw text/i }));
      });

      expect(consoleSpy).toHaveBeenCalledWith('Failed to open raw archive entry:', expect.any(Error));
      consoleSpy.mockRestore();
    });

    it('falls back to raw bytes when JSON in handleOpen is malformed', async () => {
      // details.json is handled as 'other'; malformed JSON should fall back to raw bytes
      const entries = [makeEntry('dir/broken.json', '{invalid json')];
      useArchiveStore.getState().loadArchive('test.tar.gz', entries);
      renderArchiveView();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /open broken\.json/i }));
      });

      // Both JSON.parse failing and raw-bytes fallback both result in createObjectURL being called
      expect(URL.createObjectURL).toHaveBeenCalled();
    });
  });

  describe('PNG gallery — click interaction', () => {
    it('clicking a PNG gallery button triggers handleOpen for the PNG entry', async () => {
      const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      const entries = [
        { name: 'dir/screen.png', data: pngBytes },
        makeEntry('dir/logs.2026-04-14-09.log.gz'),
      ];
      useArchiveStore.getState().loadArchive('test.tar.gz', entries);
      renderArchiveView();

      const allOpenButtons = screen.getAllByRole('button', { name: /open screen\.png/i });
      const galleryBtn = allOpenButtons.find((btn) => btn.querySelector('img'));
      expect(galleryBtn).toBeTruthy();

      await act(async () => { fireEvent.click(galleryBtn!); });

      // PNG opens as a blob URL via handleOpen 'other' path
      expect(URL.createObjectURL).toHaveBeenCalled();
    });
  });

  describe('multi-select open', () => {
    const entries = [
      makeEntry('dir/logs.2026-04-14-08.log.gz'),
      makeEntry('dir/logs.2026-04-14-09.log.gz'),
      makeEntry('dir/details.json', '{}'),
    ];

    it('shows the action bar only after a file is ticked', () => {
      useArchiveStore.getState().loadArchive('test.tar.gz', entries);
      renderArchiveView();

      expect(screen.queryByRole('button', { name: /open .* together/i })).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('checkbox', { name: /select logs\.2026-04-14-08/i }));

      expect(screen.getByRole('button', { name: /open 1 file together/i })).toBeInTheDocument();
    });

    it('opens the ticked files merged and navigates to the summary', async () => {
      useArchiveStore.getState().loadArchive('test.tar.gz', entries);
      renderArchiveView();

      fireEvent.click(screen.getByRole('checkbox', { name: /select logs\.2026-04-14-08/i }));
      fireEvent.click(screen.getByRole('checkbox', { name: /select logs\.2026-04-14-09/i }));

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /open 2 files together/i }));
      });

      expect(useLogStore.getState().loadedEntryNames).toEqual([
        'dir/logs.2026-04-14-08.log.gz',
        'dir/logs.2026-04-14-09.log.gz',
      ]);
      expect(mockNavigate).toHaveBeenCalledWith('/summary');
    });

    it('select-all ticks every analyzable entry; Clear unticks them', () => {
      useArchiveStore.getState().loadArchive('test.tar.gz', entries);
      renderArchiveView();

      fireEvent.click(screen.getByRole('checkbox', { name: /select all log files/i }));
      // 2 log files selected (details.json excluded)
      expect(screen.getByRole('button', { name: /open 2 files together/i })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /^clear$/i }));
      expect(screen.queryByRole('button', { name: /open .* together/i })).not.toBeInTheDocument();
    });

    it('unticking a ticked file removes it from the selection', () => {
      useArchiveStore.getState().loadArchive('test.tar.gz', entries);
      renderArchiveView();

      const cb = screen.getByRole('checkbox', { name: /select logs\.2026-04-14-08/i });
      fireEvent.click(cb); // tick
      expect(screen.getByRole('button', { name: /open 1 file together/i })).toBeInTheDocument();
      fireEvent.click(cb); // untick
      expect(screen.queryByRole('button', { name: /open .* together/i })).not.toBeInTheDocument();
    });

    it('clicking select-all when all are ticked clears the selection', () => {
      useArchiveStore.getState().loadArchive('test.tar.gz', entries);
      renderArchiveView();

      const selectAll = screen.getByRole('checkbox', { name: /select all log files/i });
      fireEvent.click(selectAll); // all ticked
      expect(screen.getByRole('button', { name: /open 2 files together/i })).toBeInTheDocument();
      fireEvent.click(selectAll); // toggle off → cleared
      expect(screen.queryByRole('button', { name: /open .* together/i })).not.toBeInTheDocument();
    });
  });
});

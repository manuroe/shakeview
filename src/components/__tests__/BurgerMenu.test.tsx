import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { BurgerMenu } from '../BurgerMenu';
import { useLogStore } from '../../stores/logStore';
import { useArchiveStore } from '../../stores/archiveStore';
import { useListingStore } from '../../stores/listingStore';
import { createParsedLogLine } from '../../test/fixtures';
import { fetchExtensionFileBytes } from '../../utils/extensionFileLoader';
import { KeyboardShortcutContext } from '../KeyboardShortcutContext';
import type { KeyboardShortcutContextValue } from '../KeyboardShortcutContext';

vi.mock('../LogSelectionDialog', () => ({
  LogSelectionDialog: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="log-selection-dialog">
      <button onClick={onClose}>close-mock</button>
    </div>
  ),
}));

vi.mock('../AnonMappingDialog', () => ({
  AnonMappingDialog: ({
    buildPreview,
    onClose,
  }: {
    buildPreview?: (onProgress: (p: string, c: number, t: number) => void) => Promise<unknown>;
    onClose: () => void;
  }) => {
    // Exercise the preview builder the way the real dialog would.
    if (buildPreview) void buildPreview(() => {});
    return (
      <div data-testid="anon-mapping-dialog">
        <button onClick={onClose}>close-mapping-mock</button>
      </div>
    );
  },
}));

vi.mock('../AnonTextDialog', () => ({
  AnonTextDialog: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="anon-text-dialog">
      <button onClick={onClose}>close-anon-text-mock</button>
    </div>
  ),
}));

vi.mock('../../utils/extensionFileLoader', () => ({
  fetchExtensionFileBytes: vi.fn(),
}));

// Bypass zustand persist middleware to avoid localStorage issues in tests
vi.mock('zustand/middleware', async (importOriginal) => {
  const original = await importOriginal<typeof import('zustand/middleware')>();
  return {
    ...original,
    persist: (fn: (...args: unknown[]) => unknown) => fn,
  };
});

// Track navigation calls
const navigateMock = vi.fn();
let currentSearchParams = new URLSearchParams();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => navigateMock,
    useSearchParams: () => [currentSearchParams, vi.fn()],
  };
});

describe('BurgerMenu', () => {
  beforeEach(() => {
    navigateMock.mockClear();
    currentSearchParams = new URLSearchParams();
    useLogStore.getState().clearData();
    useArchiveStore.getState().clearArchive();
    useListingStore.getState().clearListing();
    vi.mocked(fetchExtensionFileBytes).mockReset();
  });

  describe('Cross-View Navigation Param Preservation', () => {
    it('preserves start and end params when navigating to another view', () => {
      currentSearchParams = new URLSearchParams('start=2025-01-01T00:00:00Z&end=2025-01-01T12:00:00Z');

      render(
        <MemoryRouter initialEntries={['/http_requests?start=2025-01-01T00:00:00Z&end=2025-01-01T12:00:00Z']}>
          <BurgerMenu />
        </MemoryRouter>
      );

      // Open menu
      fireEvent.click(screen.getByRole('button', { name: /menu/i }));

      // Click on "Logs"
      fireEvent.click(screen.getByText('Logs'));

      expect(navigateMock).toHaveBeenCalledWith(
        '/logs?start=2025-01-01T00%3A00%3A00Z&end=2025-01-01T12%3A00%3A00Z'
      );
    });

    it('clears view-specific params (scale, status, filter, request_id) when navigating', () => {
      currentSearchParams = new URLSearchParams(
        'start=2025-01-01T00:00:00Z&end=2025-01-01T12:00:00Z&scale=50&status=200,500&filter=sync&request_id=REQ-1'
      );

      render(
        <MemoryRouter initialEntries={['/http_requests']}>
          <BurgerMenu />
        </MemoryRouter>
      );

      // Open menu
      fireEvent.click(screen.getByRole('button', { name: /menu/i }));

      // Click on "Summary"
      fireEvent.click(screen.getByText('Summary'));

      // Should only have start and end, not scale/status/filter/request_id
      const navigatedPath = navigateMock.mock.calls[0][0];
      expect(navigatedPath).toContain('start=');
      expect(navigatedPath).toContain('end=');
      expect(navigatedPath).not.toContain('scale=');
      expect(navigatedPath).not.toContain('status=');
      expect(navigatedPath).not.toContain('filter=');
      expect(navigatedPath).not.toContain('request_id=');
    });

    it('navigates without params when no start/end present', () => {
      currentSearchParams = new URLSearchParams('scale=50&filter=sync');

      render(
        <MemoryRouter initialEntries={['/http_requests']}>
          <BurgerMenu />
        </MemoryRouter>
      );

      // Open menu
      fireEvent.click(screen.getByRole('button', { name: /menu/i }));

      // Click on "Logs"
      fireEvent.click(screen.getByText('Logs'));

      // Should navigate to plain path without query string
      expect(navigateMock).toHaveBeenCalledWith('/logs');
    });

    it('preserves only start when end is not present', () => {
      currentSearchParams = new URLSearchParams('start=last-hour&filter=sync');

      render(
        <MemoryRouter initialEntries={['/http_requests']}>
          <BurgerMenu />
        </MemoryRouter>
      );

      fireEvent.click(screen.getByRole('button', { name: /menu/i }));
      fireEvent.click(screen.getByText('Summary'));

      expect(navigateMock).toHaveBeenCalledWith('/summary?start=last-hour');
    });

    it('preserves only end when start is not present', () => {
      currentSearchParams = new URLSearchParams('end=2025-01-01T12:00:00Z&status=500');

      render(
        <MemoryRouter initialEntries={['/http_requests']}>
          <BurgerMenu />
        </MemoryRouter>
      );

      fireEvent.click(screen.getByRole('button', { name: /menu/i }));
      fireEvent.click(screen.getByText('HTTP Requests'));

      expect(navigateMock).toHaveBeenCalledWith(
        '/http_requests?end=2025-01-01T12%3A00%3A00Z'
      );
    });
  });

  describe('Menu Behavior', () => {
    it('closes menu after navigation', () => {
      render(
        <MemoryRouter>
          <BurgerMenu />
        </MemoryRouter>
      );

      // Open menu
      fireEvent.click(screen.getByRole('button', { name: /menu/i }));
      expect(screen.getByText('Summary')).toBeInTheDocument();

      // Navigate
      fireEvent.click(screen.getByText('Summary'));

      // Menu should be closed (dropdown no longer visible)
      expect(screen.queryByText('Summary')).not.toBeInTheDocument();
    });
  });

  describe('New Session', () => {
    it('navigates to "/" when New Session is clicked', () => {
      render(
        <MemoryRouter>
          <BurgerMenu />
        </MemoryRouter>
      );

      fireEvent.click(screen.getByRole('button', { name: /menu/i }));
      fireEvent.click(screen.getByText('New Session'));

      expect(navigateMock).toHaveBeenCalledWith('/');
    });

    it('clears store data when New Session is clicked', () => {
      useLogStore.setState({ startTime: 'last-hour', endTime: 'end' });

      render(
        <MemoryRouter>
          <BurgerMenu />
        </MemoryRouter>
      );

      fireEvent.click(screen.getByRole('button', { name: /menu/i }));
      fireEvent.click(screen.getByText('New Session'));

      // Store should be cleared
      expect(useLogStore.getState().allRequests).toEqual([]);
    });

    it('closes menu after New Session', () => {
      render(
        <MemoryRouter>
          <BurgerMenu />
        </MemoryRouter>
      );

      fireEvent.click(screen.getByRole('button', { name: /menu/i }));
      expect(screen.getByText('New Session')).toBeInTheDocument();
      fireEvent.click(screen.getByText('New Session'));
      expect(screen.queryByText('New Session')).not.toBeInTheDocument();
    });
  });

  describe('Theme Buttons', () => {
    it('renders theme buttons when menu is open', () => {
      render(
        <MemoryRouter>
          <BurgerMenu />
        </MemoryRouter>
      );

      fireEvent.click(screen.getByRole('button', { name: /menu/i }));

      expect(screen.getByRole('button', { name: /system theme/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /light theme/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /dark theme/i })).toBeInTheDocument();
    });

    it('sets light theme when Light theme button is clicked', () => {
      render(
        <MemoryRouter>
          <BurgerMenu />
        </MemoryRouter>
      );

      fireEvent.click(screen.getByRole('button', { name: /menu/i }));
      fireEvent.click(screen.getByRole('button', { name: /light theme/i }));

      // Menu should still be open (theme change doesn't close menu)
      expect(screen.getByRole('button', { name: /dark theme/i })).toBeInTheDocument();
    });

    it('sets dark theme when Dark theme button is clicked', () => {
      render(
        <MemoryRouter>
          <BurgerMenu />
        </MemoryRouter>
      );

      fireEvent.click(screen.getByRole('button', { name: /menu/i }));
      fireEvent.click(screen.getByRole('button', { name: /dark theme/i }));

      expect(screen.getByRole('button', { name: /dark theme/i })).toBeInTheDocument();
    });

    it('sets system theme when System theme button is clicked', () => {
      render(
        <MemoryRouter>
          <BurgerMenu />
        </MemoryRouter>
      );

      fireEvent.click(screen.getByRole('button', { name: /menu/i }));
      fireEvent.click(screen.getByRole('button', { name: /system theme/i }));

      expect(screen.getByRole('button', { name: /system theme/i })).toBeInTheDocument();
    });
  });

  describe('Close on outside click', () => {
    it('closes menu when clicking outside', () => {
      render(
        <div>
          <MemoryRouter>
            <BurgerMenu />
          </MemoryRouter>
          <div data-testid="outside">outside</div>
        </div>
      );

      fireEvent.click(screen.getByRole('button', { name: /menu/i }));
      expect(screen.getByText('Summary')).toBeInTheDocument();

      fireEvent.mouseDown(screen.getByTestId('outside'));
      expect(screen.queryByText('Summary')).not.toBeInTheDocument();
    });
  });

  describe('Sync Navigation', () => {
    it('navigates to /http_requests/sync when Sync is clicked', () => {
      render(
        <MemoryRouter>
          <BurgerMenu />
        </MemoryRouter>
      );
      fireEvent.click(screen.getByRole('button', { name: /menu/i }));
      fireEvent.click(screen.getByText('Sync'));
      expect(navigateMock).toHaveBeenCalledWith('/http_requests/sync');
    });

    it('closes menu after navigating to Sync', () => {
      render(
        <MemoryRouter>
          <BurgerMenu />
        </MemoryRouter>
      );
      fireEvent.click(screen.getByRole('button', { name: /menu/i }));
      fireEvent.click(screen.getByText('Sync'));
      expect(screen.queryByText('Sync')).not.toBeInTheDocument();
    });
  });

  describe('By span', () => {
    const openMenu = (rawText: string) => {
      useLogStore.setState({ rawLogLines: [createParsedLogLine({ lineNumber: 1, rawText })] });
      render(
        <MemoryRouter>
          <BurgerMenu />
        </MemoryRouter>
      );
      fireEvent.click(screen.getByRole('button', { name: /menu/i }));
    };

    it('is listed when the logs carry spans', () => {
      openMenu('2026-01-01T00:00:00.000000Z INFO msg | spans: sync');
      expect(screen.getByText('By span')).toBeInTheDocument();
    });

    it('is hidden when the logs carry no spans (Element Web)', () => {
      openMenu('2026-01-01T00:00:00.000Z I FetchHttpApi: --> GET https://x');
      expect(screen.queryByText('By span')).not.toBeInTheDocument();
    });
  });

  describe('Keyboard Shortcuts Button', () => {
    it('calls toggleHelp and closes menu when Keyboard Shortcuts is clicked', () => {
      const toggleHelp = vi.fn();
      const ctx: KeyboardShortcutContextValue = {
        showHelp: false,
        toggleHelp,
        pendingChord: null,
        registerFocusSearch: vi.fn(() => vi.fn()),
        registerFocusFilter: vi.fn(() => vi.fn()),
        registerDismiss: vi.fn(() => vi.fn()),
      };
      render(
        <KeyboardShortcutContext.Provider value={ctx}>
          <MemoryRouter>
            <BurgerMenu />
          </MemoryRouter>
        </KeyboardShortcutContext.Provider>
      );
      fireEvent.click(screen.getByRole('button', { name: /menu/i }));
      fireEvent.click(screen.getByText('Keyboard Shortcuts'));
      expect(toggleHelp).toHaveBeenCalledTimes(1);
      expect(screen.queryByText('Keyboard Shortcuts')).not.toBeInTheDocument();
    });
  });

  describe('Select logs', () => {
    const data = new TextEncoder().encode('x');

    it('opens and closes the log selection dialog', () => {
      // A loaded archive provides the multi-file source the dialog selects from.
      useArchiveStore.getState().loadArchive('test.tar.gz', [{ name: 'logs.2026-04-14-08.log.gz', data }]);
      useLogStore.setState({ loadedEntryNames: ['logs.2026-04-14-08.log.gz'] });
      render(
        <MemoryRouter initialEntries={['/logs']}>
          <BurgerMenu />
        </MemoryRouter>
      );

      fireEvent.click(screen.getByRole('button', { name: /menu/i }));
      fireEvent.click(screen.getByText(/select logs/i));

      expect(screen.getByTestId('log-selection-dialog')).toBeInTheDocument();

      fireEvent.click(screen.getByText('close-mock'));
      expect(screen.queryByTestId('log-selection-dialog')).not.toBeInTheDocument();
    });

    it('hides "Select logs" when no log is loaded', () => {
      render(
        <MemoryRouter initialEntries={['/logs']}>
          <BurgerMenu />
        </MemoryRouter>
      );

      fireEvent.click(screen.getByRole('button', { name: /menu/i }));
      expect(screen.queryByText(/select logs/i)).not.toBeInTheDocument();
    });

    it('hides "Select logs" for a single-file load with no archive/listing source', () => {
      // e.g. a direct file upload or demo: loadedEntryNames is set, but there's
      // nothing to multi-select from, so the item stays hidden.
      useLogStore.setState({ loadedEntryNames: ['demo.log'] });
      render(
        <MemoryRouter initialEntries={['/logs']}>
          <BurgerMenu />
        </MemoryRouter>
      );

      fireEvent.click(screen.getByRole('button', { name: /menu/i }));
      expect(screen.queryByText(/select logs/i)).not.toBeInTheDocument();
    });
  });

  describe('Anonymisation submenu', () => {
    const dict = {
      forward: { '@alice:matrix.org': '@user-aaaaaaaaaaaa:domain-11111111.org' },
      reverse: { '@user-aaaaaaaaaaaa:domain-11111111.org': '@alice:matrix.org' },
    };

    it('expands to reveal the salt input and edits the salt', () => {
      render(
        <MemoryRouter initialEntries={['/logs']}>
          <BurgerMenu />
        </MemoryRouter>
      );

      fireEvent.click(screen.getByRole('button', { name: /menu/i }));
      // Salt input is hidden until the submenu is expanded.
      expect(screen.queryByLabelText('Anonymisation salt')).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /^anonymisation$/i }));
      const input = screen.getByLabelText('Anonymisation salt');
      expect(input).toBeInTheDocument();

      fireEvent.change(input, { target: { value: 'team-salt' } });
      expect(input).toHaveValue('team-salt');
    });

    it('shows "View mapping" even before anonymisation and opens the dialog', () => {
      render(
        <MemoryRouter initialEntries={['/logs']}>
          <BurgerMenu />
        </MemoryRouter>
      );

      fireEvent.click(screen.getByRole('button', { name: /menu/i }));
      fireEvent.click(screen.getByRole('button', { name: /^anonymisation$/i }));
      fireEvent.click(screen.getByText(/view mapping/i));
      expect(screen.getByTestId('anon-mapping-dialog')).toBeInTheDocument();
    });

    it('opens the free-form text dialog and takes focus back when it closes', () => {
      render(
        <MemoryRouter initialEntries={['/logs']}>
          <BurgerMenu />
        </MemoryRouter>
      );

      const burgerButton = screen.getByRole('button', { name: /menu/i });
      fireEvent.click(burgerButton);
      fireEvent.click(screen.getByRole('button', { name: /^anonymisation$/i }));
      fireEvent.click(screen.getByText(/anonymise text/i));
      expect(screen.getByTestId('anon-text-dialog')).toBeInTheDocument();

      // The menu item that opened the dialog is unmounted with the menu, so the
      // burger button has to take focus back or it falls to the body.
      fireEvent.click(screen.getByText('close-anon-text-mock'));
      expect(screen.queryByTestId('anon-text-dialog')).not.toBeInTheDocument();
      expect(document.activeElement).toBe(burgerButton);
    });

    it('hides "Save anonymised log" when no logs are loaded', () => {
      render(
        <MemoryRouter initialEntries={['/logs']}>
          <BurgerMenu />
        </MemoryRouter>
      );
      fireEvent.click(screen.getByRole('button', { name: /menu/i }));
      fireEvent.click(screen.getByRole('button', { name: /^anonymisation$/i }));
      expect(screen.queryByText(/save anonymised/i)).not.toBeInTheDocument();
    });

    it('saves an anonymised log file with a -anonym filename', () => {
      const origCreate = URL.createObjectURL;
      const origRevoke = URL.revokeObjectURL;
      URL.createObjectURL = vi.fn(() => 'blob:mock');
      URL.revokeObjectURL = vi.fn();
      let downloadName = '';
      const clickSpy = vi
        .spyOn(HTMLAnchorElement.prototype, 'click')
        .mockImplementation(function (this: HTMLAnchorElement) { downloadName = this.download; });
      try {
        useLogStore.setState({
          rawLogLines: [createParsedLogLine({ lineNumber: 0, rawText: '@alice:matrix.org hi' })],
          isAnonymized: true,
          logFileName: 'console.log',
        });
        render(
          <MemoryRouter initialEntries={['/logs']}>
            <BurgerMenu />
          </MemoryRouter>
        );
        fireEvent.click(screen.getByRole('button', { name: /menu/i }));
        fireEvent.click(screen.getByRole('button', { name: /^anonymisation$/i }));
        fireEvent.click(screen.getByText(/save anonymised/i));

        expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
        expect(clickSpy).toHaveBeenCalledTimes(1);
        expect(downloadName).toBe('console-anonym.log');
      } finally {
        clickSpy.mockRestore();
        URL.createObjectURL = origCreate;
        URL.revokeObjectURL = origRevoke;
      }
    });

    it('anonymises and saves a not-yet-anonymised log on the fly', async () => {
      const origCreate = URL.createObjectURL;
      const origRevoke = URL.revokeObjectURL;
      URL.createObjectURL = vi.fn(() => 'blob:mock');
      URL.revokeObjectURL = vi.fn();
      let downloadName = '';
      const clickSpy = vi
        .spyOn(HTMLAnchorElement.prototype, 'click')
        .mockImplementation(function (this: HTMLAnchorElement) { downloadName = this.download; });
      try {
        useLogStore.setState({
          rawLogLines: [createParsedLogLine({ lineNumber: 0, rawText: '@alice:matrix.org hi' })],
          isAnonymized: false,
          logFileName: 'console.log',
        });
        render(
          <MemoryRouter initialEntries={['/logs']}>
            <BurgerMenu />
          </MemoryRouter>
        );
        fireEvent.click(screen.getByRole('button', { name: /menu/i }));
        fireEvent.click(screen.getByRole('button', { name: /^anonymisation$/i }));
        fireEvent.click(screen.getByText(/save anonymised/i));

        await vi.waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));
        expect(downloadName).toBe('console-anonym.log');
      } finally {
        clickSpy.mockRestore();
        URL.createObjectURL = origCreate;
        URL.revokeObjectURL = origRevoke;
      }
    });

    it('saves an anonymised archive from the /listing screen', async () => {
      vi.mocked(fetchExtensionFileBytes).mockImplementation(
        async (_url, name) => new TextEncoder().encode(`@alice:matrix.org in ${name}`),
      );
      const origCreate = URL.createObjectURL;
      const origRevoke = URL.revokeObjectURL;
      URL.createObjectURL = vi.fn(() => 'blob:mock');
      URL.revokeObjectURL = vi.fn();
      let downloadName = '';
      const clickSpy = vi
        .spyOn(HTMLAnchorElement.prototype, 'click')
        .mockImplementation(function (this: HTMLAnchorElement) { downloadName = this.download; });
      try {
        useListingStore.getState().loadListing('https://host/api/listing/session42', [
          { name: 'a.log', url: 'https://host/a.log' },
        ]);
        render(
          <MemoryRouter initialEntries={['/listing']}>
            <BurgerMenu />
          </MemoryRouter>
        );
        fireEvent.click(screen.getByRole('button', { name: /menu/i }));
        fireEvent.click(screen.getByRole('button', { name: /^anonymisation$/i }));
        fireEvent.click(screen.getByText(/save anonymised/i));

        await vi.waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));
        expect(downloadName).toBe('session42-anonym.tar.gz');
        expect(fetchExtensionFileBytes).toHaveBeenCalled();
      } finally {
        clickSpy.mockRestore();
        URL.createObjectURL = origCreate;
        URL.revokeObjectURL = origRevoke;
      }
    });

    it('still saves the listing when one file fetch rejects', async () => {
      vi.mocked(fetchExtensionFileBytes).mockImplementation(async (_url, name) => {
        if (name === 'bad.log') throw new Error('sendMessage rejected');
        return new TextEncoder().encode(`@alice:matrix.org ${name}`);
      });
      const origCreate = URL.createObjectURL;
      const origRevoke = URL.revokeObjectURL;
      URL.createObjectURL = vi.fn(() => 'blob:mock');
      URL.revokeObjectURL = vi.fn();
      const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
      try {
        useListingStore.getState().loadListing('https://host/api/listing/s', [
          { name: 'good.log', url: 'https://host/good.log' },
          { name: 'bad.log', url: 'https://host/bad.log' },
        ]);
        render(
          <MemoryRouter initialEntries={['/listing']}>
            <BurgerMenu />
          </MemoryRouter>
        );
        fireEvent.click(screen.getByRole('button', { name: /menu/i }));
        fireEvent.click(screen.getByRole('button', { name: /^anonymisation$/i }));
        fireEvent.click(screen.getByText(/save anonymised/i));

        await vi.waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));
        expect(screen.queryByText('Save failed')).not.toBeInTheDocument();
      } finally {
        clickSpy.mockRestore();
        URL.createObjectURL = origCreate;
        URL.revokeObjectURL = origRevoke;
      }
    });

    it('shows a "Save failed" message when the export throws', async () => {
      vi.mocked(fetchExtensionFileBytes).mockResolvedValue(null);
      useListingStore.getState().loadListing('https://host/api/listing/s', [
        { name: 'a.log', url: 'https://host/a.log' },
      ]);
      render(
        <MemoryRouter initialEntries={['/listing']}>
          <BurgerMenu />
        </MemoryRouter>
      );
      fireEvent.click(screen.getByRole('button', { name: /menu/i }));
      fireEvent.click(screen.getByRole('button', { name: /^anonymisation$/i }));
      fireEvent.click(screen.getByText(/save anonymised/i));

      expect(await screen.findByText('Save failed')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /close/i }));
      expect(screen.queryByText('Save failed')).not.toBeInTheDocument();
    });

    it('builds a preview when View mapping is opened on the /listing screen', async () => {
      vi.mocked(fetchExtensionFileBytes).mockImplementation(
        async (_url, name) => new TextEncoder().encode(`@alice:matrix.org ${name}`),
      );
      useListingStore.getState().loadListing('https://host/api/listing/s', [
        { name: 'a.log', url: 'https://host/a.log' },
      ]);
      render(
        <MemoryRouter initialEntries={['/listing']}>
          <BurgerMenu />
        </MemoryRouter>
      );
      fireEvent.click(screen.getByRole('button', { name: /menu/i }));
      fireEvent.click(screen.getByRole('button', { name: /^anonymisation$/i }));
      fireEvent.click(screen.getByText(/view mapping/i));

      expect(screen.getByTestId('anon-mapping-dialog')).toBeInTheDocument();
      await vi.waitFor(() => expect(fetchExtensionFileBytes).toHaveBeenCalled());
    });

    it('saves an anonymised archive (-anonym.tar.gz) on the /archive screen', async () => {
      const origCreate = URL.createObjectURL;
      const origRevoke = URL.revokeObjectURL;
      URL.createObjectURL = vi.fn(() => 'blob:mock');
      URL.revokeObjectURL = vi.fn();
      let downloadName = '';
      const clickSpy = vi
        .spyOn(HTMLAnchorElement.prototype, 'click')
        .mockImplementation(function (this: HTMLAnchorElement) { downloadName = this.download; });
      try {
        useArchiveStore.getState().loadArchive('rageshake.tar.gz', [
          { name: 'a.log', data: new TextEncoder().encode('@alice:matrix.org') },
        ]);
        render(
          <MemoryRouter initialEntries={['/archive']}>
            <BurgerMenu />
          </MemoryRouter>
        );
        fireEvent.click(screen.getByRole('button', { name: /menu/i }));
        fireEvent.click(screen.getByRole('button', { name: /^anonymisation$/i }));
        fireEvent.click(screen.getByText(/save anonymised/i));

        await vi.waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));
        expect(downloadName).toBe('rageshake-anonym.tar.gz');
        expect(URL.createObjectURL).toHaveBeenCalled();
      } finally {
        clickSpy.mockRestore();
        URL.createObjectURL = origCreate;
        URL.revokeObjectURL = origRevoke;
        useArchiveStore.getState().clearArchive();
      }
    });

    it('shows "View mapping" on the /archive screen and opens the dialog', () => {
      useArchiveStore.getState().loadArchive('rageshake.tar.gz', [
        { name: 'a.log', data: new TextEncoder().encode('@alice:matrix.org') },
      ]);
      try {
        render(
          <MemoryRouter initialEntries={['/archive']}>
            <BurgerMenu />
          </MemoryRouter>
        );
        fireEvent.click(screen.getByRole('button', { name: /menu/i }));
        fireEvent.click(screen.getByRole('button', { name: /^anonymisation$/i }));
        fireEvent.click(screen.getByText(/view mapping/i));
        expect(screen.getByTestId('anon-mapping-dialog')).toBeInTheDocument();
      } finally {
        useArchiveStore.getState().clearArchive();
      }
    });

    it('opens and closes the mapping dialog when a dictionary exists', () => {
      useLogStore.setState({ isAnonymized: true, anonymizationDictionary: dict });
      render(
        <MemoryRouter initialEntries={['/logs']}>
          <BurgerMenu />
        </MemoryRouter>
      );

      fireEvent.click(screen.getByRole('button', { name: /menu/i }));
      fireEvent.click(screen.getByRole('button', { name: /^anonymisation$/i }));
      fireEvent.click(screen.getByText(/view mapping/i));

      expect(screen.getByTestId('anon-mapping-dialog')).toBeInTheDocument();

      fireEvent.click(screen.getByText('close-mapping-mock'));
      expect(screen.queryByTestId('anon-mapping-dialog')).not.toBeInTheDocument();
    });
  });
});

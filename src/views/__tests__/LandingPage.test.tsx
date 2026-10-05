/**
 * Unit tests for LandingPage.tsx
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { LandingPage } from '../LandingPage';
import { useLogStore } from '../../stores/logStore';

// Mock FileUpload to keep tests focused on the demo link
vi.mock('../../components/FileUpload', () => ({
  FileUpload: () => <div data-testid="file-upload" />,
}));

// Minimal demo log text that the parser can handle
const DEMO_LOG_TEXT = [
  '2026-01-15T10:00:00.000000Z  INFO [matrix-rust-sdk] SDK init',
  '2026-01-15T10:00:01.000000Z DEBUG [matrix-rust-sdk] send{request_id="req-001" method=GET uri="https://matrix.example.org/_matrix/client/v3/sync?timeout=0" request_size="0"}',
  '2026-01-15T10:00:02.000000Z  INFO [matrix-rust-sdk] send{request_id="req-001" method=GET uri="https://matrix.example.org/_matrix/client/v3/sync?timeout=0" request_size="0" status=200 response_size="1024" request_duration=1000ms}',
].join('\n');

function renderLandingPage() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/summary" element={<div data-testid="summary-view" />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('LandingPage', () => {
  beforeEach(() => {
    useLogStore.getState().clearData();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the FileUpload component and the mobile and web demo buttons', () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(''));

    renderLandingPage();

    expect(screen.getByTestId('file-upload')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try with mobile demo logs/i })).toHaveTextContent('Mobile');
    expect(screen.getByRole('button', { name: /try with web demo logs/i })).toHaveTextContent('Web');
  });

  it('renders the GitHub link', () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(''));

    renderLandingPage();

    expect(screen.getByRole('link', { name: /view on github/i })).toBeInTheDocument();
  });

  it('loads data into the store and navigates to /summary on success', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(DEMO_LOG_TEXT));

    renderLandingPage();

    fireEvent.click(screen.getByRole('button', { name: /try with mobile demo logs/i }));

    await waitFor(() => {
      expect(screen.getByTestId('summary-view')).toBeInTheDocument();
    });
  });

  it('loads the web demo log from its own file', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(DEMO_LOG_TEXT));

    renderLandingPage();

    fireEvent.click(screen.getByRole('button', { name: /try with web demo logs/i }));

    await waitFor(() => {
      expect(screen.getByTestId('summary-view')).toBeInTheDocument();
    });
    expect(String(fetchSpy.mock.calls[0][0])).toMatch(/demo\/demo-web\.log$/);
  });

  it('shows an error message when the fetch fails', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('Network error'));

    renderLandingPage();

    fireEvent.click(screen.getByRole('button', { name: /try with mobile demo logs/i }));

    await waitFor(() => {
      expect(screen.getByText(/failed to load demo/i)).toBeInTheDocument();
    });

    // Button should be re-enabled after error
    expect(screen.getByRole('button', { name: /try with mobile demo logs/i })).not.toBeDisabled();
  });

  it('shows an error message when the server returns a non-ok response', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('Not Found', { status: 404 }));

    renderLandingPage();

    fireEvent.click(screen.getByRole('button', { name: /try with mobile demo logs/i }));

    await waitFor(() => {
      expect(screen.getByText(/failed to load demo/i)).toBeInTheDocument();
    });
  });

  it('dismisses the demo error when onDismiss is called', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('Network error'));

    renderLandingPage();

    fireEvent.click(screen.getByRole('button', { name: /try with mobile demo logs/i }));

    // Wait for error to appear
    await waitFor(() => {
      expect(screen.getByText(/failed to load demo/i)).toBeInTheDocument();
    });

    // Click dismiss button (×) — this invokes the onDismiss handler
    const dismissButton = screen.getByRole('button', { name: /dismiss/i });
    fireEvent.click(dismissButton);

    // Error should be cleared
    await waitFor(() => {
      expect(screen.queryByText(/failed to load demo/i)).not.toBeInTheDocument();
    });
  });

  it('uses PR-specific GitHub URL when VITE_PR_NUMBER is set', () => {
    vi.stubEnv('VITE_PR_NUMBER', '42');

    renderLandingPage();

    const githubLink = screen.getByRole('link', { name: /view on github/i });
    expect(githubLink.getAttribute('href')).toContain('/pull/42');

    vi.unstubAllEnvs();
  });

  describe('with chrome extension APIs available', () => {
    beforeEach(() => {
      // Simulate extension context: chrome.runtime.sendMessage must be available
      // for the loading-screen guard to activate.
      (globalThis as Record<string, unknown>).chrome = { runtime: { sendMessage: vi.fn() } };
    });

    afterEach(() => {
      delete (globalThis as Record<string, unknown>).chrome;
    });

    it('renders the extension loading screen when extensionFileUrl param is present', () => {
      render(
        <MemoryRouter initialEntries={['/?extensionFileUrl=https%3A%2F%2Fexample.com%2Fapi%2Flisting%2Ffoo.log.gz&extensionFileName=foo.log.gz']}>
          <Routes>
            <Route path="/" element={<LandingPage />} />
          </Routes>
        </MemoryRouter>
      );

      expect(screen.getByText(/Loading foo\.log\.gz/i)).toBeInTheDocument();
      expect(screen.queryByTestId('file-upload')).not.toBeInTheDocument();
    });

    it('derives the filename from extensionFileUrl pathname when extensionFileName param is absent', () => {
      render(
        <MemoryRouter initialEntries={['/?extensionFileUrl=https%3A%2F%2Fexample.com%2Fapi%2Flisting%2Fderived.log.gz']}>
          <Routes>
            <Route path="/" element={<LandingPage />} />
          </Routes>
        </MemoryRouter>
      );

      expect(screen.getByText(/Loading derived\.log\.gz/i)).toBeInTheDocument();
    });
  });

  it('falls back to the upload UI when extensionFileUrl is present but chrome APIs are unavailable', () => {
    // Ensure chrome is NOT in globalThis (non-extension context)
    if ('chrome' in globalThis) delete (globalThis as Record<string, unknown>).chrome;

    render(
      <MemoryRouter initialEntries={['/?extensionFileUrl=https%3A%2F%2Fexample.com%2Fapi%2Flisting%2Ffoo.log.gz']}>
        <Routes>
          <Route path="/" element={<LandingPage />} />
        </Routes>
      </MemoryRouter>
    );

    // Should show the normal upload UI, not the loading screen
    expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument();
    expect(screen.getByTestId('file-upload')).toBeInTheDocument();
  });
});

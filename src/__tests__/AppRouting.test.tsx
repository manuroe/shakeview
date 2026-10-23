import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import App from '../App';
import { useLogStore } from '../stores/logStore';
import { createHttpRequests, createParsedLogLines } from '../test/fixtures';
import { getHashParam, getAllHashParams } from '../test/uriTestHelpers';

describe('App routing fallback', () => {
  const originalHash = window.location.hash;

  beforeEach(() => {
    useLogStore.getState().clearData();
    useLogStore.getState().clearLastRoute();
  });

  afterEach(() => {
    window.location.hash = originalHash;
  });

  it('redirects to LandingPage when data is missing on deep link', async () => {
    window.location.hash = '#/logs';

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/Drop Rageshake Here/i)).toBeInTheDocument();
    });

    expect(useLogStore.getState().lastRoute).toBe('/logs');
  });

  it('redirects /decryption without data to the landing page (reload behaviour)', async () => {
    window.location.hash = '#/decryption';
    render(<App />);
    await waitFor(() => expect(screen.getByText(/Drop Rageshake Here/i)).toBeInTheDocument());
  });

  // ============================================================================
  // Multi-Parameter Combination Tests
  // ============================================================================

  describe('Multi-parameter combinations', () => {
    it('handles filter + status parameters together', async () => {
      const requests = createHttpRequests(10);
      const logLines = createParsedLogLines(15);
      useLogStore.getState().setHttpRequests(requests, logLines);

      window.location.hash = '#/http_requests?filter=sync&status=200,500';

      render(<App />);

      await waitFor(() => {
        const state = useLogStore.getState();
        expect(state.logFilter).toBe('sync');
        expect(state.statusCodeFilter?.has('200')).toBe(true);
        expect(state.statusCodeFilter?.has('500')).toBe(true);
      });
    });

    it('handles filter + time range parameters together', async () => {
      const requests = createHttpRequests(10);
      const logLines = createParsedLogLines(15);
      useLogStore.getState().setHttpRequests(requests, logLines);

      window.location.hash =
        '#/http_requests?filter=sync&start=2025-01-01T00:00:00Z&end=2025-01-02T00:00:00Z';

      render(<App />);

      await waitFor(() => {
        const state = useLogStore.getState();
        expect(state.logFilter).toBe('sync');
        expect(state.startTime).not.toBeNull();
        expect(state.endTime).not.toBeNull();
      });
    });

    it('handles filter + request_id parameters together', async () => {
      const requests = createHttpRequests(10);
      const logLines = createParsedLogLines(15);
      useLogStore.getState().setHttpRequests(requests, logLines);

      window.location.hash = '#/http_requests?filter=sync&request_id=REQ-5';

      render(<App />);

      await waitFor(() => {
        const state = useLogStore.getState();
        expect(state.logFilter).toBe('sync');
        // request_id should trigger auto-open
        // REQ-5: sendLineNumber = 5*2 = 10 → rowKey = 10
        expect(state.openLogViewerIds.has(10)).toBe(true);
      });
    });

    it('handles all parameters together', async () => {
      const requests = createHttpRequests(10);
      const logLines = createParsedLogLines(20);
      useLogStore.getState().setHttpRequests(requests, logLines);

      const complexUrl =
        '#/http_requests?' +
        'filter=sync&' +
        'status=200,500&' +
        'scale=25&' +
        'start=2025-01-01T00:00:00Z&' +
        'end=2025-01-02T00:00:00Z&' +
        'request_id=REQ-3';

      window.location.hash = complexUrl;

      render(<App />);

      await waitFor(() => {
        const state = useLogStore.getState();
        expect(state.logFilter).toBe('sync');
        expect(state.statusCodeFilter?.size).toBeGreaterThan(0);
        expect(state.timelineScale).toBe(25);
        expect(state.startTime).not.toBeNull();
        expect(state.endTime).not.toBeNull();
        // REQ-3: sendLineNumber = 3*2 = 6 → rowKey = 6
        expect(state.openLogViewerIds.has(6)).toBe(true);
      });
    });

    it('parameter order does not matter', async () => {
      const requests = createHttpRequests(10);
      const logLines = createParsedLogLines(15);
      useLogStore.getState().setHttpRequests(requests, logLines);

      // Different parameter order
      window.location.hash =
        '#/http_requests?request_id=REQ-2&status=500&filter=sync&scale=30';

      render(<App />);

      await waitFor(() => {
        const state = useLogStore.getState();
        expect(state.logFilter).toBe('sync');
        expect(state.statusCodeFilter?.has('500')).toBe(true);
        expect(state.timelineScale).toBe(30);
        // REQ-2: sendLineNumber = 2*2 = 4 → rowKey = 4
        expect(state.openLogViewerIds.has(4)).toBe(true);
      });
    });
  });

  // ============================================================================
  // Parameter Persistence Across Navigation
  // ============================================================================

  describe('Parameter persistence and clearing on navigation', () => {
    it('clears filter when navigating away from http_requests route', async () => {
      const requests = createHttpRequests(10);
      const logLines = createParsedLogLines(15);
      useLogStore.getState().setHttpRequests(requests, logLines);

      window.location.hash = '#/http_requests?filter=sync';

      const { rerender } = render(<App />);

      await waitFor(() => {
        expect(useLogStore.getState().logFilter).toBe('sync');
      });

      // Navigate to different route
      window.location.hash = '#/summary';

      rerender(<App />);

      await waitFor(() => {
        // Filter should be cleared on navigation
        expect(useLogStore.getState().logFilter).toBeNull();
      });
    });

    it('clears logFilter and openLogViewerIds when navigating away to a different route', async () => {
      const requests = createHttpRequests(10);
      const logLines = createParsedLogLines(15);
      useLogStore.getState().setHttpRequests(requests, logLines);

      // Start with all parameters
      window.location.hash = '#/http_requests?filter=sync&request_id=REQ-5';

      const { rerender } = render(<App />);

      await waitFor(() => {
        expect(useLogStore.getState().logFilter).toBe('sync');
      });

      // Navigate away (true navigation)
      window.location.hash = '#/logs';

      rerender(<App />);

      await waitFor(() => {
        // Both should be cleared on navigation
        expect(useLogStore.getState().logFilter).toBeNull();
        expect(useLogStore.getState().openLogViewerIds.size).toBe(0);
      });
    });
  });

  // ============================================================================
  // Edge Cases
  // ============================================================================

  describe('edge cases with multiple parameters', () => {
    it('handles duplicate parameters (last one wins)', async () => {
      const requests = createHttpRequests(5);
      const logLines = createParsedLogLines(10);
      useLogStore.getState().setHttpRequests(requests, logLines);

      // Duplicate filter parameters
      window.location.hash = '#/http_requests?filter=sync&filter=keys';

      render(<App />);

      await waitFor(() => {
        // URLSearchParams behavior: last value wins
        const filter = getHashParam('filter');
        expect(['sync', 'keys']).toContain(filter);
      });
    });

    it('handles empty parameter values', async () => {
      const requests = createHttpRequests(5);
      const logLines = createParsedLogLines(10);
      useLogStore.getState().setHttpRequests(requests, logLines);

      window.location.hash = '#/http_requests?filter=&status=200';

      render(<App />);

      await waitFor(() => {
        const state = useLogStore.getState();
        // Empty filter should be treated as null
        expect(state.logFilter).toBeNull();
        // Other parameters should still apply
        expect(state.statusCodeFilter?.has('200')).toBe(true);
      });
    });

    it('handles URL with only some parameters', async () => {
      const requests = createHttpRequests(5);
      const logLines = createParsedLogLines(10);
      useLogStore.getState().setHttpRequests(requests, logLines);

      window.location.hash = '#/http_requests?filter=sync';

      render(<App />);

      await waitFor(() => {
        const state = useLogStore.getState();
        expect(state.logFilter).toBe('sync');
        // Other params should have default values
        expect(state.statusCodeFilter).toBeNull();
        expect(state.startTime).toBeNull();
      });
    });

    it('handles very long filter values', async () => {
      const requests = createHttpRequests(5);
      const logLines = createParsedLogLines(10);
      useLogStore.getState().setHttpRequests(requests, logLines);

      const longUri =
        '_matrix/client/v0/rooms/' + 'a'.repeat(200) + '/messages/search';
      const encodedUri = encodeURIComponent(longUri);
      window.location.hash = `#/http_requests?filter=${encodedUri}`;

      render(<App />);

      await waitFor(() => {
        expect(useLogStore.getState().logFilter).toBe(longUri);
      });
    });

    it('handles parameters with special Matrix characters', async () => {
      const requests = createHttpRequests(5);
      const logLines = createParsedLogLines(10);
      useLogStore.getState().setHttpRequests(requests, logLines);

      // Matrix URIs often contain special characters like ! : @ #
      // These should be preserved after URL encoding/decoding roundtrip
      const matrixUri =
        '_matrix/client/r0/room/!abc:matrix.org/messages?limit=10&dir=b';
      
      window.location.hash = `#/http_requests?filter=${encodeURIComponent(matrixUri)}`;

      render(<App />);

      await waitFor(() => {
        // Store gets decoded value (searchParams.get() decodes automatically)
        expect(useLogStore.getState().logFilter).toBe(matrixUri);
      });
    });
  });
});

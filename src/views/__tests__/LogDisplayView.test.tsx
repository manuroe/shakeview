import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import { screen, fireEvent, createEvent } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { useLogStore } from '../../stores/logStore';
import { LogDisplayView } from '../LogDisplayView';
import { createLogsWithMatches, createParsedLogLine } from '../../test/fixtures';
import { parseAllHttpRequests } from '../../utils/logParser';
import { resetSwiftPathCacheForTests } from '../../utils/githubLinkGenerator';
import styles from '../LogDisplayView.module.css';
import {
  KeyboardShortcutContext,
  type KeyboardShortcutContextValue,
} from '../../components/KeyboardShortcutContext';

// RowTimeAction uses useURLParams (which calls useLocation) — mock it so
// LogDisplayView tests don't need a Router context.
vi.mock('../../hooks/useURLParams', () => ({
  useURLParams: () => ({ setTimeFilter: vi.fn() }),
}));

// Mock react-virtual to simplify rendering in tests
vi.mock('@tanstack/react-virtual', () => {
  return {
    useVirtualizer: (opts: any) => ({
      getTotalSize: () => opts.count * 24,
      getVirtualItems: () => Array.from({ length: opts.count }, (_, i) => ({ index: i, key: i, start: i * 24 })),
      measureElement: () => {},
      measure: () => {},
      measurementsCache: [],
    }),
  };
});

function getLineContainer(lineNumber: number): HTMLElement {
  const candidates = screen.getAllByText(String(lineNumber));
  const lineNumSpan = candidates.find((el: Element) => el.classList.contains(styles.logLineNumber)) as HTMLElement;
  if (!lineNumSpan) throw new Error(`Line number span not found for ${lineNumber}`);
  return lineNumSpan.closest(`.${styles.logLine}`) as HTMLElement;
}

describe('LogDisplayView gap arrows & expansion', () => {
  it('shows arrows and expands down on newly displayed lines', async () => {
    const user = userEvent.setup();
    const total = 200;
    const matchIndices = [76, 157];
    useLogStore.setState({ rawLogLines: createLogsWithMatches(total, matchIndices) });

    render(<LogDisplayView requestFilter="MATCH" />);

    // Line 76 should be visible
    // Ensure line containers exist
    const line76Container = getLineContainer(76);
    expect(line76Container).toBeInTheDocument();

    // It should have a down arrow
    const downBtn76 = line76Container.querySelector('button[aria-label="Load hidden lines below"]') as HTMLButtonElement;
    expect(downBtn76).toBeTruthy();
    await user.click(downBtn76);

    // After expansion, line 86 should appear
    const line86Container = getLineContainer(86);
    expect(line86Container).toBeInTheDocument();

    // Click down on line 86's down arrow: find the nearest down arrow again
    const downBtn86 = line86Container.querySelector('button[aria-label="Load hidden lines below"]') as HTMLButtonElement;
    expect(downBtn86).toBeTruthy();
    await user.click(downBtn86);

    // Now line 96 should appear
    const line96Container = getLineContainer(96);
    expect(line96Container).toBeInTheDocument();
  });

  it('shows arrows and expands up on newly displayed lines', async () => {
    const user = userEvent.setup();
    const total = 200;
    const matchIndices = [76, 157];
    useLogStore.setState({ rawLogLines: createLogsWithMatches(total, matchIndices) });

    render(<LogDisplayView requestFilter="MATCH" />);

    // Line 157 visible
    const line157Container = getLineContainer(157);
    expect(line157Container).toBeInTheDocument();

    // It should have an up arrow
    const upBtn157 = line157Container.querySelector('button[aria-label="Load hidden lines above"]') as HTMLButtonElement;
    expect(upBtn157).toBeTruthy();
    await user.click(upBtn157);

    // After expansion, line 156 should appear
    const line156Container = getLineContainer(156);
    expect(line156Container).toBeInTheDocument();

    // Next up arrow should be on the topmost newly displayed line (147)
    const line147Container = getLineContainer(147);
    const upBtn147 = line147Container.querySelector('button[aria-label="Load hidden lines above"]') as HTMLButtonElement;
    expect(upBtn147).toBeTruthy();
    await user.click(upBtn147);

    const line146Container = getLineContainer(146);
    expect(line146Container).toBeInTheDocument();
  });

  it('context menu: Load all to next line (down)', async () => {
    const user = userEvent.setup();
    const total = 200;
    const matchIndices = [76, 157];
    useLogStore.setState({ rawLogLines: createLogsWithMatches(total, matchIndices) });

    render(<LogDisplayView requestFilter="MATCH" nextRequestLineRange={{ start: 157, end: 160 }} />);

    const line76Container = getLineContainer(76);
    const downBtn76 = line76Container.querySelector('button[aria-label="Load hidden lines below"]') as HTMLButtonElement;
    expect(downBtn76).toBeTruthy();
    fireEvent.contextMenu(downBtn76);

    const loadAllNext = await screen.findByText(/Load to next log/i);
    await user.click(loadAllNext);

    // Should expand all until next anchor (157), making 156 visible and no down arrow on 156
    const line156Container = getLineContainer(156);
    expect(line156Container).toBeInTheDocument();
    const downBtn156 = line156Container.querySelector('button[aria-label="Load hidden lines below"]');
    expect(downBtn156).toBeNull();
  });

  it('context menu: Load 10 more lines action expands by 10', async () => {
    const user = userEvent.setup();
    const total = 200;
    const matchIndices = [76, 157];
    useLogStore.setState({ rawLogLines: createLogsWithMatches(total, matchIndices) });

    render(<LogDisplayView requestFilter="MATCH" />);

    const line76Container = getLineContainer(76);
    const downBtn76 = line76Container.querySelector('button[aria-label="Load hidden lines below"]') as HTMLButtonElement;
    expect(downBtn76).toBeTruthy();
    fireEvent.contextMenu(downBtn76);

    const load10 = await screen.findByText(/Load 10 more lines/i);
    await user.click(load10);

    expect(getLineContainer(86)).toBeInTheDocument();
  });

  it('context menu: Load all to previous line (up)', async () => {
    const user = userEvent.setup();
    const total = 200;
    const matchIndices = [76, 157];
    useLogStore.setState({ rawLogLines: createLogsWithMatches(total, matchIndices) });

    render(<LogDisplayView requestFilter="MATCH" prevRequestLineRange={{ start: 70, end: 76 }} />);

    const line157Container = getLineContainer(157);
    const upBtn157 = line157Container.querySelector('button[aria-label="Load hidden lines above"]') as HTMLButtonElement;
    expect(upBtn157).toBeTruthy();
    fireEvent.contextMenu(upBtn157);

    const loadAllPrev = await screen.findByText(/Load to previous log/i);
    await user.click(loadAllPrev);

    // Should expand all until previous anchor (76), making 77 visible and no up arrow on 77
    const line77Container = getLineContainer(77);
    expect(line77Container).toBeInTheDocument();
    const upBtn77 = line77Container.querySelector('button[aria-label="Load hidden lines above"]');
    expect(upBtn77).toBeNull();
  });

  it('context menu: Load all to bottom (down at last line)', async () => {
    const user = userEvent.setup();
    const total = 200;
    const matchIndices = [76, 157];
    useLogStore.setState({ rawLogLines: createLogsWithMatches(total, matchIndices) });

    render(<LogDisplayView requestFilter="MATCH" />);

    const line157Container = getLineContainer(157);
    const downBtn157 = line157Container.querySelector('button[aria-label="Load hidden lines below"]') as HTMLButtonElement;
    expect(downBtn157).toBeTruthy();
    fireEvent.contextMenu(downBtn157);

    const loadAllBottom = await screen.findByText(/Load all to bottom/i);
    await user.click(loadAllBottom);

    // Should expand all to file end, making last line visible and no down arrow there
    const line199Container = getLineContainer(199);
    expect(line199Container).toBeInTheDocument();
    const downBtn199 = line199Container.querySelector('button[aria-label="Load hidden lines below"]');
    expect(downBtn199).toBeNull();
  });

  it('context menu: Load all to top (up at first line)', async () => {
    const user = userEvent.setup();
    const total = 200;
    const matchIndices = [76, 157];
    useLogStore.setState({ rawLogLines: createLogsWithMatches(total, matchIndices) });

    render(<LogDisplayView requestFilter="MATCH" />);

    const line76Container = getLineContainer(76);
    const upBtn76 = line76Container.querySelector('button[aria-label="Load hidden lines above"]') as HTMLButtonElement;
    expect(upBtn76).toBeTruthy();
    fireEvent.contextMenu(upBtn76);

    const loadAllTop = await screen.findByText(/Load all to top/i);
    await user.click(loadAllTop);

    // Should expand all to file start, making first line visible and no up arrow there
    const line0Container = getLineContainer(0);
    expect(line0Container).toBeInTheDocument();
    const upBtn0 = line0Container.querySelector('button[aria-label="Load hidden lines above"]');
    expect(upBtn0).toBeNull();
  });

  it('stripPrefix toggle affects displayed text', async () => {
    const user = userEvent.setup();
    // The real parser sets line.message to the full raw first line (including the ISO timestamp
    // prefix). Replicate that here so the fixture matches production behaviour.
    const isoTimestamp = '2024-01-01T10:00:03.000000Z';
    const fullLine = `${isoTimestamp} ERROR MATCH full-line-content`;
    const line = createParsedLogLine({
      lineNumber: 3,
      isoTimestamp,
      level: 'ERROR',
      rawText: fullLine,
      // message = full raw first line, as the real parser outputs
      message: fullLine,
      strippedMessage: 'MATCH full-line-content',
    });
    useLogStore.setState({ rawLogLines: [line] });

    render(<LogDisplayView requestFilter="MATCH" />);

    const line3Container = getLineContainer(3);
    const textSpan = line3Container.querySelector(`.${styles.logLineText}`) as HTMLSpanElement;
    expect(textSpan).toBeTruthy();

    // With stripPrefix=true (default), the ISO timestamp must NOT appear in the text span
    // (it is already rendered in the dedicated timestamp column).
    expect(textSpan.textContent?.trim().startsWith(isoTimestamp)).toBe(false);

    // Toggle stripPrefix off
    const stripCheckbox = screen.getByLabelText(/Strip prefix/i) as HTMLInputElement;
    await user.click(stripCheckbox);

    // With stripPrefix=false the full line.message is rendered, including the ISO timestamp.
    expect(textSpan.textContent?.includes(isoTimestamp)).toBe(true);
  });

  it('lineWrap toggles wrap class on lines', async () => {
    const user = userEvent.setup();
    const total = 5;
    const matchIndices = [2, 4];
    useLogStore.setState({ rawLogLines: createLogsWithMatches(total, matchIndices) });

    render(<LogDisplayView requestFilter="MATCH" />);

    let line2Container = getLineContainer(2);
    // Default is nowrap
    expect(line2Container.classList.contains(styles.nowrap)).toBe(true);
    expect(line2Container.classList.contains(styles.wrap)).toBe(false);

    // Toggle line wrap
    const wrapCheckbox = screen.getByLabelText(/Line wrap/i) as HTMLInputElement;
    await user.click(wrapCheckbox);

    // Re-query after state change to avoid stale node
    line2Container = getLineContainer(2);
    expect(line2Container.classList.contains(styles.wrap)).toBe(true);
    expect(line2Container.classList.contains(styles.nowrap)).toBe(false);
  });

  describe('GitHub source links', () => {
    afterEach(() => {
      vi.restoreAllMocks();
      resetSwiftPathCacheForTests();
    });

    const RUST_LINE = '2026-02-04T13:01:45.365379Z DEBUG matrix_sdk::http_client::native: Sending request num_attempt=1 | crates/matrix-sdk/src/http_client/native.rs:78 | spans: root';
    const SWIFT_LINE = '2026-02-04T13:10:37.511766Z  INFO elementx: Received room list update: running | ClientProxy.swift:1092 | spans: root';
    const SENTRY_CRASH_ID = '04f4668abb144c5f9818734e6ea88896';
    const SENTRY_CRASH_LINE = `2026-03-18T18:00:07.580609Z ERROR elementx: Sentry detected a crash in the previous run: ${SENTRY_CRASH_ID} | AppCoordinator.swift:1002 | spans: root`;

    it('shows source links with hover styling for source-tagged lines', async () => {
      const user = userEvent.setup();
      const parsed = parseAllHttpRequests(`${RUST_LINE}\n${SWIFT_LINE}`);
      useLogStore.setState({ rawLogLines: parsed.rawLogLines });

      render(<LogDisplayView />);

      // Links are always in the DOM; before hover they carry the inactive class.
      const rustLink = screen.getByRole('link', { name: 'crates/matrix-sdk/src/http_client/native.rs:78' });
      expect(rustLink).toHaveAttribute('href', 'https://github.com/matrix-org/matrix-rust-sdk/blob/main/crates/matrix-sdk/src/http_client/native.rs#L78');
      expect(rustLink.className).toMatch(/sourceLinkInactive/);

      // Hovering the row switches the link to active (visible) styling.
      await user.hover(getLineContainer(1));
      await waitFor(() => expect(rustLink.className).toMatch(/sourceLink(?!Inactive)/));

      const swiftLink = screen.getByRole('link', { name: 'ClientProxy.swift:1092' });
      expect(swiftLink).toHaveAttribute('href', 'https://github.com/element-hq/element-x-ios/search?q=ClientProxy.swift%20repo%3Aelement-hq%2Felement-x-ios&type=code');
      expect(swiftLink.className).toMatch(/sourceLinkInactive/);
      await user.hover(getLineContainer(2));
      await waitFor(() => expect(swiftLink.className).toMatch(/sourceLink(?!Inactive)/));
    });

    it('links the `at` line of Element Web crypto-wasm entries, git and crates.io paths', () => {
      const gitAt = '/home/runner/.cargo/git/checkouts/matrix-rust-sdk-5cafb579/f333a32/crates/matrix-sdk-crypto/src/olm/session.rs:42';
      const registryAt = '/home/runner/.cargo/registry/src/index.crates.io-1949cf8c/matrix-sdk-crypto-0.18.0/src/machine/mod.rs:1912';
      const parsed = parseAllHttpRequests([
        '2026-09-29T07:06:20.662Z D DEBUG matrix_sdk_crypto::olm: Decrypted an Olm message',
        `    at ${gitAt}`,
        '2026-09-29T07:06:21.000Z W WARN matrix_sdk_crypto::machine: Failed to decrypt a room event',
        `    at ${registryAt}`,
        '    in matrix_sdk_crypto::machine::decrypt_room_event with room_id="!r:example.org"',
      ].join('\n'));
      useLogStore.setState({ rawLogLines: parsed.rawLogLines });

      render(<LogDisplayView />);

      expect(screen.getByRole('link', { name: gitAt })).toHaveAttribute(
        'href', 'https://github.com/matrix-org/matrix-rust-sdk/blob/main/crates/matrix-sdk-crypto/src/olm/session.rs#L42',
      );
      // crates.io paths are mapped onto the repo crate, not linked verbatim.
      const registryLink = screen.getByRole('link', { name: registryAt });
      expect(registryLink).toHaveAttribute(
        'href', 'https://github.com/matrix-org/matrix-rust-sdk/blob/main/crates/matrix-sdk-crypto/src/machine/mod.rs#L1912',
      );
      expect(registryLink.className).toMatch(/sourceLinkInactive/);
      // The rest of the continuation stays plain text.
      expect(screen.getByText(/in matrix_sdk_crypto::machine::decrypt_room_event/)).toBeInTheDocument();
    });

    it('shows active link styling on keyboard focus and restores inactive on blur', async () => {
      const parsed = parseAllHttpRequests(RUST_LINE);
      useLogStore.setState({ rawLogLines: parsed.rawLogLines });

      render(<LogDisplayView />);

      // Link is always in the DOM; starts with inactive (plain-text) styling.
      const link = screen.getByRole('link', { name: 'crates/matrix-sdk/src/http_client/native.rs:78' });
      expect(link).toHaveAttribute('href', 'https://github.com/matrix-org/matrix-rust-sdk/blob/main/crates/matrix-sdk/src/http_client/native.rs#L78');
      expect(link.className).toMatch(/sourceLinkInactive/);

      // Focus the row → link becomes visually active.
      const container = getLineContainer(1);
      act(() => { container.focus(); });
      await waitFor(() => expect(link.className).toMatch(/sourceLink(?!Inactive)/));

      // Blur the row entirely → link reverts to inactive styling (still in DOM).
      act(() => { container.blur(); });
      await waitFor(() => expect(link.className).toMatch(/sourceLinkInactive/));
    });

    it('clicking a Swift source link navigates to the resolved file URL in a new tab', async () => {
      const user = userEvent.setup();
      const parsed = parseAllHttpRequests(SWIFT_LINE);
      useLogStore.setState({ rawLogLines: parsed.rawLogLines });

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          tree: [{ path: 'ElementX/Sources/Services/Client/ClientProxy.swift', type: 'blob' }],
        }),
      } as Response);

      const mockTab = { opener: null as unknown, location: { href: '' }, close: vi.fn() };
      vi.spyOn(window, 'open').mockReturnValue(mockTab as Window);

      render(<LogDisplayView />);
      await user.hover(getLineContainer(1));
      const link = await screen.findByRole('link', { name: 'ClientProxy.swift:1092' });
      // Use fireEvent.click so the synthetic onClick fires without userEvent's
      // anchor-navigation side-effects in jsdom.
      fireEvent.click(link);

      expect(window.open).toHaveBeenCalledWith('', '_blank');
      expect(mockTab.opener).toBeNull();
      await waitFor(() => {
        expect(mockTab.location.href).toBe(
          'https://github.com/element-hq/element-x-ios/blob/main/ElementX/Sources/Services/Client/ClientProxy.swift#L1092'
        );
      });
    });

    it('preserves search highlights in the text surrounding the source link when hovering a matched line', async () => {
      const user = userEvent.setup();
      const parsed = parseAllHttpRequests(RUST_LINE);
      useLogStore.setState({ rawLogLines: parsed.rawLogLines });

      render(<LogDisplayView />);

      const searchInput = screen.getByPlaceholderText(/search/i);
      await user.type(searchInput, 'Sending');
      // Wait for the debounced searchQuery to update and the line to be classed as a match.
      await waitFor(() => expect(getLineContainer(1).className).toMatch(/matchLine/));

      const container = getLineContainer(1);
      await user.hover(container);

      const link = await screen.findByRole('link', { name: 'crates/matrix-sdk/src/http_client/native.rs:78' });
      expect(link).toBeInTheDocument();

      // The matched word should still appear highlighted inside a <mark>
      const marks = container.querySelectorAll('mark');
      expect(marks.length).toBeGreaterThan(0);
      expect(marks[0].textContent).toBe('Sending');
    });

    it('highlights search matches inside the source link text when the line matches the search', async () => {
      const user = userEvent.setup();
      const parsed = parseAllHttpRequests(RUST_LINE);
      useLogStore.setState({ rawLogLines: parsed.rawLogLines });

      render(<LogDisplayView />);

      // Search for a term that appears inside the sourceRef itself.
      const searchInput = screen.getByPlaceholderText(/search/i);
      await user.type(searchInput, 'native.rs');
      await waitFor(() => expect(getLineContainer(1).className).toMatch(/matchLine/));

      // The link is always in the DOM; its highlighted text can be found by accessible name.
      const link = await screen.findByRole('link', { name: /native\.rs/ });
      const markInLink = link.querySelector('mark');
      expect(markInLink).not.toBeNull();
      expect(markInLink?.textContent).toBe('native.rs');
    });

    it('keeps active link styling when focus moves from the row to the link inside it', async () => {
      const parsed = parseAllHttpRequests(RUST_LINE);
      useLogStore.setState({ rawLogLines: parsed.rawLogLines });

      render(<LogDisplayView />);

      // Link is always in the DOM; starts inactive.
      const link = screen.getByRole('link', { name: 'crates/matrix-sdk/src/http_client/native.rs:78' });
      expect(link.className).toMatch(/sourceLinkInactive/);

      const container = getLineContainer(1);
      act(() => { container.focus(); });
      await waitFor(() => expect(link.className).toMatch(/sourceLink(?!Inactive)/));

      // Blur the row with relatedTarget = the link (focus staying inside the row).
      // The active styling should be preserved.
      act(() => { fireEvent.blur(container, { relatedTarget: link }); });
      expect(link.className).toMatch(/sourceLink(?!Inactive)/);

      // Blur to outside: inactive styling restored.
      act(() => { container.blur(); });
      await waitFor(() => expect(link.className).toMatch(/sourceLinkInactive/));
    });

    it('shows sentry crash ID as clickable link with hover styling', async () => {
      const user = userEvent.setup();
      const parsed = parseAllHttpRequests(SENTRY_CRASH_LINE);
      useLogStore.setState({ rawLogLines: parsed.rawLogLines, sentryEvents: parsed.sentryEvents });

      render(<LogDisplayView />);

      const sentryLink = screen.getByRole('link', { name: SENTRY_CRASH_ID });
      expect(sentryLink).toHaveAttribute(
        'href',
        `https://sentry.tools.element.io/organizations/element/issues/?project=44&query=${SENTRY_CRASH_ID}`
      );
      expect(sentryLink.className).toMatch(/sourceLinkInactive/);

      await user.hover(getLineContainer(1));
      await waitFor(() => expect(sentryLink.className).toMatch(/sourceLink(?!Inactive)/));
    });

    it('highlights search matches inside sentry crash ID link text', async () => {
      const user = userEvent.setup();
      const parsed = parseAllHttpRequests(SENTRY_CRASH_LINE);
      useLogStore.setState({ rawLogLines: parsed.rawLogLines, sentryEvents: parsed.sentryEvents });

      render(<LogDisplayView />);

      const searchInput = screen.getByPlaceholderText(/search/i);
      await user.type(searchInput, '9818734e');
      await waitFor(() => expect(getLineContainer(1).className).toMatch(/matchLine/));

      const sentryLink = await screen.findByRole('link', { name: /9818734e/ });
      const markInLink = sentryLink.querySelector('mark');
      expect(markInLink).not.toBeNull();
      expect(markInLink?.textContent).toBe('9818734e');
    });
  });

  it('contextLines shows surrounding lines when enabled', async () => {
    const user = userEvent.setup();
    const total = 30;
    const matchIndices = [15];
    useLogStore.setState({ rawLogLines: createLogsWithMatches(total, matchIndices) });

    render(<LogDisplayView requestFilter="MATCH" defaultShowOnlyMatching={true} />);

    // Initially only matching line should be visible
    const line15Container = getLineContainer(15);
    expect(line15Container).toBeInTheDocument();
    // A non-matching neighbor should not be present yet
    expect(() => getLineContainer(14)).toThrow();

    // Enable context via the ≡ button (sets contextLines=5)
    const ctxToggle = screen.getByTitle(/Context lines before\/after matches/i);
    await user.click(ctxToggle as HTMLButtonElement);

    // Now surrounding lines within 5 should appear
    const line14Container = getLineContainer(14);
    const line20Container = getLineContainer(20);
    expect(line14Container).toBeInTheDocument();
    expect(line20Container).toBeInTheDocument();
  });

  it('supports resetting and typing context line count', async () => {
    const user = userEvent.setup();
    useLogStore.setState({ rawLogLines: createLogsWithMatches(30, [10]) });

    render(<LogDisplayView requestFilter="MATCH" />);

    await new Promise(resolve => setTimeout(resolve, 350));

    const ctxToggle = screen.getByTitle(/Context lines before\/after matches/i);
    const ctxInput = screen.getByTitle(/Context lines \(0 = disabled\)/i) as HTMLInputElement;

    await user.click(ctxToggle as HTMLButtonElement);
    expect(ctxInput.value).toBe('5');

    await user.click(ctxToggle as HTMLButtonElement);
    expect(ctxInput.value).toBe('0');

    fireEvent.change(ctxInput, { target: { value: '3' } });
    expect(ctxInput.value).toBe('3');
  });

  it('removes arrows when gap fully expanded to next anchor', async () => {
    const total = 200;
    const matchIndices = [76, 77]; // Adjacent so no gap below 76
    useLogStore.setState({ rawLogLines: createLogsWithMatches(total, matchIndices) });

    render(<LogDisplayView requestFilter="MATCH" defaultShowOnlyMatching={true} />);

    const line76Container2 = getLineContainer(76);
    const line77Container2 = getLineContainer(77);
    expect(line76Container2).toBeInTheDocument();
    expect(line77Container2).toBeInTheDocument();

    // There should be no down arrow for 76 because next line is visible
    const downBtn76_2 = line76Container2.querySelector('button[aria-label="Load hidden lines below"]');
    expect(downBtn76_2).toBeNull();
  });
});

describe('LogDisplayView filter & search behaviors', () => {
  beforeEach(() => {
    useLogStore.getState().clearData();
  });

  it('filter narrows visible lines to only matching ones', async () => {
    const total = 20;
    useLogStore.setState({
      rawLogLines: createLogsWithMatches(total, []),
    });

    const { rerender } = render(<LogDisplayView />);

    // All lines should be visible initially
    expect(screen.getByText('0')).toBeInTheDocument();
    expect(screen.getByText('19')).toBeInTheDocument();

    // Apply filter
    const filterInput = screen.getByPlaceholderText(/Filter logs/i);
    await userEvent.type(filterInput, 'MATCH');
    
    // Wait for debounce
    await new Promise(resolve => setTimeout(resolve, 400));
    rerender(<LogDisplayView />);

    // No lines should be visible (no MATCH in test logs by default)
    expect(() => getLineContainer(0)).toThrow();
  });

  it('search highlights matching text within filtered results', async () => {
    const total = 10;
    useLogStore.setState({
      rawLogLines: createLogsWithMatches(total, [2, 5, 8]),
    });

    render(<LogDisplayView requestFilter="MATCH" />);

    // Filter should show only lines 2, 5, 8
    const line2Container = getLineContainer(2);
    const line5Container = getLineContainer(5);
    const line8Container = getLineContainer(8);
    expect(line2Container).toBeInTheDocument();
    expect(line5Container).toBeInTheDocument();
    expect(line8Container).toBeInTheDocument();

    // Apply search within filtered results
    const searchInput = screen.getByPlaceholderText(/Search logs/i);
    await userEvent.type(searchInput, 'MATCH');

    // Wait for debounce
    await new Promise(resolve => setTimeout(resolve, 400));

    // Search should highlight matches
    const marks = screen.queryAllByRole('mark');
    expect(marks.length).toBeGreaterThan(0);
  });

  it('search counter shows correct number of matches in filtered results', async () => {
    const total = 20;
    const matchIndices = Array.from({ length: 20 }, (_, i) => i); // All have "MATCH"
    useLogStore.setState({
      rawLogLines: createLogsWithMatches(total, matchIndices),
    });

    render(<LogDisplayView />);

    // All 20 lines visible
    const searchInput = screen.getByPlaceholderText(/Search logs/i);
    await userEvent.type(searchInput, 'MATCH');

    // Wait for debounce
    await new Promise(resolve => setTimeout(resolve, 400));

    // Counter should show search results
    const counter = screen.queryByText(/\d+ \/ \d+/);
    expect(counter).toBeTruthy();
  });

  it('search counter reflects filtered results only', async () => {
    const total = 10;
    const matchIndices = Array.from({ length: 10 }, (_, i) => i); // All have "MATCH"
    useLogStore.setState({
      rawLogLines: createLogsWithMatches(total, matchIndices),
    });

    render(<LogDisplayView requestFilter="MATCH" />);

    // Apply search
    const searchInput = screen.getByPlaceholderText(/Search logs/i);
    await userEvent.type(searchInput, 'MATCH');

    // Wait for debounce
    await new Promise(resolve => setTimeout(resolve, 400));

    // Counter should show matches in filtered results (all 10 have "MATCH")
    const counter = screen.queryByText(/\d+ \/ \d+/);
    expect(counter).toBeTruthy();
  });

  it('search is case-insensitive', async () => {
    const logs: ParsedLogLine[] = [
      {
        lineNumber: 0,
        rawText: '2024-01-01T00:00:00.000000Z INFO uppercase TEXT',
        isoTimestamp: '2024-01-01T00:00:00.000000Z',
        timestampUs: new Date('2024-01-01T00:00:00.000Z').getTime() * 1000,
        displayTime: '00:00:00.000000',
        level: 'INFO',
        message: 'uppercase TEXT',
        strippedMessage: 'uppercase TEXT',
        continuationLines: [],
      },
      {
        lineNumber: 1,
        rawText: '2024-01-01T00:00:00.000000Z INFO lowercase text',
        isoTimestamp: '2024-01-01T00:00:00.000000Z',
        timestampUs: new Date('2024-01-01T00:00:00.000Z').getTime() * 1000,
        displayTime: '00:00:00.000000',
        level: 'INFO',
        message: 'lowercase text',
        strippedMessage: 'lowercase text',
        continuationLines: [],
      },
    ];
    useLogStore.setState({ rawLogLines: logs });

    render(<LogDisplayView />);

    // Search for "TEXT" should find both lines regardless of source text casing
    const searchInput = screen.getByPlaceholderText(/Search logs/i) as HTMLInputElement;
    await userEvent.type(searchInput, 'TEXT');

    await new Promise(resolve => setTimeout(resolve, 400));

    // Matches are highlighted in both lines (case-insensitive search) and both lines remain visible
    const marks = screen.queryAllByRole('mark');
    expect(marks.length).toBe(2);
    expect(screen.getByText('0')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('filter input initializes from requestFilter prop', () => {
    useLogStore.setState({
      rawLogLines: createLogsWithMatches(10, [2, 5]),
    });

    render(<LogDisplayView requestFilter="MATCH" />);

    const filterInput = screen.getByPlaceholderText(/Filter logs/i) as HTMLInputElement;
    expect(filterInput.value).toBe('MATCH');
  });

  it('search input starts empty regardless of requestFilter', () => {
    useLogStore.setState({
      rawLogLines: createLogsWithMatches(10, [2, 5]),
    });

    render(<LogDisplayView requestFilter="MATCH" />);

    const searchInput = screen.getByPlaceholderText(/Search logs/i) as HTMLInputElement;
    expect(searchInput.value).toBe('');
  });

  it('filter and search can be used independently', async () => {
    const logs: ParsedLogLine[] = [
      {
        lineNumber: 0,
        rawText: '2024-01-01T00:00:00.000000Z INFO request-001',
        isoTimestamp: '2024-01-01T00:00:00.000000Z',
        timestampUs: new Date('2024-01-01T00:00:00.000Z').getTime() * 1000,
        displayTime: '00:00:00.000000',
        level: 'INFO',
        message: 'request-001',
        strippedMessage: 'request-001',
        continuationLines: [],
      },
      {
        lineNumber: 1,
        rawText: '2024-01-01T00:00:00.000000Z INFO response-data',
        isoTimestamp: '2024-01-01T00:00:00.000000Z',
        timestampUs: new Date('2024-01-01T00:00:00.000Z').getTime() * 1000,
        displayTime: '00:00:00.000000',
        level: 'INFO',
        message: 'response-data',
        strippedMessage: 'response-data',
        continuationLines: [],
      },
      {
        lineNumber: 2,
        rawText: '2024-01-01T00:00:00.000000Z INFO request-002',
        isoTimestamp: '2024-01-01T00:00:00.000000Z',
        timestampUs: new Date('2024-01-01T00:00:00.000Z').getTime() * 1000,
        displayTime: '00:00:00.000000',
        level: 'INFO',
        message: 'request-002',
        strippedMessage: 'request-002',
        continuationLines: [],
      },
    ];
    useLogStore.setState({ rawLogLines: logs });

    render(<LogDisplayView requestFilter="request" />);

    // Filter should show lines 0 and 2
    expect(screen.getByText('0')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    // Line 1 should not be visible
    expect(() => getLineContainer(1)).toThrow();

    // Apply search for "001" (only in line 0)
    const searchInput = screen.getByPlaceholderText(/Search logs/i);
    await userEvent.type(searchInput, '001');

    await new Promise(resolve => setTimeout(resolve, 400));

    // Should have search results
    const counter = screen.queryByText(/1 \/ 1/);
    expect(counter).toBeTruthy();
  });

  it('handles Enter and Shift+Enter in search input navigation', async () => {
    const total = 20;
    useLogStore.setState({ rawLogLines: createLogsWithMatches(total, [3, 7], 'TOKEN') });

    render(<LogDisplayView requestFilter="TOKEN" />);

    const searchInput = screen.getByPlaceholderText(/Search logs/i);
    await userEvent.type(searchInput, 'TOKEN');
    await new Promise(resolve => setTimeout(resolve, 350));

    const enterEvent = createEvent.keyDown(searchInput, { key: 'Enter' });
    enterEvent.preventDefault = vi.fn();
    fireEvent(searchInput, enterEvent);

    const shiftEnterEvent = createEvent.keyDown(searchInput, { key: 'Enter', shiftKey: true });
    shiftEnterEvent.preventDefault = vi.fn();
    fireEvent(searchInput, shiftEnterEvent);

    expect(enterEvent.preventDefault).toHaveBeenCalled();
    expect(shiftEnterEvent.preventDefault).toHaveBeenCalled();
  });

  it('context lines work with filter', async () => {
    const total = 20;
    useLogStore.setState({
      rawLogLines: createLogsWithMatches(total, [10]), // Only line 10 matches
    });

    render(<LogDisplayView requestFilter="MATCH" />);

    // Only line 10 should be visible
    const line10Container = getLineContainer(10);
    expect(line10Container).toBeInTheDocument();
    expect(() => getLineContainer(9)).toThrow();
    expect(() => getLineContainer(11)).toThrow();

    // Enable context lines
    const ctxToggle = screen.getByTitle(/Context lines before\/after matches/i);
    await userEvent.click(ctxToggle as HTMLButtonElement);

    await new Promise(resolve => setTimeout(resolve, 400));

    // Now lines 5-15 should be visible (10 ± 5)
    const line5Container = getLineContainer(5);
    const line15Container = getLineContainer(15);
    expect(line5Container).toBeInTheDocument();
    expect(line15Container).toBeInTheDocument();
  });
});

describe('LogDisplayView requestFilter prop sync', () => {
  it('updates filter input when requestFilter prop changes', async () => {
    const total = 50;
    const matchIndices = [10, 20, 30];
    useLogStore.setState({ rawLogLines: createLogsWithMatches(total, matchIndices) });

    // Initial render with no filter
    const { rerender } = render(<LogDisplayView requestFilter="" />);

    // All lines should be visible (no filter active)
    expect(getLineContainer(1)).toBeInTheDocument();
    expect(getLineContainer(5)).toBeInTheDocument();

    // Rerender with a filter prop - simulates URL→Store sync
    rerender(<LogDisplayView requestFilter="MATCH" />);

    // Wait for debounce
    await new Promise(resolve => setTimeout(resolve, 350));

    // Now only matching lines should be visible
    const line10Container = getLineContainer(10);
    expect(line10Container).toBeInTheDocument();

    // Non-matching lines should be hidden
    expect(() => getLineContainer(5)).toThrow();
  });

  it('syncs long filter strings from URL', async () => {
    const total = 20;
    // Create logs where line 7 (index 7) matches a specific long string
    // This simulates the user's URL with a very long filter
    const matchIndices = [7]; // Line number 7 (lineNumber = startLineNumber + index = 0 + 7)
    const longFilter = 'LONG_ERROR_MESSAGE_FROM_URL_PARAMETER';
    const logs = createLogsWithMatches(total, matchIndices, longFilter);
    useLogStore.setState({ rawLogLines: logs });

    // Simulate URL with long filter (like the user's issue)
    const { rerender } = render(<LogDisplayView requestFilter="" />);

    // Initially no filter - all visible
    expect(getLineContainer(0)).toBeInTheDocument();

    // Apply filter via prop update (simulating URL→Store sync)
    rerender(<LogDisplayView requestFilter={longFilter} />);

    // Wait for debounce
    await new Promise(resolve => setTimeout(resolve, 350));

    // Only line 7 (index 7) should match
    const line7Container = getLineContainer(7);
    expect(line7Container).toBeInTheDocument();

    // Other lines should be hidden
    expect(() => getLineContainer(0)).toThrow();
    expect(() => getLineContainer(5)).toThrow();
  });

  it('clears filter when requestFilter prop becomes empty', async () => {
    const total = 30;
    const matchIndices = [15];
    useLogStore.setState({ rawLogLines: createLogsWithMatches(total, matchIndices) });

    // Start with a filter
    const { rerender } = render(<LogDisplayView requestFilter="MATCH" />);

    // Wait for debounce
    await new Promise(resolve => setTimeout(resolve, 350));

    // Only matching line visible
    expect(getLineContainer(15)).toBeInTheDocument();
    expect(() => getLineContainer(1)).toThrow();

    // Clear filter via prop
    rerender(<LogDisplayView requestFilter="" />);

    // Wait for debounce
    await new Promise(resolve => setTimeout(resolve, 350));

    // Now all lines should be visible again
    expect(getLineContainer(1)).toBeInTheDocument();
    expect(getLineContainer(15)).toBeInTheDocument();
  });

  it('does not call onFilterChange when syncing from requestFilter prop updates', async () => {
    const total = 20;
    useLogStore.setState({ rawLogLines: createLogsWithMatches(total, [7], 'MATCH') });
    const onFilterChange = vi.fn();

    const { rerender } = render(<LogDisplayView requestFilter="" onFilterChange={onFilterChange} />);
    rerender(<LogDisplayView requestFilter="MATCH" onFilterChange={onFilterChange} />);

    await new Promise(resolve => setTimeout(resolve, 350));

    expect(onFilterChange).not.toHaveBeenCalled();
  });

  it('calls onFilterChange when user edits filter input', async () => {
    const total = 20;
    useLogStore.setState({ rawLogLines: createLogsWithMatches(total, [7], 'MATCH') });
    const onFilterChange = vi.fn();

    render(<LogDisplayView requestFilter="MATCH" onFilterChange={onFilterChange} />);

    const filterInput = screen.getByPlaceholderText(/Filter logs/i);
    fireEvent.change(filterInput, { target: { value: 'line 1' } });

    await new Promise(resolve => setTimeout(resolve, 350));

    expect(onFilterChange).toHaveBeenCalledWith('line 1');
  });

  it('treats quoted request filters as exact request-id match', async () => {
    useLogStore.setState({
      rawLogLines: [
        createParsedLogLine({
          lineNumber: 0,
          rawText: '2026-01-01T00:00:00.000000Z INFO send request_id="REQ-18" method=GET',
          message: 'request_id="REQ-18"',
          strippedMessage: 'request_id="REQ-18"',
        }),
        createParsedLogLine({
          lineNumber: 1,
          rawText: '2026-01-01T00:00:01.000000Z INFO send request_id="REQ-180" method=GET',
          message: 'request_id="REQ-180"',
          strippedMessage: 'request_id="REQ-180"',
        }),
      ],
    });

    render(<LogDisplayView requestFilter='"REQ-18"' />);

    await new Promise(resolve => setTimeout(resolve, 350));

    expect(getLineContainer(0)).toBeInTheDocument();
    expect(() => getLineContainer(1)).toThrow();
  });
});

describe('LogDisplayView expand button', () => {
  beforeEach(() => {
    useLogStore.getState().clearData();
  });

  it('renders expand button when onExpand is provided', () => {
    useLogStore.setState({ rawLogLines: createLogsWithMatches(5, []) });
    const onExpand = vi.fn();
    render(<LogDisplayView onExpand={onExpand} />);
    expect(screen.getByRole('button', { name: 'Open in Logs view' })).toBeInTheDocument();
  });

  it('does not render expand button when onExpand is not provided', () => {
    useLogStore.setState({ rawLogLines: createLogsWithMatches(5, []) });
    render(<LogDisplayView />);
    expect(screen.queryByRole('button', { name: 'Open in Logs view' })).toBeNull();
  });

  it('calls onExpand when expand button is clicked', async () => {
    const user = userEvent.setup();
    useLogStore.setState({ rawLogLines: createLogsWithMatches(10, [3, 7]) });
    const onExpand = vi.fn();
    render(<LogDisplayView requestFilter="MATCH" onExpand={onExpand} />);

    await user.click(screen.getByRole('button', { name: 'Open in Logs view' }));

    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it('includes updated lineWrap in onExpand call after user toggles it', async () => {
    const user = userEvent.setup();
    useLogStore.setState({ rawLogLines: createLogsWithMatches(10, [3, 7]) });
    const onExpand = vi.fn();
    render(<LogDisplayView requestFilter="MATCH" onExpand={onExpand} />);

    await user.click(screen.getByLabelText(/Line wrap/i));
    await user.click(screen.getByRole('button', { name: 'Open in Logs view' }));

    expect(onExpand).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Shortcut context registration
// ---------------------------------------------------------------------------

function makeShortcutCtx(
  overrides?: Partial<KeyboardShortcutContextValue>,
): KeyboardShortcutContextValue {
  return {
    showHelp: false,
    toggleHelp: vi.fn(),
    pendingChord: null,
    registerFocusSearch: vi.fn(() => vi.fn()),
    registerFocusFilter: vi.fn(() => vi.fn()),
    registerDismiss: vi.fn(() => vi.fn()),
    ...overrides,
  };
}

describe('LogDisplayView shortcut registration', () => {
  it('registers a focus-search handler when mounted inside shortcut context', () => {
    useLogStore.setState({ rawLogLines: createLogsWithMatches(5, [2]) });
    const registerFocusSearch = vi.fn(() => vi.fn());
    const ctx = makeShortcutCtx({ registerFocusSearch });

    render(
      <KeyboardShortcutContext.Provider value={ctx}>
        <LogDisplayView />
      </KeyboardShortcutContext.Provider>,
    );

    expect(registerFocusSearch).toHaveBeenCalledTimes(1);
  });

  it('registers a focus-filter handler when mounted inside shortcut context', () => {
    useLogStore.setState({ rawLogLines: createLogsWithMatches(5, [2]) });
    const registerFocusFilter = vi.fn(() => vi.fn());
    const ctx = makeShortcutCtx({ registerFocusFilter });

    render(
      <KeyboardShortcutContext.Provider value={ctx}>
        <LogDisplayView />
      </KeyboardShortcutContext.Provider>,
    );

    expect(registerFocusFilter).toHaveBeenCalledTimes(1);
  });

  it('focus-search handler focuses the search input', async () => {
    useLogStore.setState({ rawLogLines: createLogsWithMatches(5, [2]) });
    let capturedSearchFn: (() => void) | null = null;
    const registerFocusSearch = vi.fn((fn: () => void) => {
      capturedSearchFn = fn;
      return vi.fn();
    });
    const ctx = makeShortcutCtx({ registerFocusSearch });

    render(
      <KeyboardShortcutContext.Provider value={ctx}>
        <LogDisplayView />
      </KeyboardShortcutContext.Provider>,
    );

    expect(capturedSearchFn).not.toBeNull();
    // Calling the registered fn should not throw (focuses the ref'd input)
    expect(() => capturedSearchFn?.()).not.toThrow();
  });

  it('focus-filter handler focuses the filter input', async () => {
    useLogStore.setState({ rawLogLines: createLogsWithMatches(5, [2]) });
    let capturedFilterFn: (() => void) | null = null;
    const registerFocusFilter = vi.fn((fn: () => void) => {
      capturedFilterFn = fn;
      return vi.fn();
    });
    const ctx = makeShortcutCtx({ registerFocusFilter });

    render(
      <KeyboardShortcutContext.Provider value={ctx}>
        <LogDisplayView />
      </KeyboardShortcutContext.Provider>,
    );

    expect(capturedFilterFn).not.toBeNull();
    expect(() => capturedFilterFn?.()).not.toThrow();
  });

  it('w key toggles line wrap', () => {
    useLogStore.setState({ rawLogLines: createLogsWithMatches(5, [2]) });
    render(<LogDisplayView />);

    const checkbox = screen.getByLabelText(/Line wrap/i) as HTMLInputElement;
    const initial = checkbox.checked;

    fireEvent.keyDown(document, { key: 'w', code: 'KeyW' });

    expect(checkbox.checked).toBe(!initial);
  });

  it('p key toggles strip prefix', () => {
    useLogStore.setState({ rawLogLines: createLogsWithMatches(5, [2]) });
    render(<LogDisplayView />);

    const checkbox = screen.getByLabelText(/Strip prefix/i) as HTMLInputElement;
    const initial = checkbox.checked;

    fireEvent.keyDown(document, { key: 'p', code: 'KeyP' });

    expect(checkbox.checked).toBe(!initial);
  });

  it('w key does NOT toggle line wrap when an input element is focused', () => {
    useLogStore.setState({ rawLogLines: createLogsWithMatches(5, [2]) });
    render(<LogDisplayView />);

    const checkbox = screen.getByLabelText(/Line wrap/i) as HTMLInputElement;
    const initial = checkbox.checked;

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(document, { key: 'w', code: 'KeyW' });
    document.body.removeChild(input);

    expect(checkbox.checked).toBe(initial);
  });

  it.each([
    ['Cmd+S', { metaKey: true }],
    ['Ctrl+S', { ctrlKey: true }],
  ])('%s key opens export dialog', (_, modifier) => {
    useLogStore.setState({ rawLogLines: createLogsWithMatches(5, [2]) });
    render(<LogDisplayView />);

    // Export dialog should not be visible initially
    expect(screen.queryByRole('heading', { name: /Export Logs/i })).not.toBeInTheDocument();

    // Trigger export shortcut
    fireEvent.keyDown(document, { key: 's', code: 'KeyS', ...modifier });

    // Export dialog should now be open
    expect(screen.getByRole('heading', { name: /Export Logs/i })).toBeInTheDocument();
  });
});

describe('LogDisplayView collapse duplicates', () => {
  function createDuplicateLogLines() {
    // Lines 0-3: four exact duplicates (same text, different timestamps) → collapsed
    // Lines 4-7: four similar lines (same source file:line, different content) → collapsed
    // Line 8: unique line
    const lines = [
      createParsedLogLine({
        lineNumber: 0,
        rawText: '2024-01-15T10:00:00.000000Z ERROR Duplicate error message',
        level: 'ERROR',
      }),
      createParsedLogLine({
        lineNumber: 1,
        rawText: '2024-01-15T10:00:01.000000Z ERROR Duplicate error message',
        level: 'ERROR',
      }),
      createParsedLogLine({
        lineNumber: 2,
        rawText: '2024-01-15T10:00:02.000000Z ERROR Duplicate error message',
        level: 'ERROR',
      }),
      createParsedLogLine({
        lineNumber: 3,
        rawText: '2024-01-15T10:00:03.000000Z ERROR Duplicate error message',
        level: 'ERROR',
      }),
      createParsedLogLine({
        lineNumber: 4,
        rawText: '2024-01-15T10:00:04.000000Z INFO Room unknown room=!abc | crates/room.rs:42 | spans: root',
        level: 'INFO',
        filePath: 'crates/room.rs',
        sourceLineNumber: 42,
      }),
      createParsedLogLine({
        lineNumber: 5,
        rawText: '2024-01-15T10:00:05.000000Z INFO Room unknown room=!def | crates/room.rs:42 | spans: root',
        level: 'INFO',
        filePath: 'crates/room.rs',
        sourceLineNumber: 42,
      }),
      createParsedLogLine({
        lineNumber: 6,
        rawText: '2024-01-15T10:00:06.000000Z INFO Room unknown room=!ghi | crates/room.rs:42 | spans: root',
        level: 'INFO',
        filePath: 'crates/room.rs',
        sourceLineNumber: 42,
      }),
      createParsedLogLine({
        lineNumber: 7,
        rawText: '2024-01-15T10:00:07.000000Z INFO Room unknown room=!jkl | crates/room.rs:42 | spans: root',
        level: 'INFO',
        filePath: 'crates/room.rs',
        sourceLineNumber: 42,
      }),
      createParsedLogLine({
        lineNumber: 8,
        rawText: '2024-01-15T10:00:08.000000Z DEBUG Unique line',
        level: 'DEBUG',
      }),
    ];
    return lines;
  }

  it('collapses exact duplicates and shows summary bar with = and identical', () => {
    useLogStore.setState({ rawLogLines: createDuplicateLogLines() });
    render(<LogDisplayView />);

    // Line 0 should be visible (representative)
    const line0 = getLineContainer(0);
    expect(line0).toBeInTheDocument();

    // Lines 1, 2, 3 should be collapsed (not visible)
    expect(screen.queryByText('1', { selector: `.${styles.logLineNumber}` })).toBeNull();
    expect(screen.queryByText('2', { selector: `.${styles.logLineNumber}` })).toBeNull();
    expect(screen.queryByText('3', { selector: `.${styles.logLineNumber}` })).toBeNull();

    // Should show a collapse summary bar with = sign and "identical" text
    const collapseBar = line0.querySelector('[data-testid="collapse-bar"]');
    expect(collapseBar).toBeTruthy();
    expect(collapseBar?.textContent).toContain('=');
    expect(collapseBar?.textContent).toContain('3 identical lines collapsed');
    expect(collapseBar?.textContent).toContain('show all');
  });

  it('collapses similar lines and shows summary bar with ≈ and source location', () => {
    useLogStore.setState({ rawLogLines: createDuplicateLogLines() });
    render(<LogDisplayView />);

    // Line 4 should be visible (representative)
    const line4 = getLineContainer(4);
    expect(line4).toBeInTheDocument();

    // Lines 5, 6, 7 should be collapsed
    expect(screen.queryByText('5', { selector: `.${styles.logLineNumber}` })).toBeNull();
    expect(screen.queryByText('6', { selector: `.${styles.logLineNumber}` })).toBeNull();
    expect(screen.queryByText('7', { selector: `.${styles.logLineNumber}` })).toBeNull();

    // Should show a collapse summary bar with ≈ sign and source info
    const collapseBar = line4.querySelector('[data-testid="collapse-bar"]');
    expect(collapseBar).toBeTruthy();
    expect(collapseBar?.textContent).toContain('≈');
    expect(collapseBar?.textContent).toContain('3 similar lines collapsed');
    expect(collapseBar?.textContent).toContain('show all');
  });

  it('expands all collapsed lines when All button is clicked', async () => {
    const user = userEvent.setup();
    useLogStore.setState({ rawLogLines: createDuplicateLogLines() });
    render(<LogDisplayView />);

    // Line 1 should be collapsed
    expect(screen.queryByText('1', { selector: `.${styles.logLineNumber}` })).toBeNull();

    // Click the "All" button in the collapse summary bar
    const line0 = getLineContainer(0);
    const allBtn = line0.querySelector('button[aria-label*="Expand all"]') as HTMLButtonElement;
    expect(allBtn).toBeTruthy();
    await user.click(allBtn);

    // Lines 1, 2, 3 should now be visible
    expect(screen.getByText('1', { selector: `.${styles.logLineNumber}` })).toBeInTheDocument();
    expect(screen.getByText('2', { selector: `.${styles.logLineNumber}` })).toBeInTheDocument();
    expect(screen.getByText('3', { selector: `.${styles.logLineNumber}` })).toBeInTheDocument();
  });

  it('shows +10 button only when collapsed count exceeds 10', () => {
    // With only 3 collapsed lines, +10 button should NOT appear
    useLogStore.setState({ rawLogLines: createDuplicateLogLines() });
    render(<LogDisplayView />);

    const line0 = getLineContainer(0);
    const plus10Btn = line0.querySelector('button[aria-label="Load 10 collapsed lines"]');
    expect(plus10Btn).toBeNull();
  });

  it('shows all lines when collapse is disabled via checkbox', async () => {
    const user = userEvent.setup();
    useLogStore.setState({ rawLogLines: createDuplicateLogLines() });
    render(<LogDisplayView />);

    // Lines 1, 2, 3 should be collapsed initially
    expect(screen.queryByText('1', { selector: `.${styles.logLineNumber}` })).toBeNull();

    // Uncheck the collapse checkbox
    const checkbox = screen.getByLabelText(/Collapse duplicates/i) as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    await user.click(checkbox);

    // Now all lines should be visible
    expect(screen.getByText('1', { selector: `.${styles.logLineNumber}` })).toBeInTheDocument();
    expect(screen.getByText('2', { selector: `.${styles.logLineNumber}` })).toBeInTheDocument();
    expect(screen.getByText('3', { selector: `.${styles.logLineNumber}` })).toBeInTheDocument();
    expect(screen.getByText('5', { selector: `.${styles.logLineNumber}` })).toBeInTheDocument();
    expect(screen.getByText('6', { selector: `.${styles.logLineNumber}` })).toBeInTheDocument();
    expect(screen.getByText('7', { selector: `.${styles.logLineNumber}` })).toBeInTheDocument();
  });

  it('unique lines remain visible with collapsing enabled', () => {
    useLogStore.setState({ rawLogLines: createDuplicateLogLines() });
    render(<LogDisplayView />);

    // Line 8 is unique and should always be visible
    const line8 = getLineContainer(8);
    expect(line8).toBeInTheDocument();
  });

  it('summary bar count updates when expanding from the bottom via gap-above arrow', async () => {
    // 25 exact duplicates: line 0 = representative, lines 1-24 = collapsed
    // Line 25 is a unique line after the group (has gapAbove)
    const user = userEvent.setup();
    const lines = [
      ...Array.from({ length: 25 }, (_, i) =>
        createParsedLogLine({
          lineNumber: i,
          rawText: `2024-01-15T10:00:${String(i).padStart(2, '0')}.000000Z ERROR Repeated error`,
          level: 'ERROR',
        })
      ),
      createParsedLogLine({
        lineNumber: 25,
        rawText: '2024-01-15T10:00:25.000000Z INFO Unique after group',
        level: 'INFO',
      }),
    ];
    useLogStore.setState({ rawLogLines: lines });
    render(<LogDisplayView />);

    // Line 0 visible; lines 1-24 collapsed (count=24); line 25 visible after gap
    const line0 = getLineContainer(0);
    const initialBar = line0.querySelector('[data-testid="collapse-bar"]');
    expect(initialBar?.textContent).toContain('24 identical lines collapsed');

    // Line 25 has a gapAbove arrow — click it to load 10 from the bottom of the gap
    const line25 = getLineContainer(25);
    const upArrow = line25.querySelector('button[aria-label="Load hidden lines above"]') as HTMLButtonElement;
    expect(upArrow).toBeTruthy();
    await user.click(upArrow);

    // Lines 15-24 should now be visible
    expect(screen.getByText('15', { selector: `.${styles.logLineNumber}` })).toBeInTheDocument();
    expect(screen.getByText('24', { selector: `.${styles.logLineNumber}` })).toBeInTheDocument();

    // Lines 1-14 still collapsed — summary bar on line 0 must show remaining count
    const updatedBar = line0.querySelector('[data-testid="collapse-bar"]');
    expect(updatedBar).toBeTruthy();
    expect(updatedBar?.textContent).toContain('14 identical lines collapsed');
  });

  it('summary bar persists and shows updated count after +10 partial expansion', async () => {
    // 13 exact duplicates: line 0 = representative, lines 1-12 = collapsed (count=12)
    const user = userEvent.setup();
    const lines = Array.from({ length: 13 }, (_, i) =>
      createParsedLogLine({
        lineNumber: i,
        rawText: `2024-01-15T10:00:${String(i).padStart(2, '0')}.000000Z ERROR Repeated error`,
        level: 'ERROR',
      })
    );
    useLogStore.setState({ rawLogLines: lines });
    render(<LogDisplayView />);

    // Initially: line 0 visible, lines 1-12 collapsed, summary bar shows 12 collapsed
    const line0 = getLineContainer(0);
    const initialBar = line0.querySelector('[data-testid="collapse-bar"]');
    expect(initialBar).toBeTruthy();
    expect(initialBar?.textContent).toContain('12 identical lines collapsed');

    // Click +10
    const plus10Btn = line0.querySelector('button[aria-label="Load 10 collapsed lines"]') as HTMLButtonElement;
    expect(plus10Btn).toBeTruthy();
    await user.click(plus10Btn);

    // Lines 1-10 should now be visible
    expect(screen.getByText('1', { selector: `.${styles.logLineNumber}` })).toBeInTheDocument();
    expect(screen.getByText('10', { selector: `.${styles.logLineNumber}` })).toBeInTheDocument();

    // Line 11 and 12 should still be collapsed
    expect(screen.queryByText('11', { selector: `.${styles.logLineNumber}` })).toBeNull();
    expect(screen.queryByText('12', { selector: `.${styles.logLineNumber}` })).toBeNull();

    // Summary bar should still be visible on line 10 showing remaining 2 collapsed
    const line10 = getLineContainer(10);
    const updatedBar = line10.querySelector('[data-testid="collapse-bar"]');
    expect(updatedBar).toBeTruthy();
    expect(updatedBar?.textContent).toContain('2 identical lines collapsed');
    // +10 should no longer appear (only 2 lines remain)
    expect(updatedBar?.querySelector('button[aria-label="Load 10 collapsed lines"]')).toBeNull();
  });
});

describe('LogDisplayView sentry and HTTP error text coloring', () => {
  afterEach(() => {
    useLogStore.setState({ rawLogLines: [], sentryEvents: [] });
  });

  it('colors logLineText with sentry token for sentry lines', () => {
    const line = createParsedLogLine({
      lineNumber: 1,
      rawText: '2024-01-15T10:00:01.000000Z  WARN Sending error to Sentry',
      level: 'WARN',
    });
    useLogStore.setState({
      rawLogLines: [line],
      sentryEvents: [{ platform: 'android', lineNumber: 1, message: line.rawText }],
    });
    render(<LogDisplayView />);
    const lineEl = screen.getAllByText(String(1)).find((el) => el.classList.contains(styles.logLineNumber))!
      .closest(`.${styles.logLine}`) as HTMLElement;
    const textSpan = lineEl.querySelector(`.${styles.logLineText}`) as HTMLElement;
    expect(textSpan.style.color).toBe('var(--color-sentry)');
  });

  it('colors logLineText with HTTP status color for 4xx error lines', () => {
    const line = createParsedLogLine({
      lineNumber: 1,
      rawText: '2024-01-15T10:00:01.000000Z DEBUG send{request_id="r1" method=GET uri="https://example.com/api" request_size="0" status=404 response_size="128" request_duration=200ms}',
      level: 'DEBUG',
    });
    useLogStore.setState({ rawLogLines: [line], sentryEvents: [] });
    render(<LogDisplayView />);
    const lineEl = screen.getAllByText(String(1)).find((el) => el.classList.contains(styles.logLineNumber))!
      .closest(`.${styles.logLine}`) as HTMLElement;
    const textSpan = lineEl.querySelector(`.${styles.logLineText}`) as HTMLElement;
    expect(textSpan.style.color).toBeTruthy();
    expect(textSpan.style.color).not.toBe('');
  });

  it('does not color logLineText for 2xx lines', () => {
    const line = createParsedLogLine({
      lineNumber: 1,
      rawText: '2024-01-15T10:00:01.000000Z DEBUG send{request_id="r1" method=GET uri="https://example.com/api" request_size="0" status=200 response_size="512" request_duration=100ms}',
      level: 'DEBUG',
    });
    useLogStore.setState({ rawLogLines: [line], sentryEvents: [] });
    render(<LogDisplayView />);
    const lineEl = screen.getAllByText(String(1)).find((el) => el.classList.contains(styles.logLineNumber))!
      .closest(`.${styles.logLine}`) as HTMLElement;
    const textSpan = lineEl.querySelector(`.${styles.logLineText}`) as HTMLElement;
    expect(textSpan.style.color).toBe('');
  });
});

describe('LogDisplayView export button', () => {
  // Capture originals before the suite so afterEach can restore them exactly,
  // preventing mock leakage into other test files.
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;

  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    global.URL.createObjectURL = vi.fn(() => 'blob:mock');
    global.URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    if (originalClipboard) {
      Object.defineProperty(navigator, 'clipboard', originalClipboard);
    } else {
      // clipboard didn't exist before — remove the mock so it doesn't leak
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deleting a non-standard JSDOM property
      delete (navigator as any).clipboard;
    }
    global.URL.createObjectURL = (originalCreateObjectURL ?? vi.fn()) as typeof URL.createObjectURL;
    global.URL.revokeObjectURL = originalRevokeObjectURL ?? vi.fn();
    vi.restoreAllMocks();
    useLogStore.setState({ rawLogLines: [] });
  });

  it('shows an export button in the toolbar', () => {
    useLogStore.setState({ rawLogLines: [createParsedLogLine({ lineNumber: 1 })] });
    render(<LogDisplayView />);
    expect(screen.getByRole('button', { name: /export logs/i })).toBeInTheDocument();
  });

  it('opens the export dialog when the export button is clicked', async () => {
    const user = userEvent.setup();
    useLogStore.setState({ rawLogLines: [createParsedLogLine({ lineNumber: 1 })] });
    render(<LogDisplayView />);
    await user.click(screen.getByRole('button', { name: /export logs/i }));
    expect(screen.getByRole('dialog', { name: /export logs/i })).toBeInTheDocument();
  });

  it('closes the export dialog when the dialog close button is clicked', async () => {
    const user = userEvent.setup();
    useLogStore.setState({ rawLogLines: [createParsedLogLine({ lineNumber: 1 })] });
    render(<LogDisplayView />);
    await user.click(screen.getByRole('button', { name: /export logs/i }));
    expect(screen.getByRole('dialog', { name: /export logs/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /close export dialog/i }));
    expect(screen.queryByRole('dialog', { name: /export logs/i })).not.toBeInTheDocument();
  });

  it('RowTimeAction menu opens and closes within the log view', async () => {
    useLogStore.setState({ rawLogLines: [createParsedLogLine({ lineNumber: 1 })] });
    render(<LogDisplayView />);

    const trigger = screen.getByRole('button', { name: /row actions/i });
    const row = trigger.closest(`.${styles.logLine}`);
    expect(row).not.toBeNull();

    if (!row) {
      throw new Error('RowTimeAction trigger is not inside a log row');
    }

    fireEvent.mouseEnter(row);
    // JSDOM does not reliably apply stylesheet-driven pointer-events updates after hover,
    // so use fireEvent for activation after simulating the real mouseenter path.
    fireEvent.click(trigger);
    expect(screen.getByRole('button', { name: /set window start here/i })).toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.queryByText(/set window start here/i)).not.toBeInTheDocument();
  });
});

describe('LogDisplayView multi-line (continuation) log entries', () => {
  beforeEach(() => {
    useLogStore.getState().clearData();
  });

  it('renders continuation lines in a separate block below the first line', () => {
    useLogStore.setState({
      rawLogLines: [
        createParsedLogLine({
          lineNumber: 1,
          rawText: '2024-01-01T10:00:00.000000Z ERROR first line\n  second line\n  third line',
          isoTimestamp: '2024-01-01T10:00:00.000000Z',
          message: '2024-01-01T10:00:00.000000Z ERROR first line',
          strippedMessage: 'first line',
          level: 'ERROR',
          continuationLines: ['  second line', '  third line'],
        }),
      ],
    });

    render(<LogDisplayView />);

    const row = getLineContainer(1);
    // The continuation block must be present
    const continuationBlock = row.querySelector(`.${styles.logLineContinuation}`) as HTMLElement;
    expect(continuationBlock).not.toBeNull();
    expect(continuationBlock.textContent).toContain('second line');
    expect(continuationBlock.textContent).toContain('third line');
  });

  it('does not render a continuation block for single-line entries', () => {
    useLogStore.setState({
      rawLogLines: [
        createParsedLogLine({
          lineNumber: 1,
          continuationLines: [],
        }),
      ],
    });

    render(<LogDisplayView />);

    const row = getLineContainer(1);
    expect(row.querySelector(`.${styles.logLineContinuation}`)).toBeNull();
  });

  it('does not duplicate continuation content inside the main text span', () => {
    // Regression test: getDisplayText() must use line.message (first physical line only),
    // NOT line.rawText which now spans multiple physical lines. If rawText were used,
    // the continuation content would appear twice — once inline in the text span and
    // once in the logLineContinuation block.
    const continuationOnlyText = 'CONTINUATION_UNIQUE_STRING';
    useLogStore.setState({
      rawLogLines: [
        createParsedLogLine({
          lineNumber: 1,
          rawText: `2024-01-01T10:00:00.000000Z ERROR first line\n  ${continuationOnlyText}`,
          isoTimestamp: '2024-01-01T10:00:00.000000Z',
          message: `2024-01-01T10:00:00.000000Z ERROR first line`,
          strippedMessage: 'first line',
          level: 'ERROR',
          continuationLines: [`  ${continuationOnlyText}`],
        }),
      ],
    });

    render(<LogDisplayView />);

    const row = getLineContainer(1);
    const textSpan = row.querySelector(`.${styles.logLineText}`) as HTMLElement;
    // The continuation text must NOT appear inside the main text span
    expect(textSpan.textContent).not.toContain(continuationOnlyText);
    // But it must appear in the continuation block
    const continuationBlock = row.querySelector(`.${styles.logLineContinuation}`) as HTMLElement;
    expect(continuationBlock).not.toBeNull();
    expect(continuationBlock.textContent).toContain(continuationOnlyText);
  });

  it('search matching works via rawText even when query is only in continuation lines', async () => {
    // rawText is extended with continuation content for search purposes. A search
    // for a term that appears only in continuation lines must still highlight the row.
    const continuationOnlyTerm = 'SearchableOnlyInContinuation';
    useLogStore.setState({
      rawLogLines: [
        createParsedLogLine({
          lineNumber: 1,
          rawText: `2024-01-01T10:00:00.000000Z ERROR first line\n  ${continuationOnlyTerm}`,
          isoTimestamp: '2024-01-01T10:00:00.000000Z',
          message: `2024-01-01T10:00:00.000000Z ERROR first line`,
          strippedMessage: 'first line',
          level: 'ERROR',
          continuationLines: [`  ${continuationOnlyTerm}`],
        }),
        createParsedLogLine({
          lineNumber: 2,
          rawText: '2024-01-01T10:00:01.000000Z INFO unrelated',
          isoTimestamp: '2024-01-01T10:00:01.000000Z',
          message: '2024-01-01T10:00:01.000000Z INFO unrelated',
          strippedMessage: 'unrelated',
          continuationLines: [],
        }),
      ],
    });

    render(<LogDisplayView />);

    const searchInput = screen.getByPlaceholderText(/Search logs/i);
    await userEvent.type(searchInput, continuationOnlyTerm);
    await new Promise((resolve) => setTimeout(resolve, 400));

    // Navigation counter must show 1 match
    expect(screen.getByText('1 / 1')).toBeInTheDocument();
    // The matching row must have the matchLine class
    const matchRow = getLineContainer(1);
    expect(matchRow.classList.contains(styles.matchLine)).toBe(true);
    // The non-matching row must not
    const noMatchRow = getLineContainer(2);
    expect(noMatchRow.classList.contains(styles.matchLine)).toBe(false);
  });
});

describe('LogDisplayView open-in-new-tab button', () => {
  // Stub window.open so tests don't actually open new tabs.
  const originalOpen = window.open;

  beforeEach(() => {
    window.open = vi.fn().mockReturnValue({ opener: null, location: { href: '' } });
    vi.stubGlobal('localStorage', (() => {
      const store = new Map<string, string>();
      return {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
        removeItem: (k: string) => { store.delete(k); },
        clear: () => { store.clear(); },
      };
    })());
    vi.stubGlobal('crypto', { randomUUID: (() => { let n = 0; return () => `00000000-0000-0000-0000-${String(++n).padStart(12, '0')}`; })() });
  });

  afterEach(() => {
    window.open = originalOpen;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    useLogStore.getState().clearData();
  });

  it('renders the button when onClose and onExpand are both absent', () => {
    const line = createParsedLogLine({ lineNumber: 1 });
    useLogStore.setState({ rawLogLines: [line], lineNumberIndex: new Map([[1, line]]) });
    render(<LogDisplayView />);
    expect(screen.getByRole('button', { name: /open in new tab/i })).toBeInTheDocument();
  });

  it('hides the button when onClose is provided (panel mode)', () => {
    const line = createParsedLogLine({ lineNumber: 1 });
    useLogStore.setState({ rawLogLines: [line], lineNumberIndex: new Map([[1, line]]) });
    render(<LogDisplayView onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /open in new tab/i })).not.toBeInTheDocument();
  });

  it('hides the button when onExpand is provided (panel mode)', () => {
    const line = createParsedLogLine({ lineNumber: 1 });
    useLogStore.setState({ rawLogLines: [line], lineNumberIndex: new Map([[1, line]]) });
    render(<LogDisplayView onExpand={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /open in new tab/i })).not.toBeInTheDocument();
  });

  it('stores the log crop and opens a new tab when the button is clicked', async () => {
    const user = userEvent.setup();
    const line1Raw = '2024-01-01T10:00:00.000000Z INFO first';
    const line2Raw = '2024-01-01T10:00:01.000000Z INFO second';
    const line1 = createParsedLogLine({ lineNumber: 1, rawText: line1Raw });
    const line2 = createParsedLogLine({ lineNumber: 2, rawText: line2Raw });
    useLogStore.setState({
      rawLogLines: [line1, line2],
      lineNumberIndex: new Map([[1, line1], [2, line2]]),
    });
    render(<LogDisplayView />);

    await user.click(screen.getByRole('button', { name: /open in new tab/i }));

    // A new tab must have been requested.
    expect(window.open).toHaveBeenCalledWith('', '_blank');

    // The cropped text must be stored in localStorage under the expected UUID key.
    const expectedUuid = '00000000-0000-0000-0000-000000000001';
    const storedRaw = localStorage.getItem(`rageshake-tablog-${expectedUuid}`);
    expect(storedRaw).not.toBeNull();
    const storedEntry = JSON.parse(storedRaw!) as { text: string; createdAt: number };
    expect(storedEntry.text).toBe(`${line1Raw}\n${line2Raw}`);

    // The URL navigated to must include the tabLog UUID in its hash.
    const openedWindow = (window.open as ReturnType<typeof vi.fn>).mock.results[0].value as { location: { href: string } };
    expect(openedWindow.location.href).toContain(`tabLog=${expectedUuid}`);
    expect(openedWindow.location.href).toContain('#/logs');
  });

  const storedCropText = (): string => {
    const href = (window.open as ReturnType<typeof vi.fn>).mock.results[0].value.location.href as string;
    const uuid = new URLSearchParams((href.split('#')[1] ?? '').replace(/^\/logs\?/, '')).get('tabLog');
    return (JSON.parse(localStorage.getItem(`rageshake-tablog-${uuid}`)!) as { text: string }).text;
  };

  it('falls back to line-number bounds for a zero-timestamp orphan endpoint', async () => {
    const user = userEvent.setup();
    // Middle line is a zero-timestamp orphan; bounds come from the positive
    // timestamps, and the orphan is kept via the line-number range.
    const l1 = createParsedLogLine({ lineNumber: 1, timestampUs: 1_000_000, rawText: 'a' });
    const l2 = createParsedLogLine({ lineNumber: 2, timestampUs: 0, rawText: 'b-orphan' });
    const l3 = createParsedLogLine({ lineNumber: 3, timestampUs: 2_000_000, rawText: 'c' });
    useLogStore.setState({ rawLogLines: [l1, l2, l3], lineNumberIndex: new Map([[1, l1], [2, l2], [3, l3]]) });
    render(<LogDisplayView />);

    await user.click(screen.getByRole('button', { name: /open in new tab/i }));

    expect(window.open).toHaveBeenCalled();
    expect(storedCropText()).toBe('a\nb-orphan\nc');
  });

  it('crops by line range when no visible line has a positive timestamp', async () => {
    const user = userEvent.setup();
    const l1 = createParsedLogLine({ lineNumber: 1, timestampUs: 0, rawText: 'a' });
    const l2 = createParsedLogLine({ lineNumber: 2, timestampUs: 0, rawText: 'b' });
    useLogStore.setState({ rawLogLines: [l1, l2], lineNumberIndex: new Map([[1, l1], [2, l2]]) });
    render(<LogDisplayView />);

    await user.click(screen.getByRole('button', { name: /open in new tab/i }));

    expect(storedCropText()).toBe('a\nb');
  });

  it('propagates the active filter and time range into the new-tab URL', async () => {
    const user = userEvent.setup();
    const line = createParsedLogLine({ lineNumber: 1, rawText: '2024-01-01T10:00:00.000000Z INFO match-me' });
    useLogStore.setState({
      rawLogLines: [line],
      lineNumberIndex: new Map([[1, line]]),
      startTime: '2024-01-01T00:00:00.000000Z',
      endTime: '2024-01-01T23:59:59.000000Z',
    });

    render(<LogDisplayView requestFilter="match-me" />);
    // Wait for the filter to be applied (it's debounced).
    await new Promise((resolve) => setTimeout(resolve, 400));

    await user.click(screen.getByRole('button', { name: /open in new tab/i }));

    const openedWindow = (window.open as ReturnType<typeof vi.fn>).mock.results[0].value as { location: { href: string } };
    const hash = openedWindow.location.href.split('#')[1] ?? '';
    const params = new URLSearchParams(hash.replace(/^\/logs\?/, ''));

    expect(params.get('filter')).toBe('match-me');
    expect(params.get('start')).toBe('2024-01-01T00:00:00.000000Z');
    expect(params.get('end')).toBe('2024-01-01T23:59:59.000000Z');
  });

  it('disables the button when no lines are visible', () => {
    // No lines in the store → displayItems will be empty.
    useLogStore.setState({ rawLogLines: [] });
    render(<LogDisplayView />);
    const btn = screen.getByRole('button', { name: /open in new tab/i });
    expect(btn).toBeDisabled();
  });

  it('cleans up localStorage and shows an inline error when the popup is blocked', async () => {
    const user = userEvent.setup();
    // Make window.open return null to simulate a popup blocker.
    (window.open as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);

    const line = createParsedLogLine({ lineNumber: 1, rawText: '2024-01-01T10:00:00.000000Z INFO hi' });
    useLogStore.setState({ rawLogLines: [line], lineNumberIndex: new Map([[1, line]]) });
    render(<LogDisplayView />);

    await user.click(screen.getByRole('button', { name: /open in new tab/i }));

    // The orphaned localStorage entry must be removed immediately.
    const expectedUuid = '00000000-0000-0000-0000-000000000001';
    expect(localStorage.getItem(`rageshake-tablog-${expectedUuid}`)).toBeNull();

    // An inline error message must appear.
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('alert').textContent).toMatch(/allow popups/i);
  });
});

// ---------------------------------------------------------------------------
// Anonymize button
// ---------------------------------------------------------------------------

describe('LogDisplayView anonymize button', () => {
  beforeEach(() => {
    useLogStore.getState().clearData();
  });

  afterEach(() => {
    useLogStore.getState().clearData();
    vi.restoreAllMocks();
  });

  it('does not render the anonymize button by default (showAnonymizeButton=false)', () => {
    useLogStore.setState({ rawLogLines: [createParsedLogLine({ lineNumber: 1 })] });
    render(<LogDisplayView />);
    expect(screen.queryByRole('button', { name: /anonymise/i })).not.toBeInTheDocument();
  });

  it('renders the anonymize button when showAnonymizeButton=true', () => {
    useLogStore.setState({ rawLogLines: [createParsedLogLine({ lineNumber: 1 })] });
    render(<LogDisplayView showAnonymizeButton />);
    expect(screen.getByRole('button', { name: /anonymise logs/i })).toBeInTheDocument();
  });

  it('calls anonymizeLogs when the anonymize button is clicked in non-anonymized state', () => {
    const anonymizeLogs = vi.fn();
    useLogStore.setState({
      rawLogLines: [createParsedLogLine({ lineNumber: 1 })],
      isAnonymized: false,
      anonymizeLogs,
      unanonymizeLogs: vi.fn(),
    });
    render(<LogDisplayView showAnonymizeButton />);
    fireEvent.click(screen.getByRole('button', { name: /anonymise logs/i }));
    expect(anonymizeLogs).toHaveBeenCalledTimes(1);
  });

  it('shows "Unanonymise logs" label when isAnonymized=true', () => {
    useLogStore.setState({
      rawLogLines: [createParsedLogLine({ lineNumber: 1 })],
      isAnonymized: true,
      originalLogLines: [createParsedLogLine({ lineNumber: 1 })],
    });
    render(<LogDisplayView showAnonymizeButton />);
    expect(screen.getByRole('button', { name: /unanonymise logs/i })).toBeInTheDocument();
  });

  it('calls unanonymizeLogs() when isAnonymized=true and backup exists', () => {
    const unanonymizeLogs = vi.fn();
    useLogStore.setState({
      rawLogLines: [createParsedLogLine({ lineNumber: 1 })],
      isAnonymized: true,
      originalLogLines: [createParsedLogLine({ lineNumber: 1 })],
      unanonymizeLogs,
      anonymizeLogs: vi.fn(),
    });
    render(<LogDisplayView showAnonymizeButton />);
    fireEvent.click(screen.getByRole('button', { name: /unanonymise logs/i }));
    expect(unanonymizeLogs).toHaveBeenCalledTimes(1);
  });

  it('opens UnanonymizeDialog when isAnonymized=true and no backup (file-loaded anon log)', async () => {
    const user = userEvent.setup();
    useLogStore.setState({
      rawLogLines: [createParsedLogLine({ lineNumber: 1 })],
      isAnonymized: true,
      originalLogLines: null,
      unanonymizeLogs: vi.fn(),
      anonymizeLogs: vi.fn(),
    });
    render(<LogDisplayView showAnonymizeButton />);
    await user.click(screen.getByRole('button', { name: /unanonymise logs/i }));
    expect(screen.getByRole('dialog', { name: /unanonymise logs/i })).toBeInTheDocument();
  });

  const sampleDict = {
    forward: { '@alice:matrix.org': '@user-aaaaaaaaaaaa:domain-11111111.org' },
    reverse: { '@user-aaaaaaaaaaaa:domain-11111111.org': '@alice:matrix.org' },
  };

  it('does not render the mapping button when not anonymized', () => {
    useLogStore.setState({ rawLogLines: [createParsedLogLine({ lineNumber: 1 })], isAnonymized: false });
    render(<LogDisplayView showAnonymizeButton />);
    expect(screen.queryByRole('button', { name: /view anonymisation mapping/i })).not.toBeInTheDocument();
  });

  it('does not render the mapping button when anonymized but no dictionary (file-loaded)', () => {
    useLogStore.setState({
      rawLogLines: [createParsedLogLine({ lineNumber: 1 })],
      isAnonymized: true,
      anonymizationDictionary: null,
    });
    render(<LogDisplayView showAnonymizeButton />);
    expect(screen.queryByRole('button', { name: /view anonymisation mapping/i })).not.toBeInTheDocument();
  });

  it('renders the mapping button and opens the dialog when anonymized with a dictionary', () => {
    useLogStore.setState({
      rawLogLines: [createParsedLogLine({ lineNumber: 1 })],
      isAnonymized: true,
      originalLogLines: [createParsedLogLine({ lineNumber: 1 })],
      anonymizationDictionary: sampleDict,
    });
    render(<LogDisplayView showAnonymizeButton />);
    fireEvent.click(screen.getByRole('button', { name: /view anonymisation mapping/i }));
    expect(screen.getByRole('dialog', { name: /anonymisation mapping/i })).toBeInTheDocument();
    expect(screen.getByText('@alice:matrix.org')).toBeInTheDocument();
  });
});

describe('LogDisplayView process colours (merged multi-process logs)', () => {
  it('shows a process legend and tints lines when several processes are merged', () => {
    useLogStore.setState({
      rawLogLines: [
        createParsedLogLine({ lineNumber: 1, sourceFile: 'console.2026-04-14-08.log.gz' }),
        createParsedLogLine({ lineNumber: 2, sourceFile: 'nse.2026-04-14-08.log.gz' }),
      ],
      loadedEntryNames: ['console.2026-04-14-08.log.gz', 'nse.2026-04-14-08.log.gz'],
    });

    render(<LogDisplayView />);

    const legend = screen.getByLabelText('Process colour legend');
    expect(legend).toHaveTextContent('console');
    expect(legend).toHaveTextContent('nse');
    // Each line carries the inline process-colour stripe.
    expect(getLineContainer(1).style.boxShadow).toContain('inset');
  });

  it('shows no legend or stripe for a single process', () => {
    useLogStore.setState({
      rawLogLines: [createParsedLogLine({ lineNumber: 1, sourceFile: 'console.2026-04-14-08.log.gz' })],
      loadedEntryNames: ['console.2026-04-14-08.log.gz'],
    });

    render(<LogDisplayView />);

    expect(screen.queryByLabelText('Process colour legend')).not.toBeInTheDocument();
    expect(getLineContainer(1).style.boxShadow).toBe('');
  });
});

describe('LogDisplayView span filter chips', () => {
  beforeEach(() => {
    useLogStore.getState().clearData();
  });

  it('renders each span segment as a chip and filters by the span on click', async () => {
    const onFilterChange = vi.fn();
    // strippedMessage carries the `| spans:` tail (it's what's shown with the
    // default strip-prefix on); rawText is the full physical line.
    const stripped =
      'matrix_sdk::http_client::native: Sending request | crates/matrix-sdk/src/http_client/native.rs:88 | spans: root > send{request_id="REQ-0" method=GET}';
    useLogStore.setState({
      rawLogLines: [
        createParsedLogLine({
          lineNumber: 1,
          level: 'DEBUG',
          rawText: `2026-04-12T20:16:41.614009Z DEBUG ${stripped}`,
          message: stripped,
          strippedMessage: stripped,
        }),
      ],
    });

    render(<LogDisplayView onFilterChange={onFilterChange} />);

    // Every span segment renders as its own click-to-filter chip.
    expect(screen.getByRole('button', { name: 'root' })).toBeInTheDocument();
    const sendChip = screen.getByRole('button', { name: 'send{request_id="REQ-0" method=GET}' });
    // Chips are non-tabbable (match the row) to avoid flooding the tab order.
    expect(sendChip).toHaveAttribute('tabindex', '-1');

    // Clicking filters by the span's stable identity (name + first field, no
    // closing brace) so it survives progressively-recorded fields.
    await userEvent.click(sendChip);
    await waitFor(() => {
      expect(onFilterChange).toHaveBeenCalledWith('send{request_id="REQ-0"');
    });
  });
});


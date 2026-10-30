import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach, onTestFinished } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DecryptionView } from '../DecryptionView';
import { useCryptoStore } from '../../stores/cryptoStore';
import { useArchiveStore } from '../../stores/archiveStore';
import { useLogStore } from '../../stores/logStore';
import { deviceFromEntries } from '../../utils/crypto/loadDevice';
import { RECEIVER_DETAILS, RECEIVER_LATE_LINES, RECEIVER_LOG, SENDER_DETAILS, SENDER_LOG, entry } from '../../utils/crypto/__tests__/fixtures';
import { ALICE, BOB_PHONE, dev, st, utd } from '../../utils/crypto/__tests__/helpers';
import { parseLogFile } from '../../utils/logParser';
import { openMergedEntries } from '../../utils/openMergedLogs';

vi.mock('../../components/BurgerMenu', () => ({ BurgerMenu: () => <div data-testid="burger-menu" /> }));
vi.mock('../../components/TimeRangeSelector', () => ({ TimeRangeSelector: () => <div data-testid="time-range-selector" /> }));
vi.mock('../../utils/openMergedLogs', () => ({ openMergedEntries: vi.fn(async () => '/logs') }));
/** The lines the last rendered panel was given. */
let panelLines: unknown;
vi.mock('../LogDisplayView', () => ({
  LogDisplayView: (p: { logLines: { lineNumber: number; message: string }[]; highlightLines?: { start: number }; requestFilter?: string; onExpand?: () => void; onClose?: () => void }) => (
    <div data-testid="log-panel" data-filter={p.requestFilter} ref={() => { panelLines = p.logLines; }}>
      {p.logLines.find((l) => l.lineNumber === p.highlightLines?.start)?.message}
      {p.onExpand && <button type="button" onClick={p.onExpand}>Expand</button>}
      <button type="button" onClick={p.onClose}>Close panel</button>
    </div>
  ),
}));
// Every session row rendered: jsdom has no layout to virtualize against.
const mockScrollToIndex = vi.fn();
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number; getItemKey: (i: number) => string }) => ({
    getTotalSize: () => opts.count * 44,
    getVirtualItems: () => Array.from({ length: opts.count }, (_, i) => ({ index: i, key: opts.getItemKey(i), start: i * 44, size: 44, end: (i + 1) * 44 })),
    measureElement: () => {},
    scrollToIndex: mockScrollToIndex,
  }),
}));
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

/** Bob's archive open, its log loaded: the main device. */
function loadBob(text = RECEIVER_LOG) {
  useArchiveStore.getState().loadArchive('bob.tar.gz', [entry('details.json', RECEIVER_DETAILS), entry('logs.log', text)]);
  useLogStore.getState().loadMergedLogParserResults([{ name: 'logs.log', result: parseLogFile(text) }]);
}

/** Alice's rageshake added on /decryption for Bob's case. */
async function addAlice() {
  const alice = await deviceFromEntries('alice.tar.gz', [entry('details.json', SENDER_DETAILS), entry('logs.log', SENDER_LOG)]);
  useCryptoStore.setState({ devices: [alice], caseKey: 'bob.tar.gz' });
}

/** Seconds since the first RECEIVER_LOG line, for helper-built steps inside its time range. */
const T0 = Date.UTC(2026, 8, 8, 6, 55, 10) / 1000;

/** Bob's log plus devices with one session per outcome: S (UTD), S9 (late key), OK (key received). */
function loadMixed() {
  loadBob();
  useCryptoStore.setState({
    caseKey: 'bob.tar.gz',
    devices: [
      dev('alice', ALICE, [
        st('alice', 'share.encrypt', T0 + 1, { sessionId: 'S', recipients: [['@bob:b.org', 'BOBX']] }),
        st('alice', 'todevice.batch', T0 + 2, { sessionId: 'S', requestId: 'req1', messages: [{ messageId: 'm1', userId: '@bob:b.org', deviceId: 'BOBX' }] }),
      ]),
      dev('bobx', { ...BOB_PHONE, deviceId: 'BOBX' }, [
        st('bobx', 'todevice.received', T0 + 7, { messageId: 'm1' }),
        st('bobx', 'olm.decrypt_failed', T0 + 8, { senderKey: 'ALICEKEY' }),
        utd('bobx', T0 + 100),
        utd('bobx', T0 + 110, '$ev9', { sessionId: 'S9' }),
        st('bobx', 'roomkey.received', T0 + 120, { sessionId: 'S9', toDeviceType: 'm.room_key' }),
        st('bobx', 'roomkey.received', T0 + 5, { sessionId: 'OK', toDeviceType: 'm.room_key' }),
      ]),
    ],
  });
}

const renderView = (url = '/decryption') => render(<MemoryRouter initialEntries={[url]}><DecryptionView /></MemoryRouter>);

describe('DecryptionView', () => {
  beforeEach(() => {
    useCryptoStore.getState().clear();
    useArchiveStore.getState().clearArchive();
    useLogStore.getState().clearData();
    mockNavigate.mockReset();
    vi.mocked(openMergedEntries).mockClear();
  });

  it('has the standard header with the time selector', () => {
    loadBob();
    renderView();
    expect(screen.getByTestId('burger-menu')).toBeInTheDocument();
    expect(screen.getByTestId('time-range-selector')).toBeInTheDocument();
  });

  it('says how the sender was found', async () => {
    loadBob();
    await addAlice();
    renderView();
    expect(screen.getAllByTestId('device-header')[0]).toHaveTextContent('identified by its key share');
  });

  it('an unidentified sender can be set to an added rageshake, and undone', () => {
    loadBob();
    useCryptoStore.setState({ devices: [dev('carol.tar.gz', { userId: '@carol:c.org', deviceId: 'C1' }, [])], caseKey: 'bob.tar.gz' });
    renderView();
    const sender = () => screen.getAllByTestId('device-header')[0];
    fireEvent.click(within(sender()).getByRole('button', { name: 'Set @carol:c.org · C1 as sender' }));
    expect(useCryptoStore.getState().senderOverrides).toEqual({ SESS: 'carol.tar.gz' });
    expect(sender()).toHaveTextContent('@carol:c.org · C1');
    expect(sender()).toHaveTextContent('set by you');
    fireEvent.click(within(sender()).getByRole('button', { name: 'Undo' }));
    expect(useCryptoStore.getState().senderOverrides).toEqual({});
    expect(within(sender()).getByRole('button', { name: 'Set @carol:c.org · C1 as sender' })).toHaveClass('btn-secondary');
  });

  it('shows the loaded logs as the main device next to an added sender', async () => {
    loadBob();
    await addAlice();
    renderView();
    expect(screen.getByRole('button', { name: /^Session SESS:/ })).toBeInTheDocument();
    const headers = screen.getAllByTestId('device-header').map((h) => h.textContent);
    expect(headers[0]).toContain('@alice:a.org');
    expect(headers[0]).toContain('Sender');
    expect(headers[1]).toContain('BOBPHONE');
    expect(headers).toHaveLength(2);
    fireEvent.click(within(screen.getAllByTestId('device-header')[0]).getByRole('button', { name: /^Shared with 1 user · \d+ devices?$/ }));
    expect(within(screen.getByRole('dialog', { name: 'Key share recipients' })).getByText('@bob:b.org')).toBeInTheDocument();
    expect(screen.getByText('Likely this device was left out of the key share', { exact: false })).toBeInTheDocument();
    expect(screen.getByText(/not in the recipients of 1 share/)).toBeInTheDocument();
  });

  it('ignores a stale archive the loaded logs do not come from', async () => {
    useArchiveStore.getState().loadArchive('bob.tar.gz', [entry('details.json', RECEIVER_DETAILS), entry('logs.log', RECEIVER_LOG)]);
    useLogStore.getState().loadMergedLogParserResults([{ name: 'carol.log', result: parseLogFile(RECEIVER_LOG) }]);
    useCryptoStore.setState({ devices: [dev('alice.tar.gz', ALICE, [])], caseKey: 'bob.tar.gz' });
    renderView();
    expect(screen.getAllByTestId('device-header')[1]).toHaveTextContent('carol.log');
    await waitFor(() => expect(useCryptoStore.getState().caseKey).toBe('carol.log'));
    expect(useCryptoStore.getState().devices).toEqual([]);
  });

  it('visiting the sender archive from a step link keeps the case: the receiver joins as a device', async () => {
    const bobEntries = [entry('details.json', RECEIVER_DETAILS), entry('logs.log', RECEIVER_LOG)];
    const alice = await deviceFromEntries('alice.tar.gz', [entry('details.json', SENDER_DETAILS), entry('logs.log', SENDER_LOG)]);
    useCryptoStore.setState({ devices: [alice], caseKey: 'bob.tar.gz', caseArchive: { name: 'bob.tar.gz', entries: bobEntries } });
    // openStep re-opened Alice's archive: her log is now the loaded logs.
    useArchiveStore.getState().loadArchive('alice.tar.gz', alice.entries);
    useLogStore.getState().loadMergedLogParserResults([{ name: 'logs.log', result: parseLogFile(SENDER_LOG) }]);
    // Alice's log ends before Bob's UTD: widen the window to include it.
    useLogStore.setState({ startTime: '2026-09-08T06:55:00.000Z', endTime: '2026-09-08T06:59:00.000Z' });
    renderView();
    await waitFor(() => expect(useCryptoStore.getState().devices.map((d) => d.id)).toEqual(['alice.tar.gz', 'bob.tar.gz']));
    expect(useCryptoStore.getState().caseKey).toBe('bob.tar.gz');
    await waitFor(() => expect(screen.getAllByTestId('device-header').map((h) => h.textContent).join()).toContain('BOBPHONE'));
  });

  it('drops added devices of another case', async () => {
    useCryptoStore.setState({ devices: [dev('alice.tar.gz', ALICE, [])], caseKey: 'old.tar.gz' });
    loadBob();
    renderView();
    await waitFor(() => expect(useCryptoStore.getState().devices).toEqual([]));
    expect(useCryptoStore.getState().caseKey).toBe('bob.tar.gz');
  });

  it('keeps added devices of the same case', async () => {
    loadBob();
    await addAlice();
    renderView();
    await new Promise((r) => setTimeout(r, 20));
    expect(useCryptoStore.getState().devices.map((d) => d.id)).toEqual(['alice.tar.gz']);
  });

  it('lists only the UTDs of the selected time window, resolving with keys after it', () => {
    loadBob(`${RECEIVER_LOG}\n${RECEIVER_LATE_LINES}`);
    useLogStore.setState({ startTime: '2026-09-08T06:58:50.000Z', endTime: '2026-09-08T06:59:10.000Z' });
    renderView();
    expect(screen.queryByRole('button', { name: /^Session SESS:/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^Session SESS2: late_key/ })).toBeInTheDocument();
  });

  it('says so when the window has no UTD', () => {
    loadBob();
    useLogStore.setState({ startTime: '2026-09-08T06:57:00.000Z', endTime: '2026-09-08T06:58:00.000Z' });
    renderView();
    expect(screen.getByText(/No megolm sessions match in the loaded logs for this time range/)).toBeInTheDocument();
  });

  it('a main-device step opens its line in the bottom panel; expand goes to /logs', () => {
    loadBob();
    renderView();
    fireEvent.click(screen.getByText(/UTD \$ev1/));
    expect(screen.getByTestId('log-panel')).toHaveTextContent('Failed to decrypt a room event');
    expect(mockNavigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
    expect(mockNavigate).toHaveBeenCalledWith('/logs?line=2');
  });

  it('a journey line on the sender opens in the panel, keeping the loaded logs central', async () => {
    loadBob();
    await addAlice();
    renderView();
    fireEvent.keyDown(screen.getByRole('button', { name: /This device in the share/ }), { key: ' ' });
    expect(screen.getByTestId('log-panel')).toHaveTextContent('Trying to encrypt a room key');
    expect(screen.getByText('@alice:a.org · ALICEPHONE · logs.log:1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Expand' })).toBeNull();
    expect(useArchiveStore.getState().archiveName).toBe('bob.tar.gz');
    expect(openMergedEntries).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close panel' }));
    expect(screen.queryByTestId('log-panel')).toBeNull();
  });

  it('links a resolved UTD to the key step that resolved it', async () => {
    loadBob(RECEIVER_LATE_LINES);
    renderView();
    fireEvent.click(screen.getByRole('button', { name: /key step/ }));
    expect(screen.getByTestId('log-panel')).toHaveTextContent('Received a new megolm room key');
  });

  it('adds the other demo log as the sender rageshake of a demo', async () => {
    const demo = (name: string) => readFileSync(`public/demo/${name}`, 'utf8');
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url) => new Response(demo(String(url).split('/').pop()!)));
    onTestFinished(() => fetchSpy.mockRestore());
    useLogStore.getState().loadMergedLogParserResults([{ name: 'demo.log', result: parseLogFile(demo('demo.log')) }]);
    useCryptoStore.setState({ caseKey: 'demo.log' });
    renderView();
    fireEvent.click(screen.getByRole('button', { name: 'Add sender rageshake' }));
    await waitFor(() => expect(useCryptoStore.getState().devices.map((d) => d.id)).toEqual(['demo-web.log']));
    expect(fetchSpy.mock.calls.map(([url]) => String(url))).toContainEqual(expect.stringMatching(/demo\/demo-web\.log$/));
    expect(screen.queryByRole('button', { name: 'Add sender rageshake' })).toBeNull();
  });

  it('adds a sender rageshake from the unloaded sender column only, by drop or its button', async () => {
    loadBob();
    useCryptoStore.setState({ caseKey: 'bob.tar.gz' });
    renderView();
    const senderColumn = screen.getAllByTestId('device-header')[0];
    expect(within(senderColumn).getByRole('button', { name: 'Add sender rageshake' })).toHaveClass('btn-secondary');
    expect(screen.getAllByRole('button', { name: 'Add sender rageshake' })).toHaveLength(1);
    fireEvent.drop(senderColumn, { dataTransfer: { files: [new File(['2026-09-08T06:55:10.000000Z  INFO x: y | f.rs:1'], 'carol.log')] } });
    await waitFor(() => expect(useCryptoStore.getState().devices.map((d) => d.id)).toEqual(['carol.log']));
    fireEvent.change(screen.getByLabelText('Sender rageshake file'), { target: { files: [new File([SENDER_LOG], 'alice.log')] } });
    await waitFor(() => expect(useCryptoStore.getState().devices.map((d) => d.id)).toEqual(['carol.log', 'alice.log']));
  });

  it('validates a dropped sender rageshake like the upload, showing a refusal as a load error', async () => {
    loadBob();
    useCryptoStore.setState({ caseKey: 'bob.tar.gz' });
    renderView();
    fireEvent.drop(screen.getAllByTestId('device-header')[0], { dataTransfer: { files: [new File(['plain text'], 'carol.log.gz')] } });
    expect(await screen.findByText('carol.log.gz: Not a valid gzip file')).toBeInTheDocument();
    expect(useCryptoStore.getState().devices).toEqual([]);
  });

  it('shows the loaded device in the receiver lane', () => {
    loadBob();
    renderView();
    expect(screen.getAllByTestId('device-header')[1]).toHaveTextContent('@bob:b.org · BOBPHONE');
    expect(screen.queryByText(/Loaded logs/)).toBeNull();
  });

  it('shows load errors and devices without crypto activity', () => {
    useLogStore.getState().loadMergedLogParserResults([{ name: 'quiet.log', result: parseLogFile('2026-09-08T06:55:10.000000Z  INFO matrix_sdk::sync: hi | crates/x.rs:1') }]);
    useCryptoStore.setState({ errors: [{ name: 'bad.tar.gz', message: 'not a valid archive' }], caseKey: 'quiet.log' });
    renderView();
    expect(screen.getByText('bad.tar.gz: not a valid archive')).toBeInTheDocument();
    expect(screen.getByText(/quiet\.log: no crypto activity found/)).toBeInTheDocument();
  });

  it('tags sessions, switches session on click, folds Olm steps, marks gaps, shows receipts', () => {
    loadMixed();
    renderView();
    expect(screen.getByRole('button', { name: /^Session OK: Key received/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Session S9: late_key/ }));
    expect(screen.getByText(/Decrypted late: 1 event by late key: the key arrived up to 10\.0s after the failure; when it was applied is not logged/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Session S: MissingMegolmSession/ }));
    expect(screen.getByText('received 5.0s →')).toBeInTheDocument();
    expect(screen.getByText('→ batch +5.0s')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '▸ 1 Olm step' })).toBeInTheDocument();
    expect(screen.getByText('1m 32s with nothing logged')).toBeInTheDocument();
  });

  it('the header search keeps the sessions naming an id, any case, with the outcome counts', () => {
    loadMixed();
    renderView('/decryption?q=$EV9');
    const listed = () => screen.queryAllByRole('button', { name: /^Session / }).map((b) => b.getAttribute('aria-label'));
    expect(listed()).toEqual([expect.stringMatching(/^Session S9:/)]);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search sessions by id' }), { target: { value: 'req1' } });
    expect(listed()).toEqual([expect.stringMatching(/^Session S:/)]);
    fireEvent.click(screen.getByRole('button', { name: /^Decryption:/ }));
    expect(screen.queryByText('Key received')).toBeNull();
    expect(screen.getByRole('checkbox', { name: /MissingMegolmSession/ }).closest('label')).toHaveTextContent(/^MissingMegolmSession1$/);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Search sessions by id' }), { key: 'Escape' });
    expect(listed().length).toBeGreaterThan(2);
  });

  it('shows two columns, sender and receiver, the recipients in a popup marking the receiver', () => {
    loadMixed();
    renderView('/decryption?session=S');
    const headers = screen.getAllByTestId('device-header');
    expect(headers.map((h) => h.textContent)).toEqual([expect.stringContaining('@alice:a.org'), expect.stringContaining('BOBX')]);
    fireEvent.click(screen.getByRole('button', { name: 'Shared with 1 user · 1 device' }));
    expect(within(screen.getByRole('dialog', { name: 'Key share recipients' })).getByText('BOBX · receiver')).toBeInTheDocument();
  });

  it('lists by day, folds same-room bursts, names the session in the detail, folds repeated attempts', () => {
    loadBob();
    useCryptoStore.setState({
      caseKey: 'bob.tar.gz',
      devices: [dev('bobx', { ...BOB_PHONE, deviceId: 'BOBX' }, [
        utd('bobx', T0 + 100, '$x', { sessionId: 'G1', roomId: '!g' }),
        utd('bobx', T0 + 103, '$x', { sessionId: 'G1', roomId: '!g' }),
        utd('bobx', T0 + 110, '$y', { sessionId: 'G2', roomId: '!g' }),
        utd('bobx', T0 + 115, '$z', { sessionId: 'G2', roomId: '!g' }),
      ])],
    });
    renderView('/decryption?session=SESS');
    expect(screen.getByText('2026-09-08')).toBeInTheDocument();
    expect(within(screen.getByRole('button', { name: '2 sessions: MissingMegolmSession' })).getByTitle('3 UTDs')).toHaveTextContent('3 MissingMegolmSession');
    expect(within(screen.getByRole('button', { name: /^Session SESS:/ })).queryByTitle(/UTDs/)).toBeNull();
    expect(screen.queryByRole('button', { name: /^Session G1:/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '2 sessions: MissingMegolmSession' }));
    fireEvent.click(screen.getByRole('button', { name: /^Session G1:/ }));
    expect(screen.getByText('G1', { selector: 'code' })).toBeInTheDocument();
    expect(screen.getAllByText(/^UTD \$x/)).toHaveLength(1);
    expect(screen.getByText(/unresolved · 2 attempts/)).toBeInTheDocument();
    // The group holds the selection: one click folds it, the next opens it.
    fireEvent.click(screen.getByRole('button', { name: '2 sessions: MissingMegolmSession' }));
    expect(screen.queryByRole('button', { name: /^Session G1:/ })).toBeNull();
    expect(screen.getByRole('button', { name: '2 sessions: MissingMegolmSession' })).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(screen.getByRole('button', { name: '2 sessions: MissingMegolmSession' }));
    expect(screen.getByRole('button', { name: /^Session G1:/ })).toBeInTheDocument();
  });

  it('scrolls the list to the selected session', () => {
    loadMixed();
    renderView('/decryption?session=S9');
    const rows = [...document.querySelectorAll('[data-index]')];
    const index = rows.findIndex((r) => r.querySelector('[aria-label^="Session S9:"]'));
    expect(mockScrollToIndex).toHaveBeenLastCalledWith(index, { align: 'auto' });
  });

  it('opening a group above the selection leaves the list where the user scrolled', () => {
    loadMixed();
    useCryptoStore.setState((s) => ({ devices: [...s.devices, dev('bobg', { ...BOB_PHONE, deviceId: 'BOBG' }, [
      utd('bobg', T0 + 111, '$g1', { sessionId: 'G1', roomId: '!g' }),
      utd('bobg', T0 + 112, '$g2', { sessionId: 'G2', roomId: '!g' }),
    ])] }));
    renderView('/decryption?session=S');
    const calls = mockScrollToIndex.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: /^2 sessions:/ }));
    expect(screen.getByRole('button', { name: /^Session G1:/ })).toBeInTheDocument();
    expect(mockScrollToIndex.mock.calls.length).toBe(calls);
  });

  it('puts both lanes on one time axis, opens folds in place, flags a lane with no logs at this time', () => {
    loadMixed();
    // The receiver's logs cover the session; the sender's (0 → 10 000 s) do not.
    useCryptoStore.setState((state) => ({ devices: state.devices.map((d) => (d.id === 'bobx' ? { ...d, coverage: [{ start: T0 * 1e6, end: (T0 + 200) * 1e6 }] } : d)) }));
    renderView('/decryption?session=S');
    const times = screen.getAllByText(/^\d\d:\d\d:\d\d\.\d{3}$/).map((t) => t.textContent);
    expect(times).toEqual([...times].sort());
    expect(times.length).toBeGreaterThanOrEqual(4);
    expect(screen.queryByText('Olm decryption failed')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '▸ 1 Olm step' }));
    expect(screen.getByText('Olm decryption failed')).toBeInTheDocument();
    const headers = screen.getAllByTestId('device-header');
    expect(headers.map((h) => within(h).queryByText('no logs at this time') !== null)).toEqual([true, false]);
  });

  it('accents failures red and keys green, and alternates row backgrounds', () => {
    loadMixed();
    renderView('/decryption?session=S9');
    const toneOf = (text: RegExp) => screen.getByText(text).parentElement?.parentElement?.className;
    expect(toneOf(/^UTD \$ev9/)).toMatch(/bad/);
    expect(toneOf(/^room key received/)).toMatch(/good/);
    const rows = [...document.querySelectorAll('[class*="tlRow"]')].filter((r) => !/tlHead/.test(r.className));
    expect(rows.map((r) => /striped/.test(r.className))).toEqual(rows.map((_, i) => i % 2 === 1));
  });

  it('a row click toggles its log line; Up/Down move the selection and the panel', () => {
    loadMixed();
    renderView('/decryption?session=S9');
    const row = (text: RegExp) => screen.getByText(text).closest('[aria-selected]') as Element;
    fireEvent.click(row(/^UTD \$ev9/));
    expect(row(/^UTD \$ev9/)).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('log-panel')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(row(/^room key received/)).toHaveAttribute('aria-selected', 'true');
    expect(row(/^UTD \$ev9/)).toHaveAttribute('aria-selected', 'false');
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    expect(row(/^UTD \$ev9/)).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(row(/^UTD \$ev9/));
    expect(screen.queryByTestId('log-panel')).toBeNull();
    // From the keyboard: a focusable row in a grid; Enter toggles it like a click.
    expect(row(/^UTD \$ev9/)).toHaveAttribute('role', 'row');
    expect(row(/^UTD \$ev9/).closest('[role="grid"]')).not.toBeNull();
    fireEvent.keyDown(row(/^UTD \$ev9/), { key: 'Enter' });
    expect(row(/^UTD \$ev9/)).toHaveAttribute('aria-selected', 'true');
  });

  it('timeline rows have one tab stop: the first row, then the selected one, which focus follows on Up/Down', () => {
    loadMixed();
    renderView('/decryption?session=S9');
    const tabStops = () => [...document.querySelectorAll('[role="row"][aria-selected]')].filter((r) => r.getAttribute('tabindex') === '0');
    const row = (text: RegExp) => screen.getByText(text).closest('[aria-selected]') as HTMLElement;
    expect(tabStops()).toEqual([document.querySelector('[role="row"][aria-selected]')]);
    row(/^UTD \$ev9/).focus();
    fireEvent.keyDown(row(/^UTD \$ev9/), { key: ' ' });
    expect(tabStops()).toEqual([row(/^UTD \$ev9/)]);
    fireEvent.keyDown(row(/^UTD \$ev9/), { key: 'ArrowDown' });
    expect(tabStops()).toEqual([row(/^room key received/)]);
    expect(row(/^room key received/)).toHaveFocus();
    expect(row(/^UTD \$ev9/)).toHaveAttribute('tabindex', '-1');
  });

  it('the time window also scopes key-received sessions, by when their key arrived', () => {
    loadMixed();
    useLogStore.setState({ startTime: '2026-09-08T06:56:00.000Z', endTime: '2026-09-08T06:56:55.000Z' });
    renderView();
    expect(screen.getByRole('button', { name: /^Session S: / })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Session OK:/ })).toBeNull();
  });

  it('summarises the session: verdict, journey, an event list whose lines open the log and select the row', () => {
    loadBob();
    useCryptoStore.setState({
      caseKey: 'bob.tar.gz',
      devices: [dev('bobx', { ...BOB_PHONE, deviceId: 'BOBX' }, [
        utd('bobx', T0 + 110, '$y', { sessionId: 'G2', roomId: '!g' }),
        utd('bobx', T0 + 115, '$z', { sessionId: 'G2', roomId: '!g' }),
      ])],
    });
    renderView('/decryption?session=G2');
    expect(screen.getByText(/^✗ Likely the key never reached this device/)).toBeInTheDocument();
    expect(screen.getByText('Shared with this device')).toBeInTheDocument();
    expect(screen.getByText(/^Based on this device's logs only/)).toBeInTheDocument();
    expect(screen.getByText('Key received over to-device').closest('[data-decisive]')).not.toBeNull();
    expect(screen.queryByRole('dialog', { name: 'How to read the verdict' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'How to read the verdict' }));
    expect(screen.getByRole('dialog', { name: 'How to read the verdict' })).toHaveTextContent(/not a proven cause/);
    expect(screen.getByText('Events')).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('link', { name: '$z' }).closest('div') as HTMLElement).getByText(/still failing/));
    expect(screen.getByTestId('log-panel')).toBeInTheDocument();
    expect(screen.getByText(/^UTD \$z/).closest('[aria-selected]')).toHaveAttribute('aria-selected', 'true');
  });

  it('⌕ shows every occurrence of an event id, per lane; the sender tab parses its archive on first use', async () => {
    loadBob();
    await addAlice();
    renderView();
    fireEvent.click(screen.getByRole('button', { name: 'Show occurrences of $ev1' }));
    expect(screen.getByTestId('log-panel')).toHaveAttribute('data-filter', '$ev1');
    expect(screen.getByRole('button', { name: 'Receiver · 1' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: /^Sender/ }));
    expect(screen.getByText('Loading the sender rageshake…')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: /^Sender · \d+$/ })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Expand' })).toBeNull();
  });

  it('⌕ on a session with no receiver shows the sender\'s lines', () => {
    useLogStore.getState().loadMergedLogParserResults([{ name: 'logs.log', result: parseLogFile(SENDER_LOG) }]);
    renderView();
    fireEvent.click(screen.getAllByRole('button', { name: /^Show occurrences of / })[0]);
    expect(screen.getByTestId('log-panel')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Sender · \d+$/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('⌕ in the header searches the session id; expand opens /logs filtered on it', () => {
    loadBob();
    renderView();
    fireEvent.click(screen.getByRole('button', { name: 'Show occurrences of SESS' }));
    expect(screen.getByTestId('log-panel')).toHaveAttribute('data-filter', 'SESS');
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
    expect(mockNavigate).toHaveBeenCalledWith('/logs?filter=SESS');
  });

  it('⌕ counts the lines the panel shows: any case, the loaded lines passed as they are', () => {
    loadBob(`${RECEIVER_LOG}\n2026-09-08T06:55:30.000000Z  INFO matrix_sdk::x: lower-case sess here | crates/x.rs:1`);
    renderView();
    fireEvent.click(screen.getByRole('button', { name: 'Show occurrences of SESS' }));
    const lines = useLogStore.getState().rawLogLines;
    const anyCase = lines.filter((l) => l.rawText.toLowerCase().includes('sess')).length;
    expect(anyCase).toBeGreaterThan(lines.filter((l) => l.rawText.includes('SESS')).length);
    expect(screen.getByRole('button', { name: `Receiver · ${anyCase}` })).toBeInTheDocument();
    expect(panelLines).toBe(lines);
  });

  it('the event id links to matrix.to with a quick tooltip, plain for anonymized ids', () => {
    loadBob();
    useCryptoStore.setState({
      caseKey: 'bob.tar.gz',
      devices: [dev('bobx', { ...BOB_PHONE, deviceId: 'BOBX' }, [
        utd('bobx', T0 + 110, '$event-fd3eb2001791', { sessionId: 'A', roomId: '!room-0c9231edecda:domain-60fc0bb7.org' }),
      ])],
    });
    const { unmount } = renderView('/decryption?session=SESS');
    const link = screen.getByRole('link', { name: '$ev1' });
    expect(link).toHaveAttribute('href', 'https://matrix.to/#/!r%3Aa.org/%24ev1');
    expect(link).toHaveAttribute('data-tip', 'https://matrix.to/#/!r%3Aa.org/%24ev1');
    unmount();
    renderView('/decryption?session=A');
    expect(screen.queryByRole('link', { name: '$event-fd3eb2001791' })).toBeNull();
    expect(screen.getByText('$event-fd3eb2001791')).toHaveAttribute('data-tip', 'Ids are anonymized: no matrix.to permalink');
  });

  it('a modern anonymized room id (no domain) gets no permalink either', () => {
    loadBob();
    useCryptoStore.setState({
      caseKey: 'bob.tar.gz',
      devices: [dev('bobx', { ...BOB_PHONE, deviceId: 'BOBX' }, [utd('bobx', T0 + 110, '$ev7', { sessionId: 'M', roomId: '!room-0c9231edecda' })])],
    });
    renderView('/decryption?session=M');
    expect(screen.queryByRole('link', { name: '$ev7' })).toBeNull();
    expect(screen.getByText('$ev7')).toHaveAttribute('data-tip', 'Ids are anonymized: no matrix.to permalink');
  });

  it('notes a loaded lane whose logs do not cover the session', () => {
    loadBob();
    useCryptoStore.setState({ caseKey: 'bob.tar.gz', devices: [dev('alice', ALICE, [])] });
    renderView();
    const [senderLane, receiverLane] = screen.getAllByTestId('device-header');
    expect(senderLane).toHaveTextContent('no logs at this time');
    expect(receiverLane).not.toHaveTextContent('no logs at this time');
  });

  it('filters sessions by outcome from the header, kept in the URL', () => {
    loadMixed();
    renderView('/decryption?outcome=key_received');
    expect(screen.getByRole('button', { name: /^Session OK: Key received/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Session S9:/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Decryption: Key received' }));
    const late = screen.getByRole('checkbox', { name: /late_key/ });
    expect(screen.getByRole('checkbox', { name: /MissingMegolmSession/ })).not.toBeChecked();
    fireEvent.click(late);
    expect(screen.getByRole('button', { name: /^Session S9: late_key/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Select All' }));
    expect(screen.getByRole('button', { name: /^Session S: MissingMegolmSession/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Decryption: All' })).toBeInTheDocument();
  });

  /** loadMixed, with a timeline handling $ev1 (session S, never decrypted): reported; $ev9 (S9) never handled: not reported. */
  const loadHandled = () => {
    loadMixed();
    const [alice, bobx] = useCryptoStore.getState().devices;
    const handled = st('bobx', 'timeline.handled', T0 + 101, { eventId: '$ev1' });
    useCryptoStore.setState({ devices: [alice, { ...bobx, steps: [...bobx.steps, handled].sort((a, b) => a.ts - b.ts) }] });
  };

  it('filters by whether analytics received a UTD; /summary links to the reported ones', () => {
    loadHandled();
    renderView('/decryption?analytics=reported');
    expect(screen.getByRole('button', { name: 'Analytics: Reported' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Session S:/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Session S9:/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Analytics: Reported' }));
    expect(screen.getAllByRole('radio').map((r) => r.getAttribute('value'))).toEqual(['any', 'reported', 'not_reported', 'unknown']);
    fireEvent.click(screen.getByRole('radio', { name: /Not reported/ }));
    expect(screen.getByRole('button', { name: /^Session S9:/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Session S:/ })).toBeNull();
  });

  it('keeps a selected outcome listed, at 0, when the other filter empties it', () => {
    loadHandled();
    renderView('/decryption?analytics=not_reported&outcome=utd:missing_key');
    fireEvent.click(screen.getByRole('button', { name: 'Decryption: MissingMegolmSession' }));
    const missing = screen.getByRole('checkbox', { name: /MissingMegolmSession/ });
    expect(missing).toBeChecked();
    expect(missing.closest('label')?.textContent).toBe('MissingMegolmSession0');
  });

  it('has no "Analytics" filter, and ignores its param, when no device logs timeline handling', () => {
    loadMixed();
    renderView('/decryption?analytics=reported');
    expect(screen.queryByRole('button', { name: /^Analytics/ })).toBeNull();
    expect(screen.getByRole('button', { name: /^Session S9:/ })).toBeInTheDocument();
  });

  it('lists every outcome present with its session count', () => {
    loadMixed();
    renderView();
    fireEvent.click(screen.getByRole('button', { name: 'Decryption: All' }));
    expect(screen.getAllByRole('checkbox').map((c) => c.closest('label')?.textContent)).toEqual([
      'Key received1', 'MissingMegolmSession2', 'late_key1',
    ]);
    fireEvent.click(screen.getByRole('checkbox', { name: /Key received/ }));
    expect(screen.getByRole('button', { name: 'Decryption: All − Key received' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Session OK:/ })).toBeNull();
    // Still only the outcomes some session has: unticking does not list every other one at 0.
    expect(screen.getAllByRole('checkbox').map((c) => c.closest('label')?.textContent)).toEqual([
      'Key received1', 'MissingMegolmSession2', 'late_key1',
    ]);
  });

  it('a double click on an outcome selects only it', () => {
    loadMixed();
    renderView();
    fireEvent.click(screen.getByRole('button', { name: 'Decryption: All' }));
    const missing = screen.getByRole('checkbox', { name: /MissingMegolmSession/ });
    // A real double click: two clicks (tick, untick back), then the dblclick.
    fireEvent.click(missing);
    fireEvent.click(missing);
    fireEvent.doubleClick(missing.closest('label')!);
    expect(screen.getByRole('button', { name: 'Decryption: MissingMegolmSession' })).toBeInTheDocument();
    expect(screen.getAllByRole('checkbox').filter((c) => (c as HTMLInputElement).checked).map((c) => c.closest('label')?.textContent)).toEqual([
      'MissingMegolmSession2',
    ]);
  });

  it('unticking an outcome under a search keeps the outcomes the search hides', () => {
    loadMixed();
    renderView('/decryption?q=req1');
    fireEvent.click(screen.getByRole('button', { name: 'Decryption: All' }));
    expect(screen.queryByRole('checkbox', { name: /late_key/ })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: /MissingMegolmSession/ }));
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Search sessions by id' }), { key: 'Escape' });
    expect(screen.getByRole('button', { name: /^Session S9: late_key/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Session OK: Key received/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Session S: / })).toBeNull();
  });
});

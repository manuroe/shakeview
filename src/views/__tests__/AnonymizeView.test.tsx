import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';
import { act, render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { gzipSync, strToU8 } from 'fflate';
import { AnonymizeView } from '../AnonymizeView';
import { useAnonymizeSessionStore, type AnonymizeJob } from '../../stores/anonymizeSessionStore';
import { useAnonSaltStore } from '../../stores/anonSaltStore';
import { useArchiveStore } from '../../stores/archiveStore';
import { useLogStore } from '../../stores/logStore';
import { buildTar } from '../../utils/tarWriter';
import type { AnonymizationDictionary } from '../../types/log.types';
import type { MatrixProfile } from '../../types/listing';
import { applyAnonymization, buildAnonymizationDictionaryFromTexts } from '../../utils/anonymizeUtils';
import * as download from '../../utils/downloadBlob';
import * as deanonymize from '../../utils/deanonymizeReport';

// No homeserver in tests: each test says which profiles exist.
const profiles = vi.hoisted(() => new Map<string, MatrixProfile>());
vi.mock('../../hooks/useMatrixProfile', () => ({
  useMatrixProfile: (userId: string | undefined) => (userId ? profiles.get(userId) ?? null : null),
}));

const EMPTY: AnonymizationDictionary = { forward: {}, reverse: {} };

const job = (patch: Partial<AnonymizeJob> & { userId?: string; deviceId?: string; dict?: AnonymizationDictionary } = {}): AnonymizeJob => {
  const { userId, deviceId, dict = EMPTY, ...rest } = patch;
  return {
    id: 1, sourceName: 'rs.tar.gz', status: 'done', message: '', progress: 1, rawUrl: null, salt: 'salt', save: false, file: new File(['x'], 'rs.tar.gz'),
    output: { name: 'rs-anonym.tar.gz', data: 'x', mime: 'text/plain', dict, isArchive: true, identity: { userId, deviceId } },
    ...rest,
  };
};

const page = () => render(<MemoryRouter><AnonymizeView /></MemoryRouter>);

describe('AnonymizeView', () => {
  // jsdom has no revokeObjectURL; Forget all calls it for the held raw archive.
  const revoke = vi.fn();
  const originalRevoke = URL.revokeObjectURL;
  URL.revokeObjectURL = revoke;
  const initialState = useAnonymizeSessionStore.getState();
  const initialSalt = useAnonSaltStore.getState().salt;
  const initialArchive = useArchiveStore.getState();
  const initialLog = useLogStore.getState();
  afterEach(() => {
    vi.restoreAllMocks();
    profiles.clear();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- removing the stubbed JSDOM property
    delete (navigator as any).clipboard;
    useAnonymizeSessionStore.setState(initialState, true);
    useArchiveStore.setState(initialArchive, true);
    useLogStore.setState(initialLog, true);
    // Back to the first salt. A salt change re-anonymises after a debounce: run that here, not in the next test.
    vi.useFakeTimers();
    act(() => {
      useAnonSaltStore.setState({ salt: initialSalt });
      vi.runAllTimers();
    });
    vi.useRealTimers();
  });
  afterAll(() => { URL.revokeObjectURL = originalRevoke; });

  it('reads anonymised text back with real IDs, links repointed at the raw archive, and forgets all but the anonymised text', async () => {
    const dict = await buildAnonymizationDictionaryFromTexts(['@alice:matrix.org'], 'salt');
    const alias = applyAnonymization('@alice:matrix.org', dict);
    const text = `# Case\n\n${alias} left.\n\n- [12:00](http://127.0.0.1:7357/#/logs?archive=/c/rs-anonym.tar.gz&line=4)\n`;
    useAnonymizeSessionStore.setState({
      jobs: [job({ dict, rawUrl: 'blob:http://localhost/1', output: { name: 'rs-anonym.tar.gz', data: new Uint8Array(), mime: 'application/gzip', dict, isArchive: true, identity: {} } })],
      text,
    });

    page();

    expect(screen.getByText('@alice:matrix.org left.')).toBeInTheDocument();
    const href = screen.getAllByRole('link', { name: '12:00' })[0].getAttribute('href')!;
    expect(new URLSearchParams(href.slice(href.indexOf('?') + 1)).get('archive')).toBe('blob:http://localhost/1');

    const save = vi.spyOn(download, 'downloadBlob').mockImplementation(() => {});
    fireEvent.click(screen.getByRole('button', { name: 'Save real ids' }));
    expect(save).toHaveBeenLastCalledWith(expect.stringContaining('@alice:matrix.org left.'), 'real.md', 'text/markdown');
    fireEvent.click(screen.getByRole('button', { name: '1 rageshake ▾' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save rs-anonym.tar.gz' }));
    expect(save).toHaveBeenLastCalledWith(expect.any(Uint8Array), 'rs-anonym.tar.gz', 'application/gzip');
    fireEvent.click(screen.getByRole('button', { name: /Forget all/ }));
    expect(useAnonymizeSessionStore.getState()).toMatchObject({ jobs: [], text, driver: 'anonymised' });
    expect(revoke).toHaveBeenCalledWith('blob:http://localhost/1');

    fireEvent.click(screen.getByRole('button', { name: 'Edit real ids' }));
    expect(screen.getByRole('textbox', { name: 'Real IDs' })).toHaveValue(text);
  });

  it('anonymises text typed with real IDs, and reads it back once the anonymised side is edited', async () => {
    page();

    fireEvent.change(screen.getByRole('textbox', { name: 'Real IDs' }), { target: { value: '@alice:matrix.org left' } });
    await vi.waitFor(() => expect(screen.getByText(/^@user-[0-9a-f]{12}:domain-[0-9a-f]{8}\.org left$/)).toBeInTheDocument());
    expect(screen.queryByText(/real ID/)).toBeNull(); // all anonymised: nothing to warn about

    fireEvent.click(screen.getByRole('button', { name: 'Edit anonymised' }));
    const right = screen.getByRole('textbox', { name: 'Anonymised' }) as HTMLTextAreaElement;
    const edited = `${right.value}, then came back`;
    fireEvent.change(right, { target: { value: edited } });

    expect(useAnonymizeSessionStore.getState().driver).toBe('anonymised');
    expect(screen.getByRole('textbox', { name: 'Real IDs' })).toHaveValue('@alice:matrix.org left, then came back');

    // Typing on the left again: until it is anonymised, the right keeps its text, not the anonymisation before the edit.
    fireEvent.change(screen.getByRole('textbox', { name: 'Real IDs' }), { target: { value: '@alice:matrix.org left, then came back!' } });
    expect(screen.getByRole('textbox', { name: 'Anonymised' })).toHaveValue(edited);
  });

  it('anonymises typed text again neither on a progress tick nor on each keystroke of the salt', async () => {
    useAnonymizeSessionStore.setState({ jobs: [job()] });
    page();
    fireEvent.change(screen.getByRole('textbox', { name: 'Real IDs' }), { target: { value: '@alice:matrix.org left' } });
    await vi.waitFor(() => expect(useAnonymizeSessionStore.getState().textDict.forward).toHaveProperty(['@alice:matrix.org']));
    const spy = vi.spyOn(deanonymize, 'anonymizeText');

    act(() => {
      // A re-run's progress: a new job, the same output.
      useAnonymizeSessionStore.setState((s) => ({ jobs: s.jobs.map((j) => ({ ...j, status: 'working', progress: 0.5 })) }));
      for (const salt of ['n', 'ne', 'new']) useAnonSaltStore.setState({ salt });
    });
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 400)); // past the debounce

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('@alice:matrix.org left', 'new', expect.anything());
  });

  it('forgets the mapping of text typed with real IDs, keeping its anonymisation as typed last', async () => {
    useAnonymizeSessionStore.setState({ jobs: [job()] });
    page();
    const left = screen.getByRole('textbox', { name: 'Real IDs' });
    fireEvent.change(left, { target: { value: '@alice:matrix.org left' } });
    await vi.waitFor(() => expect(useAnonymizeSessionStore.getState().textDict.forward).toHaveProperty(['@alice:matrix.org']));
    fireEvent.change(screen.getByRole('textbox', { name: 'Real IDs' }), { target: { value: '@alice:matrix.org left, @bob:matrix.org stayed' } });

    fireEvent.click(screen.getByRole('button', { name: '1 rageshake ▾' }));
    fireEvent.click(screen.getByRole('button', { name: /Forget all/ }));
    await vi.waitFor(() => expect(useAnonymizeSessionStore.getState().driver).toBe('anonymised'));
    expect(useAnonymizeSessionStore.getState().text).toMatch(/^@user-\S+ left, @user-\S+ stayed$/);
    await new Promise((r) => setTimeout(r, 400)); // past the debounce of the text typed

    expect(useAnonymizeSessionStore.getState().textDict).toEqual({ forward: {}, reverse: {} });
  });

  it('warns when the anonymised side holds real IDs', () => {
    useAnonymizeSessionStore.setState({ text: '@alice:matrix.org on https://matrix.example.org/x' });
    page();

    expect(screen.getByText('2 real IDs left: not safe to share.')).toBeInTheDocument();
  });

  it('renders pasted text on both sides, keeps it editable, and copies its source', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    page();

    const input = screen.getByRole('textbox', { name: 'Anonymised' });
    fireEvent.paste(input);
    fireEvent.change(input, { target: { value: '# Notes' } });
    expect(screen.getAllByRole('heading', { name: 'Notes' })).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Edit anonymised' }));
    expect(screen.getByRole('textbox', { name: 'Anonymised' })).toHaveValue('# Notes');

    fireEvent.click(screen.getByRole('button', { name: 'Copy anonymised' }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('# Notes'));
  });

  it('anonymises and saves files dropped, picked, or chosen from the keyboard above the anonymised side', () => {
    const anonymiseFiles = vi.fn().mockResolvedValue(undefined);
    useAnonymizeSessionStore.setState({ anonymiseFiles });
    page();
    const zone = screen.getByRole('button', { name: 'Load and download anonymised' });
    const input = zone.querySelector('input[type="file"]') as HTMLInputElement;
    const click = vi.spyOn(input, 'click').mockImplementation(() => {});
    const file = new File(['x'], 'rs.tar.gz');
    const dataTransfer = { files: [file], types: ['Files'] };

    fireEvent.dragOver(zone, { dataTransfer });
    expect(zone.className).toMatch(/dragOver/);
    fireEvent.dragLeave(zone);
    expect(zone.className).not.toMatch(/dragOver/);
    fireEvent.drop(zone, { dataTransfer });
    expect(anonymiseFiles).toHaveBeenLastCalledWith([file], true);

    fireEvent.click(zone);
    fireEvent.keyDown(zone, { key: 'Enter' });
    expect(click).toHaveBeenCalledTimes(2);
    fireEvent.change(input, { target: { files: [file] } });
    expect(anonymiseFiles).toHaveBeenLastCalledWith([file], true);
  });

  it('takes originals above the real side for their mapping only, and loads text dropped there as real text', async () => {
    const anonymiseFiles = vi.fn().mockResolvedValue(undefined);
    useAnonymizeSessionStore.setState({ anonymiseFiles });
    page();
    const zone = screen.getByRole('button', { name: 'Load rageshakes' });
    const archive = new File(['x'], 'rs.tar.gz');
    // jsdom's File lacks text(), which every browser has.
    const txt = Object.assign(new File(['# Report'], 'report.txt'), { text: () => Promise.resolve('# Report') });

    fireEvent.drop(zone, { dataTransfer: { files: [archive, txt], types: ['Files'] } });

    expect(anonymiseFiles).toHaveBeenLastCalledWith([archive], false);
    await vi.waitFor(() => expect(useAnonymizeSessionStore.getState()).toMatchObject({ text: '# Report', driver: 'real' }));
  });

  it('routes a file dropped on a pane: a rageshake to the zone above it, text into the pane', async () => {
    const anonymiseFiles = vi.fn().mockResolvedValue(undefined);
    useAnonymizeSessionStore.setState({ anonymiseFiles });
    page();
    const archive = new File(['x'], 'rs.tar.gz');
    const md = Object.assign(new File(['# Dropped'], 'r.md'), { text: () => Promise.resolve('# Dropped') });

    fireEvent.drop(screen.getByRole('textbox', { name: 'Real IDs' }), { dataTransfer: { files: [archive], types: ['Files'] } });
    expect(anonymiseFiles).toHaveBeenLastCalledWith([archive], false);
    fireEvent.drop(screen.getByRole('textbox', { name: 'Anonymised' }), { dataTransfer: { files: [archive], types: ['Files'] } });
    expect(anonymiseFiles).toHaveBeenLastCalledWith([archive], true);
    expect(useAnonymizeSessionStore.getState().text).toBe('');

    fireEvent.drop(screen.getByRole('textbox', { name: 'Anonymised' }), { dataTransfer: { files: [md], types: ['Files'] } });
    await vi.waitFor(() => expect(useAnonymizeSessionStore.getState()).toMatchObject({ text: '# Dropped', driver: 'anonymised' }));

    const stray = fireEvent.dragOver(screen.getByRole('heading', { name: 'Anonymise' }), { dataTransfer: { files: [md], types: ['Files'] } });
    expect(stray).toBe(false); // default prevented: the browser does not navigate to the file
  });

  it('goes back to the start page when opened directly, and back in history otherwise', () => {
    const app = (entries: string[]) => (
      <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
        <Routes>
          <Route path="/" element={<p>start</p>} />
          <Route path="/summary" element={<p>summary</p>} />
          <Route path="/anonymize" element={<AnonymizeView />} />
        </Routes>
      </MemoryRouter>
    );

    const { unmount } = render(app(['/anonymize']));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByText('start')).toBeInTheDocument();
    unmount();

    render(app(['/summary', '/anonymize']));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByText('summary')).toBeInTheDocument();
  });

  it('renders a single newline as a line break, like GitHub comments', () => {
    useAnonymizeSessionStore.setState({ text: '# Notes\nfirst\nsecond' });
    page();

    expect(screen.getByLabelText('Real IDs').querySelector('p')?.innerHTML).toBe('first<br>\nsecond');
  });

  it('keeps pasted raw logs in the textarea: only markdown renders', () => {
    page();
    const input = screen.getByRole('textbox', { name: 'Real IDs' });
    fireEvent.paste(input);
    fireEvent.change(input, { target: { value: '2026-10-29 12:00:00 D/Sync: started\n2026-10-29 12:00:01 E/Sync: failed' } });

    expect(screen.getByRole('textbox', { name: 'Real IDs' })).toHaveValue('2026-10-29 12:00:00 D/Sync: started\n2026-10-29 12:00:01 E/Sync: failed');
    expect(screen.getByRole('button', { name: 'Edit real ids' })).toBeDisabled();
  });

  it('edits rendered markdown from the Edit button only, not on a click in it', () => {
    useAnonymizeSessionStore.setState({ text: '# Notes\nsee [log](https://example.org)' });
    page();

    const anonymised = within(screen.getByLabelText('Anonymised'));
    fireEvent.click(anonymised.getByRole('link', { name: 'log' }));
    fireEvent.click(anonymised.getByRole('heading', { name: 'Notes' }));
    expect(screen.queryByRole('textbox', { name: 'Anonymised' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Edit anonymised' }));
    expect(screen.getByRole('textbox', { name: 'Anonymised' })).toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: 'Preview anonymised' }));
    expect(screen.queryByRole('textbox', { name: 'Anonymised' })).toBeNull();
    expect(within(screen.getByLabelText('Anonymised')).getByRole('heading', { name: 'Notes' })).toBeInTheDocument();
  });

  it('keeps editing when pasting into existing text, and shows the drop target while dragging a file', () => {
    page();
    const input = screen.getByRole('textbox', { name: 'Anonymised' });
    fireEvent.change(input, { target: { value: 'typed' } });
    fireEvent.paste(input);
    fireEvent.change(input, { target: { value: 'typed and pasted' } });
    // Still the textarea, holding the edit: a paste only flips to rendered when it fills an empty pane.
    expect(screen.getByRole('textbox', { name: 'Anonymised' })).toHaveValue('typed and pasted');

    fireEvent.dragOver(input, { dataTransfer: { types: ['Files'], files: [] } });
    expect(screen.getByText('Drop to load')).toBeInTheDocument();
  });

  it('keeps typing in the textarea after a paste that inserted nothing', () => {
    page();
    const input = screen.getByRole('textbox', { name: 'Anonymised' });
    fireEvent.paste(input); // e.g. an image: no change follows
    fireEvent.keyDown(input, { key: 'a' });
    fireEvent.change(input, { target: { value: 'a' } });

    expect(screen.getByRole('textbox', { name: 'Anonymised' })).toHaveValue('a');
  });

  it('asks for the original when nothing is loaded, then blames the salt for aliases no rageshake knows', () => {
    useAnonymizeSessionStore.setState({ text: '@user-0123456789ab:domain-01234567.org left' });
    page();
    expect(screen.getByText('To reveal real IDs, load the original rageshake above.')).toBeInTheDocument();

    act(() => useAnonymizeSessionStore.setState({ jobs: [job()] }));
    expect(screen.getByText(/1 alias not found in the loaded rageshakes/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'wrong salt?' }));
    expect(screen.getByRole('textbox', { name: 'Anonymisation salt' })).toHaveValue(useAnonSaltStore.getState().salt);
  });

  it('opens the salt from the key button', () => {
    page();
    expect(screen.queryByRole('textbox', { name: 'Anonymisation salt' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Salt' }));
    expect(screen.getByRole('textbox', { name: 'Anonymisation salt' })).toBeInTheDocument();
  });

  describe('identity', () => {
    it('shows one user with the summary page header, its device keys included, counting their devices', () => {
      profiles.set('@alice:matrix.org', { displayName: 'Alice', avatarHttpUrl: null });
      useAnonymizeSessionStore.setState({
        jobs: [job({ output: { ...job().output!, identity: { userId: '@alice:matrix.org', deviceId: 'PHONE', curveKey: 'abc' } } })],
      });
      page();

      expect(screen.getByText('Alice')).toBeInTheDocument();
      expect(screen.getByText('@alice:matrix.org')).toBeInTheDocument();
      expect(screen.getByText('PHONE')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /Alice/ }));
      expect(within(screen.getByRole('dialog', { name: 'Device keys' })).getByText('abc')).toBeInTheDocument();

      act(() => useAnonymizeSessionStore.setState({
        jobs: [job({ userId: '@alice:matrix.org', deviceId: 'PHONE' }), job({ id: 2, userId: '@alice:matrix.org', deviceId: 'DESKTOP' })],
      }));
      expect(screen.getByText('2 devices')).toBeInTheDocument();
    });

    it('stacks several users, naming two, counting more', () => {
      profiles.set('@alice:matrix.org', { displayName: 'Alice', avatarHttpUrl: 'https://matrix.org/alice.png' });
      useAnonymizeSessionStore.setState({ jobs: [job({ userId: '@alice:matrix.org' }), job({ id: 2, userId: '@bob:example.com' })] });
      const { container } = page();
      expect(screen.getByText('Alice, @bob:example.com')).toBeInTheDocument();
      // Only Alice has a face: Bob gets none, not a placeholder.
      expect([...container.querySelectorAll('header img')].map((i) => i.getAttribute('src'))).toEqual(['https://matrix.org/alice.png']);

      act(() => useAnonymizeSessionStore.setState({
        jobs: ['@a:x.org', '@b:x.org', '@c:x.org', '@d:x.org'].map((userId, id) => job({ id, userId })),
      }));
      expect(screen.getByText('4 users')).toBeInTheDocument();
    });

    it('shows nobody until a rageshake names its user', () => {
      useAnonymizeSessionStore.setState({ jobs: [job()] });
      const { container } = page();

      expect(container.querySelector('header')).toHaveTextContent(/^Anonymise1 rageshake ▾$/);
    });
  });

  describe('open', () => {
    const openPage = () => render(
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<AnonymizeView />} />
          <Route path="/archive" element={<div>archive page</div>} />
          <Route path="/summary" element={<div>summary page</div>} />
        </Routes>
      </MemoryRouter>,
    );
    const logLine = '2026-10-29T12:00:00.000Z INFO started';

    it('opens a rageshake loaded on the real side as dropped, in the archive listing', async () => {
      const tarGz = gzipSync(buildTar([{ name: 'rs/console.log', data: strToU8(logLine) }]));
      // jsdom's File lacks arrayBuffer(), which every browser has.
      const file = Object.assign(new File([tarGz], 'rs.tar.gz'), { arrayBuffer: () => Promise.resolve(tarGz.buffer) });
      useAnonymizeSessionStore.setState({ jobs: [job({ file })] });
      openPage();
      fireEvent.click(screen.getByRole('button', { name: '1 rageshake ▾' }));
      fireEvent.click(screen.getByRole('button', { name: 'Open rs.tar.gz' }));

      expect(await screen.findByText('archive page')).toBeInTheDocument();
      expect(useArchiveStore.getState().archiveName).toBe('rs.tar.gz');
      expect(useArchiveStore.getState().archiveEntries.map((e) => e.name)).toEqual(['rs/console.log']);
    });

    it('opens a log loaded on the anonymised side as its anonymised copy, in the summary', async () => {
      useAnonymizeSessionStore.setState({
        jobs: [job({ sourceName: 'app.log', save: true, output: { ...job().output!, name: 'app-anonym.log', data: logLine, isArchive: false } })],
      });
      openPage();
      fireEvent.click(screen.getByRole('button', { name: '1 rageshake ▾' }));
      fireEvent.click(screen.getByRole('button', { name: 'Open app-anonym.log' }));

      expect(await screen.findByText('summary page')).toBeInTheDocument();
      expect(useLogStore.getState().logFileName).toBe('app-anonym.log');
    });
  });
});

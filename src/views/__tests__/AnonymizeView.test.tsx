import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AnonymizeView } from '../AnonymizeView';
import { useAnonymizeSessionStore, type AnonymizeJob } from '../../stores/anonymizeSessionStore';
import { applyAnonymization, buildAnonymizationDictionaryFromTexts } from '../../utils/anonymizeUtils';
import * as download from '../../utils/downloadBlob';

describe('AnonymizeView', () => {
  // jsdom has no revokeObjectURL; Forget all calls it for the held raw archive.
  const revoke = vi.fn();
  const originalRevoke = URL.revokeObjectURL;
  URL.revokeObjectURL = revoke;
  const initialState = useAnonymizeSessionStore.getState();
  afterEach(() => {
    vi.restoreAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- removing the stubbed JSDOM property
    delete (navigator as any).clipboard;
    useAnonymizeSessionStore.setState(initialState, true);
  });
  afterAll(() => { URL.revokeObjectURL = originalRevoke; });

  it('renders the report de-anonymised, links repointed at the raw archive, with a raw view', async () => {
    const dict = await buildAnonymizationDictionaryFromTexts(['@alice:matrix.org'], 'salt');
    const alias = applyAnonymization('@alice:matrix.org', dict);
    useAnonymizeSessionStore.setState({
      jobs: [{
        id: 0, sourceName: 'rs.tar.gz', status: 'done', message: '', progress: 1, rawUrl: 'blob:http://localhost/1', save: true,
        output: { name: 'rs-anonym.tar.gz', data: new Uint8Array(), mime: 'application/gzip', dict, isArchive: true },
      }],
      report: `# Case\n\n${alias} left.\n\n- [12:00](http://127.0.0.1:7357/#/logs?archive=/c/rs-anonym.tar.gz&line=4)\n`,
    });

    render(<MemoryRouter><AnonymizeView /></MemoryRouter>);

    expect(screen.getByRole('heading', { name: 'Case' })).toBeInTheDocument();
    expect(screen.getByText('@alice:matrix.org left.')).toBeInTheDocument();
    const href = screen.getByRole('link', { name: '12:00' }).getAttribute('href')!;
    expect(new URLSearchParams(href.slice(href.indexOf('?') + 1)).get('archive')).toBe('blob:http://localhost/1');

    const save = vi.spyOn(download, 'downloadBlob').mockImplementation(() => {});
    fireEvent.click(screen.getByRole('button', { name: 'Save de-anonymised' }));
    expect(save).toHaveBeenLastCalledWith(expect.stringContaining('@alice:matrix.org left.'), 'deanonymised.md', 'text/markdown');
    fireEvent.click(screen.getByRole('button', { name: '1 rageshake ▾' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save rs-anonym.tar.gz' }));
    expect(save).toHaveBeenLastCalledWith(expect.any(Uint8Array), 'rs-anonym.tar.gz', 'application/gzip');
    fireEvent.click(screen.getByRole('button', { name: /Forget all/ }));
    expect(useAnonymizeSessionStore.getState().jobs).toEqual([]);
    expect(revoke).toHaveBeenCalledWith('blob:http://localhost/1');
    act(() => useAnonymizeSessionStore.setState({ report: '# Case' }));

    fireEvent.click(screen.getByRole('button', { name: 'Show de-anonymised markdown source' }));
    expect(screen.getByLabelText('De-anonymised').textContent).toContain('# Case');
  });

  it('renders pasted anonymised text, keeps it editable, and copies its source', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<MemoryRouter><AnonymizeView /></MemoryRouter>);

    const input = screen.getByRole('textbox', { name: 'Anonymised' });
    fireEvent.paste(input);
    fireEvent.change(input, { target: { value: '# Notes' } });
    // Rendered on both sides now: the left after the paste, the right always.
    expect(screen.getAllByRole('heading', { name: 'Notes' })).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Show anonymised markdown source' }));
    expect(screen.getByRole('textbox', { name: 'Anonymised' })).toHaveValue('# Notes');

    fireEvent.click(screen.getByRole('button', { name: 'Copy anonymised' }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('# Notes'));
  });

  it('anonymises files dropped, picked, or chosen from the keyboard', () => {
    const anonymiseFiles = vi.fn().mockResolvedValue(undefined);
    useAnonymizeSessionStore.setState({ anonymiseFiles });
    render(<MemoryRouter><AnonymizeView /></MemoryRouter>);
    const zone = screen.getByRole('button', { name: 'Choose rageshakes to anonymise' });
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
    expect(anonymiseFiles).toHaveBeenCalledTimes(2);
  });

  it('loads a text file dropped on the rageshake zone as the report', async () => {
    const anonymiseFiles = vi.fn().mockResolvedValue(undefined);
    useAnonymizeSessionStore.setState({ anonymiseFiles });
    render(<MemoryRouter><AnonymizeView /></MemoryRouter>);
    const zone = screen.getByRole('button', { name: 'Choose rageshakes to anonymise' });
    const archive = new File(['x'], 'rs.tar.gz');
    const txt = Object.assign(new File(['# Report'], 'report.txt'), { text: () => Promise.resolve('# Report') });

    fireEvent.drop(zone, { dataTransfer: { files: [archive, txt], types: ['Files'] } });

    expect(anonymiseFiles).toHaveBeenLastCalledWith([archive], true);
    await vi.waitFor(() => expect(useAnonymizeSessionStore.getState().report).toBe('# Report'));
  });

  it('takes the original on the de-anonymised pane for its mapping only, dropped or chosen', () => {
    const anonymiseFiles = vi.fn().mockResolvedValue(undefined);
    useAnonymizeSessionStore.setState({ anonymiseFiles });
    render(<MemoryRouter><AnonymizeView /></MemoryRouter>);
    const zone = screen.getByRole('button', { name: 'Choose the original rageshake' });
    const file = new File(['x'], 'rs.tar.gz');
    const dataTransfer = { files: [file], types: ['Files'] };

    fireEvent.dragOver(zone, { dataTransfer });
    expect(zone.parentElement?.className).toMatch(/paneDragOver/);
    fireEvent.drop(zone, { dataTransfer });
    expect(anonymiseFiles).toHaveBeenLastCalledWith([file], false);

    const chooser = document.querySelectorAll('input[type="file"]')[2] as HTMLInputElement;
    const click = vi.spyOn(chooser, 'click').mockImplementation(() => {});
    fireEvent.click(zone);
    fireEvent.keyDown(zone, { key: 'Enter' });
    expect(click).toHaveBeenCalledTimes(2);
    // With text but no original yet, a hint under the pane offers the same, as does the header, always.
    act(() => useAnonymizeSessionStore.setState({ report: 'x' }));
    fireEvent.click(screen.getByRole('button', { name: 'choose it' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add original rageshake' }));
    expect(click).toHaveBeenCalledTimes(4);
    fireEvent.change(chooser, { target: { files: [file] } });
    expect(anonymiseFiles).toHaveBeenCalledTimes(2);
    expect(anonymiseFiles).toHaveBeenLastCalledWith([file], false);
  });

  it('loads a markdown file dropped on the anonymised pane and swallows stray file drops', async () => {
    render(<MemoryRouter><AnonymizeView /></MemoryRouter>);
    // jsdom's File lacks text(), which every browser has.
    const md = Object.assign(new File(['# Dropped'], 'r.md'), { text: () => Promise.resolve('# Dropped') });

    fireEvent.drop(screen.getByRole('textbox', { name: 'Anonymised' }), { dataTransfer: { files: [md], types: ['Files'] } });

    await vi.waitFor(() => expect(useAnonymizeSessionStore.getState().report).toBe('# Dropped'));
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
    useAnonymizeSessionStore.setState({ report: 'first\nsecond' });
    render(<MemoryRouter><AnonymizeView /></MemoryRouter>);

    expect(screen.getByLabelText('De-anonymised').querySelector('p')?.innerHTML).toBe('first<br>\nsecond');
  });

  it('keeps editing when pasting into existing text, and shows the drop target while dragging a file', () => {
    render(<MemoryRouter><AnonymizeView /></MemoryRouter>);
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
    render(<MemoryRouter><AnonymizeView /></MemoryRouter>);
    const input = screen.getByRole('textbox', { name: 'Anonymised' });
    fireEvent.paste(input); // e.g. an image: no change follows
    fireEvent.keyDown(input, { key: 'a' });
    fireEvent.change(input, { target: { value: 'a' } });

    expect(screen.getByRole('textbox', { name: 'Anonymised' })).toHaveValue('a');
  });

  it('keeps the zone once originals are loaded, counting them, until there is text', () => {
    const job: AnonymizeJob = {
      id: 1, sourceName: 'rs.tar.gz', status: 'done', message: '', progress: 1, rawUrl: null, save: false,
      output: { name: 'rs-anonym.tar.gz', data: 'x', mime: 'text/plain', dict: { forward: {}, reverse: {} }, isArchive: true },
    };
    useAnonymizeSessionStore.setState({ jobs: [job] });
    render(<MemoryRouter><AnonymizeView /></MemoryRouter>);

    expect(screen.getByRole('button', { name: 'Add another original rageshake' })).toHaveTextContent('1 rageshake loaded');
    act(() => useAnonymizeSessionStore.setState({ report: '# Text' }));
    expect(screen.queryByRole('button', { name: 'Add another original rageshake' })).toBeNull();
  });

  it('routes a dropped file by type, whichever pane it lands on', async () => {
    const anonymiseFiles = vi.fn().mockResolvedValue(undefined);
    useAnonymizeSessionStore.setState({ anonymiseFiles });
    render(<MemoryRouter><AnonymizeView /></MemoryRouter>);
    const archive = new File(['x'], 'rs.tar.gz');
    // jsdom's File lacks text(), which every browser has.
    const md = Object.assign(new File(['# From the right'], 'r.md'), { text: () => Promise.resolve('# From the right') });

    // An archive on the anonymised pane is an original, not text to read.
    fireEvent.drop(screen.getByRole('textbox', { name: 'Anonymised' }), { dataTransfer: { files: [archive], types: ['Files'] } });
    expect(anonymiseFiles).toHaveBeenLastCalledWith([archive], false);
    expect(useAnonymizeSessionStore.getState().report).toBe('');

    // Markdown on the de-anonymised pane is the text to reverse, not a log.
    fireEvent.drop(screen.getByRole('button', { name: 'Choose the original rageshake' }), { dataTransfer: { files: [md], types: ['Files'] } });
    await vi.waitFor(() => expect(useAnonymizeSessionStore.getState().report).toBe('# From the right'));
    expect(anonymiseFiles).toHaveBeenCalledTimes(1);
  });

  it('says how many IDs no loaded rageshake knows, instead of leaving the text silently unchanged', () => {
    const job: AnonymizeJob = {
      id: 1, sourceName: 'other.tar.gz', status: 'done', message: '', progress: 1, rawUrl: null, save: false,
      output: { name: 'other-anonym.tar.gz', data: 'x', mime: 'text/plain', dict: { forward: {}, reverse: {} }, isArchive: true },
    };
    useAnonymizeSessionStore.setState({ jobs: [job], report: '@user-0123456789ab:domain-01234567.org left' });
    render(<MemoryRouter><AnonymizeView /></MemoryRouter>);

    expect(screen.getByText(/1 ID not found in the loaded rageshakes/)).toBeInTheDocument();
  });

  describe('progress notice', () => {
    const done = (id: number, name: string): AnonymizeJob => ({
      id, sourceName: name, status: 'done', message: '', progress: 1, rawUrl: null, save: true,
      output: { name: `${name}-anonym.log`, data: 'x', mime: 'text/plain', dict: { forward: {}, reverse: {} }, isArchive: false },
    });
    const failed: AnonymizeJob = { id: 9, sourceName: 'bad.png', status: 'error', message: 'not a text log', progress: 1, output: null, rawUrl: null, save: true };
    const working: AnonymizeJob = { ...failed, status: 'working', message: 'Reading', progress: 0.5 };

    it('shows the drop\'s progress, asks nothing, and cannot be closed while working', () => {
      useAnonymizeSessionStore.setState({ jobs: [done(1, 'a'), working], batch: { jobIds: [1, 9], dismissed: false } });
      render(<MemoryRouter><AnonymizeView /></MemoryRouter>);

      // One file done, one halfway: 75% of the drop.
      expect(screen.getByRole('status')).toHaveTextContent('Anonymising 2 rageshakes75%');
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '75');
      expect(screen.getByRole('status').querySelectorAll('button')).toHaveLength(0);
    });

    it('closes by itself once done', () => {
      useAnonymizeSessionStore.setState({ jobs: [done(1, 'a'), done(2, 'b')], batch: { jobIds: [1, 2], dismissed: false } });
      render(<MemoryRouter><AnonymizeView /></MemoryRouter>);

      expect(screen.queryByRole('status')).toBeNull();
      expect(useAnonymizeSessionStore.getState().batch?.dismissed).toBe(true);
    });

    it('stays when something failed, opens the list from the failure count, and can then be closed', () => {
      useAnonymizeSessionStore.setState({ jobs: [done(1, 'a'), failed], batch: { jobIds: [1, 9], dismissed: false } });
      render(<MemoryRouter><AnonymizeView /></MemoryRouter>);

      expect(screen.getByRole('status')).toHaveTextContent('1 of 2 anonymised1 failed');
      fireEvent.click(screen.getByRole('button', { name: '1 failed' }));
      expect(screen.getByText('not a text log')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
      expect(screen.queryByRole('status')).toBeNull();
    });
  });
});

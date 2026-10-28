import { describe, it, expect, afterEach, afterAll, vi } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AnonymizeView } from '../AnonymizeView';
import { useAnonymizeSessionStore } from '../../stores/anonymizeSessionStore';
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
        id: 0, sourceName: 'rs.tar.gz', status: 'done', message: '', rawUrl: 'blob:http://localhost/1',
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

    fireEvent.click(screen.getByRole('checkbox', { name: 'Auto-save' }));
    expect(useAnonymizeSessionStore.getState().autoSave).toBe(false);
    fireEvent.dragOver(zone, { dataTransfer });
    expect(zone.className).toMatch(/dragOver/);
    fireEvent.dragLeave(zone);
    expect(zone.className).not.toMatch(/dragOver/);
    fireEvent.drop(zone, { dataTransfer });
    expect(anonymiseFiles).toHaveBeenLastCalledWith([file]);

    fireEvent.click(zone);
    fireEvent.keyDown(zone, { key: 'Enter' });
    expect(click).toHaveBeenCalledTimes(2);
    fireEvent.change(input, { target: { files: [file] } });
    expect(anonymiseFiles).toHaveBeenCalledTimes(2);
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
});

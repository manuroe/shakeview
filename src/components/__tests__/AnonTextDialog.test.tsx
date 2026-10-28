import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AnonTextDialog } from '../AnonTextDialog';
import { KeyboardShortcutContext } from '../KeyboardShortcutContext';
import type { KeyboardShortcutContextValue } from '../KeyboardShortcutContext';
import { useLogStore } from '../../stores/logStore';
import { useAnonSaltStore } from '../../stores/anonSaltStore';
import { useArchiveStore } from '../../stores/archiveStore';
import { strToU8 } from 'fflate';
import {
  applyAnonymization,
  buildAnonymizationDictionary,
  buildAnonymizationDictionaryFromTexts,
} from '../../utils/anonymizeUtils';
import { createParsedLogLine } from '../../test/fixtures';

const SALT = 'test-salt';
const USER_ALIAS_RE = /^@user-[0-9a-f]{12}:domain-[0-9a-f]{8}\.org$/;

const inputBox = () => screen.getByLabelText(/text to (un)?anonymise/i);
const resultBox = () => screen.getByLabelText('Result') as HTMLTextAreaElement;

/** Alias `text` the same way the dialog does, for asserting on its output. */
async function aliasOf(text: string): Promise<string> {
  return applyAnonymization(text, await buildAnonymizationDictionaryFromTexts([text], SALT));
}

describe('AnonTextDialog', () => {
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

  beforeEach(() => {
    useLogStore.getState().clearData();
    useAnonSaltStore.setState({ salt: SALT });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => {
    if (originalClipboard) {
      Object.defineProperty(navigator, 'clipboard', originalClipboard);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deleting a non-standard JSDOM property
      delete (navigator as any).clipboard;
    }
    vi.restoreAllMocks();
    useLogStore.getState().clearData();
    useArchiveStore.getState().clearArchive();
  });

  it('anonymises pasted text with the stored salt', async () => {
    render(<AnonTextDialog onClose={vi.fn()} />);
    fireEvent.change(inputBox(), { target: { value: '@alice:example.org joined' } });

    const expected = await aliasOf('@alice:example.org joined');
    expect(await screen.findByDisplayValue(expected)).toBeInTheDocument();
    expect(expected.split(' ')[0]).toMatch(USER_ALIAS_RE);
  });

  it('produces the same alias the loaded log would get', async () => {
    // Aliases are a pure function of salt + identifier, so pasted prose lines up
    // with the anonymised log without any mapping.
    const logDict = await buildAnonymizationDictionary(
      [createParsedLogLine({ lineNumber: 0, rawText: '@alice:example.org joined' })],
      SALT,
    );
    render(<AnonTextDialog onClose={vi.fn()} />);
    fireEvent.change(inputBox(), { target: { value: '@alice:example.org' } });

    expect(await screen.findByDisplayValue(logDict.forward['@alice:example.org'])).toBeInTheDocument();
  });

  it('unanonymises an alias back to the original using the loaded log', async () => {
    useLogStore.setState({
      rawLogLines: [createParsedLogLine({ lineNumber: 0, rawText: '@alice:example.org joined' })],
    });
    const alias = await aliasOf('@alice:example.org');

    render(<AnonTextDialog onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Unanonymise' }));
    fireEvent.change(inputBox(), { target: { value: alias } });

    expect(await screen.findByDisplayValue('@alice:example.org')).toBeInTheDocument();
  });

  it('unanonymises an identifier seen only in another file of the archive', async () => {
    useArchiveStore.getState().loadArchive('rs.tar.gz', [
      { name: 'rs/console.log', data: strToU8('@alice:example.org joined') },
      { name: 'rs/details.json', data: strToU8('{"user":"@bob:example.org"}') },
    ]);
    useLogStore.setState({
      rawLogLines: [createParsedLogLine({ lineNumber: 0, rawText: '@alice:example.org joined' })],
      loadedEntryNames: ['rs/console.log'],
    });
    const alias = await aliasOf('@bob:example.org');

    render(<AnonTextDialog onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Unanonymise' }));
    fireEvent.change(inputBox(), { target: { value: alias } });

    expect(await screen.findByDisplayValue('@bob:example.org')).toBeInTheDocument();
  });

  it('disables unanonymising when no log is loaded', () => {
    render(<AnonTextDialog onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Unanonymise' })).toBeDisabled();
    expect(screen.getByText(/aliases are hashes/i)).toBeInTheDocument();
  });

  it('disables unanonymising for a log loaded already-anonymised without a mapping', () => {
    useLogStore.setState({
      rawLogLines: [createParsedLogLine({ lineNumber: 0, rawText: '@user-aaaaaaaaaaaa:domain-11111111.org joined' })],
      isAnonymized: true,
      anonymizationDictionary: null,
    });
    render(<AnonTextDialog onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Unanonymise' })).toBeDisabled();
  });

  it('uses the mapping applied in this session when there is one', async () => {
    useLogStore.setState({
      rawLogLines: [createParsedLogLine({ lineNumber: 0, rawText: '@user-aaaaaaaaaaaa:domain-11111111.org joined' })],
      isAnonymized: true,
      anonymizationDictionary: {
        forward: { '@alice:matrix.org': '@user-aaaaaaaaaaaa:domain-11111111.org' },
        reverse: { '@user-aaaaaaaaaaaa:domain-11111111.org': '@alice:matrix.org' },
      },
    });
    render(<AnonTextDialog onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Unanonymise' }));
    fireEvent.change(inputBox(), { target: { value: '@user-aaaaaaaaaaaa:domain-11111111.org' } });

    expect(await screen.findByDisplayValue('@alice:matrix.org')).toBeInTheDocument();
  });

  it('copies the result to the clipboard', async () => {
    render(<AnonTextDialog onClose={vi.fn()} />);
    fireEvent.change(inputBox(), { target: { value: '@alice:example.org' } });
    expect(await screen.findByDisplayValue(USER_ALIAS_RE)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /copy to clipboard/i }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(resultBox().value);
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('stops showing "Working…" when the input is cleared mid-transform', async () => {
    // A hash that never settles: the abandoned run cannot clear the flag itself.
    vi.spyOn(crypto.subtle, 'digest').mockReturnValue(new Promise<ArrayBuffer>(() => {}));
    render(<AnonTextDialog onClose={vi.fn()} />);
    fireEvent.change(inputBox(), { target: { value: '@alice:example.org' } });
    expect(await screen.findByText('Working…')).toBeInTheDocument();

    fireEvent.change(inputBox(), { target: { value: '' } });
    expect(await screen.findByText('Result')).toBeInTheDocument();
  });

  it('restores focus to the opener on close', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = render(<AnonTextDialog onClose={vi.fn()} />);
    expect(document.activeElement).toBe(inputBox());

    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('switches back to anonymising after unanonymising', async () => {
    useLogStore.setState({
      rawLogLines: [createParsedLogLine({ lineNumber: 0, rawText: '@alice:example.org joined' })],
    });
    render(<AnonTextDialog onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Unanonymise' }));
    fireEvent.click(screen.getByRole('button', { name: 'Anonymise' }));
    fireEvent.change(inputBox(), { target: { value: '@alice:example.org' } });

    expect(await screen.findByDisplayValue(USER_ALIAS_RE)).toBeInTheDocument();
  });

  it('reports a failure when hashing is unavailable', async () => {
    vi.spyOn(crypto.subtle, 'digest').mockRejectedValue(new Error('insecure context'));
    render(<AnonTextDialog onClose={vi.fn()} />);
    fireEvent.change(inputBox(), { target: { value: '@alice:example.org' } });

    expect(await screen.findByText(/could not anonymise the text/i)).toBeInTheDocument();
    expect(resultBox().value).toBe('');
  });

  it('reports a failure when the log mapping cannot be built', async () => {
    useLogStore.setState({
      rawLogLines: [createParsedLogLine({ lineNumber: 0, rawText: '@alice:example.org joined' })],
    });
    vi.spyOn(crypto.subtle, 'digest').mockRejectedValue(new Error('insecure context'));
    render(<AnonTextDialog onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Unanonymise' }));

    expect(await screen.findByText(/could not build the mapping from this log/i)).toBeInTheDocument();
  });

  it('reports a failure when the clipboard rejects the copy', async () => {
    (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('denied'));
    render(<AnonTextDialog onClose={vi.fn()} />);
    fireEvent.change(inputBox(), { target: { value: '@alice:example.org' } });
    expect(await screen.findByDisplayValue(USER_ALIAS_RE)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /copy to clipboard/i }));
    expect(await screen.findByText(/could not copy to the clipboard/i)).toBeInTheDocument();
    expect(screen.queryByText('Copied')).not.toBeInTheDocument();
  });

  it('close button fires onClose', () => {
    const onClose = vi.fn();
    render(<AnonTextDialog onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /close anonymise text dialog/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape when no central shortcut handler is present', () => {
    const onClose = vi.fn();
    render(<AnonTextDialog onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('registers dismiss and defers Escape to the central shortcut handler when present', () => {
    const registerDismiss = vi.fn(() => vi.fn());
    const onClose = vi.fn();
    const ctx: KeyboardShortcutContextValue = {
      showHelp: false,
      toggleHelp: vi.fn(),
      pendingChord: null,
      registerFocusSearch: vi.fn(() => vi.fn()),
      registerFocusFilter: vi.fn(() => vi.fn()),
      registerDismiss,
    };
    render(
      <KeyboardShortcutContext.Provider value={ctx}>
        <AnonTextDialog onClose={onClose} />
      </KeyboardShortcutContext.Provider>,
    );
    expect(registerDismiss).toHaveBeenCalledWith(onClose);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on backdrop click but not on clicks inside the panel', () => {
    const onClose = vi.fn();
    render(<AnonTextDialog onClose={onClose} />);
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('dialog').parentElement as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('traps Tab focus within the dialog', () => {
    render(<AnonTextDialog onClose={vi.fn()} />);
    const panel = screen.getByRole('dialog');
    const focusable = Array.from(
      panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    first.focus();
    fireEvent.keyDown(panel, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
    last.focus();
    fireEvent.keyDown(panel, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
  });

  it('leaves focus alone when Tab is pressed away from a boundary', () => {
    render(<AnonTextDialog onClose={vi.fn()} />);
    const panel = screen.getByRole('dialog');
    const input = inputBox();
    input.focus();
    fireEvent.keyDown(panel, { key: 'Tab' });
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(panel, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(input);
  });
});

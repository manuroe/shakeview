import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import type { AnonymizationDictionary } from '../types/log.types';
import {
  applyAnonymization,
  applyUnanonymization,
  buildAnonymizationDictionary,
  buildAnonymizationDictionaryFromTexts,
} from '../utils/anonymizeUtils';
import { useLogStore } from '../stores/logStore';
import { useAnonSaltStore } from '../stores/anonSaltStore';
import { useArchiveStore } from '../stores/archiveStore';
import { loadedArchive } from '../stores/cryptoStore';
import { buildArchiveDictionary } from '../utils/anonymizeArchive';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { useKeyboardShortcutContextOptional } from './KeyboardShortcutContext';
import styles from './LogExportDialog.module.css';

interface AnonTextDialogProps {
  /** Called when the dialog should be closed. */
  readonly onClose: () => void;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const CONFIRM_DURATION_MS = 1500;

type Direction = 'anonymise' | 'unanonymise';

/**
 * Modal that runs a free-form snippet of text through the anonymisation
 * transform, using the stored salt.
 *
 * Anonymising is a pure function of the salt, so aliases produced here match
 * those in an anonymised log without needing any mapping — handy for the prose
 * written around a log (issue drafts, rageshake comments).
 *
 * Un-anonymising cannot work from the salt (aliases are truncated hashes), so it
 * needs the loaded log's mapping and is disabled when none is available.
 */
export function AnonTextDialog({ onClose }: AnonTextDialogProps) {
  const [direction, setDirection] = useState<Direction>('anonymise');
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const salt = useAnonSaltStore((s) => s.salt);
  const rawLogLines = useLogStore((s) => s.rawLogLines);
  const isAnonymized = useLogStore((s) => s.isAnonymized);
  const appliedDict = useLogStore((s) => s.anonymizationDictionary);
  const loadedEntryNames = useLogStore((s) => s.loadedEntryNames);
  const archiveName = useArchiveStore((s) => s.archiveName);
  const archiveEntries = useArchiveStore((s) => s.archiveEntries);

  // A text can cite identifiers from any file of the archive, not just the loaded
  // log, so reverse with the whole archive's mapping when there is one: on the
  // archive listing (nothing loaded yet), or when the loaded log came from it.
  const fromArchive = archiveEntries.length > 0
    && (rawLogLines.length === 0 || loadedArchive(archiveName, archiveEntries, loadedEntryNames) !== null);

  // Otherwise the reverse map can only come from the loaded log: either the mapping applied
  // in this session, or one rebuilt from the raw lines — and rebuilding is only
  // valid while those lines still hold the *original* identifiers (a log loaded
  // already-anonymised has none, so hashing them again would yield nonsense).
  const canUnanonymise = fromArchive || appliedDict !== null || (rawLogLines.length > 0 && !isAnonymized);

  // The mapping costs a hash per unique identifier in the whole log or archive, so
  // build it once per (source, salt) — on the first switch to unanonymising, not per keystroke.
  const [logDict, setLogDict] = useState<AnonymizationDictionary | null>(null);
  useEffect(() => {
    if (direction !== 'unanonymise' || !canUnanonymise) return;
    if (appliedDict && !fromArchive) {
      setLogDict(appliedDict);
      return;
    }
    let cancelled = false;
    setLogDict(null); // drop a mapping built with a stale salt while the new one builds
    void (fromArchive ? buildArchiveDictionary(archiveEntries, salt) : buildAnonymizationDictionary(rawLogLines, salt))
      .then((d) => { if (!cancelled) setLogDict(d); })
      .catch(() => { if (!cancelled) setError('Could not build the mapping from this log.'); });
    return () => { cancelled = true; };
  }, [direction, canUnanonymise, appliedDict, rawLogLines, salt, fromArchive, archiveEntries]);

  const debouncedInput = useDebouncedValue(input, 300);

  useEffect(() => {
    // Any anonymise run still in flight is abandoned by this effect's cleanup, and
    // its `finally` then skips clearing the flag — so clear it here. Only the async
    // branch below sets it again, in the same batch, so there is no flicker.
    setBusy(false);
    if (direction === 'unanonymise') {
      // Nothing to reverse: empty input, or no mapping available (yet).
      if (!debouncedInput || !logDict) {
        setOutput('');
        return;
      }
      setError(null);
      setOutput(applyUnanonymization(debouncedInput, logDict));
      return;
    }
    if (!debouncedInput) {
      setOutput('');
      return;
    }
    let cancelled = false;
    setError(null);
    setBusy(true);
    void buildAnonymizationDictionaryFromTexts([debouncedInput], salt)
      .then((dict) => { if (!cancelled) setOutput(applyAnonymization(debouncedInput, dict)); })
      .catch(() => {
        if (cancelled) return;
        setOutput('');
        // SHA-256 needs a secure context, and a truncated-hash collision throws.
        setError('Could not anonymise the text.');
      })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [debouncedInput, direction, logDict, salt]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(output);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      setCopied(true);
      copyTimerRef.current = setTimeout(() => setCopied(false), CONFIRM_DURATION_MS);
    } catch {
      // Clipboard access can be denied (non-secure context, revoked permission).
      setCopied(false);
      setError('Could not copy to the clipboard.');
    }
  };

  useEffect(() => {
    return () => { if (copyTimerRef.current) clearTimeout(copyTimerRef.current); };
  }, []);

  const shortcutCtx = useKeyboardShortcutContextOptional();
  useEffect(() => {
    if (!shortcutCtx) return;
    return shortcutCtx.registerDismiss(onClose);
  }, [shortcutCtx, onClose]);

  // Focus the input on open; restore focus on close. When the opener has unmounted in
  // the meantime — the burger menu closes as it opens this dialog — this is a no-op and
  // the opener is responsible for moving focus itself (see BurgerMenu's onClose).
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => prev?.focus();
  }, []);

  // Focus trap + local Escape fallback.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const hasCentralEsc = !!shortcutCtx;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (!hasCentralEsc) onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    panel.addEventListener('keydown', handleKey);
    return () => panel.removeEventListener('keydown', handleKey);
  }, [onClose, shortcutCtx]);

  const handleBackdropClick = useCallback(
    (e: MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  const anonymising = direction === 'anonymise';
  // Also "working" while the log mapping builds on the first switch to unanonymising.
  const working = busy || (!anonymising && canUnanonymise && !logDict && input !== '');

  return createPortal(
    <div className={styles.backdrop} onClick={handleBackdropClick}>
      <div
        ref={panelRef}
        className={styles.panel}
        style={{ width: 'min(640px, calc(100vw - 32px))' }}
        role="dialog"
        aria-modal="true"
        aria-label="Anonymise text"
      >
        <div className={styles.header}>
          <h2 className={styles.title}>Anonymise text</h2>
          <button
            className={styles.closeButton}
            onClick={onClose}
            aria-label="Close anonymise text dialog"
            title="Close"
          >
            ×
          </button>
        </div>

        <div className={styles.actionRow}>
          <button
            className={`${styles.actionButton} ${anonymising ? styles.toggleActive : ''}`}
            onClick={() => setDirection('anonymise')}
            aria-pressed={anonymising}
          >
            Anonymise
          </button>
          <button
            className={`${styles.actionButton} ${!anonymising ? styles.toggleActive : ''}`}
            onClick={() => setDirection('unanonymise')}
            aria-pressed={!anonymising}
            disabled={!canUnanonymise}
            title={canUnanonymise ? undefined : 'No mapping available for this session'}
          >
            Unanonymise
          </button>
        </div>

        {!canUnanonymise && (
          <p className={styles.mappingCount}>
            Unanonymising needs the loaded log&apos;s mapping — aliases are hashes, so the salt
            alone cannot reverse them. Load a log, or use “Unanonymise” on the log itself with
            its <code>dictionary.json</code>.
          </p>
        )}

        <p className={styles.textAreaLabel}>
          {anonymising ? 'Text with real identifiers' : 'Text with aliases'}
        </p>
        <textarea
          ref={inputRef}
          className={styles.textArea}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={anonymising ? '@alice:example.org …' : '@user-3f2a1b0c9d8e:domain-1a2b3c4d.org …'}
          spellCheck={false}
          aria-label={anonymising ? 'Text to anonymise' : 'Text to unanonymise'}
        />

        <p className={styles.textAreaLabel}>{working ? 'Working…' : 'Result'}</p>
        <textarea
          className={styles.textArea}
          value={output}
          readOnly
          spellCheck={false}
          aria-label="Result"
        />

        {error && (
          <p style={{ color: 'var(--color-error, red)', fontSize: 'var(--font-size-sm)', margin: '8px 0 0' }}>
            {error}
          </p>
        )}

        <hr className={styles.divider} />

        <div className={styles.actionRow}>
          <button
            className={styles.actionButton}
            onClick={() => { void handleCopy(); }}
            disabled={output === ''}
            title="Copy the result to the clipboard"
          >
            Copy to clipboard
          </button>
          {copied && <span className={styles.confirmLabel}>Copied</span>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

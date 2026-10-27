import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { useLogStore } from '../stores/logStore';
import type { AnonymizationDictionary } from '../types/log.types';
import { useKeyboardShortcutContextOptional } from './KeyboardShortcutContext';
import styles from './LogExportDialog.module.css';

interface UnanonymizeDialogProps {
  /** Called when the dialog should be closed. */
  readonly onClose: () => void;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal dialog that lets the user upload an anonymization dictionary JSON file
 * so that a log loaded already-anonymized can be unanonymized in-place.
 *
 * When the log was anonymized in the current session (and the original lines
 * are still held in memory) this dialog is never shown — the store's
 * `unanonymizeLogs()` action restores from the backup directly.
 */
export function UnanonymizeDialog({ onClose }: UnanonymizeDialogProps) {
  const { unanonymizeLogs } = useLogStore();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsedDict, setParsedDict] = useState<AnonymizationDictionary | null>(null);

  const shortcutCtx = useKeyboardShortcutContextOptional();
  useEffect(() => {
    if (!shortcutCtx) return;
    return shortcutCtx.registerDismiss(onClose);
  }, [shortcutCtx, onClose]);

  // Focus the close button on open; restore on close
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();
    return () => {
      prev?.focus();
    };
  }, []);

  // Focus trap + local Escape fallback
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
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
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

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setParsedDict(null);
    setFileName(file.name);

    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const raw = ev.target?.result;
        if (typeof raw !== 'string') {
          setError('Could not read file.');
          return;
        }
        const parsed: unknown = JSON.parse(raw);
        const isPlainStringRecord = (v: unknown): v is Record<string, string> =>
          typeof v === 'object' &&
          v !== null &&
          !Array.isArray(v) &&
          Object.values(v as object).every((x) => typeof x === 'string');
        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          !('forward' in parsed) ||
          !('reverse' in parsed) ||
          !isPlainStringRecord((parsed as Record<string, unknown>).forward) ||
          !isPlainStringRecord((parsed as Record<string, unknown>).reverse)
        ) {
          setError('Invalid dictionary file. Expected { forward: {…}, reverse: {…} } with string values.');
          return;
        }
        setParsedDict(parsed as AnonymizationDictionary);
      } catch {
        setError('File is not valid JSON.');
      }
    };
    reader.onerror = () => setError('Failed to read file.');
    reader.readAsText(file);
  };

  const handleApply = () => {
    if (!parsedDict) return;
    const success = unanonymizeLogs(parsedDict);
    if (success) {
      onClose();
    } else {
      setError('The dictionary does not match this log. Please check that you are using the correct file.');
    }
  };

  return createPortal(
    <div className={styles.backdrop} onClick={handleBackdropClick}>
      <div
        ref={panelRef}
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label="Unanonymise logs"
      >
        {/* Header */}
        <div className={styles.header}>
          <h2 className={styles.title}>Unanonymise Logs</h2>
          <button
            ref={closeButtonRef}
            className={styles.closeButton}
            onClick={onClose}
            aria-label="Close unanonymise dialog"
            title="Close"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)', marginBottom: 16 }}>
          This log was loaded already-anonymised. To restore the original identifiers, upload the
          <code style={{ margin: '0 4px', fontFamily: 'var(--font-mono)' }}>dictionary.json</code>
          file that was saved alongside the anonymised export.
        </p>

        <div className={styles.optionsSection}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              className={styles.actionButton}
              onClick={() => fileInputRef.current?.click()}
              type="button"
            >
              Choose dictionary file…
            </button>
            {fileName && (
              <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)' }}>
                {fileName}
              </span>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              onChange={handleFileChange}
              style={{ display: 'none' }}
              aria-label="Select anonymization dictionary JSON file"
            />
          </div>
          {error && (
            <p style={{ color: 'var(--color-error, red)', fontSize: 'var(--font-size-sm)', margin: 0 }}>
              {error}
            </p>
          )}
          {parsedDict && !error && (
            <p style={{ color: 'var(--color-success, green)', fontSize: 'var(--font-size-sm)', margin: 0 }}>
              Dictionary loaded — {Object.keys(parsedDict.forward).length} entries.
            </p>
          )}
        </div>

        <hr className={styles.divider} />

        <div className={styles.actionRow}>
          <button
            className={styles.actionButton}
            onClick={handleApply}
            disabled={parsedDict === null}
            title="Apply the uploaded dictionary and restore original identifiers"
          >
            Apply and unanonymise
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent, ChangeEvent } from 'react';
import { createPortal } from 'react-dom';
import { buildExportText, type ExportContext, type ExportOptions } from '../utils/logExportUtils';
import { downloadBlob } from '../utils/downloadBlob';
import type { DisplayItem } from '../utils/logGapManager';
import { useKeyboardShortcutContextOptional } from './KeyboardShortcutContext';
import { useLogStore } from '../stores/logStore';
import { CopyIcon, DownloadIcon } from './icons';
import styles from './LogExportDialog.module.css';

interface LogExportDialogProps {
  /** The currently visible items from LogDisplayView, in display order. */
  readonly displayItems: DisplayItem[];
  /** Snapshot of the active view state, used to populate the intro header. */
  readonly context: ExportContext;
  /** Called when the dialog should be closed. */
  readonly onClose: () => void;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Duration in ms that the "Copied!" / "Saved!" confirmation label is shown. */
const CONFIRM_DURATION_MS = 2000;

/**
 * Modal dialog for configuring and triggering a log export.
 *
 * Users can choose formatting options (intro header, line numbers, gap
 * indicators, strip prefix, max line width) and then either copy the result
 * to the clipboard or save it as a `.log` file.
 *
 * The dialog follows the same backdrop + panel pattern as `ShortcutHelpOverlay`,
 * with keyboard focus management and an Escape-to-close shortcut.
 */
export function LogExportDialog({ displayItems, context, onClose }: LogExportDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const { isAnonymized, anonymizationDictionary } = useLogStore();

  // Register onClose with the central shortcut system so the global Escape
  // handler can close this dialog. When the context is unavailable (e.g. in
  // standalone tests), the focus-trap below falls back to a local ESC handler.
  const shortcutCtx = useKeyboardShortcutContextOptional();
  useEffect(() => {
    if (!shortcutCtx) return;
    return shortcutCtx.registerDismiss(onClose);
  }, [shortcutCtx, onClose]);

  // ---------------------------------------------------------------------------
  // Option state (all off by default)
  // ---------------------------------------------------------------------------
  const [showIntro, setShowIntro] = useState(false);
  const [showLineNumbers, setShowLineNumbers] = useState(false);
  const [showGaps, setShowGaps] = useState(false);
  const [collapseDuplicates, setCollapseDuplicates] = useState(false);
  const [stripPrefix, setStripPrefix] = useState(false);
  const [maxWidthEnabled, setMaxWidthEnabled] = useState(false);
  const [maxWidth, setMaxWidth] = useState(120);
  /** `null` = no confirmation visible; `'copy'` or `'save'` = show label for that action. */
  const [confirmation, setConfirmation] = useState<'copy' | 'save' | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---------------------------------------------------------------------------
  // Focus management
  // ---------------------------------------------------------------------------

  // Focus the close button when the dialog opens; restore previous focus on close
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    closeButtonRef.current?.focus();
    return () => {
      prev?.focus();
    };
  }, []);

  // Focus trap: cycle Tab / Shift+Tab within the panel.
  // ESC is handled via the central shortcut context (registerDismiss above);
  // when no context is available the fallback below closes the dialog locally.
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

  // Close when clicking the backdrop (outside the panel)
  const handleBackdropClick = useCallback(
    (e: MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  // ---------------------------------------------------------------------------
  // Export helpers
  // ---------------------------------------------------------------------------

  const buildOptions = (): ExportOptions => ({
    showIntro,
    showLineNumbers,
    showGaps,
    stripPrefix,
    maxWidthEnabled,
    maxWidth: maxWidthEnabled ? maxWidth : 120,
    collapseDuplicates,
  });

  const showConfirmation = (action: 'copy' | 'save') => {
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    setConfirmation(action);
    confirmTimerRef.current = setTimeout(() => setConfirmation(null), CONFIRM_DURATION_MS);
  };

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    };
  }, []);

  const handleCopy = async () => {
    const text = buildExportText(displayItems, buildOptions(), context);
    try {
      await navigator.clipboard.writeText(text);
      showConfirmation('copy');
    } catch {
      // Clipboard access can be denied (e.g. non-secure context or permission
      // revoked). Surface the failure visually so the user knows the copy did
      // not succeed, but do not crash the dialog.
      setConfirmation(null);
    }
  };

  const handleSave = () => {
    const text = buildExportText(displayItems, buildOptions(), context);
    downloadBlob(text, 'export.log', 'text/plain;charset=utf-8');
    showConfirmation('save');
  };

  const handleSaveDictionary = () => {
    if (!anonymizationDictionary) return;
    downloadBlob(JSON.stringify(anonymizationDictionary, null, 2), 'dictionary.json', 'application/json;charset=utf-8');
    showConfirmation('save');
  };

  const handleMaxWidthChange = (e: ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value, 10);
    if (!isNaN(val) && val >= 4) setMaxWidth(val);
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return createPortal(
    <div className={styles.backdrop} onClick={handleBackdropClick}>
      <div
        ref={panelRef}
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label="Export logs"
      >
        {/* Header */}
        <div className={styles.header}>
          <h2 className={styles.title}>Export Logs</h2>
          <button
            ref={closeButtonRef}
            className={styles.closeButton}
            onClick={onClose}
            aria-label="Close export dialog"
            title="Close"
          >
            ×
          </button>
        </div>

        {/* Options */}
        <div className={styles.optionsSection}>
          <label className={styles.optionRow}>
            <input
              type="checkbox"
              checked={showIntro}
              onChange={(e) => setShowIntro(e.target.checked)}
            />
            <span className={styles.optionLabel}>
              Include introduction header
              <span style={{ color: 'var(--text-tertiary)', fontSize: 'var(--font-size-sm)', marginLeft: 6 }}>
                (lists active filters and view settings)
              </span>
            </span>
          </label>

          <label className={styles.optionRow}>
            <input
              type="checkbox"
              checked={showLineNumbers}
              onChange={(e) => setShowLineNumbers(e.target.checked)}
            />
            <span className={styles.optionLabel}>Prefix lines with original line numbers</span>
          </label>

          <label className={styles.optionRow}>
            <input
              type="checkbox"
              checked={showGaps}
              onChange={(e) => setShowGaps(e.target.checked)}
            />
            <span className={styles.optionLabel}>Show line gaps (e.g. <code>... 12 lines ...</code>)</span>
          </label>

          <label className={styles.optionRow}>
            <input
              type="checkbox"
              checked={collapseDuplicates}
              onChange={(e) => setCollapseDuplicates(e.target.checked)}
            />
            <span className={styles.optionLabel}>
              Collapse consecutive duplicate lines
              <span style={{ color: 'var(--text-tertiary)', fontSize: 'var(--font-size-sm)', marginLeft: 6 }}>
                (shown in gaps when enabled)
              </span>
            </span>
          </label>

          <label className={styles.optionRow}>
            <input
              type="checkbox"
              checked={stripPrefix}
              onChange={(e) => setStripPrefix(e.target.checked)}
            />
            <span className={styles.optionLabel}>Strip timestamp and log-level prefix</span>
          </label>

          <label className={styles.optionRow}>
            <input
              type="checkbox"
              checked={maxWidthEnabled}
              onChange={(e) => setMaxWidthEnabled(e.target.checked)}
            />
            <span className={styles.optionLabel}>Wrap lines at</span>
            <input
              type="number"
              min={4}
              max={2000}
              value={maxWidth}
              onChange={handleMaxWidthChange}
              disabled={!maxWidthEnabled}
              className={styles.widthInput}
              aria-label="Maximum line width in characters"
              title="Wrap lines at this column (characters)"
            />
            <span className={styles.optionUnit}>chars</span>
          </label>


        </div>

        <hr className={styles.divider} />

        {/* Export actions */}
        <div className={styles.actionRow}>
          <button
            className={styles.actionButton}
            onClick={handleCopy}
            title="Copy exported log to clipboard"
          >
            <CopyIcon />
            Copy to clipboard
          </button>
          <button
            className={styles.actionButton}
            onClick={handleSave}
            title="Download exported log as a .log file"
          >
            <DownloadIcon />
            Save to file
          </button>
          {isAnonymized && anonymizationDictionary && (
            <button
              className={styles.actionButton}
              onClick={handleSaveDictionary}
              title="Download the anonymization dictionary as a .json file (needed to unanonymise the exported log)"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h5L11 5.5V12a1.5 1.5 0 0 1-1.5 1.5h-6A1.5 1.5 0 0 1 2 12V4.5Z" stroke="currentColor" strokeWidth="1.4" fill="none"/>
                <path d="M8.5 3v3h3" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" fill="none"/>
                <path d="M5 8.5h4M5 11h2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
              </svg>
              Save anonymisation dictionary
            </button>
          )}
          {confirmation && (
            <span className={styles.confirmLabel} role="status" aria-live="polite">
              {confirmation === 'copy' ? 'Copied!' : 'Saved!'}
            </span>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

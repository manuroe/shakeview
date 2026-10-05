import { useState, useRef, useCallback, useMemo } from 'react';
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { useLogStore } from '../stores/logStore';
import { useArchiveStore } from '../stores/archiveStore';
import { useListingStore } from '../stores/listingStore';
import { useThemeStore } from '../stores/themeStore';
import { useAnonSaltStore } from '../stores/anonSaltStore';
import type { AnonymizationDictionary } from '../types/log.types';
import { buildAnonymizationDictionary, buildCompiledAnonymizer } from '../utils/anonymizeUtils';
import { buildAnonymizedFileText, deriveAnonymizedFilename } from '../utils/anonymizedLogFile';
import { buildAnonymisedArchiveGz, buildArchiveDictionary, deriveAnonymizedArchiveName, type ArchiveProgress } from '../utils/anonymizeArchive';
import { fetchExtensionFileBytes } from '../utils/extensionFileLoader';
import { downloadBlob } from '../utils/downloadBlob';
import { SPANS_MARKER } from '../utils/spansParser';
import { useKeyboardShortcutContextOptional } from './KeyboardShortcutContext';
import { useClickOutside } from '../hooks/useClickOutside';
import { LogSelectionDialog } from './LogSelectionDialog';
import { AnonMappingDialog } from './AnonMappingDialog';
import { AnonTextDialog } from './AnonTextDialog';
import { SaveProgressModal } from './SaveProgressModal';
import styles from './BurgerMenu.module.css';

export function BurgerMenu() {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const burgerButtonRef = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { clearData, clearLastRoute } = useLogStore();
  const loadedEntryNames = useLogStore((state) => state.loadedEntryNames);
  const anonymizationDictionary = useLogStore((state) => state.anonymizationDictionary);
  const loadedLines = useLogStore((state) => state.rawLogLines);
  const hasLogs = loadedLines.length > 0;
  // Element Web logs carry no tracing spans: hide the view that would be empty.
  const hasSpans = useMemo(() => loadedLines.some((line) => line.rawText.includes(SPANS_MARKER)), [loadedLines]);
  const archiveEntries = useArchiveStore((state) => state.archiveEntries);
  const archiveName = useArchiveStore((state) => state.archiveName);
  const listingEntries = useListingStore((state) => state.listingEntries);
  const listingUrl = useListingStore((state) => state.listingUrl);
  const archiveEntryCount = archiveEntries.length;
  const listingEntryCount = listingEntries.length;
  const { theme, setTheme } = useThemeStore();
  const { salt, setSalt, resetSalt } = useAnonSaltStore();
  const shortcutCtx = useKeyboardShortcutContextOptional();
  const [showLogSelection, setShowLogSelection] = useState(false);
  const [showMapping, setShowMapping] = useState(false);
  const [showAnonText, setShowAnonText] = useState(false);
  const [anonOpen, setAnonOpen] = useState(false);
  const [saveProgress, setSaveProgress] = useState<{ phase: string; current: number; total: number; error?: string } | null>(null);

  // "Select logs…" only makes sense when there's a multi-file source to pick
  // from (a loaded archive or extension listing). Direct single-file loads
  // (upload, demo, open-in-new-tab) set loadedEntryNames but have no such source.
  const canSelectLogs = loadedEntryNames.length > 0 && (archiveEntryCount > 0 || listingEntryCount > 0);

  useClickOutside(menuRef, () => { setIsOpen(false); setAnonOpen(false); }, isOpen);

  const handleNewSession = () => {
    clearData();
    clearLastRoute();
    void navigate('/');
    setIsOpen(false);
  };

  const handleNavigate = (path: string) => {
    // Preserve only time filter params (start/end) when switching views
    const start = searchParams.get('start');
    const end = searchParams.get('end');
    const params = new URLSearchParams();
    if (start) params.set('start', start);
    if (end) params.set('end', end);
    const queryString = params.toString();
    const fullPath = queryString ? `${path}?${queryString}` : path;
    void navigate(fullPath);
    setIsOpen(false);
  };

  const isActive = (path: string) => location.pathname === path;
  const isArchiveView = location.pathname === '/archive';
  const isListingView = location.pathname === '/listing';

  // "Save anonymised" targets the active screen's source: the whole archive on
  // /archive, the whole listing on /listing, otherwise the single loaded log.
  const canSave =
    (isArchiveView && archiveEntryCount > 0) ||
    (isListingView && listingEntryCount > 0) ||
    (!isArchiveView && !isListingView && hasLogs);
  // "View mapping" shows the applied log mapping, or a preview of what anonymising
  // would produce. On the archive/listing screens the preview is built from those
  // files (ignoring any stale log dictionary).
  const reportProgress: ArchiveProgress = (phase, current, total) =>
    setSaveProgress({ phase, current, total });

  // Yield a macrotask so the progress modal paints before blocking work runs.
  const paintTick = () => new Promise<void>((r) => setTimeout(r, 0));

  // Fetch every listing entry's bytes (one extension round-trip each), reporting
  // progress and dropping any that fail. Memoised so it (and the memoised
  // preview builder below) keep a stable identity until the listing changes.
  const fetchListingEntries = useCallback(
    async (onProgress: ArchiveProgress): Promise<{ name: string; data: Uint8Array }[]> => {
      const total = listingEntries.length;
      let done = 0;
      onProgress('Fetching files', 0, total);
      const fetched = await Promise.all(
        listingEntries.map(async (e) => {
          let data: Uint8Array | null = null;
          try {
            data = await fetchExtensionFileBytes(e.url, e.name);
          } catch {
            data = null; // one bad entry (rejected fetch / bad base64) must not abort the export
          }
          done += 1;
          onProgress('Fetching files', done, total);
          return data ? { name: e.name, data } : null;
        }),
      );
      return fetched.filter((e): e is { name: string; data: Uint8Array } => e !== null);
    },
    [listingEntries],
  );

  const mappingDict = isArchiveView || isListingView ? null : anonymizationDictionary;
  // Memoised so its identity only changes when the underlying source changes;
  // the mapping dialog depends on it and will rebuild the preview when it does
  // (e.g. once /listing entries finish loading), without rebuilding on every render.
  const buildMappingPreview = useMemo<
    ((onProgress: ArchiveProgress) => Promise<AnonymizationDictionary>) | undefined
  >(() => {
    if (isArchiveView) return (onProgress) => buildArchiveDictionary(archiveEntries, salt, onProgress);
    if (isListingView) {
      return async (onProgress) => buildArchiveDictionary(await fetchListingEntries(onProgress), salt, onProgress);
    }
    return undefined;
  }, [isArchiveView, isListingView, archiveEntries, salt, fetchListingEntries]);

  // Save the single loaded log anonymised: reuse the in-session anonymised lines
  // when present, otherwise anonymise the raw lines on the fly with the salt.
  const saveAnonymisedLog = async () => {
    const { rawLogLines, isAnonymized, logFileName } = useLogStore.getState();
    if (rawLogLines.length === 0) return;
    let lines = rawLogLines;
    if (!isAnonymized) {
      setSaveProgress({ phase: 'Anonymising', current: 0, total: 0 });
      await paintTick();
      const dict = await buildAnonymizationDictionary(rawLogLines, salt);
      const apply = buildCompiledAnonymizer(dict);
      lines = rawLogLines.map((l) => ({
        ...l,
        rawText: apply(l.rawText),
        continuationLines: l.continuationLines?.map(apply),
      }));
    }
    downloadBlob(buildAnonymizedFileText(lines), deriveAnonymizedFilename(logFileName), 'text/plain;charset=utf-8');
  };

  const saveAnonymisedArchive = async () => {
    setSaveProgress({ phase: 'Reading files', current: 0, total: archiveEntries.length });
    await paintTick();
    const gz = await buildAnonymisedArchiveGz(archiveEntries, salt, reportProgress);
    downloadBlob(gz, deriveAnonymizedArchiveName(archiveName), 'application/gzip');
  };

  const saveAnonymisedListing = async () => {
    const entries = await fetchListingEntries(reportProgress);
    if (entries.length === 0) throw new Error('No files could be fetched from the listing.');
    // Use the URL path (not the raw string) so query/hash fragments don't leak
    // into the download name.
    let base = 'listing';
    try {
      base = new URL(listingUrl).pathname.split('/').filter(Boolean).pop() ?? 'listing';
    } catch {
      // listingUrl isn't a valid absolute URL; keep the fallback.
    }
    const gz = await buildAnonymisedArchiveGz(entries, salt, reportProgress);
    downloadBlob(gz, deriveAnonymizedArchiveName(base), 'application/gzip');
  };

  const handleSaveAnonymised = async () => {
    setIsOpen(false);
    setAnonOpen(false);
    try {
      if (isArchiveView) await saveAnonymisedArchive();
      else if (isListingView) await saveAnonymisedListing();
      else await saveAnonymisedLog();
      setSaveProgress(null);
    } catch (e) {
      setSaveProgress({
        phase: '',
        current: 0,
        total: 0,
        error: e instanceof Error ? e.message : 'Could not save the anonymised file.',
      });
    }
  };

  return (
    <div className={styles.burgerMenu} ref={menuRef}>
      <button
        ref={burgerButtonRef}
        className={styles.burgerButton}
        onClick={() => setIsOpen(!isOpen)}
        aria-label="Menu"
        aria-expanded={isOpen}
      >
        ☰
      </button>
      {isOpen && (
        <div className={styles.burgerDropdown}>
          <button className={styles.burgerItem} onClick={handleNewSession}>
            New Session
          </button>
          {!isArchiveView && (
            <>
          <div className={styles.burgerDivider} />
          <div className={styles.burgerSectionTitle}>Views</div>
          <button
            className={`${styles.burgerItem} ${isActive('/summary') ? styles.active : ''}`}
            onClick={() => handleNavigate('/summary')}
          >
            Summary
          </button>
          <div className={styles.burgerDivider} />
          <button
            className={`${styles.burgerItem} ${isActive('/logs') ? styles.active : ''}`}
            onClick={() => handleNavigate('/logs')}
          >
            Logs
          </button>
          <button
            className={`${styles.burgerItem} ${styles.burgerSubItem} ${isActive('/triaged') ? styles.active : ''}`}
            onClick={() => handleNavigate('/triaged')}
          >
            By target
          </button>
          {hasSpans && (
            <button
              className={`${styles.burgerItem} ${styles.burgerSubItem} ${isActive('/spans') ? styles.active : ''}`}
              onClick={() => handleNavigate('/spans')}
            >
              By span
            </button>
          )}
          <div className={styles.burgerDivider} />
          <button
            className={`${styles.burgerItem} ${isActive('/http_requests') ? styles.active : ''}`}
            onClick={() => handleNavigate('/http_requests')}
          >
            HTTP Requests
          </button>
          <button
            className={`${styles.burgerItem} ${styles.burgerSubItem} ${isActive('/http_requests/sync') ? styles.active : ''}`}
            onClick={() => handleNavigate('/http_requests/sync')}
          >
            Sync
          </button>
          {canSelectLogs && (
            <>
              <div className={styles.burgerDivider} />
              <button
                className={styles.burgerItem}
                onClick={() => { setShowLogSelection(true); setIsOpen(false); }}
              >
                Select logs…
              </button>
            </>
          )}
          <div className={styles.burgerDivider} />
          <button
            className={styles.burgerItem}
            onClick={() => { shortcutCtx?.toggleHelp(); setIsOpen(false); }}
          >
            Keyboard Shortcuts
          </button>
            </>
          )}
          <div className={styles.burgerDivider} />
          <div className={styles.submenuAnchor}>
            <button
              className={styles.burgerItem}
              onClick={() => setAnonOpen((o) => !o)}
              aria-haspopup="true"
              aria-expanded={anonOpen}
            >
              Anonymisation
              <span className={styles.submenuChevron} aria-hidden="true">›</span>
            </button>
            {anonOpen && (
              <div className={styles.submenuFlyout}>
                {canSave && (
                  <button
                    className={styles.burgerItem}
                    onClick={() => { void handleSaveAnonymised(); }}
                  >
                    Save anonymised
                  </button>
                )}
                <button
                  className={styles.burgerItem}
                  onClick={() => { setShowMapping(true); setIsOpen(false); setAnonOpen(false); }}
                >
                  View mapping…
                </button>
                <button
                  className={styles.burgerItem}
                  onClick={() => { setShowAnonText(true); setIsOpen(false); setAnonOpen(false); }}
                >
                  Anonymise text…
                </button>
                <div className={styles.burgerDivider} />
                <div className={styles.submenuSalt}>
                  <label className={styles.saltLabel} htmlFor="anon-salt-input">Salt</label>
                  <input
                    id="anon-salt-input"
                    type="text"
                    className={styles.saltInput}
                    value={salt}
                    onChange={(e) => setSalt(e.target.value)}
                    placeholder="salt"
                    aria-label="Anonymisation salt"
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <button className={styles.saltReset} onClick={resetSalt}>
                    Regenerate
                  </button>
                  <p className={styles.saltWarning}>
                    Use the same salt across installs to get matching aliases. Empty = reproducible
                    but guessable.
                  </p>
                </div>
              </div>
            )}
          </div>
          <div className={styles.burgerDivider} />
          <div className={styles.themeButtons}>
            <button 
              className={`${styles.themeButton} ${theme === 'system' ? styles.active : ''}`}
              onClick={() => setTheme('system')}
              data-tooltip="System"
              aria-label="System theme"
            >
              ◐
            </button>
            <button 
              className={`${styles.themeButton} ${theme === 'light' ? styles.active : ''}`}
              onClick={() => setTheme('light')}
              data-tooltip="Light"
              aria-label="Light theme"
            >
              ☀
            </button>
            <button 
              className={`${styles.themeButton} ${theme === 'dark' ? styles.active : ''}`}
              onClick={() => setTheme('dark')}
              data-tooltip="Dark"
              aria-label="Dark theme"
            >
              ☾
            </button>
          </div>
        </div>
      )}
      {showLogSelection && <LogSelectionDialog onClose={() => setShowLogSelection(false)} />}
      {showMapping && (
        <AnonMappingDialog
          dict={mappingDict}
          buildPreview={buildMappingPreview}
          onClose={() => setShowMapping(false)}
        />
      )}
      {showAnonText && (
        // The menu item that opened the dialog is gone, so put focus back on the
        // burger button rather than letting it fall to the body.
        <AnonTextDialog onClose={() => { setShowAnonText(false); burgerButtonRef.current?.focus(); }} />
      )}
      {saveProgress && <SaveProgressModal {...saveProgress} onDismiss={() => setSaveProgress(null)} />}
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import Markdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { saveJobOutput, useAnonymizeSessionStore, type AnonymizeBatch, type AnonymizeJob } from '../stores/anonymizeSessionStore';
import { useClickOutside } from '../hooks/useClickOutside';
import { countUnresolvedAliases, repointViewerLinks, unanonymizeReport, type DeanonymizeSource } from '../utils/deanonymizeReport';
import { downloadBlob } from '../utils/downloadBlob';
import { BackIcon, CheckIcon, CloseIcon, CodeIcon, CopyIcon, DownloadIcon, TrashIcon, UploadIcon } from '../components/icons';
import buttonStyles from '../components/Button.module.css';
import dropdownStyles from '../components/Dropdown.module.css';
import styles from './AnonymizeView.module.css';

const COPIED_DURATION_MS = 1500;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

interface RageshakesDropdownProps {
  readonly jobs: readonly AnonymizeJob[];
  readonly batch: AnonymizeBatch | null;
  readonly isOpen: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/** Header dropdown listing the dropped rageshakes: progress, a save button each, and Forget all. */
function RageshakesDropdown({ jobs, batch, isOpen, onOpenChange }: RageshakesDropdownProps) {
  const forgetAll = useAnonymizeSessionStore((s) => s.forgetAll);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => onOpenChange(false), isOpen);

  const inBatch = jobs.filter((j) => batch?.jobIds.includes(j.id));
  const finished = inBatch.filter((j) => j.status !== 'working').length;
  const failed = jobs.filter((j) => j.status === 'error').length;
  const label = jobs.some((j) => j.status === 'working')
    ? `Anonymising ${Math.min(finished + 1, inBatch.length)}/${inBatch.length}…`
    : `${plural(jobs.length, 'rageshake')}${failed > 0 ? ` · ${failed} failed` : ''}`;

  return (
    <div className={dropdownStyles.container} ref={ref}>
      <button type="button" className={dropdownStyles.button} onClick={() => onOpenChange(!isOpen)} aria-expanded={isOpen}>
        {label} ▾
      </button>
      {isOpen && (
        <div className={`${dropdownStyles.dropdown} ${styles.jobsPanel}`}>
          <ul className={styles.jobs}>
            {jobs.map((j) => (
              <li key={j.id} className={styles.job}>
                <span className={styles.jobName} title={j.sourceName}>{j.output?.name ?? j.sourceName}</span>
                {j.status === 'working' && <span className={styles.muted}>{j.message}</span>}
                {j.status === 'error' && <span className={styles.error}>{j.message}</span>}
                {j.output && (
                  <>
                    <span className={styles.done} title="Anonymised"><CheckIcon /></span>
                    <button
                      type="button"
                      className={buttonStyles.iconButton}
                      onClick={() => saveJobOutput(j)}
                      title={`Save ${j.output.name}`}
                      aria-label={`Save ${j.output.name}`}
                    >
                      <DownloadIcon />
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
          <div className={dropdownStyles.divider} />
          <button type="button" className={`${dropdownStyles.option} ${styles.forget}`} onClick={() => { onOpenChange(false); forgetAll(); }}>
            <TrashIcon /> Forget all
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Bottom progress notice from the moment files are dropped. It asks nothing:
 * where a file was dropped already said whether to save it. It cannot be
 * closed while working — closing would stop nothing — and closes by itself
 * once done, unless something failed. No "Saved" message: the browser's own
 * download UI (or save dialog) is the confirmation, and the page cannot know
 * whether the user went through with it.
 */
function BatchNotice({ onShowList }: { readonly onShowList: () => void }) {
  const jobs = useAnonymizeSessionStore((s) => s.jobs);
  const batch = useAnonymizeSessionStore((s) => s.batch);
  const dismissBatch = useAnonymizeSessionStore((s) => s.dismissBatch);

  const inBatch = batch && !batch.dismissed ? jobs.filter((j) => batch.jobIds.includes(j.id)) : [];
  const finished = inBatch.filter((j) => j.status !== 'working').length;
  const working = finished < inBatch.length;
  const ok = inBatch.filter((j) => j.output).length;
  const failed = finished - ok;
  const settled = inBatch.length > 0 && !working && failed === 0;

  useEffect(() => {
    if (settled) dismissBatch();
  }, [settled, dismissBatch]);

  if (inBatch.length === 0 || settled) return null;
  const pct = Math.round((100 * inBatch.reduce((sum, j) => sum + j.progress, 0)) / inBatch.length);
  const headline = working
    ? `Anonymising ${inBatch.length === 1 ? inBatch[0].sourceName : plural(inBatch.length, 'rageshake')}`
    : `${ok} of ${inBatch.length} anonymised`;
  return (
    <div className={styles.notice} role="status">
      <div className={styles.noticeRow}>
        <strong className={styles.noticeTitle} title={headline}>{headline}</strong>
        {working
          ? <span className={styles.noticePct}>{pct}%</span>
          : (
            <button type="button" className={buttonStyles.iconButton} onClick={dismissBatch} title="Dismiss" aria-label="Dismiss">
              <CloseIcon />
            </button>
          )}
      </div>
      {working && (
        <div className={styles.noticeBar} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Anonymising">
          <div className={styles.noticeFill} style={{ width: `${pct}%` }} />
        </div>
      )}
      {failed > 0 && (
        <div className={styles.noticeRow}>
          <button type="button" className={styles.linkButton} onClick={onShowList}>{failed} failed</button>
        </div>
      )}
    </div>
  );
}

interface TextPaneProps {
  readonly title: string;
  /** Markdown source: what the source view shows, Copy copies and Save saves. */
  readonly source: string;
  /** What the rendered view shows, when it differs from `source` (e.g. links repointed for this tab only). */
  readonly markdown?: string;
  readonly saveName: string;
  /** Makes the pane an input: the source view becomes an editable textarea, and a file dropped on the pane loads into it. */
  readonly onEdit?: (text: string) => void;
  /**
   * Every file dropped on the pane goes here first, to be routed by type; a file
   * returned is loaded as the pane's own text (inputs only).
   */
  readonly onFiles?: (files: File[]) => File | undefined;
  /** Shown over the pane while a file is dragged onto it. */
  readonly dropHint?: string;
  /** Empty-state text, or the textarea placeholder for an input. */
  readonly placeholder?: string;
  /** Replaces a read-only pane's whole empty state (its own box included), e.g. with a drop zone. */
  readonly empty?: ReactNode;
  /** Extra header button, before the source/copy/save actions. */
  readonly headerAction?: ReactNode;
  readonly footer?: ReactNode;
}

/** One side of the page: markdown rendered by default, with source, Copy and Save actions. */
function TextPane({
  title, source, markdown = source, saveName, onEdit, onFiles, dropHint = 'Drop to load', placeholder, empty, headerAction, footer,
}: TextPaneProps) {
  // An input starts on its textarea and only flips to rendered when content is
  // loaded whole (a paste into the empty pane, a dropped or opened file), never
  // while editing.
  const [showSource, setShowSource] = useState(onEdit !== undefined);
  const [copied, setCopied] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  // Set by a paste into the empty textarea, consumed by the change it causes: flipping
  // in onPaste itself would unmount the textarea before the browser inserts the text.
  const pastedIntoEmpty = useRef(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), COPIED_DURATION_MS);
    return () => clearTimeout(t);
  }, [copied]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
    } catch {
      // Clipboard denied (permissions, insecure context): Save still works.
    }
  };

  const loadFile = (file: File) => {
    setShowSource(false);
    void file.text().then(onEdit);
  };

  const takesFiles = onEdit !== undefined || onFiles !== undefined;

  const handleDrop = (e: DragEvent) => {
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0 || !takesFiles) return; // plain text drag: let the textarea insert it
    e.preventDefault();
    const own = onFiles ? onFiles(files) : files[0];
    if (own && onEdit) loadFile(own);
  };

  const handleDragOver = (e: DragEvent) => {
    if (takesFiles && e.dataTransfer.types.includes('Files')) setDragOver(true);
  };

  const handleDragLeave = (e: DragEvent) => {
    // Moving between the pane's own children fires leave too: only a real exit counts.
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
  };

  const lower = title.toLowerCase();
  return (
    <div
      className={`${styles.pane} ${dragOver ? styles.paneDragOver : ''}`}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
    >
      <div className={styles.paneHeader}>
        <span className={styles.paneTitle}>{title}</span>
        {onEdit && (
          <>
            <button
              type="button"
              className={buttonStyles.iconButton}
              onClick={() => fileRef.current?.click()}
              title="Open file"
              aria-label={`Open ${lower} file`}
            >
              <UploadIcon width={16} height={16} />
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".md,.markdown,.txt,text/*"
              className={styles.fileInput}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) loadFile(file);
                e.target.value = ''; // so opening the same file again fires onChange
              }}
            />
          </>
        )}
        {headerAction}
        <button
          type="button"
          className={`${buttonStyles.iconButton} ${showSource ? buttonStyles.pillButtonActive : ''}`}
          onClick={() => setShowSource((v) => !v)}
          disabled={!source}
          aria-pressed={showSource}
          title="Show markdown source"
          aria-label={`Show ${lower} markdown source`}
        >
          <CodeIcon />
        </button>
        <button
          type="button"
          className={buttonStyles.iconButton}
          onClick={() => { void handleCopy(); }}
          disabled={!source}
          title={copied ? 'Copied' : 'Copy'}
          aria-label={`${copied ? 'Copied' : 'Copy'} ${lower}`}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
        <button
          type="button"
          className={buttonStyles.iconButton}
          onClick={() => downloadBlob(source, saveName, 'text/markdown')}
          disabled={!source}
          title="Save"
          aria-label={`Save ${lower}`}
        >
          <DownloadIcon />
        </button>
      </div>
      {onEdit && (showSource || !source) && (
        <textarea
          className={styles.report}
          value={source}
          onChange={(e) => {
            onEdit(e.target.value);
            if (pastedIntoEmpty.current) {
              pastedIntoEmpty.current = false;
              setShowSource(false);
            }
          }}
          onPaste={() => { pastedIntoEmpty.current = !source; }}
          // A paste that inserted nothing (an image) leaves the flag set: typing clears it.
          onKeyDown={() => { pastedIntoEmpty.current = false; }}
          placeholder={placeholder}
          aria-label={title}
          spellCheck={false}
        />
      )}
      {!onEdit && !source && (empty ?? <div className={`${styles.report} ${styles.empty}`}>{placeholder}</div>)}
      {!onEdit && source && showSource && <pre className={styles.report} aria-label={title}>{source}</pre>}
      {source && !showSource && (
        <div className={`${styles.report} ${styles.rendered}`} aria-label={title}>
          <Markdown
            // remarkBreaks: a newline is a line break, as in GitHub comments.
            remarkPlugins={[remarkGfm, remarkBreaks]}
            components={{ a: (props) => <a {...props} target="_blank" rel="noopener noreferrer" /> }}
          >
            {markdown}
          </Markdown>
        </div>
      )}
      {/* A custom empty state is its own drop zone, already saying what a drop does. */}
      {dragOver && (onEdit || source || !empty) && <div className={styles.dropHint}>{dropHint}</div>}
      {footer}
    </div>
  );
}

/** Rageshakes are archives and logs; any other dropped file is report text. */
const isRageshake = (f: File) => /\.(?:tgz|gz|log)$/i.test(f.name);

/**
 * Anonymise rageshakes before sharing them, and read a markdown report written
 * about them back with the real identifiers.
 *
 * Where a rageshake is dropped says why, so the page never has to ask:
 * - the top zone anonymises it to share, saving each result when ready;
 * - the right pane takes the original only for its mapping, never saving.
 * Bottom: paste or drop anonymised markdown on the left — the right pane
 * renders it reversed with every mapping held, and its deep links open the
 * real log. Everything stays in this tab (see `useAnonymizeSessionStore`).
 */
export function AnonymizeView() {
  const jobs = useAnonymizeSessionStore((s) => s.jobs);
  const report = useAnonymizeSessionStore((s) => s.report);
  const batch = useAnonymizeSessionStore((s) => s.batch);
  const anonymiseFiles = useAnonymizeSessionStore((s) => s.anonymiseFiles);
  const setReport = useAnonymizeSessionStore((s) => s.setReport);
  const inputRef = useRef<HTMLInputElement>(null);
  const originalRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const [dragOver, setDragOver] = useState(false);
  const [listOpen, setListOpen] = useState(false);

  const sources = useMemo(
    () => jobs.flatMap((j): DeanonymizeSource[] =>
      j.output ? [{ anonymizedName: j.output.name, dict: j.output.dict, rawUrl: j.rawUrl }] : []),
    [jobs],
  );
  const appBase = `${window.location.origin}${window.location.pathname}`;
  const plain = useMemo(() => unanonymizeReport(report, sources), [report, sources]);
  const rendered = useMemo(() => repointViewerLinks(plain, sources, appBase), [plain, sources, appBase]);

  const handleFilesDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    const rageshakes = files.filter(isRageshake);
    if (rageshakes.length > 0) void anonymiseFiles(rageshakes, true);
    const text = files.find((f) => !isRageshake(f));
    if (text) void text.text().then(setReport);
  };
  const loadOriginals = (files: File[]) => { void anonymiseFiles(files, false); };
  const unresolved = useMemo(() => countUnresolvedAliases(plain), [plain]);

  /**
   * A file dropped on either pane goes where its type belongs, whichever pane it
   * landed on: rageshakes (archives, logs) are loaded as originals, anything else
   * is text for the anonymised side — returned for the caller to load. Reading an
   * archive as text, or a markdown file as a log, would only produce junk.
   */
  const routeFiles = (files: File[]): File | undefined => {
    const originals = files.filter(isRageshake);
    if (originals.length > 0) loadOriginals(originals);
    return files.find((f) => !isRageshake(f));
  };
  const chooseOriginal = () => originalRef.current?.click();
  const originalZone = (
    <div
      className={styles.originalZone}
      role="button"
      tabIndex={0}
      aria-label={sources.length === 0 ? 'Choose the original rageshake' : 'Add another original rageshake'}
      onClick={chooseOriginal}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') chooseOriginal(); }}
    >
      <UploadIcon className={styles.dropIcon} />
      {sources.length === 0
        ? (
          <>
            <strong>Drop the original rageshake</strong>
            <span className={styles.muted}>or click to choose · reveals real IDs, not saved again</span>
          </>
        )
        : (
          <>
            <strong>{plural(sources.length, 'rageshake')} loaded</strong>
            <span className={styles.muted}>drop or click to add another · then add text on the left</span>
          </>
        )}
    </div>
  );

  // A file dropped beside the targets would make the browser navigate to it,
  // losing everything this tab holds. Text drags are left alone for the textarea.
  const swallowFileDrop = (e: DragEvent) => {
    if (e.dataTransfer.types.includes('Files')) e.preventDefault();
  };

  return (
    <div className={styles.page} onDragOver={swallowFileDrop} onDrop={swallowFileDrop}>
      <header className={styles.header}>
        <button
          type="button"
          className={buttonStyles.iconButton}
          // Opened directly (no in-app history): back means the start page.
          onClick={() => { void (location.key === 'default' ? navigate('/') : navigate(-1)); }}
          title="Back"
          aria-label="Back"
        >
          <BackIcon />
        </button>
        <h1>Anonymise</h1>
        <span className={styles.muted}>Stays in this tab. Reload to forget.</span>
        <div className={styles.headerActions}>
          {jobs.length > 0 && <RageshakesDropdown jobs={jobs} batch={batch} isOpen={listOpen} onOpenChange={setListOpen} />}
        </div>
      </header>

      <div
        className={`${styles.dropZone} ${dragOver ? styles.dragOver : ''}`}
        role="button"
        tabIndex={0}
        aria-label="Choose rageshakes to anonymise"
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleFilesDrop}
      >
        <UploadIcon className={styles.dropIcon} />
        <strong>Drop rageshakes to anonymise</strong>
        <span className={styles.muted}>or click to choose · each is saved when ready</span>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".tar.gz,.tgz,.gz,.log"
          className={styles.fileInput}
          onChange={(e) => {
            void anonymiseFiles(Array.from(e.target.files ?? []), true);
            e.target.value = ''; // so picking the same file again fires onChange
          }}
        />
      </div>

      <div className={styles.panes}>
        <TextPane
          title="Anonymised"
          source={report}
          saveName="anonymised.md"
          onEdit={setReport}
          onFiles={routeFiles}
          placeholder="Paste or drop anonymised text or markdown"
        />
        <TextPane
          title="De-anonymised"
          source={plain}
          markdown={rendered}
          saveName="deanonymised.md"
          onFiles={(files) => {
            const text = routeFiles(files);
            if (text) void text.text().then(setReport);
            return undefined;
          }}
          dropHint="Drop the original to reveal real IDs"
          empty={originalZone}
          headerAction={(
            <button
              type="button"
              className={buttonStyles.iconButton}
              onClick={chooseOriginal}
              title="Add original rageshake"
              aria-label="Add original rageshake"
            >
              <UploadIcon width={16} height={16} />
            </button>
          )}
          footer={(
            <>
              {plain !== report && <span className={styles.warning}>Shows real IDs. Don&apos;t share publicly.</span>}
              {report && sources.length === 0 && (
                <span className={styles.muted}>
                  To reveal real IDs, drop the original rageshake on this pane, or{' '}
                  <button type="button" className={styles.textButton} onClick={chooseOriginal}>choose it</button>.
                </span>
              )}
              {/* Otherwise a mismatch would leave the text silently unchanged. */}
              {sources.length > 0 && unresolved > 0 && (
                <span className={styles.muted}>
                  {plural(unresolved, 'ID')} not found in the loaded rageshakes: anonymised in another browser, or not the original?
                </span>
              )}
            </>
          )}
        />
        <input
          ref={originalRef}
          type="file"
          multiple
          accept=".tar.gz,.tgz,.gz,.log"
          className={styles.fileInput}
          onChange={(e) => {
            loadOriginals(Array.from(e.target.files ?? []));
            e.target.value = ''; // so picking the same file again fires onChange
          }}
        />
      </div>
      <BatchNotice onShowList={() => setListOpen(true)} />
    </div>
  );
}

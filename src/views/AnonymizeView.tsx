import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { saveJobOutput, useAnonymizeSessionStore, type AnonymizeJob } from '../stores/anonymizeSessionStore';
import { useClickOutside } from '../hooks/useClickOutside';
import { repointViewerLinks, unanonymizeReport, type DeanonymizeSource } from '../utils/deanonymizeReport';
import { downloadBlob } from '../utils/downloadBlob';
import { BackIcon, CheckIcon, CodeIcon, CopyIcon, DownloadIcon, TrashIcon, UploadIcon } from '../components/icons';
import buttonStyles from '../components/Button.module.css';
import dropdownStyles from '../components/Dropdown.module.css';
import styles from './AnonymizeView.module.css';

const COPIED_DURATION_MS = 1500;

/** Header dropdown listing the dropped rageshakes: progress, a save button each, and Forget all. */
function RageshakesDropdown({ jobs, onForget }: { readonly jobs: readonly AnonymizeJob[]; readonly onForget: () => void }) {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setIsOpen(false), isOpen);

  const working = jobs.some((j) => j.status === 'working');
  const failed = jobs.filter((j) => j.status === 'error').length;
  const label = working
    ? 'Anonymising…'
    : `${jobs.length} rageshake${jobs.length === 1 ? '' : 's'}${failed > 0 ? ` · ${failed} failed` : ''}`;

  return (
    <div className={dropdownStyles.container} ref={ref}>
      <button type="button" className={dropdownStyles.button} onClick={() => setIsOpen((o) => !o)} aria-expanded={isOpen}>
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
          <button type="button" className={`${dropdownStyles.option} ${styles.forget}`} onClick={() => { setIsOpen(false); onForget(); }}>
            <TrashIcon /> Forget all
          </button>
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
  readonly placeholder: string;
  readonly footer?: ReactNode;
}

/** One side of the page: markdown rendered by default, with source, Copy and Save actions. */
function TextPane({ title, source, markdown = source, saveName, onEdit, placeholder, footer }: TextPaneProps) {
  // An input starts on its textarea and only flips to rendered on paste or drop,
  // never mid-typing.
  const [showSource, setShowSource] = useState(onEdit !== undefined);
  const [copied, setCopied] = useState(false);

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

  const handleDrop = (e: DragEvent) => {
    const file = e.dataTransfer.files[0] as File | undefined;
    if (!file || !onEdit) return; // plain text drag: let the textarea insert it
    e.preventDefault();
    setShowSource(false);
    void file.text().then(onEdit);
  };

  const lower = title.toLowerCase();
  return (
    <div className={styles.pane} onDrop={handleDrop}>
      <div className={styles.paneHeader}>
        <span className={styles.paneTitle}>{title}</span>
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
          onChange={(e) => onEdit(e.target.value)}
          onPaste={() => setShowSource(false)}
          placeholder={placeholder}
          aria-label={title}
          spellCheck={false}
        />
      )}
      {!onEdit && !source && <div className={`${styles.report} ${styles.empty}`}>{placeholder}</div>}
      {!onEdit && source && showSource && <pre className={styles.report} aria-label={title}>{source}</pre>}
      {source && !showSource && (
        <div className={`${styles.report} ${styles.rendered}`} aria-label={title}>
          <Markdown
            remarkPlugins={[remarkGfm]}
            components={{ a: (props) => <a {...props} target="_blank" rel="noopener noreferrer" /> }}
          >
            {markdown}
          </Markdown>
        </div>
      )}
      {footer}
    </div>
  );
}

/**
 * Anonymise rageshakes before sharing them, and read a markdown report written
 * about them back with the real identifiers.
 *
 * Top: drop one or more archives or logs; each is anonymised and, with
 * auto-save on, downloaded straight away. Bottom: paste or drop anonymised
 * markdown on the left — the right pane renders it reversed with the mappings
 * of the files dropped above, and its deep links open the real log. Everything stays in this tab (see
 * `useAnonymizeSessionStore`).
 */
export function AnonymizeView() {
  const jobs = useAnonymizeSessionStore((s) => s.jobs);
  const report = useAnonymizeSessionStore((s) => s.report);
  const autoSave = useAnonymizeSessionStore((s) => s.autoSave);
  const setAutoSave = useAnonymizeSessionStore((s) => s.setAutoSave);
  const anonymiseFiles = useAnonymizeSessionStore((s) => s.anonymiseFiles);
  const setReport = useAnonymizeSessionStore((s) => s.setReport);
  const forgetAll = useAnonymizeSessionStore((s) => s.forgetAll);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const [dragOver, setDragOver] = useState(false);

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
    void anonymiseFiles(Array.from(e.dataTransfer.files));
  };

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
          <label className={styles.toggle} title="Download each file as soon as it is anonymised">
            <input type="checkbox" checked={autoSave} onChange={(e) => setAutoSave(e.target.checked)} />
            Auto-save
          </label>
          {jobs.length > 0 && <RageshakesDropdown jobs={jobs} onForget={forgetAll} />}
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
        <strong>Drop rageshakes</strong>
        <span className={styles.muted}>or click to choose</span>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".tar.gz,.tgz,.gz,.log,.txt"
          className={styles.fileInput}
          onChange={(e) => {
            void anonymiseFiles(Array.from(e.target.files ?? []));
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
          placeholder="Paste or drop anonymised text or markdown"
        />
        <TextPane
          title="De-anonymised"
          source={plain}
          markdown={rendered}
          saveName="deanonymised.md"
          placeholder={sources.length === 0 ? 'Drop the original rageshake above, then add text on the left.' : 'Add text on the left.'}
          footer={plain !== report && <span className={styles.warning}>Shows real IDs. Don&apos;t share publicly.</span>}
        />
      </div>
    </div>
  );
}

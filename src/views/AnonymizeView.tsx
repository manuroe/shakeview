import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useShallow } from 'zustand/react/shallow';
import Markdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { openJob, saveJobOutput, useAnonymizeSessionStore, type AnonymizeJob, type TextSide } from '../stores/anonymizeSessionStore';
import { useAnonSaltStore } from '../stores/anonSaltStore';
import { useClickOutside } from '../hooks/useClickOutside';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { useMatrixProfile } from '../hooks/useMatrixProfile';
import {
  anonymizeText,
  countRealIdentifiers,
  countUnresolvedAliases,
  repointViewerLinks,
  unanonymizeReport,
  type DeanonymizeSource,
} from '../utils/deanonymizeReport';
import { downloadBlob } from '../utils/downloadBlob';
import { plural } from '../utils/crypto/format';
import { roomCount } from '../utils/roomCount';
import { BackIcon, CheckIcon, CopyIcon, DownloadIcon, ExternalLinkIcon, EyeIcon, KeyIcon, PencilIcon, TrashIcon, UploadIcon } from '../components/icons';
import { SaltField } from '../components/SaltField';
import { UserHeader } from '../components/UserHeader';
import buttonStyles from '../components/Button.module.css';
import dropdownStyles from '../components/Dropdown.module.css';
import styles from './AnonymizeView.module.css';

const COPIED_DURATION_MS = 1500;
const MAX_AVATARS = 3;

/** A user's face from their homeserver; nothing without one, like the summary page. */
function Avatar({ userId, small = false }: { readonly userId: string; readonly small?: boolean }) {
  const url = useMatrixProfile(userId)?.avatarHttpUrl;
  return url
    ? <img src={url} alt="" className={`${styles.avatar} ${small ? styles.avatarSmall : ''}`} onError={(e) => { e.currentTarget.hidden = true; }} />
    : null;
}

/** A user's display name, else their ID. */
function UserName({ userId }: { readonly userId: string }) {
  return <>{useMatrixProfile(userId)?.displayName ?? userId}</>;
}

/**
 * Whose rageshakes are loaded: one user gets the summary page's header (their
 * devices counted when several); several show a stack of faces, naming two users
 * and counting more, each user and device listed in the tooltip.
 */
function Identity({ jobs }: { readonly jobs: readonly AnonymizeJob[] }) {
  const devicesByUser = new Map<string, Set<string>>();
  for (const j of jobs) {
    const { userId, deviceId } = j.output?.identity ?? {};
    if (!userId) continue;
    const devices = devicesByUser.get(userId) ?? new Set<string>();
    if (deviceId) devices.add(deviceId);
    devicesByUser.set(userId, devices);
  }
  const users = [...devicesByUser.keys()];
  if (users.length === 0) return null;

  if (users.length === 1) {
    const devices = [...devicesByUser.get(users[0])!];
    // This user's key only: a job without a user ID may still carry another device's key.
    const curveKey = devices.length === 1 ? jobs.find((j) => j.output?.identity.userId === users[0] && j.output.identity.curveKey)?.output?.identity.curveKey : undefined;
    return (
      <UserHeader
        userId={users[0]}
        deviceId={devices.length > 1 ? plural(devices.length, 'device') : devices[0]}
        deviceKeys={curveKey && `curve25519:${curveKey}`}
        rooms={roomCount(jobs.flatMap((j) => (j.output?.identity.userId ? [j.output.rooms] : [])))}
      />
    );
  }
  const tooltip = [...devicesByUser].map(([u, d]) => [u, ...d].join(' · ')).join('\n');
  return (
    <div className={styles.identity} title={tooltip}>
      <div className={styles.avatarStack}>
        {users.slice(0, MAX_AVATARS).map((u) => <Avatar key={u} userId={u} />)}
      </div>
      <div className={styles.displayName}>
        {users.length === 2
          ? <><UserName userId={users[0]} />, <UserName userId={users[1]} /></>
          : plural(users.length, 'user')}
      </div>
    </div>
  );
}

interface RageshakesDropdownProps {
  readonly jobs: readonly AnonymizeJob[];
  readonly onForget: () => void;
}

/** Header dropdown listing the dropped rageshakes: whose, progress, a save button each, and Forget all. */
function RageshakesDropdown({ jobs, onForget }: RageshakesDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setIsOpen(false), isOpen);

  const working = jobs.filter((j) => j.status === 'working');
  const failed = jobs.filter((j) => j.status === 'error').length;
  const pct = Math.round((100 * working.reduce((sum, j) => sum + j.progress, 0)) / Math.max(working.length, 1));
  const label = working.length > 0
    ? `Anonymising ${plural(working.length, 'rageshake')}… ${pct}%`
    : `${plural(jobs.length, 'rageshake')}${failed > 0 ? ` · ${failed} failed` : ''}`;

  return (
    <div className={dropdownStyles.container} ref={ref}>
      <button type="button" className={dropdownStyles.button} onClick={() => setIsOpen(!isOpen)} aria-expanded={isOpen}>
        {label} ▾
      </button>
      {isOpen && (
        <div className={`${dropdownStyles.dropdown} ${styles.jobsPanel}`}>
          <ul className={styles.jobs}>
            {jobs.map((j) => {
              const { userId } = j.output?.identity ?? {};
              const openName = j.save ? j.output?.name : j.sourceName;
              return (
                <li key={j.id} className={styles.job}>
                  {userId && <Avatar userId={userId} small />}
                  <span className={styles.jobName} title={j.sourceName}>{j.output?.name ?? j.sourceName}</span>
                  {userId && <span className={styles.muted}>{userId}</span>}
                  {j.status === 'working' && <span className={styles.muted}>{j.message}</span>}
                  {j.status === 'error' && <span className={styles.error}>{j.message}</span>}
                  {j.status === 'done' && j.output && (
                    <>
                      <span className={styles.done} title="Anonymised"><CheckIcon /></span>
                      <button
                        type="button"
                        className={buttonStyles.iconButton}
                        // Back here keeps the session: the store outlives the page.
                        // An unreadable file (changed on disk since the drop) stays here, logged.
                        onClick={() => { void openJob(j).then((route) => navigate(route), (err) => console.error('Failed to open rageshake:', err)); }}
                        title={`Open ${openName}`}
                        aria-label={`Open ${openName}`}
                      >
                        <ExternalLinkIcon />
                      </button>
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
              );
            })}
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

/** Key button opening the app-wide salt. */
function SaltButton({ isOpen, onOpenChange }: { readonly isOpen: boolean; readonly onOpenChange: (open: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => onOpenChange(false), isOpen);
  return (
    <div className={dropdownStyles.container} ref={ref}>
      <button
        type="button"
        className={`${buttonStyles.iconButton} ${isOpen ? buttonStyles.pillButtonActive : ''}`}
        onClick={() => onOpenChange(!isOpen)}
        aria-expanded={isOpen}
        title="Salt"
        aria-label="Salt"
      >
        <KeyIcon />
      </button>
      {isOpen && <div className={`${dropdownStyles.dropdown} ${styles.saltPanel}`}><SaltField /></div>}
    </div>
  );
}

interface TextPaneProps {
  readonly title: string;
  /** Said after the title, e.g. who may see the text. */
  readonly note: string;
  /** Markdown source: what the source view shows, Copy copies and Save saves. */
  readonly source: string;
  /** What the rendered view shows, when it differs from `source` (e.g. links repointed for this tab only). */
  readonly markdown?: string;
  readonly saveName: string;
  /** An edit of the source view, or a file loaded into the pane. */
  readonly onEdit: (text: string) => void;
  /** Every file dropped on the pane goes here first, to be routed by type; a file returned is loaded as the pane's text. */
  readonly onFiles: (files: File[]) => File | undefined;
  readonly placeholder: string;
  /** Extra header button, before the source/copy/save actions. */
  readonly headerAction?: ReactNode;
  readonly footer?: ReactNode;
}

// ponytail: syntax sniff (heading, list, quote, fence, table, link, bold); a log line
// that happens to start with "- " renders, a markdown parser pass if that bites.
const MARKDOWN_RE = /^(?:#{1,6}\s|\s*(?:[-*+]|\d+\.)\s|>\s|```|\|.*\|)|\[[^\]\n]+\]\([^)\s]+\)|\*\*[^*\n]+\*\*/m;

/** One side of the page: markdown rendered once it holds text, with source, Copy and Save actions. */
function TextPane({ title, note, source, markdown = source, saveName, onEdit, onFiles, placeholder, headerAction, footer }: TextPaneProps) {
  // Rendered once text arrives whole (a paste into the empty pane, a dropped or
  // opened file, the other pane's text); the source view while typing in it.
  const [showSource, setShowSource] = useState(false);
  // Raw logs are no markdown: rendering them only mangles them.
  const isMarkdown = MARKDOWN_RE.test(source);
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

  const handleDrop = (e: DragEvent) => {
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return; // plain text drag: let the textarea insert it
    e.preventDefault();
    const own = onFiles(files);
    if (own) loadFile(own);
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
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) setDragOver(true); }}
      onDragLeave={handleDragLeave}
    >
      <div className={styles.paneHeader}>
        <span className={styles.paneTitle}>{title} <span className={styles.paneNote}>· {note}</span></span>
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
        {headerAction}
        <button
          type="button"
          className={buttonStyles.iconButton}
          onClick={() => setShowSource((v) => !v)}
          disabled={!isMarkdown}
          // Named for what a click does: edit the rendered view, preview the edit.
          title={showSource ? 'Preview' : 'Edit'}
          aria-label={`${showSource ? 'Preview' : 'Edit'} ${lower}`}
        >
          {showSource ? <EyeIcon /> : <PencilIcon />}
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
      {(showSource || !isMarkdown) ? (
        <textarea
          className={styles.report}
          value={source}
          onChange={(e) => {
            onEdit(e.target.value);
            setShowSource(!pastedIntoEmpty.current);
            pastedIntoEmpty.current = false;
          }}
          onPaste={() => { pastedIntoEmpty.current = !source; }}
          // A paste that inserted nothing (an image) leaves the flag set: typing clears it.
          onKeyDown={() => { pastedIntoEmpty.current = false; }}
          placeholder={placeholder}
          aria-label={title}
          spellCheck={false}
          // Mounted by the Edit button: straight to typing.
          autoFocus={showSource}
        />
      ) : (
        <div
          className={`${styles.report} ${styles.rendered}`}
          aria-label={title}
        >
          <Markdown
            // remarkBreaks: a newline is a line break, as in GitHub comments.
            remarkPlugins={[remarkGfm, remarkBreaks]}
            components={{ a: (props) => <a {...props} target="_blank" rel="noopener noreferrer" /> }}
          >
            {markdown}
          </Markdown>
        </div>
      )}
      {dragOver && <div className={styles.dropHint}>Drop to load</div>}
      {footer && <div className={styles.paneFooter}>{footer}</div>}
    </div>
  );
}

/** Rageshakes are archives and logs; any other dropped file is text. */
const isRageshake = (f: File) => /\.(?:tgz|gz|log)$/i.test(f.name);

interface DropZoneProps {
  readonly label: string;
  readonly hint: string;
  /** Download each anonymised result, or keep only its mapping. */
  readonly save: boolean;
  /** A dropped file that is not a rageshake: text for the pane below. */
  readonly onText: (file: File) => void;
}

/** Drop or pick original rageshakes; text files dropped here go to the pane below. */
function DropZone({ label, hint, save, onText }: DropZoneProps) {
  const anonymiseFiles = useAnonymizeSessionStore((s) => s.anonymiseFiles);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    const rageshakes = files.filter(isRageshake);
    if (rageshakes.length > 0) void anonymiseFiles(rageshakes, save);
    const text = files.find((f) => !isRageshake(f));
    if (text) onText(text);
  };

  return (
    <div
      className={`${styles.dropZone} ${dragOver ? styles.dragOver : ''}`}
      role="button"
      tabIndex={0}
      aria-label={label}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      <UploadIcon className={styles.dropIcon} />
      <strong>{label}</strong>
      <span className={styles.muted}>{hint}</span>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept=".tar.gz,.tgz,.gz,.log"
        className={styles.fileInput}
        onChange={(e) => {
          void anonymiseFiles(Array.from(e.target.files ?? []), save);
          e.target.value = ''; // so picking the same file again fires onChange
        }}
      />
    </div>
  );
}

/**
 * Anonymise rageshakes and text, and read anonymised text back with the real
 * identifiers.
 *
 * Left: real identifiers. Right: anonymised. Both are editable; the one edited
 * last drives, the other is derived from it — anonymised with the salt alone, or
 * reversed with the mappings of the rageshakes loaded and of the text typed.
 *
 * Where a rageshake is dropped says why, so the page never has to ask: above the
 * left pane to reveal real IDs (mapping only), above the right one to anonymise
 * it to share (each result saved when ready). Everything stays in this tab (see
 * `useAnonymizeSessionStore`).
 */
export function AnonymizeView() {
  const jobs = useAnonymizeSessionStore((s) => s.jobs);
  const text = useAnonymizeSessionStore((s) => s.text);
  const driver = useAnonymizeSessionStore((s) => s.driver);
  const textDict = useAnonymizeSessionStore((s) => s.textDict);
  const anonymiseFiles = useAnonymizeSessionStore((s) => s.anonymiseFiles);
  const setText = useAnonymizeSessionStore((s) => s.setText);
  const addTextDict = useAnonymizeSessionStore((s) => s.addTextDict);
  const forgetAll = useAnonymizeSessionStore((s) => s.forgetAll);
  const salt = useAnonSaltStore((s) => s.salt);
  const navigate = useNavigate();
  const location = useLocation();
  const [saltOpen, setSaltOpen] = useState(false);

  // Not from jobs, a new array on every progress tick: the sources change only when a file finishes.
  const outputs = useAnonymizeSessionStore(useShallow((s) => s.jobs.map((j) => j.output)));
  const rawUrls = useAnonymizeSessionStore(useShallow((s) => s.jobs.map((j) => j.rawUrl)));
  const jobSources = useMemo(
    () => outputs.flatMap((o, i): DeanonymizeSource[] =>
      o ? [{ anonymizedName: o.name, dict: o.dict, rawUrl: rawUrls[i] }] : []),
    [outputs, rawUrls],
  );
  const sources = useMemo(() => [...jobSources, { anonymizedName: '', dict: textDict, rawUrl: null }], [jobSources, textDict]);

  // Real side drives: anonymise it (async: hashing), once typing settles.
  const [anonymised, setAnonymised] = useState('');
  const realText = useDebouncedValue(driver === 'real' ? text : null);
  // Not once per keystroke in the salt field.
  const realSalt = useDebouncedValue(salt);
  useEffect(() => {
    // Debounced, realText outlives a switch of driver (Forget all among them): adding
    // its mapping then would bring back real IDs just forgotten.
    if (realText === null || driver !== 'real') return undefined;
    let cancelled = false;
    void anonymizeText(realText, realSalt, jobSources).then((out) => {
      if (cancelled) return;
      setAnonymised(out.text);
      addTextDict(out.dict);
    });
    return () => { cancelled = true; };
  }, [realText, driver, realSalt, jobSources, addTextDict]);

  const real = useMemo(() => (driver === 'real' ? text : unanonymizeReport(text, sources)), [driver, text, sources]);
  const right = driver === 'anonymised' ? text : anonymised;
  const appBase = `${window.location.origin}${window.location.pathname}`;
  const rendered = useMemo(() => repointViewerLinks(real, sources, appBase), [real, sources, appBase]);
  const unresolved = useMemo(() => (driver === 'anonymised' ? countUnresolvedAliases(real) : 0), [driver, real]);
  const realIds = useMemo(() => countRealIdentifiers(right), [right]);

  /** A rageshake dropped on a pane goes to the zone above it; any other file is the pane's text. */
  const routeFiles = (save: boolean) => (files: File[]): File | undefined => {
    const rageshakes = files.filter(isRageshake);
    if (rageshakes.length > 0) void anonymiseFiles(rageshakes, save);
    return files.find((f) => !isRageshake(f));
  };
  const edit = (side: TextSide) => (value: string) => {
    // The right pane keeps its text until the left is anonymised, not a stale earlier anonymisation.
    if (side === 'real' && driver !== 'real') setAnonymised(right);
    setText(side, value);
  };
  const loadText = (side: TextSide) => (file: File) => { void file.text().then(edit(side)); };

  // A file dropped beside the targets would make the browser navigate to it,
  // losing everything this tab holds. Text drags are left alone for the textareas.
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
        <div className={styles.headerCenter}><Identity jobs={jobs} /></div>
        {jobs.length > 0 && <RageshakesDropdown jobs={jobs} onForget={() => {
          // The right pane lags typing on the left: keep the anonymisation of the text as it is now.
          // Failing that, the anonymisation shown: forgetting must not fail.
          if (driver === 'real') void anonymizeText(text, salt, jobSources).then((out) => forgetAll(out.text), () => forgetAll(right));
          else forgetAll(text);
        }} />}
      </header>

      <div className={styles.panes}>
        <div className={styles.column}>
          <DropZone
            label="Load rageshakes"
            hint="drop or click · nothing is downloaded"
            save={false}
            onText={loadText('real')}
          />
          <TextPane
            title="Real IDs"
            note="private"
            source={real}
            markdown={rendered}
            saveName="real.md"
            onEdit={edit('real')}
            onFiles={routeFiles(false)}
            placeholder="Type, paste or drop text with real IDs, or anonymised text on the right to read it here"
            footer={driver === 'anonymised' && text && (
              jobSources.length === 0 && unresolved > 0
                ? <span className={styles.muted}>To reveal real IDs, load the original rageshake above.</span>
                : unresolved > 0 && (
                  <span className={styles.muted}>
                    {plural(unresolved, 'alias', 'aliases')} not found in the loaded rageshakes:{' '}
                    <button type="button" className={styles.textButton} onClick={() => setSaltOpen(true)}>wrong salt?</button>
                  </span>
                )
            )}
          />
        </div>
        <div className={styles.column}>
          <DropZone
            label="Load and download anonymised"
            hint="drop or click · an anonymised copy of each is downloaded"
            save
            onText={loadText('anonymised')}
          />
          <TextPane
            title="Anonymised"
            note="shareable"
            source={right}
            saveName="anonymised.md"
            onEdit={edit('anonymised')}
            onFiles={routeFiles(true)}
            placeholder="Type, paste or drop anonymised text, or text with real IDs on the left to anonymise it here"
            headerAction={<SaltButton isOpen={saltOpen} onOpenChange={setSaltOpen} />}
            footer={realIds > 0 && <span className={styles.warning}>{plural(realIds, 'real ID')} left: not safe to share.</span>}
          />
        </div>
      </div>
    </div>
  );
}

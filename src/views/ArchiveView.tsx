/**
 * Lists all files in a loaded rageshake `.tar.gz` archive and allows the user
 * to pick one for analysis by clicking its filename.
 *
 * Columns match what the browser extension shows on rageshake listing pages:
 * File, Lines, Sentry, Errors, Warnings, Requests, Upload, Download, Status codes.
 *
 * Summaries are computed lazily in the background: the table renders immediately
 * with "…" placeholders, then each row fills in as its file is parsed. A
 * `setTimeout(0)` yield between files keeps the main thread responsive during
 * large archives.
 *
 * Entries are sorted primarily by filename category (alphabetically), then
 * most-recent-first by the date embedded in the filename within each category
 * (e.g. `logs.2026-04-12-09.log.gz`). Files without a recognisable date
 * (e.g. `details.json`, `logcat.log.gz`) appear after the dated entries in
 * their category.
 *
 * The archive store is left intact after the user navigates to `/summary`, so
 * pressing Back returns here with all summaries already computed.
 */

import { useEffect, useRef, useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { decompressSync } from 'fflate';
import { useArchiveStore } from '../stores/archiveStore';
import { isAnalyzableEntry, computeArchiveSummary, emptyArchiveSummary, utdsByFile, type ArchiveSummary, type FileUtds } from '../utils/archiveSummary';
import { formatCounts } from '../utils/crypto/decryptionSummary';
import { REPORTED_MEANING } from '../utils/crypto/labels';
import { plural } from '../utils/crypto/format';
import { parseDetailsJson } from '../utils/detailsJson';
import { decodeTextBytes } from '../utils/fileValidator';
import { getEntryKind, getMimeType, sortEntries, stripEntryPrefix } from '../utils/listingEntries';
import { openMergedEntries } from '../utils/openMergedLogs';
import { userInitial } from '../utils/matrixProfile';
import { useMatrixProfile } from '../hooks/useMatrixProfile';
import { formatBytes } from '../utils/sizeUtils';
import { roomCount } from '../utils/roomCount';
import { isNumericStatus } from '../utils/statusCodeUtils';
import { BurgerMenu } from '../components/BurgerMenu';
import { UserHeader } from '../components/UserHeader';
import tableStyles from '../components/Table.module.css';
import styles from './ArchiveView.module.css';

const NUMERIC_CODE_RE = { test: isNumericStatus };

/** Renders a row of status-code chips for a summary. */
function StatusChips({ statusCodes }: { readonly statusCodes: Readonly<Record<string, number>> }) {
  const sorted = Object.entries(statusCodes).sort((a, b) => {
    const an = parseInt(a[0], 10);
    const bn = parseInt(b[0], 10);
    if (!isNaN(an) && !isNaN(bn)) return an - bn;
    if (!isNaN(an)) return -1;
    if (!isNaN(bn)) return 1;
    return a[0].localeCompare(b[0]);
  });

  return (
    <span className={styles.statusChips}>
      {sorted.map(([code, count]) => {
        const n = parseInt(code, 10);
        let colorClass = styles.chipOther;
        if (!isNaN(n)) {
          if (n >= 200 && n < 300) colorClass = styles.chip2xx;
          else if (n >= 300 && n < 400) colorClass = styles.chip3xx;
          else if (n >= 400 && n < 500) colorClass = styles.chip4xx;
          else if (n >= 500) colorClass = styles.chip5xx;
        }
        return (
          <span key={code} className={`${styles.chip} ${colorClass} ${NUMERIC_CODE_RE.test(code) ? styles.chipNumeric : ''}`}>
            <span className={styles.chipCode}>{code}</span>
            <span className={styles.chipCount}>×{count}</span>
          </span>
        );
      })}
    </span>
  );
}

/** A file's UTDs in its cell; `reported` is `undefined` while other files are still being summarized. */
type UtdCell = Omit<FileUtds, 'reported'> & { readonly reported: number | null | undefined };

/** The UTDs cell's tooltip: what "reported (all)" counts, then the UTDs per reason. */
function utdTitle(u: UtdCell): string {
  const head = u.reported === undefined ? 'Reported: waiting for the other files'
    : u.reported === null ? 'Reported: unknown, no timeline logs'
    : `${u.reported.toLocaleString()} reported of ${plural(u.count, 'UTD')}`;
  return `${head}\n${REPORTED_MEANING}\n${formatCounts(u.byReason)}`;
}

/** A single data cell — shows "…" while loading, "—" for non-analyzable, or the value. */
function DataCell({
  summary,
  analyzable,
  children,
  className,
}: {
  readonly summary: ArchiveSummary | undefined;
  readonly analyzable: boolean;
  readonly children?: (s: ArchiveSummary) => React.ReactNode;
  readonly className?: string;
}) {
  if (!analyzable) return <td className={`${tableStyles.tableCell} ${tableStyles.alignRight} ${className ?? ''}`}>—</td>;
  if (!summary) return <td className={`${tableStyles.tableCell} ${tableStyles.alignRight} ${className ?? ''}`}><span className={styles.loadingCell}>…</span></td>;
  return <td className={`${tableStyles.tableCell} ${tableStyles.alignRight} ${className ?? ''}`}>{children?.(summary)}</td>;
}

export function ArchiveView() {
  const navigate = useNavigate();
  const { archiveName, archiveEntries, archiveSummaries, setArchiveSummary, visitedEntries } = useArchiveStore();

  /** Entry names ticked for opening together as one merged timeline. */
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  /** Set to true on unmount to stop the background summary loop. */
  const cancelRef = useRef(false);

  // Redirect to landing when there's no archive loaded (e.g. direct navigation).
  useEffect(() => {
    if (archiveEntries.length === 0) {
      void navigate('/', { replace: true });
    }
  }, [archiveEntries.length, navigate]);

  // Sorted view — most recent first, undated entries at the end.
  const sortedEntries = useMemo(() => sortEntries(archiveEntries), [archiveEntries]);

  /**
   * Selected fields parsed from `details.json` inside the archive.
   * All fields are optional — absent when the file is missing or unparseable.
   */
  const parsedDetails = useMemo(() => {
    const entry = archiveEntries.find((e) => stripEntryPrefix(e.name) === 'details.json');
    if (!entry) return null;
    return parseDetailsJson(decodeTextBytes(entry.data));
  }, [archiveEntries]);

  /** PNG entries extracted from the archive for the gallery card. */
  const pngEntries = useMemo(
    () => archiveEntries.filter((e) => e.name.toLowerCase().endsWith('.png')),
    [archiveEntries]
  );

  /** Matrix profile fetched from the user's homeserver; `null` while loading or without a userId. */
  const matrixProfile = useMatrixProfile(parsedDetails?.userId);

  /** Rooms over every file, for the user header; `null` until all are summarized, not re-merged per summary. */
  const rooms = useMemo(() => {
    if (!sortedEntries.every((e) => !isAnalyzableEntry(e.name) || archiveSummaries.has(e.name))) return null;
    return roomCount([...archiveSummaries.values()].map((s) => s.rooms));
  }, [sortedEntries, archiveSummaries]);

  /**
   * Object URLs for PNG entries, created once and revoked on unmount.
   * Keyed by entry name.
   */
  const pngUrls = useMemo(() => {
    return new Map(
      pngEntries.map((e) => {
        return [e.name, URL.createObjectURL(new Blob([e.data as Uint8Array<ArrayBuffer>], { type: 'image/png' }))];
      })
    );
  }, [pngEntries]);

  useEffect(() => {
    return () => {
      for (const url of pngUrls.values()) {
        URL.revokeObjectURL(url);
      }
    };
  }, [pngUrls]);

  // UTDs need every file: a UTD retried or decrypted in the next one counts once, in the file it first failed.
  // `undefined` until all files are summarized; only modelled when some file has UTDs.
  const archiveUtds = useMemo(() => {
    const files = sortedEntries.filter((e) => isAnalyzableEntry(e.name));
    if (!files.every((e) => archiveSummaries.has(e.name))) return undefined;
    return files.some((e) => archiveSummaries.get(e.name)!.utdCount > 0) ? utdsByFile(archiveSummaries) : new Map<string, FileUtds>();
  }, [sortedEntries, archiveSummaries]);

  // Background summary computation: parse one entry at a time, yielding between
  // each via setTimeout(0) so the UI stays responsive.
  useEffect(() => {
    cancelRef.current = false;

    const analyzable = sortedEntries.filter((e) => isAnalyzableEntry(e.name));

    let timeoutId: ReturnType<typeof setTimeout>;

    const processNext = (index: number): void => {
      if (cancelRef.current || index >= analyzable.length) return;

      const entry = analyzable[index];
      // Skip if already computed (e.g. user pressed Back)
      if (!archiveSummaries.has(entry.name)) {
        try {
          const isGz = entry.name.toLowerCase().endsWith('.gz');
          const bytes = isGz ? decompressSync(entry.data) : entry.data;
          const text = decodeTextBytes(bytes);
          const summary = computeArchiveSummary(text, entry.name);
          setArchiveSummary(entry.name, summary);
        } catch {
          // Decompression or parsing failed — record zeros so the row never stays "…"
          setArchiveSummary(entry.name, emptyArchiveSummary());
        }
      }

      timeoutId = setTimeout(() => processNext(index + 1), 0);
    };

    timeoutId = setTimeout(() => processNext(0), 0);

    return () => {
      cancelRef.current = true;
      clearTimeout(timeoutId);
    };
    // archiveSummaries intentionally excluded: we check `.has()` inside the loop
    // to skip already-computed entries, but don't want a new effect per summary update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortedEntries, setArchiveSummary]);

  const openEntries = useCallback(
    (entryNames: readonly string[]) => {
      void (async () => {
        const route = await openMergedEntries(entryNames);
        if (route) void navigate(route);
      })();
    },
    [navigate]
  );

  const handleOpen = useCallback(
    (entryName: string) => {
      const entry = archiveEntries.find((e) => e.name === entryName);
      if (!entry) return;

      const kind = getEntryKind(entryName);

      // Non-log files: hand off to the browser as a native object URL
      if (kind === 'other') {
        let blob: Blob;
        if (entryName.toLowerCase().endsWith('.json')) {
          // Decode, pretty-print, and serve as text so all browsers render it
          // inline rather than downloading it. application/json can trigger a
          // download in some browsers/configurations, text/plain never does.
          try {
            const text = decodeTextBytes(entry.data);
            const formatted = JSON.stringify(JSON.parse(text), null, 2);
            blob = new Blob([formatted], { type: 'text/plain;charset=utf-8' });
          } catch {
            // Malformed JSON — fall back to raw bytes
            blob = new Blob([entry.data as Uint8Array<ArrayBuffer>], { type: 'text/plain;charset=utf-8' });
          }
        } else {
          blob = new Blob([entry.data as Uint8Array<ArrayBuffer>], { type: getMimeType(entryName) });
        }
        const url = URL.createObjectURL(blob);
        const opened = window.open(url, '_blank', 'noopener,noreferrer');
        if (!opened) {
          // Popup blocked — revoke immediately since navigation won't happen
          URL.revokeObjectURL(url);
          return;
        }
        // Revoke after the browser has had time to read the URL; since the
        // current page stays loaded, this timer will always fire reliably.
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return;
      }

      // Log files: parse and navigate to the appropriate view
      openEntries([entryName]);
    },
    [archiveEntries, openEntries]
  );

  const handleOpenRaw = useCallback(
    (entryName: string) => {
      const entry = archiveEntries.find((e) => e.name === entryName);
      if (!entry) return;
      try {
        const isGz = entry.name.toLowerCase().endsWith('.gz');
        const bytes = isGz ? decompressSync(entry.data) : entry.data;
        const text = decodeTextBytes(bytes);
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const opened = window.open(url, '_blank', 'noopener,noreferrer');
        if (!opened) {
          URL.revokeObjectURL(url);
          return;
        }
        setTimeout(() => URL.revokeObjectURL(url), 3000);
      } catch (err) {
        console.error('Failed to open raw archive entry:', err);
      }
    },
    [archiveEntries]
  );

  // Log entries that can be ticked for opening together.
  const selectableNames = useMemo(
    () => sortedEntries.filter((e) => isAnalyzableEntry(e.name)).map((e) => e.name),
    [sortedEntries]
  );
  const allSelected = selectableNames.length > 0 && selectableNames.every((n) => selected.has(n));

  const toggleSelected = useCallback((name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelected((prev) =>
      prev.size > 0 && selectableNames.every((n) => prev.has(n)) ? new Set() : new Set(selectableNames)
    );
  }, [selectableNames]);

  // Don't render until redirect effect has had a chance to fire
  if (archiveEntries.length === 0) {
    return null;
  }

  return (
    <div className="app">
      <div className="header-compact">
        <div className="header-left">
          <BurgerMenu />
          <h1 className="header-title">{archiveName}</h1>
        </div>
        <UserHeader
          userId={parsedDetails?.userId} deviceId={parsedDetails?.deviceId} deviceKeys={parsedDetails?.deviceKeys} rooms={rooms}
        />
        <div className="header-right">
          {selected.size > 0 && (
            <>
              <button className={styles.openSelectedButton} onClick={() => openEntries([...selected])}>
                Open {selected.size} {selected.size === 1 ? 'file' : 'files'} together
              </button>
              <button className={styles.clearSelectedButton} onClick={() => setSelected(new Set())}>
                Clear
              </button>
            </>
          )}
          <span className={styles.entryCount}>{archiveEntries.length} files</span>
        </div>
      </div>
      <div className="content">
      <div className={styles.container}>

      <div className={styles.tableWrapper}>
        <table className={tableStyles.table}>
          <thead className={tableStyles.tableHead}>
            <tr>
              <th className={tableStyles.tableHeadCell}>
                <input
                  type="checkbox"
                  className={styles.selectCheckbox}
                  checked={allSelected}
                  onChange={toggleSelectAll}
                  aria-label="Select all log files"
                />
              </th>
              <th className={tableStyles.tableHeadCell}>File</th>
              <th className={`${tableStyles.tableHeadCell} ${tableStyles.alignRight}`}>Lines</th>
              <th className={`${tableStyles.tableHeadCell} ${tableStyles.alignRight}`}>Sentry</th>
              <th className={`${tableStyles.tableHeadCell} ${tableStyles.alignRight}`}>Errors</th>
              <th className={`${tableStyles.tableHeadCell} ${tableStyles.alignRight}`}>Warnings</th>
              <th className={`${tableStyles.tableHeadCell} ${tableStyles.alignRight}`}>Requests</th>
              <th className={`${tableStyles.tableHeadCell} ${tableStyles.alignRight}`}>UTDs</th>
              <th className={`${tableStyles.tableHeadCell} ${tableStyles.alignRight}`}>Upload</th>
              <th className={`${tableStyles.tableHeadCell} ${tableStyles.alignRight}`}>Download</th>
              <th className={tableStyles.tableHeadCell}>Status</th>
            </tr>
          </thead>
          <tbody>
            {sortedEntries.map((entry) => {
              const displayName = stripEntryPrefix(entry.name);
              const summary = archiveSummaries.get(entry.name);
              // Until every file is summarized: this file's own count, reported pending.
              const utds: UtdCell | undefined = archiveUtds
                ? archiveUtds.get(entry.name)
                : summary && { count: summary.utdCount, reported: undefined, byReason: summary.utdReasons };
              const analyzable = isAnalyzableEntry(entry.name);
              const kind = getEntryKind(entry.name);
              return (
                <tr key={entry.name} className={tableStyles.tableRowHover}>
                  <td className={tableStyles.tableCell}>
                    {analyzable && (
                      <input
                        type="checkbox"
                        className={styles.selectCheckbox}
                        checked={selected.has(entry.name)}
                        onChange={() => toggleSelected(entry.name)}
                        aria-label={`Select ${displayName}`}
                      />
                    )}
                  </td>
                  <td className={tableStyles.tableCell}>
                    <button
                      className={`${styles.fileLink} ${(kind !== 'other' && visitedEntries.has(entry.name)) ? styles.fileLinkVisited : ''} ${kind === 'other' ? styles.fileLinkOther : ''}`}
                      onClick={() => handleOpen(entry.name)}
                      aria-label={`Open ${displayName}`}
                    >
                      {displayName}
                    </button>
                    {kind !== 'other' && (
                      <button
                        className={styles.rawLink}
                        onClick={() => handleOpenRaw(entry.name)}
                        aria-label={`Open raw text of ${displayName}`}
                      >
                        raw
                      </button>
                    )}
                  </td>

                  <DataCell summary={summary} analyzable={analyzable}>
                    {(s) => s.totalLines.toLocaleString()}
                  </DataCell>

                  <DataCell summary={summary} analyzable={analyzable}>
                    {(s) => (
                      <span className={s.sentryCount > 0 ? styles.sentryCount : styles.zeroCount}>
                        {s.sentryCount > 0 ? s.sentryCount.toLocaleString() : '—'}
                      </span>
                    )}
                  </DataCell>

                  <DataCell summary={summary} analyzable={analyzable}>
                    {(s) => (
                      <span className={s.errorCount > 0 ? styles.errorCount : styles.zeroCount}>
                        {s.errorCount > 0 ? s.errorCount.toLocaleString() : '—'}
                      </span>
                    )}
                  </DataCell>

                  <DataCell summary={summary} analyzable={analyzable}>
                    {(s) => (
                      <span className={s.warnCount > 0 ? styles.warnCount : styles.zeroCount}>
                        {s.warnCount > 0 ? s.warnCount.toLocaleString() : '—'}
                      </span>
                    )}
                  </DataCell>

                  <DataCell summary={summary} analyzable={analyzable}>
                    {(s) => (
                      <span className={s.httpCount === 0 ? styles.zeroCount : ''}>
                        {s.httpCount > 0 ? s.httpCount.toLocaleString() : '—'}
                      </span>
                    )}
                  </DataCell>

                  <DataCell summary={summary} analyzable={analyzable}>
                    {() => (utds && utds.count > 0 ? (
                      <span className={styles.errorCount} title={utdTitle(utds)}>
                        {`${utds.reported === undefined ? '…' : utds.reported === null ? '?' : utds.reported.toLocaleString()} (${utds.count.toLocaleString()})`}
                      </span>
                    ) : <span className={styles.zeroCount}>—</span>)}
                  </DataCell>

                  <DataCell summary={summary} analyzable={analyzable}>
                    {(s) => (
                      <span className={s.totalUploadBytes === 0 ? styles.zeroCount : ''}>
                        {s.totalUploadBytes > 0 ? formatBytes(s.totalUploadBytes) : '—'}
                      </span>
                    )}
                  </DataCell>

                  <DataCell summary={summary} analyzable={analyzable}>
                    {(s) => (
                      <span className={s.totalDownloadBytes === 0 ? styles.zeroCount : ''}>
                        {s.totalDownloadBytes > 0 ? formatBytes(s.totalDownloadBytes) : '—'}
                      </span>
                    )}
                  </DataCell>

                  {/* Status codes column — full width, not right-aligned */}
                  {!analyzable ? (
                    <td className={tableStyles.tableCell}>—</td>
                  ) : !summary ? (
                    <td className={tableStyles.tableCell}><span className={styles.loadingCell}>…</span></td>
                  ) : (
                    <td className={tableStyles.tableCell}>
                      <StatusChips statusCodes={summary.statusCodes} />
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      </div>

      {(pngEntries.length > 0 || parsedDetails) && (
        <div className={styles.container}>
          <div className={styles.bottomRow}>
            {pngEntries.length > 0 && (
              <div className={styles.pngGallery}>
                {pngEntries.map((entry) => {
                  const displayName = stripEntryPrefix(entry.name);
                  const url = pngUrls.get(entry.name);
                  return (
                    <button
                      key={entry.name}
                      className={styles.pngCard}
                      onClick={() => handleOpen(entry.name)}
                      aria-label={`Open ${displayName}`}
                    >
                      <img src={url} alt={displayName} className={styles.pngThumb} />
                      <span className={styles.pngName}>{displayName}</span>
                    </button>
                  );
                })}
              </div>
            )}
            {parsedDetails && (
              <div className={styles.detailsCard}>
                {matrixProfile && (
                  <div className={styles.profileHeader}>
                    <div className={styles.avatarCircle}>
                      {matrixProfile.avatarHttpUrl ? (
                        <img
                          src={matrixProfile.avatarHttpUrl}
                          alt=""
                          className={styles.avatarImg}
                        />
                      ) : (
                        <span className={styles.avatarInitial} aria-hidden="true">
                          {parsedDetails.userId ? userInitial(parsedDetails.userId) : '?'}
                        </span>
                      )}
                    </div>
                    <span className={styles.profileDisplayName}>
                      {matrixProfile.displayName ?? parsedDetails.userId}
                    </span>
                  </div>
                )}
                {parsedDetails.userText && (
                  <p className={styles.userText}>{parsedDetails.userText}</p>
                )}
                <dl className={styles.detailsList}>
                  {parsedDetails.userId && (
                    <>
                      <dt>User</dt>
                      <dd>
                        <a
                          href={`https://matrix.to/#/${encodeURIComponent(parsedDetails.userId)}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={styles.detailsLink}
                        >
                          <code>{parsedDetails.userId}</code>
                        </a>
                      </dd>
                    </>
                  )}
                  {parsedDetails.deviceId && (
                    <>
                      <dt>Device ID</dt>
                      <dd><code>{parsedDetails.deviceId}</code></dd>
                    </>
                  )}
                  {parsedDetails.deviceKeys && (
                    <>
                      <dt>Device keys</dt>
                      <dd><code className={styles.deviceKeys}>{parsedDetails.deviceKeys}</code></dd>
                    </>
                  )}
                  {parsedDetails.appId && (
                    <>
                      <dt>App</dt>
                      <dd>
                        <code>{parsedDetails.appId}</code>
                        {parsedDetails.version && (
                          <> - <code>{parsedDetails.version}</code></>
                        )}
                      </dd>
                    </>
                  )}
                  {parsedDetails.sdkSha && (
                    <>
                      <dt>SDK commit</dt>
                      <dd>
                        <a
                          href={`https://github.com/matrix-org/matrix-rust-sdk/commit/${parsedDetails.sdkSha}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={styles.detailsLink}
                        >
                          <code>{parsedDetails.sdkSha}</code>
                        </a>
                      </dd>
                    </>
                  )}
                </dl>
              </div>
            )}
          </div>
        </div>
      )}

      </div>
    </div>
  );
}


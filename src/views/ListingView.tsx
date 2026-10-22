/**
 * Mirrors the `/archive` view for remote rageshake listing pages opened through
 * the browser extension.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { gunzipSync } from 'fflate';
import { BurgerMenu } from '../components/BurgerMenu';
import tableStyles from '../components/Table.module.css';
import styles from './ArchiveView.module.css';
import { useListingStore } from '../stores/listingStore';
import { emptyArchiveSummary, isAnalyzableEntry, type ArchiveSummary } from '../utils/archiveSummary';
import { parseDetailsJson } from '../utils/detailsJson';
import { fetchExtensionFileBytes } from '../utils/extensionFileLoader';
import { openMergedEntries } from '../utils/openMergedLogs';
import { decodeTextBytes, isValidGzipHeader } from '../utils/fileValidator';
import {
  getEntryKind,
  sortEntries,
  stripEntryPrefix,
} from '../utils/listingEntries';
import { formatBytes } from '../utils/sizeUtils';
import { isNumericStatus } from '../utils/statusCodeUtils';
import { userInitial } from '../utils/matrixProfile';
import { useMatrixProfile } from '../hooks/useMatrixProfile';
import type { ListingDetails } from '../types/listing';

export const LISTING_URL_PARAM = 'listingUrl';

const NUMERIC_CODE_RE = { test: isNumericStatus };

interface FetchListingResponse {
  readonly ok: boolean;
  readonly entries?: ReadonlyArray<{ readonly name: string; readonly url: string }>;
  readonly detailsUrl?: string | null;
  readonly error?: string;
}

interface FetchDetailsResponse {
  readonly ok: boolean;
  readonly text?: string;
  readonly error?: string;
}

interface SummarizeResponse {
  readonly ok: boolean;
  readonly summary?: ArchiveSummary;
  readonly error?: string;
}

function getListingLabel(listingUrl: string | null): string {
  if (!listingUrl) return 'Listing';
  try {
    const parsed = new URL(listingUrl);
    const trimmed = parsed.pathname.replace(/^\/api\/listing\//, '').replace(/\/$/, '');
    return trimmed.length > 0 ? trimmed : 'Listing';
  } catch {
    return 'Listing';
  }
}

function StatusChips({ statusCodes }: { readonly statusCodes: Readonly<Record<string, number>> }) {
  const sorted = Object.entries(statusCodes).sort((a, b) => {
    const left = parseInt(a[0], 10);
    const right = parseInt(b[0], 10);
    if (!isNaN(left) && !isNaN(right)) return left - right;
    if (!isNaN(left)) return -1;
    if (!isNaN(right)) return 1;
    return a[0].localeCompare(b[0]);
  });

  return (
    <span className={styles.statusChips}>
      {sorted.map(([code, count]) => {
        const numericCode = parseInt(code, 10);
        let colorClass = styles.chipOther;
        if (!isNaN(numericCode)) {
          if (numericCode >= 200 && numericCode < 300) colorClass = styles.chip2xx;
          else if (numericCode >= 300 && numericCode < 400) colorClass = styles.chip3xx;
          else if (numericCode >= 400 && numericCode < 500) colorClass = styles.chip4xx;
          else if (numericCode >= 500) colorClass = styles.chip5xx;
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

function DataCell({
  summary,
  analyzable,
  children,
}: {
  readonly summary: ArchiveSummary | undefined;
  readonly analyzable: boolean;
  readonly children?: (summary: ArchiveSummary) => React.ReactNode;
}) {
  if (!analyzable) {
    return <td className={`${tableStyles.tableCell} ${tableStyles.alignRight}`}>—</td>;
  }
  if (!summary) {
    return (
      <td className={`${tableStyles.tableCell} ${tableStyles.alignRight}`}>
        <span className={styles.loadingCell}>…</span>
      </td>
    );
  }
  return <td className={`${tableStyles.tableCell} ${tableStyles.alignRight}`}>{children?.(summary)}</td>;
}

export function ListingView() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const listingUrlParam = searchParams.get(LISTING_URL_PARAM);
  const {
    listingUrl,
    listingEntries,
    listingSummaries,
    visitedEntries,
    loadListing,
    setListingSummary,
  } = useListingStore();
  /** Entry names ticked for opening together as one merged timeline. */
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [detailsUrl, setDetailsUrl] = useState<string | null>(null);
  const [parsedDetails, setParsedDetails] = useState<ListingDetails | null>(null);

  const matrixProfile = useMatrixProfile(parsedDetails?.userId);

  useEffect(() => {
    if (!listingUrlParam && listingEntries.length === 0) {
      void navigate('/', { replace: true });
      return;
    }

    const chromeGlobal = typeof chrome !== 'undefined' ? chrome : undefined;
    if (!listingUrlParam || !chromeGlobal?.runtime?.sendMessage) {
      return;
    }

    let cancelled = false;

    void (async () => {
      const response = (await chrome.runtime.sendMessage({
        type: 'fetchListing',
        listingUrl: listingUrlParam,
      })) as FetchListingResponse | undefined;

      if (cancelled) return;

      if (!response?.ok || !response.entries) {
        console.error('[ListingView] fetchListing failed:', response?.error ?? 'no response');
        void navigate('/', { replace: true });
        return;
      }

      if (listingUrl === listingUrlParam && listingEntries.length > 0) {
        setDetailsUrl(response.detailsUrl ?? null);
        return;
      }

      loadListing(listingUrlParam, response.entries);
      setDetailsUrl(response.detailsUrl ?? null);
    })().catch((error: unknown) => {
      if (cancelled) return;
      console.error('[ListingView] error fetching listing:', error);
      void navigate('/', { replace: true });
    });

    return () => {
      cancelled = true;
    };
  }, [listingEntries.length, listingUrl, listingUrlParam, loadListing, navigate]);

  useEffect(() => {
    const chromeGlobal = typeof chrome !== 'undefined' ? chrome : undefined;
    if (!detailsUrl || !chromeGlobal?.runtime?.sendMessage) {
      setParsedDetails(null);
      return;
    }

    let cancelled = false;

    void (async () => {
      const response = (await chrome.runtime.sendMessage({
        type: 'fetchDetails',
        detailsUrl,
      })) as FetchDetailsResponse | undefined;

      if (cancelled) return;

      if (!response?.ok || !response.text) {
        setParsedDetails(null);
        return;
      }

      setParsedDetails(parseDetailsJson(response.text));
    })().catch(() => {
      if (!cancelled) setParsedDetails(null);
    });

    return () => {
      cancelled = true;
    };
  }, [detailsUrl]);

  const sortedEntries = useMemo(() => sortEntries(listingEntries), [listingEntries]);
  const pngEntries = useMemo(
    () => sortedEntries.filter((entry) => entry.name.toLowerCase().endsWith('.png')),
    [sortedEntries]
  );
  const listingLabel = useMemo(() => getListingLabel(listingUrlParam ?? listingUrl), [listingUrl, listingUrlParam]);

  useEffect(() => {
    const chromeGlobal = typeof chrome !== 'undefined' ? chrome : undefined;
    if (!chromeGlobal?.runtime?.sendMessage) return;

    let cancelled = false;
    const analyzableEntries = sortedEntries.filter((entry) => isAnalyzableEntry(entry.name));
    let nextIndex = 0;
    let activeCount = 0;

    const runNext = (): void => {
      while (!cancelled && activeCount < 3 && nextIndex < analyzableEntries.length) {
        const entry = analyzableEntries[nextIndex++];
        if (listingSummaries.has(entry.name)) {
          continue;
        }
        activeCount++;
        void (async () => {
          try {
            const response = (await chrome.runtime.sendMessage({
              type: 'fetchAndSummarize',
              url: entry.url,
            })) as SummarizeResponse | undefined;

            if (cancelled) return;

            if (response?.ok && response.summary) {
              setListingSummary(entry.name, response.summary);
            } else {
              setListingSummary(entry.name, emptyArchiveSummary());
            }
          } catch {
            if (!cancelled) {
              setListingSummary(entry.name, emptyArchiveSummary());
            }
          } finally {
            activeCount--;
            if (!cancelled) {
              setTimeout(runNext, 0);
            }
          }
        })();
      }
    };

    runNext();

    return () => {
      cancelled = true;
    };
    // listingSummaries is intentionally excluded so the effect does not restart for each row update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setListingSummary, sortedEntries]);

  const handleOpen = useCallback(
    (entryName: string) => {
      const entry = listingEntries.find((candidate) => candidate.name === entryName);
      if (!entry) return;

      const kind = getEntryKind(entryName);
      if (kind === 'other') {
        // Validate URL scheme before opening — guard against javascript: or data:
        // URIs that a malformed or compromised listing page might inject.
        try {
          const url = new URL(entry.url);
          if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
        } catch {
          return;
        }
        window.open(entry.url, '_blank', 'noopener,noreferrer');
        return;
      }

      void (async () => {
        const route = await openMergedEntries([entryName]);
        if (route) void navigate(route);
      })();
    },
    [listingEntries, navigate]
  );

  /** Open all ticked log entries merged into one timeline. */
  const openSelected = useCallback(() => {
    void (async () => {
      const route = await openMergedEntries([...selected]);
      if (route) void navigate(route);
    })();
  }, [selected, navigate]);

  const handleOpenRaw = useCallback(
    (entryName: string) => {
      const entry = listingEntries.find((candidate) => candidate.name === entryName);
      if (!entry) return;

      void (async () => {
        let objectUrl: string | null = null;
        try {
          const bytes = await fetchExtensionFileBytes(entry.url, entry.name);
          if (!bytes) return;

          const decoded = isValidGzipHeader(bytes) ? gunzipSync(bytes) : bytes;
          const text = decodeTextBytes(decoded);
          const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
          objectUrl = URL.createObjectURL(blob);
          const opened = window.open(objectUrl, '_blank', 'noopener,noreferrer');
          if (!opened) {
            URL.revokeObjectURL(objectUrl);
            objectUrl = null;
            return;
          }
          // Revoke after a short delay — long enough for the tab to fetch the blob URL.
          setTimeout(() => {
            if (objectUrl) URL.revokeObjectURL(objectUrl);
          }, 3000);
        } catch {
          // gunzipSync or decoding failed; revoke the object URL if it was created.
          if (objectUrl) URL.revokeObjectURL(objectUrl);
        }
      })();
    },
    [listingEntries]
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

  if (!listingUrlParam && listingEntries.length === 0) {
    return null;
  }

  return (
    <div className="app">
      <div className="header-compact">
        <div className="header-left">
          <BurgerMenu />
          <h1 className="header-title">{listingLabel}</h1>
        </div>
        <div className="header-right">
          {selected.size > 0 && (
            <>
              <button className={styles.openSelectedButton} onClick={openSelected}>
                Open {selected.size} {selected.size === 1 ? 'file' : 'files'} together
              </button>
              <button className={styles.clearSelectedButton} onClick={() => setSelected(new Set())}>
                Clear
              </button>
            </>
          )}
          <span className={styles.entryCount}>{listingEntries.length} files</span>
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
                  <th className={`${tableStyles.tableHeadCell} ${tableStyles.alignRight}`}>Upload</th>
                  <th className={`${tableStyles.tableHeadCell} ${tableStyles.alignRight}`}>Download</th>
                  <th className={tableStyles.tableHeadCell}>Status</th>
                </tr>
              </thead>
              <tbody>
                {sortedEntries.map((entry) => {
                  const displayName = stripEntryPrefix(entry.name);
                  const summary = listingSummaries.get(entry.name);
                  const analyzable = isAnalyzableEntry(entry.name);
                  const kind = getEntryKind(entry.name);

                  return (
                    <tr key={entry.url} className={tableStyles.tableRowHover}>
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
                        {(value) => value.totalLines.toLocaleString()}
                      </DataCell>

                      <DataCell summary={summary} analyzable={analyzable}>
                        {(value) => (
                          <span className={value.sentryCount > 0 ? styles.sentryCount : styles.zeroCount}>
                            {value.sentryCount > 0 ? value.sentryCount.toLocaleString() : '—'}
                          </span>
                        )}
                      </DataCell>

                      <DataCell summary={summary} analyzable={analyzable}>
                        {(value) => (
                          <span className={value.errorCount > 0 ? styles.errorCount : styles.zeroCount}>
                            {value.errorCount > 0 ? value.errorCount.toLocaleString() : '—'}
                          </span>
                        )}
                      </DataCell>

                      <DataCell summary={summary} analyzable={analyzable}>
                        {(value) => (
                          <span className={value.warnCount > 0 ? styles.warnCount : styles.zeroCount}>
                            {value.warnCount > 0 ? value.warnCount.toLocaleString() : '—'}
                          </span>
                        )}
                      </DataCell>

                      <DataCell summary={summary} analyzable={analyzable}>
                        {(value) => (
                          <span className={value.httpCount === 0 ? styles.zeroCount : ''}>
                            {value.httpCount > 0 ? value.httpCount.toLocaleString() : '—'}
                          </span>
                        )}
                      </DataCell>

                      <DataCell summary={summary} analyzable={analyzable}>
                        {(value) => (
                          <span className={value.totalUploadBytes === 0 ? styles.zeroCount : ''}>
                            {value.totalUploadBytes > 0 ? formatBytes(value.totalUploadBytes) : '—'}
                          </span>
                        )}
                      </DataCell>

                      <DataCell summary={summary} analyzable={analyzable}>
                        {(value) => (
                          <span className={value.totalDownloadBytes === 0 ? styles.zeroCount : ''}>
                            {value.totalDownloadBytes > 0 ? formatBytes(value.totalDownloadBytes) : '—'}
                          </span>
                        )}
                      </DataCell>

                      {!analyzable ? (
                        <td className={tableStyles.tableCell}>—</td>
                      ) : !summary ? (
                        <td className={tableStyles.tableCell}>
                          <span className={styles.loadingCell}>…</span>
                        </td>
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
                    return (
                      <button
                        key={entry.url}
                        className={styles.pngCard}
                        onClick={() => handleOpen(entry.name)}
                        aria-label={`Open ${displayName}`}
                      >
                        <img src={entry.url} alt={displayName} className={styles.pngThumb} />
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
                          <img src={matrixProfile.avatarHttpUrl} alt="" className={styles.avatarImg} />
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
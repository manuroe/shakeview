import { useEffect, useRef } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useArchiveStore } from '../stores/archiveStore';
import { parseTarGzArchive } from '../utils/tarGzArchive';
import { isAnalyzableEntry } from '../utils/archiveSummary';
import { openMergedEntries } from '../utils/openMergedLogs';
import { loadCryptoDevice, startCase } from '../stores/cryptoStore';
import { deviceFromFile } from '../utils/crypto/loadDevice';
import { fetchBytes } from '../utils/fileValidator';

/** URL search-param key carrying the URL of a `.tar.gz` rageshake archive to open. */
export const ARCHIVE_URL_PARAM = 'archive';
/** URL search-param key naming one entry inside that archive to open on its own. */
export const ARCHIVE_FILE_PARAM = 'file';

/** Display name for the archive store: the URL's last path segment. */
function archiveNameFromUrl(url: string): string {
  try {
    const parsed = new URL(url, window.location.href);
    return parsed.pathname.split('/').filter(Boolean).pop() ?? url;
  } catch {
    return url.split('/').pop() ?? url;
  }
}

/**
 * Resolve `?file=` against the archive's entries, by full path or by basename —
 * a link cites `console.2026-07-21-14.log.gz`, while the entry carries the
 * archive-id directory prefix.
 *
 * @throws when the archive has no analyzable entry by that name. Failing beats
 *   falling back to opening everything: `line=` is a number *within* the named
 *   file, so a silent fallback would highlight an unrelated line rather than
 *   none. A non-log entry (`details.json`, a screenshot) fails the same way —
 *   parsing one as a log yields a view no `line=` means anything in.
 */
function entryNamesFor(entries: readonly { name: string }[], file: string | null): string[] {
  const logs = entries.filter((e) => isAnalyzableEntry(e.name));
  if (file === null) return logs.map((e) => e.name);
  const match = logs.find((e) => e.name === file || e.name.split('/').pop() === file);
  if (!match) throw new Error(`archive has no analyzable log named "${file}"`);
  return [match.name];
}

/**
 * Opens a rageshake archive fetched from a URL, reachable from a plain link.
 *
 * This is what makes deep links verifiable: a link carries `line=`, `filter=` and
 * `start=`/`end=` alongside `archive=`, and the recipient lands on the exact log
 * line without dropping the file in by hand.
 *
 * `file=` names one entry to open on its own, and `line=` is then the line number
 * *inside that file* — which is what the `rageshake` CLI prints. It is the fast
 * path by a wide margin: parsing one log takes ~0.3s against ~2.4s for merging
 * all 50-odd logs of a real archive, and a cited line lives in one of them.
 * Without `file=`, every analyzable entry is opened merged (the archive
 * listing's "open all"), for exploring rather than for pointing.
 *
 * The URL must be same-origin or CORS-readable; a local static server pointed at
 * a case folder is the intended source.
 *
 * The hook is a no-op when the `archive` param is absent. A present-but-empty one
 * is simply dropped from the URL.
 */
export function useArchiveUrl(): void {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  // The archive being opened right now, and the `archive` + `file` opened last.
  // Two refs, not one: an in-flight archive must be left alone, while an
  // already loaded one still needs its param dropped (see below). A failed load
  // records nothing, so following the same link again retries it.
  //
  // `inFlight` deliberately ignores `file`: a link that names another file of
  // the archive already downloading must not start a second download of it. The
  // run in flight picks the file up instead (see the open below).
  const inFlight = useRef<string | null>(null);
  const loaded = useRef<{ url: string; file: string | null } | null>(null);

  // The params as of the latest render. A strip lands after an await, and the
  // effect closure's copy is stale by then, so rebuilding from it would revert any
  // param that changed while the archive was downloading.
  const latestParams = useRef(searchParams);
  latestParams.current = searchParams;

  useEffect(() => {
    const archiveUrl = searchParams.get(ARCHIVE_URL_PARAM);
    if (archiveUrl === null) return;

    // /decryption links: the first archive becomes the loaded logs, the others added
    // devices (typically the sender's rageshake), and the view stays /decryption.
    const landing = pathname === '/decryption' ? '/decryption' : '/logs';
    const extraUrls = pathname === '/decryption' ? searchParams.getAll(ARCHIVE_URL_PARAM).slice(1) : [];

    // Drop the param so a refresh doesn't re-fetch, keeping line/filter/start/end.
    const stripParam = (route: string) => {
      const nextParams = new URLSearchParams(latestParams.current);
      nextParams.delete(ARCHIVE_URL_PARAM);
      void navigate({ pathname: route, search: nextParams.toString() }, { replace: true });
    };

    // `?archive=` with no value: nothing to fetch, but the param still has to go —
    // App.tsx's loading gate only checks that it is present, so leaving an empty
    // one behind holds the loading screen up forever.
    if (archiveUrl === '') {
      stripParam('/');
      return;
    }

    // StrictMode's mount → cleanup → mount, or any param change while the fetch
    // runs: let the in-flight run finish and navigate.
    if (inFlight.current === archiveUrl) return;

    // The very same link again — a report cites many lines in one file. Nothing
    // to do, but the param still has to go, or `archivePending` in App.tsx keeps
    // the loading screen up forever. Not when it adds devices: those still load.
    if (
      extraUrls.length === 0
      && loaded.current?.url === archiveUrl
      && loaded.current.file === searchParams.get(ARCHIVE_FILE_PARAM)
      // …and still in memory: a /decryption step link may have opened another archive since.
      && useArchiveStore.getState().archiveName === archiveNameFromUrl(archiveUrl)
    ) {
      stripParam(landing);
      return;
    }

    inFlight.current = archiveUrl;

    // No unmount cancellation on purpose: StrictMode's cleanup would cancel the
    // only in-flight fetch, and the second run returns on the guard above. The
    // async path only writes a store and navigates, so a late finish is harmless.
    void (async () => {
      // Failure lands on the landing page so the user gets the normal upload UI
      // rather than an empty log view with no explanation.
      let route = '/';
      try {
        // A second link into the archive already in memory — another file, or the
        // merged view — needs no download and no unpacking, just the open. The
        // store decides that, not `loaded`: dropping another archive in by hand
        // replaces `archiveEntries`, and resolving `file=` against those would
        // open a same-named log from the wrong rageshake.
        const archiveName = archiveNameFromUrl(archiveUrl);
        let entries = useArchiveStore.getState().archiveEntries;
        if (useArchiveStore.getState().archiveName !== archiveName) {
          entries = parseTarGzArchive(await fetchBytes(archiveUrl));
          useArchiveStore.getState().loadArchive(archiveName, entries);
        }

        // `file=` is read here, not from the effect's closure: a second link into
        // this same archive returned on the in-flight guard above rather than
        // starting its own download, so this run is the one that has to honour
        // it. If it moves again during the open, open again — the archive is in
        // memory by now, so that costs a parse, not a download.
        //
        // Ignore the route openMergedEntries returns: a link carrying `archive=`
        // is pointing at log lines, so /logs is where it has to land.
        let file: string | null;
        do {
          file = latestParams.current.get(ARCHIVE_FILE_PARAM);
          if (await openMergedEntries(entryNamesFor(entries, file)) === null) {
            throw new Error('no analyzable logs in archive');
          }
        } while (file !== latestParams.current.get(ARCHIVE_FILE_PARAM));
        loaded.current = { url: archiveUrl, file };
        route = landing;
        if (landing === '/decryption') {
          startCase();
          for (const url of extraUrls) {
            const name = archiveNameFromUrl(url);
            void loadCryptoDevice(name, async () => deviceFromFile(name, await fetchBytes(url)));
          }
        }
      } catch (err) {
        console.error('[useArchiveUrl] failed to open archive from URL:', archiveUrl, err);
      }
      inFlight.current = null;
      stripParam(route);
    })();
  }, [searchParams, navigate, pathname]);
}

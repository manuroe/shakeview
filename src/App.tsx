import { useEffect, useRef } from 'react';
import {
  HashRouter as Router,
  Routes,
  Route,
  useSearchParams,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import { LandingPage } from './views/LandingPage';
import { SummaryView } from './views/SummaryView';
import { SyncView } from './views/SyncView';
import { HttpRequestsView } from './views/HttpRequestsView';
import { LogsView } from './views/LogsView';
import { LogOverviewView } from './views/LogOverviewView';
import { SpansView } from './views/SpansView';
import { ArchiveView } from './views/ArchiveView';
import { ListingView, LISTING_URL_PARAM } from './views/ListingView';
import { useLogStore } from './stores/logStore';
import { useArchiveStore } from './stores/archiveStore';
import { useListingStore } from './stores/listingStore';
import { urlToTimeFormat } from './utils/timeUtils';
import { ErrorBoundary } from './components/ErrorBoundary';
import { DEFAULT_MS_PER_PIXEL } from './utils/timelineUtils';
import { parseStatusParam } from './hooks/useURLParams';
import { KeyboardShortcutProvider } from './components/KeyboardShortcutProvider';
import { ShortcutHelpOverlay, ChordToast } from './components/ShortcutHelpOverlay';
import { useExtensionFile } from './hooks/useExtensionFile';
import { useTabLog, TAB_LOG_PARAM } from './hooks/useTabLog';
import { useArchiveUrl, ARCHIVE_URL_PARAM } from './hooks/useArchiveUrl';
import { DecryptionView } from './views/DecryptionView';
import { AnonymizingProgressModal } from './components/AnonymizingProgressModal';
import uploadStyles from './components/FileUpload.module.css';

function AppContent() {
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { rawLogLines, setLastRoute } = useLogStore();
  const archiveEntries = useArchiveStore((state) => state.archiveEntries);
  const listingEntries = useListingStore((state) => state.listingEntries);
  
  // Ref to prevent redirect loops
  const isRedirecting = useRef(false);

  // Load log file passed by the browser extension (no-op outside extension context).
  useExtensionFile();

  // Load log text stored in localStorage when opened via "Open in new tab" on the /logs screen.
  useTabLog();

  // Load an archive from the `archive=<url>` param (deep links into a served case folder).
  useArchiveUrl();
  const archivePending = searchParams.get(ARCHIVE_URL_PARAM) !== null;

  // Reset redirect flag when location changes
  useEffect(() => {
    isRedirecting.current = false;
  }, [location.pathname, location.search]);

  // Single effect: URL → Store (one direction only)
  // Components write to URL, this effect syncs URL to store
  useEffect(() => {
    // Don't sync if there's no data - redirect will handle it
    if (rawLogLines.length === 0) {
      return;
    }

    const store = useLogStore.getState();
    const start = urlToTimeFormat(searchParams.get('start'));
    const end = urlToTimeFormat(searchParams.get('end'));
    const scaleParam = searchParams.get('scale');
    const scale = scaleParam ? parseInt(scaleParam, 10) : DEFAULT_MS_PER_PIXEL;
    const status = parseStatusParam(searchParams.get('status'));
    const filter = searchParams.get('filter');
    const requestId = searchParams.get('request_id');
    const timeoutParam = searchParams.get('timeout');
    const timeout = timeoutParam !== null ? parseInt(timeoutParam, 10) : null;

    // Update store (derived from URL)
    store.setTimeFilter(start, end);
    if (!isNaN(scale) && scale > 0) {
      store.setTimelineScale(scale);
    }
    store.setStatusCodeFilter(status);
    store.setLogFilter(filter);
    store.setSelectedTimeout(!isNaN(timeout ?? NaN) ? timeout : null);
    // When request_id is absent, clear the selection.
    // When present, each view's useUrlRequestAutoScroll handles opening by rowKey.
    if (requestId === null) {
      store.setActiveRequest(null);
    }
  }, [searchParams, rawLogLines.length]);

  // Track last route for "continue where you left off"
  useEffect(() => {
    const fullPath = `${location.pathname}${location.search}${location.hash}`;
    if (location.pathname !== '/') {
      setLastRoute(fullPath);
    }
  }, [location.pathname, location.search, location.hash, setLastRoute]);

  // Redirect to landing if no data
  useEffect(() => {
    const hasData = rawLogLines.length > 0;
    const hasArchive = archiveEntries.length > 0;
    const hasListing = listingEntries.length > 0;
    // Suppress redirect when a tab-log handoff is pending — useTabLog will
    // populate the store in its own effect and the redirect would race it.
    const tabLogPending = searchParams.get(TAB_LOG_PARAM) !== null;
    const listingPending = searchParams.get(LISTING_URL_PARAM) !== null;
    if (!hasData && !hasArchive && !hasListing && !tabLogPending && !listingPending && !archivePending && location.pathname !== '/' && !isRedirecting.current) {
      isRedirecting.current = true;
      void navigate('/', { replace: true });
    }
  }, [rawLogLines.length, archiveEntries.length, listingEntries.length, location.pathname, navigate, searchParams, archivePending]);

  // A deep link lands on the route it names (usually /logs) while the archive is
  // still being fetched and parsed, which would render an empty log view for a
  // few seconds. Show the loading state here rather than per route, so it covers
  // every link shape.
  if (archivePending) {
    return (
      <div className={uploadStyles.dropZone}>
        <div className={uploadStyles.dropZoneContent}>
          <p>Loading archive…</p>
        </div>
      </div>
    );
  }

  return (
    <KeyboardShortcutProvider>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/archive" element={<ArchiveView />} />
        <Route path="/listing" element={<ListingView />} />
        <Route path="/summary" element={<SummaryView />} />
        <Route path="/logs" element={<LogsView />} />
        <Route path="/triaged" element={<LogOverviewView />} />
        <Route path="/spans" element={<SpansView />} />
        <Route path="/http_requests" element={<HttpRequestsView />} />
        <Route path="/http_requests/sync" element={<SyncView />} />
        <Route path="/decryption" element={<DecryptionView />} />
      </Routes>
      <ShortcutHelpOverlay />
      <ChordToast />
      {/* Rendered here so it persists across route changes during async anonymisation */}
      <AnonymizingProgressModal />
    </KeyboardShortcutProvider>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <Router>
        <AppContent />
      </Router>
    </ErrorBoundary>
  );
}

export default App;

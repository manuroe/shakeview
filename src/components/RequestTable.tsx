import { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import type { CSSProperties } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLogStore } from '../stores/logStore';
import { useURLParams } from '../hooks/useURLParams';
import { WaterfallTimeline } from './WaterfallTimeline';
import { BurgerMenu } from './BurgerMenu';
import { TimeRangeSelector } from './TimeRangeSelector';
import { TimelineScaleSelector } from './TimelineScaleSelector';
import { StatusFilterDropdown } from './StatusFilterDropdown';
import { SearchInput } from './SearchInput';
import type { SearchInputHandle } from './SearchInput';
import { useKeyboardShortcutContextOptional } from './KeyboardShortcutContext';
import { metaKey, optionKey } from '../utils/shortcuts';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { calculateTimelineWidth, computeAutoScale } from '../utils/timelineUtils';
import { buildCompressedTimeline, buildLinearTimeline, formatGapDuration, LABEL_PADDING_PX } from '../utils/waterfallGapUtils';
import { LogDisplayView } from '../views/LogDisplayView';
import { isWebRequestId } from '../utils/logParser';
import { useUrlRequestAutoScroll } from '../hooks/useUrlRequestAutoScroll';
import { microsToMs, getMinMaxTimestamps } from '../utils/timeUtils';
import { formatBytes } from '../utils/sizeUtils';
import { getHttpStatusColor } from '../utils/httpStatusColors';
import { buildAttemptSegments, buildRetryTooltip, computeHasSegments } from '../utils/requestBarUtils';
import { INCOMPLETE_STATUS_KEY } from '../utils/statusCodeUtils';
import { buildProcessColorMap } from '../utils/processColors';
import { deriveAppStateSegments } from '../utils/lifecycleEvents';
import { makeRowStripeColorer } from '../utils/laneStripe';
import { ProcessLegend } from './ProcessLegend';
import type { HttpRequest } from '../types/log.types';
import { RowTimeAction } from './RowTimeAction';
import styles from './RequestTable.module.css';

/** All request rows are a fixed 28 px tall. Used by the virtualizer estimator. */
const ROW_HEIGHT_PX = 28;

/**
 * Column definition for the RequestTable component.
 */
export interface ColumnDef {
  /** Unique column identifier */
  id: string;
  /** Column header label */
  label: string;
  /** Extract the display value from a request */
  getValue: (req: HttpRequest) => string;
  /** Optional CSS class name for the column */
  className?: string;
}

/**
 * Props for the RequestTable component.
 */
export interface RequestTableProps {
  /** Title displayed in the header */
  title: string;
  /** Column definitions for the sticky left panel */
  columns: ColumnDef[];
  /** CSS class applied to the container for view-specific styling */
  containerClassName?: string;
  /** Filtered requests to display */
  filteredRequests: HttpRequest[];
  /** Total count to display (pre-calculated by the view) */
  totalCount: number;
  /** Whether to show incomplete requests */
  showIncomplete: boolean;
  /** Callback when incomplete checkbox changes */
  onShowIncompleteChange: (value: boolean) => void;
  /** Timeline scale (ms per pixel) */
  msPerPixel: number;
  /** Available status codes for filtering (including 'Incomplete' if applicable) */
  availableStatusCodes: string[];
  /** Optional additional header controls before the checkbox (e.g., connection dropdown) */
  headerSlot?: ReactNode;
  /** Message to show when no requests are found */
  emptyMessage?: string;
  /** CSS selector prefix for row measurement (e.g., '.sync-view' or '') */
  rowSelector?: string;
  /** Whether to show the log filter (default: true) */
  showLogFilter?: boolean;
  /** Whether to show the /sync filter checkbox (default: true). Set to false in SyncView where all requests are already sync. */
  showSyncFilter?: boolean;
  /**
   * Optional override for the bar background color.
   * Receives the request and the default computed color; return a CSS color string.
   * Use this to apply view-specific coloring (e.g., timeout-exceeded state).
   */
  getBarColor?: (req: HttpRequest, defaultColor: string) => string;
  /**
   * Optional renderer for overlay elements inside the waterfall bar.
   * Receives the request plus timeline dimensions so the caller can compute
   * pixel positions (e.g., a vertical tick at the timeout boundary).
   */
  renderBarOverlay?: (
    req: HttpRequest,
    barWidthPx: number,
    msPerPixel: number,
    durationToPixels: (durationMs: number) => number,
  ) => ReactNode;
  /**
   * Column IDs to show when waterfall-focus mode is active.
   * When provided, a compact toggle appears in the header; activating it hides
   * all other columns, freeing horizontal space for the waterfall timeline.
   * Hidden column values are surfaced in the tooltip of the last visible focus column.
   *
   * @example ['requestId', 'uri']
   */
  focusModeColumnIds?: readonly string[];
}

/**
 * Returns a unique numeric key for a request row, derived from line numbers.
 * Using line numbers (rather than requestId) ensures uniqueness even when
 * multiple requests share the same requestId.
 */
function getRowKey(req: HttpRequest): number {
  return (req.sendLineNumber || req.responseLineNumber) as number;
}

/**
 * Reusable request timeline table component.
 * Displays requests in a two-panel layout: sticky columns on the left, waterfall timeline on the right.
 *
 * Used by HttpRequestsView, SyncView, and other future request-type views.
 */
export function RequestTable({
  title,
  columns,
  containerClassName = '',
  filteredRequests,
  totalCount,
  showIncomplete,
  onShowIncompleteChange,
  msPerPixel,
  availableStatusCodes,
  headerSlot,
  emptyMessage = 'No requests found',
  showLogFilter = true,
  showSyncFilter = true,
  getBarColor,
  renderBarOverlay,
  focusModeColumnIds,
}: RequestTableProps) {
  const {
    expandedRows,
    openLogViewerIds,
    rawLogLines,
    lineNumberIndex,
    lifecycleEvents,
    toggleRowExpansion,
    closeLogViewer,
    setActiveRequest,
    logFilter,
    loadedEntryNames,
  } = useLogStore();
  // Colour request rows by originating process when several are merged
  // (e.g. console + nse); a single process needs no differentiation. The app
  // (console) stream is instead striped by app-state shade — see makeRowStripeColorer.
  const processColorMap = useMemo(() => buildProcessColorMap(loadedEntryNames), [loadedEntryNames]);
  const showProcessColors = processColorMap.size > 1;
  const stripeColorer = useMemo(() => {
    const { min, max } = getMinMaxTimestamps(rawLogLines);
    const stateSegments = deriveAppStateSegments(lifecycleEvents, min, max);
    return makeRowStripeColorer({ processColorMap, showProcessColors, stateSegments });
  }, [rawLogLines, lifecycleEvents, processColorMap, showProcessColors]);
  const navigate = useNavigate();
  const { setLogFilter, setScale, hasExplicitScale } = useURLParams();

  const waterfallContainerRef = useRef<HTMLDivElement>(null);
  const leftPanelRef = useRef<HTMLDivElement>(null);
  const stickyHeaderRef = useRef<HTMLDivElement>(null);
  /** Tracks whether auto-scale has fired for this mount. Resets on unmount so navigating back refits. */
  const autoScaleApplied = useRef(false);
  const [containerWidth, setContainerWidth] = useState(0);
  const [showSyncRequests, setShowSyncRequests] = useState(true);
  /** When true (default), idle gaps longer than the threshold are collapsed to narrow stripe bands. */
  const [collapseIdlePeriods, setCollapseIdlePeriods] = useState(true);
  /** Row key of the request whose RowTimeAction menu is open, or null. */
  const [menuOpenForRowKey, setMenuOpenForRowKey] = useState<number | null>(null);
  /** When true, only focusModeColumnIds columns are shown to widen the waterfall timeline. */
  const [waterfallFocus, setWaterfallFocus] = useState(focusModeColumnIds !== undefined);
  /** Stable toggle callback for the header button. */
  const handleCollapseToggle = useCallback(() => setWaterfallFocus((v) => !v), []);

  const isSyncRequest = (req: HttpRequest): boolean => /\/sync(?:[/?]|$)/i.test(req.uri);
  const displayedRequests = showSyncRequests
    ? filteredRequests
    : filteredRequests.filter((req) => !isSyncRequest(req));
  const isEmpty = displayedRequests.length === 0;

  /**
   * Columns rendered in the current layout mode.
   * In waterfall-focus mode only the columns whose id is in focusModeColumnIds
   * are shown; all others are hidden to widen the waterfall timeline.
   */
  const displayedColumns = useMemo(
    () => (waterfallFocus && focusModeColumnIds)
      ? columns.filter((c) => focusModeColumnIds.includes(c.id))
      : columns,
    [waterfallFocus, focusModeColumnIds, columns],
  );

  /** Columns hidden in waterfall-focus mode; their values are appended to the tooltip of the last visible focus column. */
  const hiddenColumns = useMemo(
    () => (waterfallFocus && focusModeColumnIds)
      ? columns.filter((c) => !focusModeColumnIds.includes(c.id))
      : [],
    [waterfallFocus, focusModeColumnIds, columns],
  );

  /**
   * CSS grid template for the focus-mode left panel, derived from the columns
   * actually displayed. Injected as --focus-grid-template on the container so
   * the panel shrinks exactly to fit the visible focus columns.
   * Each track resolves from a column-id CSS variable (e.g. --col-requestId,
   * --col-url) with --col-url as a safe fallback for unknown ids.
   * Falls back to a single --col-url track when no focus columns match.
   */
  const focusGridTemplate = (waterfallFocus && focusModeColumnIds)
    ? (
        displayedColumns.length > 0
          ? displayedColumns.map((col) => `var(--col-${col.id}, var(--col-url))`).join(' ')
          : 'var(--col-url)'
      )
    : undefined;

  // Log filter state with debouncing
  const [logFilterInput, setLogFilterInput] = useState(logFilter ?? '');
  const debouncedLogFilter = useDebouncedValue(logFilterInput, 300);

  // Ref for Cmd+F shortcut (focus log filter)
  const filterInputRef = useRef<SearchInputHandle>(null);
  const shortcutCtx = useKeyboardShortcutContextOptional();
  const registerFocusFilter = shortcutCtx?.registerFocusFilter;

  // Register Cmd+F → focus log filter while this RequestTable is mounted
  useEffect(() => {
    if (!registerFocusFilter || !showLogFilter) return;
    const unregister = registerFocusFilter(() => {
      filterInputRef.current?.focus();
    });
    return unregister;
  }, [registerFocusFilter, showLogFilter]);

  // Sync debounced log filter to URL
  useEffect(() => {
    const newFilter = debouncedLogFilter.length > 0 ? debouncedLogFilter : null;
    if (newFilter !== logFilter) {
      setLogFilter(newFilter);
    }
  }, [debouncedLogFilter, logFilter, setLogFilter]);

  // Sync store changes back to input (e.g., when URL changes externally)
  useEffect(() => {
    const storeValue = logFilter ?? '';
    if (storeValue !== logFilterInput && storeValue !== debouncedLogFilter) {
      setLogFilterInput(storeValue);
    }
    // logFilterInput and debouncedLogFilter are intentionally excluded: this effect must only
    // react to external store changes (e.g., URL navigation). Including local input state
    // would create a sync loop between the input and the store.
  }, [logFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleLogFilterClear = useCallback(() => {
    setLogFilterInput('');
    setLogFilter(null);
  }, [setLogFilter, setLogFilterInput]);

  // Vertical scroll is driven by a single .timelineContentWrapper container, so no
  // JS scroll-sync hook is needed between the left and right panels.

  // Calculate timeline scale
  // Find the maximum extent: the latest point where any request bar ends
  const timeData = useMemo(() => displayedRequests
    .map((r) => {
      const sendLine = lineNumberIndex.get(r.sendLineNumber);
      const startTime = microsToMs(sendLine?.timestampUs ?? 0);
      const endTime = startTime + (r.requestDurationMs || 0);
      return { startTime, endTime };
    })
    .filter((t) => t.startTime > 0), [displayedRequests, lineNumberIndex]);

  const minTime = timeData.length > 0 ? Math.min(...timeData.map(t => t.startTime)) : 0;
  // Compute the latest request end time without label padding, used for gap compression.
  const maxEndTime = timeData.length > 0 ? Math.max(...timeData.map(t => t.endTime)) : 0;
  // Use maxExtent to ensure the timeline is wide enough for all bars including their widths
  // Add extra time (in ms) to account for the duration label displayed after the last bar (e.g., "12888ms")
  // 80px worth of label space at the current scale
  const labelPaddingMs = LABEL_PADDING_PX * msPerPixel;
  const maxExtent = maxEndTime + labelPaddingMs;
  // totalDuration uses maxExtent so bar positions are correctly proportioned to timeline width
  const totalDuration = Math.max(1, maxExtent - minTime);

  // Calculate timeline width using shared logic (used by the linear path below)
  const visibleTimes = displayedRequests
    .slice(0, 20)
    .map((r) => {
      const sendLine = lineNumberIndex.get(r.sendLineNumber);
      return microsToMs(sendLine?.timestampUs ?? 0);
    })
    .filter((t) => t > 0);

  const { timelineWidth } = calculateTimelineWidth(
    containerWidth,
    visibleTimes,
    minTime,
    maxExtent,
    msPerPixel
  );

  /**
   * Piecewise timeline mapping: compressed when `collapseIdlePeriods` is on
   * (idle gaps > 5 s are collapsed to 28 px bands), linear otherwise.
   * All bar position and width calculations read from this single object so
   * that both modes stay in sync automatically.
   */
  const timeline = useMemo(() => {
    if (collapseIdlePeriods && timeData.length > 1) {
      const t = buildCompressedTimeline(timeData, minTime, maxEndTime, msPerPixel);
      // Append a fixed LABEL_PADDING_PX region so the duration label after the
      // last bar always has room.  This avoids the tail being treated as a gap
      // when labelPaddingMs > IDLE_GAP_THRESHOLD_MS (i.e. at very low zoom).
      return { ...t, totalWidthPx: t.totalWidthPx + LABEL_PADDING_PX };
    }
    return buildLinearTimeline(minTime, totalDuration, timelineWidth, msPerPixel);
  }, [collapseIdlePeriods, timeData, minTime, maxEndTime, msPerPixel, totalDuration, timelineWidth]);

  /**
   * Row virtualizer — only renders the rows visible in the scroll viewport plus
   * an overscan buffer. `getScrollElement` points at the wrapper div (leftPanelRef)
   * which is the single vertical scroll container shared by both panels.
   */
  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: displayedRequests.length,
    getScrollElement: () => leftPanelRef.current,
    estimateSize: () => ROW_HEIGHT_PX,
    overscan: 10,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const totalVirtualHeight = rowVirtualizer.getTotalSize();

  // Keep idle-gap labels visually pinned while the shared vertical container scrolls.
  // position:sticky is blocked by overflow-x:auto on .timelineRowsRight, so a JS listener
  // on the wrapper writes --gap-label-offset = scrollTop; the label uses translateY to follow.
  useEffect(() => {
    const scrollElement = leftPanelRef.current;
    if (!scrollElement) return;
    const updateGapLabelOffset = () => {
      scrollElement.style.setProperty('--gap-label-offset', `${scrollElement.scrollTop}px`);
    };
    updateGapLabelOffset();
    scrollElement.addEventListener('scroll', updateGapLabelOffset, { passive: true });
    return () => {
      scrollElement.removeEventListener('scroll', updateGapLabelOffset);
    };
  }, []);

  // Handle resize for layout measurements
  useEffect(() => {
    const handleResize = () => {
      if (!waterfallContainerRef.current) return;
      setContainerWidth(waterfallContainerRef.current.clientWidth);
    };

    handleResize();
    const observer = new ResizeObserver(() => handleResize());
    if (waterfallContainerRef.current) {
      observer.observe(waterfallContainerRef.current);
    }

    return () => {
      observer.disconnect();
    };
  }, []);

  // Automatically pick a scale so the first 25 requests fit the container, but only
  // when there is no explicit ?scale= URL param (i.e. the user has not set it manually).
  useEffect(() => {
    if (containerWidth === 0) return;
    if (hasExplicitScale) return;
    if (autoScaleApplied.current) return;
    const scale = computeAutoScale(timeData, containerWidth, 25, collapseIdlePeriods);
    if (scale === null) return;
    setScale(scale);
    autoScaleApplied.current = true;
  }, [containerWidth, timeData, hasExplicitScale, setScale, collapseIdlePeriods]);

  /** Handle click on request ID - toggle expansion or open log viewer */
  const handleRequestClick = useCallback((rowKey: number, requestId: string, req?: HttpRequest) => {
    // Remove request_id parameter from URL if clicking a different request,
    // while preserving all other query params (e.g., scale, timeout, status).
    const hashValue = window.location.hash.startsWith('#')
      ? window.location.hash.slice(1)
      : window.location.hash;
    const [hashPath, hashQuery = ''] = hashValue.split('?');
    const hashParams = new URLSearchParams(hashQuery);
    const urlId = hashParams.get('request_id');

    if (urlId && urlId !== requestId) {
      hashParams.delete('request_id');
      const newQuery = hashParams.toString();
      window.location.hash = newQuery ? `${hashPath}?${newQuery}` : hashPath;
    }

    // If clicking the same request that's already open, close it
    if (openLogViewerIds.has(rowKey) && expandedRows.has(rowKey)) {
      closeLogViewer(rowKey);
      toggleRowExpansion(rowKey);
      return;
    }
    // Open clicked request and close all others atomically
    setActiveRequest(rowKey);
    
    // Scroll waterfall to show the request if we have the request object
    if (req && waterfallContainerRef.current) {
      setTimeout(() => {
        const sendLine = lineNumberIndex.get(req.sendLineNumber);
        const reqTime = microsToMs(sendLine?.timestampUs ?? 0);
        const barLeft = timeline.timeToPixel(reqTime);
        const container = waterfallContainerRef.current;
        if (container) {
          const containerClientWidth = container.clientWidth;
          const targetScroll = barLeft - containerClientWidth * 0.2;
          container.scrollLeft = Math.max(0, targetScroll);
        }
      }, 0);
    }
  }, [openLogViewerIds, expandedRows, closeLogViewer, toggleRowExpansion, setActiveRequest, lineNumberIndex, timeline]);

  /** Handle mouse enter on a row - highlight both panels */
  const handleRowMouseEnter = (rowKey: number) => {
    const leftRow = document.querySelector(`[data-row-id="sticky-${rowKey}"]`);
    const rightRow = document.querySelector(`[data-row-id="waterfall-${rowKey}"]`);
    leftRow?.classList.add('row-hovered');
    rightRow?.classList.add('row-hovered');
  };

  /** Handle mouse leave on a row - remove highlight */
  const handleRowMouseLeave = (rowKey: number) => {
    const leftRow = document.querySelector(`[data-row-id="sticky-${rowKey}"]`);
    const rightRow = document.querySelector(`[data-row-id="waterfall-${rowKey}"]`);
    leftRow?.classList.remove('row-hovered');
    rightRow?.classList.remove('row-hovered');
  };

  /** Handle click on waterfall row - scroll to show request start time */
  const handleWaterfallRowClick = useCallback((req: HttpRequest) => {
    if (!waterfallContainerRef.current) return;

    const container = waterfallContainerRef.current;
    const sendLine = lineNumberIndex.get(req.sendLineNumber);
    const reqTime = microsToMs(sendLine?.timestampUs ?? 0);
    const barLeft = timeline.timeToPixel(reqTime);

    // Scroll to show the start of the request bar, with some padding (20% of container width)
    const containerClientWidth = container.clientWidth;
    const targetScroll = barLeft - containerClientWidth * 0.2;

    // Use direct scrollLeft assignment (scrollTo with smooth behavior doesn't work reliably)
    container.scrollLeft = Math.max(0, targetScroll);
  }, [lineNumberIndex, timeline]);

  // Sum upload/download bytes for displayed requests
  const { totalUploadBytes, totalDownloadBytes } = useMemo(() => {
    let up = 0;
    let down = 0;
    for (const req of displayedRequests) {
      up += req.requestSize;
      down += req.responseSize;
    }
    return { totalUploadBytes: up, totalDownloadBytes: down };
  }, [displayedRequests]);

  // Use shared URL auto-scroll hook (placed after handleWaterfallRowClick is defined)
  useUrlRequestAutoScroll(displayedRequests, leftPanelRef, handleWaterfallRowClick);

  /** Map column class names to CSS module class names */
  const getColumnClass = (className?: string): string => {
    if (!className) return '';
    const classMap: Record<string, string> = {
      time: styles.time,
      uri: styles.uri,
      method: styles.method,
      size: styles.size,
      duration: styles.duration,
      status: styles.status,
    };
    return classMap[className] || '';
  };

  /** Render the expanded log viewer for a request */
  const renderExpandedLogViewer = () => {
    const expandedRowKey = Array.from(openLogViewerIds).find(id => expandedRows.has(id));
    if (expandedRowKey === undefined) return null;

    const req = displayedRequests.find(r => getRowKey(r) === expandedRowKey);
    if (!req) return null;

    // Element Web lines carry no request id to filter on: show the request's
    // own send and response lines, picked by line number (0 = not in the log).
    const isWeb = isWebRequestId(req.requestId);
    const webLineNumbers = [req.sendLineNumber, req.responseLineNumber].filter((n) => n > 0);
    const sourceLines = isWeb
      ? webLineNumbers.flatMap((n) => lineNumberIndex.get(n) ?? [])
      : rawLogLines;

    return (
      <div className={styles.expandedLogViewer}>
        <LogDisplayView
          key={expandedRowKey}
          requestFilter={isWeb ? '' : `"${req.requestId}"`}
          defaultShowOnlyMatching
          defaultLineWrap
          logLines={sourceLines.map(line => ({
            ...line,
            timestamp: line.displayTime
          }))}
          onExpand={() => {
            const params = new URLSearchParams();
            if (isWeb) params.set('line', webLineNumbers.join('-'));
            else params.set('filter', `"${req.requestId}"`);
            const { startTime: storeStart, endTime: storeEnd } = useLogStore.getState();
            if (storeStart) params.set('start', storeStart);
            if (storeEnd) params.set('end', storeEnd);
            void navigate(`/logs?${params.toString()}`);
          }}
          onClose={() => {
            closeLogViewer(expandedRowKey);
            if (expandedRows.has(expandedRowKey)) {
              toggleRowExpansion(expandedRowKey);
            }
          }}
        />
      </div>
    );
  };

  return (
    <div className={`app ${containerClassName}`.trim()}>
      <div className="header-compact">
        <div className="header-left">
          <BurgerMenu />
          <h1 className="header-title">{title}</h1>
        </div>

        <div className="header-center">
          {headerSlot}

          {showSyncFilter && (
            <label className="checkbox-compact">
              <input
                type="checkbox"
                checked={showSyncRequests}
                onChange={(e) => setShowSyncRequests(e.target.checked)}
              />
              /sync
            </label>
          )}

          <label className="checkbox-compact">
            <input
              type="checkbox"
              checked={showIncomplete}
              onChange={(e) => onShowIncompleteChange(e.target.checked)}
            />
            Incomplete
          </label>

          <label className="checkbox-compact">
            <input
              type="checkbox"
              checked={collapseIdlePeriods}
              onChange={(e) => setCollapseIdlePeriods(e.target.checked)}
            />
            Collapse idle
          </label>

          <div className="stats-compact">
            <span id="shown-count">{displayedRequests.length}</span> / <span id="total-count">{totalCount}</span>
            {(totalUploadBytes > 0 || totalDownloadBytes > 0) && (
              <span style={{ marginLeft: '8px', opacity: 0.8 }}>
                &mdash; ↑ {formatBytes(totalUploadBytes)} / ↓ {formatBytes(totalDownloadBytes)}
              </span>
            )}
          </div>
        </div>

        <div className="header-right">
          {showLogFilter && (
            <SearchInput
              ref={filterInputRef}
              value={logFilterInput}
              onChange={setLogFilterInput}
              onClear={handleLogFilterClear}
              placeholder="Filter logs..."
              title={`Filter requests by log content (${optionKey}+/ or ${metaKey}+F)`}
              aria-label="Filter requests by log content"
            />
          )}
          <StatusFilterDropdown availableStatusCodes={availableStatusCodes} />
          <TimelineScaleSelector msPerPixel={msPerPixel} />
          <TimeRangeSelector />
        </div>
      </div>

      {showProcessColors && <ProcessLegend colorMap={processColorMap} />}

      <div
        className={`${styles.timelineContainer}${(waterfallFocus && focusModeColumnIds) ? ` ${styles.waterfallFocusMode}` : ''}`}
        // eslint-disable-next-line @typescript-eslint/naming-convention -- CSS custom property name
        style={focusGridTemplate !== undefined ? { '--focus-grid-template': focusGridTemplate } as CSSProperties : undefined}
      >
        <div className={styles.timelineHeader}>
          <div className={styles.timelineHeaderSticky} ref={stickyHeaderRef}>
            {focusModeColumnIds && (
              <button
                className={`${styles.collapseToggle}${waterfallFocus ? ` ${styles.collapseToggleActive}` : ''}`}
                onClick={handleCollapseToggle}
                aria-label={waterfallFocus ? 'Expand left panel' : 'Collapse left panel'}
                aria-pressed={waterfallFocus}
                title={waterfallFocus ? 'Expand columns' : 'Collapse columns'}
              >
                {waterfallFocus ? '»' : '«'}
              </button>
            )}
            {displayedColumns.map((col) => (
              <div
                key={col.id}
                className={`${styles.stickyCol} ${getColumnClass(col.className)}`}
              >
                {col.label}
              </div>
            ))}
          </div>
          <div className={styles.timelineHeaderWaterfall}>
            <WaterfallTimeline
              width={timeline.totalWidthPx}
              cursorContainerRef={waterfallContainerRef}
              cursorOffsetLeft={0}
            />
          </div>
        </div>

        <div className={styles.scrollContent}>
          <div className={styles.timelineContent}>
            {isEmpty && (
              <div className={styles.noData}>{emptyMessage}</div>
            )}
            {/* Always keep both panels mounted so scroll container refs (leftPanelRef / rightPanelRef)
                stay attached even when the list temporarily becomes empty (e.g. mid-filter). Using
                display:none rather than conditional rendering prevents the refs from going null. */}
            <div
              data-testid="request-table-scroll-wrapper"
              ref={leftPanelRef}
              className={styles.timelineContentWrapper}
              style={isEmpty ? { display: 'none' } : undefined}
            >
                {/* Left panel - sticky columns */}
                <div data-testid="request-table-left-scroll" className={styles.timelineRowsLeft}>
                  {/*
                   * Padding approach: rows stay in normal flow so the grid content
                   * establishes the container's width correctly. Padding-top/bottom
                   * stand in for the rows that are scrolled out of view, making the
                   * total height equal to totalVirtualHeight without needing a
                   * position:relative spacer (which would collapse to width 0 because
                   * all absolutely-positioned children are taken out of flow).
                   */}
                  <div
                    style={{
                      paddingTop: `${virtualRows[0]?.start ?? 0}px`,
                      paddingBottom: `${Math.max(0, totalVirtualHeight - (virtualRows[virtualRows.length - 1]?.end ?? totalVirtualHeight))}px`,
                    }}
                  >
                    {virtualRows.map((vRow) => {
                      const req = displayedRequests[vRow.index];
                      const rowKey = getRowKey(req);
                      const sendLine = lineNumberIndex.get(req.sendLineNumber);
                      const processColor = stripeColorer(sendLine?.sourceFile, sendLine?.timestampUs);
                      return (
                      <div
                        key={`sticky-${rowKey}`}
                        data-row-id={`sticky-${rowKey}`}
                        className={`${styles.requestRow} ${vRow.index % 2 === 0 ? styles.rowOdd : ''} ${openLogViewerIds.has(rowKey) ? styles.selected : ''} ${(expandedRows.has(rowKey) && openLogViewerIds.has(rowKey)) ? styles.expanded : ''} ${(!req.status && !req.clientError) ? styles.incomplete : ''}`}
                        style={{
                          height: `${vRow.size}px`,
                          cursor: 'pointer',
                          zIndex: menuOpenForRowKey === rowKey ? 10 : undefined,
                        }}
                        onMouseEnter={() => handleRowMouseEnter(rowKey)}
                        onMouseLeave={() => handleRowMouseLeave(rowKey)}
                        onClick={() => handleWaterfallRowClick(req)}
                      >
                        {/* Stripe lives on the sticky row (above its own opaque
                            background) so it shows on every row, not just the
                            translucent selected one. */}
                        <div
                          className={styles.requestRowSticky}
                          style={processColor ? { boxShadow: `inset 3px 0 0 0 ${processColor}` } : undefined}
                        >
                          {/* Leading actions column */}
                          <RowTimeAction
                            timestampUs={lineNumberIndex.get(req.sendLineNumber)?.timestampUs}
                            onOpenChange={(open) =>
                              setMenuOpenForRowKey((prev) => (open ? rowKey : prev === rowKey ? null : prev))
                            }
                          />
                          {displayedColumns.map((col, i) => {
                            const isLastCol = i === displayedColumns.length - 1;
                            const hiddenSuffix = (isLastCol && hiddenColumns.length > 0)
                              ? hiddenColumns.map((hc) => hc.getValue(req)).filter(Boolean)
                              : [];
                            // First column is clickable request ID
                            if (i === 0) {
                              const titleValue = hiddenSuffix.length > 0
                                ? [col.getValue(req), ...hiddenSuffix].join(' · ')
                                : undefined;
                              return (
                                <div
                                  key={col.id}
                                  className={`${styles.requestId} ${styles.clickable} ${styles.stickyCol} ${getColumnClass(col.className)}`}
                                  data-testid={`request-id-${req.requestId}`}
                                  title={titleValue}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleRequestClick(rowKey, req.requestId, req);
                                  }}
                                >
                                  {col.getValue(req)}
                                </div>
                              );
                            }
                            return (
                              <div
                                key={col.id}
                                className={`${styles.stickyCol} ${getColumnClass(col.className)}`}
                                title={hiddenSuffix.length > 0
                                  ? [col.getValue(req), ...hiddenSuffix].join(' · ')
                                  : col.getValue(req)
                                }
                              >
                                {col.getValue(req)}
                              </div>
                            );
                          })}

                        </div>
                      </div>
                      );
                    })}
                  </div>
                </div>

                {/* Right panel - waterfall */}
                <div data-testid="request-table-right-scroll" className={styles.timelineRowsRight} ref={waterfallContainerRef}>
                  {/* Spacer div establishes the full scrollable height and contains absolutely-positioned rows + gap overlays. */}
                  <div style={{ width: `${timeline.totalWidthPx}px`, height: `${totalVirtualHeight}px`, position: 'relative' }}>
                    {virtualRows.map((vRow) => {
                      const req = displayedRequests[vRow.index];
                      const sendLine = lineNumberIndex.get(req.sendLineNumber);
                      const reqTime = microsToMs(sendLine?.timestampUs ?? 0);
                      const barLeft = timeline.timeToPixel(reqTime);
                      const barWidth = timeline.durationToPixels(reqTime, reqTime + req.requestDurationMs);
                      const isClientError = !req.status && !!req.clientError;
                      const resolvedIsIncomplete = !req.status && !req.clientError;
                      const resolvedStatus = req.status ? req.status : (req.clientError ?? INCOMPLETE_STATUS_KEY);
                      const statusCode = req.status ? req.status.split(' ')[0] : '';
                      const defaultBarColor = isClientError
                        ? 'var(--http-client-error)'
                        : resolvedIsIncomplete
                        ? 'var(--http-incomplete)'
                        : getHttpStatusColor(statusCode);
                      const barColor = getBarColor ? getBarColor(req, defaultBarColor) : defaultBarColor;

                      const hasSegments = computeHasSegments(req);
                      const attemptSegments = hasSegments
                        ? buildAttemptSegments(req.attemptOutcomes!, req.attemptTimestampsUs as number[], req.requestDurationMs, barWidth)
                        : null;
                      // For retry requests, build a tooltip listing each attempt outcome with its
                      // individual duration, e.g. "↻3: 503 (20ms) → 503 (100ms) → 200 (1500ms) — 1620ms"
                      const retryTooltip = hasSegments
                        ? buildRetryTooltip(req.attemptOutcomes!, req.attemptTimestampsUs as number[], req.requestDurationMs, req.numAttempts!)
                        : null;

                      const rowKey = getRowKey(req);
                      return (
                        <div
                          key={`waterfall-${rowKey}`}
                          data-row-id={`waterfall-${rowKey}`}
                          className={`${styles.requestRow} ${vRow.index % 2 === 0 ? styles.rowOdd : ''} ${openLogViewerIds.has(rowKey) ? styles.selected : ''} ${(expandedRows.has(rowKey) && openLogViewerIds.has(rowKey)) ? styles.expanded : ''} ${resolvedIsIncomplete ? styles.incomplete : ''}`}
                          style={{
                            position: 'absolute',
                            top: `${vRow.start}px`,
                            width: '100%',
                            height: `${vRow.size}px`,
                            cursor: 'pointer',
                          }}
                          onMouseEnter={() => handleRowMouseEnter(rowKey)}
                          onMouseLeave={() => handleRowMouseLeave(rowKey)}
                          onClick={() => handleWaterfallRowClick(req)}
                        >
                          <div style={{ position: 'relative', overflow: 'visible' }}>
                            <div
                              className={styles.waterfallItem}
                              style={{
                                left: `${barLeft}px`,
                                position: 'absolute',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '8px',
                              }}
                            >
                              <div
                                className={styles.waterfallBar}
                                style={{
                                  width: `${barWidth}px`,
                                  background: barColor,
                                }}
                                title={resolvedIsIncomplete ? INCOMPLETE_STATUS_KEY : (retryTooltip ?? resolvedStatus)}
                              >
                                {attemptSegments && attemptSegments.flatMap(({ leftPx, widthPx, color }, idx) => {
                                  const segment = (
                                    <div
                                      key={`seg-${idx}`}
                                      data-testid="attempt-segment"
                                      style={{
                                        position: 'absolute',
                                        top: 0,
                                        bottom: 0,
                                        left: `${leftPx}px`,
                                        width: `${widthPx}px`,
                                        background: color,
                                        pointerEvents: 'none',
                                      }}
                                    />
                                  );
                                  if (idx < attemptSegments.length - 1 && widthPx > 0) {
                                    return [
                                      segment,
                                      // Separator line between retry attempts
                                      <div
                                        key={`sep-${idx}`}
                                        aria-hidden="true"
                                        style={{
                                          position: 'absolute',
                                          top: 0,
                                          bottom: 0,
                                          left: `${leftPx + widthPx - 1}px`,
                                          width: '1px',
                                          background: 'rgba(255, 255, 255, 0.75)',
                                          zIndex: 1,
                                          pointerEvents: 'none',
                                        }}
                                      />,
                                    ];
                                  }
                                  return [segment];
                                })}
                                {!resolvedIsIncomplete && renderBarOverlay && renderBarOverlay(req, barWidth, msPerPixel, (dMs) => timeline.durationToPixels(0, dMs))}
                              </div>
                              <span className={styles.waterfallDuration} title={resolvedIsIncomplete ? INCOMPLETE_STATUS_KEY : (retryTooltip ?? resolvedStatus)}>
                                {resolvedIsIncomplete
                                  ? '...'
                                  : retryTooltip
                                  ? retryTooltip
                                  : statusCode === '200'
                                  ? `${req.requestDurationMs}ms`
                                  : `${resolvedStatus} - ${req.requestDurationMs}ms`
                                }
                              </span>
                            </div>
                          </div>
                        </div>
                      );
                    })}

                    {/* Idle gap overlay bands — absolutely positioned full-height stripes */}
                    {collapseIdlePeriods && timeline.segments
                      .filter(s => s.type === 'gap')
                      .map(seg => (
                        <div
                          key={seg.startMs}
                          className={styles.gapOverlay}
                          style={{ left: `${seg.startPx}px`, width: `${seg.widthPx}px` }}
                          aria-hidden="true"
                        >
                          <span
                            className={styles.gapLabel}
                            title={`No HTTP activity for ${formatGapDuration(seg.durationMs)}`}
                          >
                            {formatGapDuration(seg.durationMs)}
                          </span>
                        </div>
                      ))
                    }
                  </div>
                </div>
              </div>
          </div>
        </div>

        {renderExpandedLogViewer()}

      </div>
    </div>
  );
}

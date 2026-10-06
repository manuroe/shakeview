import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useLogStore } from '../stores/logStore';
import type { ParsedLogLine } from '../types/log.types';
import { buildDisplayItems, calculateGapExpansion, type ForcedRange } from '../utils/logGapManager';
import { findMatchingIndices, expandWithContext, highlightText as highlightTextUtil } from '../utils/textMatching';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { useMatchNavigation } from '../hooks/useMatchNavigation';
import { SearchInput } from '../components/SearchInput';
import type { SearchInputHandle } from '../components/SearchInput';
import { useKeyboardShortcutContextOptional } from '../components/KeyboardShortcutContext';
import { isInputFocused, metaKey } from '../utils/shortcuts';
import { generateGitHubSourceUrl, resolveSwiftFilenameToBlobUrl } from '../utils/githubLinkGenerator';
import { detectCollapseGroups, type CollapseGroupInfo } from '../utils/logCollapsingUtils';
import { getHttpStatusColor } from '../utils/httpStatusColors';
import { HTTP_CLIENT_ERROR_RE, locatePrettySourceRef } from '../utils/logParser';
import { buildProcessColorMap } from '../utils/processColors';
import { deriveAppStateSegments } from '../utils/lifecycleEvents';
import { makeRowStripeColorer } from '../utils/laneStripe';
import { getMinMaxTimestamps } from '../utils/timeUtils';
import { spanSegments, spanFilterValue, SPANS_MARKER } from '../utils/spansParser';
import { ProcessLegend } from '../components/ProcessLegend';
import { LogExportDialog } from '../components/LogExportDialog';
import { UnanonymizeDialog } from '../components/UnanonymizeDialog';
import { AnonMappingDialog } from '../components/AnonMappingDialog';
import type { ExportContext } from '../utils/logExportUtils';
import { removeTabLog, storeTabLog } from '../utils/tabLogUtils';
import { TAB_LOG_PARAM } from '../hooks/useTabLog';
import { RowTimeAction } from '../components/RowTimeAction';
import styles from './LogDisplayView.module.css';

const HTTP_ERROR_RE = /\bstatus=(\d{3})\b/;
function getHttpErrorStatus(rawText: string): string | null {
  if (HTTP_CLIENT_ERROR_RE.test(rawText)) return 'client-error';
  const m = rawText.match(HTTP_ERROR_RE);
  if (!m) return null;
  const code = parseInt(m[1], 10);
  return code >= 400 ? m[1] : null;
}

/** True when `lineNumber` falls inside the inclusive highlight range, if there is one. */
function isInHighlightRange(
  lineNumber: number | undefined,
  range: { start: number; end: number } | undefined
): boolean {
  if (range === undefined || lineNumber === undefined) return false;
  return lineNumber >= range.start && lineNumber <= range.end;
}

/**
 * Props for LogDisplayView.
 *
 * ### `logLines` vs store lines
 *
 * When `logLines` is provided it is used as the source of truth instead of
 * `rawLogLines` from the global store. This is the mechanism used by
 * request-detail panels to show only the lines that belong to a specific
 * request, without touching global state.
 *
 * When `logLines` is omitted the view reads from the store and shows the
 * full log, subject to any active filters.
 *
 * ### `lineRange` — secondary scoping within the line array
 *
 * `lineRange` is an **inclusive** `{ start, end }` filter on `lineNumber`
 * that is applied *after* selecting the line source:
 *
 * - If `logLines` is also set, `lineRange` further restricts that slice
 *   (e.g. a sub-range of lines within the request's own log segment).
 * - If only `lineRange` is set (no `logLines`), the view searches the
 *   full store log and initially renders lines whose `lineNumber` falls
 *   within the range — typically used to open a focused view on a single
 *   request from the waterfall without constructing a bespoke line array.
 *
 * Gap expansion controls are still computed against the selected source
 * line array. Expanding a gap may therefore reveal lines outside `lineRange`.
 *
 * ### Precedence summary
 *
 * | `logLines` | `lineRange` | Result |
 * |---|---|---|
 * | provided | omitted | shows `logLines` (all) |
 * | provided | provided | initially shows `logLines` filtered to `lineRange`; gap expansion can reveal surrounding lines |
 * | omitted | provided | initially shows store lines filtered to `lineRange`; gap expansion can reveal surrounding lines |
 * | omitted | omitted | shows all store lines |
 */
interface LogDisplayViewProps {
  requestFilter?: string;
  defaultShowOnlyMatching?: boolean;
  defaultLineWrap?: boolean;
  onClose?: () => void;
  onExpand?: () => void;
  onFilterChange?: (filter: string) => void;
  prevRequestLineRange?: { start: number; end: number };
  nextRequestLineRange?: { start: number; end: number };
  /** Override the line source; when absent, falls back to `rawLogLines` from the store. */
  logLines?: ParsedLogLine[];
  /**
   * Inclusive line-number range `{ start, end }`. When set, the initial
   * rendered set is restricted to lines whose `lineNumber` falls within
   * this range. Gap expansion may reveal lines outside the range. Applied
   * after the `logLines` / store selection — see interface-level JSDoc for
   * the full precedence table.
   */
  lineRange?: { start: number; end: number };
  /**
   * When true, renders the anonymize/unanonymize toolbar button.
   * Only the `/logs` route passes this prop; request-detail panels do not.
   */
  showAnonymizeButton?: boolean;
  /**
   * When set, every line whose `lineNumber` falls in this **inclusive** range is
   * highlighted, and `start` is scrolled to the center on mount. A single line is
   * `start === end`. Used by the overview drilldown to point at the exact
   * occurrence the user clicked, and by `?line=N` / `?line=A-B` deep links.
   *
   * Pass a referentially stable object: this and `lineRange` are dependencies of
   * the O(n) line-filtering memos, so an inline object re-runs them on every
   * render of the caller. Both drilldown panels memoize the pair.
   */
  highlightLines?: { start: number; end: number };
}

export function LogDisplayView({ requestFilter = '', defaultShowOnlyMatching: _defaultShowOnlyMatching = false, defaultLineWrap = false, onClose, onExpand, onFilterChange, prevRequestLineRange, nextRequestLineRange, logLines, lineRange, showAnonymizeButton = false, highlightLines }: LogDisplayViewProps) {
  const { rawLogLines, sentryEvents, lifecycleEvents, startTime, endTime, isAnonymized, isAnonymizing, originalLogLines, anonymizationDictionary, anonymizeLogs, unanonymizeLogs, logFileName, loadedEntryNames } = useLogStore();
  // Colour lines by process only when several distinct processes are merged
  // (e.g. console + nse); a single process needs no differentiation. The app
  // (console) stream is instead striped by app-state shade — see makeRowStripeColorer.
  const processColorMap = useMemo(() => buildProcessColorMap(loadedEntryNames), [loadedEntryNames]);
  const showProcessColors = processColorMap.size > 1;
  const stripeColorer = useMemo(() => {
    const { min, max } = getMinMaxTimestamps(rawLogLines);
    const stateSegments = deriveAppStateSegments(lifecycleEvents, min, max);
    return makeRowStripeColorer({ processColorMap, showProcessColors, stateSegments });
  }, [rawLogLines, lifecycleEvents, processColorMap, showProcessColors]);
  const shortcutCtx = useKeyboardShortcutContextOptional();
  const registerFocusSearch = shortcutCtx?.registerFocusSearch;
  const registerFocusFilter = shortcutCtx?.registerFocusFilter;
  // Keep a ref so the keydown handler always sees the latest showHelp value without
  // needing to re-register the listener on every help-overlay toggle.
  const showHelpRef = useRef(shortcutCtx?.showHelp ?? false);
  useEffect(() => {
    showHelpRef.current = shortcutCtx?.showHelp ?? false;
  }, [shortcutCtx?.showHelp]);
  
  // Use passed logLines if provided, otherwise use all raw log lines from store
  const displayLogLines = logLines || rawLogLines;

  const sentryLineNumbers = useMemo(() => new Set(sentryEvents.map((e) => e.lineNumber)), [sentryEvents]);
  const sentryEventByLineNumber = useMemo(
    () => new Map(sentryEvents.map((event) => [event.lineNumber, event])),
    [sentryEvents]
  );

  const [searchQueryInput, setSearchQueryInput] = useState('');
  const [filterQueryInput, setFilterQueryInput] = useState(requestFilter);

  // Ref for programmatic focus ("/" shortcut)
  const searchInputRef = useRef<SearchInputHandle>(null);
  const filterInputRef = useRef<SearchInputHandle>(null);

  // Register "/" → focus search when this view is mounted
  useEffect(() => {
    if (!registerFocusSearch) return;
    const unregister = registerFocusSearch(() => {
      searchInputRef.current?.focus();
    });
    return unregister;
  }, [registerFocusSearch]);

  // Register "Option+/" (and "Cmd+F") → focus filter when this view is mounted
  useEffect(() => {
    if (!registerFocusFilter) return;
    const unregister = registerFocusFilter(() => {
      filterInputRef.current?.focus();
    });
    return unregister;
  }, [registerFocusFilter]);
  
  // Track when we're syncing from prop to avoid calling onFilterChange
  const isSyncingFromProp = useRef(false);
  
  // Sync filter input when requestFilter prop changes (e.g., URL→Store sync)
  useEffect(() => {
    if (requestFilter !== filterQueryInput) {
      isSyncingFromProp.current = true;
      setFilterQueryInput(requestFilter);
    }
    // filterQueryInput is intentionally excluded: this effect must only react to
    // prop changes from the parent. Including it would cause every local keystroke
    // to re-run the effect and reset the input back to the prop value, clobbering
    // the user's in-progress edits.
  }, [requestFilter]); // eslint-disable-line react-hooks/exhaustive-deps
  
  // Debounce inputs to avoid recalculating on every keystroke
  const searchQuery = useDebouncedValue(searchQueryInput, 300);
  const filterQuery = useDebouncedValue(filterQueryInput, 300);

  // Notify parent when debounced filter value changes (only for user-initiated changes)
  useEffect(() => {
    // If we just synced from prop, clear the flag when debounced value catches up
    if (isSyncingFromProp.current) {
      if (filterQuery === requestFilter) {
        isSyncingFromProp.current = false;
      }
      // Don't call onFilterChange while syncing
      return;
    }
    
    if (onFilterChange && filterQuery !== requestFilter) {
      onFilterChange(filterQuery);
    }
  }, [filterQuery, onFilterChange, requestFilter]);

  const [contextLines, setContextLines] = useState(0);
  const [lineWrap, setLineWrap] = useState(defaultLineWrap);
  const [stripPrefix, setStripPrefix] = useState(true);
  const [forcedRanges, setForcedRanges] = useState<ForcedRange[]>([]);
  const [hoveredLineIndex, setHoveredLineIndex] = useState<number | null>(null);
  /** Index of the row whose RowTimeAction menu is currently open, or null. */
  const [menuOpenForIndex, setMenuOpenForIndex] = useState<number | null>(null);
  const [collapseEnabled, setCollapseEnabled] = useState(true);
  const [showExport, setShowExport] = useState(false);
  const [showUnanonymizeDialog, setShowUnanonymizeDialog] = useState(false);
  const [showMapping, setShowMapping] = useState(false);

  // Cmd/Ctrl+S → open export; w/p → toggle line wrap and strip prefix (when no input focused)
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const isMetaOrCtrl = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      // Cmd+S (macOS) or Ctrl+S (Windows/Linux) → open export dialog
      if (isMetaOrCtrl && !e.altKey && !e.shiftKey && key === 's') {
        e.preventDefault();
        setShowExport(true);
      }
      // w / p → toggles (only when no input focused and help overlay is closed)
      else if (!isInputFocused() && !showHelpRef.current && !e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey) {
        if (key === 'w') {
          e.preventDefault();
          setLineWrap((v) => !v);
        } else if (key === 'p') {
          e.preventDefault();
          setStripPrefix((v) => !v);
        }
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, []);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    gapId: string;
    direction: 'up' | 'down';
    isFirst: boolean;
    isLast: boolean;
  } | null>(null);
  const parentRef = useRef<HTMLDivElement>(null);

  // Filter determines which lines to show/hide (like old showOnlyMatching behavior)
  const filterMatchingLineIndices = useMemo(() => {
    return findMatchingIndices(displayLogLines, filterQuery, false, (line) => line.rawText);
  }, [displayLogLines, filterQuery]);

  // Build the filtered lines based on filter query and context
  const filteredLines = useMemo(() => {
    let allLines = displayLogLines.map((line, index) => ({ line, index }));

    // Pre-scope to line range when specified (e.g., a single request's lines)
    if (lineRange) {
      allLines = allLines.filter(({ line }) => {
        const ln = line.lineNumber ?? 0;
        return ln >= lineRange.start && ln <= lineRange.end;
      });
    }

    // If no filter, show all (range-scoped) lines
    if (!filterQuery.trim()) return allLines;

    // If filter is set but no matches, show empty
    if (filterMatchingLineIndices.size === 0) return [];

    // Expand matches with context lines using utility
    const linesToShow = expandWithContext(filterMatchingLineIndices, displayLogLines.length, contextLines);

    return allLines.filter(({ index }) => linesToShow.has(index));
  }, [displayLogLines, lineRange, filterQuery, contextLines, filterMatchingLineIndices]);

  // Collapse consecutive duplicate/similar lines
  const { visibleLines, collapseGroupsMap } = useMemo(() => {
    if (!collapseEnabled) {
      return { visibleLines: filteredLines, collapseGroupsMap: new Map<string, CollapseGroupInfo>() };
    }
    const { collapsedIndices, collapseGroups } = detectCollapseGroups(filteredLines);
    if (collapsedIndices.size === 0) {
      return { visibleLines: filteredLines, collapseGroupsMap: collapseGroups };
    }
    return {
      // Never collapse a highlighted line (overview drilldown / ?line=N|A-B
      // target); if it got folded away, the highlight + scroll-to-center would
      // silently no-op because it wouldn't be in the display list.
      visibleLines: filteredLines.filter(
        ({ line, index }) => !collapsedIndices.has(index) || isInHighlightRange(line.lineNumber, highlightLines)
      ),
      collapseGroupsMap: collapseGroups,
    };
  }, [filteredLines, collapseEnabled, highlightLines]);

  // Build display items with gap indicators
  const displayItems = useMemo(() => {
    return buildDisplayItems(visibleLines, displayLogLines, forcedRanges);
  }, [visibleLines, displayLogLines, forcedRanges]);

  // Build the set of raw log-line indices that form the visible template block of
  // a collapsed pattern. These lines get a teal left-border highlight so users can
  // see exactly which lines are the repeating unit.
  const patternTemplateIndices = useMemo(() => {
    const s = new Set<number>();
    for (const info of collapseGroupsMap.values()) {
      if (
        info.type === 'pattern' &&
        info.patternLength !== undefined &&
        info.patternFirstLineIndex !== undefined
      ) {
        for (let m = 0; m < info.patternLength; m++) {
          s.add(info.patternFirstLineIndex + m);
        }
      }
    }
    return s;
  }, [collapseGroupsMap]);

  const displayIndices = useMemo(() => {
    return displayItems.map((item) => item.data.index);
  }, [displayItems]);

  // Snapshot of current view settings passed to the export dialog
  const exportContext = useMemo<ExportContext>(() => ({
    filterQuery,
    contextLines,
    lineRange,
    startTime,
    endTime,
    isAnonymized,
  }), [filterQuery, contextLines, lineRange, startTime, endTime, isAnonymized]);

  /** Non-blocking error message shown when the new-tab handoff fails (e.g. quota exceeded). */
  const [newTabError, setNewTabError] = useState<string | null>(null);
  useEffect(() => {
    if (!newTabError) return;
    const id = window.setTimeout(() => setNewTabError(null), 4000);
    return () => window.clearTimeout(id);
  }, [newTabError]);

  /**
   * Opens a new tab loaded with the contiguous slice of the log spanning the
   * first to the last currently-visible line, sourced from the store's full
   * (time-sorted) `rawLogLines` so that lines hidden by the time filter — but
   * within the visible time span — are also included. The slice is taken by
   * timestamp rather than line number: with merged multi-process logs, line
   * numbers no longer run monotonically with time. The current text filter and
   * time range are carried over via URL params so the new tab starts with the
   * same view settings.
   */
  const handleOpenInNewTab = useCallback(() => {
    if (displayItems.length === 0) return;

    // Bound the crop by the first/last *positive* visible timestamps. Using the
    // raw first/last items would break when an endpoint is a zero-timestamp
    // orphan line: a 0 bound either passes the whole log (firstUs === 0) or
    // excludes every timestamped line (lastUs === 0). Line numbers bound the
    // orphan lines (and the whole crop when nothing visible is timestamped).
    let firstUs = 0;
    let lastUs = 0;
    for (const item of displayItems) {
      const ts = item.data.line.timestampUs;
      if (ts > 0) {
        if (firstUs === 0) firstUs = ts;
        lastUs = ts;
      }
    }
    const hasTimeBounds = firstUs > 0;
    const firstLineNum = displayItems[0].data.line.lineNumber;
    const lastLineNum = displayItems[displayItems.length - 1].data.line.lineNumber;
    const inLineRange = (line: ParsedLogLine) =>
      line.lineNumber >= firstLineNum && line.lineNumber <= lastLineNum;

    const croppedParts: string[] = [];
    for (const line of rawLogLines) {
      const ts = line.timestampUs;
      const inRange = hasTimeBounds && ts > 0
        ? ts >= firstUs && ts <= lastUs
        : inLineRange(line);
      if (inRange) croppedParts.push(line.rawText);
    }
    const croppedText = croppedParts.join('\n');

    const tabLogId = storeTabLog(croppedText, logFileName);
    if (!tabLogId) {
      setNewTabError('The log is too large to open in a new tab.');
      return;
    }

    const params = new URLSearchParams();
    params.set(TAB_LOG_PARAM, tabLogId);
    if (filterQuery.trim()) params.set('filter', filterQuery);
    if (startTime) params.set('start', startTime);
    if (endTime) params.set('end', endTime);

    const url = new URL(window.location.href);
    url.hash = `/logs?${params.toString()}`;

    // Mirror the existing source-link pattern: open a blank window first so
    // popup blockers treat it as user-initiated, then navigate it safely.
    const newWindow = window.open('', '_blank');
    if (!newWindow) {
      removeTabLog(tabLogId);
      setNewTabError('Unable to open a new tab. Please allow popups and try again.');
      return;
    }
    newWindow.opener = null;
    newWindow.location.href = url.toString();
  }, [displayItems, rawLogLines, filterQuery, startTime, endTime, logFileName]);

  // Search determines highlighting within all currently rendered lines (including
  // lines expanded from collapsed groups via forcedRanges).
  const searchMatchingLineIndices = useMemo(() => {
    if (!searchQuery.trim()) return new Set<number>();
    const matchingOriginalIndices = new Set<number>();
    const normalizedQuery = searchQuery.toLowerCase();
    displayItems.forEach(({ data: { line, index } }) => {
      if (line.rawText.toLowerCase().includes(normalizedQuery)) {
        matchingOriginalIndices.add(index);
      }
    });
    return matchingOriginalIndices;
  }, [displayItems, searchQuery]);

  // Convert search matches to sorted array for navigation
  const searchMatchesArray = useMemo(() => {
    return Array.from(searchMatchingLineIndices).sort((a, b) => a - b);
  }, [searchMatchingLineIndices]);

  // Use navigation hook for next/prev match functionality
  const {
    currentIndex: currentSearchMatchIndex,
    goToNext: goToNextMatch,
    goToPrevious: goToPreviousMatch,
  } = useMatchNavigation(searchMatchesArray);

  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: displayItems.length,
    getItemKey: (index) => `line-${displayItems[index]?.data.index ?? index}`,
    getScrollElement: () => parentRef.current,
    estimateSize: () => (lineWrap ? 76 : 24),
    measureElement: (el) => el.getBoundingClientRect().height,
    overscan: 20,
  });

  useEffect(() => {
    // Reset all measurements and force remeasure when wrap state or filters change
    rowVirtualizer.measurementsCache = [];
    rowVirtualizer.measure();
  }, [rowVirtualizer, lineWrap, contextLines, searchQuery, displayItems.length, forcedRanges, filterQuery]);

  // Scroll the highlighted line (overview drilldown target) to center — once
  // per target line, when it first appears in the display list. Guarding on the
  // line value (not just mount) means an unrelated filter/search change later
  // won't keep yanking the scroll position back. For a range, the first line is
  // the target: it is where reading starts.
  const scrolledForLine = useRef<number | undefined>(undefined);
  useEffect(() => {
    const highlightLineNumber = highlightLines?.start;
    if (highlightLineNumber === undefined) return;
    if (scrolledForLine.current === highlightLineNumber) return;
    const pos = displayItems.findIndex((item) => item.data.line.lineNumber === highlightLineNumber);
    if (pos === -1) return; // not in the display list yet; retry when it changes
    // Defer so the virtualizer has a measured scroll element to work with.
    // Mark done only *inside* the callback: if displayItems settles across a
    // couple of renders, the effect's cleanup cancels this frame and re-runs;
    // setting the flag early would skip the reschedule and never scroll.
    const id = requestAnimationFrame(() => {
      rowVirtualizer.scrollToIndex(pos, { align: 'center' });
      scrolledForLine.current = highlightLineNumber;
    });
    return () => cancelAnimationFrame(id);
  }, [rowVirtualizer, displayItems, highlightLines]);

  // Auto-scroll to current search match
  useEffect(() => {
    if (searchMatchesArray.length === 0) return;
    
    const currentMatchLineNumber = searchMatchesArray[currentSearchMatchIndex];
    const displayItemIndex = displayItems.findIndex(item => item.data.index === currentMatchLineNumber);
    
    if (displayItemIndex !== -1) {
      // Find the actual DOM element and scroll it into view
      setTimeout(() => {
        const matchElement = document.querySelector(`.log-line[data-index="${displayItemIndex}"]`);
        if (matchElement) {
          matchElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, 50); // Small delay to ensure element is rendered
    }
  }, [currentSearchMatchIndex, searchMatchesArray, displayItems]);

  const highlightText = (line: ParsedLogLine, originalIndex: number): React.ReactNode => {
    const isMatch = searchMatchingLineIndices.has(originalIndex);
    const displayText = getDisplayText(line);
    const isHovered = hoveredLineIndex === originalIndex;
    const highlightOpts = searchQuery && isMatch
      ? { query: searchQuery, caseSensitive: false, highlightClassName: styles.searchHighlight }
      : null;

    const renderWithSearchHighlights = (text: string, keySuffix: string): React.ReactNode => {
      if (!highlightOpts) {
        return text;
      }
      return highlightTextUtil(text, { ...highlightOpts, keyPrefix: `line-${originalIndex}-${keySuffix}` });
    };

    type LinkSpec = {
      readonly start: number;
      readonly end: number;
      readonly href: string;
      readonly title: string;
      readonly keyPrefix: string;
      readonly onClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void;
      /** When set, the span renders as a click-to-filter button (not an <a>). */
      readonly filterValue?: string;
    };

    const linkSpecs: LinkSpec[] = [];

    // Always render the anchor so the first click lands on the element.
    // The link only receives visible link styling when the row is hovered/focused;
    // otherwise it inherits the surrounding text appearance (sourceLinkInactive).
    if (line.filePath && line.sourceLineNumber) {
      const githubUrl = generateGitHubSourceUrl(line.filePath, line.sourceLineNumber);
      if (githubUrl) {
        const sourceRef = `${line.filePath}:${line.sourceLineNumber}`;
        const sourceRefIndex = displayText.indexOf(sourceRef);
        if (sourceRefIndex >= 0) {
          linkSpecs.push({
            start: sourceRefIndex,
            end: sourceRefIndex + sourceRef.length,
            href: githubUrl,
            title: 'View on GitHub',
            keyPrefix: 'source',
            onClick: (e) => { void handleSourceLinkClick(e, line.filePath, line.sourceLineNumber); },
          });
        }
      }
    }

    const sentryEvent = sentryEventByLineNumber.get(line.lineNumber);
    if (sentryEvent?.sentryId && sentryEvent.sentryUrl) {
      const sentryIdIndex = displayText.indexOf(sentryEvent.sentryId);
      if (sentryIdIndex >= 0) {
        linkSpecs.push({
          start: sentryIdIndex,
          end: sentryIdIndex + sentryEvent.sentryId.length,
          href: sentryEvent.sentryUrl,
          title: 'View in Sentry',
          keyPrefix: 'sentry',
        });
      }
    }

    // Rust SDK span segments in the `| spans: …` tail become click-to-filter
    // chips. Search only within the tail (from the spans marker) and advance a
    // cursor so a span name that also appears earlier in the message isn't
    // matched, and repeated segment texts each land on their own occurrence.
    const spansAt = displayText.lastIndexOf(SPANS_MARKER);
    if (spansAt >= 0) {
      let cursor = spansAt;
      for (const segment of spanSegments(line.rawText)) {
        const idx = displayText.indexOf(segment, cursor);
        if (idx < 0) continue;
        linkSpecs.push({
          start: idx,
          end: idx + segment.length,
          href: '',
          title: `Click to filter the logs to lines under this span: ${segment}`,
          keyPrefix: 'span',
          filterValue: spanFilterValue(segment),
        });
        cursor = idx + segment.length;
      }
    }

    if (linkSpecs.length > 0) {
      linkSpecs.sort((a, b) => a.start - b.start);
      const renderedParts: React.ReactNode[] = [];
      let cursor = 0;

      for (let i = 0; i < linkSpecs.length; i++) {
        const spec = linkSpecs[i];
        if (spec.start < cursor) {
          continue;
        }

        const before = displayText.slice(cursor, spec.start);
        if (before.length > 0) {
          renderedParts.push(renderWithSearchHighlights(before, `${spec.keyPrefix}-before-${i}`));
        }

        const linkedText = displayText.slice(spec.start, spec.end);
        if (spec.filterValue !== undefined) {
          const filterValue = spec.filterValue;
          renderedParts.push(
            <button
              type="button"
              key={`line-${originalIndex}-${spec.keyPrefix}-link-${i}`}
              className={styles.spanFilterLink}
              title={spec.title}
              // Match the log row (tabIndex -1): with up to 7 spans per line
              // across many rows, tabbable chips would flood the tab order.
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                setFilterQueryInput(filterValue);
              }}
            >
              {renderWithSearchHighlights(linkedText, `${spec.keyPrefix}-text-${i}`)}
            </button>
          );
        } else {
          renderedParts.push(renderHoverLink(
            `line-${originalIndex}-${spec.keyPrefix}-link-${i}`,
            spec.href,
            spec.title,
            isHovered,
            renderWithSearchHighlights(linkedText, `${spec.keyPrefix}-text-${i}`),
            spec.onClick,
          ));
        }

        cursor = spec.end;
      }

      const after = displayText.slice(cursor);
      if (after.length > 0) {
        renderedParts.push(renderWithSearchHighlights(after, 'tail'));
      }

      return <>{renderedParts}</>;
    }
    
    if (!searchQuery || !isMatch) {
      return displayText;
    }

    const parts = highlightTextUtil(displayText, {
      query: searchQuery,
      caseSensitive: false,
      keyPrefix: `line-${originalIndex}`,
      highlightClassName: styles.searchHighlight,
    });

    return <>{parts}</>;
  };

  const getLogLevelClass = (level: string) => {
    const levelMap: Record<string, string> = {
      trace: styles.levelTrace,
      debug: styles.levelDebug,
      info: styles.levelInfo,
      warn: styles.levelWarn,
      error: styles.levelError,
    };
    return levelMap[level.toLowerCase()] || styles.levelUnknown;
  };

  // External link (GitHub source, Sentry) that reads as plain text until its row
  // is hovered or focused, so log rows don't turn into a wall of link styling.
  const renderHoverLink = (
    key: string,
    href: string,
    title: string,
    isHovered: boolean,
    content: React.ReactNode,
    onClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void,
  ): React.ReactNode => (
    <a
      key={key}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={isHovered ? styles.sourceLink : styles.sourceLinkInactive}
      title={isHovered ? title : undefined}
      onClick={onClick}
    >
      {content}
    </a>
  );

  // Continuation lines render as plain text, except a pretty-format `at …` line
  // (crypto-wasm, Element Web) carrying the entry's source location: there is no
  // `| … |` reference on the first line to link, so its path is linked here.
  const renderContinuation = (line: ParsedLogLine, originalIndex: number): React.ReactNode => {
    const lines = line.continuationLines ?? [];
    const text = lines.join('\n');
    if (!line.filePath || !line.sourceLineNumber) return text;
    const githubUrl = generateGitHubSourceUrl(line.filePath, line.sourceLineNumber);
    const ref = githubUrl ? locatePrettySourceRef(lines, line.filePath, line.sourceLineNumber) : null;
    if (!githubUrl || !ref) return text;
    const refLine = lines[ref.lineIndex];
    const isHovered = hoveredLineIndex === originalIndex;
    return (
      <>
        {[...lines.slice(0, ref.lineIndex), refLine.slice(0, ref.start)].join('\n')}
        {renderHoverLink(`line-${originalIndex}-source-continuation`, githubUrl, 'View on GitHub', isHovered, refLine.slice(ref.start, ref.end))}
        {[refLine.slice(ref.end), ...lines.slice(ref.lineIndex + 1)].join('\n')}
      </>
    );
  };

  const getDisplayText = (line: ParsedLogLine): string => {
    // Always use line.message (first physical line only) — continuation lines are
    // rendered separately in the logLineContinuation block and must not be included
    // here. line.rawText now spans multiple physical lines for multi-line entries,
    // which is correct for search matching but wrong for single-line display.
    if (!stripPrefix) {
      return line.message;
    }
    // strippedMessage is pre-computed by the parser for each log format
    // (ISO rageshake prefix for rageshake logs, "TAG: message" for logcat logs).
    return line.strippedMessage;
  };

  const handleSourceLinkClick = async (
    e: React.MouseEvent<HTMLAnchorElement>,
    filePath?: string,
    sourceLineNumber?: number
  ) => {
    if (!filePath || !sourceLineNumber) return;
    if (!filePath.endsWith('.swift') || filePath.includes('/')) return;

    e.preventDefault();

    // Open without 'noopener' in the features string so the browser returns a
    // usable window reference; then immediately nullify opener to block
    // reverse-tabnabbing (the opened page cannot access window.opener).
    const pendingWindow = window.open('', '_blank');
    if (!pendingWindow) return;
    pendingWindow.opener = null;

    try {
      const resolvedUrl = await resolveSwiftFilenameToBlobUrl(filePath, sourceLineNumber);
      const fallbackUrl = generateGitHubSourceUrl(filePath, sourceLineNumber);
      const targetUrl = resolvedUrl || fallbackUrl;

      if (!targetUrl) {
        pendingWindow.close();
        return;
      }

      pendingWindow.location.href = targetUrl;
    } catch {
      pendingWindow.close();
    }
  };

  // Expand a gap by including the missing lines
  const expandGap = (gapId: string, count: number | 'all' | 'next-match' | 'prev-match') => {
    const newForcedRanges = calculateGapExpansion(
      gapId,
      count,
      displayIndices,
      displayLogLines.length,
      forcedRanges,
      filterMatchingLineIndices,
      prevRequestLineRange,
      nextRequestLineRange
    );
    setForcedRanges(newForcedRanges);
  };

  // Handle gap expansion with click detection
  const handleGapClick = (gapId: string) => {
    // Single click: load 10 more
    expandGap(gapId, 10);
  };

  // Handle right-click to show context menu
  const handleGapContextMenu = (
    e: React.MouseEvent,
    gapId: string,
    direction: 'up' | 'down',
    isFirst: boolean,
    isLast: boolean
  ) => {
    e.preventDefault();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      gapId,
      direction,
      isFirst,
      isLast,
    });
  };

  // Close context menu when clicking elsewhere
  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    if (contextMenu) {
      document.addEventListener('click', handleClick);
      return () => document.removeEventListener('click', handleClick);
    }
  }, [contextMenu]);

  return (
    <div className={styles.logDisplayView}>
      <div className={styles.logToolbar}>
        <div className={styles.logToolbarLeft}>
          <SearchInput
            ref={searchInputRef}
            value={searchQueryInput}
            onChange={setSearchQueryInput}
            placeholder="Search logs..."
            title="Search and highlight in filtered results (/)"
            expandOnFocus={false}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (e.shiftKey) {
                  goToPreviousMatch();
                } else {
                  goToNextMatch();
                }
              }
            }}
          />
          {searchMatchesArray.length > 0 && (
            <>
              <div className={styles.searchNavigation}>
                <button
                  className={`${styles.btnToolbar} ${styles.btnIcon}`}
                  onClick={goToPreviousMatch}
                  title="Previous match (Shift+Enter)"
                  aria-label="Previous match"
                  disabled={searchMatchesArray.length === 0}
                >
                  ↑
                </button>
                <span
                  className={styles.searchResultsCount}
                  aria-live="polite"
                  aria-atomic="true"
                >
                  {currentSearchMatchIndex + 1} / {searchMatchesArray.length}
                </span>
                <button
                  className={`${styles.btnToolbar} ${styles.btnIcon}`}
                  onClick={goToNextMatch}
                  title="Next match (Enter)"
                  aria-label="Next match"
                  disabled={searchMatchesArray.length === 0}
                >
                  ↓
                </button>
              </div>
            </>
          )}
        </div>
        <div className={styles.logToolbarRight}>
          <label className={styles.logToolbarOption} title="Toggle line wrap (w)">
            <input
              type="checkbox"
              checked={lineWrap}
              onChange={(e) => setLineWrap(e.target.checked)}
            />
            Line wrap
          </label>
          <label className={styles.logToolbarOption} title="Toggle strip prefix (p)">
            <input
              type="checkbox"
              checked={stripPrefix}
              onChange={(e) => setStripPrefix(e.target.checked)}
            />
            Strip prefix
          </label>
          <label className={styles.logToolbarOption} title="Collapse consecutive duplicate/similar log lines">
            <input
              type="checkbox"
              checked={collapseEnabled}
              onChange={(e) => setCollapseEnabled(e.target.checked)}
            />
            Collapse duplicates
          </label>
          <SearchInput
            ref={filterInputRef}
            value={filterQueryInput}
            onChange={setFilterQueryInput}
            placeholder="Filter logs..."
            title="Filter to show only matching lines"
            expandOnFocus={false}
          />
          <div className={styles.logToolbarContextGroup}>
            <button
              className={`${styles.btnToolbar} ${styles.btnContextToggle} ${contextLines > 0 ? 'active' : ''}`}
              onClick={() => {
                if (contextLines > 0) {
                  setContextLines(0);
                } else {
                  setContextLines(5);
                }
              }}
              title="Context lines before/after matches"
              aria-label="Toggle context lines"
              disabled={!filterQuery.trim()}
            >
              ≡
            </button>
            <input
              type="number"
              min="0"
              max="100"
              value={contextLines}
              onChange={(e) => {
                const val = parseInt(e.target.value) || 0;
                setContextLines(val);
              }}
              className={styles.logContextInput}
              title="Context lines (0 = disabled)"
              disabled={!filterQuery.trim()}
            />
          </div>
          <div className={styles.logToolbarActions}>
            {showAnonymizeButton && (
              <button
                className={`${styles.btnToolbar} ${styles.btnIcon}${isAnonymized ? ` ${styles.btnActive}` : ''}`}
                onClick={() => {
                  if (isAnonymized) {
                    if (originalLogLines !== null) {
                      unanonymizeLogs();
                    } else {
                      setShowUnanonymizeDialog(true);
                    }
                  } else {
                    void anonymizeLogs();
                  }
                }}
                aria-label={isAnonymizing ? 'Anonymising…' : isAnonymized ? 'Unanonymise logs' : 'Anonymise logs'}
                aria-pressed={isAnonymized}
                title={isAnonymizing ? 'Anonymising…' : isAnonymized ? 'Unanonymise logs' : 'Anonymise logs'}
                disabled={isAnonymizing}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  {/* Hat crown */}
                  <path d="M5 7V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/>
                  {/* Hat brim */}
                  <path d="M2.5 7.5h11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
                  {/* Left lens */}
                  <circle cx="5" cy="11.5" r="2" stroke="currentColor" strokeWidth="1.4"/>
                  {/* Right lens */}
                  <circle cx="11" cy="11.5" r="2" stroke="currentColor" strokeWidth="1.4"/>
                  {/* Bridge */}
                  <path d="M7 11.5h2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                </svg>
              </button>
            )}
            {isAnonymized && anonymizationDictionary && (
              <button
                className={`${styles.btnToolbar} ${styles.btnIcon}`}
                onClick={() => setShowMapping(true)}
                aria-label="View anonymisation mapping"
                title="View anonymisation mapping"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M2 4h5M2 8h5M2 12h5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                  <path d="M9 4h5M9 8h5M9 12h5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                </svg>
              </button>
            )}
            {!onClose && !onExpand && (
              <>
                {newTabError && (
                  <span role="alert" className={styles.newTabError}>{newTabError}</span>
                )}
                <button
                  className={`${styles.btnToolbar} ${styles.btnIcon}`}
                  onClick={handleOpenInNewTab}
                  aria-label="Open in new tab"
                  title="Open cropped logs in new tab"
                  disabled={displayItems.length === 0}
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M7 3H3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                    <path d="M10 2h4v4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                    <path d="M14 2L8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </button>
              </>
            )}
            <button
              className={`${styles.btnToolbar} ${styles.btnIcon}`}
              onClick={() => setShowExport(true)}
              aria-label="Export logs"
              title={`Export visible logs (${metaKey}+S)`}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M8 2v8M5 7l3 3 3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M2 12h12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
              </svg>
            </button>
            {onExpand && (
              <button
                className={`${styles.btnToolbar} ${styles.btnIcon}`}
                onClick={() => onExpand()}
                aria-label="Open in Logs view"
                title="Open in Logs view"
              >
                ⤢
              </button>
            )}
            {onClose && (
              <button
                className={`${styles.btnToolbar} ${styles.btnIcon} ${styles.closeIcon}`}
                onClick={onClose}
                aria-label="Close log viewer"
                title="Close"
              >
                ×
              </button>
            )}
          </div>
        </div>
      </div>

      {showProcessColors && <ProcessLegend colorMap={processColorMap} />}

      <div ref={parentRef} className={styles.logContentWrapper}>
        <div
          className={styles.logContent}
          style={{
            height: `${rowVirtualizer.getTotalSize()}px`,
            position: 'relative',
          }}
        >
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const item = displayItems[virtualRow.index];
            if (!item) {
              return null;
            }
            const { line, index } = item.data;
            const isMatch = searchMatchingLineIndices.has(index);
            const isCurrentSearchMatch = searchMatchesArray.length > 0 && index === searchMatchesArray[currentSearchMatchIndex];
            const gapAbove = item.gapAbove;
            const gapBelow = item.gapBelow;
            const collapseInfo = gapBelow ? collapseGroupsMap.get(gapBelow.gapId) : undefined;
            const collapsedCount = collapseInfo && gapBelow ? Math.min(collapseInfo.count, gapBelow.remainingGap) : 0;
            const isSentryLine = sentryLineNumbers.has(line.lineNumber);
            const httpErrorStatus = isSentryLine ? null : getHttpErrorStatus(line.rawText);
            // Left box-shadow stripe: app-state shade for the console stream,
            // flat process colour for others. Sits alongside the search-match /
            // pattern border without clobbering it.
            const processColor = stripeColorer(line.sourceFile, line.timestampUs);

            return (
              <div
                key={`${virtualRow.key}-${lineWrap ? 'wrap' : 'nowrap'}`}
                data-index={virtualRow.index}
                ref={(el) => {
                  if (el) rowVirtualizer.measureElement(el);
                }}
                className={`${styles.logLine} ${getLogLevelClass(line.level)} ${isMatch ? styles.matchLine : ''} ${isCurrentSearchMatch ? styles.currentMatch : ''} ${isInHighlightRange(line.lineNumber, highlightLines) ? styles.highlightLine : ''} ${patternTemplateIndices.has(index) ? styles.patternTemplateLine : ''} ${lineWrap ? styles.wrap : styles.nowrap} ${hoveredLineIndex === index ? 'log-row-hovered' : ''}`}
                onMouseEnter={() => setHoveredLineIndex(index)}
                onMouseLeave={() => setHoveredLineIndex(null)}
                onFocus={() => setHoveredLineIndex(index)}
                onBlur={(e: React.FocusEvent<HTMLDivElement>) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                    setHoveredLineIndex(null);
                  }
                }}
                tabIndex={-1}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: lineWrap ? '100%' : 'fit-content',
                  minWidth: '100%',
                  transform: `translateY(${virtualRow.start}px)`,
                  // Elevate the row above subsequent siblings when its menu is open so
                  // DOM-order paint (later rows cover earlier rows) cannot clip the menu.
                  zIndex: menuOpenForIndex === index ? 10 : undefined,
                  boxShadow: processColor ? `inset 3px 0 0 0 ${processColor}` : undefined,
                }}
              >
                <RowTimeAction
                  timestampUs={line.timestampUs}
                  onOpenChange={(open) =>
                    setMenuOpenForIndex((prev) => (open ? index : prev === index ? null : prev))
                  }
                />
                {(gapAbove || (gapBelow && !collapseInfo)) && (
                  <div className={styles.logGapControls}>
                    {gapAbove && (
                      <button
                        className={styles.logGapArrow}
                        onClick={() => handleGapClick(gapAbove.gapId)}
                        onContextMenu={(e) => handleGapContextMenu(e, gapAbove.gapId, 'up', gapAbove.isFirst ?? false, false)}
                        title={`${gapAbove.remainingGap} hidden lines above\nClick: +10 | Right-click: More options`}
                        aria-label={`Load hidden lines above`}
                      >
                        <svg viewBox="0 0 12 12" width="12" height="12">
                          <path d="M6 2 L10 7 L2 7 Z" fill="currentColor" />
                        </svg>
                      </button>
                    )}
                    {gapBelow && !collapseInfo && (
                      <button
                        className={styles.logGapArrow}
                        onClick={() => handleGapClick(gapBelow.gapId)}
                        onContextMenu={(e) => handleGapContextMenu(e, gapBelow.gapId, 'down', false, gapBelow.isLast ?? false)}
                        title={`${gapBelow.remainingGap} hidden lines below\nClick: +10 | Right-click: More options`}
                        aria-label={`Load hidden lines below`}
                      >
                        <svg viewBox="0 0 12 12" width="12" height="12">
                          <path d="M6 10 L10 5 L2 5 Z" fill="currentColor" />
                        </svg>
                      </button>
                    )}
                  </div>
                )}
                {gapBelow && !gapBelow.isLast && !collapseInfo && <div className={`${styles.logGapDivider} ${styles.logGapDividerBelow}`} />}
                <span className={styles.logLineNumber}>{line.lineNumber}</span>
                <span className={styles.logLineTimestamp}>{line.displayTime}</span>
                <span className={styles.logLineLevel}>{line.level}</span>
                <span
                  className={styles.logLineText}
                  style={isSentryLine ? { color: 'var(--color-sentry)' } : httpErrorStatus === 'client-error' ? { color: 'var(--http-client-error)' } : httpErrorStatus ? { color: getHttpStatusColor(httpErrorStatus) } : undefined}
                >
                  {highlightText(line, index)}
                </span>
                {(line.continuationLines?.length ?? 0) > 0 && (
                  <div className={styles.logLineContinuation}>
                    {renderContinuation(line, index)}
                  </div>
                )}
                {collapseInfo && gapBelow && (
                  <div className={styles.collapseSummaryBar} data-testid="collapse-bar">
                    <span className={styles.logLineNumber} aria-hidden="true" />
                    <span className={styles.logLineTimestamp} aria-hidden="true" />
                    <span className={styles.logLineLevel}>
                      {collapseInfo.type === 'exact' ? '=' : collapseInfo.type === 'similar' ? '≈' : '↻'}
                    </span>
                    <span className={styles.collapseSummaryText}>
                      {collapseInfo.type === 'pattern' && collapseInfo.patternLength
                        ? collapsedCount % collapseInfo.patternLength === 0
                          ? `${(collapsedCount / collapseInfo.patternLength).toLocaleString()} repetitions of the highlighted ${collapseInfo.patternLength}-line pattern collapsed`
                          : `${collapsedCount.toLocaleString()} lines of the highlighted ${collapseInfo.patternLength}-line pattern collapsed`
                        : `${collapsedCount.toLocaleString()} ${collapseInfo.type === 'exact' ? 'identical' : 'similar'} ${collapsedCount === 1 ? 'line' : 'lines'} collapsed`}
                      <span className={styles.collapseSummaryActions}>
                        {collapsedCount > 10 && (
                          <>
                            {' - '}
                            <button
                              className={styles.collapseSummaryBtn}
                              onClick={() => expandGap(gapBelow.gapId, 10)}
                              aria-label="Load 10 collapsed lines"
                            >
                              +10
                            </button>
                          </>
                        )}
                        {' - '}
                        <button
                          className={styles.collapseSummaryBtn}
                          onClick={() => expandGap(gapBelow.gapId, 'all')}
                          aria-label={`Expand all ${collapsedCount} collapsed lines`}
                        >
                          show all
                        </button>
                      </span>
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {displayItems.length === 0 && visibleLines.length > 0 && (
        <div className={styles.logEmptyState}>
          No matching lines found for "{searchQuery}"
        </div>
      )}

      {filteredLines.length === 0 && filterQuery && (
        <div className={styles.logEmptyState}>
          No lines match filter "{filterQuery}"
        </div>
      )}

      {displayLogLines.length === 0 && (
        <div className={styles.logEmptyState}>
          No log data available. Please upload a log file.
        </div>
      )}

      {showExport && (
        <LogExportDialog
          displayItems={displayItems}
          context={exportContext}
          onClose={() => setShowExport(false)}
        />
      )}

      {showUnanonymizeDialog && (
        <UnanonymizeDialog
          onClose={() => setShowUnanonymizeDialog(false)}
        />
      )}

      {showMapping && anonymizationDictionary && (
        <AnonMappingDialog
          dict={anonymizationDictionary}
          onClose={() => setShowMapping(false)}
        />
      )}

      {contextMenu && (
        <div
          className={styles.logGapContextMenu}
          style={{
            position: 'fixed',
            left: `${contextMenu.x}px`,
            top: `${contextMenu.y}px`,
            zIndex: 1000,
          }}
        >
          <button
            className={styles.contextMenuItem}
            onClick={() => {
              expandGap(contextMenu.gapId, 10);
              setContextMenu(null);
            }}
          >
            Load 10 more lines
          </button>
          {contextMenu.direction === 'down' && nextRequestLineRange && (
            <button
              className={styles.contextMenuItem}
              onClick={() => {
                expandGap(contextMenu.gapId, 'next-match');
                setContextMenu(null);
              }}
            >
              Load to next log
            </button>
          )}
          {contextMenu.direction === 'up' && prevRequestLineRange && (
            <button
              className={styles.contextMenuItem}
              onClick={() => {
                expandGap(contextMenu.gapId, 'prev-match');
                setContextMenu(null);
              }}
            >
              Load to previous log
            </button>
          )}
          {((contextMenu.direction === 'up' && contextMenu.isFirst) ||
            (contextMenu.direction === 'down' && contextMenu.isLast)) && (
            <button
              className={styles.contextMenuItem}
              onClick={() => {
                expandGap(contextMenu.gapId, 'all');
                setContextMenu(null);
              }}
            >
              Load all to {contextMenu.direction === 'up' ? 'top' : 'bottom'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}


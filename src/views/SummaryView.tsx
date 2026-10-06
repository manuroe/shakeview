import { useMemo, useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLogStore } from '../stores/logStore';
import { useURLParams } from '../hooks/useURLParams';
import { BurgerMenu } from '../components/BurgerMenu';
import { TimeRangeSelector } from '../components/TimeRangeSelector';
import { LogActivityChart } from '../components/LogActivityChart';
import { HttpActivityChart } from '../components/HttpActivityChart';
import { BandwidthChart } from '../components/BandwidthChart';
import { calculateTimeRangeMicros, formatTimestamp, formatDuration, getMinMaxTimestamps, snapSelectionToLogLine, SNAP_TOLERANCE_US } from '../utils/timeUtils';
import { formatBytes } from '../utils/sizeUtils';
import { getHttpStatusBadgeClass } from '../utils/httpStatusColors';
import { stripMatrixClientPath } from '../utils/uriUtils';
import { computeSummaryStats, messageGroupFilter } from '../utils/summaryStats';
import type { TimestampMicros } from '../types/time.types';
import type { SelectionRange } from '../hooks/useChartInteraction';
import styles from './SummaryView.module.css';
import tableStyles from '../components/Table.module.css';

/** Pattern matching media upload/download paths. */
const MEDIA_PATH_RE = /\/media\//i;

/** Returns true when the request has no `timeout` field, i.e. it is not a
 * /sync long-poll. Sync requests carry a `timeout` value; all other request
 * types leave the field undefined. */
const isNotSync = (r: { timeout?: number }): boolean => r.timeout === undefined;

export function SummaryView() {
  const navigate = useNavigate();
  const {
    rawLogLines,
    allHttpRequests,
    allRequests,
    connectionIds,
    sentryEvents,
    lifecycleEvents,
    startTime,
    endTime,
    detectedPlatform,
    lineNumberIndex,
    logFileName,
  } = useLogStore();
  const { setTimeFilter } = useURLParams();

  const summaryTitle = `Summary${detectedPlatform ? ` - ${detectedPlatform === 'ios' ? 'iOS' : 'Android'}` : ''}`;

  // Local zoom state (in microseconds)
  const [localStartTime, setLocalStartTime] = useState<TimestampMicros | null>(null);
  const [localEndTime, setLocalEndTime] = useState<TimestampMicros | null>(null);

  // Shared cursor/selection state — lifted here so all three activity charts
  // can mirror each other's crosshair and drag-selection in real time.
  const [sharedCursorTime, setSharedCursorTime] = useState<number | null>(null);
  const [sharedSelection, setSharedSelection] = useState<SelectionRange | null>(null);

  // Toggle for chart sync overlay feature (disabled by default)
  const [enableChartSync, setEnableChartSync] = useState(false);

  // Chart display mode: 'histogram' = stacked bar chart of data points, 'stepArea' = stacked step-function area chart
  const [displayMode, setDisplayMode] = useState<'histogram' | 'stepArea'>('stepArea');
  // Toggle to show/hide incomplete (in-flight, no response yet) requests in the HTTP chart
  const [showIncomplete, setShowIncomplete] = useState(true);
  // Toggle to show/hide /sync requests (identified by a defined timeout field) in the HTTP chart
  const [showSync, setShowSync] = useState(true);
  // Toggle to show/hide media requests (paths containing /media/) in both charts.
  const [showMedia, setShowMedia] = useState(true);

  // Precompute min/max across ALL raw log lines (keyword anchor)
  const fullDataRange = useMemo(() => {
    if (rawLogLines.length === 0) return { minTime: 0 as TimestampMicros, maxTime: 0 as TimestampMicros };
    const { min, max } = getMinMaxTimestamps(rawLogLines);
    return { minTime: min, maxTime: max };
  }, [rawLogLines]);

  /**
   * Format a selection boundary for display.
   * Returns 'start' / 'end' when the value aligns with the full data edge,
   * otherwise returns a HH:MM:SS UTC string.
   */
  const formatSelectionBoundary = useCallback(
    (us: TimestampMicros): string => {
      if (Math.abs(us - fullDataRange.minTime) <= SNAP_TOLERANCE_US) return 'start';
      if (Math.abs(us - fullDataRange.maxTime) <= SNAP_TOLERANCE_US) return 'end';
      return formatTimestamp(us, 'HH:MM:SS');
    },
    [fullDataRange]
  );

  // Clear local zoom when global filters change
  useEffect(() => {
    setLocalStartTime(null);
    setLocalEndTime(null);
  }, [startTime, endTime]);

  const handleTimeRangeSelected = useCallback((startUs: TimestampMicros, endUs: TimestampMicros) => {
    setLocalStartTime(startUs);
    setLocalEndTime(endUs);
  }, []);

  const handleResetZoom = useCallback(() => {
    // If there's a local selection, clear it
    if (localStartTime !== null || localEndTime !== null) {
      setLocalStartTime(null);
      setLocalEndTime(null);
    } else if (rawLogLines.length > 0 && startTime && endTime) {
      // No local selection - check if we can zoom out to full range
      const { startUs: currentStartUs, endUs: currentEndUs } = calculateTimeRangeMicros(startTime, endTime, fullDataRange.minTime, fullDataRange.maxTime);
      
      // Only zoom out if current range is narrower than full range (with 1ms tolerance)
      if (currentStartUs > fullDataRange.minTime + SNAP_TOLERANCE_US || currentEndUs < fullDataRange.maxTime - SNAP_TOLERANCE_US) {
        // Set as local selection so Apply button appears
        setLocalStartTime(fullDataRange.minTime as TimestampMicros);
        setLocalEndTime(fullDataRange.maxTime as TimestampMicros);
      }
    }
  }, [localStartTime, localEndTime, rawLogLines, startTime, endTime, fullDataRange]);

  const handleApplyGlobally = useCallback(() => {
    if (localStartTime !== null && localEndTime !== null && rawLogLines.length > 0) {
      const startMatchesFull = Math.abs(localStartTime - fullDataRange.minTime) <= SNAP_TOLERANCE_US;
      const endMatchesFull = Math.abs(localEndTime - fullDataRange.maxTime) <= SNAP_TOLERANCE_US;

      // If selection matches full range (within 1ms tolerance), clear the filter instead
      if (startMatchesFull && endMatchesFull) {
        setTimeFilter(null, null);
      } else {
        // Use keywords when the selection boundary aligns with the data edge,
        // otherwise snap to the nearest log line and use its ISO timestamp string.
        const startParam = snapSelectionToLogLine(localStartTime, rawLogLines, fullDataRange, 'start');
        const endParam = snapSelectionToLogLine(localEndTime, rawLogLines, fullDataRange, 'end');
        setTimeFilter(startParam, endParam);
      }

      // Clear local selection state immediately
      setLocalStartTime(null);
      setLocalEndTime(null);
    }
  }, [localStartTime, localEndTime, rawLogLines, fullDataRange, setTimeFilter]);

  // Check if local selection differs from current global filter
  const shouldShowApplyButton = useMemo(() => {
    if (localStartTime === null || localEndTime === null) return false;
    
    // If no global filter, always show apply button
    if (!startTime || !endTime) return true;
    
    const { startUs: globalStartUs, endUs: globalEndUs } = calculateTimeRangeMicros(startTime, endTime, fullDataRange.minTime, fullDataRange.maxTime);
    
    // Show if selection differs from global filter (with 1ms tolerance)
    return Math.abs(localStartTime - globalStartUs) > SNAP_TOLERANCE_US || Math.abs(localEndTime - globalEndUs) > SNAP_TOLERANCE_US;
  }, [localStartTime, localEndTime, startTime, endTime, fullDataRange]);

  // Calculate log statistics via the pure domain function.
  // SummaryView is a thin rendering shell; all the computation lives in summaryStats.ts.
  const stats = useMemo(() => {
    const localTimeRangeUs =
      localStartTime !== null && localEndTime !== null
        ? { startUs: localStartTime, endUs: localEndTime }
        : null;
    return computeSummaryStats(
      rawLogLines,
      allHttpRequests,
      allRequests,
      connectionIds,
      sentryEvents,
      startTime,
      endTime,
      localTimeRangeUs,
      lineNumberIndex,
      lifecycleEvents
    );
  }, [rawLogLines, allHttpRequests, allRequests, connectionIds, sentryEvents, startTime, endTime, localStartTime, localEndTime, lineNumberIndex, lifecycleEvents]);

  /**
   * Derived chart data with incomplete requests optionally excluded.
   * Incomplete entries have `status: ''` in the timestamps array and `endUs: null` in spans.
   */
  const httpRequestsForChart = useMemo(() => {
    let reqs = stats.httpRequestsWithTimestamps;
    if (!showIncomplete) reqs = reqs.filter((r) => r.status !== '');
    if (!showSync) reqs = reqs.filter(isNotSync);
    if (!showMedia) reqs = reqs.filter((r) => !MEDIA_PATH_RE.test(r.uri));
    return reqs;
  }, [stats.httpRequestsWithTimestamps, showIncomplete, showSync, showMedia]);

  const httpRequestSpansForChart = useMemo(() => {
    let spans = stats.httpRequestSpans;
    if (!showIncomplete) spans = spans.filter((s) => s.endUs !== null);
    if (!showSync) spans = spans.filter(isNotSync);
    if (!showMedia) spans = spans.filter((s) => !MEDIA_PATH_RE.test(s.uri));
    return spans;
  }, [stats.httpRequestSpans, showIncomplete, showSync, showMedia]);

  /** Bandwidth chart requests, filtered by media, sync, and incomplete toggles. */
  const bandwidthRequestsForChart = useMemo(() => {
    let reqs = stats.httpRequestsWithBandwidth;
    if (!showMedia) reqs = reqs.filter((r) => !MEDIA_PATH_RE.test(r.uri));
    if (!showSync) reqs = reqs.filter(isNotSync);
    if (!showIncomplete) reqs = reqs.filter((r) => !r.isIncomplete);
    return reqs;
  }, [stats.httpRequestsWithBandwidth, showMedia, showSync, showIncomplete]);

  /** Bandwidth chart request spans, filtered by media, sync, and incomplete toggles. */
  const bandwidthSpansForChart = useMemo(() => {

    let spans = stats.bandwidthRequestSpans;
    if (!showMedia) spans = spans.filter((r) => !MEDIA_PATH_RE.test(r.uri));
    if (!showSync) spans = spans.filter(isNotSync);
    if (!showIncomplete) spans = spans.filter((s) => s.endUs !== null);
    return spans;
  }, [stats.bandwidthRequestSpans, showMedia, showSync, showIncomplete]);

  /**
   * True when at least one chart-worthy HTTP request exists.
   * Includes span arrays so the HTTP Activity section remains visible in
   * stepArea mode even when no requests start inside the
   * current zoom window but some overlap it.
   */
  const hasHttpActivityData =
    stats.httpRequestsWithTimestamps.length > 0 ||
    stats.httpRequestsWithBandwidth.length > 0 ||
    stats.httpRequestSpans.length > 0 ||
    stats.bandwidthRequestSpans.length > 0;

  if (rawLogLines.length === 0) {
    return (
      <div className="app">
        <div className="header-compact">
          <div className={`header-left ${styles.headerLeft}`}>
            <BurgerMenu />
            <h1 className="header-title">{summaryTitle}</h1>
            {logFileName && <p className={styles.fileName}>{logFileName}</p>}
          </div>
        </div>
        <div className="content">
          <p>No logs loaded. Please upload a log file to see the summary.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <div className="header-compact">
        <div className={`header-left ${styles.headerLeft}`}>
          <BurgerMenu />
          <h1 className="header-title">{summaryTitle}</h1>
          {logFileName && <p className={styles.fileName}>{logFileName}</p>}
        </div>
        
        <div className="header-right">
          {shouldShowApplyButton && localStartTime !== null && localEndTime !== null && (
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <span style={{ fontSize: '12px', color: 'var(--color-primary)', fontWeight: 'bold', whiteSpace: 'nowrap' }}>
                Selected: {formatSelectionBoundary(localStartTime)} – {formatSelectionBoundary(localEndTime)} UTC
              </span>
              <button
                onClick={handleResetZoom}
                className="btn-secondary"
                style={{ padding: '4px 12px', fontSize: '12px' }}
              >
                Cancel
              </button>
              <button
                onClick={handleApplyGlobally}
                className="btn-primary"
                style={{ padding: '4px 12px', fontSize: '12px' }}
              >
                Apply
              </button>
            </div>
          )}
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              fontSize: 'var(--font-size-xs)',
              fontWeight: 'normal',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              userSelect: 'none',
            }}
            title="When enabled, hovering on one chart shows aligned cursor and tooltip info on all other charts"
          >
            <input
              type="checkbox"
              checked={enableChartSync}
              onChange={(e) => setEnableChartSync(e.target.checked)}
              style={{ cursor: 'pointer' }}
            />
            <span>Sync charts</span>
          </label>
          <TimeRangeSelector />
        </div>
      </div>

      <div className="content">
        {/* Log Overview */}
        <section className={styles.summarySection}>
          <h2>Logs: {stats.totalLogLines} lines</h2>
          
          {/* Activity Chart */}
          <div className={styles.activityChartContainer}>
            <LogActivityChart
              logLines={stats.filteredLogLines}
              sentryEvents={stats.sentryEvents}
              markers={stats.lifecycleEvents}
              onTimeRangeSelected={handleTimeRangeSelected}
              onResetZoom={handleResetZoom}
              externalCursorTime={enableChartSync ? sharedCursorTime : undefined}
              externalSelection={enableChartSync ? sharedSelection : undefined}
              onCursorMove={enableChartSync ? setSharedCursorTime : undefined}
              onSelectionChange={enableChartSync ? setSharedSelection : undefined}
            />
          </div>
        </section>

        {/* Sentry Reports Section */}
        {stats.sentryEvents.length > 0 && (
          <section className={styles.sentrySectionAlert}>
            <div className={styles.summaryTableContainer}>
              <table className={styles.summaryTable}>
                <thead>
                  <tr>
                    <th>
                      Sentry Reports (
                      <button
                        type="button"
                        className={styles.clickableHeading}
                        onClick={() => navigate('/logs?filter=sentry')}
                        aria-label="View Sentry reports in logs"
                      >
                        {stats.sentryEvents.length}
                      </button>
                      )
                    </th>
                    <th>Sentry ID</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.sentryEvents.map((event) => (
                    <tr key={event.sentryId ?? `line-${event.lineNumber}`}>
                      <td style={{ fontFamily: 'monospace', fontSize: '12px' }}>
                        <button
                          type="button"
                          onClick={() => navigate(`/logs?filter=${encodeURIComponent(event.sentryId ?? 'Sending error to Sentry')}`)}
                          className={styles.actionLink}
                          style={{ textAlign: 'left', whiteSpace: 'normal' }}
                        >
                          {event.message.substring(0, 150)}
                        </button>
                      </td>
                      <td style={{ fontFamily: 'monospace', fontSize: '12px', whiteSpace: 'nowrap' }}>
                        {event.sentryUrl && event.sentryId ? (
                          <a
                            href={event.sentryUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={styles.actionLink}
                          >
                            {event.sentryId}
                          </a>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Errors & Warnings Section */}
        <div className={styles.errorsWarningsGrid}>
          {/* Errors Section */}
          {stats.errors > 0 && (
            <section className={styles.summarySection}>
              {stats.errorsByType.length > 0 && (
                <div className={styles.summaryTableContainer}>
                  <table className={styles.summaryTable}>
                    <thead>
                      <tr>
                        <th>
                          Top Errors (
                          <span
                            className={styles.clickableHeading}
                            onClick={() => navigate('/logs?filter=ERROR')}
                          >
                            {stats.errors}
                          </span>
                          )
                        </th>
                        <th style={{ textAlign: 'right' }}>Count</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.errorsByType.map((error, idx) => (
                        <tr key={idx}>
                          <td>
                            <button
                              className={styles.actionLink}
                              title={error.type}
                              onClick={() =>
                                navigate(
                                  `/logs?filter=${encodeURIComponent(
                                    messageGroupFilter(error.type)
                                  )}`
                                )
                              }
                              style={{ textAlign: 'left', whiteSpace: 'normal' }}
                            >
                              {error.type.substring(0, 100)}
                            </button>
                          </td>
                          <td className={styles.alignRight}>{error.count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          {/* Warnings Section */}
          {stats.warnings > 0 && (
            <section className={styles.summarySection}>
              {stats.warningsByType.length > 0 && (
                <div className={styles.summaryTableContainer}>
                  <table className={styles.summaryTable}>
                    <thead>
                      <tr>
                        <th>
                          Top Warnings (
                          <span
                            className={styles.clickableHeading}
                            onClick={() => navigate('/logs?filter=WARN')}
                          >
                            {stats.warnings}
                          </span>
                          )
                        </th>
                        <th style={{ textAlign: 'right' }}>Count</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.warningsByType.map((warning, idx) => (
                        <tr key={idx}>
                          <td>
                            <button
                              className={styles.actionLink}
                              title={warning.type}
                              onClick={() =>
                                navigate(
                                  `/logs?filter=${encodeURIComponent(
                                    messageGroupFilter(warning.type)
                                  )}`
                                )
                              }
                              style={{ textAlign: 'left', whiteSpace: 'normal' }}
                            >
                              {warning.type.substring(0, 100)}
                            </button>
                          </td>
                          <td className={styles.alignRight}>{warning.count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
        </div>

        {/* HTTP Activity — unified section for requests + bandwidth charts */}
        {hasHttpActivityData && (
          <section className={styles.summarySection}>
            <div className={styles.httpActivityHeader}>
              <h2>HTTP Activity</h2>
              <select
                className={styles.chartModeSelect}
                aria-label="Chart display mode"
                value={displayMode}
                onChange={(e) => setDisplayMode(e.target.value as 'histogram' | 'stepArea')}
                title="Starts: histogram of request initiations per time bucket. In-flight: step-function showing how many requests are simultaneously active at each moment."
              >
                <option value="histogram">Starts</option>
                <option value="stepArea">In-flight</option>
              </select>
              <label className={styles.chartOption}>
                <input
                  type="checkbox"
                  checked={showIncomplete}
                  onChange={(e) => setShowIncomplete(e.target.checked)}
                />
                <span title="Show or hide requests that have not yet received a response (no status code).">
                  Incomplete
                </span>
              </label>
              <label className={styles.chartOption}>
                <input
                  type="checkbox"
                  checked={showSync}
                  onChange={(e) => setShowSync(e.target.checked)}
                />
                <span title="Show or hide Matrix /sync requests (catch-up and long-poll).">
                  Sync
                </span>
              </label>
              <label className={styles.chartOption}>
                <input
                  type="checkbox"
                  checked={showMedia}
                  onChange={(e) => setShowMedia(e.target.checked)}
                />
                <span title="Show or hide media upload/download requests (paths containing /media/). These are typically large and can compress the bandwidth scale.">
                  Media
                </span>
              </label>
            </div>
            {stats.httpRequestsWithTimestamps.length > 0 && (
              <>
                <h3>
                  Requests: {stats.httpRequestCount}
                  {stats.incompleteRequestCount > 0 ? ` (Incomplete: ${stats.incompleteRequestCount})` : ''}
                </h3>
                <div className={styles.activityChartContainer}>
                  <HttpActivityChart
                    httpRequests={httpRequestsForChart}
                    httpRequestSpans={httpRequestSpansForChart}
                    displayMode={displayMode}
                    timeRange={stats.chartTimeRange}
                    markers={stats.lifecycleEvents}
                    onTimeRangeSelected={handleTimeRangeSelected}
                    onResetZoom={handleResetZoom}
                    externalCursorTime={enableChartSync ? sharedCursorTime : undefined}
                    externalSelection={enableChartSync ? sharedSelection : undefined}
                    onCursorMove={enableChartSync ? setSharedCursorTime : undefined}
                    onSelectionChange={enableChartSync ? setSharedSelection : undefined}
                  />
                </div>
              </>
            )}
            {(stats.httpRequestsWithBandwidth.length > 0 || stats.bandwidthRequestSpans.length > 0) && (
              <>
                <h3>
                  Overall bandwidth: ↑ {formatBytes(stats.totalUploadBytes)} / ↓ {formatBytes(stats.totalDownloadBytes)}
                </h3>
                <div className={styles.activityChartContainer}>
                  <BandwidthChart
                    requests={bandwidthRequestsForChart}
                    bandwidthRequestSpans={bandwidthSpansForChart}
                    displayMode={displayMode}
                    timeRange={stats.chartTimeRange}
                    markers={stats.lifecycleEvents}
                    onTimeRangeSelected={handleTimeRangeSelected}
                    onResetZoom={handleResetZoom}
                    externalCursorTime={enableChartSync ? sharedCursorTime : undefined}
                    externalSelection={enableChartSync ? sharedSelection : undefined}
                    onCursorMove={enableChartSync ? setSharedCursorTime : undefined}
                    onSelectionChange={enableChartSync ? setSharedSelection : undefined}
                  />
                </div>
              </>
            )}
          </section>
        )}

        {/* HTTP Errors Grid */}
        <div className={styles.errorsWarningsGrid}>
          {/* TOP HTTP Errors Section */}
          {stats.topFailedUrls.length > 0 && (
            <section className={styles.summarySection}>
              <div className={styles.summaryTableContainer}>
                  <table className={styles.summaryTable}>
                    <thead>
                      <tr>
                        <th>
                          Top Failed URLs (
                          <span
                            className={styles.clickableHeading}
                            onClick={() => {
                              const statuses = stats.httpErrorsByStatus.map(e => e.status);
                              const hasClientErrors = stats.topFailedUrls.some(u => u.statuses.includes('Client Error'));
                              if (hasClientErrors) statuses.push('Client Error');
                              void navigate(`/http_requests?status=${encodeURIComponent(statuses.join(','))}`);
                            }}
                          >
                            {stats.topFailedUrls.reduce((sum, e) => sum + e.count, 0)}
                          </span>
                          )
                        </th>
                        <th>Status</th>
                        <th className={styles.alignRight}>Count</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(() => {
                        return stats.topFailedUrls.map((item, idx) => (
                          <tr key={idx}>
                            <td>
                              <button
                                className={styles.actionLink}
                                title={item.uri}
                                onClick={() => {
                                  // Find all requests matching this URI with error status or client error
                                  const matchingRequests = allHttpRequests.filter(req => {
                                    if (req.uri !== item.uri) return false;
                                    if (req.clientError) return true;
                                    if (!req.status) return false;
                                    const statusCode = parseInt(req.status, 10);
                                    return statusCode >= 400;
                                  });
                                  
                                  // If single occurrence, open with request_id param; else use filter param
                                  if (matchingRequests.length === 1) {
                                    void navigate(`/http_requests?request_id=${encodeURIComponent(matchingRequests[0].requestId)}`);
                                  } else {
                                    void navigate(`/http_requests?filter=${encodeURIComponent(item.uri)}`);
                                  }
                                }}
                                style={{ textAlign: 'left', whiteSpace: 'normal' }}
                              >
                                {stripMatrixClientPath(item.uri)}
                              </button>
                            </td>
                            <td>
                              {item.statuses.map((status, i) => (
                                <span key={status} className={`${tableStyles.badge} ${tableStyles[`badge${getHttpStatusBadgeClass(status)}`]}`}>
                                  {status}{i < item.statuses.length - 1 ? ' ' : ''}
                                </span>
                              ))}
                            </td>
                            <td className={styles.alignRight}>{item.count}</td>
                          </tr>
                        ));
                      })()}
                    </tbody>
                  </table>
                </div>
            </section>
          )}

          {/* HTTP Errors Section */}
          {stats.httpErrorsByStatus.length > 0 && (
            <section className={styles.summarySection}>
              <div className={styles.summaryTableContainer}>
                <table className={styles.summaryTable}>
                  <thead>
                    <tr>
                      <th>HTTP Error Codes</th>
                      <th style={{ textAlign: 'right' }}>Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.httpErrorsByStatus.map((error, idx) => (
                      <tr key={idx}>
                        <td>
                          <button
                            className={`${styles.actionLink} ${tableStyles.badge} ${tableStyles[`badge${getHttpStatusBadgeClass(error.status)}`]}`}
                            onClick={() =>
                              void navigate(`/http_requests?status=${error.status}`)
                            }
                          >
                            {error.status}
                          </button>
                        </td>
                        <td className={styles.alignRight}>{error.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>

        {/* Slowest URLs Section */}
        {stats.slowestHttpRequests.length > 0 && (
          <section className={styles.summarySection}>
            <h2>Slowest URLs</h2>
            <div className={styles.summaryTableContainer}>
              <table className={styles.summaryTable}>
                <thead>
                  <tr>
                    <th>Duration</th>
                    <th>Request</th>
                    <th>URI</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const filtered = stats.slowestHttpRequests;
                    return filtered.map((req) => {
                      const badgeClass = req.status ? `badge${getHttpStatusBadgeClass(req.status)}` : 'badgeIncomplete';
                      return (
                      <tr key={req.id}>
                        <td>
                          <span className={styles.durationBadge}>
                            {formatDuration(req.duration)}
                          </span>
                        </td>
                        <td style={{ fontFamily: 'monospace', fontSize: '13px', color: '#007acc' }}>
                          <a
                            href={`#/http_requests?request_id=${req.id}`}
                            className={styles.actionLink}
                            title={req.id}
                            style={{ textDecoration: 'underline', color: '#007acc' }}
                          >
                            {req.id}
                          </a>
                        </td>
                        <td className={styles.uriCell}>
                          {stripMatrixClientPath(req.uri)}
                        </td>
                        <td>
                          <span className={`${tableStyles.badge} ${tableStyles[badgeClass]}`}>
                            {req.status || 'incomplete'}
                          </span>
                        </td>
                      </tr>
                    );
                    });
                  })()}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Sync Requests by Connection Section */}
        {stats.syncRequestsByConnection.length > 0 && (
          <section className={styles.summarySection}>
            <h2>Sync Requests by Connection</h2>
            <div className={styles.summaryTableContainer}>
              <table className={styles.summaryTable}>
                <thead>
                  <tr>
                    <th>Connection ID</th>
                    <th className={styles.alignRight}>Request Count</th>
                    <th className={styles.alignRight}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.syncRequestsByConnection.map((item) => (
                    <tr key={item.connId}>
                      <td>{item.connId}</td>
                      <td className={styles.alignRight}>{item.count}</td>
                      <td className={styles.alignRight}>
                        <button
                          className={styles.actionLink}
                          onClick={() =>
                            void navigate(`/http_requests/sync?conn=${item.connId}`)
                          }
                        >
                          View
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

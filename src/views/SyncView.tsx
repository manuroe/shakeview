import { useMemo, useCallback } from 'react';
import { useLogStore } from '../stores/logStore';
import { countRequestsForTimeRange } from '../utils/timeUtils';
import { RequestTable } from '../components/RequestTable';
import type { ColumnDef } from '../components/RequestTable';
import { extractAvailableStatusCodes } from '../utils/statusCodeUtils';
import type { SyncRequest, HttpRequest } from '../types/log.types';
import { useURLParams } from '../hooks/useURLParams';
import { renderTimeoutExceededOverlay } from '../utils/waterfallTimeoutOverlay';
import { getSyncRequestBarColor } from '../utils/syncRequestColors';

/**
 * Column IDs shown when waterfall-focus mode is active for sync requests.
 * Only the request ID column remains visible in this mode; hidden column values
 * are surfaced in the request ID cell tooltip.
 */
const SYNC_WATERFALL_FOCUS_COLUMNS: readonly string[] = ['requestId'];

/**
 * Sync Requests view - displays /sync requests in a timeline with waterfall visualization.
 * This is a thin wrapper around RequestTable with sync-specific columns and connection filtering.
 */
export function SyncView() {
  const {
    allRequests,
    filteredRequests,
    connectionIds,
    selectedConnId,
    selectedTimeout,
    showIncomplete,
    startTime,
    endTime,
    timelineScale,
    rawLogLines,
    getDisplayTime,
    setSelectedConnId,
    setShowIncomplete,
    setSelectedTimeout,
  } = useLogStore();

  const { setTimeoutFilter } = useURLParams();

  const totalCount = useMemo(() => {
    const connFilteredRequests = allRequests.filter(
      (r) => !selectedConnId || r.connId === selectedConnId
    );
    return countRequestsForTimeRange(connFilteredRequests, rawLogLines, startTime, endTime);
  }, [allRequests, selectedConnId, rawLogLines, startTime, endTime]);

  // Compute available status codes from all requests (including Incomplete)
  const availableStatusCodes = useMemo(
    () => extractAvailableStatusCodes(allRequests),
    [allRequests]
  );

  // Define columns for sync requests view (fewer columns than HTTP)
  const columns: ColumnDef[] = useMemo(() => [
    {
      id: 'requestId',
      label: 'Request',
      getValue: (req) => req.requestId,
    },
    {
      id: 'time',
      label: 'Time',
      className: 'time',
      getValue: (req) => getDisplayTime(req.sendLineNumber),
    },
    {
      id: 'requestSize',
      label: '↑ Size',
      className: 'size',
      getValue: (req) => req.requestSizeString || '-',
    },
    {
      id: 'responseSize',
      label: '↓ Size',
      className: 'size',
      getValue: (req) => req.responseSizeString || '-',
    },
  ], [getDisplayTime]);

  /**
   * Override waterfall bar color based on sync request type:
   * - Catchup (timeout=0) + 2xx → yellow-green highlight
   * - Long-poll (timeout≥30s) + 2xx → muted slate (background request)
   * - Everything else → standard HTTP status color
   */
  const getBarColor = useCallback(
    (req: HttpRequest, defaultColor: string) => getSyncRequestBarColor(req, defaultColor),
    []
  );

  /**
   * Render the timeout-exceeded segment inside the bar.
   * The bar stays status-colored up to timeout; the overflow part is warning-colored.
   * For catchup requests (timeout=0), the overflow overlay is disabled (no overlay is rendered).
   */
  const renderBarOverlay = useCallback(
    (
      req: HttpRequest,
      barWidthPx: number,
      _msPerPixel: number,
      durationToPixels: (durationMs: number) => number,
    ) => renderTimeoutExceededOverlay(
      req,
      barWidthPx,
      _msPerPixel,
      durationToPixels,
      (request) => (request as SyncRequest).timeout,
    ),
    []
  );

  // Compute distinct timeout values present in the data, sorted ascending
  const availableTimeouts = useMemo(() => {
    const seen = new Set<number>();
    for (const r of allRequests) {
      if (r.timeout !== undefined) seen.add(r.timeout);
    }
    return Array.from(seen).sort((a, b) => a - b);
  }, [allRequests]);

  /** Human-readable label for a timeout value. */
  function formatTimeout(ms: number): string {
    if (ms === 0) return '0ms (catchup)';
    if (ms === 30000) return '30s (long-poll)';
    return ms >= 1000 ? `${ms / 1000}s` : `${ms}ms`;
  }

  // Connection selector + timeout selector for header
  const connectionSelector = (
    <>
      <select
        id="conn-filter"
        aria-label="Connection"
        value={selectedConnId}
        onChange={(e) => setSelectedConnId(e.target.value)}
        className="select-compact"
      >
        <option value="">All conn-id</option>
        {connectionIds.map((connId) => (
          <option key={connId} value={connId}>
            {connId}
          </option>
        ))}
      </select>
      {availableTimeouts.length >= 1 && (
        <select
          id="timeout-filter"
          aria-label="Sync timeout"
          value={selectedTimeout ?? ''}
          onChange={(e) => {
            const val = e.target.value === '' ? null : parseInt(e.target.value, 10);
            setSelectedTimeout(val);
            setTimeoutFilter(val);
          }}
          className="select-compact"
        >
          <option value="">All timeouts</option>
          {availableTimeouts.map((t) => (
            <option key={t} value={t}>
              {formatTimeout(t)}
            </option>
          ))}
        </select>
      )}
    </>
  );

  return (
    <RequestTable
      title="/sync requests"
      columns={columns}
      containerClassName="sync-view"
      filteredRequests={filteredRequests}
      totalCount={totalCount}
      showIncomplete={showIncomplete}
      onShowIncompleteChange={setShowIncomplete}
      msPerPixel={timelineScale}
      availableStatusCodes={availableStatusCodes}
      headerSlot={connectionSelector}
      emptyMessage="No sync requests found in log file"
      rowSelector=".sync-view"
      showLogFilter={false}
      showSyncFilter={false}
      renderBarOverlay={renderBarOverlay}
      getBarColor={getBarColor}
      focusModeColumnIds={SYNC_WATERFALL_FOCUS_COLUMNS}
    />
  );
}

import type { ActivityBucket } from './BaseActivityChart';
import { formatBytes } from '../utils/sizeUtils';
import { getBucketColor, getBucketLabel, sortStatusCodes } from '../utils/httpStatusBuckets';

/**
 * Bucket type for the mirrored bandwidth histogram chart, extending the generic
 * {@link ActivityBucket} with per-status byte totals for both upload and download.
 *
 * Per-status maps allow the histogram to render each bar as a stack of status-coloured
 * segments (matching the `HttpActivityChart` palette) rather than two flat blocks.
 *
 * Kept in a separate file from {@link BandwidthChart} so it can be exported
 * for direct unit-testing without violating the react-refresh rule that
 * component files should only export components.
 */
export interface BandwidthBucket extends ActivityBucket {
  /** Total download bytes across all statuses in this time slot. */
  totalDownload: number;
  /** Total upload bytes across all statuses in this time slot. */
  totalUpload: number;
  /** Per-status-bucket download bytes, keyed by `getBucketKey()` output. */
  downloadByStatus: Record<string, number>;
  /** Per-status-bucket upload bytes, keyed by `getBucketKey()` output. */
  uploadByStatus: Record<string, number>;
}

/**
 * Renders the tooltip content for a single bandwidth bar.
 *
 * Shows per-status rows under an Upload section (above zero) and a Download
 * section (below zero), matching the mirrored bar layout of the chart.
 *
 * Extracted as a module-level function (rather than an inline useCallback) so
 * it can be unit-tested directly without needing to simulate SVG mouse hover
 * events in jsdom.
 *
 * @example
 * render(renderBandwidthTooltip({
 *   timestamp: 0,
 *   timeLabel: '00:00:01',
 *   total: 1536,
 *   totalDownload: 1024,
 *   totalUpload: 512,
 *   downloadByStatus: { '200': 1024 },
 *   uploadByStatus: { '200': 512 },
 * }));
 */
export function renderBandwidthTooltip(bucket: BandwidthBucket): React.ReactElement {
  const downloadEntries = sortStatusCodes(Object.keys(bucket.downloadByStatus))
    .reverse()
    .map((key): [string, number] => [key, bucket.downloadByStatus[key] ?? 0])
    .filter(([, v]) => v > 0);
  const uploadEntries = sortStatusCodes(Object.keys(bucket.uploadByStatus))
    .reverse()
    .map((key): [string, number] => [key, bucket.uploadByStatus[key] ?? 0])
    .filter(([, v]) => v > 0);

  return (
    <>
      {uploadEntries.length > 0 && (
        <>
          <div style={{ fontSize: '10px', color: '#aaa', marginBottom: '1px' }}>↑ Upload</div>
          {uploadEntries.map(([statusKey, bytes]) => (
            <div key={statusKey} style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '1px' }}>
              <span
                style={{
                  display: 'inline-block',
                  width: '6px',
                  height: '6px',
                  backgroundColor: getBucketColor(statusKey),
                  borderRadius: '1px',
                  flexShrink: 0,
                }}
              />
              <span style={{ fontSize: '10px' }}>{getBucketLabel(statusKey)}: {formatBytes(bytes)}</span>
            </div>
          ))}
        </>
      )}

      {downloadEntries.length > 0 && (
        <>
          <div style={{ fontSize: '10px', color: '#aaa', marginTop: uploadEntries.length > 0 ? '3px' : 0, marginBottom: '1px' }}>↓ Download</div>
          {downloadEntries.map(([statusKey, bytes]) => (
            <div key={statusKey} style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '1px' }}>
              <span
                style={{
                  display: 'inline-block',
                  width: '6px',
                  height: '6px',
                  backgroundColor: getBucketColor(statusKey),
                  borderRadius: '1px',
                  flexShrink: 0,
                }}
              />
              <span style={{ fontSize: '10px' }}>{getBucketLabel(statusKey)}: {formatBytes(bytes)}</span>
            </div>
          ))}
        </>
      )}

      {bucket.total > 0 && (
        <div
          style={{
            marginTop: '3px',
            paddingTop: '2px',
            borderTop: '1px solid #555',
            fontSize: '10px',
          }}
        >
          Total: {formatBytes(bucket.total)}
        </div>
      )}
    </>
  );
}

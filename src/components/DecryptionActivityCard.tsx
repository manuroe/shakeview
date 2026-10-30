/**
 * /summary cards, apart because a key's arrival and a failure have no common clock:
 * new megolm room keys over time by source (received, or outbound sessions this device created), then UTD events at their first failure,
 * by whether UTD analytics received them (the tracked metric); how they ended is in the tooltip and tables.
 * Scoped to the loaded logs: a resolution outside them can't be seen.
 */
import { useCallback, useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { ParsedLogLine } from '../types/log.types';
import type { TimestampMicros } from '../types/time.types';
import type { SelectionRange } from '../hooks/useChartInteraction';
import { BaseActivityChart } from './BaseActivityChart';
import { InfoPopover, InfoSection } from './InfoPopover';
import { getMinMaxTimestamps } from '../utils/timeUtils';
import { loadedLogSteps } from '../utils/crypto/loadDevice';
import { formatUs } from '../utils/crypto/format';
import { ANALYTICS_CATEGORIES, ANALYTICS_LABEL, REASON_NAME, REPORTED_CAVEAT, REPORTED_MEANING } from '../utils/crypto/labels';
import type { AnalyticsCategory } from '../utils/crypto/types';
import {
  bucketByTime, countBy, formatCounts, isReported, lateDecryptionRows, lateOutcomeKey, summarizeDecryption, utdOutcomeKey, utdReasonRows,
  type KeyPoint, type KeySource, type TimeBucket, type UtdPoint,
} from '../utils/crypto/decryptionSummary';
import styles from '../views/SummaryView.module.css';

const KEY_SOURCES: KeySource[] = ['room_key', 'room_key_late', 'forwarded', 'bundle', 'backup', 'outbound'];
const KEY_NAME: Readonly<Record<KeySource, string>> = {
  ['room_key']: 'm.room_key', ['room_key_late']: 'm.room_key (late)', forwarded: 'forwarded', bundle: 'history bundle', backup: 'backup',
  outbound: 'outbound session',
};
const KEY_COLORS: Readonly<Record<KeySource, string>> = {
  ['room_key']: 'var(--color-success)', ['room_key_late']: 'var(--color-warning)', forwarded: 'var(--color-info)', bundle: 'var(--color-sentry)', backup: 'var(--color-visited)',
  outbound: 'var(--text-secondary)',
};

/** UTDs by whether analytics received them, a copy: BaseActivityChart takes a mutable list. */
const UTD_CATEGORIES = [...ANALYTICS_CATEGORIES];
// Opaque tints of the page background: still visible on the dark tooltip, in both themes.
const grey = (pct: number) => `color-mix(in srgb, var(--text-muted) ${pct}%, var(--bg-primary))`;
/** Reported in red, so the tracked metric stands out; the rest in greys. */
const UTD_COLORS: Readonly<Record<AnalyticsCategory, string>> = { reported: 'var(--color-error)', ['not_reported']: grey(70), unknown: grey(40) };

/** A tooltip line: a category with its chart colour and an optional muted detail under it. */
interface TooltipRow { readonly key: string; readonly color: string; readonly text: string; readonly count: number; readonly detail?: string }

/** Tooltip as on the logs chart (a swatch per non-zero category), laid out as a grid: counts right-aligned, total last. */
function TooltipGrid({ rows, total }: { rows: readonly TooltipRow[]; total: number }) {
  return (
    <div className={styles.tooltipGrid}>
      {rows.filter((r) => r.count > 0).map((r) => (
        <span key={r.key} className={styles.tooltipRow}>
          <span className={styles.tooltipSwatch} style={{ backgroundColor: r.color }} />
          <span>{r.text}</span>
          <span className={styles.tooltipCount}>{r.count}</span>
          {r.detail && <span className={styles.tooltipDetail}>{r.detail}</span>}
        </span>
      ))}
      <span className={styles.tooltipRule} />
      <span className={styles.tooltipTotal}>Total</span>
      <span className={styles.tooltipCount}>{total}</span>
    </div>
  );
}

/** ⓘ after a Reported header: what the column counts, and that it is recomputed. `decryptionUrl` links the decryption page. */
function ReportedInfo({ decryptionUrl }: { decryptionUrl: string }) {
  return (
    <InfoPopover label="What Reported counts" alignEnd>
      <InfoSection title="What counts as reported"><p>{REPORTED_MEANING}</p></InfoSection>
      <InfoSection title="Where the numbers come from"><p>{REPORTED_CAVEAT}</p></InfoSection>
      <InfoSection title="What they cover">
        <p>Only the loaded logs. The <Link to={decryptionUrl}>decryption page</Link> also counts the sender rageshakes you add there.</p>
      </InfoSection>
    </InfoPopover>
  );
}

interface DecryptionActivityCardProps {
  readonly rawLogLines: readonly ParsedLogLine[];
  readonly filteredLogLines: readonly ParsedLogLine[];
  readonly onTimeRangeSelected?: (startUs: TimestampMicros, endUs: TimestampMicros) => void;
  readonly onResetZoom?: () => void;
  readonly externalCursorTime?: number | null;
  readonly externalSelection?: SelectionRange | null;
  readonly onCursorMove?: (timeUs: number | null) => void;
  readonly onSelectionChange?: (selection: SelectionRange | null) => void;
}

export function DecryptionActivityCard({ rawLogLines, filteredLogLines, ...chartProps }: DecryptionActivityCardProps) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // /decryption on the same time window, like the burger menu keeps it across views.
  const decryptionUrl = (extra?: Record<string, string>) => {
    const keep = new URLSearchParams(extra);
    for (const k of ['start', 'end']) {
      const v = searchParams.get(k);
      if (v) keep.set(k, v);
    }
    return keep.size > 0 ? `/decryption?${keep.toString()}` : '/decryption';
  };
  const openDecryptionView = (extra?: Record<string, string>) => { void navigate(decryptionUrl(extra)); };
  const summary = useMemo(() => summarizeDecryption(loadedLogSteps(rawLogLines)), [rawLogLines]);
  const chart = useMemo(() => {
    const { min, max } = getMinMaxTimestamps(filteredLogLines);
    const events = summary.events.filter((e) => e.ts >= min && e.ts <= max);
    const keys = summary.keys.filter((k) => k.ts >= min && k.ts <= max);
    return { min, max, events, keys, utdBuckets: bucketByTime(events, min, max), keyBuckets: bucketByTime(keys, min, max) };
  }, [summary, filteredLogLines]);

  const failing = useMemo(() => chart.events.filter((e) => !e.resolved), [chart.events]);
  const reasonRows = useMemo(() => utdReasonRows(failing), [failing]);
  const lateRows = useMemo(() => lateDecryptionRows(chart.events), [chart.events]);
  const reported = useMemo(() => chart.events.filter(isReported).length, [chart.events]);
  // A table count opens /decryption on its rows' outcomes; a Reported count, on the reported UTDs among them.
  const count = (n: number, outcomes: readonly string[], onlyReported = false) => (n === 0 ? 0 : (
    <button type="button" className={`${styles.clickableHeading} ${onlyReported ? styles.reported : ''}`} title="Open in the decryption view"
      onClick={() => openDecryptionView({ outcome: outcomes.join(','), ...(onlyReported ? { analytics: 'reported' } : {}) })}>
      {n}
    </button>
  ));

  const getKeyColor = useCallback((c: KeySource) => KEY_COLORS[c], []);
  const getKeyCount = useCallback((b: TimeBucket<KeyPoint>, c: KeySource) => b.points.filter((p) => p.source === c).length, []);
  const renderKeyTooltip = useCallback((b: TimeBucket<KeyPoint>) => (
    <TooltipGrid rows={KEY_SOURCES.map((c) => ({ key: c, color: KEY_COLORS[c], text: KEY_NAME[c], count: getKeyCount(b, c) }))} total={b.total} />
  ), [getKeyCount]);

  const getUtdColor = useCallback((c: AnalyticsCategory) => UTD_COLORS[c], []);
  const getUtdCount = useCallback((b: TimeBucket<UtdPoint>, c: AnalyticsCategory) => b.points.filter((p) => p.analytics === c).length, []);
  const renderUtdTooltip = useCallback((b: TimeBucket<UtdPoint>) => {
    const rows = UTD_CATEGORIES.map((c): TooltipRow => {
      const points = b.points.filter((p) => p.analytics === c);
      // How they ended: `Still failing 2 · late_key 9`.
      const detail = points.length > 0 ? formatCounts(countBy(points, (p) => p.by ?? 'Still failing')) : undefined;
      return { key: c, color: UTD_COLORS[c], text: ANALYTICS_LABEL[c], count: points.length, detail };
    });
    return <TooltipGrid rows={rows} total={b.total} />;
  }, []);

  return (
    <>
      <section className={styles.summarySection}>
        <h2>New megolm keys{chart.keys.length > 0 ? `: ${chart.keys.length}` : ''}</h2>
        {chart.keys.length === 0 ? <p className={styles.emptyNote}>No new megolm keys</p> : (
          <div className={styles.activityChartContainer}>
            <BaseActivityChart
              buckets={chart.keyBuckets.buckets}
              maxCount={chart.keyBuckets.maxCount}
              minTime={chart.min}
              maxTime={chart.max}
              categories={KEY_SOURCES}
              getCategoryColor={getKeyColor}
              getCategoryCount={getKeyCount}
              renderTooltipContent={renderKeyTooltip}
              {...chartProps}
            />
          </div>
        )}
      </section>

      <section className={styles.summarySection}>
        <h2>
          UTDs
          {reported > 0 && (
            <>
              {': '}
              <button type="button" className={styles.clickableHeading} aria-label="Open the UTDs reported to analytics" onClick={() => openDecryptionView({ analytics: 'reported' })}>
                {reported} reported
              </button>
            </>
          )}
        </h2>
        {chart.events.length === 0 ? <p className={styles.emptyNote}>No UTD</p> : (
          <div className={styles.activityChartContainer}>
            <BaseActivityChart
              buckets={chart.utdBuckets.buckets}
              maxCount={chart.utdBuckets.maxCount}
              minTime={chart.min}
              maxTime={chart.max}
              categories={UTD_CATEGORIES}
              getCategoryColor={getUtdColor}
              getCategoryCount={getUtdCount}
              renderTooltipContent={renderUtdTooltip}
              {...chartProps}
            />
          </div>
        )}
        {(reasonRows.length > 0 || lateRows.length > 0) && (
          <div className={styles.errorsWarningsGrid}>
            {reasonRows.length > 0 && (
              <div className={styles.summaryTableContainer}>
                <table className={styles.summaryTable}>
                  <thead>
                    <tr>
                      <th>Still failing ({count(failing.length, reasonRows.map((r) => utdOutcomeKey(r.reason)))})</th>
                      <th className={styles.alignRight}>Sessions</th>
                      <th className={styles.alignRight}>Events</th>
                      <th className={styles.alignRight}>Reported <ReportedInfo decryptionUrl={decryptionUrl()} /></th>
                    </tr>
                  </thead>
                  <tbody>
                    {reasonRows.map((r) => (
                      <tr key={r.reason}>
                        <td>{REASON_NAME[r.reason]}</td>
                        <td className={styles.alignRight}>{count(r.sessions, [utdOutcomeKey(r.reason)])}</td>
                        <td className={styles.alignRight}>{count(r.utds, [utdOutcomeKey(r.reason)])}</td>
                        <td className={styles.alignRight}>{count(r.reported, [utdOutcomeKey(r.reason)], true)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {lateRows.length > 0 && (
              <div className={styles.summaryTableContainer}>
                <table className={styles.summaryTable}>
                  <thead>
                    <tr>
                      <th>Late decryptions ({count(lateRows.reduce((n, r) => n + r.count, 0), lateRows.map((r) => lateOutcomeKey(r.by)))})</th>
                      <th className={styles.alignRight}>Sessions</th>
                      <th className={styles.alignRight}>Events</th>
                      <th className={styles.alignRight}>Reported <ReportedInfo decryptionUrl={decryptionUrl()} /></th>
                      <th className={styles.alignRight}>Median delay</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lateRows.map((r) => (
                      <tr key={r.by}>
                        <td>{r.by}</td>
                        <td className={styles.alignRight}>{count(r.sessions, [lateOutcomeKey(r.by)])}</td>
                        <td className={styles.alignRight}>{count(r.count, [lateOutcomeKey(r.by)])}</td>
                        <td className={styles.alignRight}>{count(r.reported, [lateOutcomeKey(r.by)], true)}</td>
                        <td className={styles.alignRight} title={r.lowerBound ? 'At least: some re-decryptions are not logged, their key arrival stands in' : undefined}>{r.lowerBound ? '≥ ' : ''}{formatUs(r.medianDelayUs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </section>
    </>
  );
}

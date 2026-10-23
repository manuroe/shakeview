/**
 * /decryption: the megolm sessions of the loaded logs, in the selected time window,
 * filtered by id (header search), by outcome (key received, outbound session, UTD reason, late decryption mechanism)
 * and by whether UTD analytics received the UTD. The loaded logs are the main device; sender rageshakes can be added
 * next to it. Left: sessions; top: verdict and key journey; then one timeline for sender and receiver.
 */
import { createContext, Fragment, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useClickOutside } from '../hooks/useClickOutside';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { BurgerMenu } from '../components/BurgerMenu';
import { TimeRangeSelector } from '../components/TimeRangeSelector';
import { OutcomeFilterDropdown, type OutcomeOption } from '../components/OutcomeFilterDropdown';
import { AnalyticsFilterDropdown } from '../components/AnalyticsFilterDropdown';
import { InfoPopover, InfoSection } from '../components/InfoPopover';
import { SearchInput } from '../components/SearchInput';
import { useCryptoStore, loadCryptoDevice, loadedArchive, caseKeyOf, isInCase, startCase } from '../stores/cryptoStore';
import { useArchiveStore } from '../stores/archiveStore';
import { useLogStore } from '../stores/logStore';
import { useMatrixProfile } from '../hooks/useMatrixProfile';
import { DEMO_PEER, fetchDemoLog } from '../utils/demoLogs';
import { calculateTimeRangeMicros, formatTimestamp, getMinMaxTimestamps } from '../utils/timeUtils';
import { buildCryptoModel } from '../utils/crypto/buildCryptoModel';
import { scopeSessions } from '../utils/crypto/scope';
import { ANALYTICS_OPTIONS, deviceLabel, REASON_NAME, REPORTED_CAVEAT, RESOLUTION_MECHANISMS, UTD_REASONS } from '../utils/crypto/labels';
import { lateOutcomeKey, matchesOutcomes, sessionEventKeys, sessionOutcomeCounts, sessionSearchText, utdOutcomeKey } from '../utils/crypto/decryptionSummary';
import { filterCounts, isUnreported, listSessions, sessionSpan, sumCounts, type SessionDay, type SessionRow } from '../utils/crypto/sessionList';
import { buildTimeline, sessionLanes, shareRecipients, type Lane, type LinkMark, type StepRow, type TimelineRow } from '../utils/crypto/timeline';
import { buildJourney, type Journey, type JourneyState, type JourneyTone } from '../utils/crypto/journey';
import { describeStep, stepTone, utdStepNote } from '../utils/crypto/describeStep';
import { formatUs, plural, short, utcText } from '../utils/crypto/format';
import { isIdentifierAlias } from '../utils/anonymizeUtils';
import { findMatchingIndices } from '../utils/textMatching';
import { allLinesOf, detailsFromEntries, deviceFromDroppedFiles, deviceFromEntries, deviceFromFile, deviceFromLoadedLogs, droppedDevices, linesOfFile } from '../utils/crypto/loadDevice';
import type { ParsedLogLine } from '../types/log.types';
import { LogDisplayView } from './LogDisplayView';
import type { CryptoDevice, CryptoStep, DeviceRef, LineRef, MegolmSession } from '../utils/crypto/types';
import styles from './DecryptionView.module.css';

const SESSION_PARAM = 'session';
/** Comma-separated outcome keys (see sessionOutcomeCounts); absent: every session. */
const OUTCOME_PARAM = 'outcome';
/** Every outcome in display order: UTDs red, late decryptions orange; an outbound session grey as on the /summary keys chart. */
const OUTCOMES: readonly Omit<OutcomeOption, 'count'>[] = [
  // No SDK logs a successful decryption: all the logs show is the key arriving and no UTD.
  { key: 'key_received', label: 'Key received', group: 'No UTD', color: 'var(--color-success)' },
  // A session a loaded device started (Rust's `OutboundGroupSession`), counted as on the /summary keys chart.
  { key: 'outbound', label: 'Outbound session', group: 'No UTD', color: 'var(--text-secondary)' },
  ...UTD_REASONS.map((r) => ({ key: utdOutcomeKey(r), label: REASON_NAME[r], group: 'UTD', color: 'var(--log-level-error)' })),
  ...RESOLUTION_MECHANISMS.map((m) => ({ key: lateOutcomeKey(m), label: m, group: 'Late decryption', color: 'var(--log-level-warn)' })),
];
/** The second filter, one value at a time: did UTD analytics receive a UTD of the session. /summary links to `reported`. */
const ANALYTICS_PARAM = 'analytics';
/** The header search: sessions naming this id, or part of it, any case (see sessionSearchText). */
const QUERY_PARAM = 'q';
const clock = (us: number) => utcText(us, 'clock');

/** Opens a step's log line in the bottom panel; nothing is loaded into the log store. */
const OpenLine = createContext<(device: CryptoDevice, ref: LineRef) => void>(() => {});
/** Lines shown around the opened step. */
const PANEL_CONTEXT = 30;

/** A clickable element that is not a button, operable from the keyboard like one (Enter, Space); keys on its children are theirs. */
const activatable = (onActivate: () => void) => ({
  tabIndex: 0,
  onClick: onActivate,
  onKeyDown: (e: ReactKeyboardEvent) => {
    if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    onActivate();
  },
});

/** The sessions' outcomes, named and coloured as in the header filter; prefixed by the UTD count when more than one. */
function OutcomeTags({ counts }: { counts: ReadonlyMap<string, number> }) {
  return OUTCOMES.filter((o) => counts.has(o.key)).map((o) => {
    const n = o.group === 'No UTD' ? 0 : counts.get(o.key)!;
    return (
      <span key={o.key} className={styles.tag} style={{ color: o.color, background: `color-mix(in srgb, ${o.color} 15%, transparent)` }}
        title={n > 1 ? `${n} UTDs` : undefined}>
        {n > 1 && `${n} `}{o.label}
      </span>
    );
  });
}

const hms = (us: number) => formatTimestamp(us, 'HH:MM:SS');
const roomOf = (s: MegolmSession) => (s.roomId ? short(s.roomId) : 'room ?');
const senderOf = (s: MegolmSession, mainId: string) => (s.sender.loadedId === mainId ? 'This device' : s.sender.userId ?? 'unknown sender');
const outcomeLabels = (keys: readonly string[]) => OUTCOMES.filter((o) => keys.includes(o.key)).map((o) => o.label).join(', ');

/** Line 1: sender and time; line 2: room and outcomes. Inside a group, which shows sender and room once: time and outcomes. */
// Memoised with stable props, so a click re-renders only the rows whose selection changed.
const SessionButton = memo(function SessionButton({ row, selected, compact, mainId, onSelect }: {
  row: SessionRow; selected: boolean; compact?: boolean; mainId: string; onSelect: (sessionId: string) => void;
}) {
  const s = row.session;
  const labels = outcomeLabels(row.keys);
  return (
    <button
      type="button" className={`${styles.sessionItem} ${compact ? styles.compact : ''} ${selected ? styles.selected : ''} ${isUnreported(row.pairs) ? styles.muted : ''}`}
      onClick={() => onSelect(s.sessionId)} title={s.sessionId} aria-label={`Session ${s.sessionId}${labels ? `: ${labels}` : ''}`}
    >
      {compact ? (
        <div className={styles.rowTop}><span className={styles.rowTime}>{hms(row.ts)}</span><span><OutcomeTags counts={row.counts} /></span></div>
      ) : (
        <>
          <div className={styles.rowTop}><span className={styles.rowSender}>{senderOf(s, mainId)}</span><span className={styles.rowTime}>{hms(row.ts)}</span></div>
          <div className={styles.rowSub}><span>{roomOf(s)}</span><span><OutcomeTags counts={row.counts} /></span></div>
        </>
      )}
    </button>
  );
});

/** Consecutive sessions with the same room, sender and outcomes, folded under one row; its sessions follow it when open. */
const GroupButton = memo(function GroupButton({ rows, open, mainId, onToggle }: {
  rows: readonly SessionRow[]; open: boolean; mainId: string; onToggle: (groupId: string, open: boolean) => void;
}) {
  const counts = useMemo(() => sumCounts(rows), [rows]);
  const newest = rows[0];
  return (
    <button type="button" className={`${styles.sessionItem} ${rows.every((r) => isUnreported(r.pairs)) ? styles.muted : ''}`}
      onClick={() => onToggle(newest.session.sessionId, open)} aria-expanded={open} aria-label={`${rows.length} sessions: ${outcomeLabels(newest.keys)}`}>
      <div className={styles.rowTop}>
        <span className={styles.rowSender}>{open ? '▾' : '▸'} {senderOf(newest.session, mainId)}</span>
        <span className={styles.rowTime}>{hms(newest.ts)}</span>
      </div>
      <div className={styles.rowSub}><span>{roomOf(newest.session)}</span><span><OutcomeTags counts={counts} /></span></div>
    </button>
  );
});

/** One entry of the session list: a day, a session (compact inside a group), or a group's row. */
type ListItem =
  | { readonly kind: 'day'; readonly day: string }
  | { readonly kind: 'session'; readonly row: SessionRow; readonly compact: boolean }
  | { readonly kind: 'group'; readonly rows: readonly SessionRow[]; readonly open: boolean };
const itemKey = (it: ListItem) => (it.kind === 'day' ? `day:${it.day}` : it.kind === 'group' ? `group:${it.rows[0].session.sessionId}` : it.row.session.sessionId);
/** First guess of a row's height, in px, before it is measured. */
const ROW_ESTIMATE = 44;

/**
 * The session list, virtualized: big logs hold thousands of sessions. A group opens while it holds the
 * selection, until clicked: a click toggles what is shown. The selection scrolls into view.
 */
function SessionList({ days, selectedId, mainId, onSelect }: {
  days: readonly SessionDay[]; selectedId: string; mainId: string; onSelect: (sessionId: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map());
  const onToggle = useCallback((groupId: string, open: boolean) => setToggled((t) => new Map(t).set(groupId, !open)), []);
  const items = useMemo(() => days.flatMap((d): ListItem[] => [
    { kind: 'day', day: d.day },
    ...d.groups.flatMap((g): ListItem[] => {
      if (g.length === 1) return [{ kind: 'session', row: g[0], compact: false }];
      const open = toggled.get(g[0].session.sessionId) ?? g.some((r) => r.session.sessionId === selectedId);
      return [{ kind: 'group', rows: g, open }, ...(open ? g.map((row): ListItem => ({ kind: 'session', row, compact: true })) : [])];
    }),
  ]), [days, toggled, selectedId]);
  // eslint-disable-next-line react-hooks/incompatible-library -- useVirtualizer returns functions the compiler can't memoize; same as LogDisplayView.
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (i) => itemKey(items[i]),
    estimateSize: () => ROW_ESTIMATE,
    overscan: 10,
  });
  // The selected session's row, else its closed group's.
  const selectedIndex = useMemo(() => {
    const i = items.findIndex((it) => it.kind === 'session' && it.row.session.sessionId === selectedId);
    return i >= 0 ? i : items.findIndex((it) => it.kind === 'group' && it.rows.some((r) => r.session.sessionId === selectedId));
  }, [items, selectedId]);
  // Scroll once per selection: opening a group above it shifts its index, not what the user looks at.
  const scrolledTo = useRef<string | null>(null);
  useEffect(() => {
    if (selectedIndex < 0 || scrolledTo.current === selectedId) return;
    scrolledTo.current = selectedId;
    virtualizer.scrollToIndex(selectedIndex, { align: 'auto' });
  }, [virtualizer, selectedIndex, selectedId]);
  return (
    <div ref={scrollRef} className={styles.sessions}>
      <div className={styles.sessionsInner} style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((v) => {
          const it = items[v.index];
          return (
            <div key={v.key} data-index={v.index} ref={virtualizer.measureElement} className={styles.listItem} style={{ transform: `translateY(${v.start}px)` }}>
              {it.kind === 'day' ? <div className={styles.day}>{it.day}</div>
                : it.kind === 'group' ? <GroupButton rows={it.rows} open={it.open} mainId={mainId} onToggle={onToggle} />
                  : <SessionButton row={it.row} compact={it.compact} selected={it.row.session.sessionId === selectedId} mainId={mainId} onSelect={onSelect} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A step's card: its description and, under a UTD's first failure, how it ended with a link to the key step. */
function StepCard({ step, session, device }: { step: CryptoStep; session: MegolmSession; device: CryptoDevice }) {
  const openLine = useContext(OpenLine);
  const note = utdStepNote(step, session, device.id);
  const keyStep = note?.keyStep;
  return (
    <div>
      <div className={styles.step}>
        {describeStep(step)}
        {note && <div className={styles.sub}>{note.text}</div>}
      </div>
      {keyStep && (
        <button type="button" className={styles.link} onClick={(e) => { e.stopPropagation(); openLine(device, keyStep); }}>
          ↳ key step
        </button>
      )}
    </div>
  );
}

type Search = { readonly query: string; readonly lane: Lane };
/** Every line of an added device, parsed once per device on first search. */
const allLines = new WeakMap<CryptoDevice, readonly ParsedLogLine[]>();
/** No added devices, one array for every render: a store selector returning a fresh one would re-render forever. */
const NO_DEVICES: readonly CryptoDevice[] = [];

/** Show every log line naming this id in the bottom panel. */
function OccurrencesButton({ query, onSearch }: { query: string; onSearch: (query: string) => void }) {
  return (
    <button type="button" className={`${styles.searchButton} ${styles.tipped}`} data-tip="Find in logs" aria-label={`Show occurrences of ${query}`}
      onClick={(e) => { e.stopPropagation(); onSearch(query); }}>
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
        <circle cx="6.75" cy="6.75" r="4.75" />
        <line x1="10.25" y1="10.25" x2="14" y2="14" />
      </svg>
    </button>
  );
}

/** The event id, linked to its matrix.to permalink (shown in a quick tooltip); plain text when there is no usable link. */
function EventId({ roomId, eventId }: { roomId: string | undefined; eventId: string }) {
  if (!roomId) return <span className={styles.jEventId}>{eventId}</span>;
  // An anonymizer alias: a matrix.to link would point nowhere.
  if (isIdentifierAlias(roomId) || isIdentifierAlias(eventId)) {
    return <span className={`${styles.jEventId} ${styles.tipped}`} data-tip="Ids are anonymized: no matrix.to permalink">{eventId}</span>;
  }
  const url = `https://matrix.to/#/${encodeURIComponent(roomId)}/${encodeURIComponent(eventId)}`;
  return (
    <a className={`${styles.jEventId} ${styles.eventLink} ${styles.tipped}`} data-tip={url} href={url} target="_blank" rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}>{eventId}</a>
  );
}

const STATE_ICON: Record<JourneyState, string> = { ok: '✓', fail: '✗', unknown: '?', note: '·' };
const TONE_ICON: Record<JourneyTone, string> = { good: '✓', late: '◐', bad: '✗', neutral: '·' };

/** A symbol coloured as on the journey lines. */
const Mark = ({ tone, icon }: { tone: JourneyState | 'late'; icon: string }) => <span className={`${styles.jIcon} ${styles[tone]}`}>{icon}</span>;

/** What the verdict and the journey are, and where they go wrong: they are a heuristic, not a finding. */
function JourneyHelp() {
  return (
    <InfoPopover label="How to read the verdict">
      <InfoSection title="What the verdict is">
        <p>
          A best guess from the loaded logs, not a proven cause. The checks run in a fixed order and the first one
          that matches wins. The line it&apos;s based on is marked ▸.
        </p>
      </InfoSection>
      <InfoSection title="The key's journey">
        <p>
          The steps the key took to reach this device, as a checklist. Steps with a time are listed in order around
          the first decryption failure; &ldquo;+5s&rdquo; means 5 seconds after it.
        </p>
      </InfoSection>
      <InfoSection title="Symbols">
        <dl className={styles.symbols}>
          <dt><Mark tone="ok" icon={STATE_ICON.ok} /></dt><dd>seen in the logs</dd>
          <dt><Mark tone="fail" icon={STATE_ICON.fail} /></dt><dd>seen failing in the logs</dd>
          <dt><Mark tone="unknown" icon={STATE_ICON.unknown} /></dt><dd>not in the logs (the line says why)</dd>
          <dt><Mark tone="late" icon={TONE_ICON.late} /></dt><dd>decrypted, but late</dd>
          <dt><Mark tone="note" icon={STATE_ICON.note} /></dt><dd>a note</dd>
        </dl>
        <p><i>Inferred</i> steps are worked out from nearby lines, not logged directly.</p>
      </InfoSection>
      <InfoSection title="What the logs can't tell you">
        <ul>
          <li>This device&apos;s logs don&apos;t show the sender&apos;s side. Add the sender&apos;s rageshake to fill in the ? lines.</li>
          <li>Some things are never logged: why a device was left out of a key share, and, on Element X, a successful retry of decryption.</li>
          <li>The two devices&apos; clocks may not match. Sender times use the sender&apos;s clock.</li>
          <li>History sharing (room key bundles) is matched by time, so it&apos;s approximate.</li>
        </ul>
      </InfoSection>
      <p className={styles.helpFooter}>Click any line to open it in the logs, and check it before trusting the verdict.</p>
    </InfoPopover>
  );
}

/** The verdict and the key's journey (see buildJourney); a line with a log reference opens it like a timeline row. */
function JourneyView({ journey, roomId, sender, receiver, onOpen, onSearch }: {
  journey: Journey; roomId: string | undefined; sender: CryptoDevice | undefined; receiver: CryptoDevice | undefined;
  onOpen: (opened: Opened) => void; onSearch: (query: string) => void;
}) {
  const deviceOf = (lane: Lane | undefined) => (lane === 'sender' ? sender : receiver);
  return (
    <div className={styles.journey}>
      <div className={`${styles.verdict} ${styles[journey.tone]}`}>{TONE_ICON[journey.tone]} {journey.verdict} <JourneyHelp /></div>
      <div className={styles.basis}>Based on {journey.basis}{!sender && receiver ? ' (add it under Sender)' : ''}</div>
      {journey.lines.map((l) => {
        const device = deviceOf(l.lane);
        const ref = l.ref;
        return (
          <div
            key={l.label} className={`${styles.jLine} ${ref && device ? styles.clickable : ''}`}
            {...(ref && device ? { role: 'button', ...activatable(() => onOpen({ device, ref })) } : {})}
            data-decisive={l.decisive || undefined} title={l.decisive ? 'The verdict comes from this line' : undefined}
          >
            <span className={`${styles.jIcon} ${styles[l.state]}`}>{STATE_ICON[l.state]}</span>
            <span className={styles.jLabel}>{l.label}</span>
            <span className={styles.jDetail}>{l.detail}</span>
          </div>
        );
      })}
      {journey.events.length > 0 && (
        <div className={styles.jEvents}>
          <div className={styles.lane}>Events</div>
          {journey.events.map((e) => (
            <div key={e.eventId} className={`${styles.jLine} ${e.muted ? styles.muted : ''}`}>
              <span className={`${styles.jIcon} ${e.ok ? styles.ok : styles.fail}`}>{e.ok ? '✓' : '✗'}</span>
              <span>
                <EventId roomId={roomId} eventId={e.eventId} />
                <OccurrencesButton query={e.eventId} onSearch={onSearch} />
              </span>
              {/* Its own button: the id cell holds a link and a button already. */}
              {receiver ? (
                <button type="button" className={`${styles.textButton} ${styles.jDetail}`} title="Open its log line"
                  onClick={() => onOpen({ device: receiver, ref: e.ref })}>{e.text}</button>
              ) : <span className={styles.jDetail}>{e.text}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The sender's key-share recipients, as "N users · M devices"; the list opens in a popup, the rageshake's own user first. */
function SharedWith({ steps, receiver, mainUserId }: { steps: readonly CryptoStep[]; receiver: CryptoDevice | undefined; mainUserId: string | undefined }) {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, () => setIsOpen(false), isOpen);
  const { users, deviceCount } = useMemo(() => shareRecipients(steps, mainUserId), [steps, mainUserId]);
  if (users.length === 0) return null;
  const isReceiver = (userId: string, deviceId: string) => receiver?.identity.userId === userId && receiver.identity.deviceId === deviceId;
  return (
    <div className={styles.sharedWith} ref={ref}>
      <button type="button" className={styles.sharedWithButton} onClick={() => setIsOpen((o) => !o)} aria-expanded={isOpen} aria-haspopup="dialog">
        Shared with {plural(users.length, 'user')} · {plural(deviceCount, 'device')}
      </button>
      {isOpen && (
        <div className={styles.sharedWithPanel} role="dialog" aria-label="Key share recipients">
          {users.map(([userId, devices]) => (
            <div key={userId} className={styles.recipientUser}>
              <div>{userId}</div>
              {devices.map((d) => (
                <div key={d} className={`${styles.recipientDevice} ${isReceiver(userId, d) ? styles.recipientLoaded : ''}`}>
                  {d}{isReceiver(userId, d) ? ' · receiver' : ''}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** A lane's header: role, identity, and what the lane can or cannot show. */
function LaneHeader({ lane, deviceRef, device, session, receiver, mainUserId, onAddFiles, onAddDemo }: {
  lane: Lane; deviceRef: DeviceRef | undefined; device: CryptoDevice | undefined; session: MegolmSession;
  receiver: CryptoDevice | undefined; mainUserId: string | undefined; onAddFiles: (files: FileList | null) => void;
  /** Set when the loaded logs are a demo: adds the other side of the demo conversation instead of asking for a file. */
  onAddDemo?: () => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const isAnonymized = useLogStore((s) => s.isAnonymized);
  const profile = useMatrixProfile(isAnonymized ? undefined : device?.identity.userId ?? deviceRef?.userId);
  const isSender = lane === 'sender';
  // A sender rageshake belongs to the device that sent this session: added from its lane only.
  const canAdd = isSender && !device;
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    onAddFiles(e.dataTransfer.files);
  };
  const span = useMemo(() => sessionSpan(session), [session]);
  const covered = !device || device.coverage.length === 0 || device.coverage.some((c) => c.start <= span.end && c.end >= span.start);
  return (
    <div
      role="columnheader" className={styles.columnHeader} data-testid="device-header"
      onDragOver={canAdd ? (e) => e.preventDefault() : undefined} onDrop={canAdd ? onDrop : undefined}
    >
      <div className={styles.lane}>{isSender ? 'Sender' : 'Receiver'}</div>
      <div className={device ? '' : styles.muted}>
        {profile?.avatarHttpUrl && <img src={profile.avatarHttpUrl} alt="" className={styles.avatar} onError={(e) => { e.currentTarget.hidden = true; }} />}
        {device ? deviceLabel(device) : deviceRef ? deviceLabel(deviceRef) : 'no loaded receiver for this session'}
      </div>
      {!device && isSender && (
        <div>
          <span className={styles.muted}>sender device not loaded{deviceRef?.senderKey ? ` · curve ${short(deviceRef.senderKey)}` : ''}</span>
          {canAdd && (
            <>
              <button type="button" className={`btn-secondary ${styles.addButton}`} onClick={onAddDemo ?? (() => fileInput.current?.click())}>
                Add sender rageshake
              </button>
              <input
                ref={fileInput} type="file" accept=".gz,.tgz,.log" multiple hidden aria-label="Sender rageshake file"
                onChange={(e) => onAddFiles(e.target.files)}
              />
            </>
          )}
        </div>
      )}
      {!covered && <div className={styles.note}>no logs at this time</div>}
      {device && isSender && <SharedWith steps={session.stepsByDevice[device.id] ?? []} receiver={receiver} mainUserId={mainUserId} />}
    </div>
  );
}

const linkText = (l: LinkMark) => (l.missing ? `✗ ${l.text}` : l.dir === 'out' ? `${l.text} →` : `→ ${l.text}`);
const delta = (r: StepRow) => (r.deltaUs === null ? '' : `+${formatUs(r.deltaUs)}`);

type Opened = { readonly device: CryptoDevice; readonly ref: LineRef };
const sameRef = (a: LineRef, b: LineRef) => a.archive === b.archive && a.file === b.file && a.line === b.line;

/** One timeline row: own-clock time, delta, the card in its lane, the link between the lanes. Click toggles its log line. */
function StepRowView({ row, striped, selected, tabbable, onToggle, session, sender, receiver }: {
  row: StepRow; striped: boolean; selected: boolean; tabbable: boolean; onToggle: () => void;
  session: MegolmSession; sender: CryptoDevice | undefined; receiver: CryptoDevice | undefined;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!selected) return;
    ref.current?.scrollIntoView?.({ block: 'nearest' });
    // Up/Down from a focused row: focus follows the selection, the only tab stop.
    if (document.activeElement?.getAttribute('role') === 'row') ref.current?.focus();
  }, [selected]);
  const device = row.lane === 'sender' ? sender : receiver;
  const tone = stepTone(row.step);
  // Card accent: failures red, keys and successes green, routine steps neutral.
  const card = device && <div className={tone ? styles[tone] : ''}><StepCard step={row.step} session={session} device={device} /></div>;
  return (
    <div ref={ref} role="row" aria-selected={selected} {...activatable(onToggle)} tabIndex={tabbable ? 0 : -1}
      className={`${styles.tlRow} ${styles.clickable} ${striped ? styles.striped : ''} ${selected ? styles.selectedRow : ''}`}>
      <div role="gridcell" className={styles.tlTime}>{clock(row.step.ts)}</div>
      <div role="gridcell" className={styles.tlDelta}>{delta(row)}</div>
      <div role="gridcell">{row.lane === 'sender' && card}</div>
      <div role="gridcell" className={`${styles.tlLink} ${row.link?.missing ? styles.missing : ''}`}>{row.link && linkText(row.link)}</div>
      <div role="gridcell">{row.lane === 'receiver' && card}</div>
    </div>
  );
}

/**
 * Both lanes on one time axis (see buildTimeline); folds open in place; rows alternate like /http_requests.
 * Clicking a row toggles its log line in the bottom panel; Up/Down move to the previous/next visible row.
 */
function Timeline({ rows, session, sender, receiver, opened, onOpen }: {
  rows: readonly TimelineRow[]; session: MegolmSession; sender: CryptoDevice | undefined; receiver: CryptoDevice | undefined;
  opened: Opened | null; onOpen: (opened: Opened | null) => void;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) => setOpen((o) => {
    const next = new Set(o);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  const keyOf = (r: StepRow) => `${r.step.line.archive}:${r.step.line.file}:${r.step.line.line}`;
  const deviceOf = (r: StepRow) => (r.lane === 'sender' ? sender : receiver);
  const isSelected = (r: StepRow) => opened !== null && sameRef(opened.ref, r.step.line);
  const select = (r: StepRow | undefined, toggleOff = false) => {
    const device = r && deviceOf(r);
    if (r && device) onOpen(toggleOff && isSelected(r) ? null : { device, ref: r.step.line });
  };
  const visible = rows.flatMap((r) => (r.kind === 'step' ? [r] : r.kind === 'fold' && open.has(r.id) ? r.rows : []));
  // Subscribed once; the handler reads this render's rows and selection through the ref.
  const onKey = useRef<(e: KeyboardEvent) => void>(() => {});
  useLayoutEffect(() => {
    onKey.current = (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select, [data-log-panel]')) return;
      const i = visible.findIndex(isSelected);
      const next = i < 0 ? undefined : visible[i + (e.key === 'ArrowDown' ? 1 : -1)];
      if (!next) return;
      e.preventDefault();
      select(next);
    };
  });
  useEffect(() => {
    const handler = (e: KeyboardEvent) => onKey.current(e);
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
  // Roving tabindex: one tab stop in the grid, the selected row, else the first.
  const tabStop = visible.find(isSelected) ?? visible[0];
  let n = 0;
  const stepRow = (r: StepRow) => (
    <StepRowView key={keyOf(r)} row={r} striped={n++ % 2 === 1} selected={isSelected(r)} tabbable={r === tabStop} onToggle={() => select(r, true)}
      session={session} sender={sender} receiver={receiver} />
  );
  return rows.map((r, i) => {
    if (r.kind === 'gap') return <div key={`gap-${i}`} role="row" className={styles.tlGap}><span role="gridcell">{formatUs(r.us)} with nothing logged</span></div>;
    if (r.kind === 'step') return stepRow(r);
    const button = (
      <button type="button" className={`${styles.step} ${styles.fold}`} onClick={() => toggle(r.id)} aria-expanded={open.has(r.id)}>
        {open.has(r.id) ? '▾' : '▸'} {r.label}
      </button>
    );
    return (
      <Fragment key={r.id}>
        <div role="row" className={`${styles.tlRow} ${n++ % 2 === 1 ? styles.striped : ''}`}>
          <div role="gridcell" className={styles.tlTime}>{clock(r.rows[0].step.ts)}</div>
          <div role="gridcell" className={styles.tlDelta}>{delta(r.rows[0])}</div>
          <div role="gridcell">{r.lane === 'sender' && button}</div>
          <div role="gridcell" />
          <div role="gridcell">{r.lane === 'receiver' && button}</div>
        </div>
        {open.has(r.id) && r.rows.map(stepRow)}
      </Fragment>
    );
  });
}

export function DecryptionView() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const [opened, setOpenedLine] = useState<Opened | null>(null);
  const [search, setSearch] = useState<Search | null>(null);
  // One panel: a step's line, or every occurrence of an id.
  const setOpened = useCallback((o: Opened | null) => {
    setSearch(null);
    setOpenedLine(o);
  }, []);
  const onSearch = useCallback((query: string) => {
    setOpenedLine(null);
    setSearch({ query, lane: 'receiver' });
  }, []);
  const pending = useCryptoStore((s) => s.pending);
  const errors = useCryptoStore((s) => s.errors);
  const rawLogLines = useLogStore((s) => s.rawLogLines);
  const startTime = useLogStore((s) => s.startTime);
  const endTime = useLogStore((s) => s.endTime);
  const loadedEntryNames = useLogStore((s) => s.loadedEntryNames);
  const archiveName = useArchiveStore((s) => s.archiveName);
  const archiveEntries = useArchiveStore((s) => s.archiveEntries);

  // The archive the loaded logs come from (archiveStore can be stale), and the case they form.
  const sourceArchive = loadedArchive(archiveName, archiveEntries, loadedEntryNames);
  const caseKey = caseKeyOf(archiveName, archiveEntries, loadedEntryNames);
  const added = useCryptoStore((s) => (isInCase(s, caseKey) ? s.devices : NO_DEVICES));

  // Added devices belong to one case; opening other logs starts a new one. Opening an
  // added device's archive (a step link does) stays in the case: the case's own
  // archive then joins as a device, so the pair survives the round trip.
  useEffect(() => {
    const crypto = useCryptoStore.getState();
    if (crypto.caseKey === caseKey) return;
    const { caseArchive } = crypto;
    if (!caseArchive || !isInCase(crypto, caseKey)) {
      startCase();
      return;
    }
    // Once: a second visit to an added device's archive finds the case's own already added.
    if (!crypto.devices.some((d) => d.id === caseArchive.name)) {
      void loadCryptoDevice(caseArchive.name, () => deviceFromEntries(caseArchive.name, caseArchive.entries));
    }
  }, [caseKey]);

  // The loaded logs are the main device, like on every other view.
  const main = useMemo(
    () => deviceFromLoadedLogs(
      sourceArchive ?? (loadedEntryNames.join(', ') || 'loaded logs'), rawLogLines, sourceArchive ? detailsFromEntries(archiveEntries) : null,
    ),
    [rawLogLines, sourceArchive, archiveEntries, loadedEntryNames],
  );
  const devices = useMemo(() => [main, ...added.filter((d) => d.id !== main.id)], [main, added]);

  const range = useMemo(() => {
    const { min, max } = getMinMaxTimestamps(rawLogLines);
    return calculateTimeRangeMicros(startTime, endTime, min, max);
  }, [rawLogLines, startTime, endTime]);

  // Built once per device set (the slow part on big logs), then cut to each time window.
  const model = useMemo(() => buildCryptoModel(devices, { includeHealthy: true }), [devices]);
  const allSessions = useMemo(
    () => scopeSessions(model, range.startUs, range.endUs)
      .map((s) => {
        const counts = sessionOutcomeCounts(s);
        return { session: s, keys: [...counts.keys()], counts, pairs: sessionEventKeys(s), text: sessionSearchText(s) };
      }),
    [model, range],
  );
  const query = searchParams.get(QUERY_PARAM) ?? '';
  const searched = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? allSessions.filter((r) => r.text.includes(q)) : allSessions;
  }, [allSessions, query]);
  const setQuery = (next: string) => setSearchParams((p) => {
    if (next) p.set(QUERY_PARAM, next);
    else p.delete(QUERY_PARAM);
    return p;
  }, { replace: true });
  const outcomeParam = searchParams.get(OUTCOME_PARAM);
  const selected = useMemo(() => (outcomeParam ? new Set(outcomeParam.split(',')) : null), [outcomeParam]);
  const analyticsParam = searchParams.get(ANALYTICS_PARAM);
  const canTellAnalytics = useMemo(() => allSessions.some(({ pairs }) => pairs.some(([, a]) => a !== undefined && a !== 'unknown')), [allSessions]);
  // Ignored while its dropdown is hidden: a stale `analytics=` would empty the list with nothing to clear it.
  const analyticsAs = canTellAnalytics ? ANALYTICS_OPTIONS.find((o) => o.key === analyticsParam)?.key ?? null : null;
  const counts = useMemo(() => filterCounts(searched, selected, analyticsAs), [searched, selected, analyticsAs]);
  // A selected outcome some session in the window has stays listed at 0, so it can be unticked;
  // one no session has never shows, even when unticking from All selected it.
  const present = useMemo(() => new Set(allSessions.flatMap((r) => r.keys)), [allSessions]);
  const outcomeOptions = useMemo(
    () => OUTCOMES.flatMap((o) => (counts.byOutcome.has(o.key) || (selected?.has(o.key) && present.has(o.key)) ? [{ ...o, count: counts.byOutcome.get(o.key) ?? 0 }] : [])),
    [counts, selected, present],
  );
  const analyticsOptions = useMemo(() => ANALYTICS_OPTIONS.map((o) => ({ ...o, count: counts.byAnalytics.get(o.key) ?? 0 })), [counts]);
  const shown = useMemo(() => searched.filter(({ pairs }) => matchesOutcomes(pairs, selected, analyticsAs)), [searched, selected, analyticsAs]);
  const setAnalytics = (next: string | null) => setSearchParams((p) => {
    if (next) p.set(ANALYTICS_PARAM, next);
    else p.delete(ANALYTICS_PARAM);
    return p;
  });
  const days = useMemo(() => listSessions(shown), [shown]);
  const sessions = useMemo(() => days.flatMap((d) => d.groups.flat().map((r) => r.session)), [days]);
  const session = sessions.find((s) => s.sessionId === searchParams.get(SESSION_PARAM)) ?? sessions[0];
  const setOutcomes = (next: ReadonlySet<string> | null) => setSearchParams((p) => {
    if (next) p.set(OUTCOME_PARAM, [...next].join(','));
    else p.delete(OUTCOME_PARAM);
    return p;
  });

  // The opened step's file: the loaded logs for the main device, else parsed from the added device's archive.
  const panel = useMemo(() => {
    if (!opened) return null;
    const { device, ref } = opened;
    const isMain = device.entries.length === 0;
    return {
      lines: isMain ? rawLogLines : linesOfFile(device, ref.file),
      lineRange: { start: ref.line - PANEL_CONTEXT, end: ref.line + PANEL_CONTEXT },
      highlightLines: { start: ref.line, end: ref.line },
      onExpand: isMain ? () => { void navigate(`/logs?line=${ref.line}`); } : undefined,
    };
  }, [opened, rawLogLines, navigate]);

  const addFiles = (files: FileList | null) => {
    for (const d of droppedDevices(Array.from(files ?? []))) {
      void loadCryptoDevice(d.name, () => deviceFromDroppedFiles(d));
    }
  };
  const demoPeer = loadedEntryNames.length === 1 ? DEMO_PEER[loadedEntryNames[0]] : undefined;
  // Once added, the button asks for a file: the demo peer again would be refused as already open.
  const addDemoPeer = demoPeer && !added.some((d) => d.id === demoPeer)
    ? () => { void loadCryptoDevice(demoPeer, async () => deviceFromFile(demoPeer, await fetchDemoLog(demoPeer))); }
    : undefined;
  // setSearchParams changes identity with every URL change: a ref keeps the list's callback stable.
  const setParams = useRef(setSearchParams);
  useLayoutEffect(() => {
    setParams.current = setSearchParams;
  });
  const select = useCallback((sessionId: string) => setParams.current((p) => {
    p.set(SESSION_PARAM, sessionId);
    return p;
  }), []);

  // Two columns: the sender, and the receiver (see sessionLanes).
  const { sender, receiver, receiverRef } = useMemo(() => (session ? sessionLanes(session, devices, main.id) : {}), [session, devices, main.id]);
  const timeline = useMemo(() => (session ? buildTimeline(session, sender?.id, receiver?.id) : []), [session, sender, receiver]);
  const journey = useMemo(() => (session ? buildJourney(session, sender, receiver) : null), [session, sender, receiver]);
  // Occurrences: the main device's lines are loaded; an added device's archive is parsed on first use, off the click.
  // The asked lane, else the one with a device: an outbound session has no receiver.
  const searchLane = search && ((search.lane === 'sender' ? sender : receiver) ? search.lane : sender ? 'sender' : 'receiver');
  const searchDevice = searchLane === 'sender' ? sender : searchLane === 'receiver' ? receiver : undefined;
  const [parsed, setParsed] = useState<{ device: CryptoDevice; lines: readonly ParsedLogLine[] } | null>(null);
  useEffect(() => {
    if (!searchDevice || searchDevice.entries.length === 0 || allLines.has(searchDevice)) return undefined;
    const t = setTimeout(() => {
      const lines = allLinesOf(searchDevice);
      allLines.set(searchDevice, lines);
      setParsed({ device: searchDevice, lines });
    }, 0);
    return () => clearTimeout(t);
  }, [searchDevice]);
  const linesFor = useCallback(
    (d: CryptoDevice | undefined) => (!d ? undefined : d.entries.length === 0 ? rawLogLines : allLines.get(d) ?? (parsed?.device === d ? parsed.lines : undefined)),
    [rawLogLines, parsed],
  );
  const searchLines = useMemo(() => linesFor(searchDevice), [linesFor, searchDevice]);
  // Each lane's count, with the bottom panel's own matcher: the count is the lines it shows.
  const searchQuery = search?.query;
  const laneCounts = useMemo(() => {
    const countIn = (d: CryptoDevice | undefined) => {
      const lines = searchQuery ? linesFor(d) : undefined;
      return lines && searchQuery ? findMatchingIndices(lines, searchQuery, false, (l) => l.rawText).size : undefined;
    };
    return { sender: countIn(sender), receiver: countIn(receiver) };
  }, [searchQuery, linesFor, sender, receiver]);
  const openLine = useCallback((device: CryptoDevice, ref: LineRef) => setOpened({ device, ref }), [setOpened]);

  return (
    <OpenLine.Provider value={openLine}>
    <div className="app">
      <div className="header-compact">
        <div className="header-left">
          <BurgerMenu />
          <h1 className="header-title">Megolm decryption</h1>
        </div>
        <div className="header-center">
          <SearchInput
            value={query} onChange={setQuery} placeholder="Session, room, user, device, event id…"
            title="Sessions naming this id: session, room, user, device, curve key, event, to-device message" aria-label="Search sessions by id"
          />
        </div>
        <div className="header-right">
          <OutcomeFilterDropdown options={outcomeOptions} allOptions={OUTCOMES} selected={selected} onChange={setOutcomes} />
          {/* Hidden when no device logs timeline handling (older Element X builds). */}
          {canTellAnalytics && (
            <AnalyticsFilterDropdown
              options={analyticsOptions} anyCount={counts.any} value={analyticsAs} onChange={setAnalytics} note={REPORTED_CAVEAT}
            />
          )}
          <TimeRangeSelector />
        </div>
      </div>
      <div className={`content ${styles.pane}`}>
        {pending.length > 0 && <div className={styles.devices}>Loading {pending.join(', ')}…</div>}
        {errors.map((e, i) => <div key={`${e.name}-${i}`} className={styles.notice}>{e.name}: {e.message}</div>)}
        {devices.filter((d) => d.steps.length === 0).map((d) => (
          <div key={d.id} className={`${styles.notice} ${styles.unknown}`}>{d.id}: no crypto activity found</div>
        ))}
        {!session ? (
          <p>No megolm sessions match in the loaded logs for this time range.</p>
        ) : (
          <div className={styles.layout}>
            <SessionList days={days} selectedId={session.sessionId} mainId={main.id} onSelect={select} />
            <div className={styles.main}>
              <div className={styles.detailHeader}>
                Session <code>{session.sessionId}</code>
                <OccurrencesButton query={session.sessionId} onSearch={onSearch} />
                <span className={styles.detailRoom}>{session.roomId ?? 'room ?'}</span>
              </div>
              {journey && <JourneyView journey={journey} roomId={session.roomId} sender={sender} receiver={receiver} onOpen={setOpened} onSearch={onSearch} />}
              <div className={styles.timeline} role="grid" aria-label="Timeline">
                <div role="row" className={`${styles.tlRow} ${styles.tlHead}`}>
                  <div role="columnheader" />
                  <div role="columnheader" />
                  <LaneHeader lane="sender" deviceRef={session.sender} device={sender} session={session} receiver={receiver} mainUserId={main.identity.userId} onAddFiles={addFiles} onAddDemo={addDemoPeer} />
                  <div role="columnheader" />
                  <LaneHeader lane="receiver" deviceRef={receiverRef} device={receiver} session={session} receiver={receiver} mainUserId={main.identity.userId} onAddFiles={addFiles} />
                </div>
                <Timeline key={session.sessionId} rows={timeline} session={session} sender={sender} receiver={receiver} opened={opened} onOpen={setOpened} />
              </div>
            </div>
          </div>
        )}
      </div>
      {opened && panel && (
        <div className={styles.bottomPanel} data-log-panel>
          <div className={styles.panelTitle}>{deviceLabel(opened.device)} · {opened.ref.file}:{opened.ref.line}</div>
          <div className={styles.panelBody}>
            <LogDisplayView
              key={`${opened.device.id}:${opened.ref.file}:${opened.ref.line}`}
              logLines={panel.lines}
              lineRange={panel.lineRange}
              highlightLines={panel.highlightLines}
              defaultLineWrap
              onExpand={panel.onExpand}
              onClose={() => setOpened(null)}
            />
          </div>
        </div>
      )}
      {search && (
        <div className={styles.bottomPanel} data-log-panel>
          <div className={styles.panelTitle}>
            Occurrences of <code>{search.query}</code>
            {(['sender', 'receiver'] as const).filter((lane) => (lane === 'sender' ? sender : receiver)).map((lane) => {
              const n = laneCounts[lane];
              return (
                <button key={lane} type="button" className={`${styles.tab} ${searchLane === lane ? styles.tabActive : ''}`} aria-pressed={searchLane === lane}
                  onClick={() => setSearch((s) => s && { ...s, lane })}>
                  {lane === 'sender' ? 'Sender' : 'Receiver'}{n !== undefined ? ` · ${n}` : ''}
                </button>
              );
            })}
          </div>
          <div className={styles.panelBody}>
            {searchLines ? (
              <LogDisplayView
                key={`${search.query}:${searchLane}`}
                logLines={searchLines}
                requestFilter={search.query}
                defaultLineWrap
                onExpand={searchDevice?.entries.length === 0 ? () => { void navigate(`/logs?filter=${encodeURIComponent(search.query)}`); } : undefined}
                onClose={() => setSearch(null)}
              />
            ) : <div className={styles.loading}>Loading the {searchLane} rageshake…</div>}
          </div>
        </div>
      )}
    </div>
    </OpenLine.Provider>
  );
}

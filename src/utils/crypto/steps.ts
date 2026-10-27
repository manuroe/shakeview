/**
 * The step table: one row per lifecycle step of a megolm session (and the Olm
 * channel below it), matched against log wording from matrix-rust-sdk (Element
 * X, and crypto-wasm on Element Web) and matrix-js-sdk (Element Web).
 *
 * Wording that differs between SDK versions or platforms costs one extra row
 * with the same `kind`. First matching row wins.
 */
import type { ParsedLogLine } from '../../types/log.types';
import { classifyUtd, withheldCode } from './classifyUtd';
import {
  curveKey, field, fieldIn, intField, parseMessageList, parseRecipients, spanField, stringsAtDepth,
} from './fields';
import type { CryptoStep, StepKeys, StepKind, StepRole } from './types';

interface StepRule {
  readonly kind: StepKind;
  readonly role: StepRole;
  /** Tested against `ParsedLogLine.message` (the first physical line). */
  readonly match: RegExp;
  /** Extra guard when the wording alone is too broad. */
  readonly when?: (line: ParsedLogLine) => boolean;
  readonly extract?: (line: ParsedLogLine, m: RegExpExecArray) => StepKeys;
}

const sid = (l: ParsedLogLine) => field(l, 'session_id');
const room = (l: ParsedLogLine) => field(l, 'room_id');
/** Debug-printed structs (`session_id: "…"`), not `key=value`. */
const debugField = (l: ParsedLogLine, key: string) => new RegExp(`${key}: "([^"]+)"`).exec(l.rawText)?.[1];

/** History sharing on the inviter: Rust `share_room_history{room_id user_id}`, js-sdk `[shareRoomHistoryWithUser(<room>, <user>)]`. */
function historyKeys(l: ParsedLogLine): StepKeys {
  const js = /shareRoomHistoryWithUser\((\S+), (\S+?)\)/.exec(l.message);
  return { roomId: spanField(l, 'share_room_history', 'room_id') ?? js?.[1], userId: spanField(l, 'share_room_history', 'user_id') ?? js?.[2] };
}

/** origin_server_ts as ISO (`"2026-01-16T17:05:40.792Z"`) or epoch ms (`MilliSecondsSinceUnixEpoch(…)`), in µs. */
function eventTime(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const ms = /^\D*(\d{12,})\D*$/.test(v) ? Number(/(\d{12,})/.exec(v)![1]) : Date.parse(v);
  return Number.isNaN(ms) ? undefined : ms * 1000;
}

function utdKeys(error: string): StepKeys {
  return { error, reason: classifyUtd(error), withheldCode: withheldCode(error) };
}

const STEP_TABLE: readonly StepRule[] = [
  // ── Receiver: room events ────────────────────────────────────────────────
  {
    kind: 'event.utd', role: 'receiver',
    match: /Failed to decrypt a room event: (.*?)(?: \| |$)/,
    extract: (l, m) => ({
      ...utdKeys(m[1]),
      eventId: spanField(l, 'decrypt_room_event', 'event_id'),
      roomId: spanField(l, 'decrypt_room_event', 'room_id'),
      sessionId: spanField(l, 'decrypt_room_event', 'session_id'),
      messageIndex: intField(spanField(l, 'decrypt_room_event', 'message_index')),
      senderKey: curveKey(spanField(l, 'decrypt_room_event', 'sender_key')),
      userId: spanField(l, 'decrypt_room_event', 'sender'),
      eventTs: eventTime(spanField(l, 'decrypt_room_event', 'origin_server_ts')),
    }),
  },
  {
    kind: 'event.utd', role: 'receiver',
    match: /Error decrypting event \(id=(\S+) .*?sender=(\S+) room=(\S+) (?:ts=(\S+?)|.*?)\): DecryptionError\[msg: (.*), sender_key: ([^,\]]+), session_id: ([^\]]+)\]/,
    extract: (_l, m) => ({
      ...utdKeys(m[5]), eventId: m[1], userId: m[2], roomId: m[3], eventTs: eventTime(m[4]), senderKey: curveKey(m[6]), sessionId: m[7],
    }),
  },
  {
    kind: 'event.redecrypted', role: 'receiver',
    match: /Decrypted event on retry \(id=(\S+)/,
    extract: (_l, m) => ({ eventId: m[1] }),
  },
  {
    kind: 'event.redecrypted', role: 'receiver',
    match: /Successfully redecrypted events event_ids=\{([^}]*)\}/,
    extract: (_l, m) => ({ eventIds: [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) }),
  },
  {
    kind: 'timeline.handled', role: 'receiver',
    match: /Handling remote event/,
    extract: (l) => ({ eventId: spanField(l, 'handle_event', 'event_id') }),
  },
  {
    kind: 'utd.reported', role: 'receiver',
    match: /onUtd for event (\S+), timeToDecryptMs: (\d+|null)/,
    extract: (_l, m) => ({ eventId: m[1], timeToDecryptMs: m[2] === 'null' ? -1 : Number(m[2]) }),
  },
  // The Rust event cache's redecryptor: when it gets to a new key (it works through one batch at
  // a time, so this can lag the key's arrival), and when a timeline asks it to retry UTD sessions.
  {
    kind: 'redecrypt.keys', role: 'receiver',
    match: /Received new room keys room_keys=\[/,
    extract: (l) => ({ sessionIds: [...l.message.matchAll(/session_id: "([^"]+)"/g)].map((x) => x[1]) }),
  },
  {
    kind: 'redecrypt.request', role: 'receiver',
    match: /Received a redecryption request request=DecryptionRetryRequest \{ room_id: "([^"]+)", utd_session_ids: \{([^}]*)\}/,
    extract: (_l, m) => ({ roomId: m[1], sessionIds: [...m[2].matchAll(/"([^"]+)"/g)].map((x) => x[1]) }),
  },
  {
    kind: 'redecrypt.failed', role: 'receiver',
    match: /Failed to redecrypt an event despite receiving a room key/,
    extract: (l) => ({ sessionId: sid(l), roomId: room(l), eventId: field(l, 'event_id') }),
  },
  // ── Receiver: keys arriving ──────────────────────────────────────────────
  {
    kind: 'roomkey.received', role: 'receiver',
    // Upgrading "with new sender data" changes no ratchet, so it is left out; discards are not keys gained.
    match: /Received a new megolm room key|Received a megolm room key that we have a worse version of, merging|Upgrading a previously-received megolm session with new ratchet/,
    extract: (l) => ({
      sessionId: spanField(l, 'handle_key', 'session_id') ?? sid(l),
      roomId: spanField(l, 'handle_key', 'room_id') ?? room(l),
      firstKnownIndex: intField(spanField(l, 'handle_key', 'message_index')),
      toDeviceType: spanField(l, 'handle_decrypted_to_device_event', 'event_type'),
      senderKey: curveKey(spanField(l, 'handle_decrypted_to_device_event', 'sender_key')),
      // The to-device sender: the session's owner for m.room_key, the forwarder for a forwarded key.
      userId: spanField(l, 'receive_to_device_event', 'sender'),
    }),
  },
  {
    kind: 'bundle.received', role: 'receiver',
    match: /Received a room key bundle event|Received a historic room key bundle/,
    // The room is in the bundle content (`RoomKeyBundleContent { room_id: "…" }`); the inviter is the to-device sender.
    extract: (l) => ({
      roomId: debugField(l, 'room_id') ?? room(l),
      userId: spanField(l, 'receive_to_device_event', 'sender') ?? debugField(l, 'sender'),
    }),
  },
  {
    // Joining on this device: the moment "sent before we joined" is measured against.
    kind: 'room.joined', role: 'either',
    match: /Completing room join/,
    extract: (l) => ({ roomId: room(l) }),
  },
  {
    kind: 'bundle.missing', role: 'receiver',
    match: /No room key bundle from inviter found/,
    extract: (l) => ({
      roomId: spanField(l, 'maybe_accept_key_bundle', 'room_id') ?? room(l),
      userId: spanField(l, 'maybe_accept_key_bundle', 'inviter'),
    }),
  },
  {
    kind: 'bundle.rejected', role: 'receiver',
    match: /Received a room key bundle with no sender device keys|Received a completely empty room key bundle|Ignoring key for incorrect room \S+ in bundle/,
    extract: (l, m) => ({ roomId: room(l), error: m[0] }),
  },
  {
    kind: 'withheld.received', role: 'receiver',
    match: /Processing `m\.room_key\.withheld` event/,
    // m.no_olm names no session, only the sender key: `MegolmV1AesSha2(NoOlm(NoOlmWithheldContent { sender_key: … }))`.
    extract: (l) => ({
      sessionId: debugField(l, 'session_id'),
      roomId: debugField(l, 'room_id'),
      senderKey: curveKey(debugField(l, 'sender_key')),
      withheldCode: /code: "?([\w.]+)/.exec(l.rawText)?.[1] ?? /MegolmV1AesSha2\((\w+)\(/.exec(l.rawText)?.[1],
    }),
  },
  {
    kind: 'backup.download', role: 'receiver',
    match: /Performing backup download/,
    extract: (l) => ({ sessionId: debugField(l, 'session_id') ?? sid(l), roomId: debugField(l, 'room_id') }),
  },
  {
    kind: 'backup.download', role: 'receiver',
    match: /\[PerSessionKeyBackupDownloader\] (Checking key backup for session |Got key from backup for sessionId:|No luck requesting key backup for session )([A-Za-z0-9+/]+)/,
    extract: (_l, m) => ({
      sessionId: m[2],
      ok: m[1].startsWith('Got') ? true : m[1].startsWith('No luck') ? false : undefined,
    }),
  },
  {
    // Element X: the per-session lookup is a plain `GET /room_keys/keys/<room>/<session>`; 404 = not in backup.
    kind: 'backup.download', role: 'receiver',
    match: /Got response|Error while sending request/,
    when: (l) => /method=GET uri="[^"]*\/room_keys\/keys\/[^/"]+\/[^/"?]+/.test(l.message),
    extract: (l) => {
      const [roomId, sessionId] = /\/room_keys\/keys\/([^/"]+)\/([^/"?]+)/.exec(l.message)!.slice(1).map(decodeURIComponent);
      const status = fieldIn(l.message, 'status');
      return { roomId, sessionId, ok: status === '200' ? true : status === '404' ? false : undefined };
    },
  },
  // Device key backup state: Rust backups/recovery, Element X iOS recovery, js-sdk RustBackupManager.
  {
    kind: 'backup.state', role: 'receiver',
    match: /Backup state changed from \S+ to (\w+)/,
    extract: (_l, m) => ({ backupState: m[1].toLowerCase() }),
  },
  {
    kind: 'backup.state', role: 'receiver',
    match: /Recovery state changed (?:from \S+ )?to:? (\w+)/,
    extract: (_l, m) => ({ backupState: `recovery-${m[1].toLowerCase()}` }),
  },
  {
    kind: 'backup.state', role: 'receiver',
    match: /Found usable key backup v(\S+): enabling|Backup version (\S+) still current/,
    extract: (_l, m) => ({ backupState: 'enabled', backupVersion: m[1] ?? m[2] }),
  },
  {
    kind: 'backup.state', role: 'receiver',
    match: /No key backup present on server|no backup version was found on the server/,
    extract: () => ({ backupState: 'none' }),
  },
  {
    kind: 'backup.state', role: 'receiver',
    match: /Key backup present on server but not trusted/,
    extract: () => ({ backupState: 'untrusted' }),
  },
  {
    kind: 'backup.broken', role: 'receiver',
    match: /Failed to decrypt megolm session from backup|Couldn't automatically download all room keys from backup/,
  },
  {
    kind: 'backup.imported', role: 'receiver',
    match: /Successfully imported room keys/,
    extract: (l) => ({ sessionIds: stringsAtDepth(field(l, 'room_keys'), 3) }),
  },
  // ── Receiver: to-device and Olm ──────────────────────────────────────────
  {
    kind: 'todevice.received', role: 'receiver',
    match: /Received a to-device event/,
    extract: (l) => ({
      messageId: spanField(l, 'receive_to_device_event', 'message_id'),
      userId: spanField(l, 'receive_to_device_event', 'sender'),
      toDeviceType: spanField(l, 'receive_to_device_event', 'event_type'),
    }),
  },
  {
    kind: 'olm.decrypt_failed', role: 'receiver',
    match: /Failed to decrypt a (?:non-)?pre-key message|Failed to create a new Olm session from a pre-key message|An Olm message got replayed/,
    extract: (l) => ({
      senderKey: curveKey(spanField(l, 'decrypt_olm_v1', 'sender_key') ?? field(l, 'sender_key')),
      userId: spanField(l, 'decrypt_olm_v1', 'sender'),
      messageId: spanField(l, 'receive_to_device_event', 'message_id'),
    }),
  },
  {
    kind: 'olm.unwedge', role: 'receiver',
    match: /Marking session to be unwedged/,
    extract: (l) => ({ senderKey: curveKey(field(l, 'sender_key')) }),
  },
  {
    kind: 'olm.claim', role: 'either',
    match: /Received a `\/keys\/claim` response|Error creating Olm session|Can't establish an Olm session/,
    // `error` only on a failure: why this device gets no Olm session, so no room key.
    extract: (l) => ({ userId: field(l, 'user_id'), deviceId: field(l, 'device_id'), error: field(l, 'error') }),
  },
  {
    kind: 'keyrequest.served', role: 'either',
    match: /Serving a room key request/,
    extract: (l) => ({
      userId: spanField(l, 'handle_supported_key_request', 'user_id'),
      deviceId: spanField(l, 'handle_supported_key_request', 'device_id'),
      sessionId: spanField(l, 'handle_supported_key_request', 'session_id'),
      roomId: spanField(l, 'handle_supported_key_request', 'room_id'),
    }),
  },
  // ── Sender ───────────────────────────────────────────────────────────────
  {
    kind: 'history.not_shared', role: 'sender',
    match: /Not sharing message history as (.+?)(?: \||$)|No keys to share/,
    extract: (l, m) => ({ ...historyKeys(l), error: m[1] ?? 'no keys to share' }),
  },
  {
    kind: 'history.uploaded', role: 'sender',
    match: /Uploaded encrypted key blob/,
    extract: (l) => ({ ...historyKeys(l), count: intField(field(l, 'shared_keys')), withheldCount: intField(field(l, 'withheld_keys')) }),
  },
  {
    kind: 'history.shared', role: 'sender',
    match: /Sharing message history/,
    extract: historyKeys,
  },
  {
    kind: 'session.rotate', role: 'sender',
    match: /Rotating (?:the |a )?room key/,
    extract: (l) => ({ sessionId: sid(l), roomId: room(l) }),
  },
  {
    kind: 'share.encrypt', role: 'sender',
    match: /Trying to encrypt a room key/,
    extract: (l) => ({
      sessionId: sid(l),
      roomId: room(l),
      messageIndex: intField(field(l, 'message_index')),
      recipients: parseRecipients(field(l, 'recipients')),
      transactionId: spanField(l, 'send_raw', 'transaction_id'),
    }),
  },
  {
    kind: 'todevice.batch', role: 'sender',
    match: /Created batch of to-device messages of type (\S+)/,
    extract: (l, m) => ({
      sessionId: sid(l),
      requestId: field(l, 'request_id'),
      toDeviceType: m[1],
      messages: parseMessageList(field(l, 'message_list')),
      transactionId: spanField(l, 'send_raw', 'transaction_id'),
    }),
  },
  {
    kind: 'todevice.http', role: 'sender',
    match: /Got response|Error while sending request/,
    when: (l) => l.message.includes('/sendToDevice/'),
    extract: (l) => ({
      requestId: /\/sendToDevice\/[^/]+\/([^"?\s]+)/.exec(l.message)?.[1],
      status: fieldIn(l.message, 'status'),
    }),
  },
  {
    kind: 'todevice.http', role: 'sender',
    match: /<-- PUT \S*\/sendToDevice\/[^/]+\/(\S+) \[\S+ (\d{3})/,
    extract: (_l, m) => ({ requestId: m[1], status: m[2] }),
  },
  {
    kind: 'todevice.sent', role: 'sender',
    match: /Marking to-device request carrying a room key or a withheld as sent|marking session as shared/,
    extract: (l) => ({ requestId: field(l, 'request_id'), sessionId: sid(l), roomId: room(l) }),
  },
  {
    kind: 'event.sent', role: 'sender',
    match: /Sent event in room/,
    extract: (l) => ({
      eventId: spanField(l, 'send_raw', 'event_id'),
      transactionId: spanField(l, 'send_raw', 'transaction_id'),
      roomId: spanField(l, 'send_raw', 'room_id'),
    }),
  },
  {
    kind: 'event.sent', role: 'sender',
    match: /Event sent to (\S+) with event id (\S+)/,
    extract: (_l, m) => ({ roomId: m[1], eventId: m[2] }),
  },
  {
    kind: 'backup.upload', role: 'sender',
    match: /Successfully created a room keys backup request/,
    extract: (l) => ({ sessionIds: stringsAtDepth(field(l, 'keys'), 3) }),
  },
];

/**
 * Every row's wording in one regex: most lines are not crypto, and one test
 * rejects them where trying each row's regex in turn cost twice the time.
 */
const ANY_ROW = new RegExp(STEP_TABLE.map((r) => r.match.source).join('|'));

/** Drop `undefined` values so `toMatchObject`/spreads stay clean. */
function compact(keys: StepKeys): StepKeys {
  return Object.fromEntries(Object.entries(keys).filter(([, v]) => v !== undefined)) as StepKeys;
}

/**
 * Turn log lines into crypto steps: the one place log wording is read, so every
 * crypto view works on typed steps. A line yields at most one step.
 * `source.file` is used for lines that carry no `sourceFile` (single-file parse).
 *
 * @example
 * const [step] = extractSteps(parseLogFile(text).rawLogLines, { archive: 'bob.tar.gz', file: 'logs.log' });
 * step.kind; // 'event.utd'
 * step.keys.reason; // 'missing_key'
 */
export function extractSteps(
  lines: readonly ParsedLogLine[],
  source: { readonly archive: string; readonly file: string },
): CryptoStep[] {
  const steps: CryptoStep[] = [];
  for (const line of lines) {
    if (!ANY_ROW.test(line.message)) continue;
    for (const row of STEP_TABLE) {
      const m = row.match.exec(line.message);
      if (!m || (row.when && !row.when(line))) continue;
      steps.push({
        kind: row.kind,
        role: row.role,
        ts: line.timestampUs,
        line: { archive: source.archive, file: line.sourceFile ?? source.file, line: line.lineNumber },
        text: line.strippedMessage.split(' | ')[0].slice(0, 300),
        keys: compact(row.extract?.(line, m) ?? {}),
      });
      break;
    }
  }
  return steps;
}

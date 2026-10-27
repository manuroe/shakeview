/**
 * Types for the megolm decryption model: crypto steps extracted from log lines,
 * devices (one per rageshake), and every megolm session built across devices,
 * with its UTD (Unable To Decrypt) events when some failed.
 */
import type { TimestampMicros } from '../../types/time.types';
import type { ArchiveEntry } from '../../stores/archiveStore';

/** Which role a step implies for its megolm session. */
export type StepRole = 'sender' | 'receiver' | 'either';

/** What one log line says happened to a megolm session or its Olm channel: one per step table row kind. */
export type StepKind =
  | 'session.rotate'
  | 'share.encrypt'
  | 'todevice.batch'
  | 'todevice.http'
  | 'todevice.sent'
  | 'event.sent'
  | 'backup.upload'
  | 'olm.claim'
  | 'todevice.received'
  | 'olm.decrypt_failed'
  | 'olm.unwedge'
  | 'roomkey.received'
  | 'bundle.received'
  | 'bundle.missing'
  | 'bundle.rejected'
  | 'history.shared'
  | 'history.uploaded'
  | 'history.not_shared'
  | 'room.joined'
  | 'backup.state'
  | 'backup.broken'
  | 'withheld.received'
  | 'backup.download'
  | 'backup.imported'
  | 'keyrequest.served'
  | 'event.utd'
  | 'event.redecrypted'
  | 'redecrypt.failed'
  | 'timeline.handled'
  | 'utd.reported'
  | 'redecrypt.keys'
  | 'redecrypt.request';

/** Why an event failed to decrypt, coarse enough to count and to pick a journey for. */
export type UtdReason = 'missing_key' | 'unknown_index' | 'trust_requirement' | 'invalid_payload' | 'other';

/** How a UTD's key finally arrived; `unknown` when only the re-decryption is logged. */
export type ResolutionMechanism = 'late_key' | 'forwarded_key' | 'backup' | 'import' | 'history_bundle' | 'unknown';

/** Where a step was logged, so a view can open its log line. `line` is the line number inside `file` (deep-link target). */
export interface LineRef {
  readonly archive: string;
  readonly file: string;
  readonly line: number;
}

/** One entry of a to-device batch: the msgid sent to one device, joined to the receiver's logs by that id. */
export interface ToDeviceMessage {
  readonly messageId: string;
  readonly userId: string;
  readonly deviceId: string;
}

/** Whatever identifiers a step's line carries, so steps of different devices can be joined. All optional. */
export interface StepKeys {
  readonly sessionId?: string;
  /** Key imports and backup uploads cover many sessions at once. */
  readonly sessionIds?: readonly string[];
  readonly roomId?: string;
  readonly eventId?: string;
  /** Events re-decrypted together (Rust redecryptor batch). */
  readonly eventIds?: readonly string[];
  /** Message index of a room event (UTD) or of an outbound session (share). */
  readonly messageIndex?: number;
  /** First known index of a received room key (`handle_key{message_index}`). */
  readonly firstKnownIndex?: number;
  /** Curve25519 key, raw base64, no `curve25519:` prefix. */
  readonly senderKey?: string;
  readonly userId?: string;
  readonly deviceId?: string;
  /** To-device `message_id` of a received to-device event. */
  readonly messageId?: string;
  /** Messages of a to-device batch. */
  readonly messages?: readonly ToDeviceMessage[];
  /** To-device batch id, equal to the `/sendToDevice` txn. */
  readonly requestId?: string;
  /** `send_raw{transaction_id}`: links a sent event to its session's share steps. */
  readonly transactionId?: string;
  /** `m.room_key`, `m.forwarded_room_key`, `m.room.encrypted`, … */
  readonly toDeviceType?: string;
  readonly recipients?: readonly (readonly [string, string])[];
  readonly withheldCode?: string;
  /** HTTP status of a `/sendToDevice` response. */
  readonly status?: string;
  /** Backup lookup outcome: true = key found, false = not found, undefined = request only. */
  readonly ok?: boolean;
  /** Raw failure text of a UTD; why history was not shared or a bundle rejected. */
  readonly error?: string;
  /** Keys in an uploaded history blob, and how many of them withheld. */
  readonly count?: number;
  readonly withheldCount?: number;
  /** When a failed event was sent (its origin_server_ts), µs. */
  readonly eventTs?: number;
  /** Device key backup: enabled, disabled, none, untrusted, or `recovery-<state>` (recovery as a proxy). */
  readonly backupState?: string;
  readonly backupVersion?: string;
  readonly reason?: UtdReason;
  /** What the app sent to UTD analytics; -1 for a definite UTD. */
  readonly timeToDecryptMs?: number;
}

/** One typed fact taken from one log line: the unit every crypto view is built from. */
export interface CryptoStep {
  readonly kind: StepKind;
  readonly role: StepRole;
  readonly ts: TimestampMicros;
  readonly line: LineRef;
  /** The line's message, without timestamp/level and without the ` | file | spans` tail. */
  readonly text: string;
  readonly keys: StepKeys;
}

/** Who a rageshake's device is, so sessions can tell sender from receiver across rageshakes. */
export interface DeviceIdentity {
  readonly userId?: string;
  readonly deviceId?: string;
  /** Curve25519 identity key, raw base64. Only `details.json` carries it. */
  readonly curveKey?: string;
}

/** Time span one log file covers, so a view can tell "not logged" from "not in these logs". */
export interface DeviceCoverage {
  readonly start: TimestampMicros;
  readonly end: TimestampMicros;
}

/** One rageshake (or one bare log file) = one device. */
export interface CryptoDevice {
  /** Unique within the crypto store: the name of the archive (or file) it was loaded from. */
  readonly id: string;
  /** Raw archive entries, kept so /logs can re-open a step's file without a download. Empty for logs already in logStore. */
  readonly entries: readonly ArchiveEntry[];
  readonly identity: DeviceIdentity;
  /** Sorted by `ts`. */
  readonly steps: readonly CryptoStep[];
  readonly coverage: readonly DeviceCoverage[];
}

/** A device as it appears in a session: loaded (has an archive), seen (named in recipients) or unknown. */
export interface DeviceRef {
  readonly key: string;
  readonly loadedId?: string;
  readonly userId?: string;
  readonly deviceId?: string;
  readonly senderKey?: string;
}

/** Whether a UTD event was decrypted later in the logs, how, and on what evidence. */
export type UtdResolution =
  | { readonly state: 'unresolved' }
  | {
      readonly state: 'resolved';
      readonly by: ResolutionMechanism;
      /** When the key arrived (the re-decryption when no key step is logged). */
      readonly at: TimestampMicros;
      /** When the device logged the event's re-decryption, after the key. */
      readonly decryptedAt?: TimestampMicros;
      /** µs from first failure to decryption: to `decryptedAt` when logged, else to `at`. */
      readonly delay: number;
      /** True only when the device logged a successful re-decryption of this event. */
      readonly confirmed: boolean;
      readonly evidence: readonly LineRef[];
    };

/** Did the app send the event to its UTD analytics; `unknown` when the logs can't tell. */
export type AnalyticsCategory = 'reported' | 'not_reported' | 'unknown';

/**
 * Whether the app's UTD analytics received an event: Element X (matrix-sdk-ui
 * `UtdHookManager` and the FFI's 4 s filter) or Element Web (`DecryptionFailureTracker`).
 */
export interface UtdAnalytics {
  readonly category: AnalyticsCategory;
  /** The app's own report line, when it logs one (Element X Android). */
  readonly logged?: LineRef;
  /** Why not reported, or unknown. */
  readonly why?: string;
}

/** One UTD event on one device, de-duplicated across retries. */
export interface UtdEvent {
  readonly deviceId: string;
  readonly eventId: string;
  readonly firstFailedAt: TimestampMicros;
  readonly attempts: number;
  readonly messageIndex?: number;
  /** When the event was sent (origin_server_ts), when the failure line says. */
  readonly eventTs?: number;
  readonly reason: UtdReason;
  readonly error: string;
  readonly steps: readonly CryptoStep[];
  readonly resolution: UtdResolution;
  /** Set when a usable key arrived but the event still failed afterwards. */
  readonly keyArrivedButFailed?: LineRef;
  readonly analytics: UtdAnalytics;
}

/** One to-device message from the sender's batch, joined to what the receiver logged. */
export interface ToDeviceLink extends ToDeviceMessage {
  readonly batch: CryptoStep;
  readonly http?: CryptoStep;
  /** Loaded device the message was addressed to, when one matches. */
  readonly receiverId?: string;
  readonly received?: CryptoStep;
  /** µs from batch to receipt; negative means the two device clocks disagree. */
  readonly latency?: number;
}

/** One megolm session as every loaded device saw it: what /decryption lists, with its UTDs when some failed. */
/** How a session's sender was found: a share it logged, its curve key, the user's choice, or not at all. */
export type SenderSource = 'share' | 'curve_key' | 'override' | 'unknown';

export interface MegolmSession {
  readonly sessionId: string;
  readonly roomId?: string;
  readonly senderKey?: string;
  readonly sender: DeviceRef;
  readonly senderSource: SenderSource;
  /** Loaded receivers first (by first activity), then seen-only devices from the sender's recipients. */
  readonly receivers: readonly DeviceRef[];
  /** Steps per loaded device id, sorted by ts. */
  readonly stepsByDevice: Readonly<Record<string, readonly CryptoStep[]>>;
  readonly utds: readonly UtdEvent[];
  readonly deliveries: readonly ToDeviceLink[];
}

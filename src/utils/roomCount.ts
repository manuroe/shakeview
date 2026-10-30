/**
 * How many rooms a rageshake's user is in, for the user header, and how many the logs mention.
 * Only Element X iOS logs the first (its room lists' sizes); the second, a lower bound of it,
 * tells how much of the user's rooms the rageshake covers.
 *
 * @example
 * roomCount([roomsInLog(lines)]); // { listed: 317, seen: 42 }
 */
import { MATRIX_IDENTIFIER_RE } from './anonymizeUtils';

/** What one log says about its user's rooms; files of an archive merge with `roomCount`. */
export interface RoomsInLog {
  /** Distinct room IDs the lines mention. */
  readonly seenIds: readonly string[];
  /** Element X iOS's own counts: each room list's last size, and when it was logged. */
  readonly lists: Readonly<Record<string, { readonly count: number; readonly ts: number }>>;
}

/** The rooms counts the header shows. */
export interface RoomCount {
  /** The app's room list size, last logged: the rooms the user is in. `null` when no log has it. */
  readonly listed: number | null;
  /** Distinct rooms the logs mention. */
  readonly seen: number;
}

// RoomSummaryProvider.swift: "\(name): Rebuilding room summaries for \(rooms.count) rooms". The lists
// are AllRooms, AlternateAllRooms and StaticAllRooms; the static one is unfiltered and unpaged.
const ROOM_LIST_RE = /(\w*AllRooms): Rebuilding room summaries for (\d+) rooms/;

/** A matched identifier as a plain room ID, percent-decoding `%21…%3A…` (even double-encoded); `null` for any other ID. */
function asRoomId(id: string): string | null {
  let s = id;
  for (let i = 0; i < 3 && s.includes('%'); i++) {
    try {
      s = decodeURIComponent(s);
    } catch {
      return null;
    }
  }
  return s.startsWith('!') ? s : null;
}

/**
 * The rooms one log mentions, and each of Element X iOS's room lists' last size.
 *
 * @example roomsInLog(lines) // { seenIds: ['!room1:example.org'], lists: { StaticAllRooms: { count: 42, ts: 1768471200000000 } } }
 */
export function roomsInLog(lines: readonly { readonly rawText: string; readonly timestampUs: number }[]): RoomsInLog {
  const ids = new Set<string>();
  const lists: Record<string, { count: number; ts: number }> = {};
  for (const { rawText, timestampUs } of lines) {
    // Cheap test first: the regex's leading `\w*` retries at every position of every line.
    const list = rawText.includes('Rebuilding room summaries') ? ROOM_LIST_RE.exec(rawText) : null;
    if (list) lists[list[1]] = { count: Number(list[2]), ts: timestampUs };
    // Most lines name no room: skip the identifier regex for them.
    if (!rawText.includes('!') && !rawText.includes('%')) continue;
    for (const id of rawText.match(MATRIX_IDENTIFIER_RE) ?? []) {
      const room = asRoomId(id);
      if (room) ids.add(room);
    }
  }
  return { seenIds: [...ids], lists };
}

/**
 * The header's rooms counts over one or more logs: Element X iOS's room list size, the largest of
 * each list's last count across the logs (a filtered list holds fewer rooms than the user is in),
 * and the distinct rooms mentioned; `null` when the logs have neither.
 *
 * @example roomCount([roomsInLog(older), roomsInLog(newer)]) // { listed: null, seen: 7 }
 */
export function roomCount(logs: readonly RoomsInLog[]): RoomCount | null {
  const last = new Map<string, { count: number; ts: number }>();
  for (const { lists } of logs) {
    for (const [name, l] of Object.entries(lists)) {
      const prev = last.get(name);
      if (!prev || l.ts >= prev.ts) last.set(name, l);
    }
  }
  const listed = last.size > 0 ? Math.max(...[...last.values()].map((l) => l.count)) : null;
  const seen = new Set(logs.flatMap((l) => l.seenIds)).size;
  return listed !== null || seen > 0 ? { listed, seen } : null;
}

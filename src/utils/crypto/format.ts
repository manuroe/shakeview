/** Formatters shared by the crypto views: durations, UTC times, counts, ids, homeserver domains, resolution mechanisms. */
import type { ResolutionMechanism } from './types';

/**
 * The homeserver of a Matrix user id: whether sender and receiver federate.
 *
 * @example domainOf('@a:matrix.org') // 'matrix.org'
 */
export const domainOf = (userId: string | undefined) => userId?.split(':').slice(1).join(':');

/**
 * A µs duration, short enough for a step row: ms under a second, one decimal under a minute, then two units.
 *
 * @example formatUs(150_000_000) // '2m 30s'
 * @example formatUs(119_600_000) // '1m 59s'
 * @example formatUs(59_960_000) // '1m 0s'
 */
export function formatUs(us: number): string {
  // Rounded before the unit is picked, so rounding carries into the next unit: 999.6 ms is 1.0s, 59.96 s is 1m 0s.
  const ms = Math.round(us / 1000);
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.round(us / 100_000) / 10;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  // Floored, not rounded: 119.6 s is 1m 59s, never 1m 60s.
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.floor(sec % 60)}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

const UTC_PARTS = { day: [0, 10], clock: [11, 23], dateTime: [0, 19] } as const;

/**
 * A µs timestamp as UTC text, like every time in the app: `day` splits lists,
 * `clock` (with ms) tells apart steps logged in the same second, `dateTime` dates an event.
 *
 * @example utcText(1_768_471_201_620_000, 'clock') // '10:00:01.620'
 * @example utcText(1_768_471_201_620_000, 'dateTime') // '2026-01-15 10:00:01'
 */
export function utcText(us: number, part: keyof typeof UTC_PARTS): string {
  const [from, to] = UTC_PARTS[part];
  return new Date(us / 1000).toISOString().slice(from, to).replace('T', ' ');
}

/**
 * A count with its noun, singular for one: the journey and step descriptions count shares, keys and events.
 *
 * @example plural(2, 'device') // '2 devices'
 */
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * A long id (event, request, to-device message) cut to its start; the full line is in the log panel.
 *
 * @example short('$abcdefghijklmnop') // '$abcdefghijk…'
 */
export const short = (id: string) => (id.length > 14 ? `${id.slice(0, 12)}…` : id);

/**
 * A resolution mechanism in words, for verdicts and event lines.
 *
 * @example mechanismLabel('backup') // 'key backup'
 */
export function mechanismLabel(by: ResolutionMechanism): string {
  switch (by) {
    case 'backup': return 'key backup';
    case 'import': return 'key import';
    case 'unknown': return 'unknown means';
    default: return by.replace('_', ' ');
  }
}

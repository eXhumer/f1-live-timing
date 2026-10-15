/**
 * Time parsing for live timing values.
 *
 * Timestamps are carried as UTC epoch milliseconds (`number`). F1 sends up to
 * seven fractional digits (`2026-10-11T12:27:02.0694725Z`); `Date.parse` keeps
 * only milliseconds, so the sub-millisecond part is added back as a fraction.
 */

const UTC_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z?$/;

/**
 * Parse an F1 UTC timestamp into epoch milliseconds.
 *
 * Accepts any number of fractional digits, with or without the trailing `Z`
 * (archive `Utc` fields such as `0001-01-01T00:00:00` omit it).
 *
 * @throws {TypeError} if the string is not a timestamp.
 */
export function parseUtc(value: string): number {
  const m = UTC_RE.exec(value);
  if (!m) throw new TypeError(`Invalid UTC timestamp: ${value}`);
  const [, y, mo, d, h, mi, s, frac = ''] = m;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  return frac ? ms + Number(`0.${frac}`) * 1000 : ms;
}

/** Format epoch milliseconds as an ISO UTC string with millisecond precision. */
export function formatUtc(ms: number): string {
  return new Date(Math.floor(ms)).toISOString();
}

const OFFSET_RE = /^(\d{2,}):(\d{2}):(\d{2})\.(\d{3})$/;

/**
 * Parse an archive stream offset (`HH:MM:SS.mmm`) into milliseconds.
 *
 * @throws {TypeError} if the string is not an offset.
 */
export function parseOffset(value: string): number {
  const m = OFFSET_RE.exec(value);
  if (!m) throw new TypeError(`Invalid stream offset: ${value}`);
  const [, h, mi, s, ms] = m;
  return ((Number(h) * 60 + Number(mi)) * 60 + Number(s)) * 1000 + Number(ms);
}

/** Format milliseconds as an archive stream offset (`HH:MM:SS.mmm`). */
export function formatOffset(ms: number): string {
  const total = Math.max(0, Math.floor(ms));
  const h = Math.floor(total / 3_600_000);
  const mi = Math.floor(total / 60_000) % 60;
  const s = Math.floor(total / 1000) % 60;
  const milli = total % 1000;
  return `${pad(h, 2)}:${pad(mi, 2)}:${pad(s, 2)}.${pad(milli, 3)}`;
}

const DURATION_RE = /^(?:(?:(\d+):)?(\d+):)?(\d+)(?:\.(\d+))?$/;

/**
 * Parse a lap time or clock duration into milliseconds.
 *
 * Handles `1:36.224` (lap time), `01:59:57` (`ExtrapolatedClock.Remaining`),
 * `28.631` (sector time) and `0:00:42.123`. Returns `null` for empty or
 * non-time values such as `""` or `"LAP 1"`.
 */
export function parseDuration(value: string): number | null {
  const m = DURATION_RE.exec(value.trim());
  if (!m) return null;
  const [, h = '0', mi = '0', s, frac = ''] = m;
  const fraction = frac ? Number(`0.${frac}`) * 1000 : 0;
  return ((Number(h) * 60 + Number(mi)) * 60 + Number(s)) * 1000 + fraction;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/**
 * Which unit an elapsed time reads best in. Locale-free: the wording is `Intl`'s, through
 * `useLocalFormat`, so this decides only *what* to say and every language gets it for free.
 *
 * One rule for the whole app: every relative time goes through here.
 */
type ElapsedUnit = 'second' | 'minute' | 'hour' | 'day' | 'month' | 'year';

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/** The coarsest unit that still says something, and how many of it. `seconds` may be negative. */
export function elapsed(seconds: number): { value: number; unit: ElapsedUnit } {
  const abs = Math.abs(seconds);
  const sign = seconds < 0 ? -1 : 1;
  const pick = (size: number, unit: ElapsedUnit) => ({ value: sign * Math.round(abs / size), unit });
  if (abs < MINUTE) return pick(1, 'second');
  if (abs < HOUR) return pick(MINUTE, 'minute');
  if (abs < DAY) return pick(HOUR, 'hour');
  if (abs < MONTH) return pick(DAY, 'day');
  if (abs < YEAR) return pick(MONTH, 'month');
  return pick(YEAR, 'year');
}

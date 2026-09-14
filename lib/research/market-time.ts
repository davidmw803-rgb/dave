/**
 * Ratings are stored in UTC, but a research question like "only Monday
 * pre-market calls" is asked in market time. Everything here converts a UTC
 * timestamp into US Eastern weekday and minute-of-day so the weekday and
 * time-of-day filters mean what a trader expects, through DST changes too.
 */
const MARKET_TZ = 'America/New_York';

const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: MARKET_TZ,
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

export interface MarketMoment {
  /** 0 = Sunday, matching Date.getDay(). */
  weekday: number;
  /** Minutes since midnight ET. */
  minutes: number;
}

export function marketMoment(iso: string): MarketMoment | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;

  let weekday = 0;
  let hour = 0;
  let minute = 0;
  for (const part of formatter.formatToParts(d)) {
    if (part.type === 'weekday') weekday = WEEKDAY_INDEX[part.value] ?? 0;
    // ET midnight formats as "24" under hour12:false in some runtimes.
    if (part.type === 'hour') hour = Number(part.value) % 24;
    if (part.type === 'minute') minute = Number(part.value);
  }
  return { weekday, minutes: hour * 60 + minute };
}

export function hhmmToMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const hours = Number(m[1]);
  const mins = Number(m[2]);
  if (hours > 23 || mins > 59) return null;
  return hours * 60 + mins;
}

export const WEEKDAYS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' },
] as const;

/** Session presets, in ET. */
export const TIME_PRESETS = [
  { label: 'All day', from: '', to: '' },
  { label: 'Pre-market', from: '04:00', to: '09:30' },
  { label: 'Regular hours', from: '09:30', to: '16:00' },
  { label: 'After hours', from: '16:00', to: '20:00' },
] as const;

/**
 * True when `minutes` falls in [from, to]. A range that wraps past midnight
 * (22:00 to 02:00) is treated as spanning the boundary rather than as empty.
 */
export function inTimeRange(
  minutes: number,
  fromMinutes: number | null,
  toMinutes: number | null
): boolean {
  if (fromMinutes === null && toMinutes === null) return true;
  if (fromMinutes === null) return minutes <= (toMinutes as number);
  if (toMinutes === null) return minutes >= fromMinutes;
  if (fromMinutes <= toMinutes) return minutes >= fromMinutes && minutes <= toMinutes;
  return minutes >= fromMinutes || minutes <= toMinutes;
}

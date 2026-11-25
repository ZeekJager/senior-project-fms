import { addisDay } from './kpis';
import { addisMidnight, nextDay } from './report-period';

// Report schedules (FMS-160, docs/reports.md#schedules): daily, weekly (a weekday) or monthly (a day, 1 to 28), at an
// Addis Ababa hour; each run covers the period just ended: yesterday, last week (Monday to Sunday) or last month. Pure.

export const FREQUENCIES = ['daily', 'weekly', 'monthly'] as const;
export type Frequency = (typeof FREQUENCIES)[number];

/** Files up to this size go attached; larger ones as a signed link valid 7 days. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const LINK_DAYS = 7;
/** Each failed recipient is retried this many times, 15 minutes apart. */
export const MAX_SEND_ATTEMPTS = 3;
export const RETRY_MINUTES = 15;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** 1 (Monday) to 7 (Sunday) of an Addis Ababa day. */
export function isoWeekday(day: string): number {
  const d = new Date(`${day}T12:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

/** The first run after `after`: the next Addis Ababa `hour` on a day the schedule runs. */
export function nextRunAt(frequency: Frequency, day: number | null, hour: number, after: Date): Date {
  let d = addisDay(after);
  for (let i = 0; i < 40; i++) {
    const at = new Date(addisMidnight(d).getTime() + hour * HOUR_MS);
    const runs = frequency === 'daily' || (frequency === 'weekly' && isoWeekday(d) === day) || (frequency === 'monthly' && Number(d.slice(8, 10)) === day);
    if (runs && at > after) return at;
    d = nextDay(d);
  }
  throw new Error('No run day within 40 days');
}

/** The period a run due at `due` covers, as report filters take it: the day, week or month that has just ended. */
export function periodFor(frequency: Frequency, due: Date): { from: string; to: string } {
  const today = addisDay(due);
  const yesterday = addisDay(new Date(addisMidnight(today).getTime() - DAY_MS + HOUR_MS));
  if (frequency === 'daily') return { from: yesterday, to: yesterday };
  if (frequency === 'weekly') {
    // The last full Monday-to-Sunday week before the run's day.
    const back = isoWeekday(today) - 1 + 7;
    const monday = addisDay(new Date(addisMidnight(today).getTime() - back * DAY_MS + HOUR_MS));
    const sunday = addisDay(new Date(addisMidnight(monday).getTime() + 6 * DAY_MS + HOUR_MS));
    return { from: monday, to: sunday };
  }
  const [y, m] = today.split('-').map(Number);
  const prev = new Date(Date.UTC(y, m - 2, 1));
  const month = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
  const last = new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth() + 1, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
}

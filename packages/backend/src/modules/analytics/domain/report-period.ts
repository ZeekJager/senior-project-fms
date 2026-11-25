import { AppError } from '../../../shared/errors/app-error';
import { addisDay } from './kpis';

// The period and the filters of a report (FMS-160, docs/reports.md): a month (FMS-91's ?month=, kept), a quarter, a
// year or a custom range of up to 366 days, in Addis Ababa days; up to now when it reaches today. Pure.

export const MAX_RANGE_DAYS = 366;
const DAY_MS = 86_400_000;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const QUARTER = /^(\d{4})-Q([1-4])$/;
const YEAR = /^\d{4}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** An Addis Ababa day's first instant. */
export const addisMidnight = (day: string) => new Date(`${day}T00:00:00+03:00`);

/** The Addis Ababa day after `day`. */
export function nextDay(day: string): string {
  return addisDay(new Date(addisMidnight(day).getTime() + DAY_MS + 3_600_000));
}

export interface ReportPeriod {
  /** How it was asked for. */
  kind: 'month' | 'quarter' | 'year' | 'range';
  /** `2026-10`, `2026-Q3`, `2026`, or `2026-01-01..2026-03-15`: what file names and titles use. */
  key: string;
  /** "October 2026", "Q3 2026", "2026", "1 Jan 2026 to 15 Mar 2026". */
  label: string;
  /** The first day and the last (inclusive), YYYY-MM-DD. */
  from: string;
  to: string;
  start: Date;
  /** Exclusive: the day after `to`, or now. */
  end: Date;
  /** The month, for a period that is one (the FMS-91 `month` field). */
  month: string | null;
}

export interface PeriodQuery {
  month?: string;
  quarter?: string;
  year?: string;
  from?: string;
  to?: string;
}

const bad = (field: string, reason: string, message: string) => new AppError(400, 'VALIDATION_FAILED', message, [{ field, reason }]);

const dayLabel = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const monthLabel = (month: string) =>
  new Date(`${month}-15T12:00:00Z`).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const lastDayOf = (month: string) => {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};

/**
 * The period a query asks for: `month`, `quarter`, `year`, or `from` and `to` (days, `to` included); this month when
 * none is given. One kind at a time; a period not begun, or a range over 366 days or backwards, is refused.
 */
export function resolvePeriod(q: PeriodQuery, now: Date): ReportPeriod {
  const given = (['month', 'quarter', 'year'] as const).filter((k) => q[k] !== undefined);
  const range = q.from !== undefined || q.to !== undefined;
  if (given.length + (range ? 1 : 0) > 1) throw bad('period', 'one_period', 'Give one of month, quarter, year, or from and to.');
  let kind: ReportPeriod['kind'];
  let key: string;
  let label: string;
  let from: string;
  let to: string;
  let month: string | null = null;
  if (q.quarter !== undefined) {
    const m = QUARTER.exec(q.quarter);
    if (!m) throw bad('quarter', 'invalid_format', '`quarter` must be YYYY-Qn.');
    const first = (Number(m[2]) - 1) * 3 + 1;
    kind = 'quarter';
    key = q.quarter;
    label = `Q${m[2]} ${m[1]}`;
    from = `${m[1]}-${String(first).padStart(2, '0')}-01`;
    to = lastDayOf(`${m[1]}-${String(first + 2).padStart(2, '0')}`);
  } else if (q.year !== undefined) {
    if (!YEAR.test(q.year)) throw bad('year', 'invalid_format', '`year` must be YYYY.');
    kind = 'year';
    key = q.year;
    label = q.year;
    from = `${q.year}-01-01`;
    to = `${q.year}-12-31`;
  } else if (range) {
    if (!q.from || !q.to) throw bad(q.from ? 'to' : 'from', 'required', 'A range needs both from and to.');
    if (!DAY.test(q.from) || Number.isNaN(addisMidnight(q.from).getTime())) throw bad('from', 'invalid_format', '`from` must be YYYY-MM-DD.');
    if (!DAY.test(q.to) || Number.isNaN(addisMidnight(q.to).getTime())) throw bad('to', 'invalid_format', '`to` must be YYYY-MM-DD.');
    if (q.to < q.from) throw bad('to', 'before_from', '`to` is before `from`.');
    const days = Math.round((addisMidnight(q.to).getTime() - addisMidnight(q.from).getTime()) / DAY_MS) + 1;
    if (days > MAX_RANGE_DAYS) throw bad('to', 'range_too_long', `A range is at most ${MAX_RANGE_DAYS} days.`);
    kind = 'range';
    key = `${q.from}..${q.to}`;
    label = `${dayLabel(q.from)} to ${dayLabel(q.to)}`;
    from = q.from;
    to = q.to;
  } else {
    const m = q.month ?? addisDay(now).slice(0, 7);
    if (!MONTH.test(m)) throw bad('month', 'invalid_format', '`month` must be YYYY-MM.');
    kind = 'month';
    key = m;
    label = monthLabel(m);
    from = `${m}-01`;
    to = lastDayOf(m);
    month = m;
  }
  const start = addisMidnight(from);
  // A month keeps FMS-91's reason, which clients already read.
  if (start > now) throw bad(kind === 'range' ? 'from' : kind, kind === 'month' ? 'future_month' : 'future_period', kind === 'month' ? 'That month has not begun.' : 'That period has not begun.');
  const after = addisMidnight(nextDay(to));
  return { kind, key, label, from, to, start, end: after < now ? after : now, month };
}

/** The period just before, as long (for a KPI's change): the previous month, quarter or year, or the days before a range. */
export function previousPeriod(p: ReportPeriod, now: Date): ReportPeriod {
  const shiftMonth = (month: string, by: number) => {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + by, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  };
  if (p.kind === 'month') return resolvePeriod({ month: shiftMonth(p.month!, -1) }, now);
  if (p.kind === 'quarter') {
    const [y, q] = p.key.split('-Q').map(Number);
    return resolvePeriod({ quarter: q === 1 ? `${y - 1}-Q4` : `${y}-Q${q - 1}` }, now);
  }
  if (p.kind === 'year') return resolvePeriod({ year: String(Number(p.key) - 1) }, now);
  const days = Math.round((addisMidnight(nextDay(p.to)).getTime() - p.start.getTime()) / DAY_MS);
  const to = addisDay(new Date(p.start.getTime() - DAY_MS + 3_600_000));
  const from = addisDay(new Date(addisMidnight(to).getTime() - (days - 1) * DAY_MS + 3_600_000));
  return resolvePeriod({ from, to }, now);
}

/** The last `count` calendar months ending with the one holding `end` (exclusive), oldest first: YYYY-MM. */
export function monthsBefore(end: Date, count: number): string[] {
  const last = addisDay(new Date(end.getTime() - 1)).slice(0, 7);
  const [y, m] = last.split('-').map(Number);
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - (count - 1 - i), 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  });
}

/** The filters every report takes (public ids), and a saved filter's shape. */
export interface ReportFilters {
  depot_ids?: string[];
  vehicle_type?: string;
  vehicle_id?: string;
  driver_id?: string;
  route_id?: string;
}

/** The filters resolved to internal ids by the repository; null where not given. */
export interface ResolvedFilters {
  depotIds: string[] | null;
  vehicleType: string | null;
  vehicleId: string | null;
  driverId: string | null;
  routeId: string | null;
}

export const NO_FILTERS: ResolvedFilters = { depotIds: null, vehicleType: null, vehicleId: null, driverId: null, routeId: null };

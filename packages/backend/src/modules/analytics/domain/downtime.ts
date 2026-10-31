import { AppError } from '../../../shared/errors/app-error';
import { addisDay, pct, roundDiv } from './kpis';

// Downtime KPIs (FMS-131, docs/downtime.md): availability, MTBF and MTTR per vehicle and depot for a month, from
// fleet's downtime periods. Milliseconds while summing, whole minutes in the answer.

const MINUTE_MS = 60_000;

/** A calendar month in Addis Ababa, up to now when it is the current one. */
export interface MonthWindow {
  /** YYYY-MM. */
  month: string;
  start: Date;
  /** Exclusive: the next month's first midnight, or now. */
  end: Date;
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const monthStart = (month: string) => new Date(`${month}-01T00:00:00+03:00`);
function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** The month asked for (YYYY-MM), this month when left out; a month not yet begun is refused. */
export function monthWindow(month: string | undefined, now: Date): MonthWindow {
  const m = month ?? addisDay(now).slice(0, 7);
  if (!MONTH.test(m)) throw new AppError(400, 'VALIDATION_FAILED', '`month` must be YYYY-MM.', [{ field: 'month', reason: 'invalid_format' }]);
  const start = monthStart(m);
  if (start > now) throw new AppError(400, 'VALIDATION_FAILED', 'That month has not begun.', [{ field: 'month', reason: 'future_month' }]);
  const next = monthStart(nextMonth(m));
  return { month: m, start, end: next < now ? next : now };
}

/** When a vehicle was in the fleet: from its registration until it was retired. */
export interface ServiceSpan {
  joinedAt: Date;
  retiredAt: Date | null;
}

/** One downtime period; `unplanned` counts it as a failure. */
export interface DowntimeFact {
  startedAt: Date;
  endedAt: Date | null;
  reason: string;
  unplanned: boolean;
}

/** One vehicle's (or a sum of vehicles') month, in milliseconds and counts. */
export interface DowntimeTotals {
  vehicles: number;
  inFleetMs: number;
  downtimeMs: number;
  unplannedMs: number;
  /** Unplanned periods that began in the month. */
  failures: number;
  /** Unplanned periods that ended in the month, and their whole length. */
  repairs: number;
  repairMs: number;
  byReasonMs: Record<string, number>;
}

export const NO_TOTALS: DowntimeTotals = { vehicles: 0, inFleetMs: 0, downtimeMs: 0, unplannedMs: 0, failures: 0, repairs: 0, repairMs: 0, byReasonMs: {} };

const overlap = (aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) => Math.max(0, Math.min(aEnd.getTime(), bEnd.getTime()) - Math.max(aStart.getTime(), bStart.getTime()));

/**
 * One vehicle's month: the time it was in the fleet within the window, the downtime within that, the unplanned
 * periods that began in it (failures) and those that ended in it (repairs, their whole length). Null when the
 * vehicle was not in the fleet at all that month.
 */
export function vehicleTotals(span: ServiceSpan, facts: readonly DowntimeFact[], w: MonthWindow): DowntimeTotals | null {
  const from = span.joinedAt > w.start ? span.joinedAt : w.start;
  const to = span.retiredAt && span.retiredAt < w.end ? span.retiredAt : w.end;
  if (to <= from) return null;
  const t: DowntimeTotals = { ...NO_TOTALS, vehicles: 1, inFleetMs: to.getTime() - from.getTime(), byReasonMs: {} };
  for (const f of facts) {
    const down = overlap(f.startedAt, f.endedAt ?? to, from, to);
    t.downtimeMs += down;
    if (down > 0) t.byReasonMs[f.reason] = (t.byReasonMs[f.reason] ?? 0) + down;
    if (!f.unplanned) continue;
    t.unplannedMs += down;
    if (f.startedAt >= from && f.startedAt < to) t.failures += 1;
    if (f.endedAt && f.endedAt >= from && f.endedAt < to) {
      t.repairs += 1;
      t.repairMs += f.endedAt.getTime() - f.startedAt.getTime();
    }
  }
  return t;
}

export function addTotals(a: DowntimeTotals, b: DowntimeTotals): DowntimeTotals {
  const byReasonMs = { ...a.byReasonMs };
  for (const [reason, ms] of Object.entries(b.byReasonMs)) byReasonMs[reason] = (byReasonMs[reason] ?? 0) + ms;
  return {
    vehicles: a.vehicles + b.vehicles,
    inFleetMs: a.inFleetMs + b.inFleetMs,
    downtimeMs: a.downtimeMs + b.downtimeMs,
    unplannedMs: a.unplannedMs + b.unplannedMs,
    failures: a.failures + b.failures,
    repairs: a.repairs + b.repairs,
    repairMs: a.repairMs + b.repairMs,
    byReasonMs,
  };
}

const minutes = (ms: number) => roundDiv(ms, MINUTE_MS);

/**
 * The KPIs of a month's totals: availability (time up over time in the fleet, to a tenth of a percent), MTBF
 * (time up per failure) and MTTR (unplanned downtime per repair ended), null when there is nothing to divide by.
 */
export function downtimeKpis(t: DowntimeTotals, reasons: readonly string[]) {
  const uptimeMs = t.inFleetMs - t.downtimeMs;
  // In minutes: a large fleet's month in milliseconds, times 1,000, is past a safe integer.
  const tenths = pct(minutes(uptimeMs) * 10, minutes(t.inFleetMs));
  return {
    in_fleet_minutes: minutes(t.inFleetMs),
    uptime_minutes: minutes(uptimeMs),
    downtime_minutes: minutes(t.downtimeMs),
    unplanned_downtime_minutes: minutes(t.unplannedMs),
    availability_pct: tenths === null ? null : tenths / 10,
    failures: t.failures,
    mtbf_minutes: t.failures > 0 ? roundDiv(uptimeMs, t.failures * MINUTE_MS) : null,
    repairs: t.repairs,
    mttr_minutes: t.repairs > 0 ? roundDiv(t.repairMs, t.repairs * MINUTE_MS) : null,
    downtime_by_reason: Object.fromEntries(reasons.map((r) => [r, minutes(t.byReasonMs[r] ?? 0)])),
  };
}

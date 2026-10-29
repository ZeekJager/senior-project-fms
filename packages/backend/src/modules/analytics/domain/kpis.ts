import { AppError } from '../../../shared/errors/app-error';

/** A cache whose last refresh is older than this answers with `stale: true` (FMS-50). */
export const STALE_AFTER_HOURS = 25;
/** A completed trip ending this long after its scheduled end still counts as on time. */
export const ON_TIME_GRACE_MINUTES = 15;
/** The longest range one request may ask for. */
export const MAX_RANGE_DAYS = 366;
/** Without from/to: the 30 days to today. */
export const DEFAULT_RANGE_DAYS = 30;
/** The nightly refresh recomputes this many days back, for fill-ups, trips and repair costs entered late. */
export const NIGHTLY_DAYS = 35;
/** An empty cache is first filled this far back, so a year's dashboard has data. */
export const BACKFILL_DAYS = 400;
/** How long one API answer is kept in Redis; a refresh drops them all. */
export const RESPONSE_TTL_SECONDS = 300;

const DAY_MS = 86_400_000;
const ADDIS_MS = 3 * 3_600_000;

/** Addis Ababa's calendar day (UTC+3 all year) of an instant, as YYYY-MM-DD. */
export const addisDay = (at: Date): string => new Date(at.getTime() + ADDIS_MS).toISOString().slice(0, 10);
/** The day `n` days after `day` (negative: before). */
export const shiftDay = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
/** Midnight in Addis Ababa at the start of `day`. */
export const dayStart = (day: string): Date => new Date(`${day}T00:00:00+03:00`);
/** Days from `from` to `to`, both included. */
export const daysIn = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;

/** Integer division, half away from zero, in BigInt (no float on the money path). */
export function roundDiv(a: number, b: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || b <= 0) throw new RangeError(`roundDiv(${a}, ${b})`);
  const n = BigInt(Math.abs(a));
  const d = BigInt(b);
  const q = (2n * n + d) / (2n * d);
  return Number(a < 0 ? -q : q);
}

/** `part` of `whole` in whole percent, or null when there is no whole. */
export const pct = (part: number, whole: number): number | null => (whole > 0 ? roundDiv(part * 100, whole) : null);
/** Cents per km over metres driven, an integer; null when nothing was driven. */
export const costPerKm = (cents: number, metres: number): number | null => (metres > 0 ? roundDiv(cents * 1000, metres) : null);
/** Millilitres per km over metres driven, an integer; null when nothing was driven. */
export const mlPerKm = (ml: number, metres: number): number | null => (metres > 0 ? roundDiv(ml * 1000, metres) : null);
/** Whole km of metres. */
export const km = (metres: number): number => roundDiv(metres, 1000);

export interface Range {
  /** Addis Ababa days, both included. */
  from: string;
  to: string;
  days: number;
}

/** The range asked for: from/to as Addis Ababa days, the 30 days to today when left out, never past today. */
export function rangeOf(query: { from?: string; to?: string }, now: Date): Range {
  const today = addisDay(now);
  const to = query.to && query.to < today ? query.to : today;
  const from = query.from ?? shiftDay(to, 1 - DEFAULT_RANGE_DAYS);
  if (from > to) throw new AppError(400, 'VALIDATION_FAILED', '`from` must be on or before `to`.', [{ field: 'to', reason: 'before_from' }]);
  const days = daysIn(from, to);
  if (days > MAX_RANGE_DAYS) throw new AppError(400, 'VALIDATION_FAILED', `At most ${MAX_RANGE_DAYS} days.`, [{ field: 'from', reason: 'range_too_long' }]);
  return { from, to, days };
}

/** Stale when the cache was never filled, or not refreshed for 25 hours. */
export const isStale = (computedAt: Date | null, now: Date): boolean => computedAt === null || now.getTime() - computedAt.getTime() > STALE_AFTER_HOURS * 3_600_000;

/** One vehicle's day as the refresh computes it; the cache row adds the ratios. */
export interface DayFigures {
  vehicleId: string;
  day: string;
  used: boolean;
  distanceM: number;
  tripsCompleted: number;
  tripsTimed: number;
  tripsOnTime: number;
  fuelMl: number;
  fuelCostCents: number;
  maintenanceCostCents: number;
}

export const OPEN_ALERT_STATUSES = ['open', 'acknowledged'] as const;
export const ALERT_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export const VEHICLE_STATUSES = ['active', 'inactive', 'maintenance', 'retired'] as const;
export const TRIP_STATUSES = ['draft', 'scheduled', 'assigned', 'en_route', 'completed', 'cancelled'] as const;


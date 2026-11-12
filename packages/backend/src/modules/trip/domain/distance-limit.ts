// Daily and weekly driving distance limits, by job load (FMS-156, docs/driving-distance-limits.md): a driver is never
// assigned a trip that takes them past a set load-weighted distance in a day or a week. A safety rule like BR-1, BR-2 and
// BR-8: never held for approval (FMS-151) and never overridden. Pure: the trip service feeds it the driver's trips.

import { AppError } from '../../../shared/errors/app-error';
import type { JobLoadLevel } from './job-load';

/** A depot's limits and weights, or the fleet's (tracking.rule_thresholds, migration 074). */
export interface DistanceLimits {
  /** Load-weighted km in one calendar day in Addis Ababa. */
  dailyKm: number;
  /** Load-weighted km Monday to Sunday in Addis Ababa; at least dailyKm. */
  weeklyKm: number;
  /** What one km of each job load counts for; never lighter for a heavier load. */
  weights: Record<JobLoadLevel, number>;
}

/** The fleet row's starting values (migration 074): placeholders until the client confirms them. */
export const DEFAULT_DISTANCE_LIMITS: DistanceLimits = { dailyKm: 500, weeklyKm: 2500, weights: { light: 0.8, standard: 1, heavy: 1.5 } };

/** Each value's range, as the table's checks have it (migration 074). Weights take two decimals. */
export const DISTANCE_LIMIT_RANGES = {
  dailyKm: { min: 50, max: 2000 },
  weeklyKm: { min: 100, max: 10_000 },
  weight: { min: 0.5, max: 3 },
} as const;

/** At this share of a limit, the dispatcher is warned; never a block. */
export const DISTANCE_WARNING_SHARE = 0.8;

/** Statuses whose trips count against the limits: booked, under way, or driven. */
export const COUNTED_STATUSES = ['assigned', 'en_route', 'completed'] as const;

export type DistancePeriod = 'day' | 'week';

/** One trip as the rule counts it. */
export interface CountedTrip {
  status: string;
  scheduledStart: Date;
  plannedDistanceKm: number | null;
  /** Measured as it ended (FMS-145); null while it is not. */
  actualDistanceKm: number | null;
  jobLoad: JobLoadLevel;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Addis Ababa is UTC+3 all year, with no daylight saving. */
const ADDIS_OFFSET_MS = 3 * HOUR_MS;

/** The calendar day in Addis Ababa `at` falls on, as [start, end) in UTC. */
export function addisDay(at: Date): { start: Date; end: Date } {
  const start = Math.floor((at.getTime() + ADDIS_OFFSET_MS) / DAY_MS) * DAY_MS - ADDIS_OFFSET_MS;
  return { start: new Date(start), end: new Date(start + DAY_MS) };
}

/** The week, Monday to Sunday in Addis Ababa, `at` falls in, as [start, end) in UTC. */
export function addisWeek(at: Date): { start: Date; end: Date } {
  const day = addisDay(at).start.getTime();
  // getUTCDay of the local day's start shifted back to local midnight: 0 is Sunday.
  const weekday = new Date(day + ADDIS_OFFSET_MS).getUTCDay();
  const start = day - ((weekday + 6) % 7) * DAY_MS;
  return { start: new Date(start), end: new Date(start + 7 * DAY_MS) };
}

/** Km to one decimal, so sums compare as a dispatcher reads them. */
const tenth = (km: number) => Math.round(km * 10) / 10;

/**
 * The km a trip counts: the measured distance once it is completed and measured (FMS-145), else the planned one (a trip
 * assigned or under way, a completed one not yet measured); none when neither is known.
 */
export function countedKm(trip: Pick<CountedTrip, 'status' | 'plannedDistanceKm' | 'actualDistanceKm'>): number {
  const km = trip.status === 'completed' && trip.actualDistanceKm !== null ? trip.actualDistanceKm : trip.plannedDistanceKm;
  return km !== null && Number.isFinite(km) && km > 0 ? km : 0;
}

/** The trip's distance times its load's weight. */
export function weightedKm(trip: CountedTrip, limits: DistanceLimits): number {
  return tenth(countedKm(trip) * limits.weights[trip.jobLoad]);
}

/** Where the driver stands in one period with the trip being assigned. */
export interface PeriodStanding {
  period: DistancePeriod;
  limit_km: number;
  /** Load-weighted km of their other trips starting in the period. */
  without_km: number;
  /** With this trip's. */
  with_km: number;
  /** Left of the limit with this trip; negative when over. */
  left_km: number;
}

export interface DistanceStanding {
  /** The trip's own load-weighted km. */
  trip_km: number;
  day: PeriodStanding;
  week: PeriodStanding;
  /** The first period the trip takes past its limit (the day before the week): the assignment is refused. */
  over: PeriodStanding | null;
  /** Otherwise, the first at DISTANCE_WARNING_SHARE of its limit or more: a warning. */
  near: PeriodStanding | null;
}

/**
 * Where the driver stands if given `trip`: each period holds the driver's other `trips` that start in it (the trip's own
 * start day and week; a trip over midnight counts on the day it starts). Exactly on a limit is allowed.
 */
export function distanceStanding(trip: CountedTrip, trips: readonly CountedTrip[], limits: DistanceLimits): DistanceStanding {
  const own = weightedKm(trip, limits);
  const standing = (period: DistancePeriod): PeriodStanding => {
    const span = period === 'day' ? addisDay(trip.scheduledStart) : addisWeek(trip.scheduledStart);
    const limit = period === 'day' ? limits.dailyKm : limits.weeklyKm;
    const inside = trips.filter((t) => COUNTED_STATUSES.includes(t.status as (typeof COUNTED_STATUSES)[number]) && t.scheduledStart >= span.start && t.scheduledStart < span.end);
    const without = tenth(inside.reduce((sum, t) => sum + weightedKm(t, limits), 0));
    const withTrip = tenth(without + own);
    return { period, limit_km: limit, without_km: without, with_km: withTrip, left_km: tenth(limit - withTrip) };
  };
  const day = standing('day');
  const week = standing('week');
  const over = [day, week].find((p) => p.with_km > p.limit_km) ?? null;
  const near = over ? null : ([day, week].find((p) => p.with_km >= p.limit_km * DISTANCE_WARNING_SHARE) ?? null);
  return { trip_km: own, day, week, over, near };
}

const periodWord = (p: DistancePeriod) => (p === 'day' ? 'today' : 'this week');

/** "Would drive 560 of 500 km today", as the console and the 409 say it. */
export function overLimitText(p: PeriodStanding): string {
  return `Would drive ${formatKm(p.with_km)} of ${formatKm(p.limit_km)} km ${periodWord(p.period)}`;
}

const formatKm = (km: number) => (Number.isInteger(km) ? String(km) : km.toFixed(1));

/**
 * FMS-156: the trip takes the driver past a limit. Names the period, the limit, and the driver's total with the trip and
 * without it. `tripId` is the trip whose times moved it there, when that is another trip of the driver (FMS-139 shift).
 */
export const distanceLimitExceeded = (p: PeriodStanding, tripId?: string) =>
  new AppError(409, 'CONFLICT_DRIVER_DISTANCE_LIMIT', `${overLimitText(p)}: the driver's ${p.period === 'day' ? 'daily' : 'weekly'} distance limit.`, [
    {
      field: 'driver_id',
      reason: 'distance_limit',
      period: p.period,
      limit_km: p.limit_km,
      total_km: p.with_km,
      without_trip_km: p.without_km,
      ...(tripId ? { record_id: tripId } : {}),
    },
  ]);

/** The weights' and limits' order (chk_rule_distance_limits, chk_rule_distance_weights): what is wrong, or null. */
export function distanceLimitsProblem(l: DistanceLimits): { field: string; reason: string; message: string } | null {
  if (l.weeklyKm < l.dailyKm) return { field: 'weekly_distance_km', reason: 'below_daily', message: `A week's limit holds at least a day's: ${l.dailyKm} km or more.` };
  if (l.weights.light > l.weights.standard) return { field: 'distance_weight_light', reason: 'above_standard', message: 'A light job counts for no more than a standard one.' };
  if (l.weights.standard > l.weights.heavy) return { field: 'distance_weight_heavy', reason: 'below_standard', message: 'A heavy job counts for at least as much as a standard one.' };
  return null;
}

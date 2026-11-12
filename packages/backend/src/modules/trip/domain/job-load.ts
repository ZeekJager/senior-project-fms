// The load of a job on each trip (FMS-153, docs/job-load.md): what a trip asks of its driver, worked out from the plan,
// the schedule, the stops and the cargo, never typed. Pure: the trip service feeds it each trip it returns. The driver
// fit suggestion (FMS-154) and the trip risk model (FMS-155) read it to compare a driver with similar jobs.

import { AppError } from '../../../shared/errors/app-error';

/** What a trip carries (migration 071). `general` is the default, and what a trip with no cargo recorded is. */
export const CARGO_KINDS = ['general', 'fragile', 'hazardous', 'refrigerated', 'passengers'] as const;
export type CargoKind = (typeof CARGO_KINDS)[number];

/** The heaviest cargo a trip can record, in kg: above any road vehicle's payload. */
export const MAX_CARGO_WEIGHT_KG = 100_000;

export type JobLoadLevel = 'light' | 'standard' | 'heavy';

/** Why a trip loads as it does, each worth points (JOB_LOAD_RULES). The API returns them with the level. */
export type JobLoadReason = 'long_haul' | 'regional' | 'long_day' | 'long_hours' | 'many_stops' | 'night' | 'near_payload' | 'loaded';

/**
 * The thresholds, in one place (docs/job-load.md). Each input gives at most one reason: the higher rung when it is met,
 * else the lower. The points add up; JOB_LOAD_LEVELS turns the total into a level.
 */
export const JOB_LOAD_RULES = {
  /** Planned distance, km. */
  distance: { long_haul: { atLeast: 300, points: 2 }, regional: { atLeast: 100, points: 1 } },
  /** Planned driving time (the route's estimate, else the scheduled window), hours. */
  duration: { long_day: { atLeast: 9, points: 2 }, long_hours: { atLeast: 4, points: 1 } },
  /** Stops along the way. */
  stops: { many_stops: { atLeast: 6, points: 1 } },
  /** Scheduled hours between 22:00 and 06:00 in Addis Ababa. */
  night: { night: { atLeast: 2, points: 1 } },
  /** The cargo's share of the vehicle's payload capacity. */
  payload: { near_payload: { atLeast: 0.9, points: 2 }, loaded: { atLeast: 0.6, points: 1 } },
} as const;

/** Points to level: below `standard` is light, at or above `heavy` is heavy. */
export const JOB_LOAD_LEVELS = { standard: 1, heavy: 3 } as const;

/** The night, in Addis Ababa (UTC+3 all year, no daylight saving): 22:00 to 06:00 local, 19:00 to 03:00 UTC. */
const NIGHT_START_UTC_HOUR = 19;
const NIGHT_HOURS = 8;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface JobLoadInput {
  plannedDistanceKm: number | null;
  plannedDurationSeconds: number | null;
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  stopCount: number;
  cargoWeightKg: number | null;
  /** The assigned vehicle's; null with no vehicle yet or none recorded: the cargo's share is then unknown. */
  payloadCapacityKg: number | null;
}

export interface JobLoad {
  level: JobLoadLevel;
  /** Highest points first, then in JOB_LOAD_RULES order. */
  reasons: JobLoadReason[];
  points: number;
}

/** Hours of [start, end] between 22:00 and 06:00 in Addis Ababa. */
export function nightHours(start: Date, end: Date): number {
  const from = start.getTime();
  const to = end.getTime();
  if (!(to > from)) return 0;
  // The night that began before `start`, then each following one until `end`.
  let night = Math.floor((from - NIGHT_START_UTC_HOUR * HOUR_MS) / DAY_MS) * DAY_MS + NIGHT_START_UTC_HOUR * HOUR_MS;
  let ms = 0;
  for (; night < to; night += DAY_MS) {
    ms += Math.max(0, Math.min(to, night + NIGHT_HOURS * HOUR_MS) - Math.max(from, night));
  }
  return ms / HOUR_MS;
}

/** The cargo's share of the payload, when both are known and the capacity is above zero. */
export function payloadShare(cargoWeightKg: number | null, payloadCapacityKg: number | null): number | null {
  if (cargoWeightKg === null || payloadCapacityKg === null || payloadCapacityKg <= 0) return null;
  return cargoWeightKg / payloadCapacityKg;
}

type Rung = { readonly atLeast: number; readonly points: number };

/** The first rung `value` meets, as [reason, points]; none when it is unknown or meets none. */
function rung<R extends JobLoadReason>(value: number | null, rungs: Readonly<Record<R, Rung>>): [R, number] | null {
  if (value === null || !Number.isFinite(value)) return null;
  for (const [reason, r] of Object.entries(rungs) as [R, Rung][]) if (value >= r.atLeast) return [reason, r.points];
  return null;
}

/** A trip's job load (docs/job-load.md). Unknown inputs count as nothing: a trip with no plan and no cargo is light. */
export function jobLoad(input: JobLoadInput): JobLoad {
  const window =
    input.scheduledStart && input.scheduledEnd && input.scheduledEnd > input.scheduledStart ? (input.scheduledEnd.getTime() - input.scheduledStart.getTime()) / 1000 : null;
  const durationSeconds = input.plannedDurationSeconds ?? window;
  const found = [
    rung(input.plannedDistanceKm, JOB_LOAD_RULES.distance),
    rung(durationSeconds === null ? null : durationSeconds / 3600, JOB_LOAD_RULES.duration),
    rung(input.stopCount, JOB_LOAD_RULES.stops),
    rung(input.scheduledStart && input.scheduledEnd ? nightHours(input.scheduledStart, input.scheduledEnd) : null, JOB_LOAD_RULES.night),
    rung(payloadShare(input.cargoWeightKg, input.payloadCapacityKg), JOB_LOAD_RULES.payload),
  ].filter((r): r is [JobLoadReason, number] => r !== null);
  const points = found.reduce((sum, [, p]) => sum + p, 0);
  const level: JobLoadLevel = points >= JOB_LOAD_LEVELS.heavy ? 'heavy' : points >= JOB_LOAD_LEVELS.standard ? 'standard' : 'light';
  // Stable sort: equal points keep the rules' order.
  return { level, reasons: [...found].sort((a, b) => b[1] - a[1]).map(([reason]) => reason), points };
}

/** The cargo is heavier than the vehicle carries (FMS-153): on a cargo change of an assigned trip, or an assignment. */
export const overPayload = (field: 'cargo_weight_kg' | 'vehicle_id', cargoKg: number, capacityKg: number) =>
  new AppError(
    400,
    'VALIDATION_FAILED',
    field === 'vehicle_id'
      ? `The trip's cargo (${cargoKg} kg) is more than this vehicle carries (${capacityKg} kg).`
      : `The cargo is more than the trip's vehicle carries (${capacityKg} kg).`,
    [{ field, reason: 'over_payload' }],
  );

/** A trip under way, or closed, keeps its cargo: it is set before the trip starts. */
export const cargoFixed = (status: string) =>
  new AppError(409, 'CONFLICT_INVALID_STATE_TRANSITION', `The cargo is set before the trip starts; this one is ${status.replace('_', ' ')}.`, [
    { field: 'status', reason: `trip_${status}` },
  ]);

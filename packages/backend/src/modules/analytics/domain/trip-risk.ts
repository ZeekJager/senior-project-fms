// The trip risk model's inputs (FMS-155, docs/ml-trip-risk.md): one driver on one trip, from what was known at t, the
// trip's scheduled start. The definitions are packages/ai-service/trip_risk_spec.json; the ML service computes the same
// for its generated data (ml/trip_risk/features.py), and packages/ai-service/tests/fixtures/trip_risk_features.json holds
// cases both must agree on to the decimal. Pure: the service reads the trips, this works them out.

/** A driver's and a route's record count the trips that ended in the last 90 days. */
export const RECORD_DAYS = 90;
/** A trip is never planned longer than this: history this much older than the record's window cannot reach it. */
export const LONGEST_TRIP_HOURS = 72;
/** hours_since_last_trip for a driver with no earlier trip, and its cap: 14 days. */
export const NO_EARLIER_TRIP_HOURS = 336;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Addis Ababa is UTC+3 all year. */
const ADDIS_OFFSET_MS = 3 * HOUR_MS;

/** The model's id columns and labels around the inputs, in a dataset row (trip_risk_spec.json). */
export const TRIP_RISK_ID_COLUMNS = ['trip_id', 'driver_id', 'depot_id', 'as_of', 'source'] as const;
export const TRIP_RISK_LABELS = ['late', 'safety_event'] as const;
export type TripRiskLabel = (typeof TRIP_RISK_LABELS)[number];

/** The least data the model is trained on (trip_risk_spec.json `minimum`): below it the console says "Not enough trips yet". */
export const TRIP_RISK_MINIMUM = { trips: 2000, drivers: 20 } as const;

/** One input's range and rounding, as the spec has it. */
export interface RiskInput {
  name: string;
  type: 'int' | 'float';
  min: number;
  max: number;
  decimals: number;
}

/** The trip being judged. Its job load (FMS-153) is worked out by the trip module's jobLoad. */
export interface RiskJob {
  scheduledStart: Date;
  scheduledEnd: Date | null;
  plannedDistanceKm: number | null;
  plannedDurationSeconds: number | null;
  stops: number;
  cargoWeightKg: number | null;
  cargoKind: string;
  payloadCapacityKg: number | null;
  jobLoadPoints: number;
  jobLoadLevel: string;
  /** Hours of the scheduled window between 22:00 and 06:00 in Addis Ababa (nightHours); 0 without an end. */
  nightHours: number;
}

/** A trip of the driver's or the route's, and how it went. */
export interface RiskPast {
  scheduledEnd: Date | null;
  actualStart: Date;
  /** Null while under way. */
  actualEnd: Date | null;
  /** Null when it had no scheduled end, or has not ended. */
  late: boolean | null;
  safetyEvent: boolean;
  jobLoadLevel: string;
}

/** As the ML service rounds (math.floor(x * 10^d + 0.5) / 10^d): halves up, never to even. */
export function roundHalfUp(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.floor(value * scale + 0.5) / scale;
}

/** The share of `trips` that were late (of those judged), or had a safety event; 0 with none. */
function share(trips: readonly RiskPast[], what: 'late' | 'safety'): number {
  const judged = what === 'late' ? trips.filter((p) => p.late !== null) : trips;
  if (judged.length === 0) return 0;
  return judged.filter((p) => (what === 'late' ? p.late : p.safetyEvent)).length / judged.length;
}

/** Hours of the trips' driving (start to end, or to `to` while under way) inside [from, to). Summed in ms, then divided. */
function hoursInside(trips: readonly RiskPast[], from: number, to: number): number {
  let ms = 0;
  for (const p of trips) {
    const start = p.actualStart.getTime();
    if (start >= to) continue;
    const stop = Math.min(p.actualEnd?.getTime() ?? to, to);
    ms += Math.max(0, stop - Math.max(start, from));
  }
  return ms / HOUR_MS;
}

/** Capped to each input's range and rounded to its decimals, in the spec's order. */
export function finishInputs(raw: Record<string, number | boolean>, inputs: readonly RiskInput[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of inputs) {
    const value = raw[f.name];
    if (value === undefined) throw new Error(`trip risk: no value for input ${f.name}`);
    const v = Math.min(Math.max(Number(value), f.min), f.max);
    out[f.name] = f.type === 'int' ? roundHalfUp(v, 0) : roundHalfUp(v, f.decimals);
  }
  return out;
}

/**
 * The inputs for one driver on `job`, at t = its scheduled start. `driver` and `route` are trips of the driver and of the
 * route (any order); only those that started before t count, and those not ended at t are under way.
 */
export function tripRiskFeatures(job: RiskJob, driver: readonly RiskPast[], route: readonly RiskPast[], inputs: readonly RiskInput[]): Record<string, number> {
  const t = job.scheduledStart.getTime();
  const windowStart = t - RECORD_DAYS * DAY_MS;
  const started = driver.filter((p) => p.actualStart.getTime() < t);
  const done = started.filter((p) => p.actualEnd !== null && p.actualEnd.getTime() <= t);
  const recent = done.filter((p) => p.actualEnd!.getTime() >= windowStart);
  const same = recent.filter((p) => p.jobLoadLevel === job.jobLoadLevel);
  const routeRecent = route.filter((p) => p.actualEnd !== null && p.actualEnd.getTime() >= windowStart && p.actualEnd.getTime() < t);
  const underWay = started.some((p) => p.actualEnd === null || p.actualEnd.getTime() > t);
  const lastEnd = done.reduce<number | null>((latest, p) => Math.max(latest ?? -Infinity, p.actualEnd!.getTime()), null);
  const local = new Date(t + ADDIS_OFFSET_MS);
  const cargoShare = job.cargoWeightKg !== null && job.payloadCapacityKg ? Math.min(job.cargoWeightKg / job.payloadCapacityKg, 1) : 0;
  const end = job.scheduledEnd?.getTime() ?? null;
  const duration = job.plannedDurationSeconds !== null ? job.plannedDurationSeconds / 3600 : end !== null && end > t ? (end - t) / HOUR_MS : 0;
  return finishInputs(
    {
      driver_trips_90d: recent.length,
      driver_late_share_90d: share(recent, 'late'),
      driver_safety_share_90d: share(recent, 'safety'),
      driver_same_load_trips_90d: same.length,
      driver_same_load_late_share_90d: share(same, 'late'),
      job_load_points: job.jobLoadPoints,
      planned_distance_km: job.plannedDistanceKm ?? 0,
      planned_duration_h: duration,
      stops: job.stops,
      night_hours: job.nightHours,
      cargo_share: cargoShare,
      cargo_hazardous: job.cargoKind === 'hazardous',
      cargo_fragile: job.cargoKind === 'fragile',
      cargo_refrigerated: job.cargoKind === 'refrigerated',
      cargo_passengers: job.cargoKind === 'passengers',
      start_hour: local.getUTCHours(),
      weekday: (local.getUTCDay() + 6) % 7,
      hours_since_last_trip: underWay ? 0 : lastEnd !== null ? (t - lastEnd) / HOUR_MS : NO_EARLIER_TRIP_HOURS,
      hours_driven_24h: hoursInside(started, t - DAY_MS, t),
      hours_driven_7d: hoursInside(started, t - 7 * DAY_MS, t),
      route_trips_90d: routeRecent.length,
      route_late_share_90d: share(routeRecent, 'late'),
    },
    inputs,
  );
}

/** A CSV cell of a dataset row: numbers as JavaScript writes them (Python reads them back the same), text as is. */
export function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

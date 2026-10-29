import { AppError } from '../../../shared/errors/app-error';
import type { FuelType } from './fuel-log';

/**
 * Fuel reconciliation (FMS-41, §9.3): the fuel a vehicle was logged against what its completed trips needed at
 * its rated efficiency. Integers only, end to end (§17): distance in metres, fuel in millilitres, money in cents,
 * the variance in whole percent. Divisions round half away from zero, in BigInt, so no figure goes through a float.
 */

/** Less driving than this cannot be judged: one tank filled before the period starts outweighs it. */
export const MIN_DISTANCE_KM = 100;
/** The longest period one request may reconcile. */
export const MAX_PERIOD_DAYS = 366;

export const RECONCILIATION_STATUSES = ['above', 'below', 'within', 'not_judged'] as const;
export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number];

/** Why a vehicle's period was not judged. */
export type NotJudgedReason = 'electric' | 'no_efficiency' | 'too_little_distance';

/** The anomaly types a reconciliation writes (fuel.fuel_anomalies.anomaly_type). */
export const RECONCILIATION_ANOMALY = {
  above: 'consumption_above_expected',
  below: 'consumption_below_expected',
} as const;

/** What one vehicle's period adds up to. Integers. */
export interface VehicleUsage {
  /** Completed trips' actual distance, metres. */
  distanceM: number;
  trips: number;
  /** Fuel logged, ml. */
  actualMl: number;
  fuelLogs: number;
  costCents: number;
}

export interface Judgement {
  expectedMl: number | null;
  /** actual - expected, ml. */
  varianceMl: number | null;
  /** (actual - expected) / expected, whole percent. */
  variancePct: number | null;
  status: ReconciliationStatus;
  reason: NotJudgedReason | null;
}

/** a / b rounded half away from zero; b > 0. Integers in, an integer out, never through a float. */
export function roundDiv(a: number, b: number): number {
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || b <= 0) throw new RangeError(`roundDiv(${a}, ${b})`);
  const n = BigInt(Math.abs(a));
  const d = BigInt(b);
  const q = (2n * n + d) / (2n * d);
  return Number(a < 0 ? -q : q);
}

/** The fuel the distance needs at the vehicle's rating: metres × ml/km ÷ 1000. */
export const expectedMl = (distanceM: number, efficiencyMlPerKm: number): number => roundDiv(distanceM * efficiencyMlPerKm, 1000);

/**
 * Whether a vehicle's period is outside the threshold. Beyond it either way is an anomaly: above, fuel bought that
 * the driving does not explain; below, fill-ups missing or distance that was not driven. Exactly at it is within.
 */
export function judge(vehicle: { fuelType: FuelType; fuelEfficiencyMlPerKm: number | null }, usage: VehicleUsage, thresholdPct: number): Judgement {
  const none = (reason: NotJudgedReason): Judgement => ({ expectedMl: null, varianceMl: null, variancePct: null, status: 'not_judged', reason });
  if (vehicle.fuelType === 'electric') return none('electric');
  if (vehicle.fuelEfficiencyMlPerKm === null) return none('no_efficiency');
  if (usage.distanceM < MIN_DISTANCE_KM * 1000) return none('too_little_distance');
  const expected = expectedMl(usage.distanceM, vehicle.fuelEfficiencyMlPerKm);
  const varianceMl = usage.actualMl - expected;
  const variancePct = roundDiv(varianceMl * 100, expected);
  const status: ReconciliationStatus = variancePct > thresholdPct ? 'above' : variancePct < -thresholdPct ? 'below' : 'within';
  return { expectedMl: expected, varianceMl, variancePct, status, reason: null };
}

/** Beyond twice the threshold is high; beyond it, medium. The alert takes this severity. */
export const severityOf = (variancePct: number, thresholdPct: number): 'medium' | 'high' => (Math.abs(variancePct) > 2 * thresholdPct ? 'high' : 'medium');

/** Addis Ababa is UTC+3 all year. */
const ADDIS_OFFSET = '+03:00';
const pad = (n: number) => String(n).padStart(2, '0');
const monthStart = (year: number, month: number) => new Date(`${year}-${pad(month)}-01T00:00:00${ADDIS_OFFSET}`);

/** The calendar month before the local day `day` (YYYY-MM-DD), in Addis Ababa: [its first midnight, the next month's). */
export function previousMonth(day: string): { from: Date; to: Date } {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const [py, pm] = month === 1 ? [year - 1, 12] : [year, month - 1];
  return { from: monthStart(py, pm), to: monthStart(year, month) };
}

/** The local day (YYYY-MM-DD, Addis Ababa) of an instant. */
export const addisDay = (at: Date): string => new Date(at.getTime() + 3 * 3_600_000).toISOString().slice(0, 10);

/** Metres as km for the API and the anomaly row: three decimals at most, exact. */
export const kmOf = (metres: number): number => metres / 1000;

export const periodTooLong = () =>
  new AppError(400, 'VALIDATION_FAILED', `A reconciliation covers at most ${MAX_PERIOD_DAYS} days.`, [{ field: 'to', reason: 'period_too_long' }]);

export const periodReversed = () => new AppError(400, 'VALIDATION_FAILED', '`to` must be after `from`.', [{ field: 'to', reason: 'before_from' }]);

export const vehicleNotFound = () => new AppError(404, 'NOT_FOUND', 'Vehicle not found.');

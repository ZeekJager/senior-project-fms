/**
 * EV range estimation (FMS-98, architecture §13, docs/ev.md#range). Pure and in whole numbers, so the same inputs give
 * the same kilometres on every machine:
 *
 *   range (km) = state of charge × usable capacity × battery health ÷ consumption (Wh/km)
 *
 * The consumption is the vehicle's own, from its recent readings (each one's energy used per km since the previous),
 * rounded to whole Wh/km. The capacity is its battery spec when new (then scaled by health), or failing that estimated
 * from its completed charging sessions (which already reflects the battery's health).
 */

/** The readings the consumption is averaged over: the last this many days. */
export const CONSUMPTION_DAYS = 30;
/** Fewer readings with an energy figure than this and the consumption is not known. */
export const CONSUMPTION_MIN_READINGS = 3;
/** A session must have added at least this many points of charge to estimate the capacity from it. */
export const CAPACITY_MIN_SOC_GAIN = 20;
/** The charger's energy reaching the battery (the generator's figure, FMS-97). */
export const CHARGE_EFFICIENCY = 0.92;
/** The sessions the capacity is estimated from: the last this many days. */
export const CAPACITY_DAYS = 90;

/** Basis points (hundredths of a percent): 82.35% is 8235. */
const bp = (pct: number) => Math.round(pct * 100);

/** Whole Wh/km from the readings' energy figures: their mean, or null with too few (or none positive). */
export function consumptionWhPerKm(readings: readonly number[]): number | null {
  const usable = readings.filter((r) => Number.isFinite(r) && r > 0);
  if (usable.length < CONSUMPTION_MIN_READINGS) return null;
  return Math.round(usable.reduce((s, r) => s + r, 0) / usable.length);
}

/**
 * Usable capacity, whole Wh, from completed sessions: each one's energy into the battery over the share of the battery
 * it filled; their median, so one odd session moves nothing. Null without a session that added enough charge.
 */
export function capacityFromSessions(sessions: readonly { energy_kwh: number; start_soc: number; end_soc: number }[]): number | null {
  const estimates = sessions
    .filter((s) => s.energy_kwh > 0 && s.end_soc - s.start_soc >= CAPACITY_MIN_SOC_GAIN)
    .map((s) => Math.round((s.energy_kwh * 1000 * CHARGE_EFFICIENCY * 100) / (s.end_soc - s.start_soc)))
    .sort((a, b) => a - b);
  if (estimates.length === 0) return null;
  const mid = Math.floor(estimates.length / 2);
  return estimates.length % 2 === 1 ? estimates[mid] : Math.round((estimates[mid - 1] + estimates[mid]) / 2);
}

export interface RangeInputs {
  /** State of charge, %. */
  stateOfCharge: number;
  /** Usable capacity, whole Wh. */
  capacityWh: number;
  /** State of health, %, applied to a capacity when new; null (or a capacity already measured) applies none. */
  healthPct: number | null;
  /** Consumption, whole Wh/km. */
  whPerKm: number;
}

/** Whole kilometres the battery's charge lasts: rounded down, never below 0. Integer arithmetic throughout. */
export function rangeKm(i: RangeInputs): number {
  if (i.whPerKm <= 0 || i.capacityWh <= 0) return 0;
  const soc = Math.max(0, Math.min(10_000, bp(i.stateOfCharge)));
  const health = i.healthPct === null ? 10_000 : Math.max(0, Math.min(10_000, bp(i.healthPct)));
  // capacity (≤ 2,000,000 Wh) × 10,000 × 10,000 stays below 2^53.
  return Math.floor((Math.round(i.capacityWh) * soc * health) / (10_000 * 10_000 * Math.round(i.whPerKm)));
}

/** A vehicle's range now, as the API shows it. */
export interface RangeEstimate {
  range_km: number;
  state_of_charge: number;
  /** The reading it is from. */
  recorded_at: Date;
  wh_per_km: number;
  usable_capacity_kwh: number;
  /** The battery spec (scaled by the latest health), or estimated from charging sessions. */
  capacity_source: 'spec' | 'sessions';
  battery_health: number | null;
}

/** Why a vehicle has no range: no reading, too little consumption history, or no capacity known. */
export type RangeGap = 'no_reading' | 'no_consumption' | 'no_capacity';

export function estimateRange(input: {
  latest: { state_of_charge: number; battery_health: number | null; recorded_at: Date } | null;
  /** The latest health of any reading (a reading may leave it out). */
  health: number | null;
  readingsWhPerKm: readonly number[];
  specKwh: number | null;
  sessions: readonly { energy_kwh: number; start_soc: number; end_soc: number }[];
}): { estimate: RangeEstimate | null; gap: RangeGap | null } {
  if (!input.latest) return { estimate: null, gap: 'no_reading' };
  const whPerKm = consumptionWhPerKm(input.readingsWhPerKm);
  if (whPerKm === null) return { estimate: null, gap: 'no_consumption' };
  const fromSpec = input.specKwh !== null ? Math.round(input.specKwh * 1000) : null;
  const capacityWh = fromSpec ?? capacityFromSessions(input.sessions);
  if (capacityWh === null) return { estimate: null, gap: 'no_capacity' };
  const health = input.latest.battery_health ?? input.health;
  const km = rangeKm({ stateOfCharge: input.latest.state_of_charge, capacityWh, healthPct: fromSpec !== null ? health : null, whPerKm });
  return {
    estimate: {
      range_km: km,
      state_of_charge: input.latest.state_of_charge,
      recorded_at: input.latest.recorded_at,
      wh_per_km: whPerKm,
      usable_capacity_kwh: Math.round(capacityWh / 10) / 100,
      capacity_source: fromSpec !== null ? 'spec' : 'sessions',
      battery_health: health,
    },
    gap: null,
  };
}

/** The thresholds a battery reading is checked against (the settings ev_low_soc_pct and ev_battery_health_min_pct). */
export interface BatteryThresholds {
  lowSocPct: number;
  healthMinPct: number;
}

export const DEFAULT_BATTERY_THRESHOLDS: BatteryThresholds = { lowSocPct: 20, healthMinPct: 80 };

/** A metric of BatteryThresholdExceeded (CONVENTIONS.md): the charge, the battery's health, or the range for a trip. */
export type BatteryMetric = 'state_of_charge' | 'battery_health' | 'range';

export interface ThresholdCrossing {
  metric: BatteryMetric;
  value: number;
  threshold: number;
  severity: 'medium' | 'high' | 'critical';
}

/**
 * The thresholds a reading crosses: the charge below the low line, or the health below the degradation line, when the
 * previous reading was not already below it (a battery that stays low raises one alert, not one a reading). Half the
 * low line is critical.
 */
export function crossings(
  reading: { state_of_charge: number; battery_health: number | null },
  previous: { state_of_charge: number; battery_health: number | null } | null,
  t: BatteryThresholds,
): ThresholdCrossing[] {
  const out: ThresholdCrossing[] = [];
  if (reading.state_of_charge < t.lowSocPct && !(previous && previous.state_of_charge < t.lowSocPct)) {
    out.push({ metric: 'state_of_charge', value: reading.state_of_charge, threshold: t.lowSocPct, severity: reading.state_of_charge < t.lowSocPct / 2 ? 'critical' : 'high' });
  }
  if (reading.battery_health !== null && reading.battery_health < t.healthMinPct && !(previous?.battery_health != null && previous.battery_health < t.healthMinPct)) {
    out.push({ metric: 'battery_health', value: reading.battery_health, threshold: t.healthMinPct, severity: 'medium' });
  }
  return out;
}

/** The range for the rest of a trip: short of the distance left is high; short of half of it, critical. */
export function rangeShortfall(rangeKmNow: number, remainingKm: number): ThresholdCrossing | null {
  if (remainingKm <= 0 || rangeKmNow >= remainingKm) return null;
  return { metric: 'range', value: rangeKmNow, threshold: Math.ceil(remainingKm), severity: rangeKmNow < remainingKm / 2 ? 'critical' : 'high' };
}

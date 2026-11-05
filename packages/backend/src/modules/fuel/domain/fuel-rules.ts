// The rules a single fill-up is judged by the moment it is logged (FMS-82, docs/fuel-anomaly-rules.md), as pure
// functions. A month's fuel against its trips is the reconciliation's (FMS-41); these catch what one entry shows.
//
// Integers only (api-contract §17): fuel in ml, money in cents, distance in tenths of a km while it is multiplied,
// and the percentages whole, rounded half away from zero.

export const FILL_UP_ANOMALY = {
  /** More fuel than the vehicle's tank holds. */
  tankCapacityExceeded: 'tank_capacity_exceeded',
  /** More fuel than the distance since its last fill-up could have used: it was refuelled too soon for what it drove. */
  refuelIntervalTooShort: 'refuel_interval_too_short',
  /** A cost per litre outside the configured band. */
  priceOutOfRange: 'price_per_litre_out_of_range',
  /** A fill-up logged where the vehicle's GPS shows it was not. */
  fillUpAwayFromVehicle: 'fill_up_away_from_vehicle',
} as const;
export type FillUpAnomalyType = (typeof FILL_UP_ANOMALY)[keyof typeof FILL_UP_ANOMALY];

/** The refuel rule ignores an excess smaller than this: a few litres of difference is a measuring error, not a finding. */
export const REFUEL_MIN_EXCESS_ML = 20_000;

/** A vehicle's GPS position counts as "where it was" for a fill-up only if it was recorded this close in time to it. */
export const LOCATION_WINDOW_MS = 15 * 60_000;

/** The thresholds of the rules (config.fuel.rules). */
export interface FillUpRules {
  /** A fill-up this many percent above what the distance could have used is a refuel too soon. */
  refuelExcessPct: number;
  /** The band a litre may cost, in cents; inside it, edges included, is fine. */
  priceMinCentsPerLitre: number;
  priceMaxCentsPerLitre: number;
  /** The most a fill-up's position may be from the vehicle's GPS position, in km; exactly it is fine. */
  locationMaxKm: number;
}

/** The fill-up, as FuelLogged carries it. */
export interface FillUp {
  quantityMl: number;
  totalCostCents: number;
  odometerKm: number | null;
  /** The reading of the vehicle's log before this one in time; null for its first. */
  previousOdometerKm: number | null;
  /** Where the fill-up was recorded, when the form or the card sent it. */
  latitude: number | null;
  longitude: number | null;
}

/** What the rules need to know of the vehicle. */
export interface FillUpVehicle {
  fuelType: string;
  /** Rated consumption, integer ml/km; null for an electric vehicle. */
  fuelEfficiencyMlPerKm: number | null;
  /** The tank's size in whole ml; null while nobody has said. */
  tankCapacityMl: number | null;
}

/** The vehicle's GPS position nearest the fill-up in time, within LOCATION_WINDOW_MS of it; null when it had none. */
export interface VehiclePosition {
  latitude: number;
  longitude: number;
  recordedAt: Date;
}

export interface FillUpFinding {
  type: FillUpAnomalyType;
  severity: 'medium' | 'high';
  /** Whole percent above (positive) or below (negative) what was expected; null when the rule has no such figure. */
  deviationPct: number | null;
  expectedMl: number | null;
  actualMl: number | null;
  distanceKm: number | null;
  /** The figures the rule judged on, kept with the anomaly and sent in the event (snake_case: they are the payload's). */
  details: Record<string, number | string | null>;
}

/** a ÷ b rounded half away from zero, for whole numbers (b > 0). */
const roundDiv = (a: number, b: number): number => (a < 0 ? -Math.round(-a / b) : Math.round(a / b));

/** The great-circle distance between two points, in km (mean Earth radius). */
export function haversineKm(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** What a litre cost, in whole cents (rounded half away from zero): the cost over the quantity. */
export const centsPerLitre = (totalCostCents: number, quantityMl: number): number => roundDiv(totalCostCents * 1000, quantityMl);

const tankCapacityExceeded = (fill: FillUp, vehicle: FillUpVehicle): FillUpFinding | null => {
  const capacity = vehicle.tankCapacityMl;
  if (capacity === null || fill.quantityMl <= capacity) return null;
  return {
    type: FILL_UP_ANOMALY.tankCapacityExceeded,
    severity: 'high',
    deviationPct: roundDiv((fill.quantityMl - capacity) * 100, capacity),
    expectedMl: capacity,
    actualMl: fill.quantityMl,
    distanceKm: null,
    details: { tank_capacity_ml: capacity, quantity_ml: fill.quantityMl, over_ml: fill.quantityMl - capacity },
  };
};

const refuelIntervalTooShort = (fill: FillUp, vehicle: FillUpVehicle, rules: FillUpRules): FillUpFinding | null => {
  const rating = vehicle.fuelEfficiencyMlPerKm;
  if (vehicle.fuelType === 'electric' || rating === null || fill.odometerKm === null || fill.previousOdometerKm === null) return null;
  const tenths = Math.round((fill.odometerKm - fill.previousOdometerKm) * 10);
  if (tenths < 0) return null; // a reading that went down is the odometer rule's to refuse, not a finding here
  const usedMl = roundDiv(tenths * rating, 10);
  // q above used × (100 + pct) / 100, and by at least REFUEL_MIN_EXCESS_ML: whole-number comparison.
  if (fill.quantityMl * 100 <= usedMl * (100 + rules.refuelExcessPct) || fill.quantityMl - usedMl < REFUEL_MIN_EXCESS_ML) return null;
  return {
    type: FILL_UP_ANOMALY.refuelIntervalTooShort,
    severity: fill.quantityMl * 100 > usedMl * (100 + 2 * rules.refuelExcessPct) ? 'high' : 'medium',
    deviationPct: usedMl > 0 ? roundDiv((fill.quantityMl - usedMl) * 100, usedMl) : null,
    expectedMl: usedMl,
    actualMl: fill.quantityMl,
    distanceKm: tenths / 10,
    details: {
      distance_km: tenths / 10,
      used_ml: usedMl,
      quantity_ml: fill.quantityMl,
      previous_odometer_km: fill.previousOdometerKm,
      odometer_km: fill.odometerKm,
    },
  };
};

const priceOutOfRange = (fill: FillUp, rules: FillUpRules): FillUpFinding | null => {
  const price = centsPerLitre(fill.totalCostCents, fill.quantityMl);
  const { priceMinCentsPerLitre: min, priceMaxCentsPerLitre: max } = rules;
  if (price >= min && price <= max) return null;
  const edge = price < min ? min : max;
  return {
    type: FILL_UP_ANOMALY.priceOutOfRange,
    severity: price * 2 < min || price > max * 2 ? 'high' : 'medium',
    deviationPct: roundDiv((price - edge) * 100, edge),
    expectedMl: null,
    actualMl: null,
    distanceKm: null,
    details: {
      price_cents_per_litre: price,
      band_min_cents_per_litre: min,
      band_max_cents_per_litre: max,
      quantity_ml: fill.quantityMl,
      total_cost_cents: fill.totalCostCents,
    },
  };
};

const fillUpAwayFromVehicle = (fill: FillUp, position: VehiclePosition | null, rules: FillUpRules): FillUpFinding | null => {
  if (fill.latitude === null || fill.longitude === null || position === null) return null;
  const km = haversineKm({ latitude: fill.latitude, longitude: fill.longitude }, position);
  if (km <= rules.locationMaxKm) return null;
  const rounded = Math.round(km * 10) / 10;
  return {
    type: FILL_UP_ANOMALY.fillUpAwayFromVehicle,
    severity: 'high',
    deviationPct: null,
    expectedMl: null,
    actualMl: fill.quantityMl,
    distanceKm: rounded,
    details: {
      distance_km: rounded,
      max_km: rules.locationMaxKm,
      fill_latitude: fill.latitude,
      fill_longitude: fill.longitude,
      vehicle_latitude: position.latitude,
      vehicle_longitude: position.longitude,
      vehicle_seen_at: position.recordedAt.toISOString(),
      quantity_ml: fill.quantityMl,
    },
  };
};

/** Every rule a fill-up breaks, in a fixed order; none for a fill-up that is plausible. A rule without what it needs judges nothing. */
export function judgeFillUp(fill: FillUp, vehicle: FillUpVehicle, position: VehiclePosition | null, rules: FillUpRules): FillUpFinding[] {
  return [tankCapacityExceeded(fill, vehicle), refuelIntervalTooShort(fill, vehicle, rules), priceOutOfRange(fill, rules), fillUpAwayFromVehicle(fill, position, rules)].filter(
    (f): f is FillUpFinding => f !== null,
  );
}

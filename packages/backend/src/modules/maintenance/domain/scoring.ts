import type { ServiceItem } from './inventory';
import type { PredictionFeedbackView } from './prediction-feedback';

// The nightly scoring (FMS-55, docs/ml-scoring.md): every vehicle in service gets the 19 inputs of
// feature_spec.json (FMS-52), computed from the core's own tables as of a scoring time t, a health score
// from the active model (FMS-53, FMS-54, FMS-127), and a risk event when it falls below the line.

/** What maintenance.maintenance_predictions.prediction_type says these predictions are: the spec's label. */
export const PREDICTION_TYPE = 'failure_within_30_days';

/** The ML service's risk levels (api-contract §10.3): low at 75 and above, high at 40 and below. */
export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** A health score below this raises a risk event (CFG-3). The ML service's `low` starts here, so they agree. */
export const RISK_ALERT_BELOW = 75;

/** Vehicles per call to the ML service, which takes 1 to 500. */
export const SCORING_BATCH_SIZE = 100;

export const PREDICTION_EVENTS = { riskDetected: 'MaintenanceRiskDetected' } as const;

/**
 * The hash of the feature spec these formulas implement (spec version 2). The spec file is read at start-up
 * and its hash compared with this: a spec changed without the extractor scores nothing (FMS-127).
 */
export const EXTRACTOR_SPEC_HASH = 'b81af7ff0446aaf63946fcb12fae3a4b0cccaeecbc1a94d04d2b035a048e2f10';

/** Incidents that count as fault reports (num_fault_reports). */
export const FAULT_INCIDENT_TYPES = ['breakdown', 'tyre'] as const;

/** The windows the spec's features look back over, in days, ending at t. */
export const WINDOW_DAYS = { use: 30, faults: 90 } as const;

/** One input of feature_spec.json, as the extractor rounds and caps it. */
export interface FeatureInput {
  name: string;
  type: 'int' | 'float';
  /** km, h, d, count, %, years: how a screen labels the value. */
  unit: string;
  min: number;
  max: number;
  decimals: number;
}

/** POST /internal/ml/predict-maintenance's body (api-contract §10.3). */
export interface PredictRequest {
  vehicle_id: string;
  as_of: string;
  features: Record<string, number>;
}

/** One prediction of the ML service. */
export interface MlPrediction {
  vehicleId: string;
  failureProbability: number;
  healthScore: number;
  riskLevel: RiskLevel;
  horizonDays: number;
  modelVersion: string;
  factors: string[];
}

/** One input behind a vehicle's risk (FMS-56): its name, the vehicle's value when scored, and its unit. */
export interface RiskFactorView {
  feature: string;
  value: number | null;
  unit: string | null;
}

/**
 * GET /vehicles/{vehicle_id}/maintenance-risk (FMS-56): the vehicle's latest prediction. Every score field is
 * null, and `factors` empty, for a vehicle never scored. `stale`: scored more than 25 hours ago.
 */
export interface MaintenanceRiskView {
  vehicle_id: string;
  prediction_id: string | null;
  health_score: number | null;
  risk_level: RiskLevel | null;
  failure_probability: number | null;
  prediction_horizon_days: number | null;
  /** Up to 3, the input raising the risk most first. */
  factors: RiskFactorView[];
  model_name: string | null;
  model_version: string | null;
  /** The scoring time t the inputs were computed as of. */
  as_of: Date | null;
  scored_at: Date | null;
  stale: boolean;
  /** What a technician found when they inspected the vehicle for this prediction (FMS-128), or null. */
  feedback: PredictionFeedbackView | null;
}

/** What the features of one vehicle at t are computed from, read from the modules that own it. */
export interface VehicleFacts {
  createdAt: Date;
  modelYear: number | null;
  odometerKm: number;
  fuelEfficiencyMlPerKm: number | null;
  /** Completed trips with actual_end in [t - 30 d, t). */
  trips: { distanceKm: number; drivingSeconds: number };
  /** The engine-hour meter's increase over the window (FMS-126), when it was read at both ends; else null. */
  engineHoursIncrease: number | null;
  /** DVIRs that found issues plus breakdown and tyre incidents, in [t - 90 d, t). */
  faultReports: number;
  /** Fuel logged in [t - 30 d, t), ml. */
  fuelLoggedMl: number;
  /** The last completed preventive or inspection record before t. */
  lastServiceAt: Date | null;
  /** Each item's last change before t, and the kilometres of completed trips since. Absent: never changed in the system. */
  items: Partial<Record<ServiceItem, { changedAt: Date; kmSince: number }>>;
}

const DAY_MS = 86_400_000;
/** Addis Ababa has no daylight saving time: its days start at 00:00+03:00. */
const ADDIS_OFFSET = '+03:00';

/** The scoring time t of a run: the start of its local day (the run key), so a retry the same day computes the same inputs. */
export const scoringTimeText = (runKey: string) => `${runKey}T00:00:00${ADDIS_OFFSET}`;
export const scoringTime = (runKey: string) => new Date(scoringTimeText(runKey));
export const daysBefore = (t: Date, days: number) => new Date(t.getTime() - days * DAY_MS);

const wholeDays = (from: Date, to: Date) => Math.floor((to.getTime() - from.getTime()) / DAY_MS);
/** 1 January of the model year, or when the vehicle was registered here when the year is not known. */
const builtAt = (f: VehicleFacts) => (f.modelYear !== null ? new Date(`${String(f.modelYear).padStart(4, '0')}-01-01T00:00:00${ADDIS_OFFSET}`) : f.createdAt);

/** Days since the item's last change; never changed: since the vehicle was built (pessimistic on purpose). */
const daysSince = (item: ServiceItem) => (f: VehicleFacts, t: Date) => wholeDays(f.items[item]?.changedAt ?? builtAt(f), t);
/** Kilometres driven since the item's last change; never changed: the vehicle's whole odometer. */
const kmSince = (item: ServiceItem) => (f: VehicleFacts) => f.items[item]?.kmSince ?? f.odometerKm;

/** Each input's formula, as feature_spec.json (and docs/ml-dataset.md) states it, before rounding and caps. */
export const FEATURE_FORMULAS: Record<string, (f: VehicleFacts, t: Date) => number> = {
  mileage_km: (f) => f.trips.distanceKm,
  engine_hours: (f) => f.engineHoursIncrease ?? f.trips.drivingSeconds / 3600,
  days_since_last_service: (f, t) => wholeDays(f.lastServiceAt ?? f.createdAt, t),
  num_fault_reports: (f) => f.faultReports,
  fuel_variance_pct: (f) => {
    const km = f.trips.distanceKm;
    const expected = f.fuelEfficiencyMlPerKm;
    // Electric, too little driving to judge, or no fuel logged.
    if (expected === null || km < 100 || f.fuelLoggedMl <= 0) return 0;
    return (f.fuelLoggedMl / km / expected - 1) * 100;
  },
  age_years: (f, t) => (t.getTime() - builtAt(f).getTime()) / DAY_MS / 365.25,
  days_since_oil_change: daysSince('engine_oil'),
  km_since_oil_change: kmSince('engine_oil'),
  km_since_air_filter_change: kmSince('air_filter'),
  km_since_fuel_filter_change: kmSince('fuel_filter'),
  days_since_coolant_change: daysSince('coolant'),
  km_since_brake_pad_change: kmSince('brake_pads'),
  days_since_brake_fluid_change: daysSince('brake_fluid'),
  days_since_clutch_fluid_change: daysSince('clutch_fluid'),
  km_since_tyre_change: kmSince('tyres'),
  days_since_tyre_change: daysSince('tyres'),
  days_since_battery_change: daysSince('battery'),
  km_since_gearbox_oil_change: kmSince('gearbox_oil'),
  km_since_belt_change: kmSince('belts'),
};

/** Capped to the spec's range and rounded to its decimals: the ML service refuses anything outside it. */
function fit(input: FeatureInput, value: number): number {
  const capped = Math.min(input.max, Math.max(input.min, value));
  const scale = 10 ** (input.type === 'int' ? 0 : input.decimals);
  return Math.round(capped * scale) / scale;
}

/** The vehicle's inputs at t, in the spec's order. Throws for an input the extractor has no formula for. */
export function computeFeatures(inputs: readonly FeatureInput[], facts: VehicleFacts, t: Date): Record<string, number> {
  const features: Record<string, number> = {};
  for (const input of inputs) {
    const formula = FEATURE_FORMULAS[input.name];
    if (!formula) throw new Error(`The feature extractor has no formula for '${input.name}'`);
    features[input.name] = fit(input, formula(facts, t));
  }
  return features;
}

/** The ML service's risk level of a health score (api-contract §10.3). */
export function riskLevelOf(healthScore: number): RiskLevel {
  if (healthScore >= RISK_ALERT_BELOW) return 'low';
  return healthScore <= 40 ? 'high' : 'medium';
}

/**
 * A risk event is raised when a vehicle's score falls below the line (from at or above it, or unscored), or
 * its risk level rises (medium to high). One that stays below raises none: its alert stays open until resolved.
 */
export function raisesRiskEvent(healthScore: number, previousScore: number | null): boolean {
  if (healthScore >= RISK_ALERT_BELOW) return false;
  if (previousScore === null || previousScore >= RISK_ALERT_BELOW) return true;
  return RISK_LEVELS.indexOf(riskLevelOf(healthScore)) > RISK_LEVELS.indexOf(riskLevelOf(previousScore));
}

import { describe, expect, test } from 'vitest';
import { featureSpecLoader } from '../infrastructure/feature-spec';
import {
  computeFeatures,
  EXTRACTOR_SPEC_HASH,
  FEATURE_FORMULAS,
  raisesRiskEvent,
  riskLevelOf,
  scoringTime,
  type FeatureInput,
  type VehicleFacts,
} from './scoring';

// The core's feature extractor (FMS-55): the 19 inputs of feature_spec.json as its formulas state them,
// capped and rounded as the ML service requires.

const spec = featureSpecLoader('../ai-service/feature_spec.json')();
const t = scoringTime('2026-10-25');
const daysAgo = (n: number) => new Date(t.getTime() - n * 86_400_000);

/** A vehicle with no history in the system: built in 2020, registered here 100 days ago, 120,000 km. */
function facts(overrides: Partial<VehicleFacts> = {}): VehicleFacts {
  return {
    createdAt: daysAgo(100),
    modelYear: 2020,
    odometerKm: 120_000,
    fuelEfficiencyMlPerKm: 320,
    trips: { distanceKm: 0, drivingSeconds: 0 },
    engineHoursIncrease: null,
    faultReports: 0,
    fuelLoggedMl: 0,
    lastServiceAt: null,
    items: {},
    ...overrides,
  };
}

const features = (f: VehicleFacts) => computeFeatures(spec.inputs, f, t);
// 1 January 2020 to 25 October 2026, Addis Ababa.
const DAYS_SINCE_BUILT = 2489;

describe('the feature extractor', () => {
  test('implements the spec the ML service serves: every input, in order, and its hash', () => {
    expect(spec.hash).toBe(EXTRACTOR_SPEC_HASH);
    expect(Object.keys(FEATURE_FORMULAS)).toEqual(spec.features);
    expect(Object.keys(features(facts()))).toEqual(spec.features);
  });

  test('scores as of the start of the local day', () => {
    expect(t.toISOString()).toBe('2026-10-24T21:00:00.000Z');
  });

  test('a vehicle with no history: nothing used, and every part as old as the vehicle', () => {
    expect(features(facts())).toEqual({
      mileage_km: 0,
      engine_hours: 0,
      days_since_last_service: 100,
      num_fault_reports: 0,
      fuel_variance_pct: 0,
      age_years: 6.8,
      days_since_oil_change: DAYS_SINCE_BUILT,
      km_since_oil_change: 120_000,
      km_since_air_filter_change: 120_000,
      km_since_fuel_filter_change: 120_000,
      days_since_coolant_change: DAYS_SINCE_BUILT,
      km_since_brake_pad_change: 120_000,
      days_since_brake_fluid_change: DAYS_SINCE_BUILT,
      days_since_clutch_fluid_change: DAYS_SINCE_BUILT,
      km_since_tyre_change: 120_000,
      days_since_tyre_change: DAYS_SINCE_BUILT,
      days_since_battery_change: DAYS_SINCE_BUILT,
      km_since_gearbox_oil_change: 120_000,
      km_since_belt_change: 120_000,
    });
  });

  test('use, faults, fuel and service from the facts', () => {
    const f = features(
      facts({
        trips: { distanceKm: 4321.26, drivingSeconds: 100 * 3600 + 900 },
        faultReports: 3,
        // 1,600 l over 4,321 km is 370 ml/km against 320 expected.
        fuelLoggedMl: 1_600_000,
        lastServiceAt: new Date(daysAgo(40).getTime() - 3_600_000),
      }),
    );
    expect(f).toMatchObject({ mileage_km: 4321.3, engine_hours: 100.3, num_fault_reports: 3, fuel_variance_pct: 15.7, days_since_last_service: 40 });
  });

  test("engine hours are the meter's increase once it was read over the whole window", () => {
    expect(features(facts({ trips: { distanceKm: 900, drivingSeconds: 30 * 3600 }, engineHoursIncrease: 41.26 })).engine_hours).toBe(41.3);
  });

  test('a changed part counts from its change: days whole, kilometres driven since', () => {
    const f = features(
      facts({
        items: {
          engine_oil: { changedAt: new Date(daysAgo(12).getTime() - 60_000), kmSince: 2104.44 },
          tyres: { changedAt: daysAgo(400), kmSince: 51_000 },
        },
      }),
    );
    expect(f).toMatchObject({ days_since_oil_change: 12, km_since_oil_change: 2104.4, days_since_tyre_change: 400, km_since_tyre_change: 51_000 });
    expect(f.km_since_belt_change).toBe(120_000);
  });

  test('no model year: age and never-changed parts count from when the vehicle was registered', () => {
    const f = features(facts({ modelYear: null }));
    expect(f).toMatchObject({ age_years: 0.3, days_since_battery_change: 100 });
  });

  test('fuel variance is 0 for an electric vehicle, under 100 km, or no fuel logged', () => {
    const driven = { trips: { distanceKm: 99.9, drivingSeconds: 7200 }, fuelLoggedMl: 50_000 };
    expect(features(facts(driven)).fuel_variance_pct).toBe(0);
    expect(features(facts({ ...driven, trips: { distanceKm: 500, drivingSeconds: 7200 }, fuelEfficiencyMlPerKm: null })).fuel_variance_pct).toBe(0);
    expect(features(facts({ trips: { distanceKm: 500, drivingSeconds: 7200 } })).fuel_variance_pct).toBe(0);
  });

  test('every input is capped to the range the ML service accepts', () => {
    const f = features(
      facts({
        createdAt: daysAgo(5000),
        modelYear: 1970,
        odometerKm: 900_000,
        trips: { distanceKm: 20_000, drivingSeconds: 1000 * 3600 },
        faultReports: 80,
        // 50 ml/km against 320 expected.
        fuelLoggedMl: 1_000_000,
      }),
    );
    expect(f).toMatchObject({
      mileage_km: 15_000,
      engine_hours: 720,
      days_since_last_service: 730,
      num_fault_reports: 50,
      fuel_variance_pct: -50,
      age_years: 40,
      days_since_oil_change: 3650,
      km_since_oil_change: 500_000,
    });
    expect(features(facts({ trips: { distanceKm: 200, drivingSeconds: 3600 }, fuelLoggedMl: 1_000_000 })).fuel_variance_pct).toBe(100);
    // A vehicle registered after t (its clock is ahead) is 0 days, never negative.
    expect(features(facts({ createdAt: new Date(t.getTime() + 3_600_000) })).days_since_last_service).toBe(0);
  });

  test('refuses an input it has no formula for', () => {
    const unknown: FeatureInput = { name: 'tyre_pressure_kpa', type: 'float', min: 0, max: 1000, decimals: 1 };
    expect(() => computeFeatures([...spec.inputs, unknown], facts(), t)).toThrow(/no formula for 'tyre_pressure_kpa'/);
  });
});

describe('risk', () => {
  test("levels follow the ML service's: low at 75 and up, high at 40 and below", () => {
    expect([100, 75, 74, 41, 40, 0].map(riskLevelOf)).toEqual(['low', 'low', 'medium', 'medium', 'high', 'high']);
  });

  test('an event when the score falls below 75 or the level rises, not while it stays', () => {
    expect(raisesRiskEvent(60, null)).toBe(true);
    expect(raisesRiskEvent(80, null)).toBe(false);
    expect(raisesRiskEvent(74, 75)).toBe(true);
    expect(raisesRiskEvent(60, 70)).toBe(false);
    expect(raisesRiskEvent(30, 60)).toBe(true);
    expect(raisesRiskEvent(30, 35)).toBe(false);
    expect(raisesRiskEvent(60, 30)).toBe(false);
  });
});

import { describe, expect, test } from 'vitest';
import { featureSpecLoader } from '../infrastructure/feature-spec';
import { computeFeatures, EV_EXTRACTOR_SPEC_HASH, EV_FEATURE_FORMULAS, FEATURE_FORMULAS, scoringTime, type EvFacts, type VehicleFacts } from './scoring';

// The EV feature extractor (FMS-135): the 17 inputs of feature_spec_ev.json (FMS-134) as its formulas state them, each
// with its fallback, capped and rounded as the ML service requires.

const spec = featureSpecLoader('../ai-service/feature_spec_ev.json')();
const combustion = featureSpecLoader('../ai-service/feature_spec.json')();
const t = scoringTime('2026-11-26');
const daysAgo = (n: number) => new Date(t.getTime() - n * 86_400_000);

const noEv: EvFacts = {
  newestHealth: null,
  oldestHealth: null,
  healthReadings: 0,
  hotHours: 0,
  energySumWhPerKm: 0,
  energyReadings: 0,
  kindMeanWhPerKm: null,
  sessionEnergyKwh: 0,
  dcFastEnergyKwh: 0,
  deepDischarges: 0,
  failedSessions: 0,
};

/** An EV built in 2023, registered here 200 days ago, 40,000 km, with no history in the system. */
function facts(ev: Partial<EvFacts> | null = {}, overrides: Partial<VehicleFacts> = {}): VehicleFacts {
  return {
    createdAt: daysAgo(200),
    modelYear: 2023,
    odometerKm: 40_000,
    fuelEfficiencyMlPerKm: null,
    trips: { distanceKm: 2400, drivingSeconds: 180_000 },
    engineHoursIncrease: null,
    faultReports: 1,
    fuelLoggedMl: 0,
    lastServiceAt: daysAgo(40),
    items: {},
    ...(ev === null ? {} : { ev: { ...noEv, ...ev } }),
    ...overrides,
  };
}

const features = (f: VehicleFacts) => computeFeatures(spec.inputs, f, t, EV_FEATURE_FORMULAS);

describe('the EV feature extractor', () => {
  test('implements feature_spec_ev.json: every input in order, and its pinned hash', () => {
    // `python -c "from ml.ev.spec import spec_hash; print(spec_hash())"` in packages/ai-service; pinned there too.
    expect(spec.hash).toBe(EV_EXTRACTOR_SPEC_HASH);
    expect(Object.keys(EV_FEATURE_FORMULAS)).toEqual(spec.features);
    expect(Object.keys(features(facts()))).toEqual(spec.features);
    expect(spec.hash).not.toBe(combustion.hash);
  });

  test('no combustion-only input: an EV has no oil, filters, belts, gearbox oil or clutch fluid', () => {
    for (const name of spec.features) expect(name).not.toMatch(/oil|fuel|belt|gearbox|clutch|air_filter|engine_hours/);
    for (const name of ['days_since_oil_change', 'km_since_belt_change', 'fuel_variance_pct']) expect(EV_FEATURE_FORMULAS[name]).toBeUndefined();
  });

  test('the shared inputs are the combustion formulas', () => {
    const f = facts({}, { items: { brake_pads: { changedAt: daysAgo(100), kmSince: 9000 } } });
    for (const name of ['mileage_km', 'days_since_last_service', 'num_fault_reports', 'age_years', 'km_since_brake_pad_change', 'days_since_battery_change']) {
      expect(EV_FEATURE_FORMULAS[name](f, t)).toBe(FEATURE_FORMULAS[name](f, t));
    }
  });

  test('with no battery logs or sessions every EV input reads its fallback: a typical pack for its age, then zeros', () => {
    const f = features(facts(null));
    // Built 1 January 2023: 3.9 years at t, so 100 - 2 x 3.9 = 92.2.
    expect(f).toMatchObject({
      age_years: 3.9,
      battery_health_pct: 92.2,
      battery_health_drop_90d: 0,
      high_temp_hours_30d: 0,
      energy_vs_expected_pct: 0,
      dc_fast_share_pct: 0,
      deep_discharges_30d: 0,
      failed_charging_sessions_90d: 0,
    });
    // An old one is floored at 70.
    expect(features(facts(null, { modelYear: 2005 })).battery_health_pct).toBe(70);
  });

  test('the formulas from the battery and charging facts', () => {
    const f = features(
      facts({
        newestHealth: 84.36,
        oldestHealth: 88.1,
        healthReadings: 40,
        hotHours: 37.25,
        // A mean of 260 Wh/km against its kind's 250: 4% more.
        energySumWhPerKm: 2600,
        energyReadings: 10,
        kindMeanWhPerKm: 250,
        sessionEnergyKwh: 400,
        dcFastEnergyKwh: 130,
        deepDischarges: 3,
        failedSessions: 2,
      }),
    );
    expect(f).toMatchObject({
      battery_health_pct: 84.4,
      battery_health_drop_90d: 3.7,
      high_temp_hours_30d: 37.3,
      energy_vs_expected_pct: 4,
      dc_fast_share_pct: 32.5,
      deep_discharges_30d: 3,
      failed_charging_sessions_90d: 2,
    });
  });

  test('a drop needs two readings, a recalibration upwards is no drop, and energy needs 3 readings and a kind to compare with', () => {
    expect(features(facts({ newestHealth: 90, oldestHealth: 90, healthReadings: 1 })).battery_health_drop_90d).toBe(0);
    expect(features(facts({ newestHealth: 93, oldestHealth: 90, healthReadings: 5 })).battery_health_drop_90d).toBe(0);
    expect(features(facts({ energySumWhPerKm: 520, energyReadings: 2, kindMeanWhPerKm: 200 })).energy_vs_expected_pct).toBe(0);
    expect(features(facts({ energySumWhPerKm: 780, energyReadings: 3, kindMeanWhPerKm: null })).energy_vs_expected_pct).toBe(0);
  });

  test('every input is capped to its range and rounded to its decimals', () => {
    const f = features(facts({ newestHealth: 30, oldestHealth: 95, healthReadings: 9, hotHours: 900, energySumWhPerKm: 30_000, energyReadings: 10, kindMeanWhPerKm: 100, deepDischarges: 80, failedSessions: 70 }));
    expect(f).toMatchObject({
      battery_health_pct: 50,
      battery_health_drop_90d: 30,
      high_temp_hours_30d: 720,
      energy_vs_expected_pct: 100,
      deep_discharges_30d: 60,
      failed_charging_sessions_90d: 50,
    });
    for (const input of spec.inputs) {
      const value = f[input.name];
      expect(value).toBeGreaterThanOrEqual(input.min);
      expect(value).toBeLessThanOrEqual(input.max);
      if (input.type === 'int') expect(Number.isInteger(value)).toBe(true);
    }
  });
});

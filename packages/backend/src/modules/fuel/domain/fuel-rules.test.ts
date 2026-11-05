import { describe, expect, test } from 'vitest';
import {
  FILL_UP_ANOMALY,
  REFUEL_MIN_EXCESS_ML,
  centsPerLitre,
  haversineKm,
  judgeFillUp,
  type FillUp,
  type FillUpRules,
  type FillUpVehicle,
  type VehiclePosition,
} from './fuel-rules';

const RULES: FillUpRules = { refuelExcessPct: 50, priceMinCentsPerLitre: 3000, priceMaxCentsPerLitre: 20000, locationMaxKm: 2 };
const TRUCK: FillUpVehicle = { fuelType: 'diesel', fuelEfficiencyMlPerKm: 320, tankCapacityMl: 200_000 };
/** A plausible fill-up: 60 litres at 85 birr, 190 km after the last one (which needed 60.8 litres). */
const FILL: FillUp = { quantityMl: 60_000, totalCostCents: 510_000, odometerKm: 10_190, previousOdometerKm: 10_000, latitude: null, longitude: null };

const types = (fill: Partial<FillUp>, vehicle: Partial<FillUpVehicle> = {}, position: VehiclePosition | null = null, rules: Partial<FillUpRules> = {}) =>
  judgeFillUp({ ...FILL, ...fill }, { ...TRUCK, ...vehicle }, position, { ...RULES, ...rules }).map((f) => f.type);

describe('a plausible fill-up', () => {
  test('breaks no rule', () => {
    expect(judgeFillUp(FILL, TRUCK, null, RULES)).toEqual([]);
  });
});

describe('tank capacity exceeded', () => {
  test('a fill-up above the tank is a high finding with the over-fill in whole percent and the figures it was judged on', () => {
    const [finding] = judgeFillUp({ ...FILL, quantityMl: 250_000, totalCostCents: 2_125_000 }, TRUCK, null, RULES);
    expect(finding).toMatchObject({
      type: FILL_UP_ANOMALY.tankCapacityExceeded,
      severity: 'high',
      deviationPct: 25,
      expectedMl: 200_000,
      actualMl: 250_000,
      details: { tank_capacity_ml: 200_000, quantity_ml: 250_000, over_ml: 50_000 },
    });
  });

  test('exactly the tank is not too much; a millilitre more is', () => {
    expect(types({ quantityMl: 200_000, totalCostCents: 1_700_000 })).not.toContain(FILL_UP_ANOMALY.tankCapacityExceeded);
    expect(types({ quantityMl: 200_001, totalCostCents: 1_700_009 })).toContain(FILL_UP_ANOMALY.tankCapacityExceeded);
  });

  test('a vehicle whose tank is not known is not judged by it', () => {
    expect(types({ quantityMl: 900_000, totalCostCents: 7_650_000 }, { tankCapacityMl: null })).not.toContain(FILL_UP_ANOMALY.tankCapacityExceeded);
  });

  test('the over-fill percentage rounds half away from zero', () => {
    // 3 ml over a 200 ml tank is 1.5%: 2.
    const [finding] = judgeFillUp({ ...FILL, quantityMl: 203, totalCostCents: 17 }, { ...TRUCK, tankCapacityMl: 200 }, null, { ...RULES, priceMinCentsPerLitre: 1 });
    expect(finding.deviationPct).toBe(2);
  });
});

describe('refuel interval too short for the distance', () => {
  test('after 10 km a 60 litre fill-up is flagged: the distance needed 3.2 litres', () => {
    const [finding] = judgeFillUp({ ...FILL, odometerKm: 10_010 }, TRUCK, null, RULES);
    expect(finding).toMatchObject({
      type: FILL_UP_ANOMALY.refuelIntervalTooShort,
      severity: 'high',
      expectedMl: 3_200,
      actualMl: 60_000,
      distanceKm: 10,
      details: { distance_km: 10, used_ml: 3_200, quantity_ml: 60_000, previous_odometer_km: 10_000, odometer_km: 10_010 },
    });
    expect(finding.deviationPct).toBe(1775);
  });

  test('it is a finding only above the configured excess: exactly 50% above is fine, a millilitre more is not', () => {
    // 300 km at 320 ml/km needed 96,000 ml; 50% above is 144,000.
    const base = { odometerKm: 10_300, previousOdometerKm: 10_000 };
    expect(types({ ...base, quantityMl: 144_000, totalCostCents: 1_224_000 })).not.toContain(FILL_UP_ANOMALY.refuelIntervalTooShort);
    expect(types({ ...base, quantityMl: 144_001, totalCostCents: 1_224_009 })).toContain(FILL_UP_ANOMALY.refuelIntervalTooShort);
  });

  test('a small excess is a measuring error whatever its percentage: under 20 litres more than needed is ignored', () => {
    // 10 km needed 3.2 litres; 20 litres is a huge percentage but only 16.8 litres more.
    expect(types({ odometerKm: 10_010, quantityMl: 20_000, totalCostCents: 170_000 })).not.toContain(FILL_UP_ANOMALY.refuelIntervalTooShort);
    // 3,200 + 20,000 = 23,200: exactly the minimum excess counts.
    expect(types({ odometerKm: 10_010, quantityMl: 3_200 + REFUEL_MIN_EXCESS_ML, totalCostCents: 197_200 })).toContain(FILL_UP_ANOMALY.refuelIntervalTooShort);
  });

  test('it is medium within twice the excess and high beyond it', () => {
    const base = { odometerKm: 10_200, previousOdometerKm: 10_000 }; // needed 64,000 ml
    const at = (quantityMl: number) => judgeFillUp({ ...FILL, ...base, quantityMl, totalCostCents: quantityMl * 8.5 }, TRUCK, null, RULES).find((f) => f.type === FILL_UP_ANOMALY.refuelIntervalTooShort);
    expect(at(110_000)?.severity).toBe('medium'); // 72% above
    expect(at(129_000)?.severity).toBe('high'); // above 100%
  });

  test('two fill-ups at the same odometer reading are flagged: nothing was driven, and its percentage is not defined', () => {
    const [finding] = judgeFillUp({ ...FILL, odometerKm: 10_000 }, TRUCK, null, RULES);
    expect(finding).toMatchObject({ type: FILL_UP_ANOMALY.refuelIntervalTooShort, expectedMl: 0, deviationPct: null, distanceKm: 0 });
  });

  test('it judges nothing without both readings, a rating, or for an electric vehicle', () => {
    for (const change of [{ previousOdometerKm: null }, { odometerKm: null }] as const) expect(types({ ...change, quantityMl: 150_000, totalCostCents: 1_275_000 })).not.toContain(FILL_UP_ANOMALY.refuelIntervalTooShort);
    expect(types({ odometerKm: 10_010 }, { fuelEfficiencyMlPerKm: null })).not.toContain(FILL_UP_ANOMALY.refuelIntervalTooShort);
    expect(types({ odometerKm: 10_010 }, { fuelType: 'electric' })).not.toContain(FILL_UP_ANOMALY.refuelIntervalTooShort);
  });

  test('a reading that went down is not a finding of this rule', () => {
    expect(types({ odometerKm: 9_900 })).not.toContain(FILL_UP_ANOMALY.refuelIntervalTooShort);
  });
});

describe('cost per litre outside the band', () => {
  test('what a litre cost is the total over the quantity, in whole cents', () => {
    expect(centsPerLitre(510_000, 60_000)).toBe(8_500);
    expect(centsPerLitre(100, 3)).toBe(33_333); // 33,333.33
    expect(centsPerLitre(2, 3)).toBe(667); // 666.67
  });

  test('above the band is a finding with the price and the band, below likewise; the edges are inside', () => {
    const at = (totalCostCents: number) => judgeFillUp({ ...FILL, totalCostCents }, TRUCK, null, RULES).find((f) => f.type === FILL_UP_ANOMALY.priceOutOfRange);
    expect(at(60_000 * 20)).toBeUndefined(); // 20,000 cents a litre: the max, inside
    expect(at(60_000 * 3)).toBeUndefined(); // 3,000: the min, inside
    const dear = at(1_260_000); // 21,000 cents a litre
    expect(dear).toMatchObject({ severity: 'medium', deviationPct: 5, details: { price_cents_per_litre: 21_000, band_min_cents_per_litre: 3_000, band_max_cents_per_litre: 20_000 } });
    const cheap = at(120_000); // 2,000
    expect(cheap).toMatchObject({ severity: 'medium', deviationPct: -33, details: { price_cents_per_litre: 2_000 } });
  });

  test('far outside the band is high: under half the minimum or over twice the maximum', () => {
    const at = (totalCostCents: number) => judgeFillUp({ ...FILL, totalCostCents }, TRUCK, null, RULES).find((f) => f.type === FILL_UP_ANOMALY.priceOutOfRange);
    expect(at(60_000 * 40)?.severity).toBe('medium'); // exactly twice the max
    expect(at(60_000 * 40 + 60)?.severity).toBe('high');
    expect(at(60_000 * 1.5)?.severity).toBe('medium'); // exactly half the min
    expect(at(0)?.severity).toBe('high'); // nothing paid
  });

  test('the band is the rules’, not fixed', () => {
    expect(types({}, {}, null, { priceMaxCentsPerLitre: 8_000 })).toContain(FILL_UP_ANOMALY.priceOutOfRange);
  });
});

describe('a fill-up away from where the vehicle was', () => {
  const addis = { latitude: 9.0108, longitude: 38.7613 };
  const seen = (latitude: number, longitude: number): VehiclePosition => ({ latitude, longitude, recordedAt: new Date('2026-10-30T08:00:00Z') });

  test('is a high finding with the distance and both positions when the fill-up is farther than the limit', () => {
    const [finding] = judgeFillUp({ ...FILL, ...addis }, TRUCK, seen(9.0108, 38.8613), RULES);
    expect(finding).toMatchObject({
      type: FILL_UP_ANOMALY.fillUpAwayFromVehicle,
      severity: 'high',
      distanceKm: 11,
      details: { distance_km: 11, max_km: 2, fill_latitude: 9.0108, vehicle_longitude: 38.8613, vehicle_seen_at: '2026-10-30T08:00:00.000Z' },
    });
  });

  test('close by is fine, and so is exactly the limit', () => {
    expect(types({ ...addis }, {}, seen(9.0208, 38.7613))).not.toContain(FILL_UP_ANOMALY.fillUpAwayFromVehicle); // 1.1 km
    const exact = { latitude: 9.0, longitude: 38.0 };
    const limit = haversineKm(exact, { latitude: 9.0, longitude: 38.02 });
    expect(types({ ...exact }, {}, seen(9.0, 38.02), { locationMaxKm: limit })).not.toContain(FILL_UP_ANOMALY.fillUpAwayFromVehicle);
    expect(types({ ...exact }, {}, seen(9.0, 38.02), { locationMaxKm: limit - 0.001 })).toContain(FILL_UP_ANOMALY.fillUpAwayFromVehicle);
  });

  test('judges nothing without a position for the fill-up or one of the vehicle', () => {
    expect(types({}, {}, seen(0, 0))).not.toContain(FILL_UP_ANOMALY.fillUpAwayFromVehicle);
    expect(types({ ...addis }, {}, null)).not.toContain(FILL_UP_ANOMALY.fillUpAwayFromVehicle);
    expect(types({ latitude: 9, longitude: null }, {}, seen(0, 0))).not.toContain(FILL_UP_ANOMALY.fillUpAwayFromVehicle);
  });
});

describe('haversineKm', () => {
  test('is 0 for the same point, and about 111 km for a degree of latitude', () => {
    expect(haversineKm({ latitude: 9, longitude: 38 }, { latitude: 9, longitude: 38 })).toBe(0);
    expect(haversineKm({ latitude: 9, longitude: 38 }, { latitude: 10, longitude: 38 })).toBeCloseTo(111.2, 1);
  });

  test('Addis Ababa to Adama is about 85 km', () => {
    expect(haversineKm({ latitude: 9.005401, longitude: 38.763611 }, { latitude: 8.54, longitude: 39.27 })).toBeGreaterThan(70);
    expect(haversineKm({ latitude: 9.005401, longitude: 38.763611 }, { latitude: 8.54, longitude: 39.27 })).toBeLessThan(90);
  });
});

describe('several rules at once', () => {
  test('a fill-up can break several, listed in a fixed order', () => {
    expect(types({ quantityMl: 300_000, totalCostCents: 300_000, odometerKm: 10_050 })).toEqual([
      FILL_UP_ANOMALY.tankCapacityExceeded,
      FILL_UP_ANOMALY.refuelIntervalTooShort,
      FILL_UP_ANOMALY.priceOutOfRange,
    ]);
  });
});

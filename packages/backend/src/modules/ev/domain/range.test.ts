import { describe, expect, test } from 'vitest';
import { capacityFromSessions, consumptionWhPerKm, crossings, estimateRange, rangeKm, rangeShortfall, DEFAULT_BATTERY_THRESHOLDS } from './range';

// FMS-98 (docs/ev.md#range): range = SoC × usable capacity × health ÷ consumption, in whole numbers.

describe('rangeKm', () => {
  test('state of charge × capacity × health ÷ Wh/km, rounded down to whole km', () => {
    // 80% of 71,700 Wh at 100% health is 57,360 Wh; at 180 Wh/km, 318.67 km.
    expect(rangeKm({ stateOfCharge: 80, capacityWh: 71_700, healthPct: 100, whPerKm: 180 })).toBe(318);
    // 92.5% health: 53,058 Wh, 294.77 km.
    expect(rangeKm({ stateOfCharge: 80, capacityWh: 71_700, healthPct: 92.5, whPerKm: 180 })).toBe(294);
    // No health applied (a capacity already measured): as at 100%.
    expect(rangeKm({ stateOfCharge: 80, capacityWh: 71_700, healthPct: null, whPerKm: 180 })).toBe(318);
  });

  test('integer arithmetic: exact at the boundaries, and the same for a bus’s pack as for a car’s', () => {
    expect(rangeKm({ stateOfCharge: 100, capacityWh: 50_000, healthPct: 100, whPerKm: 200 })).toBe(250);
    expect(rangeKm({ stateOfCharge: 0, capacityWh: 50_000, healthPct: 100, whPerKm: 200 })).toBe(0);
    expect(rangeKm({ stateOfCharge: 33.33, capacityWh: 350_000, healthPct: 97.41, whPerKm: 1000 })).toBe(113);
    expect(Number.isInteger(rangeKm({ stateOfCharge: 47.17, capacityWh: 77_000, healthPct: 88.88, whPerKm: 173 }))).toBe(true);
    // The largest pack the spec takes, full: no precision lost.
    expect(rangeKm({ stateOfCharge: 100, capacityWh: 2_000_000, healthPct: 100, whPerKm: 1 })).toBe(2_000_000);
  });

  test('no consumption or capacity gives 0, never a division by zero', () => {
    expect(rangeKm({ stateOfCharge: 50, capacityWh: 70_000, healthPct: 100, whPerKm: 0 })).toBe(0);
    expect(rangeKm({ stateOfCharge: 50, capacityWh: 0, healthPct: 100, whPerKm: 180 })).toBe(0);
  });
});

describe('the consumption and the capacity', () => {
  test('consumption: whole Wh/km, the mean of the readings; too few is unknown', () => {
    expect(consumptionWhPerKm([180, 190, 200.4])).toBe(190);
    expect(consumptionWhPerKm([180, 190])).toBeNull();
    expect(consumptionWhPerKm([180, 0, -3, 190])).toBeNull();
  });

  test('capacity from sessions: the median of energy into the battery over the share filled; small top-ups ignored', () => {
    // 41.2 kWh × 0.92 over 62 points: 61,135 Wh.
    expect(capacityFromSessions([{ energy_kwh: 41.2, start_soc: 18, end_soc: 80 }])).toBe(61_135);
    expect(
      capacityFromSessions([
        { energy_kwh: 40, start_soc: 20, end_soc: 80 },
        { energy_kwh: 10, start_soc: 20, end_soc: 30 },
        { energy_kwh: 46, start_soc: 10, end_soc: 80 },
        { energy_kwh: 90, start_soc: 10, end_soc: 90 },
      ]),
    ).toBe(61_333);
    expect(capacityFromSessions([{ energy_kwh: 5, start_soc: 70, end_soc: 80 }])).toBeNull();
  });
});

describe('estimateRange', () => {
  const latest = { state_of_charge: 50, battery_health: 90, recorded_at: new Date('2026-11-26T09:00:00Z') };
  const readings = [180, 180, 180];

  test('from the spec, scaled by the newest health', () => {
    const { estimate, gap } = estimateRange({ latest, health: 90, readingsWhPerKm: readings, specKwh: 71.7, sessions: [] });
    expect(gap).toBeNull();
    expect(estimate).toMatchObject({ range_km: 179, wh_per_km: 180, usable_capacity_kwh: 71.7, capacity_source: 'spec', battery_health: 90 });
  });

  test('without a spec, from the sessions, with no health applied again', () => {
    const { estimate } = estimateRange({ latest, health: 90, readingsWhPerKm: readings, specKwh: null, sessions: [{ energy_kwh: 41.2, start_soc: 18, end_soc: 80 }] });
    expect(estimate).toMatchObject({ range_km: 169, capacity_source: 'sessions', usable_capacity_kwh: 61.14 });
  });

  test('says why there is none', () => {
    expect(estimateRange({ latest: null, health: null, readingsWhPerKm: readings, specKwh: 70, sessions: [] }).gap).toBe('no_reading');
    expect(estimateRange({ latest, health: 90, readingsWhPerKm: [180], specKwh: 70, sessions: [] }).gap).toBe('no_consumption');
    expect(estimateRange({ latest, health: 90, readingsWhPerKm: readings, specKwh: null, sessions: [] }).gap).toBe('no_capacity');
  });
});

describe('the thresholds', () => {
  const t = DEFAULT_BATTERY_THRESHOLDS;

  test('below 20% raises the charge alert once: the reading before was above the line', () => {
    expect(crossings({ state_of_charge: 18, battery_health: 95 }, { state_of_charge: 25, battery_health: 95 }, t)).toEqual([
      { metric: 'state_of_charge', value: 18, threshold: 20, severity: 'high' },
    ]);
    expect(crossings({ state_of_charge: 15, battery_health: 95 }, { state_of_charge: 18, battery_health: 95 }, t)).toEqual([]);
    expect(crossings({ state_of_charge: 9, battery_health: 95 }, null, t)).toEqual([{ metric: 'state_of_charge', value: 9, threshold: 20, severity: 'critical' }]);
    expect(crossings({ state_of_charge: 20, battery_health: 95 }, null, t)).toEqual([]);
  });

  test('a battery worn below 80% raises the degradation alert once', () => {
    expect(crossings({ state_of_charge: 60, battery_health: 79.5 }, { state_of_charge: 70, battery_health: 80.1 }, t)).toEqual([
      { metric: 'battery_health', value: 79.5, threshold: 80, severity: 'medium' },
    ]);
    expect(crossings({ state_of_charge: 60, battery_health: 79 }, { state_of_charge: 70, battery_health: 79.5 }, t)).toEqual([]);
    expect(crossings({ state_of_charge: 60, battery_health: null }, null, t)).toEqual([]);
  });

  test('a range short of the km left: high, or critical when under half', () => {
    expect(rangeShortfall(120, 100)).toBeNull();
    expect(rangeShortfall(80, 100.4)).toEqual({ metric: 'range', value: 80, threshold: 101, severity: 'high' });
    expect(rangeShortfall(40, 100)).toMatchObject({ severity: 'critical' });
    expect(rangeShortfall(0, 0)).toBeNull();
  });
});

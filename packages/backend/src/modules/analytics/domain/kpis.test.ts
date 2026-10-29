import { describe, expect, it } from 'vitest';
import { cacheRow } from '../application/analytics.service';
import { addisDay, costPerKm, isStale, km, mlPerKm, pct, rangeOf, shiftDay } from './kpis';

describe('analytics KPIs (FMS-50)', () => {
  it('are integers, rounded half away from zero, null without a denominator', () => {
    expect(costPerKm(12_345, 123_456)).toBe(100);
    expect(costPerKm(5, 1_000_000)).toBe(0);
    expect(costPerKm(100, 0)).toBeNull();
    expect(pct(1, 3)).toBe(33);
    expect(pct(1, 2)).toBe(50);
    expect(pct(1, 200)).toBe(1);
    expect(pct(0, 0)).toBeNull();
    expect(mlPerKm(40_000, 123_456)).toBe(324);
    expect(km(1_500)).toBe(2);
  });

  it('defaults to the 30 days to today, never goes past today, refuses a reversed or too long range', () => {
    const now = new Date('2026-10-29T22:30:00Z'); // 01:30 on the 30th in Addis Ababa
    expect(addisDay(now)).toBe('2026-10-30');
    expect(rangeOf({}, now)).toEqual({ from: '2026-10-01', to: '2026-10-30', days: 30 });
    expect(rangeOf({ from: '2026-10-01', to: '2026-12-31' }, now)).toEqual({ from: '2026-10-01', to: '2026-10-30', days: 30 });
    expect(rangeOf({ from: '2026-02-01', to: '2026-02-28' }, now).days).toBe(28);
    expect(() => rangeOf({ from: '2026-10-10', to: '2026-10-09' }, now)).toThrow();
    expect(() => rangeOf({ from: '2025-01-01' }, now)).toThrow();
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('is stale after 25 hours without a refresh, or when never filled', () => {
    const now = new Date('2026-10-29T12:00:00Z');
    expect(isStale(null, now)).toBe(true);
    expect(isStale(new Date('2026-10-28T11:00:00Z'), now)).toBe(false);
    expect(isStale(new Date('2026-10-28T10:59:00Z'), now)).toBe(true);
  });

  it('caches a day with its ratios beside the raw figures', () => {
    const day = { vehicleId: '1', day: '2026-10-28', used: true, distanceM: 200_000, tripsCompleted: 2, tripsTimed: 2, tripsOnTime: 1, fuelMl: 60_000, fuelCostCents: 9_000, maintenanceCostCents: 1_000 };
    expect(cacheRow(day)).toMatchObject({ utilisationPct: 100, costPerKmCents: 50, onTimePct: 50 });
    expect(cacheRow({ ...day, used: false, distanceM: 0, tripsCompleted: 0, tripsTimed: 0, tripsOnTime: 0 })).toMatchObject({ utilisationPct: 0, costPerKmCents: 0, onTimePct: null });
  });
});

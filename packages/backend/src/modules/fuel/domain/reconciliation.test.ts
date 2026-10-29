import { describe, expect, test } from 'vitest';
import { expectedMl, judge, previousMonth, roundDiv, severityOf, type VehicleUsage } from './reconciliation';

const diesel = { fuelType: 'diesel' as const, fuelEfficiencyMlPerKm: 320 };
const usage = (km: number, actualMl: number): VehicleUsage => ({ distanceM: km * 1000, trips: 1, actualMl, fuelLogs: 1, costCents: 0 });

describe('roundDiv: integer division, rounded half away from zero', () => {
  test('rounds to the nearest whole number, halves away from zero', () => {
    expect(roundDiv(7, 2)).toBe(4);
    expect(roundDiv(-7, 2)).toBe(-4);
    expect(roundDiv(5, 3)).toBe(2);
    expect(roundDiv(4, 3)).toBe(1);
    expect(roundDiv(-4, 3)).toBe(-1);
    expect(roundDiv(0, 9)).toBe(0);
  });

  test('stays exact where a float would not: a 15-digit numerator', () => {
    // 2^53 - 1 is the largest safe integer; (2^53 - 1) / 2 is ...4095.5, rounded up.
    expect(roundDiv(Number.MAX_SAFE_INTEGER, 2)).toBe(4503599627370496);
  });

  test('refuses anything but integers and a positive divisor', () => {
    expect(() => roundDiv(1.5, 2)).toThrow(RangeError);
    expect(() => roundDiv(1, 0)).toThrow(RangeError);
  });
});

describe('judge: a period against the vehicle rating (FMS-41)', () => {
  test('25% over what the distance needs is above the 20% threshold; 15% is within', () => {
    // 1,000 km at 320 ml/km needs 320 L.
    expect(expectedMl(1_000_000, 320)).toBe(320_000);
    expect(judge(diesel, usage(1000, 400_000), 20)).toEqual({ expectedMl: 320_000, varianceMl: 80_000, variancePct: 25, status: 'above', reason: null });
    expect(judge(diesel, usage(1000, 368_000), 20)).toMatchObject({ variancePct: 15, status: 'within' });
  });

  test('below by more than the threshold is an anomaly too; exactly at it is within', () => {
    expect(judge(diesel, usage(1000, 240_000), 20)).toMatchObject({ variancePct: -25, status: 'below' });
    expect(judge(diesel, usage(1000, 384_000), 20)).toMatchObject({ variancePct: 20, status: 'within' });
    expect(judge(diesel, usage(1000, 256_000), 20)).toMatchObject({ variancePct: -20, status: 'within' });
  });

  test('the variance is a whole percent, rounded: 20.4% is within, 20.5% is above', () => {
    expect(judge(diesel, usage(1000, 385_280), 20)).toMatchObject({ variancePct: 20, status: 'within' });
    expect(judge(diesel, usage(1000, 385_600), 20)).toMatchObject({ variancePct: 21, status: 'above' });
  });

  test('the expected fuel of a part of a kilometre is rounded to the millilitre', () => {
    // 123.457 km at 287 ml/km = 35,432.159 ml.
    expect(expectedMl(123_457, 287)).toBe(35_432);
  });

  test('not judged: electric, no rating, or too little driving to tell', () => {
    expect(judge({ fuelType: 'electric', fuelEfficiencyMlPerKm: null }, usage(1000, 0), 20)).toMatchObject({ status: 'not_judged', reason: 'electric', variancePct: null });
    expect(judge({ fuelType: 'diesel', fuelEfficiencyMlPerKm: null }, usage(1000, 1), 20)).toMatchObject({ reason: 'no_efficiency' });
    expect(judge(diesel, usage(99, 60_000), 20)).toMatchObject({ reason: 'too_little_distance', expectedMl: null });
    expect(judge(diesel, usage(100, 60_000), 20)).toMatchObject({ status: 'above' });
  });

  test('the threshold comes from config', () => {
    expect(judge(diesel, usage(1000, 368_000), 10)).toMatchObject({ status: 'above' });
  });
});

describe('severity and period', () => {
  test('beyond twice the threshold is high, otherwise medium', () => {
    expect(severityOf(25, 20)).toBe('medium');
    expect(severityOf(-40, 20)).toBe('medium');
    expect(severityOf(41, 20)).toBe('high');
    expect(severityOf(-60, 20)).toBe('high');
  });

  test('the month before a local day, as Addis Ababa midnights', () => {
    expect(previousMonth('2026-11-01')).toEqual({ from: new Date('2026-10-01T00:00:00+03:00'), to: new Date('2026-11-01T00:00:00+03:00') });
    expect(previousMonth('2026-01-15')).toEqual({ from: new Date('2025-12-01T00:00:00+03:00'), to: new Date('2026-01-01T00:00:00+03:00') });
  });
});

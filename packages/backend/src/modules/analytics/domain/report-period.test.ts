import { describe, expect, test } from 'vitest';
import { MAX_RANGE_DAYS, monthsBefore, previousPeriod, resolvePeriod } from './report-period';

// FMS-160: a report's period, in Addis Ababa days.

const NOW = new Date('2026-11-25T09:00:00+03:00');
const reason = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return (err as { details?: { field: string; reason: string }[] }).details?.[0];
  }
  return null;
};

describe('resolvePeriod', () => {
  test('a month, as FMS-91 read it; this month when nothing is given, up to now', () => {
    expect(resolvePeriod({ month: '2026-10' }, NOW)).toMatchObject({ kind: 'month', key: '2026-10', label: 'October 2026', from: '2026-10-01', to: '2026-10-31', month: '2026-10' });
    const current = resolvePeriod({}, NOW);
    expect(current).toMatchObject({ kind: 'month', key: '2026-11', from: '2026-11-01' });
    expect(current.end).toEqual(NOW);
    expect(resolvePeriod({ month: '2026-10' }, NOW).start.toISOString()).toBe('2026-09-30T21:00:00.000Z');
  });

  test('a quarter, a year and a custom range', () => {
    expect(resolvePeriod({ quarter: '2026-Q3' }, NOW)).toMatchObject({ kind: 'quarter', label: 'Q3 2026', from: '2026-07-01', to: '2026-09-30', month: null });
    expect(resolvePeriod({ year: '2025' }, NOW)).toMatchObject({ kind: 'year', from: '2025-01-01', to: '2025-12-31' });
    const r = resolvePeriod({ from: '2026-01-01', to: '2026-03-15' }, NOW);
    expect(r).toMatchObject({ kind: 'range', key: '2026-01-01..2026-03-15', label: '1 Jan 2026 to 15 Mar 2026' });
    expect(r.end.toISOString()).toBe('2026-03-15T21:00:00.000Z');
  });

  test('a range of up to 366 days, both ends included', () => {
    expect(MAX_RANGE_DAYS).toBe(366);
    expect(() => resolvePeriod({ from: '2025-01-01', to: '2026-01-01' }, NOW)).not.toThrow();
    expect(reason(() => resolvePeriod({ from: '2025-01-01', to: '2026-01-02' }, NOW))).toEqual({ field: 'to', reason: 'range_too_long' });
  });

  test('refused: two kinds at once, half a range, backwards, malformed, or not yet begun', () => {
    expect(reason(() => resolvePeriod({ month: '2026-10', year: '2026' }, NOW))).toEqual({ field: 'period', reason: 'one_period' });
    expect(reason(() => resolvePeriod({ from: '2026-01-01' }, NOW))).toEqual({ field: 'to', reason: 'required' });
    expect(reason(() => resolvePeriod({ from: '2026-02-01', to: '2026-01-01' }, NOW))).toEqual({ field: 'to', reason: 'before_from' });
    expect(reason(() => resolvePeriod({ quarter: '2026-Q5' }, NOW))).toEqual({ field: 'quarter', reason: 'invalid_format' });
    expect(reason(() => resolvePeriod({ month: '2026-13' }, NOW))).toEqual({ field: 'month', reason: 'invalid_format' });
    expect(reason(() => resolvePeriod({ month: '2026-12' }, NOW))).toEqual({ field: 'month', reason: 'future_month' });
    expect(reason(() => resolvePeriod({ year: '2027' }, NOW))).toEqual({ field: 'year', reason: 'future_period' });
  });
});

describe('previousPeriod and monthsBefore', () => {
  test('the period before is as long: last month, last quarter, last year, the days before a range', () => {
    expect(previousPeriod(resolvePeriod({ month: '2026-01' }, NOW), NOW)).toMatchObject({ key: '2025-12' });
    expect(previousPeriod(resolvePeriod({ quarter: '2026-Q1' }, NOW), NOW)).toMatchObject({ key: '2025-Q4' });
    expect(previousPeriod(resolvePeriod({ year: '2026' }, NOW), NOW)).toMatchObject({ key: '2025' });
    expect(previousPeriod(resolvePeriod({ from: '2026-03-11', to: '2026-03-20' }, NOW), NOW)).toMatchObject({ from: '2026-03-01', to: '2026-03-10' });
  });

  test('the months up to a period end, oldest first', () => {
    expect(monthsBefore(resolvePeriod({ month: '2026-02' }, NOW).end, 3)).toEqual(['2025-12', '2026-01', '2026-02']);
  });
});

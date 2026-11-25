import { describe, expect, test } from 'vitest';
import { isoWeekday, nextRunAt, periodFor } from './report-schedule';

// FMS-160: when a report schedule runs, in Addis Ababa (UTC+3), and the period each run covers.

const at = (s: string) => new Date(`${s}+03:00`);

describe('nextRunAt', () => {
  test('daily: the next time the hour comes round', () => {
    expect(nextRunAt('daily', null, 7, at('2026-11-25T06:59:00'))).toEqual(at('2026-11-25T07:00:00'));
    expect(nextRunAt('daily', null, 7, at('2026-11-25T07:00:00'))).toEqual(at('2026-11-26T07:00:00'));
  });

  test('weekly: the weekday (1 Monday to 7 Sunday) at the hour', () => {
    expect(isoWeekday('2026-11-25')).toBe(3);
    expect(isoWeekday('2026-11-29')).toBe(7);
    expect(nextRunAt('weekly', 1, 7, at('2026-11-25T12:00:00'))).toEqual(at('2026-11-30T07:00:00'));
    expect(nextRunAt('weekly', 3, 7, at('2026-11-25T06:00:00'))).toEqual(at('2026-11-25T07:00:00'));
    expect(nextRunAt('weekly', 3, 7, at('2026-11-25T07:00:00'))).toEqual(at('2026-12-02T07:00:00'));
  });

  test('monthly: the day of the month at the hour', () => {
    expect(nextRunAt('monthly', 1, 6, at('2026-11-25T12:00:00'))).toEqual(at('2026-12-01T06:00:00'));
    expect(nextRunAt('monthly', 28, 0, at('2027-02-01T00:00:00'))).toEqual(at('2027-02-28T00:00:00'));
  });
});

describe('periodFor', () => {
  test('a daily run covers yesterday; a weekly one last Monday to Sunday; a monthly one last month', () => {
    expect(periodFor('daily', at('2026-11-25T07:00:00'))).toEqual({ from: '2026-11-24', to: '2026-11-24' });
    expect(periodFor('daily', at('2026-03-01T00:30:00'))).toEqual({ from: '2026-02-28', to: '2026-02-28' });
    expect(periodFor('weekly', at('2026-11-30T07:00:00'))).toEqual({ from: '2026-11-23', to: '2026-11-29' });
    expect(periodFor('weekly', at('2026-11-25T07:00:00'))).toEqual({ from: '2026-11-16', to: '2026-11-22' });
    expect(periodFor('monthly', at('2026-12-01T06:00:00'))).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(periodFor('monthly', at('2026-01-15T06:00:00'))).toEqual({ from: '2025-12-01', to: '2025-12-31' });
  });
});

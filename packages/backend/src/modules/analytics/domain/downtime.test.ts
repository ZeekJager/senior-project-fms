import { describe, expect, test } from 'vitest';
import { addTotals, downtimeKpis, monthWindow, vehicleTotals, type DowntimeFact } from './downtime';

const REASONS = ['planned_service', 'unplanned_repair', 'breakdown'];
const local = (iso: string) => new Date(`${iso}+03:00`);
const fact = (from: string, to: string | null, reason: string, unplanned: boolean): DowntimeFact => ({
  startedAt: local(from),
  endedAt: to ? local(to) : null,
  reason,
  unplanned,
});

describe('downtime KPIs (FMS-131): a hand-computed September', () => {
  // September in Addis Ababa: 30 days, 43,200 minutes.
  const september = monthWindow('2026-09', local('2026-10-31T12:00:00'));
  const truck = vehicleTotals(
    { joinedAt: local('2025-01-01T00:00:00'), retiredAt: null },
    [
      // A repair from August: 12 of its 24 hours are September's; it ended in September, so it is a repair of September's.
      fact('2026-08-31T12:00:00', '2026-09-01T12:00:00', 'unplanned_repair', true),
      fact('2026-09-05T08:00:00', '2026-09-07T08:00:00', 'planned_service', false), // 48 h, planned
      fact('2026-09-10T06:00:00', '2026-09-10T18:00:00', 'breakdown', true), // 12 h
      fact('2026-09-20T00:00:00', '2026-09-21T00:00:00', 'unplanned_repair', true), // 24 h
    ],
    september,
  )!;

  test('one vehicle: availability, MTBF and MTTR', () => {
    // Down 12 + 48 + 12 + 24 = 96 h = 5,760 min; up 43,200 - 5,760 = 37,440 min; 37,440 / 43,200 = 86.67%.
    // Two failures began in September: MTBF 37,440 / 2 = 18,720 min.
    // Three repairs ended in September, 24 + 12 + 24 = 60 h whole: MTTR 3,600 / 3 = 1,200 min.
    expect(downtimeKpis(truck, REASONS)).toEqual({
      in_fleet_minutes: 43_200,
      uptime_minutes: 37_440,
      downtime_minutes: 5_760,
      unplanned_downtime_minutes: 2_880,
      availability_pct: 86.7,
      failures: 2,
      mtbf_minutes: 18_720,
      repairs: 3,
      mttr_minutes: 1_200,
      downtime_by_reason: { planned_service: 2_880, unplanned_repair: 2_160, breakdown: 720 },
    });
  });

  test('a depot: time in the fleet counts from when a vehicle joined; nothing to divide by is null', () => {
    // Joined on 16 September: 15 days, 21,600 minutes, never down.
    const van = vehicleTotals({ joinedAt: local('2026-09-16T00:00:00'), retiredAt: null }, [], september)!;
    expect(downtimeKpis(van, REASONS)).toMatchObject({ in_fleet_minutes: 21_600, availability_pct: 100, failures: 0, mtbf_minutes: null, mttr_minutes: null });
    // Together: up 37,440 + 21,600 = 59,040 of 64,800 min = 91.1%; MTBF 59,040 / 2 = 29,520.
    const depot = addTotals(truck, van);
    expect(depot.vehicles).toBe(2);
    expect(downtimeKpis(depot, REASONS)).toMatchObject({ in_fleet_minutes: 64_800, availability_pct: 91.1, mtbf_minutes: 29_520, mttr_minutes: 1_200 });
  });

  test('a vehicle retired before the month, or not yet registered, is not in it; one still down is down to the end', () => {
    expect(vehicleTotals({ joinedAt: local('2025-01-01T00:00:00'), retiredAt: local('2026-08-01T00:00:00') }, [], september)).toBeNull();
    expect(vehicleTotals({ joinedAt: local('2026-10-02T00:00:00'), retiredAt: null }, [], september)).toBeNull();
    const down = vehicleTotals({ joinedAt: local('2025-01-01T00:00:00'), retiredAt: null }, [fact('2026-09-30T00:00:00', null, 'breakdown', true)], september)!;
    expect(downtimeKpis(down, REASONS)).toMatchObject({ downtime_minutes: 1_440, failures: 1, repairs: 0, mttr_minutes: null });
  });
});

describe('monthWindow', () => {
  const now = local('2026-10-31T12:00:00');
  test('this month by default, up to now; a past month whole', () => {
    expect(monthWindow(undefined, now)).toEqual({ month: '2026-10', start: local('2026-10-01T00:00:00'), end: now });
    expect(monthWindow('2025-12', now)).toEqual({ month: '2025-12', start: local('2025-12-01T00:00:00'), end: local('2026-01-01T00:00:00') });
  });

  test('a month not yet begun or badly written is refused', () => {
    expect(() => monthWindow('2026-11', now)).toThrow('That month has not begun.');
    expect(() => monthWindow('2026-13', now)).toThrow('`month` must be YYYY-MM.');
  });
});

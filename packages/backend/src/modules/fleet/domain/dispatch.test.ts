import { describe, expect, test } from 'vitest';
import type { AvailabilityResult } from './availability';
import { NEAR_END_MINUTES, drivableTypes, driverBoardState, vehicleBoardState, withDistance, type BoardDistance } from './dispatch';

const now = new Date('2026-11-02T06:00:00Z');
const free: AvailabilityResult = { availability: 'available', reasons: [] };
const blocked: AvailabilityResult = { availability: 'unavailable', reasons: [{ code: 'assigned_to_overlapping_trip', severity: 'block', trip_id: 't-1' }] };
const minutes = (m: number) => new Date(now.getTime() + m * 60_000);

describe('driver state on the board (FMS-33)', () => {
  test('present (or not yet marked) and free: idle (green)', () => {
    expect(driverBoardState({ underWay: null, attendance: 'present', availability: free, now })).toBe('idle');
    expect(driverBoardState({ underWay: null, attendance: null, availability: free, now })).toBe('idle');
  });

  test('under way: en_route (red), or near_end (amber) when finishing within the threshold or late', () => {
    expect(driverBoardState({ underWay: { tripId: 't', end: minutes(NEAR_END_MINUTES + 1) }, attendance: 'present', availability: free, now })).toBe('en_route');
    expect(driverBoardState({ underWay: { tripId: 't', end: minutes(NEAR_END_MINUTES) }, attendance: 'present', availability: free, now })).toBe('near_end');
    expect(driverBoardState({ underWay: { tripId: 't', end: minutes(-10) }, attendance: 'present', availability: free, now })).toBe('near_end');
  });

  test.each(['absent', 'on_leave', 'sick'] as const)('%s today: absent (grey), before any availability block', (attendance) => {
    expect(driverBoardState({ underWay: null, attendance, availability: blocked, now })).toBe('absent');
  });

  test('blocked for the window (another trip then, licence, account): unavailable', () => {
    expect(driverBoardState({ underWay: null, attendance: 'late', availability: blocked, now })).toBe('unavailable');
  });
});

describe('vehicle state on the board (FMS-33)', () => {
  test('idle (green), flagged or in the workshop (red), under way (grey), otherwise blocked (unavailable)', () => {
    expect(vehicleBoardState({ status: 'active', maintenanceFlag: false, underWay: null, availability: free })).toBe('idle');
    expect(vehicleBoardState({ status: 'active', maintenanceFlag: true, underWay: { tripId: 't', end: now }, availability: blocked })).toBe('flagged');
    expect(vehicleBoardState({ status: 'maintenance', maintenanceFlag: false, underWay: null, availability: blocked })).toBe('flagged');
    expect(vehicleBoardState({ status: 'active', maintenanceFlag: false, underWay: { tripId: 't', end: now }, availability: blocked })).toBe('en_route');
    expect(vehicleBoardState({ status: 'inactive', maintenanceFlag: false, underWay: null, availability: blocked })).toBe('unavailable');
  });
});

describe('drivable vehicle types', () => {
  test('from the licence categories, in vehicle-type order, without duplicates', () => {
    expect(drivableTypes([])).toEqual([]);
    expect(drivableTypes(['automobile'])).toEqual(expect.arrayContaining(['car']));
    expect(drivableTypes(['dry_cargo_2'])).toContain('truck');
    expect(drivableTypes(['automobile', 'automobile'])).toEqual(drivableTypes(['automobile']));
    expect(drivableTypes(['nonsense'])).toEqual([]);
  });
});

describe('the driving distance limits on the board (FMS-156)', () => {
  const p = (period: 'day' | 'week', limit: number, withTrip: number) => ({ period, limit_km: limit, without_km: withTrip - 100, with_km: withTrip, left_km: limit - withTrip });
  const standing = (over: boolean, near: boolean): BoardDistance => ({
    trip_km: 100,
    day: p('day', 500, over ? 560 : near ? 420 : 300),
    week: p('week', 2500, 900),
    over: over ? p('day', 500, 560) : null,
    near: near ? p('day', 500, 420) : null,
  });

  test('past a limit blocks, naming the period, the limit and the total; blocks come first', () => {
    const withWarning: AvailabilityResult = { availability: 'available_with_warning', reasons: [{ code: 'driver_absent', severity: 'warning' }] };
    expect(withDistance(withWarning, standing(true, false))).toEqual({
      availability: 'unavailable',
      reasons: [
        { code: 'distance_limit', severity: 'block', period: 'day', limit_km: 500, total_km: 560 },
        { code: 'driver_absent', severity: 'warning' },
      ],
    });
    expect(driverBoardState({ underWay: null, attendance: null, availability: withDistance(free, standing(true, false)), now })).toBe('unavailable');
  });

  test('at 80% of one it only warns; below, or without a trip, nothing changes', () => {
    expect(withDistance(free, standing(false, true))).toEqual({
      availability: 'available_with_warning',
      reasons: [{ code: 'distance_limit_near', severity: 'warning', period: 'day', limit_km: 500, total_km: 420 }],
    });
    expect(withDistance(free, standing(false, false))).toBe(free);
    expect(withDistance(blocked, null)).toBe(blocked);
  });
});

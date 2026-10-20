import { describe, expect, test } from 'vitest';
import type { AvailabilityResult } from './availability';
import { NEAR_END_MINUTES, drivableTypes, driverBoardState, vehicleBoardState } from './dispatch';

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
    expect(drivableTypes(['B'])).toEqual(expect.arrayContaining(['car']));
    expect(drivableTypes(['C'])).toContain('truck');
    expect(drivableTypes(['B', 'B'])).toEqual(drivableTypes(['B']));
    expect(drivableTypes(['nonsense'])).toEqual([]);
  });
});

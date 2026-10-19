import { describe, expect, test } from 'vitest';
import { STATUS_TRANSITIONS, canTransition, driverAvailability, vehicleAvailability, type DriverFacts, type VehicleFacts } from './availability';
import { VEHICLE_STATUSES } from './vehicle';

const vehicle = (f: Partial<VehicleFacts> = {}): VehicleFacts => ({ depotId: '5', status: 'active', maintenanceFlag: false, overlappingTrips: [], ...f });
const driver = (f: Partial<DriverFacts> = {}): DriverFacts => ({
  depotId: '5',
  isActive: true,
  accountStatus: 'active',
  licenseValid: true,
  attendance: null,
  overlappingTrips: [],
  ...f,
});

describe('vehicle availability matrix', () => {
  test('active, not flagged, no overlapping trip: available, no reasons', () => {
    expect(vehicleAvailability(vehicle())).toEqual({ availability: 'available', reasons: [] });
  });

  test.each([
    [{ maintenanceFlag: true }, 'maintenance_flag'],
    [{ status: 'maintenance' as const }, 'vehicle_in_maintenance'],
    [{ status: 'inactive' as const }, 'vehicle_out_of_service'],
    [{ status: 'retired' as const }, 'vehicle_retired'],
  ])('%o is unavailable with %s', (facts, code) => {
    expect(vehicleAvailability(vehicle(facts))).toEqual({ availability: 'unavailable', reasons: [{ code, severity: 'block' }] });
  });

  test('an overlapping trip is unavailable, naming each trip', () => {
    expect(vehicleAvailability(vehicle({ overlappingTrips: ['t-1', 't-2'] }))).toEqual({
      availability: 'unavailable',
      reasons: [
        { code: 'assigned_to_overlapping_trip', severity: 'block', trip_id: 't-1' },
        { code: 'assigned_to_overlapping_trip', severity: 'block', trip_id: 't-2' },
      ],
    });
  });

  test('every reason that applies is reported, not only the first', () => {
    const result = vehicleAvailability(vehicle({ status: 'maintenance', maintenanceFlag: true, overlappingTrips: ['t-1'] }), '6');
    expect(result.reasons.map((r) => r.code)).toEqual(['vehicle_in_maintenance', 'maintenance_flag', 'vehicle_other_depot', 'assigned_to_overlapping_trip']);
  });

  test("asked for a depot's trip: only that depot's vehicles are available; without a depot, any", () => {
    expect(vehicleAvailability(vehicle(), '5').availability).toBe('available');
    expect(vehicleAvailability(vehicle(), '6')).toEqual({ availability: 'unavailable', reasons: [{ code: 'vehicle_other_depot', severity: 'block' }] });
    expect(vehicleAvailability(vehicle()).availability).toBe('available');
  });
});

describe('driver availability matrix', () => {
  test('active driver, active account, valid licence, nothing recorded, no trips: available', () => {
    expect(driverAvailability(driver())).toEqual({ availability: 'available', reasons: [] });
  });

  test.each([
    ['absent', 'driver_absent'],
    ['on_leave', 'driver_on_leave'],
    ['sick', 'driver_sick'],
  ] as const)('marked %s: available with a warning (%s), not a block', (attendance, code) => {
    expect(driverAvailability(driver({ attendance }))).toEqual({ availability: 'available_with_warning', reasons: [{ code, severity: 'warning' }] });
  });

  test.each(['present', 'late', 'other'] as const)('marked %s: available, no warning', (attendance) => {
    expect(driverAvailability(driver({ attendance })).availability).toBe('available');
  });

  test.each([
    [{ isActive: false }, 'driver_retired'],
    [{ accountStatus: 'suspended' }, 'account_not_active'],
    [{ accountStatus: 'unknown' }, 'account_not_active'],
    [{ licenseValid: false }, 'license_expired'],
  ])('%o is unavailable with %s', (facts, code) => {
    expect(driverAvailability(driver(facts))).toEqual({ availability: 'unavailable', reasons: [{ code, severity: 'block' }] });
  });

  test("asked for a depot's trip: a driver of another depot, or with no depot, is unavailable", () => {
    expect(driverAvailability(driver(), '5').availability).toBe('available');
    expect(driverAvailability(driver(), '6')).toEqual({ availability: 'unavailable', reasons: [{ code: 'driver_other_depot', severity: 'block' }] });
    expect(driverAvailability(driver({ depotId: null }), '5').reasons).toEqual([{ code: 'driver_other_depot', severity: 'block' }]);
    expect(driverAvailability(driver({ depotId: null })).availability).toBe('available');
  });

  test('a block outranks a warning: unavailable, blocks listed first, the warning kept', () => {
    expect(driverAvailability(driver({ attendance: 'absent', overlappingTrips: ['t-9'] }))).toEqual({
      availability: 'unavailable',
      reasons: [
        { code: 'assigned_to_overlapping_trip', severity: 'block', trip_id: 't-9' },
        { code: 'driver_absent', severity: 'warning' },
      ],
    });
  });
});

describe('status transitions', () => {
  test('active, maintenance and out of service (inactive) move freely between each other and to retired', () => {
    for (const from of ['active', 'maintenance', 'inactive'] as const) {
      for (const to of ['active', 'maintenance', 'inactive', 'retired'] as const) {
        expect(canTransition(from, to)).toBe(from !== to);
      }
    }
  });

  test('nothing leaves retired', () => {
    for (const to of VEHICLE_STATUSES) expect(canTransition('retired', to)).toBe(false);
  });

  test('every status has its transitions, and the legacy decommissioned is gone', () => {
    expect(Object.keys(STATUS_TRANSITIONS).sort()).toEqual([...VEHICLE_STATUSES].sort());
    expect(VEHICLE_STATUSES).not.toContain('decommissioned');
  });
});

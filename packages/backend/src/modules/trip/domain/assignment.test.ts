import { describe, expect, test } from 'vitest';
import { readAvailability, type AvailabilityAnswer } from './assignment';

const available: AvailabilityAnswer = { availability: 'available', reasons: [] };
const blocked = (...codes: string[]): AvailabilityAnswer => ({ availability: 'unavailable', reasons: codes.map((code) => ({ code, severity: 'block' })) });
const warned = (...codes: string[]): AvailabilityAnswer => ({ availability: 'available_with_warning', reasons: codes.map((code) => ({ code, severity: 'warning' })) });

describe('assignment reading of fleet availability (FMS-31 on FMS-76)', () => {
  test('available vehicle and driver: no refusal, no warning', () => {
    expect(readAvailability(available, available)).toEqual({ refusal: null, warnings: [] });
  });

  test.each([
    ['vehicle_other_depot', { kind: 'depot', field: 'vehicle_id' }],
    ['vehicle_retired', { kind: 'vehicle_not_active', status: 'retired' }],
    ['vehicle_out_of_service', { kind: 'vehicle_not_active', status: 'inactive' }],
    ['maintenance_flag', { kind: 'vehicle_flagged' }],
    ['vehicle_in_maintenance', { kind: 'vehicle_flagged' }],
  ])('vehicle %s refuses as %o', (code, refusal) => {
    expect(readAvailability(blocked(code), available).refusal).toEqual(refusal);
  });

  test('a driver of another depot is refused', () => {
    expect(readAvailability(available, blocked('driver_other_depot')).refusal).toEqual({ kind: 'depot', field: 'driver_id' });
  });

  test('first refusal wins: depot, then not active, then flagged, then the driver', () => {
    expect(readAvailability(blocked('maintenance_flag', 'vehicle_out_of_service', 'vehicle_other_depot'), blocked('driver_other_depot')).refusal).toEqual({
      kind: 'depot',
      field: 'vehicle_id',
    });
    expect(readAvailability(blocked('maintenance_flag', 'vehicle_out_of_service'), available).refusal).toEqual({ kind: 'vehicle_not_active', status: 'inactive' });
    expect(readAvailability(blocked('maintenance_flag'), blocked('driver_other_depot')).refusal).toEqual({ kind: 'vehicle_flagged' });
  });

  test("overlaps and the driver's eligibility are left to the trip module's own checks", () => {
    const overlap = { availability: 'unavailable' as const, reasons: [{ code: 'assigned_to_overlapping_trip', severity: 'block' as const, trip_id: 't-1' }] };
    expect(readAvailability(overlap, overlap).refusal).toBeNull();
    expect(readAvailability(available, blocked('driver_retired', 'account_not_active', 'license_expired')).refusal).toBeNull();
  });

  test.each([
    ['driver_absent', 'absent'],
    ['driver_on_leave', 'on_leave'],
    ['driver_sick', 'sick'],
  ])('%s is a warning, never a refusal', (code, attendance) => {
    expect(readAvailability(available, warned(code))).toEqual({ refusal: null, warnings: [{ warning: 'DRIVER_ATTENDANCE', field: 'driver_id', attendance }] });
  });

  test('the attendance warning is kept alongside a refusal', () => {
    expect(readAvailability(blocked('maintenance_flag'), warned('driver_sick')).warnings).toEqual([{ warning: 'DRIVER_ATTENDANCE', field: 'driver_id', attendance: 'sick' }]);
  });
});

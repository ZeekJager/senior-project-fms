import { describe, expect, test } from 'vitest';
import { DEFAULT_EXCEPTION_POLICIES, approvalRequired, heldWarnings, uncovered } from './exception';
import type { AssignmentWarning } from './trip';

const absent: AssignmentWarning = { warning: 'DRIVER_ATTENDANCE', field: 'driver_id', attendance: 'absent' };
const overrun = (tripId: string, field: 'driver_id' | 'vehicle_id' = 'driver_id'): AssignmentWarning => ({
  warning: 'PREVIOUS_TRIP_OVERRUN',
  field,
  trip_id: tripId,
  expected_end: '2026-11-02T06:00:00.000Z',
});

describe('assignment exceptions (FMS-151)', () => {
  test('by default every warning only warns; a depot holds the ones it sets to approve', () => {
    expect(heldWarnings([absent, overrun('t-1')], DEFAULT_EXCEPTION_POLICIES)).toEqual([]);
    expect(heldWarnings([absent, overrun('t-1')], { attendance: 'approve', overrun: 'warn' })).toEqual([absent]);
    expect(heldWarnings([absent, overrun('t-1')], { attendance: 'warn', overrun: 'approve' })).toEqual([overrun('t-1')]);
  });

  test('an approval covers the warnings it asked about: the same rule, field and trip under way', () => {
    // The trip's expected end moves as it runs late: still the same warning.
    expect(uncovered([{ ...overrun('t-1'), expected_end: '2026-11-02T07:00:00.000Z' } as AssignmentWarning], [overrun('t-1')])).toEqual([]);
    expect(uncovered([absent], [absent])).toEqual([]);
    expect(uncovered([overrun('t-2')], [overrun('t-1')])).toEqual([overrun('t-2')]);
    expect(uncovered([overrun('t-1', 'vehicle_id')], [overrun('t-1', 'driver_id')])).toEqual([overrun('t-1', 'vehicle_id')]);
    expect(uncovered([absent, overrun('t-1')], [absent])).toEqual([overrun('t-1')]);
  });

  test('the 409 names each held warning, the trip under way as its record', () => {
    expect(approvalRequired([{ ...absent, attendance: 'on_leave' }, overrun('t-1', 'vehicle_id')]).details).toEqual([
      { field: 'driver_id', reason: 'driver_on_leave' },
      { field: 'vehicle_id', reason: 'previous_trip_overrun', record_id: 't-1' },
    ]);
  });
});

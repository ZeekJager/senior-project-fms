import { describe, expect, test } from 'vitest';
import { minutesOf, scheduleClash, shiftNeeded, shiftedBy, TURNAROUND_MS, type Slot } from './schedule';

const at = (hhmm: string) => new Date(`2031-03-04T${hhmm}:00Z`);
const slot: Slot = { id: '2', publicId: 'trip-b', driverId: '9', vehicleId: '7', status: 'assigned', start: at('10:30'), end: at('12:00') };

describe('moving the next trip (FMS-139)', () => {
  test('it must start a turnaround after the end: touching ends are an overlap', () => {
    expect(TURNAROUND_MS).toBe(60_000);
    expect(shiftNeeded(at('11:00'), at('10:30'))).toBe(31 * 60_000);
    expect(shiftNeeded(at('10:30'), at('10:30'))).toBe(60_000);
    expect(shiftNeeded(at('10:00'), at('10:30'))).toBe(0);
  });

  test('a moved trip keeps its length', () => {
    expect(shiftedBy(slot, 31 * 60_000)).toEqual({ ...slot, start: at('11:01'), end: at('12:31') });
  });

  test('minutes are rounded up, so the offer is never short', () => {
    expect(minutesOf(60_000)).toBe(1);
    expect(minutesOf(61_000)).toBe(2);
  });

  test('a clash names the trip, and the minutes only when it can be moved', () => {
    expect(scheduleClash('driver_id', slot, 31 * 60_000, true).details).toEqual([
      { field: 'driver_id', reason: 'overlapping_trip', record_id: 'trip-b', shiftable: true, shift_minutes: 31 },
    ]);
    const fixed = scheduleClash('vehicle_id', slot, 0, false);
    expect(fixed.code).toBe('CONFLICT_VEHICLE_OVERLAP');
    expect(fixed.details).toEqual([{ field: 'vehicle_id', reason: 'overlapping_trip', record_id: 'trip-b', shiftable: false }]);
  });
});

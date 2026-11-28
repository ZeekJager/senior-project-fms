import { describe, expect, test } from 'vitest';
import { tripEndReading } from './meter';

// FMS-165: the odometer a trip leaves at its end.

const trip = (over: Partial<Parameters<typeof tripEndReading>[0]> = {}) => ({
  start_odometer_km: 50_000,
  end_odometer_km: null,
  actual_distance_km: 38.67,
  actual_distance_source: 'gps' as const,
  ...over,
});

describe('tripEndReading', () => {
  test('the reading the driver typed wins, whatever was measured', () => {
    expect(tripEndReading(trip({ end_odometer_km: 50_140 }))).toEqual({ km: 50_140, source: 'trip' });
  });

  test('otherwise the start plus the GPS distance, rounded down to the tenth: an estimate never above the real odometer', () => {
    expect(tripEndReading(trip())).toEqual({ km: 50_038.6, source: 'gps_derived' });
  });

  test("nothing for a trip the vehicle's own device measured, with no distance, or with no start reading", () => {
    expect(tripEndReading(trip({ actual_distance_source: 'odometer', actual_distance_km: 50 }))).toBeNull();
    expect(tripEndReading(trip({ actual_distance_source: null, actual_distance_km: null }))).toBeNull();
    expect(tripEndReading(trip({ start_odometer_km: null }))).toBeNull();
  });
});

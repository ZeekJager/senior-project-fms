import { describe, expect, test } from 'vitest';
import { jobLoad, nightHours, payloadShare, type JobLoadInput } from './job-load';

/** Addis Ababa local time (UTC+3) as an instant. */
const addis = (local: string) => new Date(`${local}+03:00`);

/** A 20 km city run, 09:00 to 10:00, two stops, no cargo: nothing to count. */
const CITY_RUN: JobLoadInput = {
  plannedDistanceKm: 20,
  plannedDurationSeconds: 3600,
  scheduledStart: addis('2026-11-12T09:00:00'),
  scheduledEnd: addis('2026-11-12T10:00:00'),
  stopCount: 2,
  cargoWeightKg: null,
  payloadCapacityKg: null,
};

describe('nightHours (22:00 to 06:00 in Addis Ababa)', () => {
  test('a day trip has none', () => {
    expect(nightHours(addis('2026-11-12T08:00:00'), addis('2026-11-12T18:00:00'))).toBe(0);
  });

  test('counts the part of the trip after 22:00 and before 06:00', () => {
    expect(nightHours(addis('2026-11-12T20:00:00'), addis('2026-11-13T01:30:00'))).toBe(3.5);
    expect(nightHours(addis('2026-11-13T04:00:00'), addis('2026-11-13T09:00:00'))).toBe(2);
  });

  test('a whole night is eight hours, and two nights sixteen', () => {
    expect(nightHours(addis('2026-11-12T21:00:00'), addis('2026-11-13T07:00:00'))).toBe(8);
    expect(nightHours(addis('2026-11-12T12:00:00'), addis('2026-11-14T12:00:00'))).toBe(16);
  });

  test('an empty or backwards window has none', () => {
    const at = addis('2026-11-12T23:00:00');
    expect(nightHours(at, at)).toBe(0);
    expect(nightHours(at, addis('2026-11-12T22:00:00'))).toBe(0);
  });
});

describe('payloadShare', () => {
  test('is the cargo over the capacity, when both are known', () => {
    expect(payloadShare(4500, 5000)).toBe(0.9);
    expect(payloadShare(null, 5000)).toBeNull();
    expect(payloadShare(4500, null)).toBeNull();
    expect(payloadShare(4500, 0)).toBeNull();
  });
});

describe('jobLoad', () => {
  test('a short city run with no cargo is light, for no reason', () => {
    expect(jobLoad(CITY_RUN)).toEqual({ level: 'light', reasons: [], points: 0 });
  });

  test('a trip with nothing known is light', () => {
    expect(
      jobLoad({ plannedDistanceKm: null, plannedDurationSeconds: null, scheduledStart: null, scheduledEnd: null, stopCount: 0, cargoWeightKg: null, payloadCapacityKg: null }).level,
    ).toBe('light');
  });

  test('distance: 100 km is regional (1 point), 300 km a long haul (2)', () => {
    expect(jobLoad({ ...CITY_RUN, plannedDistanceKm: 99.9 }).reasons).toEqual([]);
    expect(jobLoad({ ...CITY_RUN, plannedDistanceKm: 100 })).toEqual({ level: 'standard', reasons: ['regional'], points: 1 });
    expect(jobLoad({ ...CITY_RUN, plannedDistanceKm: 300 })).toEqual({ level: 'standard', reasons: ['long_haul'], points: 2 });
  });

  test('duration: 4 h is long hours, 9 h a long day; the scheduled window stands in for a missing estimate', () => {
    expect(jobLoad({ ...CITY_RUN, plannedDurationSeconds: 4 * 3600 }).reasons).toEqual(['long_hours']);
    expect(jobLoad({ ...CITY_RUN, plannedDurationSeconds: 9 * 3600 })).toMatchObject({ reasons: ['long_day'], points: 2 });
    expect(
      jobLoad({ ...CITY_RUN, plannedDurationSeconds: null, scheduledStart: addis('2026-11-12T08:00:00'), scheduledEnd: addis('2026-11-12T13:00:00') }).reasons,
    ).toEqual(['long_hours']);
  });

  test('six stops or more count', () => {
    expect(jobLoad({ ...CITY_RUN, stopCount: 5 }).reasons).toEqual([]);
    expect(jobLoad({ ...CITY_RUN, stopCount: 6 }).reasons).toEqual(['many_stops']);
  });

  test('two hours or more between 22:00 and 06:00 count as night', () => {
    const late = (end: string) => jobLoad({ ...CITY_RUN, plannedDurationSeconds: null, scheduledStart: addis('2026-11-12T21:00:00'), scheduledEnd: addis(end) });
    expect(late('2026-11-12T23:30:00').reasons).toEqual([]);
    expect(late('2026-11-13T00:00:00').reasons).toEqual(['night']);
  });

  test('the cargo’s share of the payload: 60% loaded, 90% near the payload', () => {
    const carrying = (kg: number) => jobLoad({ ...CITY_RUN, cargoWeightKg: kg, payloadCapacityKg: 5000 });
    expect(carrying(2900).reasons).toEqual([]);
    expect(carrying(3000)).toMatchObject({ level: 'standard', reasons: ['loaded'], points: 1 });
    expect(carrying(4500)).toMatchObject({ level: 'standard', reasons: ['near_payload'], points: 2 });
  });

  test('cargo without a vehicle, or a vehicle without a recorded payload, loads from the route alone', () => {
    expect(jobLoad({ ...CITY_RUN, cargoWeightKg: 4500, payloadCapacityKg: null }).reasons).toEqual([]);
  });

  test('a loaded 400 km haul overnight is heavy, its biggest reasons first', () => {
    const haul = jobLoad({
      plannedDistanceKm: 400,
      plannedDurationSeconds: 7 * 3600,
      scheduledStart: addis('2026-11-12T20:00:00'),
      scheduledEnd: addis('2026-11-13T03:00:00'),
      stopCount: 3,
      cargoWeightKg: 4800,
      payloadCapacityKg: 5000,
    });
    expect(haul).toEqual({ level: 'heavy', reasons: ['long_haul', 'near_payload', 'long_hours', 'night'], points: 6 });
  });

  test('three points make a heavy job', () => {
    expect(jobLoad({ ...CITY_RUN, plannedDistanceKm: 150, plannedDurationSeconds: 5 * 3600, stopCount: 6 })).toMatchObject({ level: 'heavy', points: 3 });
    expect(jobLoad({ ...CITY_RUN, plannedDistanceKm: 150, plannedDurationSeconds: 5 * 3600 })).toMatchObject({ level: 'standard', points: 2 });
  });
});

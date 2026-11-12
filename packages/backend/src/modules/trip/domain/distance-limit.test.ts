import { describe, expect, test } from 'vitest';
import {
  DEFAULT_DISTANCE_LIMITS,
  addisDay,
  addisWeek,
  countedKm,
  distanceLimitExceeded,
  distanceLimitsProblem,
  distanceStanding,
  overLimitText,
  weightedKm,
  type CountedTrip,
} from './distance-limit';

/** Addis Ababa local time (UTC+3) as an instant. */
const addis = (local: string) => new Date(`${local}+03:00`);

/** Thursday 12 November 2026, 08:00 in Addis Ababa: a week of Monday 9 to Sunday 15. */
const THURSDAY = addis('2026-11-12T08:00:00');

const trip = (over: Partial<CountedTrip> = {}): CountedTrip => ({
  status: 'assigned',
  scheduledStart: THURSDAY,
  plannedDistanceKm: 100,
  actualDistanceKm: null,
  jobLoad: 'standard',
  ...over,
});

describe('the day and the week, in Addis Ababa', () => {
  test('a day runs from local midnight to local midnight', () => {
    const day = addisDay(addis('2026-11-12T23:59:00'));
    expect(day.start).toEqual(addis('2026-11-12T00:00:00'));
    expect(day.end).toEqual(addis('2026-11-13T00:00:00'));
    // 00:30 local is still the previous evening in UTC, but the new day here.
    expect(addisDay(addis('2026-11-13T00:30:00')).start).toEqual(addis('2026-11-13T00:00:00'));
  });

  test('a week runs Monday to Sunday', () => {
    for (const at of ['2026-11-09T00:00:00', '2026-11-12T08:00:00', '2026-11-15T23:59:59']) {
      expect(addisWeek(addis(at))).toEqual({ start: addis('2026-11-09T00:00:00'), end: addis('2026-11-16T00:00:00') });
    }
    expect(addisWeek(addis('2026-11-16T00:00:00')).start).toEqual(addis('2026-11-16T00:00:00'));
  });
});

describe('the load-weighted distance', () => {
  test('each load counts by its weight: light 0.8, standard 1.0, heavy 1.5', () => {
    expect(weightedKm(trip({ jobLoad: 'light' }), DEFAULT_DISTANCE_LIMITS)).toBe(80);
    expect(weightedKm(trip({ jobLoad: 'standard' }), DEFAULT_DISTANCE_LIMITS)).toBe(100);
    expect(weightedKm(trip({ jobLoad: 'heavy' }), DEFAULT_DISTANCE_LIMITS)).toBe(150);
  });

  test('a completed trip counts what was measured; one assigned or under way, the plan', () => {
    expect(countedKm({ status: 'completed', plannedDistanceKm: 100, actualDistanceKm: 130 })).toBe(130);
    expect(countedKm({ status: 'en_route', plannedDistanceKm: 100, actualDistanceKm: 130 })).toBe(100);
    expect(countedKm({ status: 'assigned', plannedDistanceKm: 100, actualDistanceKm: null })).toBe(100);
    // Not measured yet: the plan, until it is.
    expect(countedKm({ status: 'completed', plannedDistanceKm: 100, actualDistanceKm: null })).toBe(100);
    expect(countedKm({ status: 'assigned', plannedDistanceKm: null, actualDistanceKm: null })).toBe(0);
  });
});

describe('where a driver stands with the trip', () => {
  test('sums the trips of the day and of the week, each with its weight', () => {
    const others = [
      trip({ scheduledStart: addis('2026-11-12T05:00:00'), plannedDistanceKm: 200, jobLoad: 'heavy' }), // today: 300
      trip({ scheduledStart: addis('2026-11-10T09:00:00'), status: 'completed', actualDistanceKm: 400, jobLoad: 'light' }), // Tuesday: 320
      trip({ scheduledStart: addis('2026-11-16T09:00:00'), plannedDistanceKm: 900 }), // next week: not counted
      trip({ scheduledStart: addis('2026-11-12T12:00:00'), status: 'cancelled', plannedDistanceKm: 900 }), // cancelled: not counted
    ];
    const s = distanceStanding(trip(), others, DEFAULT_DISTANCE_LIMITS);
    expect(s.trip_km).toBe(100);
    expect(s.day).toEqual({ period: 'day', limit_km: 500, without_km: 300, with_km: 400, left_km: 100 });
    expect(s.week).toEqual({ period: 'week', limit_km: 2500, without_km: 620, with_km: 720, left_km: 1780 });
    expect(s.over).toBeNull();
    // 400 of 500 is 80%: a warning.
    expect(s.near?.period).toBe('day');
  });

  test('just over the daily limit is over; exactly on it is not', () => {
    const today = [trip({ scheduledStart: addis('2026-11-12T05:00:00'), plannedDistanceKm: 400 })];
    expect(distanceStanding(trip({ plannedDistanceKm: 100 }), today, DEFAULT_DISTANCE_LIMITS).over).toBeNull();
    const over = distanceStanding(trip({ plannedDistanceKm: 100.1 }), today, DEFAULT_DISTANCE_LIMITS).over;
    expect(over).toEqual({ period: 'day', limit_km: 500, without_km: 400, with_km: 500.1, left_km: -0.1 });
  });

  test('a trip over midnight counts on the day it starts', () => {
    const lateLastNight = trip({ scheduledStart: addis('2026-11-11T23:00:00'), plannedDistanceKm: 450 });
    const s = distanceStanding(trip({ scheduledStart: addis('2026-11-12T06:00:00'), plannedDistanceKm: 100 }), [lateLastNight], DEFAULT_DISTANCE_LIMITS);
    expect(s.day.without_km).toBe(0);
    expect(s.week.without_km).toBe(450);
  });

  test('the week boundary: Sunday night belongs to the week before, Monday morning starts a new one', () => {
    const sunday = trip({ scheduledStart: addis('2026-11-15T22:00:00'), plannedDistanceKm: 2400 });
    const monday = trip({ scheduledStart: addis('2026-11-16T07:00:00'), plannedDistanceKm: 200 });
    expect(distanceStanding(monday, [sunday], DEFAULT_DISTANCE_LIMITS).over).toBeNull();
    const saturday = trip({ scheduledStart: addis('2026-11-14T06:00:00'), plannedDistanceKm: 200 });
    expect(distanceStanding(saturday, [sunday], DEFAULT_DISTANCE_LIMITS).over?.period).toBe('week');
  });

  test('past both, the day is named', () => {
    const limits = { ...DEFAULT_DISTANCE_LIMITS, dailyKm: 300, weeklyKm: 300 };
    expect(distanceStanding(trip({ plannedDistanceKm: 350 }), [], limits).over?.period).toBe('day');
  });

  test('a heavy job reaches the limit sooner than a light one of the same distance', () => {
    const today = [trip({ scheduledStart: addis('2026-11-12T05:00:00'), plannedDistanceKm: 200 })];
    expect(distanceStanding(trip({ plannedDistanceKm: 250, jobLoad: 'light' }), today, DEFAULT_DISTANCE_LIMITS).over).toBeNull();
    expect(distanceStanding(trip({ plannedDistanceKm: 250, jobLoad: 'heavy' }), today, DEFAULT_DISTANCE_LIMITS).over?.with_km).toBe(575);
  });
});

describe('the refusal', () => {
  test('says the period, the limit and the totals with and without the trip', () => {
    const p = { period: 'day' as const, limit_km: 500, without_km: 410, with_km: 560, left_km: -60 };
    expect(overLimitText(p)).toBe('Would drive 560 of 500 km today');
    const err = distanceLimitExceeded(p);
    expect(err.status).toBe(409);
    expect(err.code).toBe('CONFLICT_DRIVER_DISTANCE_LIMIT');
    expect(err.details).toEqual([{ field: 'driver_id', reason: 'distance_limit', period: 'day', limit_km: 500, total_km: 560, without_trip_km: 410 }]);
    expect(overLimitText({ ...p, period: 'week', limit_km: 2500, with_km: 2512.5 })).toBe('Would drive 2512.5 of 2500 km this week');
  });
});

describe('the settings', () => {
  test('a week holds at least a day, and a heavier load never counts for less', () => {
    expect(distanceLimitsProblem(DEFAULT_DISTANCE_LIMITS)).toBeNull();
    expect(distanceLimitsProblem({ ...DEFAULT_DISTANCE_LIMITS, dailyKm: 600, weeklyKm: 500 })?.field).toBe('weekly_distance_km');
    expect(distanceLimitsProblem({ ...DEFAULT_DISTANCE_LIMITS, weights: { light: 1.1, standard: 1, heavy: 1.5 } })?.field).toBe('distance_weight_light');
    expect(distanceLimitsProblem({ ...DEFAULT_DISTANCE_LIMITS, weights: { light: 0.8, standard: 1, heavy: 0.9 } })?.field).toBe('distance_weight_heavy');
  });
});

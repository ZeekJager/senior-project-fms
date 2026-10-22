import { describe, expect, test } from 'vitest';
import { bearing, distanceKm, loopAround, pathLength, pointAlong, scenarioFor, speedFor, step, type Point } from './motion';

const ADDIS: Point = { lat: 9.0108, lng: 38.7613 };
const ADAMA: Point = { lat: 8.5408, lng: 39.2716 };

describe('geometry', () => {
  test('distance and bearing between Addis Ababa and Adama', () => {
    expect(distanceKm(ADDIS, ADAMA)).toBeGreaterThan(75);
    expect(distanceKm(ADDIS, ADAMA)).toBeLessThan(77);
    expect(bearing(ADDIS, ADAMA)).toBeGreaterThan(130); // south-east
    expect(bearing(ADDIS, ADAMA)).toBeLessThan(140);
    expect(bearing(ADDIS, { lat: 9.1, lng: 38.7613 })).toBeCloseTo(0, 5);
  });

  test('a point along the path stays on it, and the end of the path is its last point', () => {
    const path = [ADDIS, ADAMA];
    const half = pointAlong(path, pathLength(path) / 2).position;
    expect(half.lat).toBeCloseTo((ADDIS.lat + ADAMA.lat) / 2, 3);
    expect(pointAlong(path, pathLength(path) + 5).position).toEqual(ADAMA);
    expect(pointAlong(path, -1).position).toEqual(ADDIS);
  });
});

describe('step', () => {
  const half = () => 0.5;
  test('drives forward at the scenario speed: 47.5 km/h for 10 s is about 132 m', () => {
    const { state, ping } = step({ path: [ADDIS, ADAMA], at: 0, direction: 1, scenario: 'normal' }, 10, half);
    expect(ping.speed_kmh).toBe(47.5);
    expect(state.at).toBeCloseTo((47.5 * 10) / 3600, 6);
    expect(ping.heading).toBeGreaterThan(130);
  });

  test('turns round at the end of the route and heads back', () => {
    const path = loopAround(ADDIS);
    const total = pathLength(path);
    const { state } = step({ path, at: total - 0.01, direction: 1, scenario: 'speeding' }, 10, half);
    expect(state.direction).toBe(-1);
    expect(state.at).toBeLessThan(total);
  });

  test('an idling vehicle stays where it is at 0 km/h', () => {
    const { state, ping } = step({ path: [ADDIS, ADAMA], at: 3, direction: 1, scenario: 'idling' }, 10, half);
    expect(ping.speed_kmh).toBe(0);
    expect(state.at).toBe(3);
  });
});

test('scenarios: the given shares speed and idle, the rest are normal; speeding is over 80 km/h', () => {
  const picks = Array.from({ length: 200 }, (_, i) => scenarioFor(i, 200, { speeding: 0.1, idling: 0.05 }));
  expect(picks.filter((s) => s === 'speeding')).toHaveLength(20);
  expect(picks.filter((s) => s === 'idling')).toHaveLength(10);
  expect(speedFor('speeding', () => 0)).toBeGreaterThan(80);
  expect(speedFor('normal', () => 0.999)).toBeLessThan(80);
});

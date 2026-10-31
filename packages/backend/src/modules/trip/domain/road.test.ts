import { describe, expect, test } from 'vitest';
import { lineLengthKm, simplifyLine, waypointKey, waypointsOf, type LineString } from './road';

const ADDIS = { latitude: 9.0108, longitude: 38.7613 };
const ADAMA = { latitude: 8.5408, longitude: 39.2716 };

describe('waypoints (FMS-84)', () => {
  test('origin, the stops with coordinates, destination; nothing without both ends', () => {
    const stops = [
      { name: 'Bishoftu', latitude: 8.75, longitude: 38.98 },
      { name: 'Mojo', latitude: null, longitude: null },
    ];
    expect(waypointsOf(ADDIS, stops, ADAMA)).toEqual([ADDIS, { latitude: 8.75, longitude: 38.98 }, ADAMA]);
    expect(waypointsOf(null, stops, ADAMA)).toBeNull();
    expect(waypointsOf(ADDIS, [], null)).toBeNull();
  });

  test('the key is longitude,latitude to 6 decimals, as OSRM takes them', () => {
    expect(waypointKey([ADDIS, ADAMA])).toBe('38.761300,9.010800;39.271600,8.540800');
  });
});

describe('lines', () => {
  test('length along the line, in km', () => {
    expect(lineLengthKm({ type: 'LineString', coordinates: [[38.7613, 9.0108], [39.2716, 8.5408]] })).toBeCloseTo(76.7, 0);
  });

  test('simplifying keeps both ends, drops points within the tolerance, and keeps a bend beyond it', () => {
    // A straight road with a 40 m kink in the middle and small wobbles along it.
    const coordinates: [number, number][] = [];
    for (let i = 0; i <= 100; i++) coordinates.push([38.7 + i * 0.001, 9 + (i === 50 ? 0.00036 : i % 2 ? 0.00002 : 0)]);
    const line: LineString = { type: 'LineString', coordinates };
    const simple = simplifyLine(line, 15);
    expect(simple.coordinates[0]).toEqual([38.7, 9]);
    expect(simple.coordinates.at(-1)).toEqual([38.8, 9]);
    expect(simple.coordinates).toContainEqual([38.75, 9.00036]);
    expect(simple.coordinates.length).toBeLessThan(10);
    expect(lineLengthKm(simple)).toBeCloseTo(lineLengthKm(line), 1);
  });

  test('a line of one or two points stays as it is, rounded to 5 decimals', () => {
    expect(simplifyLine({ type: 'LineString', coordinates: [[38.7613001, 9.0108004], [39.27, 8.54]] }).coordinates).toEqual([
      [38.7613, 9.0108],
      [39.27, 8.54],
    ]);
  });
});

import { describe, expect, test } from 'vitest';
import { areaSquareMetres, inside, metresBetween, metresToLine, normalizePolygon, polygonProblem, type LineString, type Polygon } from './geometry';

// FMS-90: the geometry of geofences and route deviation.

const ring = (pts: [number, number][]): Polygon => ({ type: 'Polygon', coordinates: [[...pts, pts[0]]] });
/** A square about 220 m across around Meskel Square, Addis Ababa. */
const yard = ring([
  [38.7603, 9.0098],
  [38.7623, 9.0098],
  [38.7623, 9.0118],
  [38.7603, 9.0118],
]);
/** An L-shaped yard: the notch at the top right is outside. */
const ell = ring([
  [38.76, 9.01],
  [38.764, 9.01],
  [38.764, 9.012],
  [38.762, 9.012],
  [38.762, 9.014],
  [38.76, 9.014],
]);

describe('inside', () => {
  test('a fix in the middle is inside, one past an edge is not', () => {
    expect(inside({ lat: 9.0108, lng: 38.7613 }, yard)).toBe(true);
    expect(inside({ lat: 9.0108, lng: 38.7625 }, yard)).toBe(false);
    expect(inside({ lat: 9.012, lng: 38.7613 }, yard)).toBe(false);
  });

  test('a concave yard: its notch is outside, its arm inside', () => {
    expect(inside({ lat: 9.013, lng: 38.763 }, ell)).toBe(false);
    expect(inside({ lat: 9.013, lng: 38.761 }, ell)).toBe(true);
    expect(inside({ lat: 9.011, lng: 38.763 }, ell)).toBe(true);
  });

  test('on the fence line counts as inside, at a corner too', () => {
    expect(inside({ lat: 9.0098, lng: 38.7613 }, yard)).toBe(true);
    expect(inside({ lat: 9.0118, lng: 38.7623 }, yard)).toBe(true);
  });

  test('the ring may be sent open or closed', () => {
    const open: Polygon = { type: 'Polygon', coordinates: [yard.coordinates[0].slice(0, -1)] };
    expect(inside({ lat: 9.0108, lng: 38.7613 }, open)).toBe(true);
    expect(normalizePolygon(open)).toEqual(normalizePolygon(yard));
  });
});

describe('metresToLine', () => {
  // A road running east along latitude 9.0108.
  const road: LineString = { type: 'LineString', coordinates: [[38.75, 9.0108], [38.77, 9.0108]] };

  test('on the road is 0 m; 500 m north of it is 500 m', () => {
    expect(metresToLine({ lat: 9.0108, lng: 38.76 }, road)).toBeLessThan(0.01);
    const north = 9.0108 + 500 / 111_195; // 500 m of latitude
    expect(metresToLine({ lat: north, lng: 38.76 }, road)).toBeCloseTo(500, 0);
  });

  test('past the end of the road, the distance is to its end', () => {
    const past = { lat: 9.0108, lng: 38.78 };
    expect(metresToLine(past, road)).toBeCloseTo(metresBetween(past, { lat: 9.0108, lng: 38.77 }), 0);
  });

  test('the nearest of several segments counts', () => {
    const bend: LineString = { type: 'LineString', coordinates: [[38.75, 9.0], [38.76, 9.0], [38.76, 9.02]] };
    expect(metresToLine({ lat: 9.01, lng: 38.7601 }, bend)).toBeCloseTo(11, 0);
  });
});

describe('polygonProblem', () => {
  test('a yard is a fine geofence, about 220 m by 220 m', () => {
    expect(polygonProblem(normalizePolygon(yard))).toBeNull();
    expect(areaSquareMetres(yard)).toBeGreaterThan(45_000);
    expect(areaSquareMetres(yard)).toBeLessThan(50_000);
  });

  test('two corners, a bow tie, a speck and a country are refused', () => {
    expect(polygonProblem(ring([[38.76, 9.01], [38.77, 9.01]]))).toBe('too_few_points');
    const bowTie = ring([
      [38.76, 9.01],
      [38.77, 9.02],
      [38.77, 9.01],
      [38.76, 9.02],
    ]);
    expect(polygonProblem(bowTie)).toBe('self_intersecting');
    const speck = ring([
      [38.76, 9.01],
      [38.76001, 9.01],
      [38.76001, 9.01001],
    ]);
    expect(polygonProblem(speck)).toBe('too_small');
    const country = ring([
      [33, 3],
      [48, 3],
      [48, 15],
      [33, 15],
    ]);
    expect(polygonProblem(country)).toBe('too_large');
    expect(polygonProblem(ring([[38.76, 95], [38.77, 9.01], [38.77, 9.02]]))).toBe('out_of_range');
  });

  test('repeated corners are dropped before counting', () => {
    const doubled = ring([
      [38.7603, 9.0098],
      [38.7603, 9.0098],
      [38.7623, 9.0098],
      [38.7623, 9.0118],
      [38.7603, 9.0118],
    ]);
    expect(normalizePolygon(doubled)).toEqual(normalizePolygon(yard));
    expect(normalizePolygon(doubled).coordinates[0]).toHaveLength(5);
  });
});

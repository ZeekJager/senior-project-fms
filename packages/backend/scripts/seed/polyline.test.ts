import { describe, expect, test } from 'vitest';
import { decodePolyline, encodePolyline } from './polyline';

describe('encoded polylines (FMS-84)', () => {
  test("Google's reference example, [longitude, latitude] pairs", () => {
    const points: [number, number][] = [
      [-120.2, 38.5],
      [-120.95, 40.7],
      [-126.453, 43.252],
    ];
    expect(encodePolyline(points)).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@')).toEqual(points);
  });

  test('round trip at 5 decimals, negative steps and an empty line included', () => {
    const points: [number, number][] = [
      [38.7613, 9.0108],
      [38.76131, 9.01079],
      [39.27159, 8.54081],
    ];
    expect(decodePolyline(encodePolyline(points))).toEqual(points);
    expect(decodePolyline(encodePolyline([]))).toEqual([]);
    expect(() => decodePolyline('_p~iF~ps|U_ulL')).toThrow('Truncated');
  });
});

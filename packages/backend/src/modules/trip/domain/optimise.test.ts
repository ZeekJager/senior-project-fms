import { describe, expect, test } from 'vitest';
import { nearestNeighbour, optimiseOrder, orderLength, twoOpt } from './optimise';

// FMS-86: the optimiser on fixtures. A table is [from][to] over origin, the stops in saved order, destination.

/** Points on a line (km along it): the road distance is how far apart they are, both ways. */
function lineTable(positions: number[]): number[][] {
  return positions.map((a) => positions.map((b) => Math.abs(a - b)));
}

/** Points on a plane: straight-line distances, scaled to whole metres. */
function planeTable(points: readonly [number, number][]): number[][] {
  return points.map(([ax, ay]) => points.map(([bx, by]) => Math.round(Math.hypot(ax - bx, ay - by) * 1000)));
}

/** A small deterministic generator (mulberry32), so the random fixtures are the same on every run. */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('stop-order optimisation (FMS-86)', () => {
  test('stops saved out of order along one road come back in road order', () => {
    // Origin at 0, destination at 10; stops saved at 7, 2, 9, 4.
    const table = lineTable([0, 7, 2, 9, 4, 10]);
    const result = optimiseOrder(table);
    expect(result.order).toEqual([1, 3, 0, 2]);
    expect(result.changed).toBe(true);
    expect(result.originalLength).toBe(7 + 5 + 7 + 5 + 6);
    expect(result.optimisedLength).toBe(10);
  });

  test('an order that is already the shortest is kept as saved, unchanged', () => {
    const table = lineTable([0, 2, 4, 7, 9, 10]);
    expect(optimiseOrder(table)).toEqual({ order: [0, 1, 2, 3], originalLength: 10, optimisedLength: 10, changed: false });
  });

  test('none or one stop: nothing to order', () => {
    expect(optimiseOrder(lineTable([0, 10]))).toMatchObject({ order: [], changed: false });
    expect(optimiseOrder(lineTable([0, 3, 10]))).toMatchObject({ order: [0], changed: false, originalLength: 10 });
  });

  test('2-opt reverses a stretch driven backwards; nearest neighbour starts from the closest stop', () => {
    // Along one road: stops saved at 1, 2, 3, 4; the order 1, 3, 2, 4 doubles back.
    const table = lineTable([0, 1, 2, 3, 4, 5]);
    expect(orderLength(table, [0, 2, 1, 3])).toBe(7);
    expect(twoOpt(table, [0, 2, 1, 3])).toEqual([0, 1, 2, 3]);
    expect(nearestNeighbour(lineTable([0, 4, 1, 3, 5]))).toEqual([1, 2, 0]);
  });

  test('road distances are not symmetric: the order is costed in the direction driven', () => {
    // From the origin the one-way road reaches stop 1 (index 0) cheaply only after stop 2 (index 1).
    const table = [
      [0, 50, 5, 60],
      [50, 0, 50, 5],
      [50, 1, 0, 50],
      [60, 50, 50, 0],
    ];
    const result = optimiseOrder(table);
    expect(result.order).toEqual([1, 0]);
    expect(result.optimisedLength).toBe(5 + 1 + 5);
    expect(result.originalLength).toBe(50 + 50 + 50);
  });

  test('never longer than the saved order, on 200 random tables of up to 25 stops', () => {
    const next = random(86);
    for (let run = 0; run < 200; run++) {
      const stops = 2 + Math.floor(next() * 24);
      const points = Array.from({ length: stops + 2 }, (): [number, number] => [next() * 100, next() * 100]);
      // Some detour on each leg, different each way, as roads are.
      const table = planeTable(points).map((row) => row.map((d) => Math.round(d * (1 + next() * 0.4))));
      const result = optimiseOrder(table);
      expect(result.optimisedLength).toBeLessThanOrEqual(result.originalLength);
      expect(orderLength(table, result.order)).toBe(result.optimisedLength);
      expect([...result.order].sort((a, b) => a - b)).toEqual(Array.from({ length: stops }, (_, i) => i));
      if (!result.changed) expect(result.order).toEqual(Array.from({ length: stops }, (_, i) => i));
    }
  });
});

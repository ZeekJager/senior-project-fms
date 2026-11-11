import { describe, expect, test } from 'vitest';
import { DEFAULT_SCORE_WEIGHTS, rankDrivers, scoreDriver, type DriverMonth, type ScoreWeights } from './driver-score';

// FMS-146: the driver performance score.

/** A clean month: 10 trips, 1,000 km, all on time and inspected, nothing flagged. */
const month = (patch: Partial<DriverMonth> = {}): DriverMonth => ({
  tripsCompleted: 10,
  distanceM: 1_000_000,
  tripsTimed: 10,
  tripsOnTime: 10,
  speeding: 0,
  idling: 0,
  accidents: 0,
  tripsInspected: 10,
  ...patch,
});

const only = (c: keyof ScoreWeights): ScoreWeights => ({ punctuality: 0, safety: 0, incidents: 0, dvir: 0, [c]: 1 });

describe('scoreDriver', () => {
  test('a clean month scores 100, with every component at 100', () => {
    const s = scoreDriver(month(), DEFAULT_SCORE_WEIGHTS);
    expect(s).toMatchObject({ score: 100, reason: null });
    expect(s.components).toEqual({
      punctuality: { score: 100, weight: 35 },
      safety: { score: 100, weight: 35 },
      incidents: { score: 100, weight: 20 },
      dvir: { score: 100, weight: 10 },
    });
  });

  test('punctuality is the share of timed trips ended on time', () => {
    expect(scoreDriver(month({ tripsOnTime: 7 }), only('punctuality')).score).toBe(70);
    // Trips with no scheduled end are not judged on time.
    expect(scoreDriver(month({ tripsTimed: 4, tripsOnTime: 3 }), only('punctuality')).score).toBe(75);
  });

  test('safety falls by 20 for each speeding or idling event per 100 km, to 0 at 5', () => {
    // 1,000 km: 10 events is 1 per 100 km.
    expect(scoreDriver(month({ speeding: 6, idling: 4 }), only('safety')).score).toBe(80);
    expect(scoreDriver(month({ speeding: 25, idling: 25 }), only('safety')).score).toBe(0);
    expect(scoreDriver(month({ speeding: 90 }), only('safety')).score).toBe(0);
  });

  test('incidents fall to 0 at one accident per 200 km', () => {
    expect(scoreDriver(month({ accidents: 1 }), only('incidents')).score).toBe(80);
    expect(scoreDriver(month({ accidents: 5 }), only('incidents')).score).toBe(0);
  });

  test('DVIR completion is the share of completed trips with a pre-trip inspection', () => {
    expect(scoreDriver(month({ tripsInspected: 6 }), only('dvir')).score).toBe(60);
  });

  test('the score is the weighted mean of the components, rounded', () => {
    // punctuality 50, safety 80, incidents 100, dvir 0: (50*35 + 80*35 + 100*20 + 0*10) / 100 = 65.5
    const s = scoreDriver(month({ tripsOnTime: 5, speeding: 10, tripsInspected: 0 }), DEFAULT_SCORE_WEIGHTS);
    expect(s.score).toBe(66);
    // The weights are any whole numbers: the score divides by their sum.
    expect(scoreDriver(month({ tripsOnTime: 5, speeding: 10, tripsInspected: 0 }), { punctuality: 7, safety: 7, incidents: 4, dvir: 2 }).score).toBe(66);
  });

  test('a weight of 0 leaves its component out', () => {
    expect(scoreDriver(month({ tripsInspected: 0 }), { ...DEFAULT_SCORE_WEIGHTS, dvir: 0 }).score).toBe(100);
  });

  test('fewer than 3 completed trips: no score, not a low one, though the components are given', () => {
    const s = scoreDriver(month({ tripsCompleted: 2, tripsTimed: 2, tripsOnTime: 0, tripsInspected: 0 }), DEFAULT_SCORE_WEIGHTS);
    expect(s).toMatchObject({ score: null, reason: 'not_enough_trips' });
    expect(s.components.punctuality.score).toBe(0);
    expect(scoreDriver(month({ tripsCompleted: 3, tripsTimed: 3, tripsOnTime: 3, tripsInspected: 3 }), DEFAULT_SCORE_WEIGHTS).score).toBe(100);
  });

  test('a component with nothing to judge is left out, not counted as 0', () => {
    // Under 10 km: no rates. No scheduled ends: no punctuality.
    const s = scoreDriver(month({ distanceM: 5_000, speeding: 3, tripsTimed: 0, tripsOnTime: 0, tripsInspected: 5 }), DEFAULT_SCORE_WEIGHTS);
    expect(s.components).toMatchObject({ punctuality: { score: null }, safety: { score: null }, incidents: { score: null }, dvir: { score: 50 } });
    expect(s.score).toBe(50);
    expect(scoreDriver(month({ distanceM: 5_000, tripsTimed: 0, tripsOnTime: 0 }), { ...DEFAULT_SCORE_WEIGHTS, dvir: 0 })).toMatchObject({
      score: null,
      reason: 'nothing_to_judge',
    });
  });
});

describe('rankDrivers', () => {
  const d = (name: string, score: number | null, punctuality: number | null = 90) => ({ name, score, punctuality });

  test('highest score first; a tie ranks by the higher punctuality; equal in both share a rank', () => {
    const ranked = rankDrivers([d('Abebe', 80, 70), d('Bekele', 92), d('Chaltu', 80, 95), d('Dawit', 80, 70), d('Eden', 60)]);
    expect(ranked.map((r) => [r.row.name, r.rank])).toEqual([
      ['Bekele', 1],
      ['Chaltu', 2],
      ['Abebe', 3],
      ['Dawit', 3],
      ['Eden', 5],
    ]);
  });

  test('drivers with no score come last, unranked; no punctuality counts lowest', () => {
    const ranked = rankDrivers([d('Abebe', null), d('Bekele', 70, null), d('Chaltu', 70, 10)]);
    expect(ranked.map((r) => [r.row.name, r.rank])).toEqual([
      ['Chaltu', 1],
      ['Bekele', 2],
      ['Abebe', null],
    ]);
  });
});

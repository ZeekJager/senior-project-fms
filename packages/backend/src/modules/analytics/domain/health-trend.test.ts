import { describe, expect, test } from 'vitest';
import { healthTrend } from './health-trend';

const range = { from: '2026-11-01', to: '2026-11-04', days: 4 };

describe('the health score trend (FMS-150)', () => {
  test('every day of the range, in order; a day with no stored scores is a gap of nulls, not zeros', () => {
    const days = healthTrend(range, [
      { day: '2026-11-01', vehicles: 4, scoreSum: 290, highRisk: 1 },
      { day: '2026-11-03', vehicles: 3, scoreSum: 200, highRisk: 2 },
    ]);
    expect(days).toEqual([
      { date: '2026-11-01', vehicles_scored: 4, mean_health_score: 72.5, high_risk_pct: 25 },
      { date: '2026-11-02', vehicles_scored: null, mean_health_score: null, high_risk_pct: null },
      { date: '2026-11-03', vehicles_scored: 3, mean_health_score: 66.7, high_risk_pct: 67 },
      { date: '2026-11-04', vehicles_scored: null, mean_health_score: null, high_risk_pct: null },
    ]);
  });

  test('days outside the range are left out, and a day of no vehicles is a gap', () => {
    const days = healthTrend(range, [
      { day: '2026-10-31', vehicles: 2, scoreSum: 100, highRisk: 0 },
      { day: '2026-11-02', vehicles: 0, scoreSum: 0, highRisk: 0 },
    ]);
    expect(days.map((d) => d.date)).toEqual(['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04']);
    expect(days.every((d) => d.mean_health_score === null)).toBe(true);
  });
});

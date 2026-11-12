import { shiftDay, type Range } from './kpis';

// The fleet-wide health score trend (FMS-150, docs/vehicle-health.md): each Addis Ababa day's mean of the health
// scores the nightly batch stored (FMS-55), and the share of the vehicles scored that were high risk. Pure: the
// repository reads the stored scores, one per vehicle and day, and this lays them out over the range.

/** The trend's range when none is asked for: the 90 days to today. */
export const HEALTH_TREND_DEFAULT_DAYS = 90;

/** One day's stored scores, summed by the repository: one score per vehicle (that day's last). */
export interface ScoredDay {
  day: string;
  vehicles: number;
  scoreSum: number;
  highRisk: number;
}

/** A day of the trend. A day with no scoring run is a gap: every figure null, never 0. */
export interface HealthTrendDay {
  date: string;
  vehicles_scored: number | null;
  mean_health_score: number | null;
  high_risk_pct: number | null;
}

/** Every day of the range in order, each scored day's mean (to one decimal) and high-risk share (whole percent). */
export function healthTrend(range: Range, scored: readonly ScoredDay[]): HealthTrendDay[] {
  const byDay = new Map(scored.map((d) => [d.day, d]));
  const days: HealthTrendDay[] = [];
  for (let i = 0; i < range.days; i += 1) {
    const date = shiftDay(range.from, i);
    const d = byDay.get(date);
    days.push(
      d && d.vehicles > 0
        ? {
            date,
            vehicles_scored: d.vehicles,
            mean_health_score: Math.round((d.scoreSum / d.vehicles) * 10) / 10,
            high_risk_pct: Math.round((d.highRisk / d.vehicles) * 100),
          }
        : { date, vehicles_scored: null, mean_health_score: null, high_risk_pct: null },
    );
  }
  return days;
}

// The driver performance score (FMS-146, docs/analytics.md): one number from 0 to 100 per driver per month, weighted
// from four components, each itself 0 to 100. Pure: the month's figures in, the score out.

export const SCORE_COMPONENTS = ['punctuality', 'safety', 'incidents', 'dvir'] as const;
export type ScoreComponent = (typeof SCORE_COMPONENTS)[number];

/** How much each component counts. Any whole numbers: the score divides by their sum. */
export type ScoreWeights = Record<ScoreComponent, number>;

/** The defaults (FMS-146), until an administrator changes them in Settings. */
export const DEFAULT_SCORE_WEIGHTS: ScoreWeights = { punctuality: 35, safety: 35, incidents: 20, dvir: 10 };

/** Fewer completed trips in the month than this, and there is no score: a trip or two says nothing of a driver. */
export const MIN_SCORED_TRIPS = 3;

/** Safety and incidents are rates per 100 km: under this many metres driven, they are not judged. */
export const MIN_RATED_METRES = 10_000;

/** Speeding and idling events per 100 km at which safety reaches 0; none is 100, linear between. */
export const SAFETY_ZERO_PER_100KM = 5;

/** Accidents per 100 km at which the incidents component reaches 0 (one every 200 km); none is 100, linear between. */
export const INCIDENTS_ZERO_PER_100KM = 0.5;

/** A driver's month, as the score reads it. */
export interface DriverMonth {
  tripsCompleted: number;
  distanceM: number;
  /** Completed trips with a scheduled end, and those of them ended on time. */
  tripsTimed: number;
  tripsOnTime: number;
  speeding: number;
  idling: number;
  /** Accidents of the driver: the incidents a driver is answerable for (docs/analytics.md). */
  accidents: number;
  /** Completed trips that had the driver's pre-trip inspection. */
  tripsInspected: number;
}

export interface ComponentScore {
  /** 0 to 100; null when there is nothing to judge it on (no timed trip, too few km). */
  score: number | null;
  weight: number;
}

export type ScoreReason = 'not_enough_trips' | 'nothing_to_judge';

export interface DriverScore {
  /** 0 to 100, whole; null with a reason. */
  score: number | null;
  reason: ScoreReason | null;
  components: Record<ScoreComponent, ComponentScore>;
}

const clamp = (v: number) => Math.max(0, Math.min(100, v));
/** 100 at a rate of 0, 0 at `zeroAt` and beyond. */
const falling = (rate: number, zeroAt: number) => clamp(100 * (1 - rate / zeroAt));

/** Each component, 0 to 100 unrounded, or null. */
function components(m: DriverMonth): Record<ScoreComponent, number | null> {
  const rated = m.distanceM >= MIN_RATED_METRES;
  const per100km = (count: number) => (count * 100_000) / m.distanceM;
  return {
    punctuality: m.tripsTimed > 0 ? (100 * m.tripsOnTime) / m.tripsTimed : null,
    safety: rated ? falling(per100km(m.speeding + m.idling), SAFETY_ZERO_PER_100KM) : null,
    incidents: rated ? falling(per100km(m.accidents), INCIDENTS_ZERO_PER_100KM) : null,
    dvir: m.tripsCompleted > 0 ? clamp((100 * m.tripsInspected) / m.tripsCompleted) : null,
  };
}

/**
 * A driver's score for a month: the weighted mean of the components that can be judged, over their weights. A component
 * that cannot be judged is left out, not counted as 0. Fewer than MIN_SCORED_TRIPS completed trips: no score
 * (`not_enough_trips`), though the components are still given; no judged component with a weight: `nothing_to_judge`.
 */
export function scoreDriver(m: DriverMonth, weights: ScoreWeights): DriverScore {
  const raw = components(m);
  const parts = Object.fromEntries(
    SCORE_COMPONENTS.map((c) => [c, { score: raw[c] === null ? null : Math.round(raw[c]), weight: Math.max(0, weights[c]) }]),
  ) as Record<ScoreComponent, ComponentScore>;
  if (m.tripsCompleted < MIN_SCORED_TRIPS) return { score: null, reason: 'not_enough_trips', components: parts };
  let weighted = 0;
  let total = 0;
  for (const c of SCORE_COMPONENTS) {
    const value = raw[c];
    if (value === null || parts[c].weight === 0) continue;
    weighted += value * parts[c].weight;
    total += parts[c].weight;
  }
  if (total === 0) return { score: null, reason: 'nothing_to_judge', components: parts };
  return { score: Math.round(weighted / total), reason: null, components: parts };
}

export interface Rankable {
  score: number | null;
  /** The punctuality component: ties rank by the higher. */
  punctuality: number | null;
  name: string;
}

/**
 * Drivers in rank order, each with their rank: highest score first, a tie by the higher punctuality (none counts lowest),
 * then by name for a steady order. Drivers equal in both share a rank, and the next rank skips (1, 2, 2, 4). Drivers
 * with no score come last, ranked null, in the order given.
 */
export function rankDrivers<T extends Rankable>(rows: readonly T[]): { row: T; rank: number | null }[] {
  const punctuality = (r: Rankable) => r.punctuality ?? -1;
  const scored = rows
    .filter((r) => r.score !== null)
    .sort((a, b) => b.score! - a.score! || punctuality(b) - punctuality(a) || a.name.localeCompare(b.name));
  const ranked: { row: T; rank: number | null }[] = [];
  scored.forEach((row, i) => {
    const before = ranked[i - 1];
    const tied = before && before.row.score === row.score && punctuality(before.row) === punctuality(row);
    ranked.push({ row, rank: tied ? before.rank : i + 1 });
  });
  return [...ranked, ...rows.filter((r) => r.score === null).map((row) => ({ row, rank: null }))];
}

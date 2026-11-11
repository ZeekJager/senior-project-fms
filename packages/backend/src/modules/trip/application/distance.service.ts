/**
 * Each trip's actual distance (FMS-145, docs/trip-distance.md). Measured when the trip ends, in the same audited
 * mutation, from the positions the integration module stored during it (domain/distance.ts). Measured again by the
 * hourly `trip-distance` job while positions of a recent trip keep arriving (a phone that was offline sends them
 * late, FMS-124), and once for trips completed before this card by `npm run backfill:trip-distance`.
 */
import type { PoolClient } from 'pg';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { measureTrip, type NoDistance, type TrackPoint, type TripDistance } from '../domain/distance';
import type { DistanceCandidate, TripRepository, TripWrite } from '../infrastructure/trip.repository';

/** The integration module's stored positions, connected by src/modules/index.ts (integration imports trip). */
export interface TrackLookup {
  tripTrack(db: Queryable, trip: TrackWindow, limit: number): Promise<TrackPoint[]>;
  tripTrackCounts(db: Queryable, trips: readonly TrackWindow[]): Promise<Map<string, number>>;
}

/** A trip's vehicle and time window, internal ids. */
export interface TrackWindow {
  tripId: string;
  vehicleId: string;
  start: Date;
  end: Date;
}

/** At most this many positions are read for one trip: a ping every 2 seconds for over two days. */
export const TRACK_LIMIT = 100_000;

/** Positions are accepted up to 7 days late (gps-ingestion.md), so a trip may gain positions for that long after it ends. */
export const REMEASURE_DAYS = 8;

/** Trips the hourly job looks at per run, newest first. */
export const REMEASURE_BATCH = 2_000;

export interface TripDistanceDeps {
  /** Reads outside a write: the pool. */
  db: Queryable;
  trips: Pick<TripRepository, 'inTransaction' | 'update' | 'distanceCandidates' | 'unmeasured' | 'lockCandidate'>;
  /** Null when not connected (a unit test): trips are left unmeasured, for the job to measure later. */
  track: () => TrackLookup | null;
  now?: () => Date;
  warn?: (fields: Record<string, unknown>, message: string) => void;
}

/** What a job run or the backfill did. */
export interface MeasureSummary {
  checked: number;
  measured: number;
  bySource: { odometer: number; gps: number };
  /** Measured, but nothing to measure from, by reason. */
  without: Partial<Record<NoDistance, number>>;
  /** Measured again with the same result (more positions, same distance), or skipped as unchanged. */
  unchanged: number;
}

const emptySummary = (): MeasureSummary => ({ checked: 0, measured: 0, bySource: { odometer: 0, gps: 0 }, without: {}, unchanged: 0 });

/** The columns a measurement writes. */
export function distanceWrite(result: TripDistance, at: Date): Required<Pick<TripWrite, 'actual_distance_km' | 'actual_distance_source' | 'actual_distance_points' | 'actual_distance_measured_at'>> {
  return {
    actual_distance_km: result.km,
    actual_distance_source: result.km === null ? null : result.source,
    actual_distance_points: result.points,
    actual_distance_measured_at: at,
  };
}

export class TripDistanceService {
  constructor(private readonly deps: TripDistanceDeps) {}

  /**
   * How far the trip went, from its positions between `start` and `end`; null when there is nothing to ask (no
   * vehicle, no start, or the positions are not connected): the trip is then left unmeasured.
   */
  async measure(db: Queryable, trip: { id: string; vehicleId: string | null }, start: Date | null, end: Date): Promise<TripDistance | null> {
    const track = this.deps.track();
    if (!track || !trip.vehicleId || !start) return null;
    const points = await track.tripTrack(db, { tripId: trip.id, vehicleId: trip.vehicleId, start, end }, TRACK_LIMIT);
    if (points.length === TRACK_LIMIT) {
      this.deps.warn?.({ tripId: trip.id, points: points.length }, 'trip distance: position limit reached, the distance covers the first part only');
    }
    return measureTrip(points, start.getTime(), end.getTime());
  }

  /**
   * The hourly job: trips completed in the last REMEASURE_DAYS days that were never measured, or have gained
   * positions since they were, measured again.
   */
  async remeasureRecent(ctx: MutationContext): Promise<MeasureSummary> {
    const track = this.deps.track();
    const summary = emptySummary();
    if (!track) return summary;
    const since = new Date(this.now().getTime() - REMEASURE_DAYS * 86_400_000);
    const candidates = await this.deps.trips.distanceCandidates(this.deps.db, since, REMEASURE_BATCH);
    const counts = await track.tripTrackCounts(this.deps.db, candidates.flatMap((c) => (windowOf(c) ? [windowOf(c)!] : [])));
    for (const c of candidates) {
      summary.checked++;
      if (c.actualDistancePoints !== null && counts.get(c.id) === c.actualDistancePoints) continue;
      await this.measureOne(ctx, c.id, summary);
    }
    return summary;
  }

  /** The backfill: every completed trip with no distance and never measured, in batches; `progress` after each. */
  async backfill(ctx: MutationContext, batch = 500, progress?: (s: MeasureSummary) => void): Promise<MeasureSummary> {
    const summary = emptySummary();
    let after = '0';
    for (;;) {
      const page = await this.deps.trips.unmeasured(this.deps.db, after, batch);
      if (page.length === 0) break;
      for (const c of page) {
        summary.checked++;
        await this.measureOne(ctx, c.id, summary);
      }
      after = page[page.length - 1].id;
      progress?.(summary);
    }
    return summary;
  }

  /** Measures one trip in its own transaction, its row locked, and writes the result if anything changed. */
  private async measureOne(ctx: MutationContext, id: string, summary: MeasureSummary): Promise<void> {
    await this.deps.trips.inTransaction(async (client: PoolClient) => {
      const c = await this.deps.trips.lockCandidate(client, id);
      if (!c || !c.actualEnd) return;
      const result = await this.measure(client, { id: c.id, vehicleId: c.vehicleId }, c.actualStart, c.actualEnd);
      if (!result) return;
      const same = c.actualDistancePoints === result.points && c.actualDistanceKm === result.km && c.actualDistanceSource === (result.km === null ? null : result.source);
      if (same) {
        summary.unchanged++;
        return;
      }
      await this.deps.trips.update(ctx, c.id, distanceWrite(result, this.now()), client);
      summary.measured++;
      if (result.km === null) summary.without[result.reason] = (summary.without[result.reason] ?? 0) + 1;
      else summary.bySource[result.source]++;
    });
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

}

function windowOf(c: DistanceCandidate): TrackWindow | null {
  if (!c.vehicleId || !c.actualStart || !c.actualEnd) return null;
  return { tripId: c.id, vehicleId: c.vehicleId, start: c.actualStart, end: c.actualEnd };
}

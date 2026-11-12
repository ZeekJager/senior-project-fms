import type { PoolClient } from 'pg';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import {
  DEFAULT_DISTANCE_LIMITS,
  addisWeek,
  distanceLimitExceeded,
  distanceStanding,
  type CountedTrip,
  type DistanceLimits,
  type DistanceStanding,
} from '../domain/distance-limit';
import { jobLoad } from '../domain/job-load';
import type { CountedTripRow, TripRepository } from '../infrastructure/trip.repository';
import type { TripStatus } from '../domain/trip';

/** A depot's distance limits (FMS-156): its own, else the fleet's. The integration module's (it keeps the thresholds). */
export type DistanceLimitLookup = (db: Queryable, depotId: string | null) => Promise<DistanceLimits>;

/** The trip being staffed, as the rule needs it. `id` is internal: the trip itself never counts twice. */
export interface DistanceTrip {
  id: string;
  publicId: string;
  depotId: string | null;
  status: TripStatus;
  scheduledStart: Date;
  scheduledEnd: Date | null;
  plannedDistanceKm: number | null;
  plannedDurationSeconds: number | null;
  actualDistanceKm: number | null;
  cargoWeightKg: number | null;
  stopCount: number;
  /** The vehicle it would be driven with: the one being assigned, else its own; null when none or not recorded. */
  payloadCapacityKg: number | null;
}

export interface DistanceLimitServiceDeps {
  trips: Pick<TripRepository, 'countedTrips' | 'lockDriverDistance'>;
  /** The vehicles' payloads by internal id, for the job load of each counted trip (fleet's). */
  payloads: (db: Queryable, vehicleIds: readonly string[]) => Promise<Map<string, number | null>>;
  /** Connected by src/modules/index.ts; not connected, the fleet defaults apply (the rule is never off). */
  limits: () => DistanceLimitLookup | null;
}

/**
 * The driving distance limits (FMS-156, docs/driving-distance-limits.md): each driver's load-weighted distance in the
 * trip's day and week, with the trip and without it. The assignment and a time change refuse past a limit; the dispatch
 * console shows where each driver stands.
 */
export class DistanceLimitService {
  constructor(private readonly deps: DistanceLimitServiceDeps) {}

  async limitsFor(db: Queryable, depotId: string | null): Promise<DistanceLimits> {
    const lookup = this.deps.limits();
    return lookup ? lookup(db, depotId) : DEFAULT_DISTANCE_LIMITS;
  }

  /** Where each driver (internal ids) stands if given the trip. */
  async standings(db: Queryable, trip: DistanceTrip, driverIds: readonly string[]): Promise<Map<string, DistanceStanding>> {
    const limits = await this.limitsFor(db, trip.depotId);
    const week = addisWeek(trip.scheduledStart);
    const rows = await this.deps.trips.countedTrips(db, driverIds, week.start, week.end, trip.id);
    const counted = await this.counted(db, rows);
    const own = toCounted(trip, trip.payloadCapacityKg);
    return new Map(driverIds.map((driverId) => [driverId, distanceStanding(own, counted.filter((c) => c.driverId === driverId), limits)]));
  }

  /**
   * Refuses (409 CONFLICT_DRIVER_DISTANCE_LIMIT) a trip that takes the driver past a limit, on the caller's transaction,
   * after the driver's lock: two trips given to one driver at once are checked one after the other. `blame` is the trip
   * whose change caused it, when that is another one (a trip moved by FMS-139's shift).
   */
  async enforce(client: PoolClient, trip: DistanceTrip, driverId: string, blame?: string): Promise<DistanceStanding> {
    await this.deps.trips.lockDriverDistance(client, driverId);
    const standing = (await this.standings(client, trip, [driverId])).get(driverId)!;
    if (standing.over) throw distanceLimitExceeded(standing.over, blame);
    return standing;
  }

  private async counted(db: Queryable, rows: CountedTripRow[]): Promise<(CountedTrip & { driverId: string })[]> {
    const vehicles = [...new Set(rows.flatMap((r) => (r.cargoWeightKg !== null && r.vehicleId ? [r.vehicleId] : [])))];
    const payloads = vehicles.length > 0 ? await this.deps.payloads(db, vehicles) : new Map<string, number | null>();
    return rows.map((r) => ({ driverId: r.driverId, ...toCounted(r, r.vehicleId ? (payloads.get(r.vehicleId) ?? null) : null) }));
  }
}

function toCounted(
  t: Pick<CountedTripRow, 'status' | 'scheduledStart' | 'scheduledEnd' | 'plannedDistanceKm' | 'plannedDurationSeconds' | 'actualDistanceKm' | 'cargoWeightKg' | 'stopCount'>,
  payloadCapacityKg: number | null,
): CountedTrip {
  return {
    status: t.status,
    scheduledStart: t.scheduledStart,
    plannedDistanceKm: t.plannedDistanceKm,
    actualDistanceKm: t.actualDistanceKm,
    jobLoad: jobLoad({
      plannedDistanceKm: t.plannedDistanceKm,
      plannedDurationSeconds: t.plannedDurationSeconds,
      scheduledStart: t.scheduledStart,
      scheduledEnd: t.scheduledEnd,
      stopCount: t.stopCount,
      cargoWeightKg: t.cargoWeightKg,
      payloadCapacityKg,
    }).level,
  };
}

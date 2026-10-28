import { depotScope, type Scope } from '../../../shared/authz/scope';
import { notFound, validationFailed } from '../../../shared/errors/app-error';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { RequestUser } from '../../../types/express';
import { encodeTrackCursor, type TrackPointView, type TrackQuery } from '../domain/track-history';
import type { TrackingRepository } from '../infrastructure/tracking.repository';

/** What the history needs from fleet and trip (connected in integration/index.ts). */
export interface TrackHistoryRefs {
  vehicles: { byPublicIds(db: Queryable, publicIds: readonly string[], scope: Scope): Promise<{ id: string; publicId: string }[]> };
  trips: { partiesByIds(db: Queryable, ids: readonly string[]): Promise<Map<string, { publicId: string }>> };
}

export interface TrackHistoryServiceDeps {
  db: Queryable;
  tracking: TrackingRepository;
  refs: TrackHistoryRefs;
}

/**
 * A vehicle's GPS history (FMS-136, api-contract §11): where it was, oldest first, a page at a time. Behavioural
 * data (§24.3): tracking:read only, in the caller's depot scope; another depot's vehicle is not found.
 */
export class TrackHistoryService {
  constructor(private readonly deps: TrackHistoryServiceDeps) {}

  async forVehicle(user: RequestUser, vehiclePublicId: string, query: TrackQuery): Promise<{ points: TrackPointView[]; nextCursor: string | null }> {
    const { db, tracking, refs } = this.deps;
    if (query.from && query.to && query.from >= query.to) throw validationFailed([{ field: 'to', reason: 'before_from' }], '`to` must be after `from`.');
    const [vehicle] = await refs.vehicles.byPublicIds(db, [vehiclePublicId], depotScope(user));
    if (!vehicle) throw notFound('Vehicle not found.');

    // One more than the page: whether another page follows.
    const rows = await tracking.history(db, vehicle.id, { ...query, limit: query.limit + 1 });
    const page = rows.slice(0, query.limit);
    const trips = await refs.trips.partiesByIds(db, [...new Set(page.flatMap((r) => (r.tripId ? [r.tripId] : [])))]);
    const last = page.at(-1);
    return {
      points: page.map((r) => ({
        recorded_at: r.recordedAt.toISOString(),
        lat: r.lat,
        lng: r.lng,
        speed_kmh: r.speedKmh,
        heading: r.heading,
        altitude_m: r.altitudeM,
        accuracy_m: r.accuracyM,
        ignition_on: r.ignitionOn,
        odometer_km: r.odometerKm,
        source: r.source,
        trip_id: r.tripId ? (trips.get(r.tripId)?.publicId ?? null) : null,
      })),
      nextCursor: rows.length > query.limit && last ? encodeTrackCursor({ at: last.at, id: last.id }) : null,
    };
  }
}

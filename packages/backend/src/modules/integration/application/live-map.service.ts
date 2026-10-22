import { depotScope, type Scope } from '../../../shared/authz/scope';
import type { Cache } from '../../../shared/cache/cache';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { RequestUser } from '../../../types/express';
import { LIVE_MAP_CACHE_TTL_SECONDS, type VehicleLocation } from '../domain/live-map';
import type { TrackingRepository } from '../infrastructure/tracking.repository';

/** A vehicle as the live map lists it, from the fleet module. */
export interface LiveMapVehicleRef {
  id: string;
  publicId: string;
  registrationNumber: string;
  vehicleType: string;
  status: string;
  maintenanceFlag: boolean;
  depotPublicId: string | null;
}

/** A trip under way, from the trip module. */
export interface LiveMapTripRef {
  tripId: string;
  routeName: string | null;
  origin: string | null;
  destination: string | null;
  driverId: string | null;
  actualStart: Date | null;
  scheduledEnd: Date | null;
}

/** What the live map needs from fleet and trip (connected in integration/index.ts). */
export interface LiveMapRefs {
  vehicles: { liveMap(db: Queryable, scope: Scope, depotId: string | null): Promise<LiveMapVehicleRef[]> };
  drivers: { names(db: Queryable, ids: readonly string[]): Promise<Map<string, { publicId: string; fullName: string | null }>> };
  depots: {
    resolveInScope(db: Queryable, publicId: string, scope: Scope): Promise<string | null>;
    publicIds(db: Queryable, ids: readonly string[]): Promise<Map<string, string>>;
  };
  trips: { liveForVehicles(db: Queryable, vehicleIds: readonly string[]): Promise<Map<string, LiveMapTripRef>> };
}

export interface LiveMapServiceDeps {
  db: Queryable;
  tracking: TrackingRepository;
  refs: LiveMapRefs;
  cache: Cache;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * The live map's snapshot (FMS-45): the caller's vehicles that have a position or a trip under way, each
 * with its newest position, trip and driver, and open telemetry flags. Scoped like the vehicles (a depot's
 * staff see their depot); a depot filter outside the scope gives an empty list.
 *
 * What a caller sees is one depot or all of them, so the cache holds one snapshot per depot (by public id)
 * and one for "all", shared by everyone who sees it, for a few seconds (LIVE_MAP_CACHE_TTL_SECONDS).
 */
export class LiveMapService {
  constructor(private readonly deps: LiveMapServiceDeps) {}

  async current(user: RequestUser, query: { depotId?: string }): Promise<VehicleLocation[]> {
    const { db, refs, cache } = this.deps;
    const scope = depotScope(user);
    if (scope.kind === 'none') return [];
    let depotId: string | null = null;
    let shown = 'all';
    if (query.depotId) {
      depotId = await refs.depots.resolveInScope(db, query.depotId, scope);
      if (!depotId) return [];
      shown = query.depotId;
    } else if (scope.kind === 'depot') {
      depotId = scope.depotId;
      const publicId = (await refs.depots.publicIds(db, [depotId])).get(depotId);
      if (!publicId) return [];
      shown = publicId;
    }
    return cache.getOrSet(cache.key('integration', 'live-map', shown), LIVE_MAP_CACHE_TTL_SECONDS, () => this.load(depotId));
  }

  /** Drops every cached snapshot: a trip started or ended, a vehicle changed. */
  async invalidate(): Promise<void> {
    await this.deps.cache.invalidate('integration:live-map:*');
  }

  /** One depot's vehicles (internal id; already checked against the caller's scope), or every depot's. */
  private async load(depotId: string | null): Promise<VehicleLocation[]> {
    const { db, tracking, refs } = this.deps;
    const vehicles = await refs.vehicles.liveMap(db, { kind: 'all' }, depotId);
    const ids = vehicles.map((v) => v.id);
    // One after another: a transaction's client (tests, a caller's own) runs one query at a time anyway.
    const positions = await tracking.livePositions(db, ids);
    const flags = await tracking.openFlags(db, ids);
    const trips = await refs.trips.liveForVehicles(db, ids);
    const driverIds = [...new Set([...trips.values()].map((t) => t.driverId).filter((id): id is string => id !== null))];
    const drivers = await refs.drivers.names(db, driverIds);

    const positionOf = new Map(positions.map((p) => [p.vehicleId, p]));
    const flagsOf = new Map<string, VehicleLocation['flags']>();
    for (const f of flags) flagsOf.set(f.vehicleId, [...(flagsOf.get(f.vehicleId) ?? []), { flag_type: f.flagType, severity: f.severity, observed_at: f.observedAt.toISOString() }]);

    const out: VehicleLocation[] = [];
    for (const v of vehicles) {
      const p = positionOf.get(v.id);
      const t = trips.get(v.id);
      if (!p && !t) continue;
      const driver = t?.driverId ? drivers.get(t.driverId) : undefined;
      out.push({
        vehicle_id: v.publicId,
        registration_number: v.registrationNumber,
        vehicle_type: v.vehicleType,
        vehicle_status: v.status,
        maintenance_flag: v.maintenanceFlag,
        depot_id: v.depotPublicId,
        position: p
          ? {
              lat: p.lat,
              lng: p.lng,
              speed_kmh: p.speedKmh,
              heading: p.heading,
              accuracy_m: p.accuracyM,
              ignition_on: p.ignitionOn,
              recorded_at: p.recordedAt.toISOString(),
              stopped_since: iso(p.stoppedSince),
            }
          : null,
        trip: t
          ? {
              trip_id: t.tripId,
              route_name: t.routeName,
              origin: t.origin,
              destination: t.destination,
              started_at: iso(t.actualStart),
              scheduled_end: iso(t.scheduledEnd),
              driver: driver ? { driver_id: driver.publicId, full_name: driver.fullName } : null,
            }
          : null,
        flags: flagsOf.get(v.id) ?? [],
      });
    }
    return out;
  }
}

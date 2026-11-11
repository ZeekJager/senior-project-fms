import { Router } from 'express';
import { pool } from '../../db';
import { eventBus } from '../../shared/events/event-bus';
import type { Queryable } from '../../shared/infrastructure/queryable';
import type { AppModule } from '../../shared/module';
import type { RequestUser } from '../../types/express';
import { routeRouter } from './api/route.routes';
import { tripRouter } from './api/trip.routes';
import { config } from '../../config';
import { cache } from '../../shared/cache';
import { logger } from '../../shared/logging/logger';
import { TripDistanceService, type MeasureSummary, type TrackLookup } from './application/distance.service';
import { EtaService } from './application/eta.service';
import { RouteService, type FleetRefs, type MaintenanceRefs } from './application/route.service';
import { TripService, type PositionLookup } from './application/trip.service';
import { LOCATION_UPDATED } from './domain/eta';
import { OsrmRoadPlanner, type RoadPlanner, type RoutingGatewayClient } from './infrastructure/osrm.planner';
import { RouteRepository } from './infrastructure/route.repository';
import { TripRepository } from './infrastructure/trip.repository';
import { driverTripsExport } from './infrastructure/driver-trips-export.queries';

let fleetRefs: FleetRefs | null = null;

/**
 * Connects the fleet module's depot, vehicle and driver lookups. Called once
 * by src/modules/index.ts: trip cannot import fleet itself, since fleet imports trip.
 */
export function provideFleetRefs(refs: FleetRefs): void {
  fleetRefs = refs;
}

let maintenanceRefs: MaintenanceRefs | null = null;

/** Connects the maintenance module's lookup (it imports fleet, which imports trip). Called once by src/modules/index.ts. */
export function provideMaintenanceRefs(refs: MaintenanceRefs): void {
  maintenanceRefs = refs;
}

let roadPlanner: RoadPlanner | null = null;

/**
 * Connects the routing engine (FMS-84) through the integration gateway, which imports trip. Called once by
 * src/modules/index.ts when ROUTING_URL is set; never called (or null, as tests reset it), routes keep the distance typed in.
 */
export function provideRoutingClient(client: ((correlationId: string) => RoutingGatewayClient) | null): void {
  roadPlanner = client ? new OsrmRoadPlanner(client, cache) : null;
}

let positionLookup: PositionLookup | null = null;

/**
 * Connects the vehicles' newest positions for GET /trips/{id}/live (FMS-95): the integration module's, which imports
 * trip. Called once by src/modules/index.ts.
 */
export function provideTripPositions(lookup: PositionLookup | null): void {
  positionLookup = lookup;
}

let trackLookup: TrackLookup | null = null;

/**
 * Connects the positions stored during trips (FMS-145): the integration module's, which imports trip. Called once by
 * src/modules/index.ts. Not connected, trips end unmeasured and the `trip-distance` job measures them once it is.
 */
export function provideTripTrack(lookup: TrackLookup | null): void {
  trackLookup = lookup;
}

function fleet(): FleetRefs {
  if (!fleetRefs) throw new Error('trip: no fleet lookups provided; src/modules/index.ts connects the fleet module');
  return fleetRefs;
}

function maintenance(): MaintenanceRefs {
  if (!maintenanceRefs) throw new Error('trip: no maintenance lookup provided; src/modules/index.ts connects the maintenance module');
  return maintenanceRefs;
}

const routeRepository = new RouteRepository(pool);
const routeService = new RouteService({
  routes: routeRepository,
  fleet,
  events: eventBus,
  roads: () => roadPlanner,
  warn: (fields, message) => logger.warn(fields, message),
});
const tripRepository = new TripRepository(pool);
// Each trip's actual distance (FMS-145, docs/trip-distance.md): measured as it ends, and again while late positions arrive.
const distanceService = new TripDistanceService({
  db: pool,
  trips: tripRepository,
  track: () => trackLookup,
  warn: (fields, message) => logger.warn(fields, message),
});
const tripService = new TripService({
  distance: distanceService,
  trips: tripRepository,
  routes: routeRepository,
  fleet,
  maintenance,
  events: eventBus,
  overrunGraceMinutes: config.trips.overrunGraceMinutes,
  positions: () => positionLookup,
});

// Live arrival times (FMS-86, docs/eta.md): each announced position of a trip under way, at most every 30 seconds
// of position time per trip, marks the stops reached and measures the road ahead; TripEtaUpdated follows.
const etaService = new EtaService({
  trips: tripRepository,
  events: eventBus,
  roads: () => roadPlanner,
  warn: (fields, message) => logger.warn(fields, message),
});
eventBus.subscribe(LOCATION_UPDATED, 'trip.eta', (event, tx) => etaService.onLocationUpdated(tx, event));

const router = Router();
router.use(routeRouter(routeService));
router.use(tripRouter(tripService));

export const tripModule: AppModule = {
  name: 'trip',
  router,
  jobs: [
    {
      // FMS-84: the road of routes saved while the routing engine was down or before it was set up.
      name: 'route-roads',
      every: 60,
      run: (context) => routeService.measureMissing(context.correlationId),
    },
    {
      // FMS-145: trips completed in the last 8 days that were never measured, or have since gained positions.
      name: 'trip-distance',
      every: 60,
      run: async (context) => flatSummary(await distanceService.remeasureRecent({ userId: null, correlationId: context.correlationId })),
    },
  ],
};

/** A measurement summary as a job result: counts only. */
export function flatSummary(s: MeasureSummary): Record<string, number> {
  return { checked: s.checked, measured: s.measured, odometer: s.bySource.odometer, gps: s.bySource.gps, no_positions: s.without.no_positions ?? 0, unchanged: s.unchanged };
}

/**
 * For tests and `npm run backfill:trip-distance` (FMS-145): the hourly job's work, and measuring every completed
 * trip never measured.
 */
export const tripDistance = {
  remeasureRecent: (correlationId: string) => distanceService.remeasureRecent({ userId: null, correlationId }),
  backfill: (correlationId: string, progress?: (s: MeasureSummary) => void) => distanceService.backfill({ userId: null, correlationId }, 500, progress),
};

/**
 * For the fuel module: a trip the user may see (null if missing or out of
 * scope), and trips' public ids by internal id. For the real-time gateway:
 * a trip's summary.
 */
export const tripLookups = {
  find: (db: Queryable, user: RequestUser, publicId: string) => tripService.refVisibleTo(db, user, publicId),
  publicIds: (db: Queryable, ids: readonly string[]) => tripRepository.publicIdsByIds(db, ids),
  /** Internal ids by public id, for the alert engine's trip column (FMS-92). */
  idsByPublicIds: (db: Queryable, publicIds: readonly string[]) => tripRepository.idsByPublicIds(db, publicIds),
  /** For the real-time gateway (FMS-43): a trip's summary for `trip.updated`, with no caller. */
  summary: (db: Queryable, publicId: string) => tripService.summary(db, publicId),
};

export { ROUTE_EVENTS } from './domain/route';
export { ROUTING_TIMEOUT_MS } from './infrastructure/osrm.planner';
export { TRIP_EVENTS, type TripSummary } from './domain/trip';
export { TRIP_ETA_UPDATED } from './domain/eta';

/**
 * For other modules: whether a vehicle or driver is on an assigned or
 * en-route trip (fleet blocks retirement), each vehicle's current trip (the
 * vehicle and driver lists show it), and trips' assignment state for fleet's
 * availability read model (FMS-76).
 */
export {
  activeAssignments,
  activeTripsForDrivers,
  activeTripsForVehicles,
  tripAssignment,
  type TripAssignmentState,
  driverHasActiveTrip,
  vehicleHasActiveTrip,
  vehicleOnActiveTripSql,
  type ActiveTrip,
} from './infrastructure/trip-activity.queries';

/**
 * For GPS ingestion (FMS-88): the trips under way by vehicle, and a driver's own trip under way (their phone reports for it).
 * FMS-124: the trips a driver or vehicles drove in a span of time, so a ping is placed in the trip it was recorded in.
 */
export { enRouteTripOfDriver, enRouteTripsForVehicles, tripSpansOfDriver, tripSpansOfVehicles, type EnRouteTrip, type TripSpan } from './infrastructure/trip-activity.queries';

/** For the live map (FMS-45): each vehicle's trip under way, with its route and driver. */
export { liveTripsForVehicles, type LiveTrip } from './infrastructure/trip-activity.queries';

/** For the command center's overview (FMS-89): a depot's trips of the day by status, and those under way. */
export { tripBoard, type TripBoard } from './infrastructure/command-center.queries';

/** For the telemetry rules (FMS-46): a flag's trip, by the internal id its pings carry, with its driver. */
export { tripPartiesByIds, type TripParties } from './infrastructure/trip-activity.queries';

/** For the geofence and route deviation rules (FMS-90): the road each trip follows, by the internal id its pings carry. */
export { tripRoadsByIds, type TripRoad } from './infrastructure/trip-activity.queries';

/** For the nightly scoring (FMS-55): completed trips' kilometres and driving time over a window, and kilometres since a time. */
export { completedDistanceAfter, completedTripMetres, completedTripUsage, type TripUsage } from './infrastructure/trip-usage.queries';

/** For a driver's data export (FMS-104): their trips, by the driver's internal id. */
export const driverTripData = { forDriver: (db: Queryable, driverId: string) => driverTripsExport(db, driverId) };
export type { DriverTripExport } from './infrastructure/driver-trips-export.queries';

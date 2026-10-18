import { Router } from 'express';
import { pool } from '../../db';
import { eventBus } from '../../shared/events/event-bus';
import type { AppModule } from '../../shared/module';
import { routeRouter } from './api/route.routes';
import { tripRouter } from './api/trip.routes';
import { RouteService, type FleetRefs } from './application/route.service';
import { TripService } from './application/trip.service';
import { RouteRepository } from './infrastructure/route.repository';
import { TripRepository } from './infrastructure/trip.repository';

let fleetRefs: FleetRefs | null = null;

/**
 * Connects the fleet module's depot, vehicle and driver lookups. Called once
 * by src/modules/index.ts: trip cannot import fleet itself, since fleet imports trip.
 */
export function provideFleetRefs(refs: FleetRefs): void {
  fleetRefs = refs;
}

function fleet(): FleetRefs {
  if (!fleetRefs) throw new Error('trip: no fleet lookups provided; src/modules/index.ts connects the fleet module');
  return fleetRefs;
}

const routeService = new RouteService({ routes: new RouteRepository(pool), fleet, events: eventBus });
const tripService = new TripService({ trips: new TripRepository(pool), fleet, events: eventBus });

const router = Router();
router.use(routeRouter(routeService));
router.use(tripRouter(tripService));

export const tripModule: AppModule = { name: 'trip', router };

export { ROUTE_EVENTS } from './domain/route';
export { TRIP_EVENTS } from './domain/trip';

/**
 * For other modules: whether a vehicle or driver is on an assigned or
 * en-route trip (fleet blocks retirement), and each vehicle's current trip
 * (the vehicle and driver lists show it).
 */
export {
  activeTripsForDrivers,
  activeTripsForVehicles,
  driverHasActiveTrip,
  vehicleHasActiveTrip,
  vehicleOnActiveTripSql,
  type ActiveTrip,
} from './infrastructure/trip-activity.queries';

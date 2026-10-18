import { Router } from 'express';
import { pool } from '../../db';
import { eventBus } from '../../shared/events/event-bus';
import type { AppModule } from '../../shared/module';
import { routeRouter } from './api/route.routes';
import { RouteService, type RouteServiceDeps } from './application/route.service';
import { RouteRepository } from './infrastructure/route.repository';

type DepotRefs = ReturnType<RouteServiceDeps['depots']>;

let depotRefs: DepotRefs | null = null;

/**
 * Connects the fleet module's depot lookup. Called once by src/modules/index.ts:
 * trip cannot import fleet itself, since fleet imports trip.
 */
export function provideDepotRefs(refs: DepotRefs): void {
  depotRefs = refs;
}

const routeService = new RouteService({
  routes: new RouteRepository(pool),
  depots: () => {
    if (!depotRefs) throw new Error('trip: no depot lookup provided; src/modules/index.ts connects the fleet module');
    return depotRefs;
  },
  events: eventBus,
});

const router = Router();
router.use(routeRouter(routeService));

export const tripModule: AppModule = { name: 'trip', router };

export { ROUTE_EVENTS } from './domain/route';

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

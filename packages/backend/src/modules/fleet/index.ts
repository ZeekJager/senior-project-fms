import { Router } from 'express';
import { pool } from '../../db';
import { eventBus } from '../../shared/events/event-bus';
import type { Queryable } from '../../shared/infrastructure/queryable';
import type { AppModule } from '../../shared/module';
import { userDirectory, type DepotDirectory } from '../auth';
import { driverHasActiveTrip, vehicleHasActiveTrip } from '../trip';
import { driverRouter } from './api/driver.routes';
import { fleetRouter } from './api/fleet.routes';
import { vehicleRouter } from './api/vehicle.routes';
import { DriverService } from './application/driver.service';
import { VehicleService } from './application/vehicle.service';
import { depotPublicIds, findDepotPublicId, resolveDepotInScope } from './infrastructure/depot.queries';
import { DriverRepository } from './infrastructure/driver.repository';
import { VehicleRepository } from './infrastructure/vehicle.repository';

const vehicleService = new VehicleService({
  vehicles: new VehicleRepository(pool),
  trips: { vehicleHasActiveTrip },
  events: eventBus,
});

const driverService = new DriverService({
  drivers: new DriverRepository(pool),
  users: userDirectory,
  depots: { resolveInScope: resolveDepotInScope, publicIds: depotPublicIds },
  trips: { driverHasActiveTrip },
  events: eventBus,
});

const router = Router();
router.use(fleetRouter);
router.use(vehicleRouter(vehicleService));
router.use(driverRouter(driverService));

export const fleetModule: AppModule = { name: 'fleet', router };

/** Depot lookups other modules need; the auth module uses it for /auth/me. */
export const depotDirectory: DepotDirectory = {
  publicIdOf: (depotId) => findDepotPublicId(pool, depotId),
};

/**
 * For the trip module: whether a driver (internal id) may be dispatched at
 * `at` (not retired, licence valid on that date in Addis Ababa, account
 * active). Pass the caller's transaction client as `db` to read inside it.
 */
export function isDriverEligible(driverId: string, at: Date, db: Queryable = pool): Promise<boolean> {
  return driverService.isEligible(db, driverId, at);
}

/** Event types, for modules that subscribe to them. */
export { DRIVER_EVENTS } from './domain/driver';
export { VEHICLE_EVENTS } from './domain/vehicle';

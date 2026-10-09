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
import type { DriverEligibility } from './domain/driver';
import { VehicleService } from './application/vehicle.service';
import { depotPublicIds, findDepotPublicId, resolveDepotInScope } from './infrastructure/depot.queries';
import { DriverRepository } from './infrastructure/driver.repository';
import { VehicleRepository } from './infrastructure/vehicle.repository';

const vehicleRepository = new VehicleRepository(pool);

const vehicleService = new VehicleService({
  vehicles: vehicleRepository,
  trips: { vehicleHasActiveTrip },
  events: eventBus,
});

const driverService = new DriverService({
  drivers: new DriverRepository(pool),
  vehicles: { typeOf: (db, vehicleId) => vehicleRepository.typeOf(db, vehicleId) },
  users: userDirectory,
  depots: { resolveInScope: resolveDepotInScope, publicIds: depotPublicIds },
  trips: { driverHasActiveTrip },
  events: eventBus,
});

const router = Router();
router.use(fleetRouter);
router.use(vehicleRouter(vehicleService));
router.use(driverRouter(driverService));

export const fleetModule: AppModule = {
  name: 'fleet',
  router,
  jobs: [
    {
      // DriverLicenseExpiring 30 and 7 days before a licence expires.
      name: 'driver-licence-expiry-warnings',
      hour: 6,
      run: async (now) => {
        await driverService.publishExpiringLicences(now);
      },
    },
  ],
};

/** Depot lookups other modules need; the auth module uses it for /auth/me. */
export const depotDirectory: DepotDirectory = {
  publicIdOf: (depotId) => findDepotPublicId(pool, depotId),
};

/**
 * For the trip module: whether a driver (internal id) may be dispatched at
 * `at`, with every reason if not (retired, account not active, licence
 * expired on that date in Addis Ababa, and with `vehicleId` a licence class
 * that does not cover the vehicle's type). Pass the caller's transaction
 * client as `db` to read inside it.
 */
export function checkDriverEligibility(
  driverId: string,
  at: Date,
  options: { vehicleId?: string; db?: Queryable } = {},
): Promise<DriverEligibility> {
  return driverService.checkEligibility(options.db ?? pool, driverId, at, options.vehicleId);
}

/** `checkDriverEligibility(...).eligible`, for callers that need only yes or no. */
export async function isDriverEligible(driverId: string, at: Date, db: Queryable = pool): Promise<boolean> {
  return (await checkDriverEligibility(driverId, at, { db })).eligible;
}

export type { DriverEligibility, EligibilityReason } from './domain/driver';

/** Event types, for modules that subscribe to them. */
export { DRIVER_EVENTS } from './domain/driver';
export { VEHICLE_EVENTS } from './domain/vehicle';

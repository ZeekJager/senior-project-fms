import { Router } from 'express';
import { pool } from '../../db';
import { eventBus } from '../../shared/events/event-bus';
import type { AppModule } from '../../shared/module';
import type { DepotDirectory } from '../auth';
import { vehicleHasActiveTrip } from '../trip';
import { fleetRouter } from './api/fleet.routes';
import { vehicleRouter } from './api/vehicle.routes';
import { VehicleService } from './application/vehicle.service';
import { findDepotPublicId } from './infrastructure/depot.queries';
import { VehicleRepository } from './infrastructure/vehicle.repository';

const vehicleService = new VehicleService({
  vehicles: new VehicleRepository(pool),
  trips: { vehicleHasActiveTrip },
  events: eventBus,
});

const router = Router();
router.use(fleetRouter);
router.use(vehicleRouter(vehicleService));

export const fleetModule: AppModule = { name: 'fleet', router };

/** Depot lookups other modules need; the auth module uses it for /auth/me. */
export const depotDirectory: DepotDirectory = {
  publicIdOf: (depotId) => findDepotPublicId(pool, depotId),
};

/** Vehicle event types, for modules that subscribe to them. */
export { VEHICLE_EVENTS } from './domain/vehicle';

import { Router } from 'express';
import { config } from '../../config';
import { pool } from '../../db';
import { eventBus } from '../../shared/events/event-bus';
import { createDocumentStorage } from '../../shared/storage/document-storage';
import type { Queryable } from '../../shared/infrastructure/queryable';
import type { AppModule } from '../../shared/module';
import { USER_EVENTS, userDirectory, type DepotDirectory } from '../auth';
import { activeTripsForDrivers, activeTripsForVehicles, driverHasActiveTrip, vehicleHasActiveTrip } from '../trip';
import { attendanceRouter } from './api/attendance.routes';
import { depotRouter } from './api/depot.routes';
import { documentRouter } from './api/document.routes';
import { driverRouter } from './api/driver.routes';
import { vehicleRouter } from './api/vehicle.routes';
import { AttendanceService } from './application/attendance.service';
import { DepotService } from './application/depot.service';
import { DocumentService } from './application/document.service';
import { DocumentUrlSigner } from './application/document-url';
import { DriverService } from './application/driver.service';
import type { DriverEligibility } from './domain/driver';
import { VehicleService } from './application/vehicle.service';
import { depotPublicIdByCode, depotPublicIds, findDepotPublicId, resolveDepotInScope } from './infrastructure/depot.queries';
import { AttendanceRepository } from './infrastructure/attendance.repository';
import { DepotRepository } from './infrastructure/depot.repository';
import { driverAccounts } from './infrastructure/driver-account.projection';
import { DocumentRepository } from './infrastructure/document.repository';
import { DriverRepository } from './infrastructure/driver.repository';
import { VehicleRepository } from './infrastructure/vehicle.repository';

const vehicleRepository = new VehicleRepository(pool, activeTripsForVehicles);

const vehicleService = new VehicleService({
  vehicles: vehicleRepository,
  trips: { vehicleHasActiveTrip },
  events: eventBus,
});

const driverRepository = new DriverRepository(pool);
const attendanceRepository = new AttendanceRepository(pool);

const driverService = new DriverService({
  drivers: driverRepository,
  vehicles: { typeOf: (db, vehicleId) => vehicleRepository.typeOf(db, vehicleId) },
  users: userDirectory,
  accounts: driverAccounts,
  depots: { resolveInScope: resolveDepotInScope, publicIds: depotPublicIds, publicIdByCode: depotPublicIdByCode },
  trips: { driverHasActiveTrip, activeTripsForDrivers },
  attendance: { statusOn: (db, ids, date) => attendanceRepository.statusOn(db, ids, date) },
  events: eventBus,
});

const documentService = new DocumentService({
  documents: new DocumentRepository(pool),
  storage: createDocumentStorage(config.storage),
  urls: new DocumentUrlSigner(config.jwtSecret),
  vehicles: {
    findRef: (db, by, scope) => vehicleRepository.findRef(db, by, scope),
    findRefs: (db, publicIds, scope) => vehicleRepository.findRefs(db, publicIds, scope),
  },
  drivers: {
    findByPublicId: (db, id) => driverRepository.findByPublicId(db, id),
    findByPublicIds: (db, ids) => driverRepository.findByPublicIds(db, ids),
    findById: (db, id) => driverRepository.findById(db, id),
  },
  users: userDirectory,
  events: eventBus,
});

// Keep fleet's copy of driver account fields current when another module changes an account.
eventBus.subscribe(USER_EVENTS.accountChanged, async (event) => {
  if (typeof event.payload.user_id === 'string') await driverService.onAccountChanged(event.payload.user_id);
});

const attendanceService = new AttendanceService({
  attendance: attendanceRepository,
  drivers: { findByPublicId: (db, id) => driverRepository.findByPublicId(db, id) },
  users: userDirectory,
  depots: { resolveInScope: resolveDepotInScope, publicIds: depotPublicIds },
  events: eventBus,
});

const depotService = new DepotService({ depots: new DepotRepository(pool), users: userDirectory, events: eventBus });

const router = Router();
router.use(depotRouter(depotService));
router.use(attendanceRouter(attendanceService));
router.use(vehicleRouter(vehicleService));
router.use(driverRouter(driverService));
router.use(documentRouter(documentService));

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
    {
      // Re-copies every driver's account fields, repairing any missed UserAccountChanged.
      name: 'driver-account-sync',
      hour: 3,
      run: async () => {
        await driverService.syncAccounts();
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
export { ATTENDANCE_EVENTS } from './domain/attendance';
export { DEPOT_EVENTS } from './domain/depot';
export { DRIVER_EVENTS } from './domain/driver';
export { DOCUMENT_EVENTS } from './domain/document';
export { VEHICLE_EVENTS } from './domain/vehicle';

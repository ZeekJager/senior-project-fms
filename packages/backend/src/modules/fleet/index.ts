import { Router } from 'express';
import type { PoolClient } from 'pg';
import { config } from '../../config';
import { pool } from '../../db';
import { cache } from '../../shared/cache';
import { eventBus } from '../../shared/events/event-bus';
import { createDocumentStorage } from '../../shared/storage/document-storage';
import type { MutationContext } from '../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../shared/infrastructure/queryable';
import type { AppModule } from '../../shared/module';
import { USER_EVENTS, userDirectory, type DepotDirectory, type Scope } from '../auth';
import { activeTripsForDrivers, activeTripsForVehicles, driverHasActiveTrip, tripLookups, vehicleHasActiveTrip, vehicleOnActiveTripSql } from '../trip';
import { attendanceRouter } from './api/attendance.routes';
import { depotRouter } from './api/depot.routes';
import { documentRouter } from './api/document.routes';
import { driverRouter } from './api/driver.routes';
import { dvirRouter } from './api/dvir.routes';
import { vehicleRouter } from './api/vehicle.routes';
import { AttendanceService } from './application/attendance.service';
import { DepotService } from './application/depot.service';
import { DocumentService } from './application/document.service';
import { DocumentUrlSigner } from './application/document-url';
import { DriverService } from './application/driver.service';
import { DvirService } from './application/dvir.service';
import { ExpiryService } from './application/expiry.service';
import { DOCUMENT_EVENTS } from './domain/document';
import type { DriverEligibility } from './domain/driver';
import { VehicleService } from './application/vehicle.service';
import { depotPublicIdByCode, depotPublicIds, findDepotPublicId, resolveDepotInScope } from './infrastructure/depot.queries';
import { AttendanceRepository } from './infrastructure/attendance.repository';
import { DepotRepository } from './infrastructure/depot.repository';
import { driverAccounts } from './infrastructure/driver-account.projection';
import { DocumentRepository } from './infrastructure/document.repository';
import { DriverRepository } from './infrastructure/driver.repository';
import { DvirRepository } from './infrastructure/dvir.repository';
import { ExpiryRepository } from './infrastructure/expiry.repository';
import { VehicleRepository } from './infrastructure/vehicle.repository';

const vehicleRepository = new VehicleRepository(pool, activeTripsForVehicles, vehicleOnActiveTripSql);

const vehicleService = new VehicleService({
  vehicles: vehicleRepository,
  trips: { vehicleHasActiveTrip },
  events: eventBus,
  cache,
});

// The maintenance module sets and clears the maintenance flag inside its
// own transaction; its events are delivered after commit, so the cached
// vehicle is dropped only once the change is visible. By name: fleet cannot
// import the maintenance module, which imports fleet.
for (const type of ['MaintenanceRecordOpened', 'MaintenanceRecordUpdated', 'MaintenanceRecordCompleted', 'VehicleFaultDetected']) {
  eventBus.subscribe(type, 'fleet.vehicle-cache', async (event) => {
    if (typeof event.payload.vehicle_id === 'string') await vehicleService.invalidate(event.payload.vehicle_id);
  });
}

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
eventBus.subscribe(USER_EVENTS.accountChanged, 'fleet.driver-accounts', async (event, tx) => {
  if (typeof event.payload.user_id === 'string') await driverService.onAccountChanged(tx, event.payload.user_id);
});

const expiryService = new ExpiryService({
  db: pool,
  expiry: new ExpiryRepository(),
  users: userDirectory,
  depots: { publicIds: depotPublicIds },
  events: eventBus,
});

// A document uploaded already inside the 30-day window is flagged at once,
// not at the next 07:00 check (FMS-26). The notice table keeps the two from
// raising it twice.
eventBus.subscribe(DOCUMENT_EVENTS.uploaded, 'fleet.document-expiry', async (event, tx) => {
  if (typeof event.payload.document_id !== 'string' || !event.payload.expires_on) return;
  await expiryService.checkDocuments({ now: new Date(), correlationId: event.correlation_id }, event.payload.document_id, tx);
});

const attendanceService = new AttendanceService({
  attendance: attendanceRepository,
  drivers: { findByPublicId: (db, id) => driverRepository.findByPublicId(db, id) },
  users: userDirectory,
  depots: { resolveInScope: resolveDepotInScope, publicIds: depotPublicIds },
  events: eventBus,
});

// An inspection that finds issues sets the maintenance flag inside its own transaction (FMS-36),
// so its VehicleFaultDetected event, like the maintenance ones above, drops the cached vehicle.
const dvirService = new DvirService({
  reports: new DvirRepository(pool),
  vehicles: vehicleRepository,
  drivers: driverRepository,
  users: userDirectory,
  trips: tripLookups,
  events: eventBus,
});

const depotService = new DepotService({ depots: new DepotRepository(pool), users: userDirectory, events: eventBus });

const router = Router();
router.use(depotRouter(depotService));
router.use(attendanceRouter(attendanceService));
router.use(vehicleRouter(vehicleService));
router.use(driverRouter(driverService));
router.use(documentRouter(documentService));
router.use(dvirRouter(dvirService));

/**
 * For the maintenance module (FMS-22): find a vehicle in the caller's scope
 * (optionally row-locked), name vehicles in responses, list the vehicles of a
 * scope, and set or clear the maintenance flag inside its transaction.
 */
export const vehicleMaintenance = {
  findInScope: (db: Queryable, by: { publicId: string } | { id: string }, scope: Scope, lock = false) =>
    vehicleRepository.findForMaintenance(db, by, scope, lock),
  refsByIds: (db: Queryable, ids: readonly string[]) => vehicleRepository.refsByIds(db, ids),
  idsInScope: (db: Queryable, scope: Scope) => vehicleRepository.idsInScope(db, scope),
  setMaintenanceFlag: (client: PoolClient, ctx: MutationContext, id: string, flag: boolean) => vehicleRepository.setMaintenanceFlag(ctx, id, flag, client),
};

/** For other modules: depots by public id in a caller's scope (share-locked), and public ids by internal id. */
export const depotRefs = { resolveInScope: resolveDepotInScope, publicIds: depotPublicIds };

/**
 * For the trip module (FMS-30): depots, vehicles and drivers between public
 * and internal ids, and the driver profile of a signed-in user (a driver
 * sees only their own trips).
 */
export const tripRefs = {
  depots: depotRefs,
  vehicles: {
    idOf: async (db: Queryable, publicId: string) => (await vehicleRepository.findRef(db, { publicId }, { kind: 'all' }))?.id ?? null,
    publicIds: async (db: Queryable, ids: readonly string[]) =>
      new Map([...(await vehicleRepository.refsByIds(db, ids))].map(([id, ref]) => [id, ref.publicId])),
  },
  drivers: {
    idOf: async (db: Queryable, publicId: string) => (await driverRepository.findByPublicId(db, publicId))?.id ?? null,
    idOfUser: async (db: Queryable, userId: string) => (await driverRepository.findByUserId(db, userId))?.id ?? null,
    publicIds: (db: Queryable, ids: readonly string[]) => driverRepository.publicIdsByIds(db, ids),
  },
};

export const fleetModule: AppModule = {
  name: 'fleet',
  router,
  jobs: [
    {
      // DocumentExpiring: amber within 30 days of a document's expiry date, red within 7 (FMS-26).
      name: 'document-expiry-check',
      at: '07:00',
      run: (context) => expiryService.checkDocuments(context),
    },
    {
      // LicenceExpiring: the same levels for driving licences.
      name: 'licence-expiry-check',
      at: '07:00',
      run: (context) => expiryService.checkLicences(context),
    },
    {
      // Re-copies every driver's account fields, repairing any missed UserAccountChanged.
      name: 'driver-account-sync',
      at: '03:00',
      run: async () => ({ synced: await driverService.syncAccounts() }),
    },
  ],
};

/** Depot lookups other modules need; the auth module uses it for /auth/me. */
export const depotDirectory: DepotDirectory = {
  publicIdOf: (depotId) => findDepotPublicId(pool, depotId),
  resolveActive: (publicId, db = pool) => resolveDepotInScope(db, publicId, { kind: 'all' }),
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
export { EXPIRY_EVENTS } from './domain/expiry';
export { VEHICLE_EVENTS } from './domain/vehicle';

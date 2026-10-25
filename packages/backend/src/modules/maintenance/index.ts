import { Router } from 'express';
import { config } from '../../config';
import { pool } from '../../db';
import { eventBus } from '../../shared/events/event-bus';
import type { MutationContext } from '../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../shared/infrastructure/queryable';
import type { JobContext } from '../../shared/jobs/job';
import { logger } from '../../shared/logging/logger';
import type { AppModule } from '../../shared/module';
import { incidentLookup } from '../alert';
import { userDirectory } from '../auth';
import { depotRefs, vehicleMaintenance } from '../fleet';
import { inventoryRouter } from './api/inventory.routes';
import { maintenanceRouter } from './api/maintenance.routes';
import { mlModelRouter } from './api/ml-model.routes';
import { InventoryService } from './application/inventory.service';
import { MaintenanceService } from './application/maintenance.service';
import { MlModelService } from './application/ml-model.service';
import { FailureRepository } from './infrastructure/failure.repository';
import { featureSpecLoader } from './infrastructure/feature-spec';
import { InventoryRepository } from './infrastructure/inventory.repository';
import { MaintenanceRepository } from './infrastructure/maintenance.repository';
import { MlModelRepository, type MlModelListFilter } from './infrastructure/ml-model.repository';
import { HttpMlServiceClient } from './infrastructure/ml-service.client';

const maintenanceRepository = new MaintenanceRepository(pool);

const maintenanceService = new MaintenanceService({
  records: maintenanceRepository,
  vehicles: vehicleMaintenance,
  failures: new FailureRepository(pool),
  incidents: incidentLookup,
  users: userDirectory,
  depots: depotRefs,
  events: eventBus,
});

const inventoryService = new InventoryService({
  parts: new InventoryRepository(pool),
  depots: depotRefs,
  users: userDirectory,
  events: eventBus,
});

const featureSpec = featureSpecLoader(config.ml.featureSpecPath);

const mlModelService = new MlModelService({
  models: new MlModelRepository(pool),
  // Read when called: unset, nothing can be scored.
  client: () => (config.ml.service ? new HttpMlServiceClient(config.ml.service) : null),
  spec: featureSpec,
  users: userDirectory,
  events: eventBus,
  log: logger,
});

const router = Router();
router.use(maintenanceRouter(maintenanceService));
router.use(inventoryRouter(inventoryService));
router.use(mlModelRouter(mlModelService));

export const maintenanceModule: AppModule = { name: 'maintenance', router };

/** For the fleet (FMS-76) and trip (FMS-31) modules: the open record behind a vehicle's maintenance flag, named in CONFLICT_VEHICLE_FLAGGED. */
export const maintenanceRefs = {
  openRecordFor: (db: Queryable, vehicleId: string) => maintenanceRepository.openRecordFor(db, vehicleId),
  /** The open work behind each vehicle's flag, summarized for the dispatcher's board (FMS-33). */
  openRecordSummaries: (db: Queryable, vehicleIds: readonly string[]) => maintenanceRepository.openRecordSummaries(db, vehicleIds),
  /** For the nightly scoring's features (FMS-55): each item's last change on a vehicle before a time (FMS-52). */
  lastServiceItems: (db: Queryable, vehicleId: string, before: Date | null = null) => maintenanceRepository.lastServiceItems(db, vehicleId, before),
  /** For meter readings (FMS-126, fleet): completed repairs with an odometer, completed at or after `since`. */
  completedOdometers: (db: Queryable, since: Date | null) => maintenanceRepository.completedOdometers(db, since),
};

/**
 * For the nightly scoring (FMS-55): before scoring, the model the ML service serves, registered on first
 * sight (FMS-127). Score only when `ok`, and store each prediction with that model's name and version.
 */
export const mlRegistry = {
  checkServing: (context: JobContext) => mlModelService.checkServing(context),
  /** The feature spec the extractor implements: input names in order, version and hash. */
  featureSpec,
};

/** For `npm run ml:model` (FMS-127): the registry, and activation by a named administrator. */
export const mlModelAdmin = {
  list: (filter: MlModelListFilter) => mlModelService.list(filter),
  activate: (publicId: string, ctx: MutationContext) => mlModelService.activateAs(ctx, publicId),
};

export { FAILURE_COMPONENTS, FAILURE_EVENTS, FAILURE_MODES } from './domain/failure';
export { INVENTORY_EVENTS, SERVICE_ITEMS, type ServiceItem } from './domain/inventory';
export { MAINTENANCE_EVENTS } from './domain/maintenance';
export { ML_MODEL_EVENTS, type MlModelView, type ScoringCheck } from './domain/ml-model';
export { MlServiceError } from './infrastructure/ml-service.client';

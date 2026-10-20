import { Router } from 'express';
import { pool } from '../../db';
import { eventBus } from '../../shared/events/event-bus';
import type { Queryable } from '../../shared/infrastructure/queryable';
import type { AppModule } from '../../shared/module';
import { userDirectory } from '../auth';
import { depotRefs, vehicleMaintenance } from '../fleet';
import { inventoryRouter } from './api/inventory.routes';
import { maintenanceRouter } from './api/maintenance.routes';
import { InventoryService } from './application/inventory.service';
import { MaintenanceService } from './application/maintenance.service';
import { InventoryRepository } from './infrastructure/inventory.repository';
import { MaintenanceRepository } from './infrastructure/maintenance.repository';

const maintenanceRepository = new MaintenanceRepository(pool);

const maintenanceService = new MaintenanceService({
  records: maintenanceRepository,
  vehicles: vehicleMaintenance,
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

const router = Router();
router.use(maintenanceRouter(maintenanceService));
router.use(inventoryRouter(inventoryService));

export const maintenanceModule: AppModule = { name: 'maintenance', router };

/** For the fleet (FMS-76) and trip (FMS-31) modules: the open record behind a vehicle's maintenance flag, named in CONFLICT_VEHICLE_FLAGGED. */
export const maintenanceRefs = {
  openRecordFor: (db: Queryable, vehicleId: string) => maintenanceRepository.openRecordFor(db, vehicleId),
  /** The open work behind each vehicle's flag, summarized for the dispatcher's board (FMS-33). */
  openRecordSummaries: (db: Queryable, vehicleIds: readonly string[]) => maintenanceRepository.openRecordSummaries(db, vehicleIds),
};

export { INVENTORY_EVENTS } from './domain/inventory';
export { MAINTENANCE_EVENTS } from './domain/maintenance';

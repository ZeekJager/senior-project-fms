import { Router } from 'express';
import { pool } from '../../db';
import { eventBus } from '../../shared/events/event-bus';
import type { AppModule } from '../../shared/module';
import { userDirectory } from '../auth';
import { depotRefs, vehicleMaintenance } from '../fleet';
import { inventoryRouter } from './api/inventory.routes';
import { maintenanceRouter } from './api/maintenance.routes';
import { InventoryService } from './application/inventory.service';
import { MaintenanceService } from './application/maintenance.service';
import { InventoryRepository } from './infrastructure/inventory.repository';
import { MaintenanceRepository } from './infrastructure/maintenance.repository';

const maintenanceService = new MaintenanceService({
  records: new MaintenanceRepository(pool),
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

export { INVENTORY_EVENTS } from './domain/inventory';
export { MAINTENANCE_EVENTS } from './domain/maintenance';

import { pool } from '../../db';
import { eventBus } from '../../shared/events/event-bus';
import type { AppModule } from '../../shared/module';
import { userDirectory } from '../auth';
import { vehicleMaintenance } from '../fleet';
import { maintenanceRouter } from './api/maintenance.routes';
import { MaintenanceService } from './application/maintenance.service';
import { MaintenanceRepository } from './infrastructure/maintenance.repository';

const maintenanceService = new MaintenanceService({
  records: new MaintenanceRepository(pool),
  vehicles: vehicleMaintenance,
  users: userDirectory,
  events: eventBus,
});

export const maintenanceModule: AppModule = { name: 'maintenance', router: maintenanceRouter(maintenanceService) };

export { MAINTENANCE_EVENTS } from './domain/maintenance';

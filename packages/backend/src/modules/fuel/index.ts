import { Router } from 'express';
import { pool } from '../../db';
import { eventBus } from '../../shared/events/event-bus';
import type { AppModule } from '../../shared/module';
import { fuelRefs } from '../fleet';
import { tripLookups } from '../trip';
import { fuelLogRouter } from './api/fuel-log.routes';
import { FuelLogService } from './application/fuel-log.service';
import { FuelLogRepository } from './infrastructure/fuel-log.repository';

const fuelLogService = new FuelLogService({
  logs: new FuelLogRepository(pool),
  refs: { ...fuelRefs, trips: tripLookups },
  events: eventBus,
});

const router = Router();
router.use(fuelLogRouter(fuelLogService));

export const fuelModule: AppModule = { name: 'fuel', router };

export { FUEL_EVENTS } from './domain/fuel-log';

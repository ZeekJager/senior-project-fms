import { Router } from 'express';
import { pool } from '../../db';
import { eventBus } from '../../shared/events/event-bus';
import type { Queryable } from '../../shared/infrastructure/queryable';
import type { AppModule } from '../../shared/module';
import { fuelRefs } from '../fleet';
import { tripLookups } from '../trip';
import { fuelLogRouter } from './api/fuel-log.routes';
import { FuelLogService } from './application/fuel-log.service';
import { FuelLogRepository } from './infrastructure/fuel-log.repository';

const fuelLogs = new FuelLogRepository(pool);

const fuelLogService = new FuelLogService({
  logs: fuelLogs,
  refs: { ...fuelRefs, trips: tripLookups },
  events: eventBus,
});

const router = Router();
router.use(fuelLogRouter(fuelLogService));

export const fuelModule: AppModule = { name: 'fuel', router };

/** For meter readings (FMS-126, fleet): every fuel log's odometer, recorded at or after `since`. */
export const fuelMeterReadings = {
  odometers: (db: Queryable, since: Date | null) => fuelLogs.odometerReadings(db, since),
};

/** For the nightly scoring (FMS-55): each vehicle's fuel logged (ml) in [from, to), by internal id. */
export const fuelUsage = {
  loggedMl: (db: Queryable, vehicleIds: readonly string[], from: Date, to: Date) => fuelLogs.loggedMl(db, vehicleIds, from, to),
};

export { FUEL_EVENTS } from './domain/fuel-log';

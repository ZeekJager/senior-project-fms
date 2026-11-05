import { Router } from 'express';
import { pool, reads } from '../../db';
import { eventBus } from '../../shared/events/event-bus';
import type { Queryable } from '../../shared/infrastructure/queryable';
import type { JobContext } from '../../shared/jobs/job';
import type { AppModule } from '../../shared/module';
import { userDirectory } from '../auth';
import { config } from '../../config';
import { fuelRefs } from '../fleet';
import { trackingLookups } from '../integration';
import { settings } from '../settings';
import { completedTripMetres, tripLookups } from '../trip';
import { fuelAnomalyRouter } from './api/fuel-anomaly.routes';
import { fuelLogRouter } from './api/fuel-log.routes';
import { reconciliationRouter } from './api/reconciliation.routes';
import { FillUpRulesService } from './application/fill-up-rules.service';
import { FuelAnomalyService } from './application/fuel-anomaly.service';
import { FuelLogService } from './application/fuel-log.service';
import { ReconciliationService } from './application/reconciliation.service';
import { FuelAnomalyRepository } from './infrastructure/fuel-anomaly.repository';
import { FUEL_EVENTS } from './domain/fuel-log';
import { FuelLogRepository } from './infrastructure/fuel-log.repository';

const fuelLogs = new FuelLogRepository(pool);

const fuelLogService = new FuelLogService({
  logs: fuelLogs,
  refs: { ...fuelRefs, trips: tripLookups },
  events: eventBus,
});

const fuelAnomalies = new FuelAnomalyRepository(pool);

const reconciliationService = new ReconciliationService({
  // The read replica when it is up and close enough (FMS-94), the primary otherwise.
  reads,
  logs: fuelLogs,
  anomalies: fuelAnomalies,
  refs: { vehicles: fuelRefs.vehicles, depots: fuelRefs.depots, trips: { completedMetres: completedTripMetres } },
  events: eventBus,
  settings: { varianceThresholdPct: () => settings.value('fuel_variance_threshold_pct') },
});

// FMS-82: every fill-up is judged the moment it is logged. The relay delivers FuelLogged to this consumer within a second;
// an anomaly and FuelAnomalyDetected (the alert engine's input) are written in the delivery's transaction.
const fillUpRules = new FillUpRulesService({
  anomalies: fuelAnomalies,
  logs: fuelLogs,
  vehicles: fuelRefs.vehicles,
  positions: trackingLookups,
  rules: config.fuel.rules,
  events: eventBus,
});
eventBus.subscribe(FUEL_EVENTS.logged, 'fuel.fill-up-rules', (event, tx) => fillUpRules.onFuelLogged(event, tx));

// FMS-42: the finance screen lists anomalies and closes them, so they are read on the primary.
const fuelAnomalyService = new FuelAnomalyService({ db: pool, anomalies: fuelAnomalies, vehicles: fuelRefs.vehicles, users: userDirectory });

const router = Router();
router.use(fuelLogRouter(fuelLogService));
router.use(reconciliationRouter(reconciliationService));
router.use(fuelAnomalyRouter(fuelAnomalyService));

export const fuelModule: AppModule = {
  name: 'fuel',
  router,
  jobs: [
    {
      // FMS-41: last month's fuel against its trips; an anomaly and FuelAnomalyDetected beyond the threshold.
      name: 'fuel-reconciliation',
      at: '04:30',
      run: (context) => reconciliationService.runMonthly(context),
    },
  ],
};

/** For meter readings (FMS-126, fleet): every fuel log's odometer, recorded at or after `since`. */
export const fuelMeterReadings = {
  odometers: (db: Queryable, since: Date | null) => fuelLogs.odometerReadings(db, since),
};

/** For the nightly scoring (FMS-55): each vehicle's fuel logged (ml) in [from, to), by internal id. */
export const fuelUsage = {
  loggedMl: (db: Queryable, vehicleIds: readonly string[], from: Date, to: Date) => fuelLogs.loggedMl(db, vehicleIds, from, to),
};

/** The monthly reconciliation (FMS-41), the job's run, for tests: `run(context)`. */
export const fuelReconciliation = { run: (context: JobContext) => reconciliationService.runMonthly(context) };

export { FUEL_EVENTS } from './domain/fuel-log';

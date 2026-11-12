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
import { depotRefs, HEALTH_BANDS, recallRefs, scoringRefs, serviceRefs, VEHICLE_EVENTS, vehicleMaintenance } from '../fleet';
import { settings } from '../settings';
import { fuelUsage } from '../fuel';
import { integrationGateway } from '../integration';
import { completedDistanceAfter, completedTripUsage } from '../trip';
import { inventoryRouter } from './api/inventory.routes';
import { maintenanceRouter } from './api/maintenance.routes';
import { mlModelRouter } from './api/ml-model.routes';
import { predictionFeedbackRouter } from './api/prediction-feedback.routes';
import { predictionRouter } from './api/prediction.routes';
import { serviceProgramRouter } from './api/service-program.routes';
import { warrantyRouter } from './api/warranty.routes';
import { InventoryService } from './application/inventory.service';
import { MaintenanceService } from './application/maintenance.service';
import { MlModelService } from './application/ml-model.service';
import { PredictionFeedbackService } from './application/prediction-feedback.service';
import { PredictionService } from './application/prediction.service';
import { ScoringService } from './application/scoring.service';
import { ServiceProgramService } from './application/service-program.service';
import { WarrantyService } from './application/warranty.service';
import { FailureRepository } from './infrastructure/failure.repository';
import { featureSpecLoader } from './infrastructure/feature-spec';
import { InventoryRepository } from './infrastructure/inventory.repository';
import { MaintenanceRepository } from './infrastructure/maintenance.repository';
import { MlModelRepository, type MlModelListFilter } from './infrastructure/ml-model.repository';
import { PredictionFeedbackRepository } from './infrastructure/prediction-feedback.repository';
import { HttpMlServiceClient, ML_SERVICE_TIMEOUT_MS, MlServiceError, type TripRiskRequest } from './infrastructure/ml-service.client';
import { ScoringRepository } from './infrastructure/scoring.repository';
import { ServiceProgramRepository } from './infrastructure/service-program.repository';
import { WarrantyRepository } from './infrastructure/warranty.repository';

const maintenanceRepository = new MaintenanceRepository(pool);
const failureRepository = new FailureRepository(pool);

// Preventive service programs and the service due under them (FMS-129, docs/service-programs.md).
const serviceProgramService = new ServiceProgramService({
  programs: new ServiceProgramRepository(pool),
  vehicles: {
    service: serviceRefs.vehicles,
    metersAt: serviceRefs.metersAt,
    findInScope: (db, by, scope) => vehicleMaintenance.findInScope(db, by, scope),
    idsInScope: vehicleMaintenance.idsInScope,
  },
  depots: depotRefs,
  events: eventBus,
});

// Warranties, warranty claims and recalls (FMS-133, docs/warranties-recalls.md).
const warrantyService = new WarrantyService({
  repo: new WarrantyRepository(pool),
  vehicles: {
    findInScope: (db, by, scope) => vehicleMaintenance.findInScope(db, by, scope),
    refsByIds: vehicleMaintenance.refsByIds,
    idsInScope: vehicleMaintenance.idsInScope,
    forRecall: recallRefs.vehicles,
    odometers: async (db, ids) => new Map((await serviceRefs.vehicles(db, ids)).map((v) => [v.id, v.odometerKm])),
  },
  users: userDirectory,
  events: eventBus,
  warningDays: () => settings.value('expiry_warning_days'),
});

/** What a recall matches on: an edit of anything else leaves the vehicle's recalls as they are. */
const RECALL_FIELDS: unknown[] = ['make', 'model', 'year'];

// A vehicle registered, or its make, model or year changed, falls under the recalls it now matches (FMS-133).
for (const type of [VEHICLE_EVENTS.registered, VEHICLE_EVENTS.updated]) {
  eventBus.subscribe(type, 'maintenance.recall-match', async (event, tx) => {
    const changed = event.payload.changed_fields;
    if (Array.isArray(changed) && !changed.some((f) => RECALL_FIELDS.includes(f))) return;
    if (typeof event.payload.vehicle_id === 'string') await warrantyService.vehicleChanged(tx, event.payload.vehicle_id, event.correlation_id);
  });
}

const maintenanceService = new MaintenanceService({
  records: maintenanceRepository,
  vehicles: vehicleMaintenance,
  failures: failureRepository,
  incidents: incidentLookup,
  users: userDirectory,
  depots: depotRefs,
  services: serviceProgramService,
  warranties: warrantyService,
  events: eventBus,
});

const inventoryService = new InventoryService({
  parts: new InventoryRepository(pool),
  depots: depotRefs,
  users: userDirectory,
  events: eventBus,
});

const featureSpec = featureSpecLoader(config.ml.featureSpecPath);
// The trip risk model's (FMS-155): its own spec, shared with the ML service the same way.
const tripRiskSpec = featureSpecLoader(config.ml.tripRiskSpecPath);

/**
 * The ML service (FMS-54) through the integration gateway: timeouts, retries and its circuit breaker.
 * Read when called: unset, nothing can be scored.
 */
function mlClient(): HttpMlServiceClient | null {
  const service = config.ml.service;
  if (!service) return null;
  return new HttpMlServiceClient(service.token, (correlationId) =>
    integrationGateway.internalClient({ code: 'ml-service', baseUrl: service.url, timeoutMs: ML_SERVICE_TIMEOUT_MS }, correlationId),
  );
}

const feedbackRepository = new PredictionFeedbackRepository(pool);

const mlModelService = new MlModelService({
  models: new MlModelRepository(pool),
  client: mlClient,
  spec: featureSpec,
  tripRiskSpec,
  users: userDirectory,
  feedback: feedbackRepository,
  events: eventBus,
  log: logger,
});

const scoringRepository = new ScoringRepository(pool);

// The nightly scoring (FMS-55, docs/ml-scoring.md): features from each module that owns the data.
const scoringService = new ScoringService({
  db: pool,
  predictions: scoringRepository,
  registry: mlModelService,
  client: mlClient,
  spec: featureSpec,
  sources: {
    vehicles: scoringRefs.vehicles,
    tripUsage: completedTripUsage,
    distanceAfter: completedDistanceAfter,
    engineHours: scoringRefs.engineHours,
    faultyDvirs: scoringRefs.faultyDvirs,
    faultIncidents: incidentLookup.countsByVehicle,
    fuelLoggedMl: fuelUsage.loggedMl,
    setHealthScore: scoringRefs.setHealthScore,
  },
  events: eventBus,
  log: logger,
  healthAlertBelow: () => settings.value('health_alert_below'),
});

// What a technician found when they inspected a flagged vehicle (FMS-128).
const predictionFeedbackService = new PredictionFeedbackService({
  feedback: feedbackRepository,
  vehicles: vehicleMaintenance,
  failures: failureRepository,
  users: userDirectory,
  events: eventBus,
});

// The health score screen's reads (FMS-56).
const predictionService = new PredictionService({
  predictions: scoringRepository,
  vehicles: vehicleMaintenance,
  spec: featureSpec,
  feedback: predictionFeedbackService,
  staleAfterHours: HEALTH_BANDS.staleAfterHours,
});

const router = Router();
router.use(maintenanceRouter(maintenanceService));
router.use(inventoryRouter(inventoryService));
router.use(mlModelRouter(mlModelService));
router.use(predictionRouter(predictionService));
router.use(predictionFeedbackRouter(predictionFeedbackService));
router.use(serviceProgramRouter(serviceProgramService));
router.use(warrantyRouter(warrantyService));

export const maintenanceModule: AppModule = {
  name: 'maintenance',
  router,
  jobs: [
    {
      // Every vehicle in service scored by the active model, after the engine-hours job (01:00) has read yesterday (FMS-55).
      name: 'maintenance-scoring',
      at: '02:00',
      run: (context) => scoringService.run(context),
    },
    {
      // Each vehicle's service due under each program, from today's meters, after the engine-hours job (01:00) (FMS-129).
      name: 'service-due',
      at: '01:30',
      run: (context) => serviceProgramService.run(context),
    },
  ],
};

/** For the fleet (FMS-76) and trip (FMS-31) modules: the open record behind a vehicle's maintenance flag, named in CONFLICT_VEHICLE_FLAGGED. */
export const maintenanceRefs = {
  openRecordFor: (db: Queryable, vehicleId: string) => maintenanceRepository.openRecordFor(db, vehicleId),
  /** The open work behind each vehicle's flag, summarized for the dispatcher's board (FMS-33). */
  openRecordSummaries: (db: Queryable, vehicleIds: readonly string[]) => maintenanceRepository.openRecordSummaries(db, vehicleIds),
  /** For the nightly scoring's features (FMS-55): each item's last change on a vehicle before a time (FMS-52). */
  lastServiceItems: (db: Queryable, vehicleId: string, before: Date | null = null) => maintenanceRepository.lastServiceItems(db, vehicleId, before),
  /** For meter readings (FMS-126, fleet): completed repairs with an odometer, completed at or after `since`. */
  completedOdometers: (db: Queryable, since: Date | null) => maintenanceRepository.completedOdometers(db, since),
  /** For the dispatcher's board (FMS-129): each vehicle's service programs due or overdue, by internal vehicle id. */
  serviceDueSummaries: (db: Queryable, vehicleIds: readonly string[]) => serviceProgramService.boardSummaries(db, vehicleIds),
  /** For downtime (FMS-131, fleet): the repairs (public ids, and those with a failure) and failures behind it. */
  downtimeSources: (db: Queryable, vehicleIds: readonly string[], recordIds: readonly string[]) =>
    maintenanceRepository.downtimeSources(db, vehicleIds, recordIds),
  /** For the availability screen (FMS-142, fleet): what the repairs and failures behind downtime periods were. */
  downtimeProblems: (db: Queryable, recordIds: readonly string[], failureIds: readonly string[]) =>
    maintenanceRepository.downtimeProblems(db, recordIds, failureIds),
};

/** For the expiry job (FMS-26, fleet): the warranties ending within its window (FMS-133). */
export const warrantyRefs = {
  endingWithin: (db: Queryable, today: string, window: number) => warrantyService.endingWithin(db, today, window),
};

/** For tests and scripts: one run of the service-due job (FMS-129), as the scheduler runs it. */
export const serviceDueJob = {
  run: (context: JobContext) => serviceProgramService.run(context),
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

/**
 * For the trip risk model (FMS-155, docs/ml-trip-risk.md), read by the analytics module: whether the console may ask the
 * model the ML service serves (registered on first sight), and the asking. Its spec is the one the extractor implements.
 */
export const tripRiskModels = {
  check: (correlationId: string) => mlModelService.checkTripRisk(correlationId),
  predict: async (items: readonly TripRiskRequest[], correlationId: string) => {
    const client = mlClient();
    if (!client) throw new MlServiceError('ML_SERVICE_URL is not set');
    return client.predictTripRisk(items, correlationId);
  },
  spec: tripRiskSpec,
};

/** For `npm run ml:model` (FMS-127): the registry, and activation by a named administrator. */
/** For tests and scripts: one run of the nightly scoring (FMS-55), as the scheduler runs it. */
export const maintenanceScoring = {
  run: (context: JobContext) => scoringService.run(context),
};

export const mlModelAdmin = {
  list: (filter: MlModelListFilter) => mlModelService.list(filter),
  activate: (publicId: string, ctx: MutationContext) => mlModelService.activateAs(ctx, publicId),
};

export { FAILURE_COMPONENTS, FAILURE_EVENTS, FAILURE_MODES } from './domain/failure';
export { INVENTORY_EVENTS, SERVICE_ITEMS, type ServiceItem } from './domain/inventory';
export { MAINTENANCE_EVENTS } from './domain/maintenance';
export { MAINTENANCE_MODEL, ML_MODEL_EVENTS, TRIP_RISK_MODEL, type MlModelView, type ScoringCheck, type TripRiskCheck } from './domain/ml-model';
export type { TripRiskPrediction, TripRiskRequest } from './infrastructure/ml-service.client';
export type { FeatureSpec } from './infrastructure/feature-spec';
export { PREDICTION_FEEDBACK_EVENTS, PREDICTION_OUTCOMES } from './domain/prediction-feedback';
export { SERVICE_DUE_EVENTS } from './domain/service-program';
export { WARRANTY_EVENTS } from './domain/warranty';
export type { ServiceDueSummary } from './application/service-program.service';
export { PREDICTION_EVENTS, PREDICTION_TYPE, RISK_ALERT_BELOW, type MaintenanceRiskView } from './domain/scoring';
export type { ScoringResult } from './application/scoring.service';
export { MlServiceError } from './infrastructure/ml-service.client';

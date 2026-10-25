import type { PoolClient } from 'pg';
import type { EventBus } from '../../../shared/events/event-bus';
import { aggregateKey, createEvent, deterministicEventId, type DomainEvent } from '../../../shared/events/domain-event';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { JobContext } from '../../../shared/jobs/job';
import type { RegisteredModel, ScoringCheck } from '../domain/ml-model';
import {
  computeFeatures,
  daysBefore,
  EXTRACTOR_SPEC_HASH,
  FAULT_INCIDENT_TYPES,
  PREDICTION_EVENTS,
  PREDICTION_TYPE,
  raisesRiskEvent,
  SCORING_BATCH_SIZE,
  scoringTime,
  scoringTimeText,
  WINDOW_DAYS,
  type MlPrediction,
  type PredictRequest,
  type VehicleFacts,
} from '../domain/scoring';
import type { FeatureSpec } from '../infrastructure/feature-spec';
import { MlServiceError, type MlServiceClient } from '../infrastructure/ml-service.client';
import type { ScoringRepository } from '../infrastructure/scoring.repository';

/** A vehicle to score, from the fleet module (internal ids). */
export interface ScoringVehicle {
  id: string;
  publicId: string;
  createdAt: Date;
  modelYear: number | null;
  odometerKm: number;
  fuelEfficiencyMlPerKm: number | null;
  healthScore: number | null;
}

type Counts = (db: Queryable, vehicleIds: readonly string[], from: Date, to: Date) => Promise<Map<string, number>>;

/** What the features read from the modules that own the data, each over a window, by internal vehicle id. */
export interface ScoringSources {
  vehicles(db: Queryable): Promise<ScoringVehicle[]>;
  tripUsage(db: Queryable, vehicleIds: readonly string[], from: Date, to: Date): Promise<Map<string, { distanceKm: number; drivingSeconds: number }>>;
  distanceAfter(db: Queryable, since: readonly { vehicleId: string; after: Date }[], before: Date): Promise<number[]>;
  engineHours: Counts;
  faultyDvirs: Counts;
  faultIncidents(db: Queryable, vehicleIds: readonly string[], types: readonly (typeof FAULT_INCIDENT_TYPES)[number][], from: Date, to: Date): Promise<Map<string, number>>;
  fuelLoggedMl: Counts;
  setHealthScore(client: PoolClient, ctx: MutationContext, vehicleId: string, score: number, at: Date): Promise<void>;
}

export interface ScoringServiceDeps {
  db: Queryable;
  predictions: ScoringRepository;
  registry: { checkServing(context: JobContext): Promise<ScoringCheck> };
  /** Null when ML_SERVICE_URL is not set. */
  client: () => MlServiceClient | null;
  spec: () => FeatureSpec;
  sources: ScoringSources;
  events: EventBus;
  log: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void; error(obj: object, msg: string): void };
  batchSize?: number;
}

/** What a run did, for the job's history (counts, never personal data). */
export type ScoringResult = {
  vehicles: number;
  scored: number;
  /** Scored earlier the same day by the same model (a retried run). */
  already_scored: number;
  /** Not scored: the ML service could not be asked, refused a batch, or no model may score. */
  skipped: number;
  risk_events: number;
  batches_failed: number;
  model_version: string | null;
  /** Why nothing was scored: `ml_unavailable`, or the registry's reason (FMS-127). */
  blocked: string | null;
  duration_ms: number;
};

/**
 * The nightly scoring (FMS-55, docs/ml-scoring.md). Every vehicle in service gets the inputs of
 * feature_spec.json as of the start of the day, computed from the core's tables, and is scored by the
 * active model through the ML service in batches. Each prediction is stored with the vehicle's health
 * score, and a score falling below 75 raises MaintenanceRiskDetected. An ML service that is down, or a
 * model that may not score, skips the vehicles and the run still finishes.
 */
export class ScoringService {
  constructor(private readonly deps: ScoringServiceDeps) {}

  async run(context: JobContext): Promise<ScoringResult> {
    const started = Date.now();
    const { log, sources, db } = this.deps;
    const spec = this.deps.spec();
    // A deployment bug, not an outage: the run fails, and its history says why.
    if (spec.hash !== EXTRACTOR_SPEC_HASH) {
      throw new Error(`feature_spec.json (hash ${spec.hash}) is not the spec the feature extractor implements (${EXTRACTOR_SPEC_HASH}): update the extractor with the spec`);
    }
    const vehicles = await sources.vehicles(db);
    const result: ScoringResult = {
      vehicles: vehicles.length,
      scored: 0,
      already_scored: 0,
      skipped: 0,
      risk_events: 0,
      batches_failed: 0,
      model_version: null,
      blocked: null,
      duration_ms: 0,
    };
    const finish = () => ({ ...result, duration_ms: Date.now() - started });

    let check: ScoringCheck;
    try {
      check = await this.deps.registry.checkServing(context);
    } catch (err) {
      if (!(err instanceof MlServiceError)) throw err;
      log.error({ event: 'maintenance.scoring_skipped', reason: err.message, vehicles: vehicles.length }, 'nightly scoring skipped: the ML service could not be asked');
      Object.assign(result, { skipped: vehicles.length, blocked: 'ml_unavailable' });
      return finish();
    }
    result.model_version = check.model.version;
    // The registry has logged why and raised MlScoringBlocked.
    if (!check.ok) {
      Object.assign(result, { skipped: vehicles.length, blocked: check.reason });
      return finish();
    }
    const client = this.deps.client();
    if (!client) throw new MlServiceError('ML_SERVICE_URL is not set');

    const t = scoringTime(context.runKey);
    const done = await this.deps.predictions.scoredAt(db, t, PREDICTION_TYPE, check.model);
    const todo = vehicles.filter((v) => !done.has(v.id));
    result.already_scored = vehicles.length - todo.length;
    const facts = await this.facts(todo, t);

    const size = this.deps.batchSize ?? SCORING_BATCH_SIZE;
    for (let i = 0; i < todo.length; i += size) {
      const batch = todo.slice(i, i + size);
      const items: PredictRequest[] = batch.map((v) => ({
        vehicle_id: v.publicId,
        as_of: scoringTimeText(context.runKey),
        features: computeFeatures(spec.inputs, facts.get(v.id)!, t),
      }));
      let predictions: MlPrediction[];
      try {
        predictions = await client.predictBatch(items, context.correlationId);
        // The service restarted with another model since the check: it is not the one the registry allowed.
        const other = predictions.find((p) => p.modelVersion !== check.model.version);
        if (other) throw new MlServiceError(`the ML service answered with model ${other.modelVersion}, not ${check.model.version}`);
      } catch (err) {
        if (!(err instanceof MlServiceError)) throw err;
        result.skipped += batch.length;
        result.batches_failed += 1;
        log.error({ event: 'maintenance.scoring_batch_failed', reason: err.message, vehicles: batch.length }, 'nightly scoring: a batch was not scored');
        continue;
      }
      result.risk_events += await this.store(context, check.model, t, batch, items, predictions);
      result.scored += batch.length;
    }

    const summary = finish();
    if (summary.skipped > 0) log.warn({ event: 'maintenance.scoring_incomplete', ...summary }, 'nightly scoring finished without scoring every vehicle');
    else log.info({ event: 'maintenance.scoring_done', ...summary }, 'nightly scoring finished');
    return summary;
  }

  /** Every vehicle's facts as of t, read in one pass per source. */
  private async facts(vehicles: readonly ScoringVehicle[], t: Date): Promise<Map<string, VehicleFacts>> {
    const { sources, predictions, db } = this.deps;
    const ids = vehicles.map((v) => v.id);
    const useFrom = daysBefore(t, WINDOW_DAYS.use);
    const faultsFrom = daysBefore(t, WINDOW_DAYS.faults);
    // One source after another: they may share one connection (a transaction).
    const usage = await sources.tripUsage(db, ids, useFrom, t);
    const hours = await sources.engineHours(db, ids, useFrom, t);
    const dvirs = await sources.faultyDvirs(db, ids, faultsFrom, t);
    const incidents = await sources.faultIncidents(db, ids, FAULT_INCIDENT_TYPES, faultsFrom, t);
    const fuel = await sources.fuelLoggedMl(db, ids, useFrom, t);
    const services = await predictions.lastServices(db, ids, t);
    const changes = await predictions.lastServiceItems(db, ids, t);
    const kmSince = await sources.distanceAfter(db, changes.map((c) => ({ vehicleId: c.vehicleId, after: c.changedAt })), t);

    const facts = new Map<string, VehicleFacts>();
    for (const v of vehicles) {
      facts.set(v.id, {
        createdAt: v.createdAt,
        modelYear: v.modelYear,
        odometerKm: v.odometerKm,
        fuelEfficiencyMlPerKm: v.fuelEfficiencyMlPerKm,
        trips: usage.get(v.id) ?? { distanceKm: 0, drivingSeconds: 0 },
        engineHoursIncrease: hours.get(v.id) ?? null,
        faultReports: (dvirs.get(v.id) ?? 0) + (incidents.get(v.id) ?? 0),
        fuelLoggedMl: fuel.get(v.id) ?? 0,
        lastServiceAt: services.get(v.id) ?? null,
        items: {},
      });
    }
    changes.forEach((c, i) => {
      facts.get(c.vehicleId)!.items[c.item] = { changedAt: c.changedAt, kmSince: kmSince[i] };
    });
    return facts;
  }

  /**
   * One batch's predictions, in one transaction: each stored (superseding the vehicle's previous one), its
   * health score set on the vehicle, and a risk event where the score fell below the line. Returns the events.
   */
  private async store(
    context: JobContext,
    model: RegisteredModel,
    t: Date,
    batch: readonly ScoringVehicle[],
    items: readonly PredictRequest[],
    predictions: readonly MlPrediction[],
  ): Promise<number> {
    const { predictions: repo, sources, events } = this.deps;
    const ctx: MutationContext = { userId: null, correlationId: context.correlationId };
    return repo.inTransaction(async (client) => {
      const previous = await repo.activeIds(
        client,
        batch.map((v) => v.id),
        PREDICTION_TYPE,
      );
      const risks: DomainEvent[] = [];
      for (const [i, vehicle] of batch.entries()) {
        const p = predictions[i];
        for (const id of previous.get(vehicle.id) ?? []) await repo.supersede(client, ctx, id);
        const predictionId = await repo.insert(client, ctx, {
          vehicleId: vehicle.id,
          modelName: model.name,
          modelVersion: model.version,
          predictionType: PREDICTION_TYPE,
          failureProbability: p.failureProbability,
          healthScore: p.healthScore,
          riskLevel: p.riskLevel,
          horizonDays: p.horizonDays,
          factors: p.factors,
          features: items[i].features,
          asOf: t,
        });
        await sources.setHealthScore(client, ctx, vehicle.id, p.healthScore, context.now);
        if (!raisesRiskEvent(p.healthScore, vehicle.healthScore)) continue;
        risks.push(
          createEvent(
            PREDICTION_EVENTS.riskDetected,
            {
              prediction_id: predictionId,
              vehicle_id: vehicle.publicId,
              risk_level: p.riskLevel,
              failure_probability: p.failureProbability,
              health_score: p.healthScore,
              previous_health_score: vehicle.healthScore,
              factors: p.factors,
              // The model predicts no failure category (FMS-53).
              component: null,
              model_name: model.name,
              model_version: model.version,
              as_of: t.toISOString(),
            },
            { actor: null, correlationId: context.correlationId },
            {
              id: deterministicEventId(`${PREDICTION_EVENTS.riskDetected}:${t.toISOString()}:${vehicle.publicId}:${model.version}`),
              aggregate: aggregateKey('vehicle', vehicle.publicId),
            },
          ),
        );
      }
      await events.publish(client, risks);
      return risks.length;
    });
  }
}

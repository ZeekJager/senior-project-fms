import type { PoolClient } from 'pg';
import type { EventBus } from '../../../shared/events/event-bus';
import { aggregateKey, createEvent, deterministicEventId, type DomainEvent } from '../../../shared/events/domain-event';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { JobContext } from '../../../shared/jobs/job';
import { EV_MAINTENANCE_MODEL, MAINTENANCE_MODEL, type MaintenanceModelName, type RegisteredModel, type ScoringCheck } from '../domain/ml-model';
import {
  computeFeatures,
  daysBefore,
  EV_DC_FAST_KW,
  EV_DEEP_SOC,
  EV_EXTRACTOR_SPEC_HASH,
  EV_FEATURE_FORMULAS,
  EV_HOT_C,
  EV_HOT_HOURS_PER_READING,
  EXTRACTOR_SPEC_HASH,
  FEATURE_FORMULAS,
  FAULT_INCIDENT_TYPES,
  PREDICTION_EVENTS,
  PREDICTION_TYPE,
  raisesRiskEvent,
  SCORING_BATCH_SIZE,
  scoringTime,
  scoringTimeText,
  WINDOW_DAYS,
  type EvFacts,
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
  /** electric: scored by the EV model (FMS-135); anything else by the combustion model. */
  fuelType: string;
  make: string;
  model: string;
}

/** An EV's battery and charging facts as the EV module reads them (FMS-135), before its kind's energy mean. */
export type EvScoringFacts = Omit<EvFacts, 'kindMeanWhPerKm'>;

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
  /** FMS-135: the EVs' battery and charging as of t, from the EV module (null: not wired, every EV input reads its fallback). */
  evFacts?:
    | ((db: Queryable, vehicleIds: readonly string[], t: Date, rules: { hotC: number; hotHoursPerReading: number; deepSoc: number; dcFastKw: number }) => Promise<Map<string, EvScoringFacts>>)
    | null;
}

export interface ScoringServiceDeps {
  db: Queryable;
  predictions: ScoringRepository;
  registry: { checkServing(context: JobContext, name?: MaintenanceModelName): Promise<ScoringCheck> };
  /** Null when ML_SERVICE_URL is not set. */
  client: () => MlServiceClient | null;
  spec: () => FeatureSpec;
  /** feature_spec_ev.json (FMS-135): the EV model's inputs. */
  evSpec: () => FeatureSpec;
  sources: ScoringSources;
  events: EventBus;
  log: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void; error(obj: object, msg: string): void };
  /** The health score below which a risk event is raised: a setting (FMS-80), RISK_ALERT_BELOW by default. */
  healthAlertBelow: () => Promise<number>;
  batchSize?: number;
}

/** What a run did, for the job's history (counts, never personal data). */
export type ScoringResult = {
  vehicles: number;
  scored: number;
  /** Scored earlier the same day by the same model (a retried run). */
  already_scored: number;
  /** Not scored: the ML service could not be asked, refused a batch, or no model may score (EVs without one included). */
  skipped: number;
  risk_events: number;
  batches_failed: number;
  /** The combustion model that scored (FMS-55). */
  model_version: string | null;
  /** Why the combustion vehicles were not scored: `ml_unavailable`, or the registry's reason (FMS-127). */
  blocked: string | null;
  /** FMS-135: the electric vehicles, scored by the EV model only. */
  ev_vehicles: number;
  /** EVs not scored because no EV model may score (none served, or not active): they keep their last score. */
  skipped_no_model: number;
  ev_model_version: string | null;
  /** Why the EVs were not scored: `no_model`, `ml_unavailable`, or the registry's reason. */
  ev_blocked: string | null;
  duration_ms: number;
};

/** Which model scores a group of vehicles, by what spec and formulas. */
interface Group {
  name: MaintenanceModelName;
  vehicles: ScoringVehicle[];
  spec: FeatureSpec;
  formulas: typeof FEATURE_FORMULAS;
}

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
    const { sources, db } = this.deps;
    const spec = this.deps.spec();
    const evSpec = this.deps.evSpec();
    // A deployment bug, not an outage: the run fails, and its history says why.
    if (spec.hash !== EXTRACTOR_SPEC_HASH) {
      throw new Error(`feature_spec.json (hash ${spec.hash}) is not the spec the feature extractor implements (${EXTRACTOR_SPEC_HASH}): update the extractor with the spec`);
    }
    if (evSpec.hash !== EV_EXTRACTOR_SPEC_HASH) {
      throw new Error(`feature_spec_ev.json (hash ${evSpec.hash}) is not the spec the EV feature extractor implements (${EV_EXTRACTOR_SPEC_HASH}): update the extractor with the spec`);
    }
    const vehicles = await sources.vehicles(db);
    // An EV is never scored by the combustion model (FMS-135), and the other way round.
    const evs = vehicles.filter((v) => v.fuelType === 'electric');
    const result: ScoringResult = {
      vehicles: vehicles.length,
      scored: 0,
      already_scored: 0,
      skipped: 0,
      risk_events: 0,
      batches_failed: 0,
      model_version: null,
      blocked: null,
      ev_vehicles: evs.length,
      skipped_no_model: 0,
      ev_model_version: null,
      ev_blocked: null,
      duration_ms: 0,
    };
    const groups: Group[] = [
      { name: MAINTENANCE_MODEL, vehicles: vehicles.filter((v) => v.fuelType !== 'electric'), spec, formulas: FEATURE_FORMULAS },
      { name: EV_MAINTENANCE_MODEL, vehicles: evs, spec: evSpec, formulas: EV_FEATURE_FORMULAS },
    ];
    for (const group of groups) {
      // Each model on its own: one that may not score leaves the other's vehicles to it.
      if (group.vehicles.length > 0) await this.scoreGroup(context, group, result);
    }

    const summary = { ...result, duration_ms: Date.now() - started };
    if (summary.skipped > 0) this.deps.log.warn({ event: 'maintenance.scoring_incomplete', ...summary }, 'nightly scoring finished without scoring every vehicle');
    else this.deps.log.info({ event: 'maintenance.scoring_done', ...summary }, 'nightly scoring finished');
    return summary;
  }

  /** One model's vehicles: checked with the registry, then scored in batches. What happened goes into `result`. */
  private async scoreGroup(context: JobContext, group: Group, result: ScoringResult): Promise<void> {
    const { log, db } = this.deps;
    const ev = group.name === EV_MAINTENANCE_MODEL;
    const block = (reason: string, versionOf: string | null) => {
      result.skipped += group.vehicles.length;
      if (ev) {
        Object.assign(result, { ev_blocked: reason, ev_model_version: versionOf });
        // With no EV model that may score, the EVs keep the score they had (FMS-135).
        if (reason !== 'ml_unavailable') result.skipped_no_model += group.vehicles.length;
      } else Object.assign(result, { blocked: reason, model_version: versionOf });
    };

    let check: ScoringCheck;
    try {
      check = await this.deps.registry.checkServing(context, group.name);
    } catch (err) {
      if (!(err instanceof MlServiceError)) throw err;
      log.error({ event: 'maintenance.scoring_skipped', model_name: group.name, reason: err.message, vehicles: group.vehicles.length }, 'nightly scoring skipped: the ML service could not be asked');
      block('ml_unavailable', null);
      return;
    }
    if (!check.ok) {
      // The registry has logged why and raised MlScoringBlocked; with no EV model served there is nothing to alert about.
      if (check.reason === 'no_model') log.info({ event: 'maintenance.scoring_no_ev_model', vehicles: group.vehicles.length }, 'nightly scoring: no EV model, the EVs keep their last score');
      block(check.reason, check.model?.version ?? null);
      return;
    }
    const model = check.model;
    if (ev) result.ev_model_version = model.version;
    else result.model_version = model.version;
    const client = this.deps.client();
    if (!client) throw new MlServiceError('ML_SERVICE_URL is not set');

    const t = scoringTime(context.runKey);
    const done = await this.deps.predictions.scoredAt(db, t, PREDICTION_TYPE, model);
    const todo = group.vehicles.filter((v) => !done.has(v.id));
    result.already_scored += group.vehicles.length - todo.length;
    const facts = await this.facts(todo, t, ev);

    const size = this.deps.batchSize ?? SCORING_BATCH_SIZE;
    const alertBelow = await this.deps.healthAlertBelow();
    for (let i = 0; i < todo.length; i += size) {
      const batch = todo.slice(i, i + size);
      const items: PredictRequest[] = batch.map((v) => ({
        vehicle_id: v.publicId,
        as_of: scoringTimeText(context.runKey),
        features: computeFeatures(group.spec.inputs, facts.get(v.id)!, t, group.formulas),
      }));
      let predictions: MlPrediction[];
      try {
        predictions = await client.predictBatch(items, context.correlationId, ev ? group.name : undefined);
        // The service restarted with another model since the check: it is not the one the registry allowed.
        const other = predictions.find((p) => p.modelVersion !== model.version);
        if (other) throw new MlServiceError(`the ML service answered with model ${other.modelVersion}, not ${model.version}`);
      } catch (err) {
        if (!(err instanceof MlServiceError)) throw err;
        result.skipped += batch.length;
        result.batches_failed += 1;
        log.error({ event: 'maintenance.scoring_batch_failed', model_name: group.name, reason: err.message, vehicles: batch.length }, 'nightly scoring: a batch was not scored');
        continue;
      }
      result.risk_events += await this.store(context, model, t, batch, items, predictions, alertBelow);
      result.scored += batch.length;
    }
  }

  /** Every vehicle's facts as of t, read in one pass per source. */
  private async facts(vehicles: readonly ScoringVehicle[], t: Date, ev = false): Promise<Map<string, VehicleFacts>> {
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
    if (ev) await this.evFacts(vehicles, t, facts);
    return facts;
  }

  /**
   * The EVs' battery and charging facts (FMS-135), and each one's kind: the mean energy per km of every EV of its make
   * and model, when another of them reports. A vehicle with none reads the spec's fallbacks.
   */
  private async evFacts(vehicles: readonly ScoringVehicle[], t: Date, facts: Map<string, VehicleFacts>): Promise<void> {
    const read = this.deps.sources.evFacts;
    if (!read) return;
    const rows = await read(this.deps.db, vehicles.map((v) => v.id), t, { hotC: EV_HOT_C, hotHoursPerReading: EV_HOT_HOURS_PER_READING, deepSoc: EV_DEEP_SOC, dcFastKw: EV_DC_FAST_KW });
    const kindOf = (v: ScoringVehicle) => `${v.make}\u0000${v.model}`;
    const kinds = new Map<string, { sum: number; readings: number; reporting: number }>();
    for (const v of vehicles) {
      const r = rows.get(v.id);
      if (!r || r.energyReadings === 0) continue;
      const k = kinds.get(kindOf(v)) ?? { sum: 0, readings: 0, reporting: 0 };
      kinds.set(kindOf(v), { sum: k.sum + r.energySumWhPerKm, readings: k.readings + r.energyReadings, reporting: k.reporting + 1 });
    }
    for (const v of vehicles) {
      const r = rows.get(v.id);
      if (!r) continue;
      const kind = kinds.get(kindOf(v));
      // Its own readings count in its kind's mean; another vehicle of the kind must report too.
      const others = kind ? kind.reporting - (r.energyReadings > 0 ? 1 : 0) : 0;
      facts.get(v.id)!.ev = { ...r, kindMeanWhPerKm: kind && others > 0 ? kind.sum / kind.readings : null };
    }
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
    alertBelow: number,
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
        if (!raisesRiskEvent(p.healthScore, vehicle.healthScore, alertBelow)) continue;
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

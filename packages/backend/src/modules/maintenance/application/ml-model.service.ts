import type { EventBus } from '../../../shared/events/event-bus';
import { aggregateKey, createEvent, deterministicEventId } from '../../../shared/events/domain-event';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { JobContext } from '../../../shared/jobs/job';
import {
  ML_MODEL_EVENTS,
  mlModelFeaturesMismatch,
  mlModelNotFound,
  type MlModelView,
  type RegisteredModel,
  type ScoringBlockedReason,
  type ScoringCheck,
  type ServedModel,
} from '../domain/ml-model';
import type { FeatureSpec } from '../infrastructure/feature-spec';
import type { MlModelListFilter, MlModelRepository, MlModelRow } from '../infrastructure/ml-model.repository';
import { MlServiceError, type MlServiceClient } from '../infrastructure/ml-service.client';
import type { Caller } from './maintenance.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNIQUE_VIOLATION = '23505';

const registeredModel = (r: MlModelRow): RegisteredModel => ({
  id: r.id,
  publicId: r.publicId,
  name: r.name,
  version: r.version,
  status: r.status,
  featureSpecHash: r.featureSpecHash,
});

export interface MlModelServiceDeps {
  models: MlModelRepository;
  /** Null when ML_SERVICE_URL is not set. */
  client: () => MlServiceClient | null;
  /** The feature spec the core's extractor implements (feature_spec.json). */
  spec: () => FeatureSpec;
  users: { findByIds(db: Queryable, ids: readonly string[]): Promise<{ id: string; publicId: string }[]> };
  events: EventBus;
  log: { warn(obj: object, msg: string): void; error(obj: object, msg: string): void };
  now?: () => Date;
}

/**
 * The model registry (FMS-127, docs/ml-model-registry.md). Every model the ML service serves is
 * registered the first time the scoring job sees it; it scores only once an administrator activates it,
 * and never when its inputs are not the ones the core computes.
 */
export class MlModelService {
  constructor(private readonly deps: MlModelServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /**
   * For the nightly scoring (FMS-55), before it scores: the model the ML service serves, registered on
   * first sight. Scoring may go ahead only when that model is active and was trained on the core's
   * feature spec. Otherwise the reason is logged and MlScoringBlocked raises an alert for administrators.
   * Throws MlServiceError when the service is not configured or cannot say what it serves.
   */
  async checkServing(context: JobContext): Promise<ScoringCheck> {
    const client = this.deps.client();
    if (!client) throw new MlServiceError('ML_SERVICE_URL is not set');
    const served = await client.servedModel(context.correlationId);
    const ctx: MutationContext = { userId: null, correlationId: context.correlationId };
    const { row, registered } = await this.register(ctx, served);
    const model = registeredModel(row);

    // The registry keeps what a version was when first seen; a version served with another artefact was reused.
    const expected = this.deps.spec().hash;
    const reason: ScoringBlockedReason | null =
      row.featureSpecHash !== expected || served.featureSpecHash !== expected
        ? 'feature_spec_mismatch'
        : row.artefactSha256 !== served.artefactSha256
          ? 'artefact_mismatch'
          : model.status !== 'active'
            ? 'not_active'
            : null;
    if (!reason) return { ok: true, model, registered };

    const facts = {
      model_id: model.publicId,
      model_name: model.name,
      model_version: model.version,
      model_status: model.status,
      reason,
      feature_spec_hash: served.featureSpecHash,
      expected_feature_spec_hash: expected,
    };
    if (reason === 'not_active') this.deps.log.warn(facts, 'scoring skipped: the served model is not active');
    else this.deps.log.error(facts, 'scoring refused: the served model does not match the registry or the core');
    const event = createEvent(
      ML_MODEL_EVENTS.scoringBlocked,
      facts,
      { actor: null, correlationId: context.correlationId },
      { id: deterministicEventId(`${ML_MODEL_EVENTS.scoringBlocked}:${context.runKey}:${model.publicId}:${reason}`), aggregate: aggregateKey('ml_model', model.publicId) },
    );
    await this.deps.models.inTransaction((client) => this.deps.events.publish(client, [event]));
    return { ok: false, reason, model, registered };
  }

  /** The registry row of this version, registered first if it is new. */
  private async register(ctx: MutationContext, served: ServedModel): Promise<{ row: MlModelRow; registered: boolean }> {
    const { models } = this.deps;
    const find = () => models.inTransaction((c) => models.findByVersion(c, served.name, served.version));
    const known = await find();
    if (known) return { row: known, registered: false };
    try {
      await models.inTransaction((c) => models.insert(c, ctx, served));
    } catch (err) {
      // Another run registered it first.
      const raced = (err as { code?: string }).code === UNIQUE_VIOLATION ? await find() : null;
      if (raced) return { row: raced, registered: false };
      throw err;
    }
    return { row: (await find())!, registered: true };
  }

  /** GET /ml-models: newest first. */
  async list(filter: MlModelListFilter): Promise<{ items: MlModelView[]; total: number }> {
    const { models } = this.deps;
    return models.inTransaction(async (client) => {
      const { items, total } = await models.list(client, filter);
      return { items: await this.views(client, items), total };
    });
  }

  /** GET /ml-models/{id}. */
  async get(publicId: string): Promise<MlModelView> {
    if (!UUID.test(publicId)) throw mlModelNotFound();
    const { models } = this.deps;
    return models.inTransaction(async (client) => {
      const row = await models.findRow(client, publicId);
      if (!row) throw mlModelNotFound();
      return (await this.views(client, [row]))[0];
    });
  }

  /**
   * POST /ml-models/{id}/activate: lets this model score, and retires the active model of its name.
   * Activating the active model changes nothing; a retired model may be activated again (a rollback).
   * A model trained on other inputs than the core computes is refused.
   */
  async activate(caller: Caller, publicId: string): Promise<MlModelView> {
    return this.activateAs({ userId: caller.user.id, correlationId: caller.correlationId }, publicId);
  }

  /** As `activate`, for the administrator `ctx.userId` (`npm run ml:model -- activate`). */
  async activateAs(ctx: MutationContext, publicId: string): Promise<MlModelView> {
    if (!UUID.test(publicId)) throw mlModelNotFound();
    const { models } = this.deps;
    return models.inTransaction(async (client) => {
      const target = await models.findRow(client, publicId);
      if (!target) throw mlModelNotFound();
      const sameName = await models.lockName(client, target.name);
      const locked = sameName.find((m) => m.id === target.id)!;
      if (locked.status !== 'active') {
        if (locked.featureSpecHash !== this.deps.spec().hash) throw mlModelFeaturesMismatch();
        const at = this.now();
        for (const other of sameName) if (other.status === 'active') await models.retire(client, ctx, other.id, at);
        await models.activate(client, ctx, locked.id, at, ctx.userId === null ? null : String(ctx.userId));
      }
      return (await this.views(client, [(await models.findRow(client, publicId))!]))[0];
    });
  }

  private async views(db: Queryable, rows: MlModelRow[]): Promise<MlModelView[]> {
    const ids = [...new Set(rows.flatMap((r) => (r.activatedBy ? [r.activatedBy] : [])))];
    const users = new Map((await this.deps.users.findByIds(db, ids)).map((u) => [u.id, u.publicId]));
    const hash = this.deps.spec().hash;
    return rows.map((r) => ({
      id: r.publicId,
      name: r.name,
      version: r.version,
      status: r.status,
      algorithm: r.algorithm,
      features: r.features,
      feature_spec_version: r.featureSpecVersion,
      feature_spec_hash: r.featureSpecHash,
      features_match: r.featureSpecHash === hash,
      metrics: r.metrics,
      training_data: r.trainingData,
      trained_at: r.trainedAt,
      artefact_sha256: r.artefactSha256,
      first_seen_at: r.firstSeenAt,
      activated_at: r.activatedAt,
      activated_by: r.activatedBy ? (users.get(r.activatedBy) ?? null) : null,
      retired_at: r.retiredAt,
    }));
  }
}

import type { PoolClient } from 'pg';
import { depotScope, type Scope } from '../../../shared/authz/scope';
import { aggregateKey, createEvent } from '../../../shared/events/domain-event';
import type { EventBus } from '../../../shared/events/event-bus';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { FailureComponent } from '../domain/failure';
import {
  PREDICTION_FEEDBACK_EVENTS,
  editableUntil,
  feedbackAlreadyRecorded,
  feedbackComponentMismatch,
  feedbackFailureNotFound,
  feedbackFailureOtherVehicle,
  feedbackNotAuthor,
  feedbackNotFound,
  feedbackWindowClosed,
  foundWithoutIssue,
  predictionNotFound,
  type FeedbackInput,
  type FeedbackPatch,
  type PredictionFeedbackView,
} from '../domain/prediction-feedback';
import type { FailureRepository } from '../infrastructure/failure.repository';
import type { FeedbackRow, PredictionFeedbackRepository, PredictionRef } from '../infrastructure/prediction-feedback.repository';
import type { Caller } from './maintenance.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNIQUE_VIOLATION = '23505';

export interface PredictionFeedbackServiceDeps {
  feedback: PredictionFeedbackRepository;
  vehicles: { findInScope(db: Queryable, by: { id: string }, scope: Scope): Promise<{ id: string; publicId: string } | null> };
  failures: Pick<FailureRepository, 'findByPublicId'>;
  users: { findByIds(db: Queryable, ids: readonly string[]): Promise<{ id: string; publicId: string }[]> };
  events: EventBus;
  now?: () => Date;
}

/** What a feedback is about once checked: the failure it names (internal id) and the component found. */
interface Found {
  component: FailureComponent | null;
  failureEventId: string | null;
}

/**
 * Feedback on predictions (FMS-128, docs/ml-scoring.md): a technician says what they found on a vehicle the
 * model flagged. One per prediction, for a prediction on a vehicle in the caller's depots (anything else is
 * 404). The author may change it for 7 days. A confirmed issue can name the failure record it led to
 * (FMS-125) and the component; the other outcomes carry neither. Each write publishes PredictionFeedbackRecorded.
 */
export class PredictionFeedbackService {
  constructor(private readonly deps: PredictionFeedbackServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** POST /maintenance-predictions/{id}/feedback. */
  async record(caller: Caller, predictionId: string, input: FeedbackInput): Promise<PredictionFeedbackView> {
    const { feedback } = this.deps;
    return feedback.inTransaction(async (client) => {
      const { prediction, vehicle } = await this.target(client, caller, predictionId);
      const existing = await feedback.forPrediction(client, prediction.id);
      if (existing) throw feedbackAlreadyRecorded(existing.publicId);
      const found = await this.found(client, caller, prediction, input.outcome, input.component, input.failure_event_id);
      let row: FeedbackRow;
      try {
        row = await feedback.insert(client, mutationContext(caller), {
          prediction_id: prediction.id,
          user_id: caller.user.id as string,
          outcome: input.outcome,
          component: found.component,
          failure_event_id: found.failureEventId,
          comment: input.comment ?? null,
        });
      } catch (err) {
        // The lock above makes this a second feedback only if the first committed in between.
        if ((err as { code?: string }).code === UNIQUE_VIOLATION) throw feedbackAlreadyRecorded((await feedback.forPrediction(client, prediction.id))?.publicId ?? '');
        throw err;
      }
      await this.publish(client, caller, prediction, vehicle.publicId, row, false);
      return (await this.views(client, caller, [row]))[0];
    });
  }

  /**
   * PATCH /maintenance-predictions/{id}/feedback: the author's change, within 7 days of giving it. Changing the
   * outcome to anything but a confirmed issue drops the component and the failure link. A request that
   * changes nothing writes and publishes nothing.
   */
  async edit(caller: Caller, predictionId: string, patch: FeedbackPatch): Promise<PredictionFeedbackView> {
    const { feedback } = this.deps;
    return feedback.inTransaction(async (client) => {
      const { prediction, vehicle } = await this.target(client, caller, predictionId);
      const existing = await feedback.forPrediction(client, prediction.id);
      if (!existing) throw feedbackNotFound();
      if (existing.userId !== caller.user.id) throw feedbackNotAuthor();
      if (this.now() > editableUntil(existing.createdAt)) throw feedbackWindowClosed();

      const outcome = patch.outcome ?? existing.outcome;
      const found =
        outcome === 'confirmed_issue'
          ? await this.found(
              client,
              caller,
              prediction,
              outcome,
              patch.component === undefined ? existing.component : patch.component,
              patch.failure_event_id === undefined ? existing.failurePublicId : patch.failure_event_id,
            )
          : await this.found(client, caller, prediction, outcome, patch.component, patch.failure_event_id);
      const comment = patch.comment === undefined ? existing.comment : patch.comment;

      const changed = outcome !== existing.outcome || found.component !== existing.component || found.failureEventId !== existing.failureEventId || comment !== existing.comment;
      if (!changed) return (await this.views(client, caller, [existing]))[0];

      const row = await feedback.update(client, mutationContext(caller), existing.id, {
        outcome,
        component: found.component,
        failure_event_id: found.failureEventId,
        comment,
      });
      await this.publish(client, caller, prediction, vehicle.publicId, row, true);
      return (await this.views(client, caller, [row]))[0];
    });
  }

  /** The feedback of a prediction (internal id) as the caller sees it, or null: for the health score view. */
  async forPrediction(db: Queryable, caller: Caller, predictionId: string): Promise<PredictionFeedbackView | null> {
    const row = await this.deps.feedback.forPrediction(db, predictionId);
    return row ? (await this.views(db, caller, [row]))[0] : null;
  }

  /** The prediction, and its vehicle if it is in the caller's depots; 404 for anything else, a missing prediction included. */
  private async target(client: PoolClient, caller: Caller, predictionId: string): Promise<{ prediction: PredictionRef; vehicle: { id: string; publicId: string } }> {
    if (!UUID.test(predictionId)) throw predictionNotFound();
    const prediction = await this.deps.feedback.findPrediction(client, predictionId, true);
    const vehicle = prediction && (await this.deps.vehicles.findInScope(client, { id: prediction.vehicleId }, depotScope(caller.user)));
    if (!prediction || !vehicle) throw predictionNotFound();
    return { prediction, vehicle };
  }

  /**
   * What the outcome allows: for a confirmed issue the component found and the failure record it led to (the
   * same vehicle's, in the caller's depots; the component defaults to the failure's and may not contradict it);
   * for any other outcome neither.
   */
  private async found(
    client: PoolClient,
    caller: Caller,
    prediction: PredictionRef,
    outcome: FeedbackInput['outcome'],
    component: FailureComponent | null | undefined,
    failurePublicId: string | null | undefined,
  ): Promise<Found> {
    if (outcome !== 'confirmed_issue') {
      if (component) throw foundWithoutIssue('component');
      if (failurePublicId) throw foundWithoutIssue('failure_event_id');
      return { component: null, failureEventId: null };
    }
    if (!failurePublicId) return { component: component ?? null, failureEventId: null };
    const failure = UUID.test(failurePublicId) ? await this.deps.failures.findByPublicId(client, failurePublicId) : null;
    const vehicle = failure && (await this.deps.vehicles.findInScope(client, { id: failure.vehicleId }, depotScope(caller.user)));
    if (!failure || !vehicle) throw feedbackFailureNotFound();
    if (failure.vehicleId !== prediction.vehicleId) throw feedbackFailureOtherVehicle();
    if (component && component !== failure.component) throw feedbackComponentMismatch();
    return { component: failure.component, failureEventId: failure.id };
  }

  private publish(client: PoolClient, caller: Caller, prediction: PredictionRef, vehiclePublicId: string, row: FeedbackRow, edited: boolean) {
    return this.deps.events.publish(client, [
      createEvent(
        PREDICTION_FEEDBACK_EVENTS.recorded,
        {
          feedback_id: row.publicId,
          prediction_id: prediction.publicId,
          vehicle_id: vehiclePublicId,
          model_name: prediction.modelName,
          model_version: prediction.modelVersion,
          risk_level: prediction.riskLevel,
          outcome: row.outcome,
          component: row.component,
          failure_event_id: row.failurePublicId,
          edited,
        },
        { actor: caller.user.publicId, correlationId: caller.correlationId },
        // In order with the vehicle's other events.
        { aggregate: aggregateKey('vehicle', vehiclePublicId) },
      ),
    ]);
  }

  private async views(db: Queryable, caller: Caller, rows: FeedbackRow[]): Promise<PredictionFeedbackView[]> {
    const users = new Map((await this.deps.users.findByIds(db, [...new Set(rows.map((r) => r.userId))])).map((u) => [u.id, u.publicId]));
    const now = this.now();
    return rows.map((r) => {
      const until = editableUntil(r.createdAt);
      return {
        id: r.publicId,
        prediction_id: r.predictionPublicId,
        outcome: r.outcome,
        component: r.component,
        failure_event_id: r.failurePublicId,
        comment: r.comment,
        recorded_by: users.get(r.userId) ?? null,
        created_at: r.createdAt,
        updated_at: r.updatedAt,
        editable_until: until,
        can_edit: r.userId === caller.user.id && now <= until,
      };
    });
  }
}

function mutationContext(caller: Caller): MutationContext {
  return { userId: caller.user.id, correlationId: caller.correlationId };
}

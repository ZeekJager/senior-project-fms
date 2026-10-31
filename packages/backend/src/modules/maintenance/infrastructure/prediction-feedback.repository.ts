import type { Pool, PoolClient } from 'pg';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { Repository } from '../../../shared/infrastructure/repository';
import type { FailureComponent } from '../domain/failure';
import { FEEDBACK_MONTHS, type PredictionOutcome } from '../domain/prediction-feedback';
import type { RiskLevel } from '../domain/scoring';

/** A scored prediction, internal ids. */
export interface PredictionRef {
  id: string;
  publicId: string;
  vehicleId: string;
  riskLevel: RiskLevel;
  modelName: string;
  modelVersion: string;
}

/** A maintenance.prediction_feedback row; `failurePublicId` is the failure record it names. */
export interface FeedbackRow {
  id: string;
  publicId: string;
  predictionId: string;
  predictionPublicId: string;
  userId: string;
  outcome: PredictionOutcome;
  component: FailureComponent | null;
  failureEventId: string | null;
  failurePublicId: string | null;
  comment: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewFeedback {
  prediction_id: string;
  user_id: string;
  outcome: PredictionOutcome;
  component: FailureComponent | null;
  failure_event_id: string | null;
  comment: string | null;
}

/** One model version's counts of feedback on its high-risk predictions, and by month. */
export interface FeedbackCounts {
  modelName: string;
  modelVersion: string;
  highRisk: number;
  withFeedback: number;
  confirmed: number;
  noIssue: number;
  alreadyFixed: number;
  notInspected: number;
  months: { month: string; reviewed: number; confirmed: number }[];
}

const ROW_SQL = `
  SELECT f.id, f.public_id AS "publicId", f.prediction_id AS "predictionId", p.public_id AS "predictionPublicId",
         f.user_id AS "userId", f.outcome, f.component, f.failure_event_id AS "failureEventId",
         e.public_id AS "failurePublicId", f.comment, f.created_at AS "createdAt", f.updated_at AS "updatedAt"
    FROM maintenance.prediction_feedback f
    JOIN maintenance.maintenance_predictions p ON p.id = f.prediction_id
    LEFT JOIN maintenance.failure_events e ON e.id = f.failure_event_id`;

/**
 * maintenance.prediction_feedback (FMS-128): what a technician found on a flagged vehicle. One row per
 * prediction; the author may change it for a week (the service checks), nobody deletes it. Each write is
 * one audit row.
 */
export class PredictionFeedbackRepository extends Repository {
  constructor(db: Pool) {
    super(db);
  }

  inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.transaction(fn);
  }

  /** A scored prediction by public id (an old row with no health score is not one), or null. `lock` holds it, so two first feedbacks are decided one after the other. */
  async findPrediction(db: Queryable, publicId: string, lock = false): Promise<PredictionRef | null> {
    const res = await db.query<PredictionRef>(
      `SELECT p.id, p.public_id AS "publicId", p.vehicle_id AS "vehicleId", p.risk_level AS "riskLevel",
              p.model_name AS "modelName", p.model_version AS "modelVersion"
         FROM maintenance.maintenance_predictions p
        WHERE p.public_id = $1 AND p.health_score IS NOT NULL${lock ? ' FOR UPDATE' : ''}`,
      [publicId],
    );
    return res.rows[0] ?? null;
  }

  async forPrediction(db: Queryable, predictionId: string): Promise<FeedbackRow | null> {
    const res = await db.query<FeedbackRow>(`${ROW_SQL} WHERE f.prediction_id = $1`, [predictionId]);
    return res.rows[0] ?? null;
  }

  async findById(db: Queryable, id: string): Promise<FeedbackRow> {
    const res = await db.query<FeedbackRow>(`${ROW_SQL} WHERE f.id = $1`, [id]);
    return res.rows[0];
  }

  async insert(client: PoolClient, ctx: MutationContext, feedback: NewFeedback): Promise<FeedbackRow> {
    const row = await this.mutate(ctx, 'maintenance.prediction_feedback', 'INSERT', null, { ...feedback }, client);
    return this.findById(client, row.id as string);
  }

  async update(client: PoolClient, ctx: MutationContext, id: string, patch: Partial<Omit<NewFeedback, 'prediction_id' | 'user_id'>>): Promise<FeedbackRow> {
    await this.mutate(ctx, 'maintenance.prediction_feedback', 'UPDATE', id, { ...patch }, client);
    return this.findById(client, id);
  }

  /**
   * The feedback on each model version's high-risk predictions (FMS-128): how many there are, how many have
   * feedback and what it says, and, for the months (Addis Ababa) feedback was given in, the ones judged.
   * A version with no high-risk predictions is absent.
   */
  async countsFor(db: Queryable, models: readonly { name: string; version: string }[]): Promise<FeedbackCounts[]> {
    if (models.length === 0) return [];
    const names = models.map((m) => m.name);
    const versions = models.map((m) => m.version);
    const totals = await db.query<Omit<FeedbackCounts, 'months'>>(
      `SELECT p.model_name AS "modelName", p.model_version AS "modelVersion",
              count(*)::int AS "highRisk", count(f.id)::int AS "withFeedback",
              count(*) FILTER (WHERE f.outcome = 'confirmed_issue')::int AS confirmed,
              count(*) FILTER (WHERE f.outcome = 'no_issue_found')::int AS "noIssue",
              count(*) FILTER (WHERE f.outcome = 'already_fixed')::int AS "alreadyFixed",
              count(*) FILTER (WHERE f.outcome = 'not_inspected')::int AS "notInspected"
         FROM maintenance.maintenance_predictions p
         LEFT JOIN maintenance.prediction_feedback f ON f.prediction_id = p.id
        WHERE p.risk_level = 'high' AND p.health_score IS NOT NULL
          AND (p.model_name, p.model_version) IN (SELECT * FROM unnest($1::text[], $2::text[]))
        GROUP BY p.model_name, p.model_version`,
      [names, versions],
    );
    const months = await db.query<{ modelName: string; modelVersion: string; month: string; reviewed: number; confirmed: number }>(
      `SELECT p.model_name AS "modelName", p.model_version AS "modelVersion",
              to_char(f.created_at AT TIME ZONE 'Africa/Addis_Ababa', 'YYYY-MM') AS month,
              count(*)::int AS reviewed, count(*) FILTER (WHERE f.outcome = 'confirmed_issue')::int AS confirmed
         FROM maintenance.maintenance_predictions p
         JOIN maintenance.prediction_feedback f ON f.prediction_id = p.id
        WHERE p.risk_level = 'high' AND p.health_score IS NOT NULL AND f.outcome <> 'not_inspected'
          AND (p.model_name, p.model_version) IN (SELECT * FROM unnest($1::text[], $2::text[]))
          AND (f.created_at AT TIME ZONE 'Africa/Addis_Ababa') >= date_trunc('month', now() AT TIME ZONE 'Africa/Addis_Ababa') - make_interval(months => $3)
        GROUP BY p.model_name, p.model_version, month
        ORDER BY month DESC`,
      [names, versions, FEEDBACK_MONTHS - 1],
    );
    return totals.rows.map((t) => ({
      ...t,
      months: months.rows.filter((m) => m.modelName === t.modelName && m.modelVersion === t.modelVersion).map(({ month, reviewed, confirmed }) => ({ month, reviewed, confirmed })),
    }));
  }
}

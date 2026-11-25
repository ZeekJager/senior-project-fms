import type { Pool, PoolClient } from 'pg';
import { recordAuditEntry } from '../../../shared/infrastructure/audit-log';
import type { MutationContext, Row } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { Repository } from '../../../shared/infrastructure/repository';
import type { FeedbackSubject, FeedbackTone } from '../domain/feedback';
import { audience, type Audience } from './analytics.repository';
import type { AppealDriver } from './appeal.repository';

// Admin-to-driver feedback (FMS-158, docs/driver-feedback.md): analytics.driver_feedback, its earlier texts and the
// saved templates; drivers, depots and trips through the analytics views only. Read on the primary: an item shows
// the moment it is saved.

/** An analytics.driver_feedback row, internal ids, with its trip's public id. */
export interface FeedbackRow {
  id: string;
  publicId: string;
  driverId: string;
  depotId: string | null;
  subjectType: FeedbackSubject;
  tripId: string | null;
  tripPublicId: string | null;
  /** `YYYY-MM`, for a month. */
  scoreMonth: string | null;
  scoreShown: number | null;
  category: string;
  tone: FeedbackTone;
  message: string;
  authorId: string;
  editableUntil: Date;
  editedAt: Date | null;
  retractedAt: Date | null;
  retractedBy: string | null;
  retractionReason: string | null;
  acknowledgedAt: Date | null;
  reply: string | null;
  repliedAt: Date | null;
  createdAt: Date;
  version: number;
}

export interface RevisionRow {
  feedbackId: string;
  message: string;
  revisedBy: string | null;
  at: Date;
}

export interface TemplateRow {
  id: string;
  publicId: string;
  category: string;
  title: string;
  body: string;
  isActive: boolean;
  version: number;
  updatedAt: Date;
}

export interface FeedbackFilter {
  driverId: string;
  /** The driver's own view leaves out retracted items. */
  live?: boolean;
  category?: string;
  tone?: FeedbackTone;
  limit: number;
  offset: number;
}

const COLUMNS = `f.id, f.public_id::text AS "publicId", f.driver_id::text AS "driverId", f.depot_id::text AS "depotId",
  f.subject_type AS "subjectType", f.trip_id::text AS "tripId",
  (SELECT t.public_id::text FROM analytics.trip_history_facts t WHERE t.trip_id = f.trip_id) AS "tripPublicId",
  to_char(f.score_month, 'YYYY-MM') AS "scoreMonth", f.score_shown AS "scoreShown", f.category, f.tone, f.message,
  f.author_id::text AS "authorId", f.editable_until AS "editableUntil", f.edited_at AS "editedAt",
  f.retracted_at AS "retractedAt", f.retracted_by::text AS "retractedBy", f.retraction_reason AS "retractionReason",
  f.acknowledged_at AS "acknowledgedAt", f.reply, f.replied_at AS "repliedAt", f.created_at AS "createdAt", f.version`;

const TEMPLATE_COLUMNS = `id, public_id::text AS "publicId", category, title, body, is_active AS "isActive", version, updated_at AS "updatedAt"`;

const DRIVER = `SELECT d.driver_id::text AS "driverId", d.public_id::text AS "publicId", d.full_name AS name, u.user_id::text AS "userId",
  d.depot_id::text AS "depotId", d.depot_public_id::text AS "depotPublicId", d.depot_name AS "depotName"
  FROM analytics.driver_directory d LEFT JOIN analytics.driver_users u ON u.driver_id = d.driver_id`;

export class FeedbackRepository extends Repository {
  constructor(db: Pool) {
    super(db);
  }

  pool(): Pool {
    return this.db;
  }

  inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.transaction(fn);
  }

  /** A driver by public id, or null. */
  async driver(db: Queryable, publicId: string): Promise<AppealDriver | null> {
    const res = await db.query<AppealDriver>(`${DRIVER} WHERE d.public_id = $1`, [publicId]);
    return res.rows[0] ?? null;
  }

  async driverById(db: Queryable, driverId: string): Promise<AppealDriver | null> {
    const res = await db.query<AppealDriver>(`${DRIVER} WHERE d.driver_id = $1`, [driverId]);
    return res.rows[0] ?? null;
  }

  /** The driver signed in as this user, or null. */
  async driverOfUser(db: Queryable, userId: string): Promise<AppealDriver | null> {
    const res = await db.query<AppealDriver>(`${DRIVER} WHERE u.user_id = $1`, [userId]);
    return res.rows[0] ?? null;
  }

  /** Whether a depot (internal id; null for none) is in a manager's audience. */
  async depotInAudience(db: Queryable, depotId: string | null, a: Audience): Promise<boolean> {
    const w = audience(a, 'x.depot_id', 2);
    const res = await db.query(`SELECT 1 FROM (SELECT $1::bigint AS depot_id) x WHERE ${w.sql}`, [depotId, ...w.params]);
    return res.rowCount !== 0;
  }

  /** A trip by public id: whose it was, whether it is completed, and when it ended. */
  async trip(db: Queryable, publicId: string): Promise<{ id: string; driverId: string | null; status: string; endedAt: Date | null } | null> {
    const res = await db.query<{ id: string; driverId: string | null; status: string; endedAt: Date | null }>(
      `SELECT trip_id::text AS id, driver_id::text AS "driverId", status, actual_end AS "endedAt" FROM analytics.trip_history_facts WHERE public_id = $1`,
      [publicId],
    );
    return res.rows[0] ?? null;
  }

  insert(ctx: MutationContext, data: Row, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'analytics.driver_feedback', 'INSERT', null, data, client);
  }

  update(ctx: MutationContext, id: string, data: Row, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'analytics.driver_feedback', 'UPDATE', id, data, client);
  }

  /**
   * Deletes items for good, with their earlier texts (an erasure, or the retention job): `action` is the audit entry
   * per item, which records which item went and why, never its words (an erasure does not copy what it erases).
   * Audited mutations soft-delete, so this writes its own entries.
   */
  async remove(ctx: MutationContext, ids: readonly string[], action: 'privacy.feedback_erased' | 'feedback.retention_deleted', client: PoolClient): Promise<number> {
    if (ids.length === 0) return 0;
    const res = await client.query<{ id: string; publicId: string; driverId: string; createdAt: Date }>(
      `DELETE FROM analytics.driver_feedback WHERE id = ANY($1::bigint[])
       RETURNING id::text, public_id::text AS "publicId", driver_id::text AS "driverId", created_at AS "createdAt"`,
      [ids],
    );
    for (const r of res.rows) {
      await recordAuditEntry(client, {
        action,
        userId: ctx.userId,
        entityType: 'analytics.driver_feedback',
        entityId: r.id,
        correlationId: ctx.correlationId,
        details: { feedback_id: r.publicId, driver_id: r.driverId, given_at: r.createdAt.toISOString() },
      });
    }
    return res.rowCount ?? 0;
  }

  addRevision(ctx: MutationContext, feedbackId: string, message: string, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'analytics.feedback_revisions', 'INSERT', null, { feedback_id: feedbackId, message, revised_by: ctx.userId }, client);
  }

  async find(db: Queryable, publicId: string, lock = false): Promise<FeedbackRow | null> {
    const res = await db.query<FeedbackRow>(`SELECT ${COLUMNS} FROM analytics.driver_feedback f WHERE f.public_id = $1${lock ? ' FOR UPDATE OF f' : ''}`, [publicId]);
    return res.rows[0] ?? null;
  }

  async findById(db: Queryable, id: string): Promise<FeedbackRow | null> {
    const res = await db.query<FeedbackRow>(`SELECT ${COLUMNS} FROM analytics.driver_feedback f WHERE f.id = $1`, [id]);
    return res.rows[0] ?? null;
  }

  /** A driver's items, newest first. */
  async list(db: Queryable, f: FeedbackFilter): Promise<{ rows: FeedbackRow[]; total: number }> {
    const where = ['f.driver_id = $1'];
    const params: unknown[] = [f.driverId];
    if (f.live) where.push('f.retracted_at IS NULL');
    if (f.category) {
      params.push(f.category);
      where.push(`f.category = $${params.length}`);
    }
    if (f.tone) {
      params.push(f.tone);
      where.push(`f.tone = $${params.length}`);
    }
    const condition = where.join(' AND ');
    const total = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM analytics.driver_feedback f WHERE ${condition}`, params);
    const res = await db.query<FeedbackRow>(
      `SELECT ${COLUMNS} FROM analytics.driver_feedback f WHERE ${condition} ORDER BY f.created_at DESC, f.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, f.limit, f.offset],
    );
    return { rows: res.rows, total: total.rows[0].n };
  }

  /** A driver's live items per category since `since`, and how many of them are unacknowledged past `staleBefore`. */
  async counts(db: Queryable, driverId: string, since: Date, staleBefore: Date): Promise<{ byCategory: Record<string, number>; unacknowledged: number }> {
    const res = await db.query<{ category: string; n: number }>(
      `SELECT category, count(*)::int AS n FROM analytics.driver_feedback
        WHERE driver_id = $1 AND retracted_at IS NULL AND created_at >= $2 GROUP BY category`,
      [driverId, since],
    );
    const stale = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM analytics.driver_feedback
        WHERE driver_id = $1 AND retracted_at IS NULL AND acknowledged_at IS NULL AND created_at <= $2`,
      [driverId, staleBefore],
    );
    return { byCategory: Object.fromEntries(res.rows.map((r) => [r.category, r.n])), unacknowledged: stale.rows[0].n };
  }

  async revisions(db: Queryable, feedbackIds: readonly string[]): Promise<RevisionRow[]> {
    if (feedbackIds.length === 0) return [];
    const res = await db.query<RevisionRow>(
      `SELECT feedback_id::text AS "feedbackId", message, revised_by::text AS "revisedBy", created_at AS at
         FROM analytics.feedback_revisions WHERE feedback_id = ANY($1::bigint[]) ORDER BY id`,
      [feedbackIds],
    );
    return res.rows;
  }

  /** Every item of a driver, retracted ones too, oldest first: for their data export. */
  async forDriver(db: Queryable, driverId: string): Promise<FeedbackRow[]> {
    const res = await db.query<FeedbackRow>(`SELECT ${COLUMNS} FROM analytics.driver_feedback f WHERE f.driver_id = $1 ORDER BY f.created_at, f.id`, [driverId]);
    return res.rows;
  }

  /** Items given before `cutoff`, oldest first, for the retention job. */
  async olderThan(db: Queryable, cutoff: Date, limit: number): Promise<string[]> {
    const res = await db.query<{ id: string }>(`SELECT id::text FROM analytics.driver_feedback WHERE created_at < $1 ORDER BY created_at, id LIMIT $2`, [cutoff, limit]);
    return res.rows.map((r) => r.id);
  }

  /** The ids of a driver's items, for an erasure. */
  async idsOfDriver(db: Queryable, driverId: string): Promise<string[]> {
    const res = await db.query<{ id: string }>(`SELECT id::text FROM analytics.driver_feedback WHERE driver_id = $1 ORDER BY id`, [driverId]);
    return res.rows.map((r) => r.id);
  }

  /** The author of the feedback an appeal disagrees with (FMS-159), or null. */
  async authorOf(db: Queryable, feedbackId: string): Promise<string | null> {
    const res = await db.query<{ authorId: string }>(`SELECT author_id::text AS "authorId" FROM analytics.driver_feedback WHERE id = $1`, [feedbackId]);
    return res.rows[0]?.authorId ?? null;
  }

  // Templates ------------------------------------------------------------------------------------------------------

  async templates(db: Queryable, category?: string): Promise<TemplateRow[]> {
    const params: unknown[] = [];
    let where = 'is_active';
    if (category) {
      params.push(category);
      where += ' AND category = $1';
    }
    const res = await db.query<TemplateRow>(`SELECT ${TEMPLATE_COLUMNS} FROM analytics.feedback_templates WHERE ${where} ORDER BY category, lower(title), id LIMIT 500`, params);
    return res.rows;
  }

  async template(db: Queryable, publicId: string, lock = false): Promise<TemplateRow | null> {
    const res = await db.query<TemplateRow>(`SELECT ${TEMPLATE_COLUMNS} FROM analytics.feedback_templates WHERE public_id = $1 AND is_active${lock ? ' FOR UPDATE' : ''}`, [publicId]);
    return res.rows[0] ?? null;
  }

  insertTemplate(ctx: MutationContext, data: Row, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'analytics.feedback_templates', 'INSERT', null, data, client);
  }

  updateTemplate(ctx: MutationContext, id: string, data: Row, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'analytics.feedback_templates', 'UPDATE', id, data, client);
  }
}

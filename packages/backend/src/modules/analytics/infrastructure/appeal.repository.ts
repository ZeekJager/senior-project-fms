import type { Pool, PoolClient } from 'pg';
import type { MutationContext, Row } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { Repository } from '../../../shared/infrastructure/repository';
import type { AppealEventType, AppealKind, AppealOutcome, AppealReason, AppealStatus, AppealTargetType, AttachmentType, Correction } from '../domain/appeal';
import { audience, type Audience } from './analytics.repository';

// Score appeals (FMS-159, docs/score-appeals.md): analytics.score_appeals and their steps, attachments and score
// exclusions, and what they are against through the analytics views only. Read on the primary: a step shows the
// moment it is saved.

/** An analytics.score_appeals row, internal ids, with its target's and trip's public ids. */
export interface AppealRow {
  id: string;
  publicId: string;
  driverId: string;
  depotId: string | null;
  kind: AppealKind;
  targetType: AppealTargetType;
  flagId: string | null;
  incidentId: string | null;
  /** `YYYY-MM`, for a score. */
  scoreMonth: string | null;
  tripId: string | null;
  targetPublicId: string | null;
  tripPublicId: string | null;
  eventAt: Date;
  reason: AppealReason;
  explanation: string;
  status: AppealStatus;
  outcome: AppealOutcome | null;
  correction: Correction | null;
  decisionNote: string | null;
  scoreBefore: number | null;
  scoreAfter: number | null;
  submittedBy: string;
  claimedBy: string | null;
  claimedAt: Date | null;
  decidedBy: string | null;
  decidedAt: Date | null;
  dueAt: Date;
  escalatedAt: Date | null;
  acknowledgedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  version: number;
}

export interface AppealDriver {
  driverId: string;
  publicId: string;
  name: string;
  userId: string | null;
  depotId: string | null;
  depotPublicId: string | null;
  depotName: string | null;
}

/** A flag or an incident a driver may appeal: whose, when, on which trip and vehicle, and who reported or reviewed it. */
export interface AppealableFact {
  id: string;
  publicId: string;
  kind: string;
  driverId: string | null;
  tripId: string | null;
  tripPublicId: string | null;
  vehicleId: string | null;
  at: Date;
  endedAt: Date | null;
  /** The user who reported the incident or reviewed the flag: they may not decide an appeal against it. */
  reporterId: string | null;
  excluded: boolean;
}

/** A flag or incident on the driver's appealable list, with its open appeal if any. */
export type AppealableItem = AppealableFact & { target: 'flag' | 'incident'; openAppealId: string | null };

export interface AppealEventRow {
  publicId: string;
  type: AppealEventType;
  actorId: string | null;
  body: string | null;
  at: Date;
}

export interface AttachmentRow {
  id: string;
  publicId: string;
  appealId: string;
  storageKey: string;
  contentType: AttachmentType;
  sizeBytes: number;
  filename: string | null;
  uploadedBy: string;
}

export interface AppealFilter {
  /** Reviewers: the appeals of the depots in their audience. */
  audience?: Audience;
  /** A driver: their own. */
  driverId?: string;
  statuses?: readonly AppealStatus[];
  overdueAt?: Date;
  /** Oldest first for the queue, newest first for a driver. */
  order: 'oldest' | 'newest';
  limit: number;
  offset: number;
}

const COLUMNS = `a.id, a.public_id AS "publicId", a.driver_id AS "driverId", a.depot_id AS "depotId", a.kind,
  a.target_type AS "targetType", a.flag_id AS "flagId", a.incident_id AS "incidentId", to_char(a.score_month, 'YYYY-MM') AS "scoreMonth",
  a.trip_id AS "tripId",
  COALESCE((SELECT f.public_id::text FROM analytics.score_flag_facts f WHERE f.flag_id = a.flag_id),
           (SELECT i.public_id::text FROM analytics.score_incident_facts i WHERE i.incident_id = a.incident_id)) AS "targetPublicId",
  (SELECT t.public_id::text FROM analytics.trip_history_facts t WHERE t.trip_id = a.trip_id) AS "tripPublicId",
  a.event_at AS "eventAt", a.reason, a.explanation, a.status, a.outcome, a.correction, a.decision_note AS "decisionNote",
  a.score_before AS "scoreBefore", a.score_after AS "scoreAfter", a.submitted_by AS "submittedBy",
  a.claimed_by AS "claimedBy", a.claimed_at AS "claimedAt", a.decided_by AS "decidedBy", a.decided_at AS "decidedAt",
  a.due_at AS "dueAt", a.escalated_at AS "escalatedAt", a.acknowledged_at AS "acknowledgedAt", a.closed_at AS "closedAt",
  a.created_at AS "createdAt", a.version`;

const DRIVER = `SELECT d.driver_id AS "driverId", d.public_id AS "publicId", d.full_name AS name, u.user_id AS "userId",
  d.depot_id AS "depotId", d.depot_public_id AS "depotPublicId", d.depot_name AS "depotName"
  FROM analytics.driver_directory d LEFT JOIN analytics.driver_users u ON u.driver_id = d.driver_id`;

export class AppealRepository extends Repository {
  constructor(db: Pool) {
    super(db);
  }

  pool(): Pool {
    return this.db;
  }

  inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.transaction(fn);
  }

  /** The driver signed in as this user, or null. */
  async driverOfUser(db: Queryable, userId: string): Promise<AppealDriver | null> {
    const res = await db.query<AppealDriver>(`${DRIVER} WHERE u.user_id = $1`, [userId]);
    return res.rows[0] ?? null;
  }

  async drivers(db: Queryable, driverIds: readonly string[]): Promise<Map<string, AppealDriver>> {
    if (driverIds.length === 0) return new Map();
    const res = await db.query<AppealDriver>(`${DRIVER} WHERE d.driver_id = ANY($1::bigint[])`, [[...new Set(driverIds)]]);
    return new Map(res.rows.map((r) => [r.driverId, r]));
  }

  async depots(db: Queryable, depotIds: readonly string[]): Promise<Map<string, { publicId: string; name: string }>> {
    if (depotIds.length === 0) return new Map();
    const res = await db.query<{ id: string; publicId: string; name: string }>(
      `SELECT depot_id::text AS id, public_id::text AS "publicId", name FROM analytics.depot_directory WHERE depot_id = ANY($1::bigint[])`,
      [[...new Set(depotIds)]],
    );
    return new Map(res.rows.map((r) => [r.id, { publicId: r.publicId, name: r.name }]));
  }

  async vehiclePublicId(db: Queryable, vehicleId: string): Promise<{ publicId: string; registrationNumber: string } | null> {
    const res = await db.query<{ publicId: string; registrationNumber: string }>(
      `SELECT public_id::text AS "publicId", registration_number AS "registrationNumber" FROM analytics.vehicle_directory WHERE vehicle_id = $1 LIMIT 1`,
      [vehicleId],
    );
    return res.rows[0] ?? null;
  }

  /** A trip's flags, oldest first: the reviewer sees the appealed one among them. */
  async tripFlags(db: Queryable, tripId: string): Promise<{ publicId: string; kind: string; at: Date; endedAt: Date | null; excluded: boolean }[]> {
    const res = await db.query<{ publicId: string; kind: string; at: Date; endedAt: Date | null; excluded: boolean }>(
      `SELECT public_id::text AS "publicId", flag_type::text AS kind, observed_at AS at, resolved_at AS "endedAt", score_excluded AS excluded
         FROM analytics.score_flag_facts WHERE trip_id = $1 ORDER BY observed_at LIMIT 100`,
      [tripId],
    );
    return res.rows;
  }

  /** A trip's times, for the GPS track. */
  async tripTimes(db: Queryable, tripId: string): Promise<{ start: Date | null; end: Date | null } | null> {
    const res = await db.query<{ start: Date | null; end: Date | null }>(
      `SELECT actual_start AS start, actual_end AS "end" FROM analytics.trip_history_facts WHERE trip_id = $1`,
      [tripId],
    );
    return res.rows[0] ?? null;
  }

  /** A depot in the caller's audience by public id: its internal id, or null. */
  async depotInAudience(db: Queryable, publicId: string, a: Audience): Promise<string | null> {
    const w = audience(a, 'depot_id', 2);
    const res = await db.query<{ id: string }>(`SELECT depot_id::text AS id FROM analytics.depot_directory WHERE public_id = $1 AND ${w.sql}`, [publicId, ...w.params]);
    return res.rows[0]?.id ?? null;
  }

  async flag(db: Queryable, publicId: string): Promise<AppealableFact | null> {
    const res = await db.query<AppealableFact>(
      `SELECT f.flag_id::text AS id, f.public_id::text AS "publicId", f.flag_type::text AS kind, f.driver_id::text AS "driverId",
              f.trip_id::text AS "tripId", t.public_id::text AS "tripPublicId", f.vehicle_id::text AS "vehicleId",
              f.observed_at AS at, f.resolved_at AS "endedAt", f.reviewed_by::text AS "reporterId", f.score_excluded AS excluded
         FROM analytics.score_flag_facts f LEFT JOIN analytics.trip_history_facts t ON t.trip_id = f.trip_id
        WHERE f.public_id = $1`,
      [publicId],
    );
    return res.rows[0] ?? null;
  }

  async incident(db: Queryable, publicId: string): Promise<AppealableFact | null> {
    const res = await db.query<AppealableFact>(
      `SELECT i.incident_id::text AS id, i.public_id::text AS "publicId", i.incident_type AS kind, i.driver_id::text AS "driverId",
              i.trip_id::text AS "tripId", t.public_id::text AS "tripPublicId", i.vehicle_id::text AS "vehicleId",
              i.occurred_at AS at, NULL::timestamptz AS "endedAt", i.reported_by::text AS "reporterId", i.score_excluded AS excluded
         FROM analytics.score_incident_facts i LEFT JOIN analytics.trip_history_facts t ON t.trip_id = i.trip_id
        WHERE i.public_id = $1`,
      [publicId],
    );
    return res.rows[0] ?? null;
  }

  /** A trip by public id: whose it was and when it ended. */
  async trip(db: Queryable, publicId: string): Promise<{ id: string; driverId: string | null; endedAt: Date | null; startedAt: Date | null } | null> {
    const res = await db.query<{ id: string; driverId: string | null; endedAt: Date | null; startedAt: Date | null }>(
      `SELECT trip_id::text AS id, driver_id::text AS "driverId", actual_end AS "endedAt", actual_start AS "startedAt"
         FROM analytics.trip_history_facts WHERE public_id = $1`,
      [publicId],
    );
    return res.rows[0] ?? null;
  }

  /** What a driver may appeal from the last `days` days: their flags and incidents, newest first, with any open appeal. */
  async appealable(db: Queryable, driverId: string, since: Date): Promise<AppealableItem[]> {
    const res = await db.query<AppealableItem>(
      `SELECT 'flag' AS target, f.flag_id::text AS id, f.public_id::text AS "publicId", f.flag_type::text AS kind, f.driver_id::text AS "driverId",
              f.trip_id::text AS "tripId", t.public_id::text AS "tripPublicId", f.vehicle_id::text AS "vehicleId", f.observed_at AS at,
              f.resolved_at AS "endedAt", f.reviewed_by::text AS "reporterId", f.score_excluded AS excluded,
              (SELECT a.public_id::text FROM analytics.score_appeals a WHERE a.target_key = 'flag:' || f.flag_id AND a.status IN ('submitted', 'under_review')) AS "openAppealId"
         FROM analytics.score_flag_facts f LEFT JOIN analytics.trip_history_facts t ON t.trip_id = f.trip_id
        WHERE f.driver_id = $1 AND f.observed_at >= $2 AND f.flag_type::text IN ('speeding', 'idling')
       UNION ALL
       SELECT 'incident', i.incident_id::text, i.public_id::text, i.incident_type, i.driver_id::text, i.trip_id::text, t.public_id::text,
              i.vehicle_id::text, i.occurred_at, NULL::timestamptz, i.reported_by::text, i.score_excluded,
              (SELECT a.public_id::text FROM analytics.score_appeals a WHERE a.target_key = 'incident:' || i.incident_id AND a.status IN ('submitted', 'under_review'))
         FROM analytics.score_incident_facts i LEFT JOIN analytics.trip_history_facts t ON t.trip_id = i.trip_id
        WHERE i.driver_id = $1 AND i.occurred_at >= $2
        ORDER BY at DESC
        LIMIT 200`,
      [driverId, since],
    );
    return res.rows;
  }

  insert(ctx: MutationContext, data: Row, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'analytics.score_appeals', 'INSERT', null, data, client);
  }

  update(ctx: MutationContext, id: string, data: Row, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'analytics.score_appeals', 'UPDATE', id, data, client);
  }

  async find(db: Queryable, publicId: string, lock = false): Promise<AppealRow | null> {
    const res = await db.query<AppealRow>(`SELECT ${COLUMNS} FROM analytics.score_appeals a WHERE a.public_id = $1${lock ? ' FOR UPDATE OF a' : ''}`, [publicId]);
    return res.rows[0] ?? null;
  }

  async findById(db: Queryable, id: string): Promise<AppealRow | null> {
    const res = await db.query<AppealRow>(`SELECT ${COLUMNS} FROM analytics.score_appeals a WHERE a.id = $1`, [id]);
    return res.rows[0] ?? null;
  }

  /** Whether an appeal is in a reviewer's audience: its depot's, or any for an unscoped reviewer. */
  async inAudience(db: Queryable, appealId: string, a: Audience): Promise<boolean> {
    const w = audience(a, 'a.depot_id', 2);
    const res = await db.query(`SELECT 1 FROM analytics.score_appeals a WHERE a.id = $1 AND ${w.sql}`, [appealId, ...w.params]);
    return res.rowCount !== 0;
  }

  async list(db: Queryable, f: AppealFilter): Promise<{ rows: AppealRow[]; total: number }> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (f.audience) {
      const w = audience(f.audience, 'a.depot_id', params.length + 1);
      where.push(w.sql);
      params.push(...w.params);
    }
    if (f.driverId) {
      params.push(f.driverId);
      where.push(`a.driver_id = $${params.length}`);
    }
    if (f.statuses?.length) {
      params.push(f.statuses);
      where.push(`a.status = ANY($${params.length}::text[])`);
    }
    if (f.overdueAt) {
      params.push(f.overdueAt);
      where.push(`a.status IN ('submitted', 'under_review') AND a.due_at <= $${params.length}`);
    }
    const condition = where.length ? where.join(' AND ') : 'TRUE';
    const total = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM analytics.score_appeals a WHERE ${condition}`, params);
    const order = f.order === 'oldest' ? 'a.created_at ASC, a.id ASC' : 'a.created_at DESC, a.id DESC';
    const res = await db.query<AppealRow>(
      `SELECT ${COLUMNS} FROM analytics.score_appeals a WHERE ${condition} ORDER BY ${order} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, f.limit, f.offset],
    );
    return { rows: res.rows, total: total.rows[0].n };
  }

  addEvent(ctx: MutationContext, appealId: string, type: AppealEventType, body: string | null, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'analytics.appeal_events', 'INSERT', null, { appeal_id: appealId, event_type: type, actor_user_id: ctx.userId, body }, client);
  }

  async events(db: Queryable, appealId: string): Promise<AppealEventRow[]> {
    const res = await db.query<AppealEventRow>(
      `SELECT public_id::text AS "publicId", event_type AS type, actor_user_id::text AS "actorId", body, created_at AS at
         FROM analytics.appeal_events WHERE appeal_id = $1 ORDER BY id`,
      [appealId],
    );
    return res.rows;
  }

  addAttachment(ctx: MutationContext, data: Row, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'analytics.appeal_attachments', 'INSERT', null, data, client);
  }

  async attachments(db: Queryable, appealIds: readonly string[]): Promise<AttachmentRow[]> {
    if (appealIds.length === 0) return [];
    const res = await db.query<AttachmentRow>(
      `SELECT id, public_id::text AS "publicId", appeal_id::text AS "appealId", storage_key AS "storageKey", content_type AS "contentType",
              size_bytes AS "sizeBytes", original_filename AS filename, uploaded_by::text AS "uploadedBy"
         FROM analytics.appeal_attachments WHERE appeal_id = ANY($1::bigint[]) ORDER BY id`,
      [appealIds],
    );
    return res.rows;
  }

  async attachment(db: Queryable, publicId: string): Promise<AttachmentRow | null> {
    const res = await db.query<AttachmentRow>(
      `SELECT id, public_id::text AS "publicId", appeal_id::text AS "appealId", storage_key AS "storageKey", content_type AS "contentType",
              size_bytes AS "sizeBytes", original_filename AS filename, uploaded_by::text AS "uploadedBy"
         FROM analytics.appeal_attachments WHERE public_id = $1`,
      [publicId],
    );
    return res.rows[0] ?? null;
  }

  addExclusion(ctx: MutationContext, data: Row, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'analytics.score_exclusions', 'INSERT', null, data, client);
  }

  /** Undecided appeals past their deadline that have not been escalated yet, oldest first. */
  async dueForEscalation(db: Queryable, now: Date, limit: number): Promise<AppealRow[]> {
    const res = await db.query<AppealRow>(
      `SELECT ${COLUMNS} FROM analytics.score_appeals a
        WHERE a.status IN ('submitted', 'under_review') AND a.escalated_at IS NULL AND a.due_at <= $1
        ORDER BY a.due_at, a.id LIMIT $2`,
      [now, limit],
    );
    return res.rows;
  }

  /** Decisions made before `cutoff` that the driver never acknowledged. */
  async decidedBefore(db: Queryable, cutoff: Date, limit: number): Promise<AppealRow[]> {
    const res = await db.query<AppealRow>(
      `SELECT ${COLUMNS} FROM analytics.score_appeals a
        WHERE a.status IN ('approved', 'rejected') AND a.decided_at <= $1
        ORDER BY a.decided_at, a.id LIMIT $2`,
      [cutoff, limit],
    );
    return res.rows;
  }

  /** Approved appeals of a driver's month (by when what they were against happened), for "Corrected after appeal". */
  async corrections(db: Queryable, driverId: string, from: Date, to: Date): Promise<AppealRow[]> {
    const res = await db.query<AppealRow>(
      `SELECT ${COLUMNS} FROM analytics.score_appeals a
        WHERE a.driver_id = $1 AND a.outcome = 'approved' AND a.correction IS NOT NULL
          AND ((a.score_month IS NOT NULL AND a.score_month = ($2::timestamptz AT TIME ZONE 'Africa/Addis_Ababa')::date)
               OR (a.score_month IS NULL AND a.event_at >= $2 AND a.event_at < $3))
        ORDER BY a.decided_at`,
      [driverId, from, to],
    );
    return res.rows;
  }

  /** The KPI dashboard's figures (FMS-160): appeals opened in [from, to), decided, approved, and days to a decision. */
  async kpis(db: Queryable, a: Audience, from: Date, to: Date): Promise<{ opened: number; decided: number; approved: number; days: number[] }> {
    const w = audience(a, 'a.depot_id', 3);
    const opened = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM analytics.score_appeals a WHERE a.created_at >= $1 AND a.created_at < $2 AND ${w.sql}`,
      [from, to, ...w.params],
    );
    const decided = await db.query<{ outcome: string; days: number }>(
      `SELECT a.outcome, EXTRACT(EPOCH FROM a.decided_at - a.created_at)::float8 / 86400 AS days
         FROM analytics.score_appeals a
        WHERE a.decided_at >= $1 AND a.decided_at < $2 AND a.outcome IN ('approved', 'rejected') AND ${w.sql}`,
      [from, to, ...w.params],
    );
    return {
      opened: opened.rows[0].n,
      decided: decided.rows.length,
      approved: decided.rows.filter((r) => r.outcome === 'approved').length,
      days: decided.rows.map((r) => Number(r.days)),
    };
  }
}

import type { Pool, PoolClient } from 'pg';
import { scopeClause, type Scope } from '../../../shared/authz/scope';
import { recordAuditEntry } from '../../../shared/infrastructure/audit-log';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { Repository } from '../../../shared/infrastructure/repository';
import type { AlertSeverity, AlertStatus } from '../domain/alert';

/** How early an escalation may come: the scheduler's jitter, not a policy. */
export const ESCALATION_GRACE_SECONDS = 5;

/** An alert.alerts row: internal ids (other modules' too), Dates. */
export interface AlertRow {
  id: string;
  publicId: string;
  alertType: string;
  severity: AlertSeverity;
  status: AlertStatus;
  title: string;
  description: string | null;
  depotId: string | null;
  vehicleId: string | null;
  driverId: string | null;
  tripId: string | null;
  entityType: string | null;
  entityId: string | null;
  sourceModule: string;
  sourceEventType: string | null;
  occurrenceCount: number;
  lastOccurredAt: Date;
  escalationLevel: number;
  escalatedAt: Date | null;
  createdAt: Date;
  acknowledgedAt: Date | null;
  acknowledgedBy: string | null;
  resolvedAt: Date | null;
  resolvedBy: string | null;
}

const ROW_SQL = `
  SELECT a.id, a.public_id AS "publicId", a.alert_type AS "alertType", a.severity, a.status, a.title, a.description,
         a.depot_id AS "depotId", a.vehicle_id AS "vehicleId", a.driver_id AS "driverId", a.trip_id AS "tripId",
         a.entity_type AS "entityType", a.entity_id AS "entityId", a.source_module AS "sourceModule",
         a.source_event_type AS "sourceEventType", a.occurrence_count AS "occurrenceCount", a.last_occurred_at AS "lastOccurredAt",
         a.escalation_level AS "escalationLevel", a.escalated_at AS "escalatedAt", a.created_at AS "createdAt",
         a.acknowledged_at AS "acknowledgedAt", a.acknowledged_by AS "acknowledgedBy", a.resolved_at AS "resolvedAt",
         a.resolved_by AS "resolvedBy"
    FROM alert.alerts a`;

export interface AlertListFilter {
  scope: Scope;
  /** Internal id, already checked against the scope. */
  depotId?: string;
  vehicleId?: string;
  statuses?: readonly AlertStatus[];
  severities?: readonly AlertSeverity[];
  types?: readonly string[];
  /** Newest first, or the most severe first (then newest). */
  sort: 'newest' | 'priority';
  limit: number;
  offset: number;
}

/** A new alert's columns. */
export interface NewAlert {
  alert_type: string;
  severity: AlertSeverity;
  source_module: string;
  source_event_type: string;
  source_event_id: string;
  title: string;
  description: string;
  depot_id: string | null;
  vehicle_id: string | null;
  driver_id: string | null;
  trip_id: string | null;
  entity_type: string | null;
  entity_id: string | null;
  dedup_key: string;
  last_occurred_at: Date;
  details: Record<string, unknown>;
}

/**
 * alert.alerts, alert.alert_acknowledgements and alert.notifications (FMS-92). Alert writes go through
 * `mutate` (one audit row each); a notification batch is one statement and one audit entry.
 */
export class AlertRepository extends Repository {
  constructor(db: Pool) {
    super(db);
  }

  inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.transaction(fn);
  }

  /**
   * Serialises the work on one source across transactions and instances: a repeat that arrives while the
   * first is still being written waits, then finds its alert. Released at commit.
   */
  async lockSource(client: PoolClient, dedupKey: string): Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 92))', [`alert:${dedupKey}`]);
  }

  /** The source's active alert last seen at or after `since`, row-locked. */
  async findActiveByDedup(client: PoolClient, dedupKey: string, since: Date): Promise<AlertRow | null> {
    const res = await client.query<AlertRow>(
      `${ROW_SQL}
        WHERE a.dedup_key = $1 AND a.status IN ('open', 'acknowledged') AND a.last_occurred_at >= $2
        ORDER BY a.last_occurred_at DESC, a.id DESC
        LIMIT 1
        FOR UPDATE`,
      [dedupKey, since],
    );
    return res.rows[0] ?? null;
  }

  async findById(db: Queryable, id: string): Promise<AlertRow | null> {
    const res = await db.query<AlertRow>(`${ROW_SQL} WHERE a.id = $1`, [id]);
    return res.rows[0] ?? null;
  }

  /** An alert in the caller's scope (a depot's, or the fleet's for someone who sees every depot); `lock` row-locks it. */
  async findInScope(db: Queryable, publicId: string, scope: Scope, lock = false): Promise<AlertRow | null> {
    const clause = scopeClause(scope, 'a.depot_id', 2);
    const res = await db.query<AlertRow>(`${ROW_SQL} WHERE a.public_id = $1 AND ${clause.sql}${lock ? ' FOR UPDATE' : ''}`, [publicId, ...clause.params]);
    return res.rows[0] ?? null;
  }

  async list(db: Queryable, f: AlertListFilter): Promise<{ rows: AlertRow[]; total: number }> {
    const params: unknown[] = [];
    const add = (value: unknown) => `$${params.push(value)}`;
    const where: string[] = [];
    const clause = scopeClause(f.scope, 'a.depot_id', 1);
    params.push(...clause.params);
    where.push(clause.sql);
    if (f.depotId) where.push(`a.depot_id = ${add(f.depotId)}::bigint`);
    if (f.vehicleId) where.push(`a.vehicle_id = ${add(f.vehicleId)}::bigint`);
    if (f.statuses?.length) where.push(`a.status = ANY(${add(f.statuses)}::alert.alert_status[])`);
    if (f.severities?.length) where.push(`a.severity = ANY(${add(f.severities)}::alert.alert_severity[])`);
    if (f.types?.length) where.push(`a.alert_type = ANY(${add(f.types)}::text[])`);
    const order = f.sort === 'priority' ? 'a.severity DESC, a.created_at DESC, a.id DESC' : 'a.created_at DESC, a.id DESC';
    const condition = where.join(' AND ');
    const [rows, count] = [
      await db.query<AlertRow>(`${ROW_SQL} WHERE ${condition} ORDER BY ${order} LIMIT ${add(f.limit)} OFFSET ${add(f.offset)}`, params),
      await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM alert.alerts a WHERE ${condition}`, params.slice(0, params.length - 2)),
    ];
    return { rows: rows.rows, total: count.rows[0].n };
  }

  /**
   * Critical alerts nobody has acknowledged whose last escalation (or creation) is at least `minutes` old
   * and that have a tier left, row-locked. SKIP LOCKED: an alert being acknowledged right now is left to that.
   * A few seconds of grace: the job runs on the minute, a few milliseconds late each time, and without it an
   * escalation stamped at 09:15:00.004 would not be due at 09:16:00.002 but a whole run later.
   */
  async dueForEscalation(client: PoolClient, now: Date, minutes: number, maxLevel: number, limit = 100): Promise<AlertRow[]> {
    const res = await client.query<AlertRow>(
      `${ROW_SQL}
        WHERE a.status = 'open' AND a.severity = 'critical' AND a.escalation_level < $3
          AND COALESCE(a.escalated_at, a.created_at) <= $1::timestamptz - make_interval(mins => $2) + make_interval(secs => ${ESCALATION_GRACE_SECONDS})
        ORDER BY a.created_at, a.id
        LIMIT $4
        FOR UPDATE SKIP LOCKED`,
      [now, minutes, maxLevel, limit],
    );
    return res.rows;
  }

  async insert(client: PoolClient, ctx: MutationContext, alert: NewAlert): Promise<AlertRow> {
    const row = await this.mutate(ctx, 'alert.alerts', 'INSERT', null, { ...alert, details: JSON.stringify(alert.details) }, client);
    return (await this.findById(client, row.id as string))!;
  }

  async update(client: PoolClient, ctx: MutationContext, id: string, data: Record<string, unknown>): Promise<AlertRow> {
    await this.mutate(ctx, 'alert.alerts', 'UPDATE', id, data, client);
    return (await this.findById(client, id))!;
  }

  /** One line of an alert's history: who acknowledged or resolved it, when, and why. */
  async recordAction(client: PoolClient, ctx: MutationContext, alertId: string, userId: string, action: 'acknowledge' | 'resolve', comment: string | null): Promise<void> {
    await this.mutate(ctx, 'alert.alert_acknowledgements', 'INSERT', null, { alert_id: alertId, user_id: userId, action, comment }, client);
  }

  /** Of these users, the ones already told about this alert. */
  async notified(db: Queryable, alertId: string): Promise<Set<string>> {
    const res = await db.query<{ userId: string }>('SELECT DISTINCT recipient_user_id AS "userId" FROM alert.notifications WHERE alert_id = $1', [alertId]);
    return new Set(res.rows.map((r) => r.userId));
  }

  /**
   * In-app notifications (the inbox, S-17), one per recipient, delivered as they are written. One statement
   * and one audit entry for the batch (`alert.notified`, with the count), not a row each.
   */
  async notify(
    client: PoolClient,
    ctx: MutationContext,
    alertId: string,
    recipients: readonly string[],
    content: { type: string; title: string; message: string },
  ): Promise<number> {
    if (recipients.length === 0) return 0;
    const res = await client.query(
      `INSERT INTO alert.notifications
              (alert_id, recipient_user_id, notification_type, title, message, channel, status, sent_at, delivered_at)
       SELECT $1, r, $3, $4, $5, 'in_app', 'delivered', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
         FROM unnest($2::bigint[]) AS r`,
      [alertId, recipients, content.type, content.title, content.message],
    );
    await recordAuditEntry(client, {
      action: 'alert.notified',
      userId: ctx.userId,
      entityType: 'alert.alerts',
      entityId: alertId,
      correlationId: ctx.correlationId,
      details: { channel: 'in_app', recipients: res.rowCount ?? recipients.length, notification_type: content.type },
    });
    return res.rowCount ?? recipients.length;
  }
}

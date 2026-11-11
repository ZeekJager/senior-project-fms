import type { PoolClient } from 'pg';
import { auditedMutation, type MutationContext } from '../../../shared/infrastructure/audited-mutation';
import { recordAuditEntry } from '../../../shared/infrastructure/audit-log';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { DelayMargins } from '../../trip';
import { DEFAULT_THRESHOLD_SET, type ThresholdSet } from '../application/rule-threshold.service';

/** A row of tracking.rule_thresholds: the fleet's (depotId null) or a depot's. Internal ids. */
export interface ThresholdRow extends ThresholdSet {
  id: string;
  depotId: string | null;
  updatedBy: string | null;
  updatedAt: Date;
}

const COLUMNS = `id, depot_id AS "depotId", speed_limit_kmh AS "speedLimitKmh", speeding_pings AS "speedingPings",
       clear_pings AS "clearPings", idle_minutes AS "idleMinutes", route_deviation_m AS "routeDeviationM",
       route_deviation_pings AS "routeDeviationPings", trip_delay_minutes AS "tripDelayMinutes",
       trip_delay_urgent_minutes AS "tripDelayUrgentMinutes", updated_by AS "updatedBy", updated_at AS "updatedAt"`;

const TABLE = 'tracking.rule_thresholds';

const columnsOf = (t: ThresholdSet) => ({
  speed_limit_kmh: t.speedLimitKmh,
  speeding_pings: t.speedingPings,
  clear_pings: t.clearPings,
  idle_minutes: t.idleMinutes,
  route_deviation_m: t.routeDeviationM,
  route_deviation_pings: t.routeDeviationPings,
  trip_delay_minutes: t.tripDelayMinutes,
  trip_delay_urgent_minutes: t.tripDelayUrgentMinutes,
});

/** Changes to tracking.rule_thresholds from the settings screen (FMS-80), each audited. */
export class RuleThresholdRepository {
  /** The fleet's row first, then the depots' that differ. */
  async all(db: Queryable): Promise<ThresholdRow[]> {
    const res = await db.query<ThresholdRow>(`SELECT ${COLUMNS} FROM tracking.rule_thresholds ORDER BY depot_id NULLS FIRST, id`);
    return res.rows;
  }

  /** The trip delay margins (FMS-147) of a depot (internal id): its own row's, else the fleet's. */
  async delayMargins(db: Queryable, depotId: string | null): Promise<DelayMargins> {
    const res = await db.query<DelayMargins>(
      `SELECT trip_delay_minutes AS "lateMinutes", trip_delay_urgent_minutes AS "urgentMinutes"
         FROM tracking.rule_thresholds
        WHERE depot_id = $1 OR depot_id IS NULL
        ORDER BY depot_id NULLS LAST
        LIMIT 1`,
      [depotId],
    );
    return res.rows[0] ?? { lateMinutes: DEFAULT_THRESHOLD_SET.tripDelayMinutes, urgentMinutes: DEFAULT_THRESHOLD_SET.tripDelayUrgentMinutes };
  }

  /** The fleet's row (depotId null) or a depot's, if it has one. Changes queue behind each other, so two cannot both insert a depot's row. */
  async lock(client: PoolClient, depotId: string | null): Promise<ThresholdRow | null> {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('tracking.rule_thresholds'))`);
    const res = await client.query<ThresholdRow>(`SELECT ${COLUMNS} FROM tracking.rule_thresholds WHERE depot_id IS NOT DISTINCT FROM $1`, [depotId]);
    return res.rows[0] ?? null;
  }

  async insert(client: PoolClient, ctx: MutationContext, depotId: string | null, t: ThresholdSet): Promise<void> {
    await auditedMutation(client, ctx, TABLE, 'INSERT', null, { depot_id: depotId, ...columnsOf(t), updated_by: ctx.userId });
  }

  async update(client: PoolClient, ctx: MutationContext, id: string, t: ThresholdSet): Promise<void> {
    await auditedMutation(client, ctx, TABLE, 'UPDATE', id, { ...columnsOf(t), updated_by: ctx.userId });
  }

  /** A depot's row goes: the depot follows the fleet's again. The table has no is_active, so the row is deleted and the audit keeps it. */
  async remove(client: PoolClient, ctx: MutationContext, row: ThresholdRow): Promise<void> {
    const res = await client.query(`DELETE FROM tracking.rule_thresholds WHERE id = $1 AND depot_id IS NOT NULL RETURNING *`, [row.id]);
    if (!res.rows[0]) return;
    await recordAuditEntry(client, {
      action: 'DELETE',
      userId: ctx.userId,
      entityType: TABLE,
      entityId: row.id,
      correlationId: ctx.correlationId,
      oldValues: res.rows[0] as Record<string, unknown>,
      newValues: null,
    });
  }
}

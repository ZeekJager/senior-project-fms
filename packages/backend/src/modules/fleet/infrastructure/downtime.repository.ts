import type { Pool, PoolClient } from 'pg';
import { limitOffset, type Page } from '../../../shared/http/pagination';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { Repository } from '../../../shared/infrastructure/repository';
import type { DerivedPeriod, DowntimeReason, StatusChange } from '../domain/downtime';
import type { VehicleStatus } from '../domain/vehicle';

/** A vehicle as the periods are derived for it. `id` is internal. */
export interface DowntimeVehicle {
  id: string;
  publicId: string;
  registeredAt: Date;
  status: VehicleStatus;
}

/** A stored period. `id` is internal; `reasonSetBy` an internal user id. */
export interface PeriodRow {
  id: string;
  publicId: string;
  vehiclePublicId: string;
  openedBy: string;
  startedAt: Date;
  endedAt: Date | null;
  reason: DowntimeReason;
  derivedReason: DowntimeReason;
  reasonNote: string | null;
  reasonSetBy: string | null;
  reasonSetAt: Date | null;
  maintenanceRecordId: string | null;
  failureEventId: string | null;
}

/** What one vehicle's re-derivation changed: periods added, corrected and removed. */
export interface DowntimeSync {
  added: number;
  repaired: number;
  removed: number;
}

const VEHICLE_SQL = `SELECT id, public_id AS "publicId", created_at AS "registeredAt", status::text AS status FROM fleet.vehicles`;

const PERIOD_SQL = `
  SELECT p.id, p.public_id AS "publicId", v.public_id AS "vehiclePublicId", p.opened_by AS "openedBy",
         p.started_at AS "startedAt", p.ended_at AS "endedAt", p.reason::text AS reason, p.derived_reason::text AS "derivedReason",
         p.reason_note AS "reasonNote", p.reason_set_by AS "reasonSetBy", p.reason_set_at AS "reasonSetAt",
         p.maintenance_record_id AS "maintenanceRecordId", p.failure_event_id AS "failureEventId"
    FROM fleet.downtime_periods p
    JOIN fleet.vehicles v ON v.id = p.vehicle_id`;

/**
 * fleet.downtime_periods (FMS-131): a read model of each vehicle's downtime, re-derived from its status history
 * and breakdowns. Those writes are not audited (derived data); a staff member's reason is.
 */
export class DowntimeRepository extends Repository {
  constructor(db: Pool) {
    super(db);
  }

  inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.transaction(fn);
  }

  /** Serializes re-deriving one vehicle's periods until the transaction ends: the second sees the first's rows. */
  async lock(db: Queryable, vehicleId: string): Promise<void> {
    await db.query(`SELECT pg_advisory_xact_lock(hashtext('fleet.downtime'), $1::bigint::int)`, [vehicleId]);
  }

  async vehicleByPublicId(db: Queryable, publicId: string): Promise<DowntimeVehicle | null> {
    const res = await db.query<DowntimeVehicle>(`${VEHICLE_SQL} WHERE public_id = $1`, [publicId]);
    return res.rows[0] ?? null;
  }

  /** The next `limit` vehicles after `afterId`, by id: the rebuild's batches. */
  async vehiclesAfter(db: Queryable, afterId: string, limit: number): Promise<DowntimeVehicle[]> {
    const res = await db.query<DowntimeVehicle>(`${VEHICLE_SQL} WHERE id > $1 ORDER BY id LIMIT $2`, [afterId, limit]);
    return res.rows;
  }

  /** Each vehicle's status changes, in the order they happened. */
  async history(db: Queryable, vehicleIds: readonly string[]): Promise<Map<string, StatusChange[]>> {
    const res = await db.query<StatusChange & { vehicleId: string }>(
      `SELECT vehicle_id AS "vehicleId", public_id AS id, from_status::text AS "from", to_status::text AS "to",
              changed_at AS "changedAt", maintenance_record_id AS "maintenanceRecordId"
         FROM fleet.vehicle_status_history
        WHERE vehicle_id = ANY($1::bigint[])
        ORDER BY vehicle_id, changed_at, id`,
      [vehicleIds],
    );
    const byVehicle = new Map<string, StatusChange[]>(vehicleIds.map((id) => [id, []]));
    for (const { vehicleId, ...change } of res.rows) byVehicle.get(vehicleId)!.push(change);
    return byVehicle;
  }

  /**
   * Makes the vehicle's stored periods these: removes the ones no longer derived, then adds or corrects the rest,
   * oldest first (so the one still open is written last). A staff member's reason and note are kept.
   */
  async replace(client: Queryable, vehicleId: string, periods: readonly DerivedPeriod[]): Promise<DowntimeSync> {
    const removed = await client.query(`DELETE FROM fleet.downtime_periods WHERE vehicle_id = $1 AND NOT (opened_by = ANY($2::text[]))`, [
      vehicleId,
      periods.map((p) => p.openedBy),
    ]);
    if (periods.length === 0) return { added: 0, repaired: 0, removed: removed.rowCount ?? 0 };
    const res = await client.query<{ inserted: boolean }>(
      `INSERT INTO fleet.downtime_periods (vehicle_id, opened_by, started_at, ended_at, derived_reason, maintenance_record_id, failure_event_id)
       SELECT $1, u.opened_by, u.started_at, u.ended_at, u.derived_reason, u.maintenance_record_id, u.failure_event_id
         FROM unnest($2::text[], $3::timestamptz[], $4::timestamptz[], $5::fleet.downtime_reason[], $6::uuid[], $7::uuid[])
              WITH ORDINALITY AS u(opened_by, started_at, ended_at, derived_reason, maintenance_record_id, failure_event_id, n)
        ORDER BY u.n
       ON CONFLICT (vehicle_id, opened_by) DO UPDATE
          SET started_at = EXCLUDED.started_at, ended_at = EXCLUDED.ended_at, derived_reason = EXCLUDED.derived_reason,
              maintenance_record_id = EXCLUDED.maintenance_record_id, failure_event_id = EXCLUDED.failure_event_id,
              synced_at = clock_timestamp()
        WHERE (downtime_periods.started_at, downtime_periods.ended_at, downtime_periods.derived_reason,
               downtime_periods.maintenance_record_id, downtime_periods.failure_event_id)
              IS DISTINCT FROM
              (EXCLUDED.started_at, EXCLUDED.ended_at, EXCLUDED.derived_reason, EXCLUDED.maintenance_record_id, EXCLUDED.failure_event_id)
       RETURNING (xmax = 0) AS inserted`,
      [
        vehicleId,
        periods.map((p) => p.openedBy),
        periods.map((p) => p.startedAt),
        periods.map((p) => p.endedAt),
        periods.map((p) => p.reason),
        periods.map((p) => p.maintenanceRecordId),
        periods.map((p) => p.failureEventId),
      ],
    );
    const added = res.rows.filter((r) => r.inserted).length;
    return { added, repaired: res.rows.length - added, removed: removed.rowCount ?? 0 };
  }

  /** A vehicle's periods, newest first. */
  async list(db: Queryable, vehicleId: string, page: Page): Promise<{ items: PeriodRow[]; total: number }> {
    const { limit, offset } = limitOffset(page);
    const rows = await db.query<PeriodRow>(`${PERIOD_SQL} WHERE p.vehicle_id = $1 ORDER BY p.started_at DESC, p.id DESC LIMIT $2 OFFSET $3`, [
      vehicleId,
      limit,
      offset,
    ]);
    const total = await db.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM fleet.downtime_periods WHERE vehicle_id = $1', [vehicleId]);
    return { items: rows.rows, total: total.rows[0].n };
  }

  async find(db: Queryable, vehicleId: string, periodPublicId: string): Promise<PeriodRow | null> {
    const res = await db.query<PeriodRow>(`${PERIOD_SQL} WHERE p.vehicle_id = $1 AND p.public_id = $2`, [vehicleId, periodPublicId]);
    return res.rows[0] ?? null;
  }

  /** A staff member's reason and note (audited), or none: the derived reason again. */
  async setReason(
    client: PoolClient,
    ctx: MutationContext,
    periodId: string,
    change: { reason: DowntimeReason | null; note: string | null; setBy: string | null },
  ): Promise<void> {
    await this.mutate(
      ctx,
      'fleet.downtime_periods',
      'UPDATE',
      periodId,
      change.reason === null
        ? { reason_override: null, reason_note: null, reason_set_by: null, reason_set_at: null }
        : { reason_override: change.reason, reason_note: change.note, reason_set_by: change.setBy, reason_set_at: new Date() },
      client,
    );
  }
}

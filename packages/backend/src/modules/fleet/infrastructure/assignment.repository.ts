import type { Pool, PoolClient } from 'pg';
import { scopeClause, type Scope } from '../../../shared/authz/scope';
import { limitOffset, type Page } from '../../../shared/http/pagination';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { Repository } from '../../../shared/infrastructure/repository';
import type { AssignmentStatus, AssignmentType, AssignmentView } from '../domain/assignment';

export interface AssignmentRow {
  id: string;
  publicId: string;
  driverId: string;
  vehicleId: string;
  assignmentType: AssignmentType;
  assignedFrom: Date;
  assignedUntil: Date | null;
  status: AssignmentStatus;
}

export interface NewAssignment {
  driverId: string;
  vehicleId: string;
  assignmentType: AssignmentType;
  assignedFrom: Date;
  assignedUntil: Date | null;
  notes: string | null;
}

// The assignment's depot is its vehicle's: depot scope is the vehicle's, as for its trips.
const VIEW_SQL = `
  SELECT a.public_id AS id,
         json_build_object('id', d.public_id, 'full_name', acc.full_name) AS driver,
         json_build_object('id', v.public_id, 'registration_number', v.registration_number) AS vehicle,
         dep.public_id AS depot_id,
         a.assignment_type, a.assigned_from AS start_at, a.assigned_until AS end_at, a.status,
         -- clock_timestamp(): now, not the transaction's start (an assignment just written in it starts after that).
         (a.status = 'active' AND a.assigned_from <= clock_timestamp()
            AND (a.assigned_until IS NULL OR a.assigned_until > clock_timestamp())) AS current,
         a.notes, a.created_at
    FROM fleet.driver_vehicle_assignments a
    JOIN fleet.drivers d ON d.id = a.driver_id
    LEFT JOIN fleet.driver_accounts acc ON acc.user_id = d.user_id
    JOIN fleet.vehicles v ON v.id = a.vehicle_id
    JOIN fleet.depots dep ON dep.id = v.depot_id`;

const ROW_SQL = `
  SELECT a.id, a.public_id AS "publicId", a.driver_id AS "driverId", a.vehicle_id AS "vehicleId",
         a.assignment_type AS "assignmentType", a.assigned_from AS "assignedFrom", a.assigned_until AS "assignedUntil", a.status
    FROM fleet.driver_vehicle_assignments a
    JOIN fleet.vehicles v ON v.id = a.vehicle_id`;

/** fleet.driver_vehicle_assignments (FMS-77): a driver's regular vehicle. Every write is audited. */
export class AssignmentRepository extends Repository {
  constructor(db: Pool) {
    super(db);
  }

  inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.transaction(fn);
  }

  async insert(client: PoolClient, ctx: MutationContext, a: NewAssignment): Promise<string> {
    const row = await this.mutate(
      ctx,
      'fleet.driver_vehicle_assignments',
      'INSERT',
      null,
      {
        driver_id: a.driverId,
        vehicle_id: a.vehicleId,
        assignment_type: a.assignmentType,
        assigned_from: a.assignedFrom,
        assigned_until: a.assignedUntil,
        status: 'active',
        notes: a.notes,
      },
      client,
    );
    return row.public_id as string;
  }

  /** Sets its end and status in one audited change. */
  async end(client: PoolClient, ctx: MutationContext, id: string, endAt: Date, notes: string | undefined): Promise<void> {
    await this.mutate(ctx, 'fleet.driver_vehicle_assignments', 'UPDATE', id, { assigned_until: endAt, status: 'ended', ...(notes !== undefined ? { notes } : {}) }, client);
  }

  /** An assignment in the caller's scope, row-locked for a write. */
  async lockForWrite(client: PoolClient, publicId: string, scope: Scope): Promise<AssignmentRow | null> {
    const clause = scopeClause(scope, 'v.depot_id', 2);
    const res = await client.query<AssignmentRow>(`${ROW_SQL} WHERE a.public_id = $1 AND ${clause.sql} FOR UPDATE OF a`, [publicId, ...clause.params]);
    return res.rows[0] ?? null;
  }

  /**
   * The active primary assignment of the driver (`by: 'driver'`) or of the vehicle whose period meets [from, until), if
   * any: an open end is for ever. `exclude` leaves one out.
   */
  async overlappingPrimary(db: Queryable, by: 'driver' | 'vehicle', id: string, from: Date, until: Date | null): Promise<string | null> {
    const column = by === 'driver' ? 'a.driver_id' : 'a.vehicle_id';
    const res = await db.query<{ publicId: string }>(
      `SELECT a.public_id AS "publicId" FROM fleet.driver_vehicle_assignments a
        WHERE ${column} = $1 AND a.status = 'active' AND a.assignment_type = 'primary'
          AND (a.assigned_until IS NULL OR a.assigned_until > $2)
          AND ($3::timestamptz IS NULL OR a.assigned_from < $3)
        ORDER BY a.assigned_from LIMIT 1`,
      [id, from, until],
    );
    return res.rows[0]?.publicId ?? null;
  }

  /** A driver in the caller's depots (their account's home depot), row-locked: two assignments for them are decided in turn. */
  async lockDriver(client: PoolClient, publicId: string, scope: Scope): Promise<{ id: string; isActive: boolean; depotId: string | null } | null> {
    const clause = scopeClause(scope, 'acc.depot_id', 2);
    const res = await client.query<{ id: string; isActive: boolean; depotId: string | null }>(
      `SELECT d.id, d.is_active AS "isActive", acc.depot_id AS "depotId"
         FROM fleet.drivers d JOIN fleet.driver_accounts acc ON acc.user_id = d.user_id
        WHERE d.public_id = $1 AND ${clause.sql} FOR UPDATE OF d`,
      [publicId, ...clause.params],
    );
    return res.rows[0] ?? null;
  }

  async view(db: Queryable, publicId: string, scope: Scope): Promise<AssignmentView | null> {
    const clause = scopeClause(scope, 'v.depot_id', 2);
    const res = await db.query<AssignmentView>(`${VIEW_SQL} WHERE a.public_id = $1 AND ${clause.sql}`, [publicId, ...clause.params]);
    return res.rows[0] ?? null;
  }

  /** A driver's or a vehicle's assignments (internal id), the newest start first: the current one, then the history. */
  async history(db: Queryable, by: 'driver' | 'vehicle', id: string, page: Page): Promise<{ items: AssignmentView[]; total: number }> {
    const column = by === 'driver' ? 'a.driver_id' : 'a.vehicle_id';
    const { limit, offset } = limitOffset(page);
    // One after the other: on a transaction's client, queries run in turn anyway.
    const rows = await db.query<AssignmentView>(`${VIEW_SQL} WHERE ${column} = $1 ORDER BY a.assigned_from DESC, a.id DESC LIMIT $2 OFFSET $3`, [id, limit, offset]);
    const count = await db.query<{ total: number }>(`SELECT count(*)::int AS total FROM fleet.driver_vehicle_assignments a WHERE ${column} = $1`, [id]);
    return { items: rows.rows, total: count.rows[0].total };
  }
}

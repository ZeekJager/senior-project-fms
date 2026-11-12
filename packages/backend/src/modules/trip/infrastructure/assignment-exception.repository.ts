import type { Pool, PoolClient } from 'pg';
import type { MutationContext, Row } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { Repository } from '../../../shared/infrastructure/repository';
import type { ExceptionStatus } from '../domain/exception';
import type { AssignmentWarning } from '../domain/trip';

/** A trip.assignment_exceptions row (FMS-151). Internal ids, with the trip's public id. */
export interface ExceptionRow {
  id: string;
  publicId: string;
  tripId: string;
  tripPublicId: string;
  driverId: string;
  vehicleId: string;
  warnings: AssignmentWarning[];
  reason: string;
  status: ExceptionStatus;
  requestedBy: string | null;
  requestedAt: Date;
  decidedBy: string | null;
  decidedAt: Date | null;
  decisionReason: string | null;
}

export interface ExceptionWrite {
  trip_id?: string;
  driver_id?: string;
  vehicle_id?: string;
  /** JSON text of the warnings. */
  warnings?: string;
  reason?: string;
  status?: ExceptionStatus;
  requested_by?: string | number | null;
  decided_by?: string | number | null;
  decided_at?: Date;
  decision_reason?: string | null;
}

const TABLE = 'trip.assignment_exceptions';

const ROW_SQL = `
  SELECT e.id, e.public_id AS "publicId", e.trip_id AS "tripId", t.public_id AS "tripPublicId", e.driver_id AS "driverId",
         e.vehicle_id AS "vehicleId", e.warnings, e.reason, e.status, e.requested_by AS "requestedBy",
         e.requested_at AS "requestedAt", e.decided_by AS "decidedBy", e.decided_at AS "decidedAt",
         e.decision_reason AS "decisionReason"
    FROM trip.assignment_exceptions e
    JOIN trip.trips t ON t.id = e.trip_id`;

/** Assignments held for a fleet manager's approval (FMS-151, docs/assignment-exceptions.md). Every change audited. */
export class AssignmentExceptionRepository extends Repository {
  constructor(db: Pool) {
    super(db);
  }

  /** Each trip's newest request, whatever became of it. */
  async latestByTrips(db: Queryable, tripIds: readonly string[]): Promise<ExceptionRow[]> {
    if (tripIds.length === 0) return [];
    const res = await db.query<ExceptionRow>(
      `${ROW_SQL.replace('SELECT', 'SELECT DISTINCT ON (e.trip_id)')}
        WHERE e.trip_id = ANY($1::bigint[])
        ORDER BY e.trip_id, e.requested_at DESC, e.id DESC`,
      [tripIds],
    );
    return res.rows;
  }

  /** A request by its public id, unlocked: which trip to lock first. */
  async find(db: Queryable, publicId: string): Promise<ExceptionRow | null> {
    const res = await db.query<ExceptionRow>(`${ROW_SQL} WHERE e.public_id = $1`, [publicId]);
    return res.rows[0] ?? null;
  }

  /** The request locked, once its trip is (the trip first, as an assignment locks them). */
  async lock(client: PoolClient, id: string): Promise<ExceptionRow> {
    const res = await client.query<ExceptionRow>(`${ROW_SQL} WHERE e.id = $1 FOR UPDATE OF e`, [id]);
    return res.rows[0];
  }

  /** The trip's request still waiting, locked; at most one (uq_assignment_exception_pending). */
  async pendingOf(client: PoolClient, tripId: string): Promise<ExceptionRow | null> {
    const res = await client.query<ExceptionRow>(`${ROW_SQL} WHERE e.trip_id = $1 AND e.status = 'pending' FOR UPDATE OF e`, [tripId]);
    return res.rows[0] ?? null;
  }

  insert(ctx: MutationContext, data: ExceptionWrite, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, TABLE, 'INSERT', null, { ...data }, client);
  }

  update(ctx: MutationContext, id: string, data: ExceptionWrite, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, TABLE, 'UPDATE', id, { ...data }, client);
  }
}

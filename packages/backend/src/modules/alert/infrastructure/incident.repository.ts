import type { Pool, PoolClient } from 'pg';
import { scopeClause, type Scope } from '../../../shared/authz/scope';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { Repository } from '../../../shared/infrastructure/repository';
import type { AlertSeverity } from '../domain/alert';
import { ACTIVE_INCIDENT_STATUSES, type IncidentStatus } from '../domain/incident';

/**
 * Which incidents a caller sees (FMS-38): a driver, the ones they reported (`own`, the user's id);
 * staff, their depots' (`all`, `depot`); an incident no depot owns only by those who see every depot.
 */
export type IncidentVisibility = Scope;

/** An alert.incident_reports row: internal ids (other modules' too), Dates. Coordinates as float8. */
export interface IncidentRow {
  id: string;
  publicId: string;
  incidentType: string;
  severity: AlertSeverity;
  status: IncidentStatus;
  description: string;
  vehicleId: string | null;
  driverId: string | null;
  tripId: string | null;
  depotId: string | null;
  reportedBy: string;
  latitude: number | null;
  longitude: number | null;
  occurredAt: Date;
  createdAt: Date;
  /** The user dealing with it (FMS-89). */
  assignedTo: string | null;
  notes: string | null;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  updatedAt: Date;
}

/** What a PATCH changes (FMS-89): columns of alert.incident_reports, internal ids. */
export interface IncidentChanges {
  status?: IncidentStatus;
  assigned_to?: string | null;
  notes?: string | null;
  resolved_at?: Date | null;
  resolved_by?: string | null;
}

export interface NewIncident {
  incident_type: string;
  severity: AlertSeverity;
  description: string;
  vehicle_id: string | null;
  driver_id: string | null;
  trip_id: string | null;
  depot_id: string | null;
  reported_by: string;
  latitude: number | null;
  longitude: number | null;
  occurred_at: Date;
}

export interface IncidentFilter {
  visibility: IncidentVisibility;
  vehicleId?: string;
  statuses?: readonly IncidentStatus[];
  severities?: readonly AlertSeverity[];
  types?: readonly string[];
  /** Incidents that happened at or after `from`, and before `to`. */
  from?: Date;
  to?: Date;
  limit: number;
  offset: number;
}

const ROW_SQL = `
  SELECT i.id, i.public_id AS "publicId", i.incident_type AS "incidentType", i.severity, i.status, i.description,
         i.vehicle_id AS "vehicleId", i.driver_id AS "driverId", i.trip_id AS "tripId", i.depot_id AS "depotId",
         i.reported_by AS "reportedBy", i.latitude::float8 AS latitude, i.longitude::float8 AS longitude,
         i.occurred_at AS "occurredAt", i.created_at AS "createdAt", i.assigned_to AS "assignedTo", i.notes,
         i.resolved_at AS "resolvedAt", i.resolved_by AS "resolvedBy", i.updated_at AS "updatedAt"
    FROM alert.incident_reports i`;

/** A driver's own by reporter; anyone else's by depot. */
const visibilityClause = (v: IncidentVisibility, nextParam: number) => scopeClause(v, v.kind === 'own' ? 'i.reported_by' : 'i.depot_id', nextParam);

/** alert.incident_reports (FMS-38). Writes go through `mutate`: one audit row each. */
export class IncidentRepository extends Repository {
  constructor(db: Pool) {
    super(db);
  }

  inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.transaction(fn);
  }

  /** Serialises one reporter's submissions, so a late replay and its original are never both written. Released at commit. */
  async lockReporter(client: PoolClient, userId: string): Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 38))', [`incident:${userId}`]);
  }

  /**
   * The same report already on file: this reporter, this moment, these words. An offline submission that
   * reached the server, lost its answer and came back after the Idempotency-Key expired (24 h).
   */
  async findReplay(db: Queryable, reportedBy: string, occurredAt: Date, description: string): Promise<IncidentRow | null> {
    const res = await db.query<IncidentRow>(`${ROW_SQL} WHERE i.reported_by = $1 AND i.occurred_at = $2 AND i.description = $3 ORDER BY i.id LIMIT 1`, [
      reportedBy,
      occurredAt,
      description,
    ]);
    return res.rows[0] ?? null;
  }

  async findById(db: Queryable, id: string): Promise<IncidentRow> {
    const res = await db.query<IncidentRow>(`${ROW_SQL} WHERE i.id = $1`, [id]);
    return res.rows[0];
  }

  /** An incident by public id if the caller may see it; anyone else's is simply not found. */
  async findVisible(db: Queryable, publicId: string, visibility: IncidentVisibility): Promise<IncidentRow | null> {
    const clause = visibilityClause(visibility, 2);
    const res = await db.query<IncidentRow>(`${ROW_SQL} WHERE i.public_id = $1 AND ${clause.sql}`, [publicId, ...clause.params]);
    return res.rows[0] ?? null;
  }

  /** As findVisible, row-locked for a change (FMS-89): two consoles saving at once are applied one after the other. */
  async lockVisible(client: PoolClient, publicId: string, visibility: IncidentVisibility): Promise<IncidentRow | null> {
    const clause = visibilityClause(visibility, 2);
    const res = await client.query<IncidentRow>(`${ROW_SQL} WHERE i.public_id = $1 AND ${clause.sql} FOR UPDATE OF i`, [publicId, ...clause.params]);
    return res.rows[0] ?? null;
  }

  /**
   * The incidents still being dealt with (open, investigating) of one depot (internal id), or of every depot
   * (null, those no depot owns included): the most severe first, then the newest. For the command center (FMS-89).
   */
  async active(db: Queryable, depotId: string | null, limit: number): Promise<IncidentRow[]> {
    const res = await db.query<IncidentRow>(
      `${ROW_SQL} WHERE i.status = ANY($1::text[]) AND ($2::bigint IS NULL OR i.depot_id = $2)
        ORDER BY i.severity DESC, i.occurred_at DESC, i.id DESC LIMIT $3`,
      [ACTIVE_INCIDENT_STATUSES, depotId, limit],
    );
    return res.rows;
  }

  /** How many active incidents of one depot (or every depot) there are, by status and severity. */
  async activeCounts(db: Queryable, depotId: string | null): Promise<{ status: IncidentStatus; severity: AlertSeverity; n: number }[]> {
    const res = await db.query<{ status: IncidentStatus; severity: AlertSeverity; n: number }>(
      `SELECT i.status, i.severity::text AS severity, count(*)::int AS n FROM alert.incident_reports i
        WHERE i.status = ANY($1::text[]) AND ($2::bigint IS NULL OR i.depot_id = $2)
        GROUP BY i.status, i.severity`,
      [ACTIVE_INCIDENT_STATUSES, depotId],
    );
    return res.rows;
  }

  /** An incident by public id, whoever may see it, with its vehicle: for a failure it reported (FMS-125). */
  async refByPublicId(db: Queryable, publicId: string): Promise<{ id: string; vehicleId: string | null } | null> {
    const res = await db.query<{ id: string; vehicleId: string | null }>(
      'SELECT id, vehicle_id AS "vehicleId" FROM alert.incident_reports WHERE public_id = $1',
      [publicId],
    );
    return res.rows[0] ?? null;
  }

  async publicIds(db: Queryable, ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const res = await db.query<{ id: string; public_id: string }>('SELECT id, public_id FROM alert.incident_reports WHERE id = ANY($1::bigint[])', [ids]);
    return new Map(res.rows.map((r) => [r.id, r.public_id]));
  }

  /** Each vehicle's incidents of these types that occurred in [from, to). Vehicles with none are absent. */
  async countsByVehicle(db: Queryable, vehicleIds: readonly string[], types: readonly string[], from: Date, to: Date): Promise<Map<string, number>> {
    if (vehicleIds.length === 0) return new Map();
    const res = await db.query<{ vehicleId: string; count: number }>(
      `SELECT vehicle_id AS "vehicleId", count(*)::int AS count FROM alert.incident_reports
        WHERE vehicle_id = ANY($1::bigint[]) AND incident_type = ANY($2::text[]) AND occurred_at >= $3 AND occurred_at < $4
        GROUP BY vehicle_id`,
      [vehicleIds, types, from, to],
    );
    return new Map(res.rows.map((r) => [r.vehicleId, r.count]));
  }

  /** Newest first (when it happened). */
  async list(db: Queryable, f: IncidentFilter): Promise<{ rows: IncidentRow[]; total: number }> {
    const params: unknown[] = [];
    const add = (value: unknown) => `$${params.push(value)}`;
    const clause = visibilityClause(f.visibility, 1);
    params.push(...clause.params);
    const where = [clause.sql];
    if (f.vehicleId) where.push(`i.vehicle_id = ${add(f.vehicleId)}::bigint`);
    if (f.statuses?.length) where.push(`i.status = ANY(${add(f.statuses)}::text[])`);
    if (f.severities?.length) where.push(`i.severity = ANY(${add(f.severities)}::alert.alert_severity[])`);
    if (f.types?.length) where.push(`i.incident_type = ANY(${add(f.types)}::text[])`);
    if (f.from) where.push(`i.occurred_at >= ${add(f.from)}`);
    if (f.to) where.push(`i.occurred_at < ${add(f.to)}`);
    const condition = where.join(' AND ');

    const total = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM alert.incident_reports i WHERE ${condition}`, params);
    const rows = await db.query<IncidentRow>(`${ROW_SQL} WHERE ${condition} ORDER BY i.occurred_at DESC, i.id DESC LIMIT ${add(f.limit)} OFFSET ${add(f.offset)}`, params);
    return { rows: rows.rows, total: total.rows[0].n };
  }

  async insert(client: PoolClient, ctx: MutationContext, incident: NewIncident): Promise<IncidentRow> {
    const row = await this.mutate(ctx, 'alert.incident_reports', 'INSERT', null, { ...incident }, client);
    return this.findById(client, row.id as string);
  }

  /** One audited UPDATE: the row before and after, with who changed it (FMS-89). */
  async update(client: PoolClient, ctx: MutationContext, id: string, changes: IncidentChanges): Promise<IncidentRow> {
    await this.mutate(ctx, 'alert.incident_reports', 'UPDATE', id, { ...changes }, client);
    return this.findById(client, id);
  }
}

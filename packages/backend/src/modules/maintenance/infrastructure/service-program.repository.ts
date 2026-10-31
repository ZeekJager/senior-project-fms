import type { Pool, PoolClient } from 'pg';
import { limitOffset, type Page } from '../../../shared/http/pagination';
import type { MutationContext, Row } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { Repository } from '../../../shared/infrastructure/repository';
import { OPEN_STATUSES } from '../domain/maintenance';
import type { ProgramFuelType, ProgramVehicleType, ServiceDueStatus, ServiceMeasure } from '../domain/service-program';

/** A maintenance.service_programs row (internal ids). */
export interface ProgramRow {
  id: string;
  publicId: string;
  name: string;
  description: string | null;
  depotId: string | null;
  vehicleType: ProgramVehicleType | null;
  fuelType: ProgramFuelType | null;
  make: string | null;
  model: string | null;
  intervalKm: number | null;
  leadKm: number | null;
  intervalDays: number | null;
  leadDays: number | null;
  intervalEngineHours: number | null;
  leadEngineHours: number | null;
  tasks: string[];
  isActive: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** The columns a program write sets. */
export interface ProgramWrite {
  name?: string;
  description?: string | null;
  depot_id?: string | null;
  vehicle_type?: string | null;
  fuel_type?: string | null;
  make?: string | null;
  model?: string | null;
  interval_km?: number | null;
  lead_km?: number | null;
  interval_days?: number | null;
  lead_days?: number | null;
  interval_engine_hours?: number | null;
  lead_engine_hours?: number | null;
  /** JSON text of the task names. */
  tasks?: string;
  is_active?: boolean;
  created_by?: string | null;
}

export interface ProgramListFilter extends Page {
  /** Programs of these depots, and the fleet-wide ones; null: every program. */
  depotIds: string[] | null;
  status: 'active' | 'retired' | 'all';
}

/** A maintenance.service_due row with its program's name and tasks, and the repair it counts from. */
export interface DueRow {
  vehicleId: string;
  programId: string;
  programPublicId: string;
  programName: string;
  programTasks: string[];
  lastRecordPublicId: string | null;
  lastCompletedAt: Date | null;
  sinceAt: Date;
  sinceKm: number;
  sinceEngineHours: number | null;
  nextDueKm: number | null;
  nextDueAt: Date | null;
  nextDueEngineHours: number | null;
  odometerKm: number;
  engineHours: number | null;
  status: ServiceDueStatus;
  dueBy: ServiceMeasure[];
  statusChangedAt: Date;
  computedAt: Date;
}

/** One computed row to store. Internal ids. */
export interface DueWrite {
  vehicleId: string;
  programId: string;
  lastRecordId: string | null;
  sinceAt: Date;
  sinceKm: number;
  sinceEngineHours: number | null;
  nextDueKm: number | null;
  nextDueAt: Date | null;
  nextDueEngineHours: number | null;
  odometerKm: number;
  engineHours: number | null;
  status: ServiceDueStatus;
  dueBy: ServiceMeasure[];
}

export interface DueListFilter extends Page {
  /** Vehicles in the caller's scope (internal ids); null: every vehicle. */
  vehicleIds: string[] | null;
  programId?: string;
  statuses: readonly ServiceDueStatus[];
}

/** The last completed service of a program on a vehicle. */
export interface LastServiceRow {
  vehicleId: string;
  programId: string;
  recordId: string;
  completedAt: Date;
  odometerKm: number | null;
}

export interface OpenServiceRow {
  vehicleId: string;
  programId: string;
  publicId: string;
  status: string;
  scheduledAt: Date | null;
}

const PROGRAM_SQL = `
  SELECT p.id, p.public_id AS "publicId", p.name, p.description, p.depot_id AS "depotId",
         p.vehicle_type::text AS "vehicleType", p.fuel_type::text AS "fuelType", p.make, p.model,
         p.interval_km AS "intervalKm", p.lead_km AS "leadKm", p.interval_days AS "intervalDays", p.lead_days AS "leadDays",
         p.interval_engine_hours AS "intervalEngineHours", p.lead_engine_hours AS "leadEngineHours",
         p.tasks, p.is_active AS "isActive", p.version, p.created_at AS "createdAt", p.updated_at AS "updatedAt"
    FROM maintenance.service_programs p`;

const DUE_SQL = `
  SELECT d.vehicle_id AS "vehicleId", d.program_id AS "programId", p.public_id AS "programPublicId",
         p.name AS "programName", p.tasks AS "programTasks",
         r.public_id AS "lastRecordPublicId", r.completed_at AS "lastCompletedAt",
         d.since_at AS "sinceAt", d.since_km::float8 AS "sinceKm", d.since_engine_hours::float8 AS "sinceEngineHours",
         d.next_due_km::float8 AS "nextDueKm", d.next_due_at AS "nextDueAt", d.next_due_engine_hours::float8 AS "nextDueEngineHours",
         d.odometer_km::float8 AS "odometerKm", d.engine_hours::float8 AS "engineHours",
         d.status::text AS status, d.due_by AS "dueBy", d.status_changed_at AS "statusChangedAt", d.computed_at AS "computedAt"
    FROM maintenance.service_due d
    JOIN maintenance.service_programs p ON p.id = d.program_id
    LEFT JOIN maintenance.maintenance_records r ON r.id = d.last_record_id`;

/** Most urgent first, then the longest at it. */
const DUE_ORDER = `ORDER BY CASE d.status WHEN 'overdue' THEN 0 WHEN 'due' THEN 1 ELSE 2 END, d.status_changed_at, d.vehicle_id, p.name`;

/**
 * Preventive service programs and the service due under them (FMS-129). Vehicles live in the fleet
 * module: this repository only sees their internal ids.
 */
export class ServiceProgramRepository extends Repository {
  constructor(db: Pool) {
    super(db);
  }

  inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.transaction(fn);
  }

  /** By name. */
  async list(db: Queryable, f: ProgramListFilter): Promise<{ rows: ProgramRow[]; total: number }> {
    const params: unknown[] = [];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where: string[] = [];
    if (f.depotIds !== null) where.push(`(p.depot_id IS NULL OR p.depot_id = ANY(${add(f.depotIds)}::bigint[]))`);
    if (f.status !== 'all') where.push(f.status === 'active' ? 'p.is_active' : 'NOT p.is_active');
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const count = await db.query<{ total: number }>(`SELECT count(*)::int AS total FROM maintenance.service_programs p ${whereSql}`, params);
    const { limit, offset } = limitOffset(f);
    const res = await db.query<ProgramRow>(
      `${PROGRAM_SQL} ${whereSql} ORDER BY lower(p.name), p.id LIMIT ${add(limit)} OFFSET ${add(offset)}`,
      params,
    );
    return { rows: res.rows, total: count.rows[0].total };
  }

  async findByPublicId(db: Queryable, publicId: string): Promise<ProgramRow | null> {
    const res = await db.query<ProgramRow>(`${PROGRAM_SQL} WHERE p.public_id = $1`, [publicId]);
    return res.rows[0] ?? null;
  }

  async findById(db: Queryable, id: string): Promise<ProgramRow> {
    const res = await db.query<ProgramRow>(`${PROGRAM_SQL} WHERE p.id = $1`, [id]);
    return res.rows[0];
  }

  async lockForWrite(client: PoolClient, publicId: string): Promise<ProgramRow | null> {
    const res = await client.query<ProgramRow>(`${PROGRAM_SQL} WHERE p.public_id = $1 FOR UPDATE`, [publicId]);
    return res.rows[0] ?? null;
  }

  async byIds(db: Queryable, ids: readonly string[]): Promise<ProgramRow[]> {
    if (ids.length === 0) return [];
    const res = await db.query<ProgramRow>(`${PROGRAM_SQL} WHERE p.id = ANY($1::bigint[])`, [ids]);
    return res.rows;
  }

  /** Active programs, or those of `ids` among them, in id order. */
  async active(db: Queryable, ids: readonly string[] | null = null): Promise<ProgramRow[]> {
    const res = await db.query<ProgramRow>(`${PROGRAM_SQL} WHERE p.is_active AND ($1::bigint[] IS NULL OR p.id = ANY($1::bigint[])) ORDER BY p.id`, [ids]);
    return res.rows;
  }

  /** Whether another active program of the name applies to the same depot (or is fleet-wide too). */
  async nameTaken(db: Queryable, depotId: string | null, name: string, exceptId: string | null): Promise<boolean> {
    const res = await db.query<{ taken: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM maintenance.service_programs
          WHERE is_active AND COALESCE(depot_id, 0) = COALESCE($1::bigint, 0) AND lower(name) = lower($2)
            AND ($3::bigint IS NULL OR id <> $3)
       ) AS taken`,
      [depotId, name.trim(), exceptId],
    );
    return res.rows[0].taken;
  }

  insert(ctx: MutationContext, data: ProgramWrite, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'maintenance.service_programs', 'INSERT', null, { ...data }, client);
  }

  update(ctx: MutationContext, id: string, data: ProgramWrite, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'maintenance.service_programs', 'UPDATE', id, { ...data }, client);
  }

  /** Each vehicle's last completed service under each program, among the vehicles and programs asked (null: all). */
  async lastServices(db: Queryable, vehicleIds: readonly string[] | null, programIds: readonly string[] | null): Promise<LastServiceRow[]> {
    const res = await db.query<LastServiceRow>(
      `SELECT DISTINCT ON (vehicle_id, service_program_id)
              vehicle_id AS "vehicleId", service_program_id AS "programId", id AS "recordId",
              completed_at AS "completedAt", odometer_km::float8 AS "odometerKm"
         FROM maintenance.maintenance_records
        WHERE service_program_id IS NOT NULL AND status = 'completed' AND completed_at IS NOT NULL
          AND ($1::bigint[] IS NULL OR vehicle_id = ANY($1::bigint[]))
          AND ($2::bigint[] IS NULL OR service_program_id = ANY($2::bigint[]))
        ORDER BY vehicle_id, service_program_id, completed_at DESC, id DESC`,
      [vehicleIds, programIds],
    );
    return res.rows;
  }

  /** Open preventive work booked for a program on each vehicle (the latest), among the vehicles asked. */
  async openServices(db: Queryable, vehicleIds: readonly string[]): Promise<OpenServiceRow[]> {
    if (vehicleIds.length === 0) return [];
    const res = await db.query<OpenServiceRow>(
      `SELECT DISTINCT ON (vehicle_id, service_program_id)
              vehicle_id AS "vehicleId", service_program_id AS "programId", public_id AS "publicId",
              status::text AS status, scheduled_at AS "scheduledAt"
         FROM maintenance.maintenance_records
        WHERE service_program_id IS NOT NULL AND vehicle_id = ANY($1::bigint[])
          AND status = ANY($2::maintenance.maintenance_status[])
        ORDER BY vehicle_id, service_program_id, created_at DESC, id DESC`,
      [vehicleIds, OPEN_STATUSES],
    );
    return res.rows;
  }

  /** The stored statuses of the vehicles and programs asked (null: all), by `vehicleId:programId`. */
  async statuses(db: Queryable, vehicleIds: readonly string[] | null, programIds: readonly string[] | null): Promise<Map<string, ServiceDueStatus>> {
    const res = await db.query<{ key: string; status: ServiceDueStatus }>(
      `SELECT vehicle_id || ':' || program_id AS key, status::text AS status
         FROM maintenance.service_due
        WHERE ($1::bigint[] IS NULL OR vehicle_id = ANY($1::bigint[])) AND ($2::bigint[] IS NULL OR program_id = ANY($2::bigint[]))`,
      [vehicleIds, programIds],
    );
    return new Map(res.rows.map((r) => [r.key, r.status]));
  }

  /** Stores computed rows: a row whose status moved gets status_changed_at now. */
  async upsertDue(db: Queryable, rows: readonly DueWrite[], now: Date): Promise<void> {
    if (rows.length === 0) return;
    const col = <T>(f: (r: DueWrite) => T) => rows.map(f);
    await db.query(
      `INSERT INTO maintenance.service_due AS d
              (vehicle_id, program_id, last_record_id, since_at, since_km, since_engine_hours, next_due_km, next_due_at,
               next_due_engine_hours, odometer_km, engine_hours, status, due_by, status_changed_at, computed_at)
       SELECT u.vehicle_id, u.program_id, u.last_record_id, u.since_at, u.since_km, u.since_engine_hours, u.next_due_km, u.next_due_at,
              u.next_due_engine_hours, u.odometer_km, u.engine_hours, u.status::maintenance.service_due_status,
              COALESCE(string_to_array(NULLIF(u.due_by, ''), ','), '{}'), $14, $14
         FROM unnest($1::bigint[], $2::bigint[], $3::bigint[], $4::timestamptz[], $5::numeric[], $6::numeric[], $7::numeric[],
                     $8::timestamptz[], $9::numeric[], $10::numeric[], $11::numeric[], $12::text[], $13::text[])
              AS u(vehicle_id, program_id, last_record_id, since_at, since_km, since_engine_hours, next_due_km, next_due_at,
                   next_due_engine_hours, odometer_km, engine_hours, status, due_by)
       ON CONFLICT (vehicle_id, program_id) DO UPDATE SET
              last_record_id = EXCLUDED.last_record_id, since_at = EXCLUDED.since_at, since_km = EXCLUDED.since_km,
              since_engine_hours = EXCLUDED.since_engine_hours, next_due_km = EXCLUDED.next_due_km,
              next_due_at = EXCLUDED.next_due_at, next_due_engine_hours = EXCLUDED.next_due_engine_hours,
              odometer_km = EXCLUDED.odometer_km, engine_hours = EXCLUDED.engine_hours, status = EXCLUDED.status,
              due_by = EXCLUDED.due_by, computed_at = EXCLUDED.computed_at,
              status_changed_at = CASE WHEN d.status <> EXCLUDED.status THEN EXCLUDED.status_changed_at ELSE d.status_changed_at END`,
      [
        col((r) => r.vehicleId),
        col((r) => r.programId),
        col((r) => r.lastRecordId),
        col((r) => r.sinceAt),
        col((r) => r.sinceKm),
        col((r) => r.sinceEngineHours),
        col((r) => r.nextDueKm),
        col((r) => r.nextDueAt),
        col((r) => r.nextDueEngineHours),
        col((r) => r.odometerKm),
        col((r) => r.engineHours),
        col((r) => r.status),
        col((r) => r.dueBy.join(',')),
        now,
      ],
    );
  }

  /**
   * Removes the rows of the vehicles and programs recomputed (null: all) that no longer apply: a program
   * retired or narrowed, a vehicle moved, retired or re-typed. `keep` holds `vehicleId:programId`.
   */
  async deleteStale(db: Queryable, vehicleIds: readonly string[] | null, programIds: readonly string[] | null, keep: readonly string[]): Promise<number> {
    const res = await db.query(
      `DELETE FROM maintenance.service_due
        WHERE ($1::bigint[] IS NULL OR vehicle_id = ANY($1::bigint[])) AND ($2::bigint[] IS NULL OR program_id = ANY($2::bigint[]))
          AND NOT (vehicle_id || ':' || program_id = ANY($3::text[]))`,
      [vehicleIds, programIds, keep],
    );
    return res.rowCount ?? 0;
  }

  /** Removes the rows of every vehicle but those given: the vehicles in service, after the daily job. */
  async deleteOtherVehicles(db: Queryable, vehicleIds: readonly string[]): Promise<number> {
    const res = await db.query('DELETE FROM maintenance.service_due WHERE NOT (vehicle_id = ANY($1::bigint[]))', [vehicleIds]);
    return res.rowCount ?? 0;
  }

  async listDue(db: Queryable, f: DueListFilter): Promise<{ rows: DueRow[]; total: number }> {
    const params: unknown[] = [f.statuses];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where = ['p.is_active', 'd.status = ANY($1::maintenance.service_due_status[])'];
    if (f.vehicleIds !== null) where.push(`d.vehicle_id = ANY(${add(f.vehicleIds)}::bigint[])`);
    if (f.programId) where.push(`d.program_id = ${add(f.programId)}`);
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const count = await db.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM maintenance.service_due d JOIN maintenance.service_programs p ON p.id = d.program_id ${whereSql}`,
      params,
    );
    const { limit, offset } = limitOffset(f);
    const res = await db.query<DueRow>(`${DUE_SQL} ${whereSql} ${DUE_ORDER} LIMIT ${add(limit)} OFFSET ${add(offset)}`, params);
    return { rows: res.rows, total: count.rows[0].total };
  }

  /** Every program's row for one vehicle, most urgent first. */
  async dueForVehicles(db: Queryable, vehicleIds: readonly string[], statuses: readonly ServiceDueStatus[]): Promise<DueRow[]> {
    if (vehicleIds.length === 0) return [];
    const res = await db.query<DueRow>(
      `${DUE_SQL} WHERE p.is_active AND d.vehicle_id = ANY($1::bigint[]) AND d.status = ANY($2::maintenance.service_due_status[]) ${DUE_ORDER}`,
      [vehicleIds, statuses],
    );
    return res.rows;
  }

  /** Each program's vehicles by status, among the vehicles asked (null: all). */
  async counts(db: Queryable, programIds: readonly string[], vehicleIds: readonly string[] | null): Promise<Map<string, Record<ServiceDueStatus, number>>> {
    if (programIds.length === 0) return new Map();
    const res = await db.query<{ programId: string; status: ServiceDueStatus; n: number }>(
      `SELECT program_id AS "programId", status::text AS status, count(*)::int AS n
         FROM maintenance.service_due
        WHERE program_id = ANY($1::bigint[]) AND ($2::bigint[] IS NULL OR vehicle_id = ANY($2::bigint[]))
        GROUP BY program_id, status`,
      [programIds, vehicleIds],
    );
    const out = new Map<string, Record<ServiceDueStatus, number>>();
    for (const r of res.rows) {
      const c = out.get(r.programId) ?? { upcoming: 0, due: 0, overdue: 0 };
      c[r.status] = r.n;
      out.set(r.programId, c);
    }
    return out;
  }
}

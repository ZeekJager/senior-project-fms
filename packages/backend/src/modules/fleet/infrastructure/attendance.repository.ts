import type { Pool, PoolClient } from 'pg';
import { scopeClause, type Scope } from '../../../shared/authz/scope';
import { limitOffset, type Page } from '../../../shared/http/pagination';
import type { MutationContext, Row } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { Repository } from '../../../shared/infrastructure/repository';
import type { AttendanceStatus } from '../domain/attendance';
import { EXPIRING_SOON_DAYS, type LicenseStatus } from '../domain/driver';

/** A fleet.driver_attendance row with internal ids; the service turns it into a view. */
export interface AttendanceRow {
  id: string;
  publicId: string;
  driverId: string;
  driverPublicId: string;
  driverUserId: string;
  date: string;
  status: AttendanceStatus;
  notes: string | null;
  loggedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** A roster line: a driver, and their record for the day if there is one. */
export interface RosterRow {
  driverPublicId: string;
  fullName: string;
  email: string;
  depotId: string | null;
  licenseStatus: LicenseStatus;
  record: Omit<AttendanceRow, 'driverId' | 'driverPublicId' | 'driverUserId' | 'date'> | null;
}

export interface RosterFilter extends Page {
  date: string;
  /** Narrows by the driver's home depot (fleet's copy of the account). */
  scope: Scope;
  /** For a driver: only their own line (internal user id). */
  ownUserId?: string;
  depotId?: string;
  driverPublicId?: string;
  /** `unmarked`: no record yet. */
  status?: AttendanceStatus | 'unmarked';
  search?: string;
}

const ROW_SQL = `
  SELECT t.id, t.public_id AS "publicId", t.driver_id AS "driverId", d.public_id AS "driverPublicId",
         d.user_id AS "driverUserId", t.attendance_date::text AS date, t.status, t.notes,
         t.logged_by AS "loggedBy", t.created_at AS "createdAt", t.updated_at AS "updatedAt"
    FROM fleet.driver_attendance t
    JOIN fleet.drivers d ON d.id = t.driver_id`;

const containsPattern = (term: string) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const LICENSE_STATUS_SQL = `CASE WHEN d.license_expiry < ($1::date) THEN 'expired'
              WHEN d.license_expiry <= ($1::date) + ${EXPIRING_SOON_DAYS} THEN 'expiring_soon'
              ELSE 'valid' END`;

/** fleet.driver_attendance (FMS-21). One row per driver and day; writes are audited. */
export class AttendanceRepository extends Repository {
  constructor(db: Pool) {
    super(db);
  }

  inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.transaction(fn);
  }

  async findByPublicId(db: Queryable, publicId: string): Promise<AttendanceRow | null> {
    const res = await db.query<AttendanceRow>(`${ROW_SQL} WHERE t.public_id = $1`, [publicId]);
    return res.rows[0] ?? null;
  }

  async findById(db: Queryable, id: string): Promise<AttendanceRow> {
    const res = await db.query<AttendanceRow>(`${ROW_SQL} WHERE t.id = $1`, [id]);
    return res.rows[0];
  }

  /** Locks a record for an update in the same transaction. */
  async lockForWrite(client: PoolClient, publicId: string): Promise<AttendanceRow | null> {
    const res = await client.query<AttendanceRow>(`${ROW_SQL} WHERE t.public_id = $1 FOR UPDATE OF t`, [publicId]);
    return res.rows[0] ?? null;
  }

  /**
   * The day's roster: every active driver the filter allows (home depot in
   * scope, depot still active), with their record for the date or null, by
   * name. Licence status is judged on that date.
   */
  async roster(db: Queryable, f: RosterFilter): Promise<{ rows: RosterRow[]; total: number }> {
    const params: unknown[] = [f.date];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where: string[] = ['d.is_active', 'NOT EXISTS (SELECT 1 FROM fleet.depots dep WHERE dep.id = a.depot_id AND NOT dep.is_active)'];
    const scope = scopeClause(f.scope, 'a.depot_id', params.length + 1);
    where.push(scope.sql);
    params.push(...scope.params);
    if (f.ownUserId) where.push(`d.user_id = ${add(f.ownUserId)}`);
    if (f.depotId) where.push(`a.depot_id = ${add(f.depotId)}`);
    if (f.driverPublicId) where.push(`d.public_id = ${add(f.driverPublicId)}`);
    if (f.status === 'unmarked') where.push('t.id IS NULL');
    else if (f.status) where.push(`t.status = ${add(f.status)}`);
    if (f.search) {
      const p = add(containsPattern(f.search));
      where.push(`(a.full_name ILIKE ${p} OR a.email ILIKE ${p} OR d.license_number ILIKE ${p})`);
    }
    const from = `fleet.drivers d
      JOIN fleet.driver_accounts a ON a.user_id = d.user_id
      LEFT JOIN fleet.driver_attendance t ON t.driver_id = d.id AND t.attendance_date = $1::date`;
    const whereSql = where.join(' AND ');

    const count = await db.query<{ total: number }>(`SELECT count(*)::int AS total FROM ${from} WHERE ${whereSql}`, params);
    const { limit, offset } = limitOffset(f);
    const res = await db.query<{
      driverPublicId: string;
      fullName: string;
      email: string;
      depotId: string | null;
      licenseStatus: LicenseStatus;
      id: string | null;
      publicId: string | null;
      status: AttendanceStatus | null;
      notes: string | null;
      loggedBy: string | null;
      createdAt: Date | null;
      updatedAt: Date | null;
    }>(
      `SELECT d.public_id AS "driverPublicId", a.full_name AS "fullName", a.email, a.depot_id AS "depotId",
              ${LICENSE_STATUS_SQL} AS "licenseStatus",
              t.id, t.public_id AS "publicId", t.status, t.notes, t.logged_by AS "loggedBy",
              t.created_at AS "createdAt", t.updated_at AS "updatedAt"
         FROM ${from}
        WHERE ${whereSql}
        ORDER BY a.full_name, d.id
        LIMIT ${add(limit)} OFFSET ${add(offset)}`,
      params,
    );
    return {
      total: count.rows[0].total,
      rows: res.rows.map((r) => ({
        driverPublicId: r.driverPublicId,
        fullName: r.fullName,
        email: r.email,
        depotId: r.depotId,
        licenseStatus: r.licenseStatus,
        record:
          r.id === null
            ? null
            : {
                id: r.id,
                publicId: r.publicId!,
                status: r.status!,
                notes: r.notes,
                loggedBy: r.loggedBy!,
                createdAt: r.createdAt!,
                updatedAt: r.updatedAt!,
              },
      })),
    };
  }

  /** Today's status of each driver (internal ids) that has a record: for driver views and dispatch warnings. */
  async statusOn(db: Queryable, driverIds: readonly string[], date: string): Promise<Map<string, AttendanceStatus>> {
    if (driverIds.length === 0) return new Map();
    const res = await db.query<{ driverId: string; status: AttendanceStatus }>(
      `SELECT driver_id AS "driverId", status FROM fleet.driver_attendance
        WHERE driver_id = ANY($1::bigint[]) AND attendance_date = $2::date`,
      [driverIds, date],
    );
    return new Map(res.rows.map((r) => [r.driverId, r.status]));
  }

  insert(ctx: MutationContext, data: { driver_id: string; attendance_date: string; status: AttendanceStatus; notes: string | null; logged_by: string }, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'fleet.driver_attendance', 'INSERT', null, { ...data }, client);
  }

  update(ctx: MutationContext, id: string, data: { status?: AttendanceStatus; notes?: string | null; logged_by: string }, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'fleet.driver_attendance', 'UPDATE', id, { ...data }, client);
  }
}


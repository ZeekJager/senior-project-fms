import type { Pool, PoolClient } from 'pg';
import type { MutationContext, Row } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { Repository } from '../../../shared/infrastructure/repository';
import { EXPIRING_SOON_DAYS, OPERATING_TIME_ZONE, type LicenseCategory, type LicenseStatus } from '../domain/driver';

/** A fleet.drivers row. Dates are `YYYY-MM-DD` text, never JS Dates, so no time zone shifts them. */
export interface DriverRow {
  id: string;
  publicId: string;
  userId: string;
  licenseNumber: string;
  licenseCategory: LicenseCategory | null;
  licenseExpiry: string;
  licenseStatus: LicenseStatus;
  hireDate: string | null;
  emergencyPhone: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export const DRIVER_SORT_COLUMNS = {
  license_number: 'd.license_number',
  license_expiry: 'd.license_expiry',
  hire_date: 'd.hire_date',
  created_at: 'd.created_at',
} as const;

export type DriverSortKey = keyof typeof DRIVER_SORT_COLUMNS;

export interface DriverListFilter {
  page: number;
  page_size: number;
  /** Drivers whose user is one of these (the depot filter and scope, resolved by the auth module); null: no limit. */
  userIds: readonly string[] | null;
  /** Search: drivers whose user matched by name or email, or whose licence number contains `term`. */
  search?: { term: string; userIds: readonly string[] };
  status?: 'active' | 'retired';
  /** `YYYY-MM-DD`: licences that expire before this date (already expired included). */
  licenseExpiringBefore?: string;
  licenseStatus?: LicenseStatus;
  sort_by: DriverSortKey;
  sort_order: 'asc' | 'desc';
}

/** The columns of fleet.drivers a write may set. */
export interface DriverWrite {
  user_id?: string;
  license_number?: string;
  license_category?: LicenseCategory | null;
  license_expiry?: string;
  hire_date?: string | null;
  emergency_phone?: string | null;
}

// Today's date where the fleet operates. The zone and the day count are code
// constants, never input.
const TODAY = `(CURRENT_TIMESTAMP AT TIME ZONE '${OPERATING_TIME_ZONE}')::date`;
const LICENSE_STATUS_SQL = `CASE WHEN d.license_expiry < ${TODAY} THEN 'expired'
              WHEN d.license_expiry <= ${TODAY} + ${EXPIRING_SOON_DAYS} THEN 'expiring_soon'
              ELSE 'valid' END`;

const ROW_COLUMNS = `
         d.id, d.public_id AS "publicId", d.user_id AS "userId", d.license_number AS "licenseNumber",
         d.license_category AS "licenseCategory", d.license_expiry::text AS "licenseExpiry",
         ${LICENSE_STATUS_SQL} AS "licenseStatus",
         d.hire_date::text AS "hireDate", d.emergency_phone AS "emergencyPhone", d.is_active AS "isActive",
         d.created_at AS "createdAt", d.updated_at AS "updatedAt"`;

const ROW_SQL = `SELECT ${ROW_COLUMNS} FROM fleet.drivers d`;

const containsPattern = (term: string) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * fleet.drivers. Depot scope cannot be a WHERE clause here: a driver's depot
 * is on their user account, which belongs to the auth module. The service
 * applies it, through user ids resolved by the auth module.
 */
export class DriverRepository extends Repository {
  constructor(db: Pool) {
    super(db);
  }

  inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.transaction(fn);
  }

  async findByPublicId(db: Queryable, publicId: string): Promise<DriverRow | null> {
    const res = await db.query<DriverRow>(`${ROW_SQL} WHERE d.public_id = $1`, [publicId]);
    return res.rows[0] ?? null;
  }

  async findById(db: Queryable, id: string): Promise<DriverRow> {
    const res = await db.query<DriverRow>(`${ROW_SQL} WHERE d.id = $1`, [id]);
    return res.rows[0];
  }

  /** The driver profile of a user account (internal user id), if any. */
  async findByUserId(db: Queryable, userId: string): Promise<DriverRow | null> {
    const res = await db.query<DriverRow>(`${ROW_SQL} WHERE d.user_id = $1`, [userId]);
    return res.rows[0] ?? null;
  }

  /** Reads and row-locks a driver for a write in the same transaction. */
  async lockForWrite(client: PoolClient, publicId: string): Promise<DriverRow | null> {
    const res = await client.query<DriverRow>(`${ROW_SQL} WHERE d.public_id = $1 FOR UPDATE`, [publicId]);
    return res.rows[0] ?? null;
  }

  async list(db: Queryable, filter: DriverListFilter): Promise<{ rows: DriverRow[]; total: number }> {
    const params: unknown[] = [];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where: string[] = [];

    // Retired drivers leave the default list; status=retired lists them.
    where.push(filter.status === 'retired' ? 'NOT d.is_active' : 'd.is_active');
    if (filter.userIds !== null) where.push(`d.user_id = ANY(${add(filter.userIds)}::bigint[])`);
    if (filter.search) {
      where.push(
        `(d.user_id = ANY(${add(filter.search.userIds)}::bigint[]) OR d.license_number ILIKE ${add(containsPattern(filter.search.term))})`,
      );
    }
    if (filter.licenseExpiringBefore) where.push(`d.license_expiry < ${add(filter.licenseExpiringBefore)}::date`);
    if (filter.licenseStatus) where.push(`${LICENSE_STATUS_SQL} = ${add(filter.licenseStatus)}`);

    const whereSql = where.join(' AND ');
    const count = await db.query<{ total: number }>(`SELECT count(*)::int AS total FROM fleet.drivers d WHERE ${whereSql}`, params);

    const direction = filter.sort_order === 'desc' ? 'DESC' : 'ASC';
    const limit = add(filter.page_size);
    const offset = add((filter.page - 1) * filter.page_size);
    const rows = await db.query<DriverRow>(
      `${ROW_SQL} WHERE ${whereSql}
        ORDER BY ${DRIVER_SORT_COLUMNS[filter.sort_by]} ${direction} NULLS LAST, d.id ${direction}
        LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    return { rows: rows.rows, total: count.rows[0].total };
  }

  /** True while the driver holds an active vehicle assignment (fleet.driver_vehicle_assignments). */
  async hasActiveAssignment(db: Queryable, driverId: string): Promise<boolean> {
    const res = await db.query<{ active: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM fleet.driver_vehicle_assignments
          WHERE driver_id = $1 AND status = 'active'
            AND (assigned_until IS NULL OR assigned_until > CURRENT_TIMESTAMP)
       ) AS active`,
      [driverId],
    );
    return res.rows[0].active;
  }

  /** The driver's own facts for eligibility at `at`: retired or not, licence valid on that local date, its class. */
  async licenceAt(
    db: Queryable,
    driverId: string,
    at: Date,
  ): Promise<{ userId: string; isActive: boolean; licenseValid: boolean; licenseCategory: LicenseCategory | null } | null> {
    const res = await db.query<{ userId: string; isActive: boolean; licenseValid: boolean; licenseCategory: LicenseCategory | null }>(
      `SELECT d.user_id AS "userId", d.is_active AS "isActive", d.license_category AS "licenseCategory",
              d.license_expiry >= ($2::timestamptz AT TIME ZONE $3)::date AS "licenseValid"
         FROM fleet.drivers d
        WHERE d.id = $1`,
      [driverId, at.toISOString(), OPERATING_TIME_ZONE],
    );
    return res.rows[0] ?? null;
  }

  /**
   * Active drivers whose licence expires exactly `daysLeft` days after `at`'s
   * date in Addis Ababa (one of them per row, with the count), for the daily
   * expiry warning.
   */
  async expiringIn(db: Queryable, daysLeft: readonly number[], at: Date): Promise<(DriverRow & { daysLeft: number })[]> {
    const res = await db.query<DriverRow & { daysLeft: number }>(
      `SELECT ${ROW_COLUMNS}, (d.license_expiry - ($2::timestamptz AT TIME ZONE $3)::date) AS "daysLeft"
         FROM fleet.drivers d
        WHERE d.is_active AND (d.license_expiry - ($2::timestamptz AT TIME ZONE $3)::date) = ANY($1::int[])
        ORDER BY d.id`,
      [daysLeft, at.toISOString(), OPERATING_TIME_ZONE],
    );
    return res.rows;
  }

  insert(ctx: MutationContext, data: DriverWrite, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'fleet.drivers', 'INSERT', null, { ...data }, client);
  }

  update(ctx: MutationContext, id: string, data: DriverWrite, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'fleet.drivers', 'UPDATE', id, { ...data }, client);
  }

  /** Soft retirement: `is_active = FALSE`, one audited change. Trips and attendance keep pointing at the row. */
  retire(ctx: MutationContext, id: string, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'fleet.drivers', 'DELETE', id, {}, client);
  }
}

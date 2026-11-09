import type { Pool, PoolClient } from 'pg';
import { recordAuditEntry } from '../../../shared/infrastructure/audit-log';
import { limitOffset, type Page } from '../../../shared/http/pagination';
import type { MutationContext, Row } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { Repository } from '../../../shared/infrastructure/repository';
import type { FailureComponent } from '../domain/failure';
import type { ClaimStatus, RecallVehicleStatus } from '../domain/warranty';

/** A maintenance.warranties row (internal ids). Dates are YYYY-MM-DD. */
export interface WarrantyRow {
  id: string;
  publicId: string;
  vehicleId: string;
  component: FailureComponent | null;
  provider: string;
  coverage: string | null;
  startsOn: string;
  endsOn: string | null;
  endsKm: number | null;
  terms: string | null;
  isActive: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WarrantyWrite {
  vehicle_id?: string;
  component?: FailureComponent | null;
  provider?: string;
  coverage?: string | null;
  starts_on?: string;
  ends_on?: string | null;
  ends_km?: number | null;
  terms?: string | null;
  is_active?: boolean;
  created_by?: string | null;
}

export interface WarrantyListFilter extends Page {
  /** Vehicles in the caller's scope (internal ids); null: every vehicle. */
  vehicleIds: string[] | null;
  vehicleId?: string;
  includeVoid: boolean;
}

/** A repair, as the claim check reads it. */
export interface RepairToJudge {
  id: string;
  status: string;
  workAt: Date;
  odometerKm: number | null;
  components: FailureComponent[];
  warrantyId: string | null;
  claimStatus: ClaimStatus | null;
}

/** The claim on a repair, with its warranty. */
export interface ClaimRow {
  recordId: string;
  warrantyPublicId: string;
  provider: string;
  component: FailureComponent | null;
  endsKm: number | null;
  odometerKm: number | null;
  status: ClaimStatus;
  amountCents: number | null;
  reference: string | null;
  updatedAt: Date | null;
  updatedBy: string | null;
}

/** A repair row locked for its claim. */
export interface LockedClaim {
  id: string;
  vehicleId: string;
  warrantyId: string | null;
  claimStatus: ClaimStatus | null;
  /** The repair's odometer; null: not entered. */
  odometerKm: number | null;
  /** Its warranty's end odometer; null: none, or no warranty. */
  endsKm: number | null;
}

/** A maintenance.recalls row (internal ids). */
export interface RecallRow {
  id: string;
  publicId: string;
  campaignCode: string;
  make: string;
  model: string;
  yearFrom: number;
  yearTo: number;
  description: string;
  remedy: string | null;
  issuedOn: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface RecallWrite {
  campaign_code?: string;
  make?: string;
  model?: string;
  year_from?: number;
  year_to?: number;
  description?: string;
  remedy?: string | null;
  issued_on?: string | null;
  created_by?: string | null;
}

/** A maintenance.recall_vehicles row with its recall, and the work order's public id. */
export interface RecallVehicleRow {
  id: string;
  recallId: string;
  recallPublicId: string;
  campaignCode: string;
  description: string;
  remedy: string | null;
  vehicleId: string;
  status: RecallVehicleStatus;
  recordId: string | null;
  recordPublicId: string | null;
  completedAt: Date | null;
  notes: string | null;
  matchedAt: Date;
  updatedAt: Date;
}

export interface RecallVehicleWrite {
  status?: RecallVehicleStatus;
  maintenance_record_id?: string | null;
  completed_at?: string | null;
  notes?: string | null;
  updated_by?: string | null;
}

const WARRANTY_SQL = `
  SELECT w.id, w.public_id AS "publicId", w.vehicle_id AS "vehicleId", w.component::text AS component, w.provider, w.coverage,
         w.starts_on::text AS "startsOn", w.ends_on::text AS "endsOn", w.ends_km::float8 AS "endsKm", w.terms,
         w.is_active AS "isActive", w.version, w.created_at AS "createdAt", w.updated_at AS "updatedAt"
    FROM maintenance.warranties w`;

const RECALL_SQL = `
  SELECT r.id, r.public_id AS "publicId", r.campaign_code AS "campaignCode", r.make, r.model,
         r.year_from AS "yearFrom", r.year_to AS "yearTo", r.description, r.remedy, r.issued_on::text AS "issuedOn",
         r.version, r.created_at AS "createdAt", r.updated_at AS "updatedAt"
    FROM maintenance.recalls r`;

const RECALL_VEHICLE_SQL = `
  SELECT rv.id, rv.recall_id AS "recallId", r.public_id AS "recallPublicId", r.campaign_code AS "campaignCode",
         r.description, r.remedy, rv.vehicle_id AS "vehicleId", rv.status::text AS status,
         rv.maintenance_record_id AS "recordId", m.public_id AS "recordPublicId", rv.completed_at AS "completedAt",
         rv.notes, rv.matched_at AS "matchedAt", rv.updated_at AS "updatedAt"
    FROM maintenance.recall_vehicles rv
    JOIN maintenance.recalls r ON r.id = rv.recall_id
    LEFT JOIN maintenance.maintenance_records m ON m.id = rv.maintenance_record_id`;

/** Open first, then booked, then done; the oldest match first. */
const RECALL_VEHICLE_ORDER = `ORDER BY CASE rv.status WHEN 'open' THEN 0 WHEN 'scheduled' THEN 1 ELSE 2 END, rv.matched_at, rv.id`;

/**
 * Warranties, the warranty claims on repairs, and recalls with the vehicles they match (FMS-133).
 * Vehicles live in the fleet module: this repository only sees their internal ids.
 */
export class WarrantyRepository extends Repository {
  constructor(db: Pool) {
    super(db);
  }

  inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.transaction(fn);
  }

  // Warranties

  /** Live ones first, then by end date, the soonest first. */
  async listWarranties(db: Queryable, f: WarrantyListFilter): Promise<{ rows: WarrantyRow[]; total: number }> {
    const params: unknown[] = [];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where: string[] = [];
    if (f.vehicleIds !== null) where.push(`w.vehicle_id = ANY(${add(f.vehicleIds)}::bigint[])`);
    if (f.vehicleId) where.push(`w.vehicle_id = ${add(f.vehicleId)}`);
    if (!f.includeVoid) where.push('w.is_active');
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const count = await db.query<{ total: number }>(`SELECT count(*)::int AS total FROM maintenance.warranties w ${whereSql}`, params);
    const { limit, offset } = limitOffset(f);
    const res = await db.query<WarrantyRow>(
      `${WARRANTY_SQL} ${whereSql} ORDER BY w.is_active DESC, w.ends_on NULLS LAST, w.id LIMIT ${add(limit)} OFFSET ${add(offset)}`,
      params,
    );
    return { rows: res.rows, total: count.rows[0].total };
  }

  async findWarranty(db: Queryable, publicId: string): Promise<WarrantyRow | null> {
    const res = await db.query<WarrantyRow>(`${WARRANTY_SQL} WHERE w.public_id = $1`, [publicId]);
    return res.rows[0] ?? null;
  }

  async warrantyById(db: Queryable, id: string): Promise<WarrantyRow> {
    const res = await db.query<WarrantyRow>(`${WARRANTY_SQL} WHERE w.id = $1`, [id]);
    return res.rows[0];
  }

  async lockWarranty(client: PoolClient, publicId: string): Promise<WarrantyRow | null> {
    const res = await client.query<WarrantyRow>(`${WARRANTY_SQL} WHERE w.public_id = $1 FOR UPDATE`, [publicId]);
    return res.rows[0] ?? null;
  }

  /** Every warranty of a vehicle, void ones too (the rules leave those out). */
  async warrantiesOf(db: Queryable, vehicleId: string): Promise<WarrantyRow[]> {
    const res = await db.query<WarrantyRow>(`${WARRANTY_SQL} WHERE w.vehicle_id = $1 ORDER BY w.id`, [vehicleId]);
    return res.rows;
  }

  insertWarranty(ctx: MutationContext, data: WarrantyWrite, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'maintenance.warranties', 'INSERT', null, { ...data }, client);
  }

  updateWarranty(ctx: MutationContext, id: string, data: WarrantyWrite, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'maintenance.warranties', 'UPDATE', id, { ...data }, client);
  }

  /** The repairs claimed under each warranty, by claim status, and what approved claims recovered. */
  async claimCounts(db: Queryable, warrantyIds: readonly string[]): Promise<Map<string, { status: ClaimStatus; n: number; cents: number }[]>> {
    const out = new Map<string, { status: ClaimStatus; n: number; cents: number }[]>();
    if (warrantyIds.length === 0) return out;
    const res = await db.query<{ warrantyId: string; status: ClaimStatus; n: number; cents: number }>(
      `SELECT warranty_id AS "warrantyId", claim_status AS status, count(*)::int AS n, COALESCE(sum(claim_amount_cents), 0)::int AS cents
         FROM maintenance.maintenance_records
        WHERE warranty_id = ANY($1::bigint[])
        GROUP BY warranty_id, claim_status`,
      [warrantyIds],
    );
    for (const r of res.rows) out.set(r.warrantyId, [...(out.get(r.warrantyId) ?? []), r]);
    return out;
  }

  /** Warranties with an end date in [today, today + window], live, of active vehicles: what the expiry job warns of. */
  async endingWithin(db: Queryable, today: string, window: number): Promise<(WarrantyRow & { daysLeft: number })[]> {
    const res = await db.query<{ id: string; daysLeft: number }>(
      `SELECT w.id, (w.ends_on - $1::date) AS "daysLeft"
         FROM maintenance.warranties w
        WHERE w.is_active AND w.ends_on BETWEEN $1::date AND $1::date + $2::int
        ORDER BY w.ends_on, w.id`,
      [today, window],
    );
    if (res.rows.length === 0) return [];
    const rows = new Map((await db.query<WarrantyRow>(`${WARRANTY_SQL} WHERE w.id = ANY($1::bigint[])`, [res.rows.map((r) => r.id)])).rows.map((w) => [w.id, w]));
    return res.rows.map((r) => ({ ...rows.get(r.id)!, daysLeft: r.daysLeft }));
  }

  // Claims

  /**
   * The vehicle's repairs whose claim is not yet sent (none, or claimable), or those of `recordIds` among
   * them, with what the claim check reads: when the work was done, its odometer and what failed.
   */
  async repairsToJudge(db: Queryable, vehicleId: string, recordIds: readonly string[] | null): Promise<RepairToJudge[]> {
    const res = await db.query<RepairToJudge>(
      `SELECT r.id, r.status::text AS status, COALESCE(r.completed_at, r.started_at, r.created_at) AS "workAt",
              r.odometer_km::float8 AS "odometerKm",
              COALESCE((SELECT array_agg(DISTINCT f.component::text) FROM maintenance.failure_events f WHERE f.maintenance_record_id = r.id), '{}') AS components,
              r.warranty_id AS "warrantyId", r.claim_status AS "claimStatus"
         FROM maintenance.maintenance_records r
        WHERE r.vehicle_id = $1 AND (r.claim_status IS NULL OR r.claim_status = 'claimable')
          AND ($2::bigint[] IS NULL OR r.id = ANY($2::bigint[]))
        ORDER BY r.id`,
      [vehicleId, recordIds],
    );
    return res.rows;
  }

  setClaim(
    ctx: MutationContext,
    client: PoolClient,
    recordId: string,
    data: {
      warranty_id?: string | null;
      claim_status?: ClaimStatus | null;
      claim_amount_cents?: number | null;
      claim_reference?: string | null;
      claim_updated_at?: string | null;
      claim_updated_by?: string | null;
    },
  ): Promise<Row> {
    return this.mutate(ctx, 'maintenance.maintenance_records', 'UPDATE', recordId, { ...data }, client);
  }

  /** The odometer a repair was missing, given with its warranty claim (audited as a change to the record). */
  setRepairOdometer(ctx: MutationContext, client: PoolClient, recordId: string, odometerKm: number): Promise<Row> {
    return this.mutate(ctx, 'maintenance.maintenance_records', 'UPDATE', recordId, { odometer_km: odometerKm }, client);
  }

  async lockClaim(client: PoolClient, recordPublicId: string): Promise<LockedClaim | null> {
    const res = await client.query<LockedClaim>(
      `SELECT r.id, r.vehicle_id AS "vehicleId", r.warranty_id AS "warrantyId", r.claim_status AS "claimStatus",
              r.odometer_km::float8 AS "odometerKm", w.ends_km::float8 AS "endsKm"
         FROM maintenance.maintenance_records r
         LEFT JOIN maintenance.warranties w ON w.id = r.warranty_id
        WHERE r.public_id = $1 FOR UPDATE OF r`,
      [recordPublicId],
    );
    return res.rows[0] ?? null;
  }

  async claims(db: Queryable, recordIds: readonly string[]): Promise<ClaimRow[]> {
    if (recordIds.length === 0) return [];
    const res = await db.query<ClaimRow>(
      `SELECT r.id AS "recordId", w.public_id AS "warrantyPublicId", w.provider, w.component::text AS component,
              w.ends_km::float8 AS "endsKm", r.odometer_km::float8 AS "odometerKm", r.claim_status AS status,
              r.claim_amount_cents AS "amountCents", r.claim_reference AS reference,
              r.claim_updated_at AS "updatedAt", r.claim_updated_by AS "updatedBy"
         FROM maintenance.maintenance_records r
         JOIN maintenance.warranties w ON w.id = r.warranty_id
        WHERE r.id = ANY($1::bigint[])`,
      [recordIds],
    );
    return res.rows;
  }

  // Recalls

  async listRecalls(db: Queryable, page: Page): Promise<{ rows: RecallRow[]; total: number }> {
    const count = await db.query<{ total: number }>('SELECT count(*)::int AS total FROM maintenance.recalls');
    const { limit, offset } = limitOffset(page);
    const res = await db.query<RecallRow>(`${RECALL_SQL} ORDER BY r.created_at DESC, r.id DESC LIMIT $1 OFFSET $2`, [limit, offset]);
    return { rows: res.rows, total: count.rows[0].total };
  }

  async allRecalls(db: Queryable): Promise<RecallRow[]> {
    const res = await db.query<RecallRow>(`${RECALL_SQL} ORDER BY r.id`);
    return res.rows;
  }

  async findRecall(db: Queryable, publicId: string): Promise<RecallRow | null> {
    const res = await db.query<RecallRow>(`${RECALL_SQL} WHERE r.public_id = $1`, [publicId]);
    return res.rows[0] ?? null;
  }

  async recallById(db: Queryable, id: string): Promise<RecallRow> {
    const res = await db.query<RecallRow>(`${RECALL_SQL} WHERE r.id = $1`, [id]);
    return res.rows[0];
  }

  async lockRecall(client: PoolClient, publicId: string): Promise<RecallRow | null> {
    const res = await client.query<RecallRow>(`${RECALL_SQL} WHERE r.public_id = $1 FOR UPDATE`, [publicId]);
    return res.rows[0] ?? null;
  }

  async codeTaken(db: Queryable, code: string, exceptId: string | null): Promise<boolean> {
    const res = await db.query<{ taken: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM maintenance.recalls WHERE upper(campaign_code) = upper($1) AND ($2::bigint IS NULL OR id <> $2)) AS taken`,
      [code.trim(), exceptId],
    );
    return res.rows[0].taken;
  }

  insertRecall(ctx: MutationContext, data: RecallWrite, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'maintenance.recalls', 'INSERT', null, { ...data }, client);
  }

  updateRecall(ctx: MutationContext, id: string, data: RecallWrite, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'maintenance.recalls', 'UPDATE', id, { ...data }, client);
  }

  /** Each recall's vehicles by status, among `vehicleIds` (null: all). */
  async recallCounts(db: Queryable, recallIds: readonly string[], vehicleIds: readonly string[] | null): Promise<Map<string, Record<RecallVehicleStatus, number>>> {
    const out = new Map<string, Record<RecallVehicleStatus, number>>();
    if (recallIds.length === 0) return out;
    const res = await db.query<{ recallId: string; status: RecallVehicleStatus; n: number }>(
      `SELECT recall_id AS "recallId", status::text AS status, count(*)::int AS n
         FROM maintenance.recall_vehicles
        WHERE recall_id = ANY($1::bigint[]) AND ($2::bigint[] IS NULL OR vehicle_id = ANY($2::bigint[]))
        GROUP BY recall_id, status`,
      [recallIds, vehicleIds],
    );
    for (const r of res.rows) {
      const c = out.get(r.recallId) ?? { open: 0, scheduled: 0, completed: 0 };
      c[r.status] = r.n;
      out.set(r.recallId, c);
    }
    return out;
  }

  /** The vehicles under recalls, filtered; open first. */
  async listRecallVehicles(
    db: Queryable,
    f: Page & { recallId?: string; vehicleIds: string[] | null; statuses: readonly RecallVehicleStatus[] | null },
  ): Promise<{ rows: RecallVehicleRow[]; total: number }> {
    const params: unknown[] = [];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where: string[] = [];
    if (f.recallId) where.push(`rv.recall_id = ${add(f.recallId)}`);
    if (f.vehicleIds !== null) where.push(`rv.vehicle_id = ANY(${add(f.vehicleIds)}::bigint[])`);
    if (f.statuses !== null) where.push(`rv.status = ANY(${add(f.statuses)}::maintenance.recall_vehicle_status[])`);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const count = await db.query<{ total: number }>(`SELECT count(*)::int AS total FROM maintenance.recall_vehicles rv ${whereSql}`, params);
    const { limit, offset } = limitOffset(f);
    const res = await db.query<RecallVehicleRow>(`${RECALL_VEHICLE_SQL} ${whereSql} ${RECALL_VEHICLE_ORDER} LIMIT ${add(limit)} OFFSET ${add(offset)}`, params);
    return { rows: res.rows, total: count.rows[0].total };
  }

  /** Every recall of a vehicle, open first. */
  async recallsOf(db: Queryable, vehicleId: string): Promise<RecallVehicleRow[]> {
    const res = await db.query<RecallVehicleRow>(`${RECALL_VEHICLE_SQL} WHERE rv.vehicle_id = $1 ${RECALL_VEHICLE_ORDER}`, [vehicleId]);
    return res.rows;
  }

  async lockRecallVehicle(client: PoolClient, recallId: string, vehicleId: string): Promise<RecallVehicleRow | null> {
    const res = await client.query<RecallVehicleRow>(`${RECALL_VEHICLE_SQL} WHERE rv.recall_id = $1 AND rv.vehicle_id = $2 FOR UPDATE OF rv`, [recallId, vehicleId]);
    return res.rows[0] ?? null;
  }

  async recallVehicleById(db: Queryable, id: string): Promise<RecallVehicleRow> {
    const res = await db.query<RecallVehicleRow>(`${RECALL_VEHICLE_SQL} WHERE rv.id = $1`, [id]);
    return res.rows[0];
  }

  /** The recall work a work order carries out and that is not done yet, locked. */
  async lockRecallWorkFor(client: PoolClient, recordId: string): Promise<RecallVehicleRow[]> {
    const res = await client.query<RecallVehicleRow>(
      `${RECALL_VEHICLE_SQL} WHERE rv.maintenance_record_id = $1 AND rv.status <> 'completed' ORDER BY rv.id FOR UPDATE OF rv`,
      [recordId],
    );
    return res.rows;
  }

  /** The vehicles a recall already lists, with their status and work order. */
  async matchesOf(db: Queryable, recallId: string): Promise<{ id: string; vehicleId: string; status: RecallVehicleStatus; recordId: string | null }[]> {
    const res = await db.query<{ id: string; vehicleId: string; status: RecallVehicleStatus; recordId: string | null }>(
      `SELECT id, vehicle_id AS "vehicleId", status::text AS status, maintenance_record_id AS "recordId"
         FROM maintenance.recall_vehicles WHERE recall_id = $1`,
      [recallId],
    );
    return res.rows;
  }

  /** The recalls a vehicle is already listed under. */
  async recallIdsOf(db: Queryable, vehicleId: string): Promise<Set<string>> {
    const res = await db.query<{ recall_id: string }>('SELECT recall_id FROM maintenance.recall_vehicles WHERE vehicle_id = $1', [vehicleId]);
    return new Set(res.rows.map((r) => r.recall_id));
  }

  insertMatch(ctx: MutationContext, client: PoolClient, recallId: string, vehicleId: string): Promise<Row> {
    return this.mutate(ctx, 'maintenance.recall_vehicles', 'INSERT', null, { recall_id: recallId, vehicle_id: vehicleId }, client);
  }

  updateRecallVehicle(ctx: MutationContext, client: PoolClient, id: string, data: RecallVehicleWrite): Promise<Row> {
    return this.mutate(ctx, 'maintenance.recall_vehicles', 'UPDATE', id, { ...data }, client);
  }

  /**
   * Removes a match that no longer applies (the recall's make, model or years changed), with its audit
   * entry. Only an open one with no work order: booked or done work stays on record.
   */
  async removeMatch(ctx: MutationContext, client: PoolClient, id: string): Promise<void> {
    const res = await client.query<Row>(
      `DELETE FROM maintenance.recall_vehicles WHERE id = $1 AND status = 'open' AND maintenance_record_id IS NULL RETURNING *`,
      [id],
    );
    if (res.rows[0]) {
      await recordAuditEntry(client, {
        action: 'DELETE',
        userId: ctx.userId,
        entityType: 'maintenance.recall_vehicles',
        entityId: id,
        correlationId: ctx.correlationId,
        oldValues: res.rows[0],
        newValues: null,
      });
    }
  }

  /** A work order of the vehicle that is not cancelled, by public id: what recall work links. */
  async recordOf(db: Queryable, recordPublicId: string): Promise<{ id: string; vehicleId: string; status: string; completedAt: Date | null } | null> {
    const res = await db.query<{ id: string; vehicleId: string; status: string; completedAt: Date | null }>(
      `SELECT id, vehicle_id AS "vehicleId", status::text AS status, completed_at AS "completedAt"
         FROM maintenance.maintenance_records WHERE public_id = $1`,
      [recordPublicId],
    );
    return res.rows[0] ?? null;
  }
}

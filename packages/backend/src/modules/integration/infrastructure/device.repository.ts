import type { Pool, PoolClient } from 'pg';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { Repository } from '../../../shared/infrastructure/repository';

/** An integration.gps_devices row, as ingestion needs it. */
export interface DeviceRow {
  id: string;
  publicId: string;
  identifier: string;
  vehicleId: string;
  providerId: string | null;
  status: 'active' | 'inactive' | 'faulty' | 'removed';
}

const DEVICE_SQL = `
  SELECT d.id, d.public_id AS "publicId", d.device_identifier AS identifier, d.vehicle_id AS "vehicleId",
         d.provider_id AS "providerId", d.status
    FROM integration.gps_devices d`;

/** A device as the registry lists it (FMS-138): with its provider, never its token. */
export interface DeviceListRow {
  id: string;
  publicId: string;
  identifier: string;
  model: string | null;
  vehicleId: string;
  providerId: string | null;
  providerPublicId: string | null;
  providerCode: string | null;
  providerName: string | null;
  hasToken: boolean;
  status: 'active' | 'inactive' | 'faulty' | 'removed';
  installedAt: Date | null;
  removedAt: Date | null;
  lastSeenAt: Date | null;
  lastErrorReason: string | null;
  lastErrorAt: Date | null;
}

export interface UnknownDeviceRow {
  providerPublicId: string;
  providerCode: string;
  providerName: string;
  identifier: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  positions: number;
}

const LIST_SQL = `
  SELECT d.id, d.public_id AS "publicId", d.device_identifier AS identifier, d.device_model AS model, d.vehicle_id AS "vehicleId",
         d.provider_id AS "providerId", p.public_id AS "providerPublicId", p.code AS "providerCode", p.name AS "providerName",
         d.token_hash IS NOT NULL AS "hasToken", d.status, d.installed_at AS "installedAt", d.removed_at AS "removedAt",
         d.last_seen_at AS "lastSeenAt", d.last_error_reason AS "lastErrorReason", d.last_error_at AS "lastErrorAt"
    FROM integration.gps_devices d
    LEFT JOIN integration.external_providers p ON p.id = d.provider_id`;

/** integration.gps_devices (FMS-88): trackers installed in vehicles, with their tokens (hashes only). */
export class DeviceRepository extends Repository {
  constructor(db: Pool) {
    super(db);
  }

  inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.transaction(fn);
  }

  pool(): Queryable {
    return this.db;
  }

  /** The active device holding this token (by its SHA-256). */
  async findByTokenHash(db: Queryable, tokenHash: string): Promise<DeviceRow | null> {
    const res = await db.query<DeviceRow>(`${DEVICE_SQL} WHERE d.token_hash = $1 AND d.status = 'active'`, [tokenHash]);
    return res.rows[0] ?? null;
  }

  async findByIdentifier(db: Queryable, identifier: string): Promise<DeviceRow | null> {
    return (await db.query<DeviceRow>(`${DEVICE_SQL} WHERE d.device_identifier = $1`, [identifier])).rows[0] ?? null;
  }

  /** A provider's active devices among these identifiers, keyed by identifier. */
  async providerDevices(db: Queryable, providerId: string, identifiers: readonly string[]): Promise<Map<string, DeviceRow>> {
    if (identifiers.length === 0) return new Map();
    const res = await db.query<DeviceRow>(`${DEVICE_SQL} WHERE d.provider_id = $1 AND d.device_identifier = ANY($2::text[]) AND d.status = 'active'`, [
      providerId,
      identifiers,
    ]);
    return new Map(res.rows.map((r) => [r.identifier, r]));
  }

  /** The vehicle's active device, if it has one (at most one: ux_integration_active_gps_device_vehicle). */
  async activeForVehicle(db: Queryable, vehicleId: string): Promise<DeviceRow | null> {
    return (await db.query<DeviceRow>(`${DEVICE_SQL} WHERE d.vehicle_id = $1 AND d.status = 'active'`, [vehicleId])).rows[0] ?? null;
  }

  /**
   * When each device last reported. Not audited row by row: it is part of the ingested batch, which has
   * its own audit entry.
   */
  async touch(client: PoolClient, deviceIds: readonly string[], at: Date): Promise<void> {
    if (deviceIds.length === 0) return;
    await client.query('UPDATE integration.gps_devices SET last_seen_at = greatest(coalesce(last_seen_at, $2), $2) WHERE id = ANY($1::bigint[])', [deviceIds, at]);
  }

  /**
   * Why each device's last refused position was refused (FMS-138). Not audited, like `touch`: part of the
   * ingested batch.
   */
  async recordErrors(client: PoolClient, errors: ReadonlyMap<string, string>, at: Date): Promise<void> {
    if (errors.size === 0) return;
    await client.query(
      `UPDATE integration.gps_devices d SET last_error_reason = e.reason, last_error_at = $3
         FROM unnest($1::bigint[], $2::text[]) AS e(id, reason)
        WHERE d.id = e.id`,
      [[...errors.keys()], [...errors.values()], at],
    );
  }

  /** The devices on these vehicles (internal ids; null for every vehicle), optionally of one provider (internal id), active first. */
  async list(db: Queryable, vehicleIds: readonly string[] | null, filter: { providerId?: string | null; status?: 'active' | 'removed' }): Promise<DeviceListRow[]> {
    const res = await db.query<DeviceListRow>(
      `${LIST_SQL}
        WHERE ($1::bigint[] IS NULL OR d.vehicle_id = ANY($1::bigint[]))
          AND ($2::bigint IS NULL OR d.provider_id = $2)
          AND ($3::text IS NULL OR ($3 = 'removed') = (d.status = 'removed'))
        ORDER BY (d.status = 'removed'), d.last_seen_at DESC NULLS LAST, d.device_identifier`,
      [vehicleIds, filter.providerId ?? null, filter.status ?? null],
    );
    return res.rows;
  }

  async findListRow(db: Queryable, by: { publicId: string } | { id: string }): Promise<DeviceListRow | null> {
    const res = await db.query<DeviceListRow>(`${LIST_SQL} WHERE ${'publicId' in by ? 'd.public_id = $1::uuid' : 'd.id = $1'}`, ['publicId' in by ? by.publicId : by.id]);
    return res.rows[0] ?? null;
  }

  /**
   * Device ids a provider's signed delivery named that no active device of the provider has, with how many
   * positions each sent. New ones are added while the provider has fewer than `max`.
   */
  async noteUnknown(client: PoolClient, providerId: string, counts: ReadonlyMap<string, number>, at: Date, max: number): Promise<void> {
    if (counts.size === 0) return;
    await client.query(
      `INSERT INTO integration.unknown_devices AS u (provider_id, device_identifier, first_seen_at, last_seen_at, positions)
       SELECT $1, e.identifier, $4, $4, e.n
         FROM unnest($2::text[], $3::int[]) AS e(identifier, n)
        WHERE EXISTS (SELECT 1 FROM integration.unknown_devices k WHERE k.provider_id = $1 AND k.device_identifier = e.identifier)
           OR (SELECT count(*) FROM integration.unknown_devices k WHERE k.provider_id = $1) < $5
       ON CONFLICT (provider_id, device_identifier)
       DO UPDATE SET last_seen_at = greatest(u.last_seen_at, EXCLUDED.last_seen_at), positions = u.positions + EXCLUDED.positions`,
      [providerId, [...counts.keys()], [...counts.values()], at, max],
    );
  }

  /** Unknown devices, newest first. */
  async listUnknown(db: Queryable, limit: number): Promise<UnknownDeviceRow[]> {
    const res = await db.query<UnknownDeviceRow>(
      `SELECT p.public_id AS "providerPublicId", p.code AS "providerCode", p.name AS "providerName", u.device_identifier AS identifier,
              u.first_seen_at AS "firstSeenAt", u.last_seen_at AS "lastSeenAt", u.positions
         FROM integration.unknown_devices u
         JOIN integration.external_providers p ON p.id = u.provider_id
        ORDER BY u.last_seen_at DESC, u.id DESC
        LIMIT $1`,
      [limit],
    );
    return res.rows;
  }

  /** A device once linked is no longer unknown. Bookkeeping, like the counts: not audited. */
  async forgetUnknown(client: PoolClient, providerId: string, identifier: string): Promise<void> {
    await client.query('DELETE FROM integration.unknown_devices WHERE provider_id = $1 AND device_identifier = $2', [providerId, identifier]);
  }

  insert(
    ctx: MutationContext,
    data: { vehicle_id: string; provider_id: string | null; device_identifier: string; device_model: string | null; token_hash: string | null },
    client: PoolClient,
  ) {
    return this.mutate(
      ctx,
      'integration.gps_devices',
      'INSERT',
      null,
      { ...data, status: 'active', installed_at: new Date(), token_issued_at: data.token_hash ? new Date() : null },
      client,
    );
  }

  /** A provider's device linked to a vehicle (FMS-138): active there from now, without a token (its provider signs for it). */
  relink(ctx: MutationContext, id: string, vehicleId: string, model: string | null | undefined, client: PoolClient) {
    return this.mutate(
      ctx,
      'integration.gps_devices',
      'UPDATE',
      id,
      {
        vehicle_id: vehicleId,
        status: 'active',
        installed_at: new Date(),
        removed_at: null,
        token_hash: null,
        token_issued_at: null,
        last_error_reason: null,
        last_error_at: null,
        ...(model !== undefined ? { device_model: model } : {}),
      },
      client,
    );
  }

  /** A new token for a device (the old one stops working), active again on this vehicle. */
  reissue(ctx: MutationContext, id: string, vehicleId: string, tokenHash: string, client: PoolClient) {
    return this.mutate(
      ctx,
      'integration.gps_devices',
      'UPDATE',
      id,
      { vehicle_id: vehicleId, token_hash: tokenHash, token_issued_at: new Date(), status: 'active', removed_at: null },
      client,
    );
  }

  /** Takes a device out of service; its token stops working. */
  remove(ctx: MutationContext, id: string, client: PoolClient) {
    return this.mutate(ctx, 'integration.gps_devices', 'UPDATE', id, { status: 'removed', removed_at: new Date(), token_hash: null }, client);
  }
}

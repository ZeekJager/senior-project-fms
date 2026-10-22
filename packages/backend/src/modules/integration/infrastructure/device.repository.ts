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

  insert(
    ctx: MutationContext,
    data: { vehicle_id: string; provider_id: string | null; device_identifier: string; device_model: string | null; token_hash: string },
    client: PoolClient,
  ) {
    return this.mutate(ctx, 'integration.gps_devices', 'INSERT', null, { ...data, status: 'active', installed_at: new Date(), token_issued_at: new Date() }, client);
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

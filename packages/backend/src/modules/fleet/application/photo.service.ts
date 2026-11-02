import type { Pool, PoolClient } from 'pg';
import type { Readable } from 'node:stream';
import { depotScope, type Scope } from '../../../shared/authz/scope';
import { recordAuditEntry } from '../../../shared/infrastructure/audit-log';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { withTransaction } from '../../../shared/infrastructure/transaction';
import type { DocumentStorage } from '../../../shared/storage/document-storage';
import { noPhoto, photoKey, photoUrl, type PhotoType, type UploadedPhoto } from '../../../shared/storage/photo';
import { vehicleNotFound } from '../domain/vehicle';
import type { Caller } from './caller';

interface VehiclePhotoRow {
  id: string;
  publicId: string;
  key: string | null;
  type: PhotoType | null;
}

type PhotoActor = { userId: string | null; correlationId: string };

export interface FleetPhotoDeps {
  db: Pool;
  storage: DocumentStorage;
  /** A vehicle in the caller's scope, retired included (VehicleRepository.findRef). */
  vehicles: { findRef(db: Queryable, by: { publicId: string }, scope: Scope): Promise<{ id: string; publicId: string } | null> };
  /** Drops the cached vehicle view, so its photo_url changes at once. */
  invalidate(vehicleId: string): Promise<void>;
  /** A driver's internal user id, in the caller's scope (DriverService.accountOf). */
  driverAccount(caller: Caller, driverId: string): Promise<string>;
  /** The auth module's user photos: a driver's photo is their account's. */
  userPhotos: {
    set(actor: PhotoActor, userId: string, photo: UploadedPhoto): Promise<{ photo_url: string }>;
    remove(actor: PhotoActor, userId: string): Promise<void>;
  };
  now?: () => Date;
}

/**
 * Photos of vehicles and drivers (docs/photos.md). A vehicle's is on fleet.vehicles; a driver's is their user
 * account's, set through the auth module so it is the same photo everywhere they appear. Depot scope applies:
 * another depot's vehicle or driver is 404.
 */
export class FleetPhotoService {
  constructor(private readonly deps: FleetPhotoDeps) {}

  async setVehicle(caller: Caller, vehicleId: string, photo: UploadedPhoto): Promise<{ photo_url: string }> {
    const now = this.deps.now?.() ?? new Date();
    const result = await withTransaction(this.deps.db, async (client) => {
      const row = await this.lockVehicle(client, caller, vehicleId);
      const key = photoKey('vehicles', row.publicId, now);
      await this.deps.storage.put(key, photo.bytes, photo.type);
      try {
        await client.query(`UPDATE fleet.vehicles SET photo_key = $2, photo_type = $3, photo_updated_at = $4 WHERE id = $1`, [row.id, key, photo.type, now]);
        await this.audit(client, caller, row.id, 'photo.updated', { type: photo.type, size_bytes: photo.bytes.length });
      } catch (err) {
        await this.deps.storage.remove(key).catch(() => undefined);
        throw err;
      }
      if (row.key) await this.deps.storage.remove(row.key).catch(() => undefined);
      return { photo_url: photoUrl('vehicles', row.publicId, now)! };
    });
    await this.deps.invalidate(vehicleId);
    return result;
  }

  async removeVehicle(caller: Caller, vehicleId: string): Promise<void> {
    await withTransaction(this.deps.db, async (client) => {
      const row = await this.lockVehicle(client, caller, vehicleId);
      if (!row.key) return;
      await client.query(`UPDATE fleet.vehicles SET photo_key = NULL, photo_type = NULL, photo_updated_at = NULL WHERE id = $1`, [row.id]);
      await this.audit(client, caller, row.id, 'photo.removed', {});
      await this.deps.storage.remove(row.key).catch(() => undefined);
    });
    await this.deps.invalidate(vehicleId);
  }

  async readVehicle(caller: Caller, vehicleId: string): Promise<{ stream: Readable; type: PhotoType }> {
    const ref = await this.deps.vehicles.findRef(this.deps.db, { publicId: vehicleId }, depotScope(caller.user));
    if (!ref) throw vehicleNotFound();
    const res = await this.deps.db.query<{ key: string | null; type: PhotoType | null }>(`SELECT photo_key AS key, photo_type AS type FROM fleet.vehicles WHERE id = $1`, [ref.id]);
    const row = res.rows[0];
    if (!row?.key || !row.type) throw noPhoto();
    return { stream: await this.deps.storage.get(row.key), type: row.type };
  }

  async setDriver(caller: Caller, driverId: string, photo: UploadedPhoto): Promise<{ photo_url: string }> {
    const userId = await this.deps.driverAccount(caller, driverId);
    return this.deps.userPhotos.set({ userId: caller.user.id, correlationId: caller.correlationId }, userId, photo);
  }

  async removeDriver(caller: Caller, driverId: string): Promise<void> {
    const userId = await this.deps.driverAccount(caller, driverId);
    await this.deps.userPhotos.remove({ userId: caller.user.id, correlationId: caller.correlationId }, userId);
  }

  private async lockVehicle(client: PoolClient, caller: Caller, vehicleId: string): Promise<VehiclePhotoRow> {
    const ref = await this.deps.vehicles.findRef(client, { publicId: vehicleId }, depotScope(caller.user));
    if (!ref) throw vehicleNotFound();
    const res = await client.query<VehiclePhotoRow>(
      `SELECT id, public_id AS "publicId", photo_key AS key, photo_type AS type FROM fleet.vehicles WHERE id = $1 FOR UPDATE`,
      [ref.id],
    );
    return res.rows[0];
  }

  private audit(client: PoolClient, caller: Caller, vehicleId: string, action: string, details: Record<string, unknown>) {
    return recordAuditEntry(client, { action, userId: caller.user.id, entityType: 'fleet.vehicles', entityId: vehicleId, correlationId: caller.correlationId, details });
  }
}

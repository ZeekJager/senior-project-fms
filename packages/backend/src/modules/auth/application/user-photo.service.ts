import type { Pool, PoolClient } from 'pg';
import type { Readable } from 'node:stream';
import type { RequestUser } from '../../../types/express';
import { recordAuditEntry } from '../../../shared/infrastructure/audit-log';
import { withTransaction } from '../../../shared/infrastructure/transaction';
import type { DocumentStorage } from '../../../shared/storage/document-storage';
import { noPhoto, photoKey, photoUrl, type PhotoColumns, type PhotoType, type UploadedPhoto } from '../../../shared/storage/photo';
import { userNotFound } from '../domain/user-admin';

/** Who may see a colleague's photo: those who see people lists (users, drivers). Everyone sees their own. */
export const PHOTO_VIEWER_PERMISSIONS = ['users:read', 'driver:read'] as const;

/** Who changed it, for the audit trail. */
export interface PhotoActor {
  userId: string | null;
  correlationId: string;
}

interface PhotoRow extends PhotoColumns {
  id: string;
  publicId: string;
}

const lockSql = (by: 'id' | 'public_id') => `
  SELECT id, public_id AS "publicId", photo_key AS key, photo_type AS type, photo_updated_at AS "updatedAt"
    FROM auth.users WHERE ${by} = $1 FOR UPDATE`;

/**
 * Users' photos (docs/photos.md): one per account, for every role. Set by the user (PUT /auth/me/photo), an
 * admin (PUT /users/{id}/photo) or, for a driver, whoever manages drivers (fleet's PUT /drivers/{id}/photo,
 * through `userPhotos` in index.ts). The old file is removed once the new one is recorded.
 */
export class UserPhotoService {
  constructor(
    private readonly deps: { db: Pool; storage: DocumentStorage; now?: () => Date },
  ) {}

  /** Sets the photo of a user by public id (`by: 'publicId'`) or internal id. Returns its new URL. */
  async set(actor: PhotoActor, user: { id?: string; publicId?: string }, photo: UploadedPhoto): Promise<{ photo_url: string }> {
    const now = this.deps.now?.() ?? new Date();
    return withTransaction(this.deps.db, async (client) => {
      const row = await this.lock(client, user);
      const key = photoKey('users', row.publicId, now);
      await this.deps.storage.put(key, photo.bytes, photo.type);
      try {
        await client.query(`UPDATE auth.users SET photo_key = $2, photo_type = $3, photo_updated_at = $4 WHERE id = $1`, [row.id, key, photo.type, now]);
        await this.audit(client, actor, row, 'photo.updated', { type: photo.type, size_bytes: photo.bytes.length });
      } catch (err) {
        await this.deps.storage.remove(key).catch(() => undefined);
        throw err;
      }
      if (row.key) await this.deps.storage.remove(row.key).catch(() => undefined);
      return { photo_url: photoUrl('users', row.publicId, now)! };
    });
  }

  /** Removes the photo; the screens show the placeholder again. Safe to repeat. */
  async remove(actor: PhotoActor, user: { id?: string; publicId?: string }): Promise<void> {
    await withTransaction(this.deps.db, async (client) => {
      const row = await this.lock(client, user);
      if (!row.key) return;
      await client.query(`UPDATE auth.users SET photo_key = NULL, photo_type = NULL, photo_updated_at = NULL WHERE id = $1`, [row.id]);
      await this.audit(client, actor, row, 'photo.removed', {});
      await this.deps.storage.remove(row.key).catch(() => undefined);
    });
  }

  /** GET /users/{id}/photo: the caller's own, or anyone's for those who see people lists; 404 otherwise. */
  async read(caller: RequestUser, publicId: string): Promise<{ stream: Readable; type: PhotoType }> {
    const mayView = caller.publicId === publicId || PHOTO_VIEWER_PERMISSIONS.some((p) => caller.permissions.includes(p));
    if (!mayView) throw noPhoto();
    const res = await this.deps.db.query<{ key: string | null; type: PhotoType | null }>(
      `SELECT photo_key AS key, photo_type AS type FROM auth.users WHERE public_id = $1`,
      [publicId],
    );
    const row = res.rows[0];
    if (!row?.key || !row.type) throw noPhoto();
    return { stream: await this.deps.storage.get(row.key), type: row.type };
  }

  private async lock(client: PoolClient, user: { id?: string; publicId?: string }): Promise<PhotoRow> {
    const res = user.id !== undefined ? await client.query<PhotoRow>(lockSql('id'), [user.id]) : await client.query<PhotoRow>(lockSql('public_id'), [user.publicId]);
    if (!res.rows[0]) throw userNotFound();
    return res.rows[0];
  }

  private audit(client: PoolClient, actor: PhotoActor, row: PhotoRow, action: string, details: Record<string, unknown>) {
    return recordAuditEntry(client, {
      action,
      userId: actor.userId,
      entityType: 'auth.users',
      entityId: row.id,
      correlationId: actor.correlationId,
      details,
    });
  }
}


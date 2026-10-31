import type { Pool, PoolClient } from 'pg';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { Repository } from '../../../shared/infrastructure/repository';
import type { SettingKey } from '../domain/settings';

/** A stored setting. `value` null: changed back to the default. */
export interface SettingRow {
  id: string;
  key: SettingKey;
  value: number | null;
  updatedBy: string | null;
  updatedAt: Date;
}

/** settings.settings (FMS-80). Every write is audited. */
export class SettingsRepository extends Repository {
  constructor(db: Pool) {
    super(db);
  }

  inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.transaction(fn);
  }

  async all(db: Queryable): Promise<SettingRow[]> {
    const res = await db.query<SettingRow>(
      `SELECT id, key, value, updated_by AS "updatedBy", updated_at AS "updatedAt" FROM settings.settings ORDER BY key`,
    );
    return res.rows;
  }

  /** The rows for `keys`, for a change. Changes queue behind each other, so two first changes of a key cannot both insert it. */
  async lock(client: PoolClient, keys: readonly SettingKey[]): Promise<Map<SettingKey, SettingRow>> {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('settings.settings'))`);
    const res = await client.query<SettingRow>(
      `SELECT id, key, value, updated_by AS "updatedBy", updated_at AS "updatedAt" FROM settings.settings WHERE key = ANY($1::text[])`,
      [keys],
    );
    return new Map(res.rows.map((r) => [r.key, r]));
  }

  async insert(client: PoolClient, ctx: MutationContext, key: SettingKey, value: number | null): Promise<void> {
    await this.mutate(ctx, 'settings.settings', 'INSERT', null, { key, value, updated_by: ctx.userId }, client);
  }

  async update(client: PoolClient, ctx: MutationContext, id: string, value: number | null): Promise<void> {
    await this.mutate(ctx, 'settings.settings', 'UPDATE', id, { value, updated_by: ctx.userId }, client);
  }
}

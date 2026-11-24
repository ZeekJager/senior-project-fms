import type { Pool, PoolClient } from 'pg';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { Repository } from '../../../shared/infrastructure/repository';
import type { Definition, ParameterStorage, SystemParameter } from '../domain/registry';
import type { ParameterRules, ParameterType } from '../domain/parameter-types';

/** A stored value (settings.settings). `value` null: back to the default. A secret parameter's is in `secretValue`. */
export interface SettingRow {
  id: string;
  key: string;
  value: unknown;
  secretValue: unknown;
  reason: string | null;
  updatedBy: string | null;
  updatedAt: Date;
}

/** The columns of a value write: jsonb, so each is sent as JSON (null stays SQL NULL: the default). */
export interface ValueColumns {
  value: unknown;
  secretValue: unknown;
  reason: string | null;
}

/** The columns of a new definition. */
export interface NewDefinition {
  key: string;
  label: string;
  category: string;
  description: string;
  type: ParameterType;
  defaultValue: unknown;
  rules: ParameterRules;
  isEnabled: boolean;
  isSecret: boolean;
  requiredPermission: string | null;
}

/** The definition columns a change may set. */
export type DefinitionChange = Partial<{
  label: string;
  category: string;
  description: string;
  defaultValue: unknown;
  rules: ParameterRules;
  isEnabled: boolean;
  requiredPermission: string | null;
}>;

const json = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));

const VALUE_COLUMNS = `id, key, value, secret_value AS "secretValue", reason, updated_by AS "updatedBy", updated_at AS "updatedAt"`;

const DEFINITION_COLUMNS = `id, key, label, category, description, type, default_value AS "defaultValue", rules,
       is_enabled AS "isEnabled", is_system AS "isSystem", is_secret AS "isSecret", required_permission AS "requiredPermission",
       storage, version, value_changed_at AS "valueChangedAt", created_by AS "createdBy", updated_by AS "updatedBy",
       created_at AS "createdAt", updated_at AS "updatedAt"`;

const DEFINITIONS = 'settings.definitions';
const VALUES = 'settings.settings';

/** settings.settings (FMS-80) and settings.definitions (FMS-157). Every write but a version bump is audited. */
export class SettingsRepository extends Repository {
  constructor(db: Pool) {
    super(db);
  }

  inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.transaction(fn);
  }

  async all(db: Queryable): Promise<SettingRow[]> {
    const res = await db.query<SettingRow>(`SELECT ${VALUE_COLUMNS} FROM settings.settings ORDER BY key`);
    return res.rows;
  }

  /** The rows for `keys`, for a change. Changes queue behind each other, so two first changes of a key cannot both insert it. */
  async lock(client: PoolClient, keys: readonly string[]): Promise<Map<string, SettingRow>> {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('settings.settings'))`);
    const res = await client.query<SettingRow>(`SELECT ${VALUE_COLUMNS} FROM settings.settings WHERE key = ANY($1::text[])`, [keys]);
    return new Map(res.rows.map((r) => [r.key, r]));
  }

  /** The id of a key's value row, if it ever had one: its history in the audit trail is that row's. */
  async valueRowId(db: Queryable, key: string): Promise<string | null> {
    const res = await db.query<{ id: string }>(`SELECT id FROM settings.settings WHERE key = $1`, [key]);
    return res.rows[0]?.id ?? null;
  }

  async insert(client: PoolClient, ctx: MutationContext, key: string, v: ValueColumns): Promise<void> {
    await this.mutate(
      ctx,
      VALUES,
      'INSERT',
      null,
      { key, value: json(v.value), secret_value: json(v.secretValue), reason: v.reason, updated_by: ctx.userId },
      client,
    );
  }

  async update(client: PoolClient, ctx: MutationContext, id: string, v: ValueColumns): Promise<void> {
    await this.mutate(ctx, VALUES, 'UPDATE', id, { value: json(v.value), secret_value: json(v.secretValue), reason: v.reason, updated_by: ctx.userId }, client);
  }

  /** The live definitions, by category and label. */
  async definitions(db: Queryable): Promise<Definition[]> {
    const res = await db.query<Definition>(`SELECT ${DEFINITION_COLUMNS} FROM settings.definitions WHERE is_active ORDER BY category, label, key`);
    return res.rows;
  }

  /** A key's live definition, locked for a change. */
  async lockDefinition(client: PoolClient, key: string): Promise<Definition | null> {
    const res = await client.query<Definition>(`SELECT ${DEFINITION_COLUMNS} FROM settings.definitions WHERE key = $1 AND is_active FOR UPDATE`, [key]);
    return res.rows[0] ?? null;
  }

  /** The live definitions of `keys`, locked for a change of their values. */
  async lockDefinitions(client: PoolClient, keys: readonly string[]): Promise<Map<string, Definition>> {
    const res = await client.query<Definition>(
      `SELECT ${DEFINITION_COLUMNS} FROM settings.definitions WHERE key = ANY($1::text[]) AND is_active ORDER BY id FOR UPDATE`,
      [keys],
    );
    return new Map(res.rows.map((d) => [d.key, d]));
  }

  /** Every definition a key has had, deleted ones too, oldest first: their history is in the audit trail. */
  async definitionIds(db: Queryable, key: string): Promise<string[]> {
    const res = await db.query<{ id: string }>(`SELECT id FROM settings.definitions WHERE key = $1 ORDER BY id`, [key]);
    return res.rows.map((r) => r.id);
  }

  async insertDefinition(client: PoolClient, ctx: MutationContext, d: NewDefinition): Promise<string> {
    const row = await this.mutate(
      ctx,
      DEFINITIONS,
      'INSERT',
      null,
      {
        key: d.key,
        label: d.label,
        category: d.category,
        description: d.description,
        type: d.type,
        default_value: json(d.defaultValue),
        rules: JSON.stringify(d.rules),
        is_enabled: d.isEnabled,
        is_secret: d.isSecret,
        required_permission: d.requiredPermission,
        created_by: ctx.userId,
        updated_by: ctx.userId,
      },
      client,
    );
    return String(row.id);
  }

  async updateDefinition(client: PoolClient, ctx: MutationContext, id: string, change: DefinitionChange): Promise<void> {
    const data: Record<string, unknown> = { updated_by: ctx.userId };
    if (change.label !== undefined) data.label = change.label;
    if (change.category !== undefined) data.category = change.category;
    if (change.description !== undefined) data.description = change.description;
    if (change.defaultValue !== undefined) data.default_value = json(change.defaultValue);
    if (change.rules !== undefined) data.rules = JSON.stringify(change.rules);
    if (change.isEnabled !== undefined) data.is_enabled = change.isEnabled;
    if (change.requiredPermission !== undefined) data.required_permission = change.requiredPermission;
    await this.mutate(ctx, DEFINITIONS, 'UPDATE', id, data, client);
  }

  /** Soft: is_active false, audited. The key is free again. */
  async deleteDefinition(client: PoolClient, ctx: MutationContext, id: string): Promise<void> {
    await this.mutate(ctx, DEFINITIONS, 'DELETE', id, { updated_by: ctx.userId }, client);
  }

  /**
   * The values of these definitions changed (audited where the value lives): their version goes up, so an ETag a
   * screen holds is stale. Not audited itself: it records nothing the value's own audit row does not.
   */
  async valuesChanged(client: PoolClient, ids: readonly string[]): Promise<void> {
    if (ids.length) await client.query(`UPDATE settings.definitions SET value_changed_at = CURRENT_TIMESTAMP WHERE id = ANY($1::bigint[])`, [ids]);
  }

  /**
   * The system parameters as the code declares them: inserted when missing, their label, category, description,
   * type, rules, default and storage brought in step when they differ. Whether one is enabled is the administrator's
   * and stays. Concurrent instances do this at once harmlessly: the upsert is one statement per row.
   */
  async syncSystem(db: Queryable, parameters: readonly SystemParameter[]): Promise<string[]> {
    const changed: string[] = [];
    for (const p of parameters) {
      const res = await db.query<{ key: string }>(
        `INSERT INTO settings.definitions AS d (key, label, category, description, type, default_value, rules, is_system, storage)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, TRUE, $8)
         ON CONFLICT (key) WHERE is_active DO UPDATE
            SET label = EXCLUDED.label, category = EXCLUDED.category, description = EXCLUDED.description, type = EXCLUDED.type,
                default_value = EXCLUDED.default_value, rules = EXCLUDED.rules, storage = EXCLUDED.storage, is_system = TRUE
          WHERE (d.label, d.category, d.description, d.type, d.default_value, d.rules, d.storage, d.is_system)
                IS DISTINCT FROM (EXCLUDED.label, EXCLUDED.category, EXCLUDED.description, EXCLUDED.type,
                                  EXCLUDED.default_value, EXCLUDED.rules, EXCLUDED.storage, TRUE)
         RETURNING key`,
        [p.key, p.label, p.category, p.description, p.type, JSON.stringify(p.default_value), JSON.stringify(p.rules), p.storage as ParameterStorage],
      );
      if (res.rows[0]) changed.push(res.rows[0].key);
    }
    return changed;
  }
}

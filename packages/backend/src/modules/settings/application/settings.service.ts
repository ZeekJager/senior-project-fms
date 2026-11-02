import { validationFailed } from '../../../shared/errors/app-error';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { RequestUser } from '../../../types/express';
import {
  SETTING_KEYS,
  type SettingChanges,
  type SettingDefinition,
  type SettingKey,
  type SettingValues,
  type SettingView,
} from '../domain/settings';
import type { SettingRow, SettingsRepository } from '../infrastructure/settings.repository';

export interface Caller {
  user: RequestUser;
  correlationId: string;
}

export interface SettingsServiceDeps {
  db: Queryable;
  settings: SettingsRepository;
  definitions: Record<SettingKey, SettingDefinition>;
  users: { findByIds(db: Queryable, ids: readonly string[]): Promise<{ id: string; publicId: string; fullName: string }[]> };
  now?: () => number;
}

/**
 * Values are re-read from the database at most this often per instance. The instance that saves a change
 * forgets its copy at once; the others follow within this, so a change takes effect everywhere within a
 * minute (FMS-80).
 */
export const SETTINGS_TTL_MS = 30_000;

/** Settings (FMS-80): read by any signed-in user and by the modules whose rules they tune; changed by settings:write. */
export class SettingsService {
  private cached: { values: SettingValues; until: number } | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: SettingsServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Every setting's value, for the modules that apply them. */
  async values(): Promise<SettingValues> {
    if (this.cached && this.cached.until > this.now()) return this.cached.values;
    const values = this.resolve(await this.deps.settings.all(this.deps.db));
    this.cached = { values, until: this.now() + SETTINGS_TTL_MS };
    return values;
  }

  forget(): void {
    this.cached = null;
  }

  async value(key: SettingKey): Promise<number> {
    return (await this.values())[key];
  }

  /** GET /settings. */
  async list(): Promise<SettingView[]> {
    return this.views(await this.deps.settings.all(this.deps.db));
  }

  /**
   * PATCH /settings: every value checked against its range before any is written, all written in one
   * transaction, each an audited change. A value equal to the current one writes nothing.
   */
  async update(caller: Caller, changes: SettingChanges): Promise<SettingView[]> {
    const { definitions } = this.deps;
    const keys = SETTING_KEYS.filter((k) => k in changes);
    const problems = keys.flatMap((key) => {
      const value = changes[key];
      const d = definitions[key];
      return value === null || value === undefined || (value >= d.min && value <= d.max) ? [] : [{ field: key, reason: 'out_of_range' }];
    });
    if (problems.length) throw validationFailed(problems, `Out of range: ${problems.map((p) => `${p.field} (${definitions[p.field].min} to ${definitions[p.field].max})`).join(', ')}.`);

    const ctx = { userId: caller.user.id, correlationId: caller.correlationId };
    await this.deps.settings.inTransaction(async (client) => {
      const current = await this.deps.settings.lock(client, keys);
      for (const key of keys) {
        // The default is stored as NULL, so it follows the code if the default ever changes.
        const value = changes[key] === definitions[key].default ? null : (changes[key] ?? null);
        const row = current.get(key);
        if (!row) {
          if (value !== null) await this.deps.settings.insert(client, ctx, key, value);
        } else if (row.value !== value) {
          await this.deps.settings.update(client, ctx, row.id, value);
        }
      }
    });
    this.forget();
    return this.list();
  }

  private resolve(rows: SettingRow[]): SettingValues {
    const stored = new Map(rows.map((r) => [r.key, r.value]));
    return Object.fromEntries(SETTING_KEYS.map((k) => [k, stored.get(k) ?? this.deps.definitions[k].default])) as SettingValues;
  }

  private async views(rows: SettingRow[]): Promise<SettingView[]> {
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const editorIds = [...new Set(rows.flatMap((r) => (r.updatedBy ? [r.updatedBy] : [])))];
    const editors = new Map((await this.deps.users.findByIds(this.deps.db, editorIds)).map((u) => [u.id, u]));
    return SETTING_KEYS.map((key) => {
      const d = this.deps.definitions[key];
      const row = byKey.get(key);
      const editor = row?.updatedBy ? editors.get(row.updatedBy) : undefined;
      return {
        key,
        value: row?.value ?? d.default,
        default_value: d.default,
        is_default: (row?.value ?? null) === null,
        unit: d.unit,
        min: d.min,
        max: d.max,
        updated_by: editor?.publicId ?? null,
        updated_by_name: editor?.fullName ?? null,
        updated_at: row?.updatedAt.toISOString() ?? null,
      };
    });
  }
}

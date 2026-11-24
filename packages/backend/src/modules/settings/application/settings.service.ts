import { DatabaseError, type PoolClient } from 'pg';
import { validationFailed, type ErrorDetail } from '../../../shared/errors/app-error';
import { aggregateKey, createEvent } from '../../../shared/events/domain-event';
import type { EventBus } from '../../../shared/events/event-bus';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { RequestUser } from '../../../types/express';
import { checkDefinition, checkValue, PARAMETER_TYPES, type ParameterRules, type ParameterType } from '../domain/parameter-types';
import {
  EDITABLE_FIELDS,
  KEY_PATTERN,
  keyTaken,
  notAllowed,
  parameterNotFound,
  precondition,
  SECRET_MASK,
  SETTING_EVENTS,
  systemParameter,
  type Definition,
  type HistoryEntry,
  type ParameterStorage,
  type ParameterView,
  type StoredValue,
  type SystemParameter,
  type ValueChange,
} from '../domain/registry';
import {
  DRIVER_SCORE_WEIGHT_KEYS,
  SETTING_KEYS,
  settingParameters,
  type SettingDefinition,
  type SettingKey,
  type SettingValues,
  type SettingView,
} from '../domain/settings';
import type { DefinitionChange, SettingRow, SettingsRepository } from '../infrastructure/settings.repository';

export interface Caller {
  user: RequestUser;
  correlationId: string;
}

/**
 * Where system parameters of another module keep their values (FMS-157): the driving rules' thresholds stay in the
 * fleet's row of tracking.rule_thresholds, which the integration module owns. That module registers one of these
 * (registerParameterStore), and the registry reads, writes and shows those values through it.
 */
export interface ParameterStore {
  storage: Exclude<ParameterStorage, 'settings'>;
  parameters: readonly SystemParameter[];
  /** The stored values by key: every parameter of the store has one (its default until changed). */
  read(db: Queryable): Promise<Map<string, StoredValue>>;
  /**
   * Sets these values (each already valid for its type; a default is passed as the default's value) on the
   * transaction, audited, after checking the rules between them (a trip is urgent later than it is late...). Throws a
   * 400 when they break one, so nothing is written. `reason` is kept with the change. Returns the keys whose value
   * actually changed.
   */
  write(client: PoolClient, ctx: MutationContext, values: ReadonlyMap<string, unknown>, reason: string | null): Promise<string[]>;
  /** The audited changes of a parameter's value, newest first. */
  history(db: Queryable, key: string): Promise<ValueChange[]>;
}

export interface SettingsServiceDeps {
  db: Queryable;
  settings: SettingsRepository;
  definitions: Record<SettingKey, SettingDefinition>;
  users: { findByIds(db: Queryable, ids: readonly string[]): Promise<{ id: string; publicId: string; fullName: string }[]> };
  events: EventBus;
  /** The audited changes of records, newest first (the audit module's trail). */
  trail: (
    db: Queryable,
    entityType: string,
    ids: readonly string[],
  ) => Promise<{ id: string; at: Date; userId: string | null; action: string; oldValues: Record<string, unknown> | null; newValues: Record<string, unknown> | null }[]>;
  now?: () => number;
}

/**
 * Values are re-read from the database at most this often per instance. The instance that saves a change forgets
 * its copy at once, and every other one when the change's event reaches it over Redis (startSettingsSync), so a
 * change takes effect everywhere within a few seconds; this is the fallback when Redis is down (FMS-80, FMS-157).
 */
export const SETTINGS_TTL_MS = 30_000;

/** A POST /settings/definitions. */
export interface NewParameter {
  key: string;
  label: string;
  category: string;
  description?: string;
  type: ParameterType;
  /** Required: a missing one is refused with the definition's other problems. */
  default_value?: unknown;
  rules?: ParameterRules;
  is_enabled?: boolean;
  is_secret?: boolean;
  required_permission?: string | null;
  /** A value of its own from the start; left out, it answers with the default. */
  value?: unknown;
}

/** A PATCH /settings/definitions/{key}: the definition's fields (custom parameters), enabled, and the value. */
export type ParameterPatch = Partial<{
  label: string;
  category: string;
  description: string;
  default_value: unknown;
  rules: ParameterRules;
  required_permission: string | null;
  is_enabled: boolean;
  /** null: back to the default. */
  value: unknown;
  /** Why: required to change a system parameter's value. */
  reason: string;
}>;

interface Snapshot {
  definitions: Map<string, Definition>;
  values: Map<string, StoredValue>;
  until: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Equal as JSON values: what a jsonb column stores. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => k in b && sameValue(a[k], b[k]));
  }
  return false;
}

const describe = (d: ErrorDetail[], messages: string[]) => validationFailed(d, messages.join(' '));

/**
 * Settings (FMS-80) and the registry of parameters they are part of (FMS-157). Anyone signed in reads the values;
 * settings:write changes them (with a definition's required permission, if it names one); settings:define adds,
 * edits, enables, disables and deletes parameters. Every change is audited and published as an event.
 */
export class SettingsService {
  private snapshot: Snapshot | null = null;
  private synced: Promise<void> | null = null;
  private readonly stores = new Map<string, ParameterStore>();
  private readonly listeners: (() => void)[] = [];
  private readonly now: () => number;

  constructor(private readonly deps: SettingsServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** A module's system parameters kept elsewhere (the driving rules). Registered as the module loads. */
  registerStore(store: ParameterStore): void {
    this.stores.set(store.storage, store);
    this.synced = null;
    this.forget();
  }

  /** Called whenever this instance forgets its copy: a module with its own cache of these values drops it too. */
  onForget(listener: () => void): void {
    this.listeners.push(listener);
  }

  /** Drops this instance's copy: the next read goes to the database. */
  forget(): void {
    this.snapshot = null;
    for (const listener of this.listeners) listener();
  }

  /** The system parameters every module declares, in step with settings.definitions. Once per process (again after a failure). */
  ready(): Promise<void> {
    this.synced ??= (async () => {
      const parameters = [...settingParameters(this.deps.definitions), ...[...this.stores.values()].flatMap((s) => s.parameters)];
      await this.deps.settings.syncSystem(this.deps.db, parameters);
    })().catch((err: unknown) => {
      this.synced = null;
      throw err;
    });
    return this.synced;
  }

  private async load(db: Queryable): Promise<{ definitions: Map<string, Definition>; values: Map<string, StoredValue> }> {
    await this.ready();
    // One after another: they may share one connection.
    const definitions = new Map((await this.deps.settings.definitions(db)).map((d) => [d.key, d]));
    const rows = await this.deps.settings.all(db);
    const values = new Map<string, StoredValue>();
    for (const r of rows) values.set(r.key, { value: r.secretValue ?? r.value ?? null, updatedBy: r.updatedBy, updatedAt: r.updatedAt });
    for (const store of this.stores.values()) for (const [key, v] of await store.read(db)) values.set(key, v);
    return { definitions, values };
  }

  private async current(): Promise<Snapshot> {
    if (this.snapshot && this.snapshot.until > this.now()) return this.snapshot;
    const loaded = await this.load(this.deps.db);
    this.snapshot = { ...loaded, until: this.now() + SETTINGS_TTL_MS };
    return this.snapshot;
  }

  /** What a parameter answers with: its default while disabled or never changed, else its value. */
  private static effective(d: Definition, stored: StoredValue | undefined): unknown {
    if (!d.isEnabled) return d.defaultValue;
    const v = stored?.value;
    return v === null || v === undefined ? d.defaultValue : v;
  }

  /**
   * A parameter's value, for code that applies it (FMS-157): the stored one, or the default while it is disabled or
   * was never changed. A secret's real value. Undefined for a key with no live definition (deleted, or never added).
   */
  async get<T = unknown>(key: string): Promise<T | undefined> {
    const s = await this.current();
    const d = s.definitions.get(key);
    return d ? (SettingsService.effective(d, s.values.get(key)) as T) : undefined;
  }

  /** The defaults of the disabled parameters of a store: a module reading the values itself answers with these instead. */
  async disabledDefaults(storage: ParameterStorage): Promise<Map<string, unknown>> {
    const s = await this.current();
    return new Map([...s.definitions.values()].filter((d) => d.storage === storage && !d.isEnabled).map((d) => [d.key, d.defaultValue]));
  }

  /** Every setting's value, for the modules that apply them. */
  async values(): Promise<SettingValues> {
    const s = await this.current();
    return Object.fromEntries(
      SETTING_KEYS.map((k) => {
        const d = s.definitions.get(k);
        const v = d ? SettingsService.effective(d, s.values.get(k)) : this.deps.definitions[k].default;
        return [k, typeof v === 'number' ? v : this.deps.definitions[k].default];
      }),
    ) as SettingValues;
  }

  async value(key: SettingKey): Promise<number> {
    return (await this.values())[key];
  }

  /** GET /settings: the settings (FMS-80), as before the registry. */
  async list(): Promise<SettingView[]> {
    const { definitions, values } = await this.load(this.deps.db);
    const rows = new Map((await this.deps.settings.all(this.deps.db)).map((r) => [r.key, r]));
    const editors = await this.editors([...rows.values()].map((r) => r.updatedBy));
    return SETTING_KEYS.map((key) => {
      const d = this.deps.definitions[key];
      const def = definitions.get(key);
      const row = rows.get(key);
      const editor = row?.updatedBy ? editors.get(row.updatedBy) : undefined;
      const value = def ? SettingsService.effective(def, values.get(key)) : d.default;
      return {
        key,
        value: typeof value === 'number' ? value : d.default,
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

  /** GET /settings/definitions: every parameter, by category and label. */
  async definitions(): Promise<ParameterView[]> {
    const { definitions, values } = await this.load(this.deps.db);
    return this.views([...definitions.values()], values);
  }

  /** GET /settings/definitions/{key}. */
  async definition(key: string, db: Queryable = this.deps.db): Promise<ParameterView> {
    const { definitions, values } = await this.load(db);
    const d = definitions.get(key);
    if (!d) throw parameterNotFound();
    return (await this.views([d], values, db))[0];
  }

  /** POST /settings/definitions (settings:define): a custom parameter. */
  async define(caller: Caller, input: NewParameter): Promise<ParameterView> {
    await this.ready();
    const problems: ErrorDetail[] = [];
    const messages: string[] = [];
    const key = input.key.trim();
    if (!KEY_PATTERN.test(key)) {
      problems.push({ field: 'key', reason: 'invalid_format' });
      messages.push('The key is 2 to 80 lower-case letters, digits and _, starting with a letter.');
    }
    const rules = input.rules ?? {};
    for (const p of checkDefinition(input.type, rules, input.default_value)) {
      problems.push({ field: p.field, reason: p.reason });
      messages.push(p.message);
    }
    if (problems.length === 0 && input.value !== undefined && input.value !== null) {
      const check = checkValue(input.type, rules, input.value);
      if (!check.ok) {
        problems.push({ field: 'value', reason: check.reason });
        messages.push(check.message);
      }
    }
    if (problems.length) throw describe(problems, messages);

    const ctx = this.context(caller);
    const view = await this.deps.settings.inTransaction(async (client) => {
      try {
        await this.deps.settings.insertDefinition(client, ctx, {
          key,
          label: input.label.trim(),
          category: input.category.trim(),
          description: (input.description ?? '').trim(),
          type: input.type,
          defaultValue: input.default_value,
          rules,
          isEnabled: input.is_enabled ?? true,
          isSecret: input.is_secret ?? false,
          requiredPermission: input.required_permission ?? null,
        });
      } catch (err) {
        throw this.translate(err, key);
      }
      // A key used before (a custom parameter deleted since) may still have a value row: start from the default.
      const d = (await this.deps.settings.lockDefinition(client, key))!;
      await this.writeValues(client, caller, new Map([[key, d]]), new Map([[key, input.value ?? null]]), null, { publish: false, touch: false });
      await this.publish(client, caller, SETTING_EVENTS.defined, d, { type: d.type, category: d.category, is_secret: d.isSecret });
      return this.definition(key, client);
    });
    this.forget();
    return view;
  }

  /**
   * PATCH /settings/definitions/{key}: a custom parameter's definition (settings:define), whether it is enabled
   * (settings:define), and its value (settings:write, and the definition's required permission). A system parameter's
   * value needs a reason. `expectedVersion` from If-Match: an older one is 412, not an overwrite.
   */
  async updateDefinition(caller: Caller, key: string, patch: ParameterPatch, expectedVersion: number | null): Promise<ParameterView> {
    await this.ready();
    const editing = EDITABLE_FIELDS.filter((f) => f in patch);
    const enabling = patch.is_enabled !== undefined;
    const valuing = 'value' in patch;
    if ((editing.length || enabling) && !caller.user.permissions.includes('settings:define')) throw notAllowed('settings:define');
    if (valuing && !caller.user.permissions.includes('settings:write')) throw notAllowed('settings:write');

    const ctx = this.context(caller);
    const view = await this.deps.settings.inTransaction(async (client) => {
      const d = await this.deps.settings.lockDefinition(client, key);
      if (!d) throw parameterNotFound();
      if (expectedVersion !== null && expectedVersion !== d.version) throw precondition();
      if (editing.length && d.isSystem) throw systemParameter('cannot be edited, only its value and whether it is enabled');
      if (valuing && d.requiredPermission && !caller.user.permissions.includes(d.requiredPermission)) throw notAllowed(d.requiredPermission);
      const reason = patch.reason?.trim() || null;
      if (valuing && d.isSystem && !reason) {
        throw validationFailed([{ field: 'reason', reason: 'required' }], 'Say why: a system parameter changes how FMS works for everyone.');
      }

      const change: DefinitionChange = {};
      if (editing.length) {
        const rules = patch.rules ?? d.rules;
        const defaultValue = 'default_value' in patch ? patch.default_value : d.defaultValue;
        const problems = checkDefinition(d.type, rules, defaultValue);
        if (problems.length) throw describe(problems.map((p) => ({ field: p.field, reason: p.reason })), problems.map((p) => p.message));
        // The value it has must still fit, unless this save replaces it too.
        const stored = (await this.load(client)).values.get(key)?.value ?? null;
        if (!valuing && stored !== null && !checkValue(d.type, rules, stored).ok) {
          throw validationFailed([{ field: 'rules', reason: 'invalid_rules' }], 'Its current value does not fit these rules: change it in the same save, or reset it first.');
        }
        if (patch.label !== undefined && patch.label.trim() !== d.label) change.label = patch.label.trim();
        if (patch.category !== undefined && patch.category.trim() !== d.category) change.category = patch.category.trim();
        if (patch.description !== undefined && patch.description.trim() !== d.description) change.description = patch.description.trim();
        if ('default_value' in patch && !sameValue(defaultValue, d.defaultValue)) change.defaultValue = defaultValue;
        if (patch.rules !== undefined && !sameValue(rules, d.rules)) change.rules = rules;
        if ('required_permission' in patch && (patch.required_permission ?? null) !== d.requiredPermission) change.requiredPermission = patch.required_permission ?? null;
      }
      if (enabling && patch.is_enabled !== d.isEnabled) change.isEnabled = patch.is_enabled;

      if (Object.keys(change).length) {
        try {
          await this.deps.settings.updateDefinition(client, ctx, d.id, change);
        } catch (err) {
          throw this.translate(err, key);
        }
      }
      const fields = Object.keys(change).filter((f) => f !== 'isEnabled');
      if (fields.length) await this.publish(client, caller, SETTING_EVENTS.changed, d, { fields: fields.map(snake), value_changed: false });
      if (change.isEnabled !== undefined) await this.publish(client, caller, change.isEnabled ? SETTING_EVENTS.enabled : SETTING_EVENTS.disabled, d, {});

      if (valuing) {
        const current = (await this.deps.settings.lockDefinition(client, key))!;
        const value = patch.value ?? null;
        if (value !== null) {
          const check = checkValue(current.type, current.rules, value);
          if (!check.ok) throw validationFailed([{ field: 'value', reason: check.reason }], check.message);
        }
        await this.checkGroups(new Map([[key, value]]));
        await this.writeValues(client, caller, new Map([[key, current]]), new Map([[key, value]]), reason);
      }
      return this.definition(key, client);
    });
    this.forget();
    return view;
  }

  /** DELETE /settings/definitions/{key} (settings:define): a custom parameter, soft. Its value goes back to nothing. */
  async remove(caller: Caller, key: string, expectedVersion: number | null): Promise<void> {
    await this.ready();
    const ctx = this.context(caller);
    await this.deps.settings.inTransaction(async (client) => {
      const d = await this.deps.settings.lockDefinition(client, key);
      if (!d) throw parameterNotFound();
      if (d.isSystem) throw systemParameter('cannot be deleted; disable it instead, and it answers with its default');
      if (expectedVersion !== null && expectedVersion !== d.version) throw precondition();
      await this.writeValues(client, caller, new Map([[key, d]]), new Map([[key, null]]), 'Parameter deleted', { publish: false, touch: false });
      await this.deps.settings.deleteDefinition(client, ctx, d.id);
      await this.publish(client, caller, SETTING_EVENTS.deleted, d, {});
    });
    this.forget();
  }

  /**
   * PATCH /settings: values of any parameters, by key; null (or the default itself) goes back to the default. Every
   * value is checked against its type and rules before any is written (400 with a reason per field), then all are
   * written in one transaction, each an audited change. A value equal to the current one writes nothing. Answers
   * with GET /settings.
   */
  async update(caller: Caller, changes: Record<string, unknown>): Promise<SettingView[]> {
    await this.ready();
    const keys = Object.keys(changes);
    const { definitions } = await this.load(this.deps.db);
    const problems: ErrorDetail[] = [];
    const messages: string[] = [];
    const ranges: string[] = [];
    for (const key of keys) {
      const d = definitions.get(key);
      const value = changes[key];
      if (!d) {
        problems.push({ field: key, reason: 'unknown_parameter' });
        messages.push(`No parameter ${key}.`);
        continue;
      }
      if (value === null) continue;
      const check = checkValue(d.type, d.rules, value);
      if (!check.ok) {
        problems.push({ field: key, reason: check.reason });
        if (check.reason === 'out_of_range' && d.rules.min !== undefined && d.rules.max !== undefined) ranges.push(`${key} (${d.rules.min} to ${d.rules.max})`);
        else messages.push(`${key}: ${check.message}`);
      }
    }
    if (problems.length) {
      throw validationFailed(problems, ranges.length === problems.length ? `Out of range: ${ranges.join(', ')}.` : [...messages, ...(ranges.length ? [`Out of range: ${ranges.join(', ')}.`] : [])].join(' '));
    }
    for (const key of keys) {
      const required = definitions.get(key)!.requiredPermission;
      if (required && !caller.user.permissions.includes(required)) throw notAllowed(required);
    }
    await this.checkGroups(new Map(keys.map((k) => [k, changes[k]])));

    await this.deps.settings.inTransaction(async (client) => {
      const locked = await this.deps.settings.lockDefinitions(client, keys);
      // Deleted in between: refused like an unknown key, and nothing written.
      const gone = keys.filter((k) => !locked.has(k));
      if (gone.length) throw validationFailed(gone.map((field) => ({ field, reason: 'unknown_parameter' })), `No parameter ${gone.join(', ')}.`);
      await this.writeValues(client, caller, locked, new Map(keys.map((k) => [k, changes[k]])), null);
    });
    this.forget();
    return this.list();
  }

  /** GET /settings/definitions/{key}/history: who changed what, when and why, newest first. */
  async history(key: string): Promise<HistoryEntry[]> {
    const { definitions } = await this.load(this.deps.db);
    const d = definitions.get(key);
    if (!d) throw parameterNotFound();
    const { db, settings, trail } = this.deps;
    const entries: (Omit<HistoryEntry, 'at' | 'by' | 'by_name'> & { id: string; at: Date; userId: string | null })[] = [];
    const mask = (v: unknown) => (v === null || v === undefined ? null : d.isSecret ? SECRET_MASK : v);

    const store = this.stores.get(d.storage);
    if (store) {
      for (const c of await store.history(db, key)) {
        entries.push({ id: c.id, at: c.at, userId: c.userId, change: 'value', old_value: mask(c.oldValue), new_value: mask(c.newValue), fields: [], reason: c.reason });
      }
    } else {
      const rowId = await settings.valueRowId(db, key);
      for (const r of rowId ? await trail(db, 'settings.settings', [rowId]) : []) {
        // A deleted parameter's earlier life is not this one's.
        if (!d.isSystem && r.at < d.createdAt) continue;
        const pick = (v: Record<string, unknown> | null) => (v ? (v.secret_value !== undefined && v.secret_value !== null ? v.secret_value : (v.value ?? null)) : null);
        const before = r.action === 'INSERT' ? null : pick(r.oldValues);
        const after = pick(r.newValues);
        // A secret's are [REDACTED] in the trail, so two of them look alike: every audited write of one is a change.
        if (!d.isSecret && sameValue(before, after)) continue;
        entries.push({
          id: r.id,
          at: r.at,
          userId: r.userId,
          change: 'value',
          old_value: mask(before),
          new_value: mask(after),
          fields: [],
          reason: (r.newValues?.reason as string | null | undefined) ?? null,
        });
      }
    }

    for (const r of await trail(db, 'settings.definitions', [d.id])) {
      const before = r.oldValues ?? {};
      const after = r.newValues ?? {};
      if (r.action === 'INSERT') {
        entries.push({ id: r.id, at: r.at, userId: r.userId, change: 'defined', old_value: null, new_value: null, fields: [], reason: null });
        continue;
      }
      if (before.is_enabled !== after.is_enabled) {
        entries.push({ id: r.id, at: r.at, userId: r.userId, change: after.is_enabled ? 'enabled' : 'disabled', old_value: null, new_value: null, fields: [], reason: null });
      }
      if (before.is_active === true && after.is_active === false) {
        entries.push({ id: r.id, at: r.at, userId: r.userId, change: 'deleted', old_value: null, new_value: null, fields: [], reason: null });
      }
      const fields = ['label', 'category', 'description', 'default_value', 'rules', 'required_permission'].filter((f) => !sameValue(before[f], after[f]));
      if (fields.length) entries.push({ id: r.id, at: r.at, userId: r.userId, change: 'edited', old_value: null, new_value: null, fields, reason: null });
    }

    const editors = await this.editors(entries.map((e) => e.userId));
    return entries
      .sort((a, b) => b.at.getTime() - a.at.getTime() || Number(b.id) - Number(a.id))
      .map(({ id, at, userId, ...rest }) => {
        void id;
        const editor = userId ? editors.get(userId) : undefined;
        return { at: at.toISOString(), ...rest, by: editor?.publicId ?? null, by_name: editor?.fullName ?? null };
      });
  }

  /** The values of these definitions changed elsewhere (a driving rules PUT): their ETags move on, and the change is published. */
  async valuesChangedElsewhere(client: PoolClient, caller: Caller, keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    const locked = await this.deps.settings.lockDefinitions(client, keys);
    await this.deps.settings.valuesChanged(client, [...locked.values()].map((d) => d.id));
    for (const d of locked.values()) await this.publish(client, caller, SETTING_EVENTS.changed, d, { value_changed: true, fields: [] });
    this.forget();
  }

  /**
   * Rules between parameters of this module: the driver score's weights may each be 0, but not all of them (FMS-146).
   * A store checks its own (write).
   */
  private async checkGroups(changes: ReadonlyMap<string, unknown>): Promise<void> {
    if (!DRIVER_SCORE_WEIGHT_KEYS.some((k) => changes.has(k))) return;
    const current = await this.values();
    const { definitions } = this.deps;
    const after = DRIVER_SCORE_WEIGHT_KEYS.map((k) => (changes.has(k) ? (changes.get(k) ?? definitions[k].default) : current[k]));
    if (after.every((w) => w === 0)) {
      throw validationFailed(
        DRIVER_SCORE_WEIGHT_KEYS.filter((k) => changes.has(k)).map((field) => ({ field, reason: 'all_zero' })),
        'The driver score needs at least one weight above 0.',
      );
    }
  }

  /**
   * Writes values already checked, on the transaction: settings.settings for this module's (the default stored as
   * NULL, so it follows the definition's default if that changes; a secret's in secret_value, which the audit trail
   * never copies), the store for the others. The definitions whose value changed get a new version and an event.
   */
  private async writeValues(
    client: PoolClient,
    caller: Caller,
    definitions: ReadonlyMap<string, Definition>,
    changes: ReadonlyMap<string, unknown>,
    reason: string | null,
    options: { publish?: boolean; touch?: boolean } = {},
  ): Promise<string[]> {
    const ctx = this.context(caller);
    const own = [...changes.keys()].filter((k) => definitions.get(k)!.storage === 'settings');
    const changed: string[] = [];
    if (own.length) {
      const rows = await this.deps.settings.lock(client, own);
      for (const key of own) {
        const d = definitions.get(key)!;
        const wanted = changes.get(key) ?? null;
        const stored = wanted === null || sameValue(wanted, d.defaultValue) ? null : wanted;
        const row: SettingRow | undefined = rows.get(key);
        const columns = { value: d.isSecret ? null : stored, secretValue: d.isSecret ? stored : null, reason };
        if (!row) {
          if (stored !== null) {
            await this.deps.settings.insert(client, ctx, key, columns);
            changed.push(key);
          }
        } else if (!sameValue(row.value ?? null, columns.value) || !sameValue(row.secretValue ?? null, columns.secretValue)) {
          await this.deps.settings.update(client, ctx, row.id, columns);
          changed.push(key);
        }
      }
    }
    for (const store of this.stores.values()) {
      const keys = [...changes.keys()].filter((k) => definitions.get(k)!.storage === store.storage);
      if (keys.length === 0) continue;
      const values = new Map(keys.map((k) => [k, changes.get(k) ?? definitions.get(k)!.defaultValue]));
      changed.push(...(await store.write(client, ctx, values, reason)));
    }
    if (options.touch !== false) await this.deps.settings.valuesChanged(client, changed.map((k) => definitions.get(k)!.id));
    if (options.publish !== false) {
      for (const key of changed) await this.publish(client, caller, SETTING_EVENTS.changed, definitions.get(key)!, { value_changed: true, fields: [] });
    }
    return changed;
  }

  private async views(definitions: Definition[], values: Map<string, StoredValue>, db: Queryable = this.deps.db): Promise<ParameterView[]> {
    const editors = await this.editors(definitions.map((d) => values.get(d.key)?.updatedBy ?? null), db);
    return definitions.map((d) => {
      const stored = values.get(d.key);
      const store = this.stores.get(d.storage);
      // A store's parameters always have a value; theirs is "the default" while it equals it.
      const isDefault = store ? stored === undefined || sameValue(stored.value, d.defaultValue) : (stored?.value ?? null) === null;
      const editor = stored?.updatedBy ? editors.get(stored.updatedBy) : undefined;
      return {
        key: d.key,
        label: d.label,
        category: d.category,
        description: d.description,
        type: d.type,
        rules: d.rules,
        default_value: d.isSecret ? null : d.defaultValue,
        value: d.isSecret ? null : SettingsService.effective(d, stored),
        is_default: isDefault,
        is_enabled: d.isEnabled,
        is_system: d.isSystem,
        is_secret: d.isSecret,
        has_value: d.isSecret ? !isDefault : true,
        required_permission: d.requiredPermission,
        storage: d.storage,
        version: d.version,
        value_changed_at: (d.valueChangedAt ?? (isDefault ? null : (stored?.updatedAt ?? null)))?.toISOString() ?? null,
        value_changed_by: editor?.publicId ?? null,
        value_changed_by_name: editor?.fullName ?? null,
        created_at: d.createdAt.toISOString(),
        updated_at: d.updatedAt.toISOString(),
      };
    });
  }

  private async editors(ids: (string | null)[], db: Queryable = this.deps.db) {
    const unique = [...new Set(ids.filter((id): id is string => id !== null))];
    return new Map((await this.deps.users.findByIds(db, unique)).map((u) => [u.id, u]));
  }

  private context(caller: Caller): MutationContext {
    return { userId: caller.user.id, correlationId: caller.correlationId };
  }

  /** Into the outbox on the change's transaction; ordered per parameter. The payload names it, never its value. */
  private publish(client: PoolClient, caller: Caller, type: string, d: Definition, extra: Record<string, unknown>): Promise<void> {
    const ctx = { actor: caller.user.publicId ?? null, correlationId: caller.correlationId };
    const payload = { key: d.key, is_system: d.isSystem, storage: d.storage, ...extra };
    return this.deps.events.publish(client, [createEvent(type, payload, ctx, { aggregate: aggregateKey('setting', d.key) })]);
  }

  /** A unique key taken in between, or a required permission that does not exist. */
  private translate(err: unknown, key: string): unknown {
    if (err instanceof DatabaseError && err.code === '23505') return keyTaken(key);
    if (err instanceof DatabaseError && err.code === '23503') {
      return validationFailed([{ field: 'required_permission', reason: 'unknown_permission' }], 'No such permission.');
    }
    return err;
  }
}

const snake = (field: string) => field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

export { PARAMETER_TYPES };

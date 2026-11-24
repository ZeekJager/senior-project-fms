import { AppError } from '../../../shared/errors/app-error';
import type { ParameterRules, ParameterType } from './parameter-types';

// The settings registry (FMS-157, ADR-09, docs/settings.md): every parameter an administrator tunes without a code
// change, with its type, rules and default, in settings.definitions. System parameters are declared in code by the
// module whose rule they tune; custom ones are added on the Settings screen and read in code with settings.get().

/** Where a parameter's value lives: settings.settings, or the fleet's row of tracking.rule_thresholds (the driving rules). */
export type ParameterStorage = 'settings' | 'rule_thresholds';

/** A system parameter as the code declares it. The registry keeps its row in step on start. */
export interface SystemParameter {
  key: string;
  label: string;
  category: string;
  description: string;
  type: ParameterType;
  default_value: unknown;
  rules: ParameterRules;
  storage: ParameterStorage;
}

/** A row of settings.definitions. Internal ids. */
export interface Definition {
  id: string;
  key: string;
  label: string;
  category: string;
  description: string;
  type: ParameterType;
  defaultValue: unknown;
  rules: ParameterRules;
  isEnabled: boolean;
  isSystem: boolean;
  isSecret: boolean;
  requiredPermission: string | null;
  storage: ParameterStorage;
  version: number;
  valueChangedAt: Date | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A parameter's current value: what is stored (null: never changed, or put back to the default), and who changed it last. */
export interface StoredValue {
  value: unknown;
  updatedBy: string | null;
  updatedAt: Date | null;
}

/** A parameter as the registry's endpoints return it. A secret's values are never in it. */
export interface ParameterView {
  key: string;
  label: string;
  category: string;
  description: string;
  type: ParameterType;
  rules: ParameterRules;
  /** The default, and the value it answers with now (the default while disabled); null for a secret. */
  default_value: unknown;
  value: unknown;
  /** No value of its own: it answers with the default. */
  is_default: boolean;
  is_enabled: boolean;
  is_system: boolean;
  is_secret: boolean;
  /** For a secret: whether a value is set. Always true otherwise. */
  has_value: boolean;
  required_permission: string | null;
  storage: ParameterStorage;
  /** The ETag: bumped by every change of the definition or the value. */
  version: number;
  value_changed_at: string | null;
  value_changed_by: string | null;
  value_changed_by_name: string | null;
  created_at: string;
  updated_at: string;
}

/** One change in a parameter's history (GET /settings/definitions/{key}/history), newest first. */
export interface HistoryEntry {
  at: string;
  /** `value` (the value changed, or went back to the default with null), or what happened to the definition. */
  change: 'value' | 'defined' | 'edited' | 'enabled' | 'disabled' | 'deleted';
  /** For a value change: before and after; null is the default. A secret's are never shown. */
  old_value: unknown;
  new_value: unknown;
  /** For an edit: the fields of the definition it changed. */
  fields: string[];
  reason: string | null;
  by: string | null;
  by_name: string | null;
}

/** An audited change of a value, as a store reads it from the audit trail. */
export interface ValueChange {
  /** The audit row's id: orders changes made at the same instant. */
  id: string;
  at: Date;
  userId: string | null;
  oldValue: unknown;
  newValue: unknown;
  reason: string | null;
}

/** The settings events (CONVENTIONS.md, Events: past-tense facts). The payload names the parameter; never its value. */
export const SETTING_EVENTS = {
  defined: 'SettingDefined',
  changed: 'SettingChanged',
  enabled: 'SettingEnabled',
  disabled: 'SettingDisabled',
  deleted: 'SettingDeleted',
} as const;

/** A secret's value in the history and the audit trail. */
export const MASKED_VALUE = '[SECRET]';

/** The definition fields a PATCH may change on a custom parameter. A system parameter's come from the code. */
export const EDITABLE_FIELDS = ['label', 'category', 'description', 'default_value', 'rules', 'required_permission'] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

export const KEY_PATTERN = /^[a-z][a-z0-9_]{1,79}$/;

export const parameterNotFound = () => new AppError(404, 'NOT_FOUND', 'No such settings parameter.');

export const systemParameter = (what: string) =>
  new AppError(409, 'CONFLICT_SYSTEM_PARAMETER', `A system parameter ${what}: the code it tunes declares it.`, [{ reason: 'system_parameter' }]);

export const keyTaken = (key: string) =>
  new AppError(409, 'CONFLICT_DUPLICATE', `A parameter ${key} already exists.`, [{ field: 'key', reason: 'key_taken' }]);

/** If-Match named an older version: someone else saved in between (RFC 9110 §13.1.1). */
export const precondition = () =>
  new AppError(412, 'PRECONDITION_FAILED', 'Someone else changed this parameter since you opened it. Reload it and try again.', [{ reason: 'stale_version' }]);

export const notAllowed = (permission: string) =>
  new AppError(403, 'FORBIDDEN_INSUFFICIENT_ROLE', `You need the ${permission} permission to do this.`, [{ reason: 'missing_permission', field: permission }]);

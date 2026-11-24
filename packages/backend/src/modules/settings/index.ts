import type Redis from 'ioredis';
import type { PoolClient } from 'pg';
import { config } from '../../config';
import { pool } from '../../db';
import { eventChannel, eventBus } from '../../shared/events/event-bus';
import { logger } from '../../shared/logging/logger';
import type { AppModule } from '../../shared/module';
import { auditTrail } from '../audit';
import { userDirectory } from '../auth';
import { settingsRouter } from './api/settings.routes';
import { SettingsService, type Caller, type ParameterStore } from './application/settings.service';
import type { ParameterStorage } from './domain/registry';
import { settingDefinitions, type SettingKey } from './domain/settings';
import { SettingsRepository } from './infrastructure/settings.repository';

// Settings an administrator tunes without a code change (FMS-80, FMS-157, docs/settings.md): a registry of typed
// parameters with defaults, rules, history and access control. Other modules read the values through `settings`
// below; a module whose parameters keep their values in its own tables registers a store (the driving rules).

const service = new SettingsService({
  db: pool,
  settings: new SettingsRepository(pool),
  definitions: settingDefinitions({ fuelVarianceThresholdPct: config.fuel.varianceThresholdPct }),
  users: userDirectory,
  events: eventBus,
  trail: (db, entityType, ids) => auditTrail.records(db, entityType, ids),
});

export const settingsModule: AppModule = { name: 'settings', router: settingsRouter(service) };

/** The current values, cached for at most SETTINGS_TTL_MS per instance, and dropped as soon as one changes anywhere. */
export const settings = {
  /** One of the FMS-80 settings, a whole number. */
  value: (key: SettingKey) => service.value(key),
  values: () => service.values(),
  /**
   * Any parameter's value (FMS-157), custom ones included: the stored value, or the default while it is disabled or
   * was never changed. Undefined for a key with no live definition.
   *
   *     const cutoff = (await settings.get<number>('report_cutoff_hour')) ?? 18;
   */
  get: <T = unknown>(key: string) => service.get<T>(key),
  /** The defaults of a store's disabled parameters, for a module that reads those values from its own tables. */
  disabledDefaults: (storage: ParameterStorage) => service.disabledDefaults(storage),
  /** Drops this instance's copy: the next read goes to the database. Also for tests, which roll back their changes. */
  forget: () => service.forget(),
  /** Called whenever this instance forgets its copy, so a module's own cache of these values is dropped with it. */
  onForget: (listener: () => void) => service.onForget(listener),
  /** A module's system parameters kept in its own tables (ParameterStore). */
  registerStore: (store: ParameterStore) => service.registerStore(store),
  /** A store's values changed outside the registry's endpoints, on this transaction: their ETags move on and the change is published. */
  valuesChangedElsewhere: (client: PoolClient, caller: Caller, keys: readonly string[]) => service.valuesChangedElsewhere(client, caller, keys),
};

/**
 * Every instance forgets its copy the moment a parameter changes anywhere: the outbox relay publishes each settings
 * event on Redis (`<prefix>:events:Setting*`), and this listens. Without Redis (one instance) the instance that saved
 * already forgot; SETTINGS_TTL_MS is the fallback either way. Started by src/server.ts; returns a stop function.
 */
export function startSettingsSync(redis: Redis | null): () => Promise<void> {
  if (!redis) return async () => undefined;
  const sub = redis.duplicate({ enableOfflineQueue: true, commandTimeout: undefined });
  sub.on('pmessage', () => service.forget());
  sub.on('error', (err: Error) => logger.warn({ err: err.message }, 'settings sync: redis error'));
  sub.psubscribe(eventChannel('Setting*')).catch((err: unknown) => logger.warn({ err: (err as Error).message }, 'settings sync: could not subscribe'));
  return async () => {
    await sub.quit().catch(() => undefined);
  };
}

export { SETTINGS_TTL_MS, type ParameterStore, type Caller as SettingsCaller } from './application/settings.service';
export { SETTING_KEYS, type SettingKey, type SettingValues } from './domain/settings';
export { checkValue, type ParameterRules, type ParameterType } from './domain/parameter-types';
export type { ParameterStorage, StoredValue, SystemParameter, ValueChange } from './domain/registry';

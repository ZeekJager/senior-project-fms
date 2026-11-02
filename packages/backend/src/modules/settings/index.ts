import { config } from '../../config';
import { pool } from '../../db';
import type { AppModule } from '../../shared/module';
import { userDirectory } from '../auth';
import { settingsRouter } from './api/settings.routes';
import { SettingsService } from './application/settings.service';
import { settingDefinitions, type SettingKey } from './domain/settings';
import { SettingsRepository } from './infrastructure/settings.repository';

// Settings an administrator tunes without a code change (FMS-80, docs/settings.md). Other modules read the
// values through `settings` below; the telemetry rules' thresholds are the integration module's.

const service = new SettingsService({
  db: pool,
  settings: new SettingsRepository(pool),
  definitions: settingDefinitions({ fuelVarianceThresholdPct: config.fuel.varianceThresholdPct }),
  users: userDirectory,
});

export const settingsModule: AppModule = { name: 'settings', router: settingsRouter(service) };

/** The current values, cached for at most SETTINGS_TTL_MS per instance. */
export const settings = {
  value: (key: SettingKey) => service.value(key),
  values: () => service.values(),
  /** Drops this instance's copy: the next read goes to the database. For tests, which roll back their changes. */
  forget: () => service.forget(),
};

export { SETTINGS_TTL_MS } from './application/settings.service';
export { SETTING_KEYS, type SettingKey, type SettingValues } from './domain/settings';

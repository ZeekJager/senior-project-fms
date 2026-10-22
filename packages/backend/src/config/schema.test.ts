import { test } from 'vitest';
import assert from 'node:assert/strict';
import { ConfigError, loadAppConfig, loadMigrationConfig, PLACEHOLDER } from './schema';

const validEnv = {
  DB_HOST: 'localhost',
  DB_NAME: 'fms_db',
  DB_USER: 'fms_app',
  DB_PASSWORD: 'app-secret',
  JWT_SECRET: 'x'.repeat(32),
};

function problems(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    return err.problems;
  }
  assert.fail('expected a ConfigError');
}

test('valid environment loads with defaults', () => {
  const cfg = loadAppConfig(validEnv);
  assert.equal(cfg.nodeEnv, 'development');
  assert.equal(cfg.port, 3000);
  assert.deepEqual(cfg.db, { host: 'localhost', port: 5432, database: 'fms_db', user: 'fms_app', password: 'app-secret' });
});

test('missing JWT secret is refused', () => {
  const env: Record<string, string> = { ...validEnv };
  delete env.JWT_SECRET;
  assert.deepEqual(problems(() => loadAppConfig(env)).map((p) => p.split(':')[0]), ['JWT_SECRET']);
});

test('every problem is reported at once', () => {
  const found = problems(() => loadAppConfig({ PORT: 'abc', JWT_SECRET: 'short' }));
  for (const key of ['PORT', 'DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'JWT_SECRET']) {
    assert.ok(found.some((p) => p.startsWith(key)), `expected a problem for ${key}`);
  }
});

test('blank values count as missing', () => {
  assert.ok(problems(() => loadAppConfig({ ...validEnv, DB_PASSWORD: '  ' })).some((p) => p.startsWith('DB_PASSWORD')));
});

test('production refuses the .env.example placeholder', () => {
  const env = { ...validEnv, NODE_ENV: 'production', DB_PASSWORD: PLACEHOLDER, JWT_SECRET: `${PLACEHOLDER}-${'x'.repeat(32)}` };
  const found = problems(() => loadAppConfig(env));
  assert.ok(found.some((p) => p.startsWith('DB_PASSWORD')));
  assert.ok(found.some((p) => p.startsWith('JWT_SECRET')));
});

test('development tolerates the placeholder password', () => {
  assert.equal(loadAppConfig({ ...validEnv, DB_PASSWORD: PLACEHOLDER }).db.password, PLACEHOLDER);
});

test('migration config uses the admin credentials', () => {
  const db = loadMigrationConfig({ DB_HOST: 'h', DB_NAME: 'd', DB_ADMIN_USER: 'fms_admin', DB_ADMIN_PASSWORD: 'p', DB_PORT: '6543' });
  assert.deepEqual(db, { host: 'h', port: 6543, database: 'd', user: 'fms_admin', password: 'p' });
  assert.ok(problems(() => loadMigrationConfig({ DB_HOST: 'h', DB_NAME: 'd' })).some((p) => p.startsWith('DB_ADMIN_PASSWORD')));
});

test('real-time: allowed origins as a comma-separated list, legacy location off by default (FMS-43)', () => {
  assert.deepEqual(loadAppConfig(validEnv).realtime, { allowedOrigins: [], legacyLocation: false });
  const cfg = loadAppConfig({ ...validEnv, REALTIME_ALLOWED_ORIGINS: ' https://fleet.example.com/ , http://localhost:5173', REALTIME_LEGACY_LOCATION: 'true' });
  assert.deepEqual(cfg.realtime, { allowedOrigins: ['https://fleet.example.com', 'http://localhost:5173'], legacyLocation: true });
  assert.ok(problems(() => loadAppConfig({ ...validEnv, REALTIME_ALLOWED_ORIGINS: 'fleet.example.com' })).some((p) => p.startsWith('REALTIME_ALLOWED_ORIGINS')));
  assert.ok(problems(() => loadAppConfig({ ...validEnv, REALTIME_LEGACY_LOCATION: 'yes' })).some((p) => p.startsWith('REALTIME_LEGACY_LOCATION')));
});

test('integration secrets are read by provider code from INTEGRATION_<CODE>_* (FMS-85)', () => {
  assert.deepEqual(loadAppConfig(validEnv).integrations, { secrets: {} });
  const cfg = loadAppConfig({
    ...validEnv,
    INTEGRATION_MOCK_TELEMATICS_WEBHOOK_SECRET: 's'.repeat(32),
    INTEGRATION_MOCK_TELEMATICS_API_KEY: 'key-1',
    INTEGRATION_FUELCARD_API_KEY: 'key-2',
    INTEGRATION_EMPTY_API_KEY: '',
  });
  assert.deepEqual(cfg.integrations.secrets, {
    'mock-telematics': { webhookSecret: 's'.repeat(32), apiKey: 'key-1' },
    fuelcard: { apiKey: 'key-2' },
  });
  assert.deepEqual(problems(() => loadAppConfig({ ...validEnv, INTEGRATION_SHORT_WEBHOOK_SECRET: 'too-short' })), [
    'INTEGRATION_SHORT_WEBHOOK_SECRET: must be at least 32 characters',
  ]);
  const production = { ...validEnv, NODE_ENV: 'production', REDIS_HOST: 'r', REDIS_PASSWORD: 'p', JWT_SECRET: 'j'.repeat(40) };
  assert.ok(problems(() => loadAppConfig({ ...production, INTEGRATION_X_API_KEY: PLACEHOLDER })).some((p) => p.includes('placeholder')));
});

test('GPS events: at most one per vehicle per 5 s by default (FMS-88)', () => {
  assert.deepEqual(loadAppConfig(validEnv).tracking, { eventIntervalSeconds: 5 });
  assert.equal(loadAppConfig({ ...validEnv, TRACKING_EVENT_INTERVAL_SECONDS: '0' }).tracking.eventIntervalSeconds, 0);
  assert.ok(problems(() => loadAppConfig({ ...validEnv, TRACKING_EVENT_INTERVAL_SECONDS: '-1' })).some((p) => p.startsWith('TRACKING_EVENT_INTERVAL_SECONDS')));
});

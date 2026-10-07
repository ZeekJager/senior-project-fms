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

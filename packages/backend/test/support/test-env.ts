/**
 * Test environment for integration tests. Applied by the global setup (main
 * process) and by test/support/env-setup.ts (each worker, before the app's
 * config is imported).
 *
 * - Values already in the environment win (CI sets them explicitly).
 * - Otherwise the repo-root .env (created by `make env`) supplies the
 *   passwords and JWT secret, with host defaults for a `make dev` stack.
 * - DB_NAME is always the dedicated test database, never the dev database.
 */
import fs from 'node:fs';
import path from 'node:path';

export const TEST_DB_NAME = process.env.TEST_DB_NAME ?? 'fms_test';

if (!TEST_DB_NAME.endsWith('_test')) {
  throw new Error(`TEST_DB_NAME must end with "_test" (got "${TEST_DB_NAME}"); tests drop and recreate it.`);
}

function readDotEnv(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  const values: Record<string, string> = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const i = line.indexOf('=');
    values[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return values;
}

export function applyTestEnv(): void {
  const dotEnv = readDotEnv(path.resolve(__dirname, '../../../../.env'));
  // Assigning undefined to process.env stores the string "undefined", so only
  // set a default that actually has a value; missing ones fail config loading.
  const setDefault = (key: string, value: string | undefined) => {
    if (process.env[key] === undefined && value !== undefined) process.env[key] = value;
  };

  setDefault('NODE_ENV', 'test');
  setDefault('LOG_LEVEL', 'silent');
  setDefault('DB_HOST', 'localhost');
  setDefault('DB_PORT', '5432');
  setDefault('DB_ADMIN_USER', 'fms_admin');
  setDefault('DB_ADMIN_PASSWORD', dotEnv.DB_ADMIN_PASSWORD);
  setDefault('DB_USER', 'fms_app');
  setDefault('DB_PASSWORD', process.env.DB_APP_PASSWORD ?? dotEnv.DB_APP_PASSWORD);
  setDefault('JWT_SECRET', dotEnv.JWT_SECRET);
  process.env.DB_NAME = TEST_DB_NAME;
}

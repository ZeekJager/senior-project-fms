/**
 * Test environment for integration tests. Applied by the global setup (main
 * process) and by test/support/env-setup.ts (each worker, before the app's
 * config is imported).
 *
 * - Values already in the environment win (CI sets them explicitly).
 * - Otherwise the repo-root .env (created by `make env`) supplies the
 *   passwords, JWT secret and data encryption key, with host defaults for a
 *   `make dev` stack; without a data encryption key there, a fixed test-only key.
 * - DB_NAME is always the dedicated test database, never the dev database.
 */
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { readDotEnv } from '../../scripts/lib/dotenv';

export const TEST_DB_NAME = process.env.TEST_DB_NAME ?? 'fms_test';

/** Uploaded document files during tests: a temp folder, emptied by the global setup before and after the run. */
export const TEST_STORAGE_DIR = path.join(os.tmpdir(), `${TEST_DB_NAME}-documents`);

if (!TEST_DB_NAME.endsWith('_test')) {
  throw new Error(`TEST_DB_NAME must end with "_test" (got "${TEST_DB_NAME}"); tests drop and recreate it.`);
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
  // The driver-data key (FMS-104): the .env's when it has one (`make env` adds it), else a fixed test-only key. The
  // test database is dropped and recreated each run, so nothing encrypted with it outlives the run, and every worker
  // gets the same one (a random key per process would not read what the global setup's migrations wrote).
  setDefault('DATA_ENCRYPTION_KEY', dotEnv.DATA_ENCRYPTION_KEY ?? 'test-only-data-encryption-key-for-the-test-database-0001');
  // Redis (FMS-72) only when REDIS_HOST is given (CI sets it; the dev stack's
  // Redis is not published to the host). Test keys live under their own prefix,
  // and each test file under its own below it: the files share one Redis, and a
  // rolled-back test does not empty it, so a snapshot one file cached (the live
  // map's fleet-wide one, 5 s) was read by another that had just added vehicles.
  if (process.env.REDIS_HOST) {
    setDefault('REDIS_PASSWORD', dotEnv.REDIS_PASSWORD);
    setDefault('TEST_REDIS_KEY_PREFIX', process.env.REDIS_KEY_PREFIX ?? 'fms-test');
    process.env.REDIS_KEY_PREFIX = `${process.env.TEST_REDIS_KEY_PREFIX}-${randomBytes(4).toString('hex')}`;
  }
  // The integration gateway's mock provider (FMS-85): a webhook secret and an API key for the code
  // test/integration/integrations.test.ts gives its providers.
  setDefault('INTEGRATION_MOCK_TELEMATICS_WEBHOOK_SECRET', 'test-webhook-secret-for-the-mock-provider-0001');
  setDefault('INTEGRATION_MOCK_TELEMATICS_API_KEY', 'test-api-key-mock-provider');
  // The GPS simulator's provider (FMS-138), which test/integration/telematics.test.ts posts as.
  setDefault('INTEGRATION_FMS_SIMULATOR_WEBHOOK_SECRET', 'test-webhook-secret-for-the-gps-simulator-0001');
  // Always local disk, in a temp folder: tests never write into the repo or a real bucket.
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_LOCAL_DIR = TEST_STORAGE_DIR;
  process.env.DB_NAME = TEST_DB_NAME;
}

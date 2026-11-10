/**
 * Imported first by scripts/load/run.ts, before anything loads the config (FMS-61): refuses production and any
 * database not named `*_test` (`LOAD_DB_NAME`, default `fms_load_test`), then fills the environment from itself and
 * the repository's .env.
 */
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { readDotEnv } from '../lib/dotenv';
import { assertLoadTarget } from './guard';

export const LOAD_DB_NAME = process.env.LOAD_DB_NAME ?? 'fms_load_test';
export const LOAD_STORAGE_DIR = path.join(os.tmpdir(), `${LOAD_DB_NAME}-documents`);

function applyLoadEnv(): void {
  assertLoadTarget(process.env, LOAD_DB_NAME);
  const dotEnv = readDotEnv(path.resolve(__dirname, '../../../../.env'));
  const setDefault = (key: string, value: string | undefined) => {
    if (process.env[key] === undefined && value !== undefined) process.env[key] = value;
  };
  setDefault('DB_HOST', 'localhost');
  setDefault('DB_PORT', '5432');
  setDefault('DB_ADMIN_USER', 'fms_admin');
  setDefault('DB_ADMIN_PASSWORD', dotEnv.DB_ADMIN_PASSWORD);
  setDefault('DB_USER', 'fms_app');
  setDefault('DB_PASSWORD', process.env.DB_APP_PASSWORD ?? dotEnv.DB_APP_PASSWORD);
  setDefault('REDIS_PASSWORD', dotEnv.REDIS_PASSWORD);
  // The database is new each run, so keys made for this run read everything it writes and nothing outlives it.
  setDefault('JWT_SECRET', dotEnv.JWT_SECRET ?? randomBytes(32).toString('hex'));
  setDefault('DATA_ENCRYPTION_KEY', dotEnv.DATA_ENCRYPTION_KEY ?? randomBytes(32).toString('hex'));
  if (!process.env.REDIS_HOST) {
    throw new Error('The load suite runs the API as in production, which needs Redis: set REDIS_HOST and REDIS_PASSWORD (docs/load-testing.md).');
  }
  // This process seeds and sets up; the API it starts runs with NODE_ENV=production (server.ts).
  process.env.NODE_ENV = 'development';
  process.env.DB_NAME = LOAD_DB_NAME;
  process.env.LOG_LEVEL = process.env.LOAD_LOG_LEVEL ?? 'warn';
  process.env.REDIS_KEY_PREFIX = `fms-load-${randomBytes(4).toString('hex')}`;
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_LOCAL_DIR = LOAD_STORAGE_DIR;
}

try {
  applyLoadEnv();
} catch (err) {
  console.error(`✖ ${(err as Error).message}`);
  process.exit(1);
}

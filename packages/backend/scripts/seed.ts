/**
 * Seed dataset generator (FMS-113): repeatable demo and test data at the
 * scale the performance budgets assume. Local and CI databases only.
 *
 *   npm run seed -- --size=small                 # a laptop demo (empty database)
 *   npm run seed -- --size=budget --reset        # rebuild the schema, then 200 vehicles, 300 drivers, 1,000 trips
 *   npm run seed -- --seed=7 --anchor=2026-10-01 # another dataset; the same seed and anchor give the same data
 *   npm run seed:reset                           # rebuild the schema only
 *
 * The password of the accounts that can sign in comes from FMS_SEED_PASSWORD,
 * or is generated and printed once.
 */
// First: refuses in production and sets the log level, before anything below loads the config.
import './seed/env';
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Client } from 'pg';
import { config } from '../src/config';
import { loadMigrationConfig } from '../src/config/schema';
import { pool } from '../src/db';
import { cache, closeRedis } from '../src/shared/cache';
import { applyMigrations, revertMigrations } from './lib/migrations';
import { runSeed } from './seed/apply';
import type { ProfileName } from './seed/plan';

const USAGE = 'Usage: npm run seed -- [--size=small|budget] [--seed=<integer>] [--anchor=YYYY-MM-DD] [--reset | --reset-only]';
const DEFAULT_SEED = 20261007;

function generatePassword(): string {
  return randomBytes(12).toString('base64url');
}

/** Today in Addis Ababa, YYYY-MM-DD. */
function today(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Addis_Ababa' }).format(new Date());
}

function options() {
  const { values } = parseArgs({
    options: {
      size: { type: 'string', default: 'small' },
      seed: { type: 'string', default: String(DEFAULT_SEED) },
      anchor: { type: 'string' },
      reset: { type: 'boolean', default: false },
      'reset-only': { type: 'boolean', default: false },
    },
  });
  if (values.size !== 'small' && values.size !== 'budget') throw new Error(`--size must be small or budget. ${USAGE}`);
  if (!/^\d{1,9}$/.test(values.seed)) throw new Error(`--seed must be a whole number. ${USAGE}`);
  const anchor = values.anchor ?? today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor) || Number.isNaN(Date.parse(anchor))) throw new Error(`--anchor must be a date, YYYY-MM-DD. ${USAGE}`);
  // Hire dates and attendance cannot be in the future (API rules), so neither can the anchor.
  if (anchor > today()) throw new Error('--anchor cannot be in the future.');
  return { size: values.size as ProfileName, seed: Number(values.seed), anchor, reset: values.reset || values['reset-only'], seedAfter: !values['reset-only'] };
}

async function reset(): Promise<void> {
  // Admin rights, like `npm run migrate`: the app role cannot drop tables.
  const db = loadMigrationConfig(process.env);
  const client = new Client(db);
  await client.connect();
  try {
    const reverted = await revertMigrations(client);
    const { applied } = await applyMigrations(client);
    console.log(`✔ Rebuilt ${db.database}: reverted ${reverted.length} and applied ${applied.length} migrations.`);
  } finally {
    await client.end();
  }
  // The rebuilt database has no documents, so their files are orphans: local
  // storage drops them (every key starts with documents/); a bucket is left alone.
  if (config.storage.driver === 'local') {
    await rm(path.join(config.storage.localDir, 'documents'), { recursive: true, force: true });
  } else {
    console.log('  Document files in the S3 bucket were left in place; the rebuilt database no longer references them.');
  }
}

async function main(): Promise<void> {
  const opts = options();
  if (opts.reset) await reset();
  // A rebuilt database has new ids: nothing cached from the old one applies.
  if (opts.reset) await cache.invalidate('*');
  if (!opts.seedAfter) return void (await Promise.all([pool.end(), closeRedis()]));

  const generated = !process.env.FMS_SEED_PASSWORD;
  const password = process.env.FMS_SEED_PASSWORD || generatePassword();
  const started = Date.now();
  try {
    const summary = await runSeed({ profile: opts.size, seed: opts.seed, anchor: opts.anchor, password, log: (line) => console.log(`  ${line}`) });
    console.log(`✔ Seeded the ${opts.size} profile (seed ${opts.seed}, anchor ${opts.anchor}) in ${Math.round((Date.now() - started) / 1000)} s.`);
    console.table(summary.counts);
    console.log('Accounts that can sign in:');
    for (const login of summary.logins) console.log(`  ${login.role.padEnd(20)} ${login.email}`);
    if (generated) console.log(`Their password (shown once; set FMS_SEED_PASSWORD to choose it): ${password}`);
    console.log(`fingerprint ${summary.fingerprint}`);
  } finally {
    await Promise.all([pool.end(), closeRedis()]);
  }
}

main().catch((err: unknown) => {
  console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

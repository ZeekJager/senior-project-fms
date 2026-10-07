/**
 * Integration-test global setup: once per run, drop and recreate the test
 * database and apply every migration with the same code `make migrate`
 * uses. Teardown fails the run if any test left rows behind.
 */
import { Client } from 'pg';
import { loadMigrationConfig } from '../../src/config/schema';
import { applyMigrations } from '../../scripts/lib/migrations';
import { applyTestEnv, TEST_DB_NAME } from './test-env';

// Every table the migrations create, excluding schema_migrations.
const COUNT_ROWS_SQL = `
  SELECT n.nspname || '.' || c.relname AS table_name
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r', 'p')
     AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'public')
     AND NOT c.relispartition
   ORDER BY 1`;

async function rowCounts(client: Client): Promise<Map<string, number>> {
  const tables = (await client.query<{ table_name: string }>(COUNT_ROWS_SQL)).rows.map((r) => r.table_name);
  const counts = new Map<string, number>();
  for (const t of tables) {
    const res = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`);
    counts.set(t, res.rows[0].n);
  }
  return counts;
}

function connect(database: string): Client {
  const db = loadMigrationConfig(process.env);
  return new Client({ ...db, database });
}

export default async function setup(): Promise<() => Promise<void>> {
  applyTestEnv();
  const admin = connect('postgres');
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(
      `Integration tests need PostgreSQL at ${process.env.DB_HOST}:${process.env.DB_PORT} ` +
        `(start it with "make dev"; see docs/testing.md): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${TEST_DB_NAME}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${TEST_DB_NAME}"`);
  } finally {
    await admin.end();
  }

  const db = connect(TEST_DB_NAME);
  await db.connect();
  let baseline: Map<string, number>;
  try {
    await applyMigrations(db);
    baseline = await rowCounts(db);
  } finally {
    await db.end();
  }

  return async () => {
    const check = connect(TEST_DB_NAME);
    await check.connect();
    try {
      const after = await rowCounts(check);
      const leaked = [...after].filter(([t, n]) => n !== (baseline.get(t) ?? 0)).map(([t, n]) => `${t} (+${n - (baseline.get(t) ?? 0)})`);
      if (leaked.length) {
        throw new Error(`Integration tests left rows behind in: ${leaked.join(', ')}. Did a test write outside its transaction?`);
      }
    } finally {
      await check.end();
    }
  };
}

import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { ConfigError, loadMigrationConfig, type DbConfig } from '../src/config/schema';

// Runs as the schema owner (DB_ADMIN_USER) to create tables and triggers.
function migrationConfig(): DbConfig {
  try {
    return loadMigrationConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

const dbConfig = migrationConfig();

// The script runs from `scripts/` (tsx) or `dist/scripts/` (compiled), so
// walk up to the package's `migrations/` folder instead of a fixed path.
function findMigrationsDir(): string {
  let dir = __dirname;
  for (let i = 0; i < 3; i++) {
    const candidate = path.join(dir, 'migrations');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error(`migrations/ folder not found above ${__dirname}`);
}

const UP_MARKER = /\r?\n-- \+migrate Up\r?\n/;
const DOWN_MARKER = /\r?\n-- \+migrate Down\r?\n/;

async function runMigrations(): Promise<void> {
  const client = new Client(dbConfig);
  try {
    await client.connect();
    console.log('✔ Connected to PostgreSQL for migrations.');

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id SERIAL PRIMARY KEY,
        filename VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const migrationsDir = findMigrationsDir();
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      const { rowCount } = await client.query('SELECT id FROM schema_migrations WHERE filename = $1', [file]);
      if (rowCount) {
        console.log(`[⏩ SKIPPED] ${file} (already applied)`);
        continue;
      }

      console.log(`[⚒️ RUNNING] ${file}...`);
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');

      // Only the Up section runs. The markers are matched on their own line
      // so header comments that mention them are not mistaken for the start.
      const afterUp = sql.split(UP_MARKER)[1];
      if (afterUp === undefined) {
        console.warn(`[!] Warning: No '-- +migrate Up' found in ${file}.`);
        continue;
      }
      const upSql = afterUp.split(DOWN_MARKER)[0];

      await client.query('BEGIN');
      try {
        await client.query(upSql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`[✅ SUCCESS] ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[❌ FAILED] ${file}`);
        console.error(err);
        process.exitCode = 1;
        return;
      }
    }
    console.log('✨ All database migrations applied successfully!');
  } catch (err) {
    console.error('Migration error:', err);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

void runMigrations();

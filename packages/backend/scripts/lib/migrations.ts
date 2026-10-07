import fs from 'node:fs';
import path from 'node:path';
import type { Client } from 'pg';

const UP_MARKER = /\r?\n-- \+migrate Up\r?\n/;
const DOWN_MARKER = /\r?\n-- \+migrate Down\r?\n/;

// Callers run from `scripts/` (tsx), `dist/scripts/` (compiled) or `test/`,
// so walk up to the package's `migrations/` folder instead of a fixed path.
export function findMigrationsDir(from: string = __dirname): string {
  let dir = from;
  for (let i = 0; i < 4; i++) {
    const candidate = path.join(dir, 'migrations');
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error(`migrations/ folder not found above ${from}`);
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Applies the Up section of every not-yet-applied migration, in file order,
 * each in its own transaction, recording it in `schema_migrations`. Throws
 * on the first failure (that migration is rolled back).
 */
export async function applyMigrations(
  client: Client,
  log: (line: string) => void = () => {},
  migrationsDir: string = findMigrationsDir(),
): Promise<MigrationResult> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255) NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const result: MigrationResult = { applied: [], skipped: [] };
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    const { rowCount } = await client.query('SELECT id FROM schema_migrations WHERE filename = $1', [file]);
    if (rowCount) {
      log(`[⏩ SKIPPED] ${file} (already applied)`);
      result.skipped.push(file);
      continue;
    }

    // Only the Up section runs. The markers are matched on their own line
    // so header comments that mention them are not mistaken for the start.
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    const afterUp = sql.split(UP_MARKER)[1];
    if (afterUp === undefined) throw new Error(`No '-- +migrate Up' marker in ${file}`);
    const upSql = afterUp.split(DOWN_MARKER)[0];

    log(`[⚒️ RUNNING] ${file}...`);
    await client.query('BEGIN');
    try {
      await client.query(upSql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    log(`[✅ SUCCESS] ${file}`);
    result.applied.push(file);
  }
  return result;
}

import { Client } from 'pg';
import { ConfigError, loadMigrationConfig, type DbConfig } from '../src/config/schema';
import { applyMigrations } from './lib/migrations';

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

async function main(): Promise<void> {
  const client = new Client(migrationConfig());
  try {
    await client.connect();
    console.log('✔ Connected to PostgreSQL for migrations.');
    await applyMigrations(client, (line) => console.log(line));
    console.log('✨ All database migrations applied successfully!');
  } catch (err) {
    console.error(`[❌ FAILED] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

void main();

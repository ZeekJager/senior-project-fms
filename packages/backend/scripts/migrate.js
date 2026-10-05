const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const dbConfig = {
  host: process.env.DB_HOST || 'postgres',
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER || 'fms_admin', // Must run as admin to create tables and triggers
  password: process.env.DB_PASS || 'adminpassword',
  database: process.env.DB_NAME || 'fms_db',
};

async function runMigrations() {
  const client = new Client(dbConfig);
  try {
    await client.connect();
    console.log('\u2714 Connected to PostgreSQL for migrations.');

    // 1. Create a table to track which migrations have already run
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id SERIAL PRIMARY KEY,
        filename VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 2. Find all SQL files in the migrations directory
    const migrationsDir = path.join(__dirname, '../migrations');
    const files = fs.readdirSync(migrationsDir)
                    .filter(f => f.endsWith('.sql'))
                    .sort();

    // 3. Execute them sequentially
    for (const file of files) {
      const { rowCount } = await client.query('SELECT id FROM schema_migrations WHERE filename = $1', [file]);
      if (rowCount > 0) {
        console.log(`[\u23E9 SKIPPED] ${file} (already applied)`);
        continue;
      }

      console.log(`[\u2692\uFE0F RUNNING] ${file}...`);
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
      
      // We parse out ONLY the "Up" section written by Zekarias
      // Using a regex with newline to avoid matching the explanation comments in the header!
      const upMatch = sql.split(/\r?\n-- \+migrate Up\r?\n/)[1];
      if (!upMatch) {
        console.warn(`[!] Warning: No '-- +migrate Up' found in ${file}.`);
        continue;
      }
      
      // Stop before the Down section
      const upSql = upMatch.split(/\r?\n-- \+migrate Down\r?\n/)[0];

      // Execute migration inside a transaction
      await client.query('BEGIN');
      try {
        await client.query(upSql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`[\u2705 SUCCESS] ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[\u274C FAILED] ${file}`);
        console.error(err);
        process.exit(1);
      }
    }
    console.log('\u2728 All database migrations applied successfully!');
  } catch (err) {
    console.error('Migration error:', err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

runMigrations();

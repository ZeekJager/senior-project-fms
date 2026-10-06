import { Pool, type QueryResultRow } from 'pg';

// Runtime app credentials, not the admin ones: fms_app is a non-owner role
// whose privileges are narrowed by migration 013 (e.g. audit is INSERT-only).
export const pool = new Pool({
  host: process.env.DB_HOST ?? 'postgres',
  port: Number(process.env.DB_PORT ?? 5432),
  user: process.env.DB_USER ?? 'fms_app',
  password: process.env.DB_PASS ?? 'apppassword',
  database: process.env.DB_NAME ?? 'fms_db',
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

export function query<R extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) {
  return pool.query<R>(text, params);
}

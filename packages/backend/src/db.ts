import { Pool, type QueryResultRow } from 'pg';
import { config } from './config';

// Runtime app credentials (fms_app), not the admin ones: fms_app is a
// non-owner role whose privileges are narrowed by migration 013.
export const pool = new Pool(config.db);

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

export function query<R extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) {
  return pool.query<R>(text, params);
}

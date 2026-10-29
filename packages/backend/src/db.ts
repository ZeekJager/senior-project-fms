import { Pool, type QueryResultRow } from 'pg';
import { config } from './config';
import { ReadRouter } from './shared/infrastructure/read-router';
import { logger } from './shared/logging/logger';

// Runtime app credentials (fms_app), not the admin ones: fms_app is a
// non-owner role whose privileges are narrowed by migration 013.
export const pool = new Pool(config.db);

pool.on('error', (err) => {
  logger.fatal({ err }, 'unexpected error on an idle database client');
  process.exit(-1);
});

/**
 * The read replica's pool (FMS-94), as the same fms_app role: a physical copy
 * has the same roles and grants, and refuses every write. Null without
 * DB_READ_HOST. A replica that fails is not fatal, unlike the primary: the
 * router reads the primary instead. It connects within 2 s or counts as down,
 * and lets a script exit while its clients are idle.
 */
export const replicaPool = config.readReplica ? new Pool({ ...config.readReplica.db, connectionTimeoutMillis: 2_000, allowExitOnIdle: true }) : null;

replicaPool?.on('error', (err) => {
  logger.warn({ err }, 'read replica: an idle client failed');
});

/**
 * `db.read` (FMS-94): reporting reads (fuel reconciliation, the audit log).
 * `await reads.session()` gives one request's reads, from the replica when it
 * is up and at most READ_REPLICA_MAX_LAG_SECONDS behind, the primary
 * otherwise; `session.freshness()` says which (`meta.data_freshness`).
 * Writes always go to `pool`.
 */
export const reads = new ReadRouter(pool, replicaPool, { maxLagSeconds: config.readReplica?.maxLagSeconds ?? 30, log: logger });

export function query<R extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]) {
  return pool.query<R>(text, params);
}

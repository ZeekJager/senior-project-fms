import { Pool, type QueryResultRow } from 'pg';
import { config } from './config';
import { useDataKey } from './shared/infrastructure/data-key';
import { ReadRouter } from './shared/infrastructure/read-router';
import { logger } from './shared/logging/logger';

/** How long connecting to the primary may take before the query fails (and the request answers 503). */
export const PRIMARY_CONNECT_TIMEOUT_MS = 5_000;

// Runtime app credentials (fms_app), not the admin ones: fms_app is a
// non-owner role whose privileges are narrowed by migration 013.
// Through one stable endpoint (FMS-162, docs/disaster-recovery.md): after a failover the same host is the new
// primary, and new connections reach it. A connection attempt gives up after 5 s, so while the database is
// unavailable a request answers 503 at once instead of hanging.
export const pool = new Pool({ ...config.db, connectionTimeoutMillis: PRIMARY_CONNECT_TIMEOUT_MS });
useDataKey(pool, config.dataEncryptionKey, (err) => logger.error({ err }, 'could not give a database connection the data encryption key'));

// An idle client failing (the primary restarted, failed over, or the network dropped) is logged and dropped: pg
// removes it from the pool, and the next query connects again. The API keeps answering, 503 until the database is
// back, rather than exiting and taking every in-flight request with it.
pool.on('error', (err) => {
  logger.error({ err }, 'database: an idle client failed; the next query reconnects');
});

/**
 * The read replica's pool (FMS-94), as the same fms_app role: a physical copy
 * has the same roles and grants, and refuses every write. Null without
 * DB_READ_HOST. A replica that fails is not fatal, unlike the primary: the
 * router reads the primary instead. It connects within 2 s or counts as down,
 * and lets a script exit while its clients are idle.
 */
export const replicaPool = config.readReplica ? new Pool({ ...config.readReplica.db, connectionTimeoutMillis: 2_000, allowExitOnIdle: true }) : null;

if (replicaPool) useDataKey(replicaPool, config.dataEncryptionKey, (err) => logger.warn({ err }, 'read replica: could not give a connection the data encryption key'));

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

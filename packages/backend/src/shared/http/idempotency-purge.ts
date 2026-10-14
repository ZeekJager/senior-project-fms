import type { ScheduledJob } from '../jobs/job';
import type { Queryable } from '../infrastructure/queryable';

/** Deletes every Idempotency-Key past its expiry (api-contract §19) and returns how many went. */
export async function purgeExpiredIdempotencyKeys(db: Queryable): Promise<number> {
  const result = await db.query('DELETE FROM api.idempotency_keys WHERE expires_at < now()');
  return result.rowCount ?? 0;
}

/** The daily purge (FMS-87). Platform code, so server.ts schedules it next to the modules' jobs. */
export function idempotencyPurgeJob(db: Queryable): ScheduledJob {
  return {
    name: 'idempotency-key-purge',
    at: '02:00',
    run: async () => ({ purged: await purgeExpiredIdempotencyKeys(db) }),
  };
}

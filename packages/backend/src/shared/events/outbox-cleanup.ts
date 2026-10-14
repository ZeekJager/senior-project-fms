import type { ScheduledJob } from '../jobs/job';
import type { Queryable } from '../infrastructure/queryable';
import { outboxStore } from './outbox';

/** How long delivered events, and consumers' records of them, are kept. */
export const OUTBOX_RETENTION_DAYS = 7;

/**
 * Daily: deletes events delivered both ways more than a week ago, and
 * consumers' processed records as old. Dead letters are kept until someone
 * has dealt with them (docs/events.md). Platform job, run by src/server.ts.
 */
export function outboxCleanupJob(db: Queryable): ScheduledJob {
  return {
    name: 'event-outbox-cleanup',
    at: '03:30',
    async run({ now }) {
      const removed = await outboxStore.purge(db, new Date(now.getTime() - OUTBOX_RETENTION_DAYS * 86_400_000));
      return { events_deleted: removed.events, processed_deleted: removed.processed };
    },
  };
}

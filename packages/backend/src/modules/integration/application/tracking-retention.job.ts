import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { ScheduledJob } from '../../../shared/jobs/job';
import type { TelemetryFlagRepository } from '../infrastructure/telemetry-flag.repository';
import type { TrackingRepository } from '../infrastructure/tracking.repository';

/** Rows deleted per statement, and statements per table per run: at most 1,000,000 rows of each a night. */
export const PURGE_BATCH = 5_000;
export const PURGE_MAX_BATCHES = 200;

const DAY_MS = 86_400_000;

export interface TrackingRetentionDeps {
  db: Queryable;
  tracking: Pick<TrackingRepository, 'purgePingsBefore'>;
  flags: Pick<TelemetryFlagRepository, 'purgeBefore'>;
  /** Days kept (config.tracking.retention). */
  retention: { pingDays: number; flagDays: number };
}

/** Repeats a bounded delete until a batch comes back short (the table is clear to the cutoff) or the run's cap is reached. */
async function drain(purge: (limit: number) => Promise<number>): Promise<number> {
  let total = 0;
  for (let i = 0; i < PURGE_MAX_BATCHES; i++) {
    const n = await purge(PURGE_BATCH);
    total += n;
    if (n < PURGE_BATCH) break;
  }
  return total;
}

/**
 * Nightly (FMS-104, docs/driver-data-protection.md): where a vehicle was, and so its driver, is not kept for ever. Deletes GPS
 * pings recorded, and telemetry flags observed, before the retention period. The run's counts (never the data) are on its
 * audit entry, which the scheduler writes. A night's cap leaves a larger backlog for the next night.
 */
export function trackingRetentionJob(deps: TrackingRetentionDeps): ScheduledJob {
  return {
    name: 'tracking-retention',
    at: '03:20',
    async run({ now }) {
      const pingCutoff = new Date(now.getTime() - deps.retention.pingDays * DAY_MS);
      const flagCutoff = new Date(now.getTime() - deps.retention.flagDays * DAY_MS);
      const pings = await drain((limit) => deps.tracking.purgePingsBefore(deps.db, pingCutoff, limit));
      const flags = await drain((limit) => deps.flags.purgeBefore(deps.db, flagCutoff, limit));
      return { pings_deleted: pings, flags_deleted: flags, ping_cutoff: pingCutoff.toISOString(), flag_cutoff: flagCutoff.toISOString() };
    },
  };
}

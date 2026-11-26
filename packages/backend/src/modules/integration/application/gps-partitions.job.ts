import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { ScheduledJob } from '../../../shared/jobs/job';
import type { TrackingRepository } from '../infrastructure/tracking.repository';

/**
 * Months made ahead of the one under way: this month and the next two always exist, so next month's partition is
 * there from the first of this month (the card's bar is the 25th), and a month of failed runs still leaves one ahead.
 */
export const GPS_PARTITION_MONTHS_AHEAD = 2;

export interface GpsPartitionsDeps {
  db: Queryable;
  tracking: Pick<TrackingRepository, 'ensurePartitions'>;
}

/**
 * Nightly (FMS-110, docs/gps-ingestion.md#partitions): tracking.gps_pings keeps one partition a month (UTC). Makes the
 * months that do not exist yet, and moves any pings that landed in the default partition (outside every month) into a
 * month of their own. Dropping old months is the tracking-retention job's.
 */
export function gpsPartitionsJob(deps: GpsPartitionsDeps): ScheduledJob {
  return {
    name: 'gps-partitions',
    at: '02:50',
    async run({ now }) {
      const made = await deps.tracking.ensurePartitions(deps.db, now, GPS_PARTITION_MONTHS_AHEAD);
      return {
        partitions_created: made.length,
        rows_moved: made.reduce((sum, m) => sum + m.rowsMoved, 0),
        months: made.map((m) => m.partition),
      };
    },
  };
}

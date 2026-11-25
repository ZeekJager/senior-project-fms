import { describe, expect, test } from 'vitest';
import { pool } from '../../src/db';
import { integrationModule } from '../../src/modules/integration';
import { TrackingRepository } from '../../src/modules/integration/infrastructure/tracking.repository';
import type { ScheduledJob } from '../../src/shared/jobs/job';
import { PostgresJobLock } from '../../src/shared/jobs/job-lock';
import { runJob } from '../../src/shared/jobs/scheduler';
import { createDepot, createVehicle } from '../support/factories';

// FMS-110: GPS partition maintenance (migration 083, docs/gps-ingestion.md#partitions).

const DAY = 86_400_000;
const tracking = new TrackingRepository();
const jobNamed = (name: string) => integrationModule.jobs!.find((j) => j.name === name)!;

/** The job as of `now`, under a name of its own so the run's lock and history never meet another test's. */
async function run(job: ScheduledJob, now: Date) {
  const outcome = await runJob(
    { ...job, name: `${job.name}-${Math.random()}` },
    { lock: new PostgresJobLock(pool), audit: pool, timeZone: 'Africa/Addis_Ababa', instanceId: 'test', now: () => now },
  );
  if (outcome.status !== 'succeeded') throw new Error(`job ${outcome.status}`);
  return outcome.result as Record<string, unknown>;
}

async function months(): Promise<string[]> {
  return (await pool.query<{ name: string }>('SELECT partition_name AS name FROM tracking.gps_partitions()')).rows.map((r) => r.name);
}

const monthName = (d: Date) => `gps_pings_y${d.getUTCFullYear()}m${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
const monthsAfter = (d: Date, n: number) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));

async function ping(vehicleId: unknown, at: Date): Promise<void> {
  await pool.query('INSERT INTO tracking.gps_pings (vehicle_id, latitude, longitude, speed_kmh, recorded_at) VALUES ($1, 9.01, 38.76, 0, $2)', [vehicleId, at]);
}

/** Where each of the vehicle's pings is stored, oldest first: [recorded_at, partition]. */
async function placed(vehicleId: unknown): Promise<[string, string][]> {
  const res = await pool.query<{ at: Date; part: string }>(
    'SELECT recorded_at AS at, tableoid::regclass::text AS part FROM tracking.gps_pings WHERE vehicle_id = $1 ORDER BY recorded_at',
    [vehicleId],
  );
  return res.rows.map((r) => [r.at.toISOString(), r.part.replace(/^tracking\./, '')]);
}

describe('GPS partitions', () => {
  test('the migration made this month and the next two', async () => {
    const now = new Date();
    expect(await months()).toEqual(expect.arrayContaining([0, 1, 2].map((n) => monthName(monthsAfter(now, n)))));
  });

  test("next month's partition exists by the 25th: the nightly job makes this month and the next two", async () => {
    const the25th = new Date('2031-03-25T09:00:00Z');
    expect(await months()).not.toContain('gps_pings_y2031m04');

    const result = await run(jobNamed('gps-partitions'), the25th);
    expect(result).toMatchObject({ partitions_created: 3, rows_moved: 0, months: ['gps_pings_y2031m03', 'gps_pings_y2031m04', 'gps_pings_y2031m05'] });
    expect(await months()).toEqual(expect.arrayContaining(['gps_pings_y2031m03', 'gps_pings_y2031m04', 'gps_pings_y2031m05']));

    // A second run the next night has nothing to make.
    expect(await run(jobNamed('gps-partitions'), new Date('2031-03-26T09:00:00Z'))).toMatchObject({ partitions_created: 0 });

    // A ping in next month now lands in its partition, not the default one.
    const vehicle = await createVehicle({ depot: await createDepot() });
    await ping(vehicle.id, new Date('2031-04-02T08:00:00Z'));
    expect(await placed(vehicle.id)).toEqual([['2031-04-02T08:00:00.000Z', 'gps_pings_y2031m04']]);
  });

  test('pings outside every month are moved out of the default partition into a month of their own', async () => {
    const vehicle = await createVehicle({ depot: await createDepot() });
    await ping(vehicle.id, new Date('2029-06-15T10:00:00Z'));
    await ping(vehicle.id, new Date('2029-06-30T23:59:59Z'));
    await ping(vehicle.id, new Date('2029-07-01T00:00:00Z'));
    expect((await placed(vehicle.id)).map(([, part]) => part)).toEqual(['gps_pings_default', 'gps_pings_default', 'gps_pings_default']);

    const result = await run(jobNamed('gps-partitions'), new Date());
    expect(result).toMatchObject({ rows_moved: 3 });
    expect(result.months).toEqual(expect.arrayContaining(['gps_pings_y2029m06', 'gps_pings_y2029m07']));
    // UTC months: the last second of June stays in June, midnight of the 1st is July.
    expect(await placed(vehicle.id)).toEqual([
      ['2029-06-15T10:00:00.000Z', 'gps_pings_y2029m06'],
      ['2029-06-30T23:59:59.000Z', 'gps_pings_y2029m06'],
      ['2029-07-01T00:00:00.000Z', 'gps_pings_y2029m07'],
    ]);
    expect((await tracking.partitionStatus(pool)).defaultRows).toBe(0);
  });

  test('data older than retention is dropped: whole months dropped, the rest of the cutoff month deleted, newer pings kept', async () => {
    const vehicle = await createVehicle({ depot: await createDepot() });
    for (const at of ['2025-01-10T00:00:00Z', '2025-02-20T00:00:00Z', '2025-03-01T06:00:00Z', '2025-03-05T00:00:00Z', '2025-04-01T00:00:00Z']) {
      await ping(vehicle.id, new Date(at));
    }
    await tracking.ensurePartitions(pool, new Date('2025-01-01T00:00:00Z'), 3);
    expect(await months()).toEqual(expect.arrayContaining(['gps_pings_y2025m01', 'gps_pings_y2025m02', 'gps_pings_y2025m03', 'gps_pings_y2025m04']));

    // The retention job as of the day the cutoff (180 days back) is 3 March 2025.
    const cutoff = new Date('2025-03-03T00:00:00Z');
    const result = await run(jobNamed('tracking-retention'), new Date(cutoff.getTime() + 180 * DAY));
    expect(result).toMatchObject({ partitions_dropped: 2, months_dropped: ['gps_pings_y2025m01', 'gps_pings_y2025m02'], ping_cutoff: cutoff.toISOString() });
    expect(result.pings_deleted).toBeGreaterThanOrEqual(1);

    const left = await months();
    expect(left).not.toContain('gps_pings_y2025m01');
    expect(left).not.toContain('gps_pings_y2025m02');
    expect(left).toEqual(expect.arrayContaining(['gps_pings_y2025m03', 'gps_pings_y2025m04']));
    expect(await placed(vehicle.id)).toEqual([
      ['2025-03-05T00:00:00.000Z', 'gps_pings_y2025m03'],
      ['2025-04-01T00:00:00.000Z', 'gps_pings_y2025m04'],
    ]);
  });

  test('the months reach more than two months ahead, which is what the GpsPartitionMissing alert watches', async () => {
    const status = await tracking.partitionStatus(pool);
    expect(status.partitions).toBeGreaterThanOrEqual(3);
    expect(status.coveredUntil!.getTime() - Date.now()).toBeGreaterThan(59 * DAY);
  });

  // The function checks before it touches anything; the failed statement ends the test's transaction, so nothing follows it.
  test('a retention cutoff in the future is refused', async () => {
    await expect(tracking.dropPartitionsBefore(pool, new Date(Date.now() + 40 * DAY))).rejects.toThrow(/cutoff must be in the past/);
  });

  test('the runtime role cannot add a partition itself: only the owner functions can', async () => {
    await expect(
      pool.query("CREATE TABLE tracking.gps_pings_rogue PARTITION OF tracking.gps_pings FOR VALUES FROM ('2040-01-01') TO ('2040-02-01')"),
    ).rejects.toThrow(/must be owner|permission denied/);
  });
});

import { describe, expect, test } from 'vitest';
import { config } from '../../src/config';
import { pool } from '../../src/db';
import { integrationModule } from '../../src/modules/integration';
import { runJob } from '../../src/shared/jobs/scheduler';
import { PostgresJobLock } from '../../src/shared/jobs/job-lock';
import { createDepot, createVehicle } from '../support/factories';

// FMS-104: driver data protection (docs/driver-data-protection.md).

const DAY = 86_400_000;
const NOW = new Date('2026-11-10T03:30:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY);

describe('retention of GPS pings and telemetry flags', () => {
  const job = integrationModule.jobs!.find((j) => j.name === 'tracking-retention')!;
  async function ping(vehicleId: unknown, at: Date) {
    await pool.query('INSERT INTO tracking.gps_pings (vehicle_id, latitude, longitude, speed_kmh, recorded_at) VALUES ($1, 9.01, 38.76, 0, $2)', [vehicleId, at]);
  }
  async function flag(vehicleId: unknown, at: Date) {
    await pool.query("INSERT INTO tracking.telemetry_flags (vehicle_id, flag_type, observed_at, resolved_at) VALUES ($1, 'speeding', $2, $2::timestamptz + interval '1 hour')", [vehicleId, at]);
  }
  test('the defaults keep pings 180 days and flags a year', () => {
    expect(config.tracking.retention).toEqual({ pingDays: 180, flagDays: 365 });
  });

  test('older pings and flags are deleted, newer ones kept, exactly at the cutoff', async () => {
    const vehicle = await createVehicle({ depot: await createDepot() });
    const { pingDays, flagDays } = config.tracking.retention;
    await ping(vehicle.id, daysAgo(pingDays + 30)); // gone
    await ping(vehicle.id, new Date(daysAgo(pingDays).getTime() - 1000)); // a second past the cutoff: gone
    await ping(vehicle.id, new Date(daysAgo(pingDays).getTime() + 1000)); // a second inside: kept
    await ping(vehicle.id, daysAgo(1)); // kept
    await flag(vehicle.id, daysAgo(flagDays + 10)); // gone
    await flag(vehicle.id, daysAgo(flagDays - 10)); // kept
    await flag(vehicle.id, daysAgo(2)); // kept

    const outcome = await runWithNow();
    expect(outcome.result).toMatchObject({ pings_deleted: expect.any(Number), flags_deleted: expect.any(Number) });
    const left = async (table: string, column: string) =>
      (await pool.query<{ at: Date }>(`SELECT ${column} AS at FROM ${table} WHERE vehicle_id = $1 ORDER BY ${column}`, [vehicle.id])).rows.map((r) => r.at.getTime());
    expect(await left('tracking.gps_pings', 'recorded_at')).toEqual([daysAgo(pingDays).getTime() + 1000, daysAgo(1).getTime()]);
    expect(await left('tracking.telemetry_flags', 'observed_at')).toEqual([daysAgo(flagDays - 10).getTime(), daysAgo(2).getTime()]);
  });

  test('the run reports counts, not data, on its audit entry, and a second run has nothing to delete', async () => {
    const vehicle = await createVehicle({ depot: await createDepot() });
    await ping(vehicle.id, daysAgo(config.tracking.retention.pingDays + 5));
    await ping(vehicle.id, daysAgo(config.tracking.retention.pingDays + 6));
    const first = await runWithNow();
    expect(first.result.pings_deleted).toBeGreaterThanOrEqual(2);
    const audited = await pool.query("SELECT details FROM audit.audit_logs WHERE action = 'job.succeeded' AND correlation_id = $1", [first.correlationId]);
    expect(JSON.stringify(audited.rows[0].details)).not.toMatch(/38\.76|9\.01|latitude|longitude/);
    expect(audited.rows[0].details).toMatchObject({ result: { pings_deleted: first.result.pings_deleted } });
    const second = await runWithNow();
    expect(second.result).toMatchObject({ pings_deleted: 0, flags_deleted: 0 });
  });

  test('a vehicle’s latest known position is not removed with its old pings', async () => {
    const vehicle = await createVehicle({ depot: await createDepot() });
    await ping(vehicle.id, daysAgo(1));
    await ping(vehicle.id, daysAgo(config.tracking.retention.pingDays + 20));
    const before = (await pool.query('SELECT count(*)::int AS n FROM tracking.vehicle_current_location WHERE vehicle_id = $1', [vehicle.id])).rows[0].n;
    await runWithNow();
    const after = (await pool.query('SELECT count(*)::int AS n FROM tracking.vehicle_current_location WHERE vehicle_id = $1', [vehicle.id])).rows[0].n;
    expect(after).toBe(before);
  });

  /** Runs the job as of NOW, with the run's result and correlation id. */
  async function runWithNow() {
    const outcome = await runJob(
      { ...job, name: `tracking-retention-${Math.random()}` },
      { lock: new PostgresJobLock(pool), audit: pool, timeZone: 'Africa/Addis_Ababa', instanceId: 'test', now: () => NOW },
    );
    if (outcome.status !== 'succeeded') throw new Error(`job ${outcome.status}`);
    return { result: outcome.result as Record<string, number>, correlationId: outcome.correlationId };
  }
});

import { describe, expect, test } from 'vitest';
import { runSeed, SEED_ADMIN_EMAIL } from '../../scripts/seed/apply';
import { buildEvPlan } from '../../scripts/seed/ev';
import { buildPlan } from '../../scripts/seed/plan';
import { tripTrack } from '../../scripts/seed/tracks';
import { pool } from '../../src/db';
import { verifyPassword } from '../../src/modules/auth/infrastructure/password-hasher';

// The seed generator (FMS-113) on the test database. Each test is rolled
// back, so both start from the same empty database: the second must produce
// exactly what the first did.
const OPTIONS = { profile: 'small', seed: 20261007, anchor: '2026-10-01', password: 'Seed-Test-Pass-2026' } as const;
const fingerprints: string[] = [];

describe('seed generator', () => {
  test('the small profile writes every kind of data through the API, audited', { timeout: 120_000 }, async () => {
    const summary = await runSeed(OPTIONS);
    fingerprints.push(summary.fingerprint);
    expect(summary.counts).toMatchObject({ depots: 3, vehicles: 24, drivers: 30, trips: 80, roles_held: 9, trip_statuses: 6, spare_parts: 19, vehicle_documents: 48 });
    // 20 repairs, then each vehicle's service history (FMS-55).
    expect(summary.counts.maintenance_records).toBe(buildPlan(OPTIONS.profile, OPTIONS.seed, OPTIONS.anchor).maintenance.length);
    expect(summary.counts.maintenance_records).toBeGreaterThan(100);
    expect(summary.counts.electric_vehicles).toBeGreaterThan(0);
    expect(summary.counts.fuel_logs).toBeGreaterThan(0);
    expect(summary.counts.failure_events).toBeGreaterThan(0);
    expect(summary.counts.documents_expiring_amber).toBeGreaterThan(0);
    expect(summary.counts.documents_expiring_red).toBeGreaterThan(0);
    expect(summary.logins.map((l) => l.role)).toEqual(expect.arrayContaining(['admin', 'fleet_manager', 'dispatcher', 'driver']));

    // Every completed trip's GPS track (FMS-136), within its actual start and end, and the vehicles' current
    // location from it; batches audited like the ingestion's.
    const plan = buildPlan(OPTIONS.profile, OPTIONS.seed, OPTIONS.anchor);
    expect(summary.counts.gps_pings).toBe(plan.trips.reduce((n, _, i) => n + tripTrack(plan, i).length, 0));
    const tracks = await pool.query<{ outside: number; trips: number; completed: number; located: number; batches: number }>(
      `SELECT (SELECT count(*) FROM tracking.gps_pings p JOIN trip.trips t ON t.id = p.trip_id
                WHERE p.recorded_at NOT BETWEEN t.actual_start AND t.actual_end OR p.vehicle_id <> t.vehicle_id)::int AS outside,
              (SELECT count(DISTINCT trip_id) FROM tracking.gps_pings)::int AS trips,
              (SELECT count(*) FROM trip.trips WHERE status = 'completed')::int AS completed,
              (SELECT count(*) FROM tracking.vehicle_current_location)::int AS located,
              (SELECT count(*) FROM audit.audit_logs WHERE action = 'tracking.pings_ingested')::int AS batches`,
    );
    expect(tracks.rows[0]).toMatchObject({ outside: 0, trips: tracks.rows[0].completed, batches: Math.ceil(summary.counts.gps_pings / 5000) });
    expect(tracks.rows[0].located).toBeGreaterThan(0);

    // Every row has its audit entry: written by the services, or by auditedMutation for trips.
    const audited = await pool.query<{ entity_type: string; n: number }>(
      "SELECT entity_type, count(*)::int AS n FROM audit.audit_logs WHERE action = 'INSERT' AND entity_type IN ('fleet.vehicles', 'fleet.drivers', 'trip.trips', 'document.documents') GROUP BY 1",
    );
    expect(Object.fromEntries(audited.rows.map((r) => [r.entity_type, r.n]))).toEqual({ 'fleet.vehicles': 24, 'fleet.drivers': 30, 'trip.trips': 80, 'document.documents': 48 });
    // Each vehicle joined the fleet when the plan says, years ago.
    const registered = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM fleet.vehicles WHERE created_at < now() - interval '60 days'");
    expect(registered.rows[0].n).toBe(24);

    // Every vehicle's registered odometer, fuel log and completed repair with an odometer is a meter reading (FMS-126).
    const readings = await pool.query<{ source: string; n: number }>('SELECT source, count(*)::int AS n FROM fleet.meter_readings GROUP BY 1');
    const completedWithOdometer = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM maintenance.maintenance_records WHERE status = 'completed' AND odometer_km IS NOT NULL");
    expect(Object.fromEntries(readings.rows.map((r) => [r.source, r.n]))).toEqual({
      manual: 24,
      fuel_log: summary.counts.fuel_logs,
      maintenance: completedWithOdometer.rows[0].n,
    });
    expect(summary.counts.meter_readings).toBe(24 + summary.counts.fuel_logs + completedWithOdometer.rows[0].n);

    // The accounts it lists can sign in.
    expect(await canSignIn(SEED_ADMIN_EMAIL)).toBe(true);

    await expect(runSeed(OPTIONS)).rejects.toThrow(/already holds data/);
  });

  test('a second run with the same seed and anchor produces the same data', { timeout: 120_000 }, async () => {
    const summary = await runSeed(OPTIONS);
    expect(fingerprints).toHaveLength(1);
    expect(summary.fingerprint).toBe(fingerprints[0]);
  });

  // FMS-97 (docs/ev.md#synthetic-data): one command loads 90 days of EV data for the seeded EVs, through the EV API,
  // every record marked synthetic. Its sameness across runs is the plan's (scripts/seed/ev.test.ts) and CI's.
  test('--with-ev adds 90 days of synthetic battery and charging data for every seeded EV, through the API', { timeout: 240_000 }, async () => {
    // One call at a time: the test database is one connection (test/support/transactional-pool.ts).
    const summary = await runSeed({ ...OPTIONS, withEv: true, evConcurrency: 1 });
    const ev = buildEvPlan(buildPlan(OPTIONS.profile, OPTIONS.seed, OPTIONS.anchor));
    expect(summary.counts).toMatchObject({ charging_stations: ev.stations.length, battery_logs: ev.logs.length, charging_sessions: ev.sessions.length });
    expect(summary.fingerprint).not.toBe(fingerprints[0]);

    const check = await pool.query<{ evs: number; logged: number; days: number; not_synthetic: number; statuses: string[]; audited: number }>(
      `SELECT (SELECT count(*) FROM fleet.vehicles WHERE fuel_type = 'electric')::int AS evs,
              (SELECT count(DISTINCT vehicle_id) FROM ev.ev_battery_logs)::int AS logged,
              (SELECT extract(day FROM max(recorded_at) - min(recorded_at)) FROM ev.ev_battery_logs)::int AS days,
              ((SELECT count(*) FROM ev.ev_battery_logs WHERE source <> 'synthetic') + (SELECT count(*) FROM ev.charging_sessions WHERE source <> 'synthetic')
                + (SELECT count(*) FROM ev.charging_stations WHERE source <> 'synthetic'))::int AS not_synthetic,
              array(SELECT DISTINCT status::text FROM ev.charging_sessions ORDER BY 1) AS statuses,
              (SELECT count(*) FROM audit.audit_logs WHERE entity_type = 'ev.ev_battery_logs' AND action = 'INSERT')::int AS audited`,
    );
    expect(check.rows[0]).toMatchObject({ logged: check.rows[0].evs, days: 89, not_synthetic: 0, statuses: ['completed', 'failed'], audited: ev.logs.length });
    // The degrading EV's battery summary shows the wear (FMS-96's endpoint, on the generated data).
    const degrading = ev.vehicles.find((v) => v.scenario === 'fast_degradation')!;
    const health = await pool.query<{ first: number; last: number }>(
      `SELECT (array_agg(battery_health::float8 ORDER BY recorded_at))[1] AS first, (array_agg(battery_health::float8 ORDER BY recorded_at DESC))[1] AS last
         FROM ev.ev_battery_logs l JOIN fleet.vehicles v ON v.id = l.vehicle_id WHERE v.registration_number = $1`,
      [buildPlan(OPTIONS.profile, OPTIONS.seed, OPTIONS.anchor).vehicles[degrading.vehicle].registration_number],
    );
    expect(health.rows[0].first - health.rows[0].last).toBeGreaterThan(7);
  });
});

/** Whether the seed password matches this account's stored hash. */
async function canSignIn(email: string): Promise<boolean> {
  const row = await pool.query<{ password_hash: string }>('SELECT password_hash FROM auth.users WHERE email = $1', [email]);
  return verifyPassword(row.rows[0].password_hash, OPTIONS.password);
}

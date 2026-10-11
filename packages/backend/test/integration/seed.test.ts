import { describe, expect, test } from 'vitest';
import { runSeed, SEED_ADMIN_EMAIL } from '../../scripts/seed/apply';
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
    expect(summary.counts).toMatchObject({ depots: 3, vehicles: 24, drivers: 30, trips: 80, roles_held: 9, trip_statuses: 6, spare_parts: 16, maintenance_records: 20 });
    expect(summary.counts.electric_vehicles).toBeGreaterThan(0);
    expect(summary.counts.fuel_logs).toBeGreaterThan(0);
    expect(summary.logins.map((l) => l.role)).toEqual(expect.arrayContaining(['admin', 'fleet_manager', 'dispatcher', 'driver']));

    // Every row has its audit entry: written by the services, or by auditedMutation for trips.
    const audited = await pool.query<{ entity_type: string; n: number }>(
      "SELECT entity_type, count(*)::int AS n FROM audit.audit_logs WHERE action = 'INSERT' AND entity_type IN ('fleet.vehicles', 'fleet.drivers', 'trip.trips') GROUP BY 1",
    );
    expect(Object.fromEntries(audited.rows.map((r) => [r.entity_type, r.n]))).toEqual({ 'fleet.vehicles': 24, 'fleet.drivers': 30, 'trip.trips': 80 });

    // The accounts it lists can sign in.
    expect(await canSignIn(SEED_ADMIN_EMAIL)).toBe(true);

    await expect(runSeed(OPTIONS)).rejects.toThrow(/already holds data/);
  });

  test('a second run with the same seed and anchor produces the same data', { timeout: 120_000 }, async () => {
    const summary = await runSeed(OPTIONS);
    expect(fingerprints).toHaveLength(1);
    expect(summary.fingerprint).toBe(fingerprints[0]);
  });
});

/** Whether the seed password matches this account's stored hash. */
async function canSignIn(email: string): Promise<boolean> {
  const row = await pool.query<{ password_hash: string }>('SELECT password_hash FROM auth.users WHERE email = $1', [email]);
  return verifyPassword(row.rows[0].password_hash, OPTIONS.password);
}

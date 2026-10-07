// The harness itself (FMS-74): test database, per-test rollback, factories.
import { describe, expect, test } from 'vitest';
import { pool } from '../../src/db';
import { createDepot, createDriver, createUser, createVehicle } from '../support/factories';

const MARKER = 'harness-isolation-check';

describe('test database', () => {
  test('tests run against the dedicated test database', async () => {
    const res = await pool.query<{ db: string }>('SELECT current_database() AS db');
    expect(res.rows[0].db).toMatch(/_test$/);
  });

  test('migrations ran: seeded roles exist', async () => {
    const res = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM auth.roles');
    expect(res.rows[0].n).toBe(9);
  });
});

describe('per-test rollback', () => {
  // Order matters: the second test checks what the first one wrote.
  test('writes data, including an audited mutation', async () => {
    await createDepot({ name: MARKER });
    const res = await pool.query("SELECT count(*)::int AS n FROM fleet.depots WHERE name = $1", [MARKER]);
    expect(res.rows[0].n).toBe(1);
  });

  test('sees none of the previous test\'s rows', async () => {
    const res = await pool.query("SELECT count(*)::int AS n FROM fleet.depots WHERE name = $1", [MARKER]);
    expect(res.rows[0].n).toBe(0);
  });

  test('a failing statement does not break the rest of the test', async () => {
    await expect(pool.query('SELECT * FROM no_such_table')).rejects.toThrow();
    const res = await pool.query<{ ok: number }>('SELECT 1 AS ok');
    expect(res.rows[0].ok).toBe(1);
  });
});

describe('factories', () => {
  test('a depot-scoped user with roles in one line', async () => {
    const depot = await createDepot();
    const user = await createUser({ roles: ['dispatcher', 'depot_admin'], depot });

    const roles = await pool.query<{ name: string }>(
      'SELECT r.name FROM auth.user_roles ur JOIN auth.roles r ON r.id = ur.role_id WHERE ur.user_id = $1 ORDER BY r.name',
      [user.id],
    );
    expect(roles.rows.map((r) => r.name)).toEqual(['depot_admin', 'dispatcher']);
    expect(user.depot_id).toBe(depot.id);
    expect(user.roles).toEqual(['dispatcher', 'depot_admin']);
  });

  test('an unknown role is rejected', async () => {
    await expect(createUser({ roles: ['pilot' as never] })).rejects.toThrow(/Unknown role/);
  });

  test('vehicles and drivers belong to the depot', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const ev = await createVehicle({ depot, fuel_type: 'electric', fuel_efficiency_ml_per_km: null });
    const { user, driver } = await createDriver({ depot });

    expect(vehicle.depot_id).toBe(depot.id);
    expect(ev.fuel_type).toBe('electric');
    expect(driver.user_id).toBe(user.id);
    expect(user.depot_id).toBe(depot.id);
  });

  test('repeated calls never collide on unique fields', async () => {
    const depot = await createDepot();
    for (let i = 0; i < 10; i++) await createVehicle({ depot });
    const res = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM fleet.vehicles WHERE depot_id = $1', [depot.id]);
    expect(res.rows[0].n).toBe(10);
  });
});

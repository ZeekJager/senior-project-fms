/**
 * Test data in one line. Each factory inserts through the app's pool, so the
 * rows live inside the current test's transaction and disappear afterwards.
 * Unique fields get random suffixes; pass overrides for anything that matters.
 *
 *   const depot = await createDepot();
 *   const dispatcher = await createUser({ roles: ['dispatcher'], depot });
 *   const { user, driver } = await createDriver({ depot });
 */
import { randomUUID } from 'node:crypto';
import { pool } from '../../src/db';

export type RoleName =
  | 'admin' | 'fleet_manager' | 'dispatcher' | 'driver' | 'technician'
  | 'depot_admin' | 'finance_clerk' | 'compliance_officer' | 'fleet_owner';

type Row = Record<string, unknown> & { id: string };

const unique = () => randomUUID().slice(0, 8);

async function insert(table: string, values: Record<string, unknown>): Promise<Row> {
  const keys = Object.keys(values);
  const res = await pool.query<Row>(
    `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    Object.values(values),
  );
  return res.rows[0];
}

export function createDepot(overrides: Record<string, unknown> = {}): Promise<Row> {
  return insert('fleet.depots', { name: `Depot ${unique()}`, location: 'Addis Ababa', code: `D-${unique()}`, ...overrides });
}

export interface CreateUserOptions {
  roles?: RoleName[];
  depot?: { id: string } | null;
  email?: string;
  fullName?: string;
  status?: 'active' | 'inactive' | 'suspended' | 'locked';
}

/** A user with roles, optionally scoped to a depot. `roles` is returned with the row. */
export async function createUser(options: CreateUserOptions = {}): Promise<Row & { roles: RoleName[] }> {
  const { roles = [], depot = null, status = 'active' } = options;
  const user = await insert('auth.users', {
    email: options.email ?? `user-${unique()}@test.fms`,
    password_hash: 'not-a-real-hash',
    full_name: options.fullName ?? 'Test User',
    depot_id: depot?.id ?? null,
    status,
  });
  if (roles.length) {
    const res = await pool.query(
      `INSERT INTO auth.user_roles (user_id, role_id)
       SELECT $1, id FROM auth.roles WHERE name = ANY($2::text[]) RETURNING role_id`,
      [user.id, roles],
    );
    if (res.rowCount !== roles.length) throw new Error(`Unknown role in [${roles.join(', ')}]`);
  }
  return { ...user, roles };
}

export function createVehicle(options: { depot: { id: string } } & Record<string, unknown>): Promise<Row> {
  const { depot, ...overrides } = options;
  return insert('fleet.vehicles', {
    depot_id: depot.id,
    registration_number: `AA-${unique()}`,
    vehicle_type: 'truck',
    fuel_type: 'diesel',
    fuel_efficiency_ml_per_km: 320,
    make: 'Isuzu',
    model: 'FSR',
    ...overrides,
  });
}

/** A driver: a user with the driver role in the depot, plus the fleet.drivers row. */
export async function createDriver(options: { depot: { id: string } } & Record<string, unknown>): Promise<{ user: Row; driver: Row }> {
  const { depot, ...overrides } = options;
  const user = await createUser({ roles: ['driver'], depot, fullName: 'Test Driver' });
  const driver = await insert('fleet.drivers', {
    user_id: user.id,
    license_number: `LIC-${unique()}`,
    license_expiry: '2030-12-31',
    ...overrides,
  });
  return { user, driver };
}

/**
 * The load suite's data (FMS-61): a new database, migrated, seeded at the budget size the performance budgets assume
 * (scripts/seed: 200 vehicles, 300 drivers, 1,000 trips and their history), then the accounts and devices the
 * scenarios use. Accounts get one password made for this run; it is never printed or stored.
 */
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { Client } from 'pg';
import { loadMigrationConfig } from '../../src/config/schema';
import { pool } from '../../src/db';
import { hashPassword } from '../../src/modules/auth';
import { gpsDevices } from '../../src/modules/integration';
import { auditedMutation } from '../../src/shared/infrastructure/audited-mutation';
import { withTransaction } from '../../src/shared/infrastructure/transaction';
import { applyMigrations } from '../lib/migrations';
import type { Point } from '../simulator/motion';

const BACKEND = path.resolve(__dirname, '../..');

function connect(database: string): Client {
  return new Client({ ...loadMigrationConfig(process.env), database });
}

/** Drops and recreates the load database, then applies every migration. */
export async function prepareDatabase(name: string): Promise<void> {
  const admin = connect('postgres');
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  const db = connect(name);
  await db.connect();
  try {
    await applyMigrations(db);
  } finally {
    await db.end();
  }
}

/** Runs the seed generator at `size` (budget: 200 vehicles; fleet500: 500) in its own process, as `npm run seed` does. */
export function seedDataset(size: 'budget' | 'fleet500'): Promise<void> {
  return new Promise((resolve, reject) => {
    // tsx as a loader of this Node, so no shell or .cmd shim is involved on any platform.
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/seed.ts', `--size=${size}`], {
      cwd: BACKEND,
      env: { ...process.env, FMS_SEED_PASSWORD: randomBytes(12).toString('base64url') },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`The seed exited with ${code}.`))));
  });
}

export interface Dataset {
  vehicles: number;
  drivers: number;
  trips: number;
  fuelLogs: number;
  gpsPings: number;
  maintenanceRecords: number;
}

/** How big the seeded data is, for the report. */
export async function datasetSize(): Promise<Dataset> {
  const count = async (table: string) => (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
  return {
    vehicles: await count('fleet.vehicles'),
    drivers: await count('fleet.drivers'),
    trips: await count('trip.trips'),
    fuelLogs: await count('fuel.fuel_logs'),
    gpsPings: await count('tracking.gps_pings'),
    maintenanceRecords: await count('maintenance.maintenance_records'),
  };
}

/** Domain events not yet delivered: the seed leaves thousands, and the API's relay works them off once it starts. */
export async function outboxBacklog(): Promise<number> {
  const res = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM events.outbox WHERE dead_lettered_at IS NULL AND (dispatched_at IS NULL OR published_at IS NULL)`,
  );
  return res.rows[0].n;
}

export interface LoadUsers {
  emails: string[];
  password: string;
}

/** `count` fleet managers (every depot), `load-<run>-NN@load.test`, sharing one password made for this run. */
export async function createUsers(count: number): Promise<LoadUsers> {
  const password = randomBytes(18).toString('base64url');
  const hash = await hashPassword(password);
  const run = randomBytes(3).toString('hex');
  const emails = Array.from({ length: count }, (_, i) => `load-${run}-${String(i + 1).padStart(2, '0')}@load.test`);
  await withTransaction(pool, async (client) => {
    for (const [i, email] of emails.entries()) {
      const user = await auditedMutation(client, { userId: null, correlationId: randomUUID() }, 'auth.users', 'INSERT', null, {
        email,
        password_hash: hash,
        full_name: `Load user ${i + 1}`,
        depot_id: null,
      });
      await client.query(`INSERT INTO auth.user_roles (user_id, role_id) SELECT $1, id FROM auth.roles WHERE name = 'fleet_manager'`, [user.id]);
    }
  });
  return { emails, password };
}

export interface FuelVehicle {
  publicId: string;
  odometerKm: number;
}

/** Live vehicles that take liquid fuel, with their odometer: one per user who logs fuel, so readings only rise. */
export async function fuelVehicles(count: number): Promise<FuelVehicle[]> {
  const res = await pool.query<{ public_id: string; odometer_km: number }>(
    `SELECT public_id, odometer_km::float8 AS odometer_km FROM fleet.vehicles
      WHERE is_active AND status <> 'retired' AND fuel_type <> 'electric' ORDER BY id LIMIT $1`,
    [count],
  );
  if (res.rows.length < count) throw new Error(`Only ${res.rows.length} vehicles take fuel; the scenario needs ${count}.`);
  return res.rows.map((r) => ({ publicId: r.public_id, odometerKm: r.odometer_km }));
}

export interface Device {
  vehicleId: string;
  token: string;
  centre: Point;
}

const ADDIS: Point = { lat: 9.0108, lng: 38.7613 };

/** A tracker device with a token for each of the first `count` live vehicles, as `npm run simulate:gps -- --via device` makes. */
export async function registerDevices(count: number): Promise<Device[]> {
  const res = await pool.query<{ public_id: string; lat: number | null; lng: number | null }>(
    `SELECT v.public_id, d.latitude::float8 AS lat, d.longitude::float8 AS lng
       FROM fleet.vehicles v LEFT JOIN fleet.depots d ON d.id = v.depot_id
      WHERE v.is_active AND v.status <> 'retired' ORDER BY v.id LIMIT $1`,
    [count],
  );
  if (res.rows.length < count) throw new Error(`Only ${res.rows.length} live vehicles; the scenario needs ${count}.`);
  const ctx = { userId: null, correlationId: randomUUID() };
  const devices: Device[] = [];
  for (const v of res.rows) {
    const { token } = await gpsDevices.register({ vehicleId: v.public_id, identifier: `load-${v.public_id}`, model: 'FMS load test' }, ctx);
    devices.push({ vehicleId: v.public_id, token, centre: v.lat !== null && v.lng !== null ? { lat: v.lat, lng: v.lng } : ADDIS });
  }
  return devices;
}

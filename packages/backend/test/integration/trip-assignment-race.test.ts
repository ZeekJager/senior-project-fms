/**
 * Concurrent trip assignment (FMS-31): two dispatchers at the same moment.
 *
 * The usual harness runs each test on one connection inside a rolled-back
 * transaction, so requests there never truly race. Here the trip service
 * runs on its own pool, with one connection per assignment and real
 * commits, as in production. Committed audit rows cannot be deleted (they
 * are append-only), so this file works in its own database, migrated like
 * the test database and dropped afterwards.
 */
import { randomUUID } from 'node:crypto';
import { Client, Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { applyMigrations } from '../../scripts/lib/migrations';
import { config } from '../../src/config';
import { loadMigrationConfig } from '../../src/config/schema';
import { tripRefs } from '../../src/modules/fleet';
import { maintenanceRefs } from '../../src/modules/maintenance';
import { TripService, type TripAssignment } from '../../src/modules/trip/application/trip.service';
import { TripRepository } from '../../src/modules/trip/infrastructure/trip.repository';
import { RouteRepository } from '../../src/modules/trip/infrastructure/route.repository';
import { toAppError } from '../../src/shared/errors/to-app-error';
import { eventBus } from '../../src/shared/events/event-bus';
import { TEST_DB_NAME } from '../support/test-env';

const RACE_DB = `${TEST_DB_NAME}_race`;

/** As the schema owner (DB_ADMIN_USER), on another database of the same server. */
function adminClient(database: string): Client {
  return new Client({ ...loadMigrationConfig(process.env), database });
}

async function onServer(sql: string) {
  const admin = adminClient('postgres');
  await admin.connect();
  try {
    await admin.query(sql);
  } finally {
    await admin.end();
  }
}

let real: Pool;
let service: TripService;

beforeAll(async () => {
  await onServer(`DROP DATABASE IF EXISTS "${RACE_DB}" WITH (FORCE)`);
  await onServer(`CREATE DATABASE "${RACE_DB}"`);
  const owner = adminClient(RACE_DB);
  await owner.connect();
  try {
    await applyMigrations(owner);
  } finally {
    await owner.end();
  }
  // The app's role and settings, on the race database.
  real = new Pool({ ...config.db, database: RACE_DB, max: 6 });
  service = new TripService({ trips: new TripRepository(real), routes: new RouteRepository(real), fleet: () => tripRefs, maintenance: () => maintenanceRefs, events: eventBus, overrunGraceMinutes: 0 });
});

afterAll(async () => {
  await real?.end();
  await onServer(`DROP DATABASE IF EXISTS "${RACE_DB}" WITH (FORCE)`);
});

type Ref = { id: string; publicId: string };
type Caller = Parameters<TripService['assign']>[0];

const one = async <T>(sql: string, params: unknown[]) => (await real.query(sql, params)).rows[0] as T;

/** Committed rows: a depot, an admin, truck drivers, trucks, and scheduled trips in the given windows. */
async function fixtures(drivers: number, vehicles: number, windows: [string, string][]): Promise<{ caller: Caller; drivers: Ref[]; vehicles: Ref[]; trips: Ref[] }> {
  const tag = randomUUID().slice(0, 8);
  const ref = (row: { id: string; public_id: string }): Ref => ({ id: row.id, publicId: row.public_id });
  const depot = await one<{ id: string }>("INSERT INTO fleet.depots (name, location, code) VALUES ($1, 'Addis Ababa', $1) RETURNING id", [`Race ${tag}`]);
  const admin = await one<{ id: string; public_id: string }>(
    "INSERT INTO auth.users (email, password_hash, full_name) VALUES ($1, 'x', 'Race Admin') RETURNING id, public_id",
    [`admin-${tag}@race.test`],
  );
  const out = { caller: { user: { id: admin.id, publicId: admin.public_id, roles: ['admin'], permissions: [], depotId: null }, correlationId: randomUUID() }, drivers: [] as Ref[], vehicles: [] as Ref[], trips: [] as Ref[] };
  for (let i = 0; i < drivers; i++) {
    const user = await one<{ id: string }>("INSERT INTO auth.users (email, password_hash, full_name, depot_id) VALUES ($1, 'x', 'Race Driver', $2) RETURNING id", [`driver-${i}-${tag}@race.test`, depot.id]);
    await real.query('INSERT INTO fleet.driver_accounts (user_id, full_name, email, depot_id, account_status) SELECT id, full_name, email, depot_id, status FROM auth.users WHERE id = $1', [user.id]);
    out.drivers.push(
      ref(await one("INSERT INTO fleet.drivers (user_id, license_number, license_expiry, license_categories) VALUES ($1, $2, '2030-12-31', '{C}') RETURNING id, public_id", [user.id, `RACE-${i}-${tag}`])),
    );
  }
  for (let i = 0; i < vehicles; i++) {
    out.vehicles.push(
      ref(
        await one(
          "INSERT INTO fleet.vehicles (depot_id, registration_number, vehicle_type, fuel_type, fuel_efficiency_ml_per_km, make, model) VALUES ($1, $2, 'truck', 'diesel', 320, 'Isuzu', 'FSR') RETURNING id, public_id",
          [depot.id, `RC-${i}-${tag}`],
        ),
      ),
    );
  }
  const route = await one<{ id: string }>('INSERT INTO trip.routes (name, depot_id) VALUES ($1, $2) RETURNING id', [`Race route ${tag}`, depot.id]);
  for (const [start, end] of windows) {
    out.trips.push(ref(await one("INSERT INTO trip.trips (route_id, status, scheduled_start, scheduled_end) VALUES ($1, 'scheduled', $2, $3) RETURNING id, public_id", [route.id, start, end])));
  }
  return out;
}

/** Runs both at once; returns how many succeeded and the error codes of the others. */
async function race(caller: Caller, a: [string, TripAssignment], b: [string, TripAssignment]) {
  const results = await Promise.allSettled([service.assign(caller, ...a), service.assign(caller, ...b)]);
  return {
    ok: results.filter((r) => r.status === 'fulfilled').length,
    codes: results.flatMap((r) => (r.status === 'rejected' ? [toAppError(r.reason).code] : [])),
  };
}

describe('two dispatchers at once', () => {
  test('assigning the same trip twice with the same version: exactly one succeeds, the other is CONFLICT_CONCURRENT_MODIFICATION', async () => {
    const f = await fixtures(2, 2, [['2026-12-01T06:00:00Z', '2026-12-01T09:00:00Z']]);
    const trip = f.trips[0].publicId;
    const result = await race(
      f.caller,
      [trip, { driver_id: f.drivers[0].publicId, vehicle_id: f.vehicles[0].publicId, version: 0 }],
      [trip, { driver_id: f.drivers[1].publicId, vehicle_id: f.vehicles[1].publicId, version: 0 }],
    );
    expect(result).toEqual({ ok: 1, codes: ['CONFLICT_CONCURRENT_MODIFICATION'] });
    expect(await one('SELECT status, version FROM trip.trips WHERE id = $1', [f.trips[0].id])).toEqual({ status: 'assigned', version: 1 });
    expect(await one("SELECT count(*)::int AS n FROM events.outbox WHERE event_type = 'TripAssigned' AND aggregate_key = $1", [`trip:${trip}`])).toEqual({ n: 1 });
  });

  test('two overlapping trips claiming one driver at once: exactly one succeeds, the other is CONFLICT_DRIVER_OVERLAP', async () => {
    // Back to back: the second starts when the first ends, which counts as an overlap.
    const f = await fixtures(1, 2, [
      ['2026-12-02T06:00:00Z', '2026-12-02T09:00:00Z'],
      ['2026-12-02T09:00:00Z', '2026-12-02T11:00:00Z'],
    ]);
    const result = await race(
      f.caller,
      [f.trips[0].publicId, { driver_id: f.drivers[0].publicId, vehicle_id: f.vehicles[0].publicId, version: 0 }],
      [f.trips[1].publicId, { driver_id: f.drivers[0].publicId, vehicle_id: f.vehicles[1].publicId, version: 0 }],
    );
    expect(result).toEqual({ ok: 1, codes: ['CONFLICT_DRIVER_OVERLAP'] });
    expect(await one("SELECT count(*)::int AS n FROM trip.trips WHERE id = ANY($1::bigint[]) AND status = 'assigned'", [f.trips.map((t) => t.id)])).toEqual({ n: 1 });
  });

  test('when both get past the checks, the database still refuses the second: 23P01 becomes CONFLICT_VEHICLE_OVERLAP', async () => {
    const f = await fixtures(2, 1, [
      ['2026-12-03T06:00:00Z', '2026-12-03T09:00:00Z'],
      ['2026-12-03T08:00:00Z', '2026-12-03T10:00:00Z'],
    ]);
    const a: PoolClient = await real.connect();
    const b: PoolClient = await real.connect();
    try {
      const assignSql = "UPDATE trip.trips SET status = 'assigned', driver_id = $2, vehicle_id = $3 WHERE id = $1";
      await a.query('BEGIN');
      await b.query('BEGIN');
      await a.query(assignSql, [f.trips[0].id, f.drivers[0].id, f.vehicles[0].id]);
      // B waits on A's uncommitted row in the exclusion index, then fails once A commits.
      const second = b.query(assignSql, [f.trips[1].id, f.drivers[1].id, f.vehicles[0].id]).then(
        () => null,
        (err: unknown) => err,
      );
      await a.query('COMMIT');
      const err = await second;
      await b.query('ROLLBACK');
      expect(err).toMatchObject({ code: '23P01', constraint: 'ex_trip_vehicle_overlap' });
      expect(toAppError(err)).toMatchObject({ status: 409, code: 'CONFLICT_VEHICLE_OVERLAP' });
    } finally {
      a.release();
      b.release();
    }
  });
});

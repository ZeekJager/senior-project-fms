import { randomUUID } from 'node:crypto';
import request, { type Response } from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { hashPassword } from '../../src/modules/auth';
import { createDepot, createDriver, createTrip, createUser, createVehicle, type RoleName } from '../support/factories';
import { publishedEvents } from '../support/events';

const app = createApp();
const PASSWORD = 'Fuel-Test-1';

type Depot = Awaited<ReturnType<typeof createDepot>>;
type Vehicle = Awaited<ReturnType<typeof createVehicle>>;

async function login(email: string): Promise<string> {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

async function signIn(roles: RoleName[], depot: Depot | null = null): Promise<string> {
  const user = await createUser({ roles, depot, password: PASSWORD });
  return login(user.email as string);
}

/** A driver who can sign in, with their fleet.drivers row. */
async function driverWithLogin(depot: Depot) {
  const { user, driver } = await createDriver({ depot });
  await pool.query('UPDATE auth.users SET password_hash = $2 WHERE id = $1', [user.id, await hashPassword(PASSWORD)]);
  return { user, driver, cookie: await login(user.email as string) };
}

const api = {
  get: (path: string, cookie: string) => request(app).get(`/api/v1${path}`).set('Cookie', cookie),
  post: (path: string, body: object, cookie: string, key?: string) => {
    const req = request(app).post(`/api/v1${path}`).set('Cookie', cookie);
    return (key ? req.set('Idempotency-Key', key) : req).send(body);
  },
};

const pub = (row: Record<string, unknown>) => row.public_id as string;

/** A valid body for a vehicle; override anything the test is about. */
const fill = (vehicle: Vehicle, extra: Record<string, unknown> = {}) => ({
  vehicle_id: pub(vehicle),
  quantity_ml: 45_500,
  total_cost_cents: 380_000,
  odometer_km: 12_000.5,
  ...extra,
});

/** A log straight into the table, for the read tests (the API writes are tested above them). */
async function insertLog(vehicle: Vehicle, driver: { id: unknown } | null, extra: Record<string, unknown> = {}) {
  const values = {
    vehicle_id: vehicle.id,
    driver_id: driver?.id ?? null,
    fuel_type: 'diesel',
    quantity_ml: 40_000,
    total_cost_cents: 300_000,
    odometer_km: 5_000,
    ...extra,
  };
  const keys = Object.keys(values);
  const res = await pool.query<{ id: string; public_id: string }>(
    `INSERT INTO fuel.fuel_logs (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id, public_id`,
    Object.values(values),
  );
  return res.rows[0];
}

/** A trip in its own two-hour window: a driver cannot be assigned to overlapping trips. */
let slot = 0;
function tripFor(vehicle: Vehicle, driver: { id: unknown }, extra: Record<string, unknown> = {}) {
  slot += 1;
  const start = new Date(Date.UTC(2031, 0, 1, 0, 0, 0) + slot * 3 * 60 * 60 * 1000);
  return createTrip({
    vehicle,
    driver: driver as { id: string },
    scheduled_start: start.toISOString(),
    scheduled_end: new Date(start.getTime() + 2 * 60 * 60 * 1000).toISOString(),
    ...extra,
  });
}

async function routeIn(depot: Depot) {
  return (await pool.query<{ id: string }>('INSERT INTO trip.routes (name, depot_id) VALUES ($1, $2) RETURNING id', [`R ${randomUUID().slice(0, 6)}`, depot.id])).rows[0];
}

const logCount = async (vehicle: Vehicle) =>
  (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM fuel.fuel_logs WHERE vehicle_id = $1', [vehicle.id])).rows[0].n;

async function auditRows(res: Response) {
  const rows = await pool.query<{ action: string; entity_type: string }>(
    'SELECT action, entity_type FROM audit.audit_logs WHERE correlation_id = $1 ORDER BY id',
    [res.headers['x-request-id']],
  );
  return rows.rows.map((r) => `${r.action} ${r.entity_type}`);
}

const ids = (res: Response) => (res.body.data as { id: string }[]).map((l) => l.id);

describe('POST /fuel-logs', () => {
  test('a driver logs their own fill-up: 201, their driver id, the vehicle fuel type, one audit row and a FuelLogged event', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot, fuel_type: 'diesel' });
    const { driver, cookie } = await driverWithLogin(depot);

    const res = await api.post('/fuel-logs', fill(vehicle, { station_name: ' Total Bole ', unit_price_cents: 8_350 }), cookie);
    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(`/api/v1/fuel-logs/${res.body.data.id}`);
    expect(res.body.data).toMatchObject({
      vehicle_id: pub(vehicle),
      driver_id: pub(driver),
      trip_id: null,
      fuel_type: 'diesel',
      quantity_ml: 45_500,
      total_cost_cents: 380_000,
      unit_price_cents: 8_350,
      odometer_km: 12_000.5,
      station_name: 'Total Bole',
      source: 'manual',
    });
    expect(Number.isNaN(Date.parse(res.body.data.recorded_at))).toBe(false);
    expect(await auditRows(res)).toEqual(['INSERT fuel.fuel_logs']);

    const [event, ...rest] = await publishedEvents('FuelLogged');
    expect(rest).toEqual([]);
    expect(event.aggregate).toBe(`vehicle:${pub(vehicle)}`);
    expect(event.payload).toMatchObject({
      fuel_log_id: res.body.data.id,
      vehicle_id: pub(vehicle),
      driver_id: pub(driver),
      trip_id: null,
      fuel_type: 'diesel',
      quantity_ml: 45_500,
      total_cost_cents: 380_000,
      odometer_km: 12_000.5,
      previous_odometer_km: null,
    });
  });

  test('a second log carries the reading of the one before it in the event', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const cookie = await signIn(['depot_admin'], depot);
    expect((await api.post('/fuel-logs', fill(vehicle, { odometer_km: 1_000 }), cookie)).status).toBe(201);
    expect((await api.post('/fuel-logs', fill(vehicle, { odometer_km: 1_450.5 }), cookie)).status).toBe(201);

    const events = await publishedEvents('FuelLogged');
    expect(events.map((e) => e.payload.previous_odometer_km)).toEqual([null, 1_000]);
  });

  test('staff may name the driver, or none; a fuel type other than the default is kept', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot, fuel_type: 'diesel' });
    const { driver } = await createDriver({ depot });
    const cookie = await signIn(['depot_admin'], depot);

    const named = await api.post('/fuel-logs', fill(vehicle, { driver_id: pub(driver), fuel_type: 'petrol' }), cookie);
    expect(named.status).toBe(201);
    expect(named.body.data).toMatchObject({ driver_id: pub(driver), fuel_type: 'petrol' });

    const anonymous = await api.post('/fuel-logs', fill(vehicle, { odometer_km: 13_000 }), cookie);
    expect(anonymous.status).toBe(201);
    expect(anonymous.body.data.driver_id).toBeNull();
  });

  test('a fleet manager logs for a vehicle in any depot; a depot admin only in their own', async () => {
    const [mine, other] = [await createDepot(), await createDepot()];
    const elsewhere = await createVehicle({ depot: other });

    expect((await api.post('/fuel-logs', fill(elsewhere), await signIn(['fleet_manager']))).status).toBe(201);

    const refused = await api.post('/fuel-logs', fill(elsewhere, { odometer_km: 99_000 }), await signIn(['depot_admin'], mine));
    expect(refused.status).toBe(400);
    expect(refused.body.error.details).toEqual([{ field: 'vehicle_id', reason: 'references_missing_record' }]);
  });

  test('roles without fuel:write get 403; no sign-in is 401', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    for (const role of ['dispatcher', 'technician', 'compliance_officer'] as const) {
      const res = await api.post('/fuel-logs', fill(vehicle), await signIn([role], depot));
      expect(res.status, role).toBe(403);
    }
    expect((await request(app).post('/api/v1/fuel-logs').send(fill(vehicle))).status).toBe(401);
    expect(await logCount(vehicle)).toBe(0);
  });

  describe('validation', () => {
    async function setup() {
      const depot = await createDepot();
      const vehicle = await createVehicle({ depot });
      return { vehicle, cookie: await signIn(['depot_admin'], depot) };
    }

    test('23500.5 ml is 400 VALIDATION_FLOAT_IN_MONEY_PATH, and so is a fractional cost or price', async () => {
      const { vehicle, cookie } = await setup();
      for (const body of [{ quantity_ml: 23_500.5 }, { total_cost_cents: 1_500.5 }, { unit_price_cents: 83.5 }]) {
        const res = await api.post('/fuel-logs', fill(vehicle, body), cookie);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_FLOAT_IN_MONEY_PATH');
        expect(res.body.error.details[0]).toMatchObject({ field: Object.keys(body)[0], reason: 'float_in_money_path' });
      }
      // Also under a name the API does not accept: "use whole cents" beats "unknown field".
      const renamed = await api.post('/fuel-logs', fill(vehicle, { totalCost: 1_500.5 }), cookie);
      expect(renamed.body.error.code).toBe('VALIDATION_FLOAT_IN_MONEY_PATH');
      expect(await logCount(vehicle)).toBe(0);
    });

    test('a whole number written with a decimal point (45500.0) is still a whole number', async () => {
      const { vehicle, cookie } = await setup();
      const res = await request(app)
        .post('/api/v1/fuel-logs')
        .set('Cookie', cookie)
        .set('Content-Type', 'application/json')
        .send(`{"vehicle_id":"${pub(vehicle)}","quantity_ml":45500.0,"total_cost_cents":380000.0,"odometer_km":10}`);
      expect(res.status).toBe(201);
      expect(res.body.data.quantity_ml).toBe(45_500);
    });

    test('quantity must be between 1 ml and 2,000 litres; cost between 0 and 1,000,000 birr', async () => {
      const { vehicle, cookie } = await setup();
      for (const body of [{ quantity_ml: 0 }, { quantity_ml: -5 }, { quantity_ml: 2_000_001 }, { total_cost_cents: -1 }, { total_cost_cents: 100_000_001 }]) {
        const res = await api.post('/fuel-logs', fill(vehicle, body), cookie);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
        expect(res.body.error.details[0]).toMatchObject({ field: Object.keys(body)[0], reason: 'out_of_range' });
      }
      expect((await api.post('/fuel-logs', fill(vehicle, { quantity_ml: 2_000_000, total_cost_cents: 0 }), cookie)).status).toBe(201);
    });

    test('the odometer is required, not negative and has at most one decimal; text is refused', async () => {
      const { vehicle, cookie } = await setup();
      const withoutOdometer: Record<string, unknown> = fill(vehicle);
      delete withoutOdometer.odometer_km;
      const missing = await api.post('/fuel-logs', withoutOdometer, cookie);
      expect(missing.status).toBe(400);
      expect(missing.body.error.details).toEqual([{ field: 'odometer_km', reason: 'invalid_type' }]);

      const decimals = await api.post('/fuel-logs', fill(vehicle, { odometer_km: 100.25 }), cookie);
      expect(decimals.body.error.details).toEqual([{ field: 'odometer_km', reason: 'too_many_decimals' }]);
      expect((await api.post('/fuel-logs', fill(vehicle, { odometer_km: -1 }), cookie)).status).toBe(400);
      expect((await api.post('/fuel-logs', fill(vehicle, { quantity_ml: '45500' }), cookie)).status).toBe(400);
    });

    test('vehicle_id must be a UUID; anything the API does not accept is not_writable', async () => {
      const { vehicle, cookie } = await setup();
      const bad = await api.post('/fuel-logs', fill(vehicle, { vehicle_id: 'AA-1234' }), cookie);
      expect(bad.status).toBe(400);
      expect(bad.body.error.details[0].field).toBe('vehicle_id');

      const extra = await api.post('/fuel-logs', fill(vehicle, { source: 'fuel_card', recorded_at: '2020-01-01T00:00:00Z' }), cookie);
      expect(extra.status).toBe(400);
      expect(extra.body.error.details).toEqual([
        { field: 'source', reason: 'not_writable' },
        { field: 'recorded_at', reason: 'not_writable' },
      ]);

      const wrongType = await api.post('/fuel-logs', fill(vehicle, { fuel_type: 'water' }), cookie);
      expect(wrongType.body.error.code).toBe('VALIDATION_INVALID_ENUM');
    });
  });

  describe('odometer regression', () => {
    test('a reading below the vehicle odometer is 409 CONFLICT_ODOMETER_REGRESSION and records nothing', async () => {
      const depot = await createDepot();
      const vehicle = await createVehicle({ depot, odometer_km: 1_000 });
      const cookie = await signIn(['depot_admin'], depot);

      const res = await api.post('/fuel-logs', fill(vehicle, { odometer_km: 999.9 }), cookie);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT_ODOMETER_REGRESSION');
      expect(res.body.error.details).toEqual([{ field: 'odometer_km', reason: 'below_last_reading' }]);
      expect(res.body.error.message).toContain('1000 km');
      expect(await logCount(vehicle)).toBe(0);
      expect(await publishedEvents('FuelLogged')).toEqual([]);

      // The same reading as the vehicle's is fine: it has not gone down.
      expect((await api.post('/fuel-logs', fill(vehicle, { odometer_km: 1_000 }), cookie)).status).toBe(201);
    });

    test('a reading below the last fuel log is 409 too, even when the vehicle odometer is lower', async () => {
      const depot = await createDepot();
      const vehicle = await createVehicle({ depot, odometer_km: 100 });
      const cookie = await signIn(['depot_admin'], depot);
      expect((await api.post('/fuel-logs', fill(vehicle, { odometer_km: 5_000 }), cookie)).status).toBe(201);

      const res = await api.post('/fuel-logs', fill(vehicle, { odometer_km: 4_999.9 }), cookie);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT_ODOMETER_REGRESSION');
      expect(res.body.error.message).toContain('5000 km');
      expect(await logCount(vehicle)).toBe(1);
      expect((await api.post('/fuel-logs', fill(vehicle, { odometer_km: 5_000.1 }), cookie)).status).toBe(201);
    });

    test("one vehicle's readings do not constrain another's", async () => {
      const depot = await createDepot();
      const [a, b] = [await createVehicle({ depot }), await createVehicle({ depot })];
      const cookie = await signIn(['depot_admin'], depot);
      expect((await api.post('/fuel-logs', fill(a, { odometer_km: 90_000 }), cookie)).status).toBe(201);
      expect((await api.post('/fuel-logs', fill(b, { odometer_km: 10 }), cookie)).status).toBe(201);
    });
  });

  describe('Idempotency-Key', () => {
    test('a retry with the same key returns the original log and writes one row and one event', async () => {
      const depot = await createDepot();
      const vehicle = await createVehicle({ depot });
      const { cookie } = await driverWithLogin(depot);
      const key = `fuel-${randomUUID()}`;

      const first = await api.post('/fuel-logs', fill(vehicle), cookie, key);
      const retry = await api.post('/fuel-logs', fill(vehicle), cookie, key);
      expect(first.status).toBe(201);
      expect(retry.status).toBe(201);
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(retry.body.data).toEqual(first.body.data);
      expect(await logCount(vehicle)).toBe(1);
      expect(await publishedEvents('FuelLogged')).toHaveLength(1);
    });

    test('without a key, the same body is logged twice (two real fill-ups); the same key with another body is 409', async () => {
      const depot = await createDepot();
      const vehicle = await createVehicle({ depot });
      const cookie = await signIn(['depot_admin'], depot);

      expect((await api.post('/fuel-logs', fill(vehicle), cookie)).status).toBe(201);
      expect((await api.post('/fuel-logs', fill(vehicle), cookie)).status).toBe(201);
      expect(await logCount(vehicle)).toBe(2);

      const key = `fuel-${randomUUID()}`;
      expect((await api.post('/fuel-logs', fill(vehicle, { odometer_km: 20_000 }), cookie, key)).status).toBe(201);
      const reused = await api.post('/fuel-logs', fill(vehicle, { odometer_km: 20_000, quantity_ml: 1_000 }), cookie, key);
      expect(reused.status).toBe(409);
      expect(reused.body.error.code).toBe('CONFLICT_IDEMPOTENCY_KEY_REUSED');
      expect(await logCount(vehicle)).toBe(3);
    });

    test('a refused log frees its key, so the corrected retry goes through', async () => {
      const depot = await createDepot();
      const vehicle = await createVehicle({ depot, odometer_km: 5_000 });
      const cookie = await signIn(['depot_admin'], depot);
      const key = `fuel-${randomUUID()}`;

      expect((await api.post('/fuel-logs', fill(vehicle, { odometer_km: 10 }), cookie, key)).status).toBe(409);
      expect((await api.post('/fuel-logs', fill(vehicle, { odometer_km: 5_100 }), cookie, key)).status).toBe(201);
    });
  });

  describe('vehicle, fuel type, driver and trip', () => {
    test('an unknown vehicle and a vehicle in another depot are refused with the same body', async () => {
      const [mine, other] = [await createDepot(), await createDepot()];
      const cookie = await signIn(['depot_admin'], mine);
      const unknown = await api.post('/fuel-logs', { ...fill(await createVehicle({ depot: mine })), vehicle_id: randomUUID() }, cookie);
      const foreign = await api.post('/fuel-logs', fill(await createVehicle({ depot: other })), cookie);
      expect(unknown.status).toBe(400);
      expect(foreign.status).toBe(400);
      expect(foreign.body.error).toEqual(unknown.body.error);
    });

    test('a retired vehicle takes no fuel logs', async () => {
      const depot = await createDepot();
      const vehicle = await createVehicle({ depot, is_active: false, status: 'retired' });
      const res = await api.post('/fuel-logs', fill(vehicle), await signIn(['depot_admin'], depot));
      expect(res.status).toBe(400);
      expect(res.body.error.details).toEqual([{ field: 'vehicle_id', reason: 'vehicle_retired' }]);
    });

    test('an electric vehicle is charged, not fuelled; electric cannot be named either', async () => {
      const depot = await createDepot();
      const ev = await createVehicle({ depot, fuel_type: 'electric', fuel_efficiency_ml_per_km: null });
      const diesel = await createVehicle({ depot, fuel_type: 'diesel' });
      const cookie = await signIn(['depot_admin'], depot);

      const own = await api.post('/fuel-logs', fill(ev), cookie);
      expect(own.status).toBe(400);
      expect(own.body.error.details).toEqual([{ field: 'fuel_type', reason: 'not_a_liquid_fuel' }]);
      expect((await api.post('/fuel-logs', fill(diesel, { fuel_type: 'electric' }), cookie)).status).toBe(400);
      expect((await api.post('/fuel-logs', fill(ev, { fuel_type: 'petrol' }), cookie)).status).toBe(201);
    });

    test('a driver may not name another driver, may name themselves, and one without a profile cannot log', async () => {
      const depot = await createDepot();
      const vehicle = await createVehicle({ depot });
      const { driver, cookie } = await driverWithLogin(depot);
      const { driver: colleague } = await createDriver({ depot });

      const other = await api.post('/fuel-logs', fill(vehicle, { driver_id: pub(colleague) }), cookie);
      expect(other.status).toBe(400);
      expect(other.body.error.details).toEqual([{ field: 'driver_id', reason: 'not_writable' }]);
      expect(await logCount(vehicle)).toBe(0);

      const self = await api.post('/fuel-logs', fill(vehicle, { driver_id: pub(driver) }), cookie);
      expect(self.status).toBe(201);
      expect(self.body.data.driver_id).toBe(pub(driver));

      const bare = await createUser({ roles: ['driver'], depot, password: PASSWORD });
      const noProfile = await api.post('/fuel-logs', fill(vehicle, { odometer_km: 99_000 }), await login(bare.email as string));
      expect(noProfile.status).toBe(400);
      expect(noProfile.body.error.details).toEqual([{ field: 'driver_id', reason: 'no_driver_profile' }]);
    });

    test("a driver logs only for their depot's vehicles", async () => {
      const [mine, other] = [await createDepot(), await createDepot()];
      const { cookie } = await driverWithLogin(mine);
      const res = await api.post('/fuel-logs', fill(await createVehicle({ depot: other })), cookie);
      expect(res.status).toBe(400);
      expect(res.body.error.details).toEqual([{ field: 'vehicle_id', reason: 'references_missing_record' }]);
    });

    test('staff cannot name a driver from another depot or one that does not exist', async () => {
      const [mine, other] = [await createDepot(), await createDepot()];
      const vehicle = await createVehicle({ depot: mine });
      const { driver: foreign } = await createDriver({ depot: other });
      const cookie = await signIn(['depot_admin'], mine);

      for (const driverId of [pub(foreign), randomUUID()]) {
        const res = await api.post('/fuel-logs', fill(vehicle, { driver_id: driverId }), cookie);
        expect(res.status).toBe(400);
        expect(res.body.error.details).toEqual([{ field: 'driver_id', reason: 'references_missing_record' }]);
      }
    });

    test("a trip of the vehicle is linked; another vehicle's trip, an unknown trip and another driver's trip are 400", async () => {
      const depot = await createDepot();
      const [vehicle, otherVehicle] = [await createVehicle({ depot }), await createVehicle({ depot })];
      const { driver, cookie } = await driverWithLogin(depot);
      const { driver: colleague } = await createDriver({ depot });
      const mine = await tripFor(vehicle, driver);
      const wrongVehicle = await tripFor(otherVehicle, driver);
      const theirs = await tripFor(vehicle, colleague);

      const linked = await api.post('/fuel-logs', fill(vehicle, { trip_id: pub(mine) }), cookie);
      expect(linked.status).toBe(201);
      expect(linked.body.data.trip_id).toBe(pub(mine));
      expect((await publishedEvents('FuelLogged'))[0].payload.trip_id).toBe(pub(mine));

      const mismatch = await api.post('/fuel-logs', fill(vehicle, { trip_id: pub(wrongVehicle), odometer_km: 13_000 }), cookie);
      expect(mismatch.status).toBe(400);
      expect(mismatch.body.error.details).toEqual([{ field: 'trip_id', reason: 'trip_vehicle_mismatch' }]);

      for (const tripId of [randomUUID(), pub(theirs)]) {
        const res = await api.post('/fuel-logs', fill(vehicle, { trip_id: tripId, odometer_km: 13_000 }), cookie);
        expect(res.status).toBe(400);
        expect(res.body.error.details).toEqual([{ field: 'trip_id', reason: 'references_missing_record' }]);
      }
      expect(await logCount(vehicle)).toBe(1);
    });

    test("a depot admin links a trip planned on their depot's route, but not another depot's", async () => {
      const [mine, other] = [await createDepot(), await createDepot()];
      const vehicle = await createVehicle({ depot: mine });
      const { driver } = await createDriver({ depot: mine });
      const ownTrip = await tripFor(vehicle, driver, { route_id: (await routeIn(mine)).id });
      const foreignTrip = await tripFor(vehicle, driver, { route_id: (await routeIn(other)).id });
      const cookie = await signIn(['depot_admin'], mine);

      expect((await api.post('/fuel-logs', fill(vehicle, { trip_id: pub(ownTrip) }), cookie)).status).toBe(201);
      const res = await api.post('/fuel-logs', fill(vehicle, { trip_id: pub(foreignTrip), odometer_km: 13_000 }), cookie);
      expect(res.status).toBe(400);
      expect(res.body.error.details).toEqual([{ field: 'trip_id', reason: 'references_missing_record' }]);
    });
  });
});

describe('GET /fuel-logs and /fuel-logs/{id}', () => {
  test("a driver lists only their own logs, and another driver's log by id is 404 with the body of a missing id", async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const { driver, cookie } = await driverWithLogin(depot);
    const { driver: colleague } = await createDriver({ depot });
    const [mine, theirs] = [await insertLog(vehicle, driver), await insertLog(vehicle, colleague, { odometer_km: 6_000 })];
    await insertLog(vehicle, null, { odometer_km: 7_000 });

    const list = await api.get('/fuel-logs', cookie);
    expect(list.status).toBe(200);
    expect(ids(list)).toEqual([mine.public_id]);
    expect(list.body.meta).toMatchObject({ page: 1, page_size: 25, total_items: 1, total_pages: 1 });

    expect((await api.get(`/fuel-logs/${mine.public_id}`, cookie)).status).toBe(200);
    const foreign = await api.get(`/fuel-logs/${theirs.public_id}`, cookie);
    const missing = await api.get(`/fuel-logs/${randomUUID()}`, cookie);
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(foreign.body.error).toEqual(missing.body.error);
    expect(foreign.body.error.code).toBe('NOT_FOUND');
  });

  test("a driver cannot widen their view with filters on another driver's or another vehicle's logs", async () => {
    const depot = await createDepot();
    const [vehicle, other] = [await createVehicle({ depot }), await createVehicle({ depot })];
    const { driver, cookie } = await driverWithLogin(depot);
    const { driver: colleague } = await createDriver({ depot });
    await insertLog(vehicle, driver);
    await insertLog(other, colleague);

    expect(ids(await api.get(`/fuel-logs?driver_id=${pub(colleague)}`, cookie))).toEqual([]);
    expect(ids(await api.get(`/fuel-logs?vehicle_id=${pub(other)}`, cookie))).toEqual([]);
  });

  test('a driver with no driver profile sees nothing', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    await insertLog(vehicle, null);
    const bare = await createUser({ roles: ['driver'], depot, password: PASSWORD });
    const res = await api.get('/fuel-logs', await login(bare.email as string));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  test("staff see the logs of their depot's vehicles; another depot's log by id is 404; a fleet manager sees both", async () => {
    const [mine, other] = [await createDepot(), await createDepot()];
    const [ownVehicle, foreignVehicle] = [await createVehicle({ depot: mine }), await createVehicle({ depot: other })];
    const [ownLog, foreignLog] = [await insertLog(ownVehicle, null), await insertLog(foreignVehicle, null)];
    const admin = await signIn(['depot_admin'], mine);

    expect(ids(await api.get('/fuel-logs', admin))).toEqual([ownLog.public_id]);
    expect((await api.get(`/fuel-logs/${ownLog.public_id}`, admin)).status).toBe(200);
    expect((await api.get(`/fuel-logs/${foreignLog.public_id}`, admin)).status).toBe(404);

    const all = ids(await api.get('/fuel-logs?page_size=100', await signIn(['fleet_manager'])));
    expect(all).toEqual(expect.arrayContaining([ownLog.public_id, foreignLog.public_id]));
  });

  test('a depot-scoped user with no depot sees nothing', async () => {
    const depot = await createDepot();
    await insertLog(await createVehicle({ depot }), null);
    const res = await api.get('/fuel-logs', await signIn(['depot_admin'], null));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  test('roles without fuel:read get 403; no sign-in is 401; a malformed id is 404', async () => {
    const depot = await createDepot();
    const log = await insertLog(await createVehicle({ depot }), null);
    expect((await api.get('/fuel-logs', await signIn(['dispatcher'], depot))).status).toBe(403);
    expect((await api.get(`/fuel-logs/${log.public_id}`, await signIn(['technician'], depot))).status).toBe(403);
    expect((await request(app).get('/api/v1/fuel-logs')).status).toBe(401);
    expect((await api.get('/fuel-logs/not-a-uuid', await signIn(['depot_admin'], depot))).status).toBe(404);
  });

  test('filters by vehicle, driver and trip; an unknown or out-of-scope reference is an empty page', async () => {
    const depot = await createDepot();
    const [a, b] = [await createVehicle({ depot }), await createVehicle({ depot })];
    const [d1, d2] = [(await createDriver({ depot })).driver, (await createDriver({ depot })).driver];
    // Planned on a route of the depot, so the depot admin below may see it.
    const trip = await tripFor(a, d1, { route_id: (await routeIn(depot)).id });
    const [l1, l2, l3] = [
      await insertLog(a, d1, { trip_id: trip.id, odometer_km: 1_000 }),
      await insertLog(a, d2, { odometer_km: 2_000 }),
      await insertLog(b, d1, { odometer_km: 3_000 }),
    ];
    const cookie = await signIn(['depot_admin'], depot);
    const sorted = async (path: string) => ids(await api.get(path, cookie)).sort();

    expect(await sorted(`/fuel-logs?vehicle_id=${pub(a)}`)).toEqual([l1.public_id, l2.public_id].sort());
    expect(await sorted(`/fuel-logs?driver_id=${pub(d1)}`)).toEqual([l1.public_id, l3.public_id].sort());
    expect(await sorted(`/fuel-logs?trip_id=${pub(trip)}`)).toEqual([l1.public_id]);
    expect(await sorted(`/fuel-logs?vehicle_id=${pub(a)}&driver_id=${pub(d1)}`)).toEqual([l1.public_id]);

    const foreignVehicle = await createVehicle({ depot: await createDepot() });
    for (const query of [`vehicle_id=${randomUUID()}`, `vehicle_id=${pub(foreignVehicle)}`, `driver_id=${randomUUID()}`, `trip_id=${randomUUID()}`]) {
      const res = await api.get(`/fuel-logs?${query}`, cookie);
      expect(res.status, query).toBe(200);
      expect(res.body.data, query).toEqual([]);
      expect(res.body.meta.total_items, query).toBe(0);
    }
    expect((await api.get('/fuel-logs?vehicle_id=not-a-uuid', cookie)).status).toBe(400);
  });

  test('from and to bound recorded_at by Addis Ababa days; a date `to` includes that whole day', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    // 2026-10-20 23:30 in Addis Ababa (UTC+3) is 20:30 UTC; 2026-10-21 00:30 there is 21:30 UTC on the 20th.
    const [lateOn20, earlyOn21, noonOn21, on22] = [
      await insertLog(vehicle, null, { odometer_km: 1, recorded_at: '2026-10-20T20:30:00Z' }),
      await insertLog(vehicle, null, { odometer_km: 2, recorded_at: '2026-10-20T21:30:00Z' }),
      await insertLog(vehicle, null, { odometer_km: 3, recorded_at: '2026-10-21T09:00:00Z' }),
      await insertLog(vehicle, null, { odometer_km: 4, recorded_at: '2026-10-22T09:00:00Z' }),
    ];
    const cookie = await signIn(['depot_admin'], depot);

    const day21 = await api.get('/fuel-logs?from=2026-10-21&to=2026-10-21&sort_order=asc', cookie);
    expect(ids(day21)).toEqual([earlyOn21.public_id, noonOn21.public_id]);
    expect(ids(await api.get('/fuel-logs?to=2026-10-20&sort_order=asc', cookie))).toEqual([lateOn20.public_id]);
    expect(ids(await api.get('/fuel-logs?from=2026-10-22', cookie))).toEqual([on22.public_id]);
    expect(ids(await api.get('/fuel-logs?from=2026-10-21T09:00:00Z&to=2026-10-21T09:00:01Z', cookie))).toEqual([noonOn21.public_id]);
    expect((await api.get('/fuel-logs?from=21-10-2026', cookie)).status).toBe(400);
  });

  test('lists newest first, or oldest first, and pages with totals; page size is capped at 100', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const logs = [];
    for (let i = 0; i < 5; i++) logs.push(await insertLog(vehicle, null, { odometer_km: i + 1, recorded_at: `2026-10-0${i + 1}T08:00:00Z` }));
    const cookie = await signIn(['depot_admin'], depot);
    const newestFirst = logs.map((l) => l.public_id).reverse();

    expect(ids(await api.get('/fuel-logs', cookie))).toEqual(newestFirst);
    expect(ids(await api.get('/fuel-logs?sort_order=asc', cookie))).toEqual([...newestFirst].reverse());

    const page2 = await api.get('/fuel-logs?page=2&page_size=2', cookie);
    expect(ids(page2)).toEqual(newestFirst.slice(2, 4));
    expect(page2.body.meta).toMatchObject({ page: 2, page_size: 2, total_items: 5, total_pages: 3 });
    expect((await api.get('/fuel-logs?page_size=1000', cookie)).body.meta.page_size).toBe(100);
    expect((await api.get('/fuel-logs?page=0', cookie)).status).toBe(400);
    expect(ids(await api.get('/fuel-logs?page=4&page_size=2', cookie))).toEqual([]);
  });

  test('a log is returned in full by id, with public ids only', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const { driver } = await createDriver({ depot });
    const log = await insertLog(vehicle, driver, { unit_price_cents: 8_000, station_name: 'Noc Mexico', odometer_km: 123.4 });
    const res = await api.get(`/fuel-logs/${log.public_id}`, await signIn(['depot_admin'], depot));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      id: log.public_id,
      vehicle_id: pub(vehicle),
      driver_id: pub(driver),
      trip_id: null,
      fuel_type: 'diesel',
      quantity_ml: 40_000,
      unit_price_cents: 8_000,
      total_cost_cents: 300_000,
      odometer_km: 123.4,
      station_name: 'Noc Mexico',
      source: 'manual',
      recorded_at: expect.any(String),
      created_at: expect.any(String),
    });
    expect(res.body.meta.request_id).toBe(res.headers['x-request-id']);
  });
});

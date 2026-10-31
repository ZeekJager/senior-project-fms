import { randomUUID } from 'node:crypto';
import request, { type Response } from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { hashPassword } from '../../src/modules/auth';
import { createDepot, createDriver, createTrip, createUser, createVehicle, type RoleName } from '../support/factories';
import { deliverEvents, publishedEvents } from '../support/events';

const app = createApp();
const PASSWORD = 'Dvir-Test-1';

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

const PASS = { name: 'Brakes', passed: true };
const FAIL = { name: 'Left tail light', passed: false, notes: 'Cracked lens' };

/** A valid body for a vehicle; override anything the test is about. */
const inspection = (vehicle: Vehicle, extra: Record<string, unknown> = {}) => ({
  vehicle_id: pub(vehicle),
  type: 'pre_trip',
  items: [PASS, { name: 'Tyres', passed: true, notes: 'Pressure checked' }],
  ...extra,
});

/** A trip in its own two-hour window: a driver cannot be assigned to overlapping trips. */
let slot = 0;
function tripFor(vehicle: Vehicle, driver: { id: unknown }, extra: Record<string, unknown> = {}) {
  slot += 1;
  const start = new Date(Date.UTC(2032, 0, 1, 0, 0, 0) + slot * 3 * 60 * 60 * 1000);
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

/** A report straight into the table, for the read tests (the API writes are tested above them). */
async function insertReport(vehicle: Vehicle, driver: { id: unknown }, extra: Record<string, unknown> = {}) {
  const values = {
    vehicle_id: vehicle.id,
    driver_id: driver.id,
    inspection_type: 'pre_trip',
    checklist: JSON.stringify({ items: [{ name: 'Brakes', passed: true, notes: null }] }),
    ...extra,
  };
  const keys = Object.keys(values);
  const res = await pool.query<{ id: string; public_id: string }>(
    `INSERT INTO fleet.dvir_reports (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id, public_id`,
    Object.values(values),
  );
  return res.rows[0];
}

const reportCount = async (vehicle: Vehicle) =>
  (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM fleet.dvir_reports WHERE vehicle_id = $1', [vehicle.id])).rows[0].n;

const flagOf = async (vehicle: Vehicle) =>
  (await pool.query<{ f: boolean }>('SELECT maintenance_flag AS f FROM fleet.vehicles WHERE id = $1', [vehicle.id])).rows[0].f;

async function auditRows(res: Response) {
  const rows = await pool.query<{ action: string; entity_type: string }>(
    'SELECT action, entity_type FROM audit.audit_logs WHERE correlation_id = $1 ORDER BY id',
    [res.headers['x-request-id']],
  );
  return rows.rows.map((r) => `${r.action} ${r.entity_type}`);
}

const ids = (res: Response) => (res.body.data as { id: string }[]).map((r) => r.id);

describe('POST /dvir-reports', () => {
  test('a driver submits a clean inspection: 201, created, their driver id, no flag, no fault event', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const { driver, cookie } = await driverWithLogin(depot);

    const res = await api.post('/dvir-reports', inspection(vehicle), cookie);
    expect(res.status).toBe(201);
    expect(res.body.meta.created).toBe(true);
    expect(res.body.data).toMatchObject({
      vehicle_id: pub(vehicle),
      driver_id: pub(driver),
      trip_id: null,
      type: 'pre_trip',
      status: 'submitted',
      items: [
        { name: 'Brakes', passed: true, notes: null },
        { name: 'Tyres', passed: true, notes: 'Pressure checked' },
      ],
      defects: [],
      issues_found: false,
    });
    expect(Number.isNaN(Date.parse(res.body.data.submitted_at))).toBe(false);
    expect(await auditRows(res)).toEqual(['INSERT fleet.dvir_reports']);
    expect(await flagOf(vehicle)).toBe(false);
    expect(await publishedEvents('VehicleFaultDetected')).toEqual([]);
  });

  describe('issues found', () => {
    test('a failed item sets the maintenance flag in the same transaction, lists the defect and publishes VehicleFaultDetected', async () => {
      const depot = await createDepot();
      const vehicle = await createVehicle({ depot });
      const { driver, cookie } = await driverWithLogin(depot);

      const res = await api.post('/dvir-reports', inspection(vehicle, { items: [PASS, FAIL], issues_found: true }), cookie);
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ issues_found: true, defects: [{ name: 'Left tail light', notes: 'Cracked lens' }] });
      expect(await flagOf(vehicle)).toBe(true);
      // One change set, one audit trail: the report and the flag are written together.
      expect(await auditRows(res)).toEqual(['INSERT fleet.dvir_reports', 'UPDATE fleet.vehicles']);

      const [event, ...rest] = await publishedEvents('VehicleFaultDetected');
      expect(rest).toEqual([]);
      expect(event.aggregate).toBe(`vehicle:${pub(vehicle)}`);
      expect(event.payload).toEqual({
        source: 'dvir',
        dvir_report_id: res.body.data.id,
        vehicle_id: pub(vehicle),
        driver_id: pub(driver),
        trip_id: null,
        inspection_type: 'pre_trip',
        defect_count: 1,
        defects: ['Left tail light'],
        maintenance_flag_set: true,
      });
    });

    test('the vehicle is flagged, not locked out: it stays active and keeps its status', async () => {
      const depot = await createDepot();
      const vehicle = await createVehicle({ depot });
      await api.post('/dvir-reports', inspection(vehicle, { items: [FAIL] }), (await driverWithLogin(depot)).cookie);
      const row = (await pool.query<{ is_active: boolean; status: string }>('SELECT is_active, status FROM fleet.vehicles WHERE id = $1', [vehicle.id])).rows[0];
      expect(row).toEqual({ is_active: true, status: vehicle.status });
    });

    test('a failed item forces issues_found true even when the driver said false; true with every item passed is kept', async () => {
      const depot = await createDepot();
      const [a, b] = [await createVehicle({ depot }), await createVehicle({ depot })];
      const { cookie } = await driverWithLogin(depot);

      const forced = await api.post('/dvir-reports', inspection(a, { items: [FAIL], issues_found: false }), cookie);
      expect(forced.body.data.issues_found).toBe(true);
      expect(await flagOf(a)).toBe(true);

      const hunch = await api.post('/dvir-reports', inspection(b, { issues_found: true }), cookie);
      expect(hunch.status).toBe(201);
      expect(hunch.body.data).toMatchObject({ issues_found: true, defects: [] });
      expect(await flagOf(b)).toBe(true);
    });

    test('a vehicle that is already flagged stays flagged without another change, and the new defects still raise the event', async () => {
      const depot = await createDepot();
      const vehicle = await createVehicle({ depot, maintenance_flag: true });
      const res = await api.post('/dvir-reports', inspection(vehicle, { items: [FAIL] }), (await driverWithLogin(depot)).cookie);

      expect(res.status).toBe(201);
      expect(await auditRows(res)).toEqual(['INSERT fleet.dvir_reports']);
      expect((await publishedEvents('VehicleFaultDetected'))[0].payload.maintenance_flag_set).toBe(false);
    });

    test('a later inspection with no issues does not clear the flag: a technician does that', async () => {
      const depot = await createDepot();
      const vehicle = await createVehicle({ depot });
      const { cookie } = await driverWithLogin(depot);
      await api.post('/dvir-reports', inspection(vehicle, { items: [FAIL] }), cookie);
      await api.post('/dvir-reports', inspection(vehicle, { type: 'post_trip' }), cookie);
      expect(await flagOf(vehicle)).toBe(true);
    });

    test('the cached vehicle shows the flag once the event is delivered', async () => {
      const depot = await createDepot();
      const vehicle = await createVehicle({ depot });
      const { cookie } = await driverWithLogin(depot);
      const staff = await signIn(['depot_admin'], depot);
      expect((await api.get(`/vehicles/${pub(vehicle)}`, staff)).body.data.maintenance_flag).toBe(false);

      await api.post('/dvir-reports', inspection(vehicle, { items: [FAIL] }), cookie);
      await deliverEvents();
      expect((await api.get(`/vehicles/${pub(vehicle)}`, staff)).body.data.maintenance_flag).toBe(true);
    });
  });

  describe('duplicate submission', () => {
    test('the same vehicle, trip and type again returns the original with created:false, and changes nothing', async () => {
      const depot = await createDepot();
      const vehicle = await createVehicle({ depot });
      const { driver, cookie } = await driverWithLogin(depot);
      const trip = await tripFor(vehicle, driver);
      const body = inspection(vehicle, { trip_id: pub(trip), items: [FAIL] });

      const first = await api.post('/dvir-reports', body, cookie);
      expect(first.status).toBe(201);
      expect(first.body.data.trip_id).toBe(pub(trip));

      const again = await api.post('/dvir-reports', body, cookie);
      expect(again.status).toBe(200);
      expect(again.body.meta.created).toBe(false);
      expect(again.body.data).toEqual(first.body.data);
      expect(await auditRows(again)).toEqual([]);
      expect(await reportCount(vehicle)).toBe(1);
      expect(await publishedEvents('VehicleFaultDetected')).toHaveLength(1);
    });

    test('the original is returned even when the resubmission differs (an offline replay with an edited checklist)', async () => {
      const depot = await createDepot();
      const vehicle = await createVehicle({ depot });
      const { driver, cookie } = await driverWithLogin(depot);
      const trip = await tripFor(vehicle, driver);
      const first = await api.post('/dvir-reports', inspection(vehicle, { trip_id: pub(trip) }), cookie);
      const again = await api.post('/dvir-reports', inspection(vehicle, { trip_id: pub(trip), items: [FAIL] }), cookie);

      expect(again.body.meta.created).toBe(false);
      expect(again.body.data.id).toBe(first.body.data.id);
      expect(again.body.data.defects).toEqual([]);
      expect(await flagOf(vehicle)).toBe(false);
    });

    test('another type for the same trip, or the same type for another trip, is a new report', async () => {
      const depot = await createDepot();
      const vehicle = await createVehicle({ depot });
      const { driver, cookie } = await driverWithLogin(depot);
      const [t1, t2] = [await tripFor(vehicle, driver), await tripFor(vehicle, driver)];

      expect((await api.post('/dvir-reports', inspection(vehicle, { trip_id: pub(t1) }), cookie)).body.meta.created).toBe(true);
      expect((await api.post('/dvir-reports', inspection(vehicle, { trip_id: pub(t1), type: 'post_trip' }), cookie)).body.meta.created).toBe(true);
      expect((await api.post('/dvir-reports', inspection(vehicle, { trip_id: pub(t2) }), cookie)).body.meta.created).toBe(true);
      expect(await reportCount(vehicle)).toBe(3);
    });

    test('without a trip there is nothing to match on: each submission is its own report', async () => {
      const depot = await createDepot();
      const vehicle = await createVehicle({ depot });
      const { cookie } = await driverWithLogin(depot);
      expect((await api.post('/dvir-reports', inspection(vehicle), cookie)).status).toBe(201);
      expect((await api.post('/dvir-reports', inspection(vehicle), cookie)).status).toBe(201);
      expect(await reportCount(vehicle)).toBe(2);
    });

    test('an Idempotency-Key retry replays the stored response, report and all', async () => {
      const depot = await createDepot();
      const vehicle = await createVehicle({ depot });
      const { cookie } = await driverWithLogin(depot);
      const key = `dvir-${randomUUID()}`;

      const first = await api.post('/dvir-reports', inspection(vehicle), cookie, key);
      const retry = await api.post('/dvir-reports', inspection(vehicle), cookie, key);
      expect(retry.status).toBe(201);
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(retry.body.data).toEqual(first.body.data);
      expect(await reportCount(vehicle)).toBe(1);

      const reused = await api.post('/dvir-reports', inspection(vehicle, { type: 'post_trip' }), cookie, key);
      expect(reused.status).toBe(409);
      expect(reused.body.error.code).toBe('CONFLICT_IDEMPOTENCY_KEY_REUSED');
    });
  });

  test('the legacy POST /dvir alias is gone: 404 NOT_FOUND, nothing recorded, the vehicle not flagged (FMS-122)', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const { driver, cookie } = await driverWithLogin(depot);
    const trip = await tripFor(vehicle, driver);

    const legacy = await api.post('/dvir', inspection(vehicle, { trip_id: pub(trip), items: [FAIL] }), cookie);
    expect(legacy.status).toBe(404);
    expect(legacy.body.error.code).toBe('NOT_FOUND');
    expect(await reportCount(vehicle)).toBe(0);
    expect(await flagOf(vehicle)).toBe(false);

    const canonical = await api.post('/dvir-reports', inspection(vehicle, { trip_id: pub(trip), items: [FAIL] }), cookie);
    expect(canonical.status).toBe(201);
    expect(await flagOf(vehicle)).toBe(true);
  });

  describe('validation', () => {
    async function setup() {
      const depot = await createDepot();
      return { vehicle: await createVehicle({ depot }), cookie: (await driverWithLogin(depot)).cookie };
    }

    test('a type outside the list is 400 VALIDATION_INVALID_ENUM; every listed type is accepted', async () => {
      const { vehicle, cookie } = await setup();
      for (const type of ['weekly', 'PRE_TRIP', '', 5]) {
        const res = await api.post('/dvir-reports', inspection(vehicle, { type }), cookie);
        expect(res.status, String(type)).toBe(400);
        expect(res.body.error.code, String(type)).toBe('VALIDATION_INVALID_ENUM');
      }
      for (const type of ['pre_trip', 'post_trip', 'routine', 'other']) {
        expect((await api.post('/dvir-reports', inspection(vehicle, { type }), cookie)).status, type).toBe(201);
      }
    });

    test('the checklist is required, non-empty, at most 100 items, each with a name and a passed boolean', async () => {
      const { vehicle, cookie } = await setup();
      const bad: [string, unknown][] = [
        ['missing', undefined],
        ['empty', []],
        ['not an array', 'all good'],
        ['no name', [{ passed: true }]],
        ['blank name', [{ name: '   ', passed: true }]],
        ['no passed', [{ name: 'Brakes' }]],
        ['passed as text', [{ name: 'Brakes', passed: 'yes' }]],
        ['long name', [{ name: 'x'.repeat(101), passed: true }]],
        ['long notes', [{ name: 'Brakes', passed: true, notes: 'x'.repeat(1001) }]],
        ['too many', Array.from({ length: 101 }, (_, i) => ({ name: `Item ${i}`, passed: true }))],
      ];
      for (const [label, items] of bad) {
        const res = await api.post('/dvir-reports', inspection(vehicle, { items }), cookie);
        expect(res.status, label).toBe(400);
        expect(res.body.error.code, label).toBe('VALIDATION_FAILED');
      }
      expect(await reportCount(vehicle)).toBe(0);
      expect((await api.post('/dvir-reports', inspection(vehicle, { items: Array.from({ length: 100 }, (_, i) => ({ name: `Item ${i}`, passed: true })) }), cookie)).status).toBe(201);
    });

    test('an item named twice (any casing) is 400 duplicate_item; notes may be null or left out and are trimmed', async () => {
      const { vehicle, cookie } = await setup();
      const dup = await api.post('/dvir-reports', inspection(vehicle, { items: [{ name: 'Brakes', passed: true }, { name: ' brakes ', passed: false }] }), cookie);
      expect(dup.status).toBe(400);
      expect(dup.body.error.details).toEqual([{ field: 'items', reason: 'duplicate_item' }]);

      const ok = await api.post('/dvir-reports', inspection(vehicle, { items: [{ name: ' Horn ', passed: true, notes: null }, { name: 'Lights', passed: false, notes: '  dim  ' }] }), cookie);
      expect(ok.status).toBe(201);
      expect(ok.body.data.items).toEqual([
        { name: 'Horn', passed: true, notes: null },
        { name: 'Lights', passed: false, notes: 'dim' },
      ]);
    });

    test('vehicle_id and the other ids must be UUIDs; anything the API does not accept is not_writable', async () => {
      const { vehicle, cookie } = await setup();
      const bad = await api.post('/dvir-reports', inspection(vehicle, { vehicle_id: 'AA-1234' }), cookie);
      expect(bad.status).toBe(400);
      expect(bad.body.error.details[0].field).toBe('vehicle_id');
      expect((await api.post('/dvir-reports', inspection(vehicle, { trip_id: 'soon' }), cookie)).status).toBe(400);

      const extra = await api.post('/dvir-reports', inspection(vehicle, { status: 'closed', reviewed_by: 1 }), cookie);
      expect(extra.status).toBe(400);
      expect(extra.body.error.details).toEqual([
        { field: 'status', reason: 'not_writable' },
        { field: 'reviewed_by', reason: 'not_writable' },
      ]);
      expect((await api.post('/dvir-reports', { type: 'pre_trip', items: [PASS] }, cookie)).status).toBe(400);
    });

    test('submitted_at is kept (an offline queue), but not in the future and not older than 30 days', async () => {
      const { vehicle, cookie } = await setup();
      const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

      const late = await api.post('/dvir-reports', inspection(vehicle, { submitted_at: hoursAgo(5) }), cookie);
      expect(late.status).toBe(201);
      expect(Math.abs(Date.parse(late.body.data.submitted_at) - (Date.now() - 5 * 3_600_000))).toBeLessThan(10_000);
      expect(Date.parse(late.body.data.created_at)).toBeGreaterThan(Date.parse(late.body.data.submitted_at) + 4 * 3_600_000);

      const future = await api.post('/dvir-reports', inspection(vehicle, { submitted_at: new Date(Date.now() + 3_600_000).toISOString() }), cookie);
      expect(future.status).toBe(400);
      expect(future.body.error.details).toEqual([{ field: 'submitted_at', reason: 'in_future' }]);

      const old = await api.post('/dvir-reports', inspection(vehicle, { submitted_at: hoursAgo(24 * 31) }), cookie);
      expect(old.body.error.details).toEqual([{ field: 'submitted_at', reason: 'too_old' }]);

      expect((await api.post('/dvir-reports', inspection(vehicle, { submitted_at: hoursAgo(24 * 29) }), cookie)).status).toBe(201);
      expect((await api.post('/dvir-reports', inspection(vehicle, { submitted_at: 'yesterday' }), cookie)).status).toBe(400);
    });
  });

  describe('who may submit', () => {
    test('roles without dvir:write get 403 and no sign-in is 401', async () => {
      const depot = await createDepot();
      const vehicle = await createVehicle({ depot });
      for (const role of ['finance_clerk', 'dispatcher', 'compliance_officer', 'fleet_owner'] as const) {
        const res = await api.post('/dvir-reports', inspection(vehicle), await signIn([role], depot));
        expect(res.status, role).toBe(403);
      }
      expect((await request(app).post('/api/v1/dvir-reports').send(inspection(vehicle))).status).toBe(401);
      expect(await reportCount(vehicle)).toBe(0);
    });

    test('staff must name the driver, who must be in their depots; a technician may submit for a driver', async () => {
      const [mine, other] = [await createDepot(), await createDepot()];
      const vehicle = await createVehicle({ depot: mine });
      const { driver } = await createDriver({ depot: mine });
      const { driver: foreign } = await createDriver({ depot: other });
      const technician = await signIn(['technician'], mine);

      const unnamed = await api.post('/dvir-reports', inspection(vehicle), technician);
      expect(unnamed.status).toBe(400);
      expect(unnamed.body.error.details).toEqual([{ field: 'driver_id', reason: 'required' }]);

      for (const driverId of [pub(foreign), randomUUID()]) {
        const res = await api.post('/dvir-reports', inspection(vehicle, { driver_id: driverId }), technician);
        expect(res.status).toBe(400);
        expect(res.body.error.details).toEqual([{ field: 'driver_id', reason: 'references_missing_record' }]);
      }

      const ok = await api.post('/dvir-reports', inspection(vehicle, { driver_id: pub(driver) }), technician);
      expect(ok.status).toBe(201);
      expect(ok.body.data.driver_id).toBe(pub(driver));
      expect(await reportCount(vehicle)).toBe(1);
    });

    test('a driver may not name another driver, may name themselves, and one without a profile cannot submit', async () => {
      const depot = await createDepot();
      const vehicle = await createVehicle({ depot });
      const { driver, cookie } = await driverWithLogin(depot);
      const { driver: colleague } = await createDriver({ depot });

      const other = await api.post('/dvir-reports', inspection(vehicle, { driver_id: pub(colleague) }), cookie);
      expect(other.status).toBe(400);
      expect(other.body.error.details).toEqual([{ field: 'driver_id', reason: 'not_writable' }]);
      expect(await reportCount(vehicle)).toBe(0);

      const self = await api.post('/dvir-reports', inspection(vehicle, { driver_id: pub(driver) }), cookie);
      expect(self.status).toBe(201);
      expect(self.body.data.driver_id).toBe(pub(driver));

      const bare = await createUser({ roles: ['driver'], depot, password: PASSWORD });
      const noProfile = await api.post('/dvir-reports', inspection(vehicle), await login(bare.email as string));
      expect(noProfile.status).toBe(400);
      expect(noProfile.body.error.details).toEqual([{ field: 'driver_id', reason: 'no_driver_profile' }]);
    });
  });

  describe('vehicle and trip', () => {
    test('an unknown vehicle, another depot\'s vehicle (for a depot-scoped caller) are refused with the same body; a fleet manager reaches any depot', async () => {
      const [mine, other] = [await createDepot(), await createDepot()];
      const { driver, cookie } = await driverWithLogin(mine);
      const foreign = await createVehicle({ depot: other });

      const unknown = await api.post('/dvir-reports', { ...inspection(await createVehicle({ depot: mine })), vehicle_id: randomUUID() }, cookie);
      const elsewhere = await api.post('/dvir-reports', inspection(foreign), cookie);
      expect(unknown.status).toBe(400);
      expect(elsewhere.status).toBe(400);
      expect(elsewhere.body.error).toEqual(unknown.body.error);
      expect(unknown.body.error.details).toEqual([{ field: 'vehicle_id', reason: 'references_missing_record' }]);

      // A fleet manager is not limited to a depot: any vehicle, any driver.
      const manager = await signIn(['fleet_manager']);
      const { driver: local } = await createDriver({ depot: other });
      expect((await api.post('/dvir-reports', inspection(foreign, { driver_id: pub(local) }), manager)).status).toBe(201);
      expect((await api.post('/dvir-reports', inspection(foreign, { driver_id: pub(driver), type: 'post_trip' }), manager)).status).toBe(201);
    });

    test('a retired vehicle cannot be inspected', async () => {
      const depot = await createDepot();
      const vehicle = await createVehicle({ depot, is_active: false, status: 'retired' });
      const res = await api.post('/dvir-reports', inspection(vehicle), (await driverWithLogin(depot)).cookie);
      expect(res.status).toBe(400);
      expect(res.body.error.details).toEqual([{ field: 'vehicle_id', reason: 'vehicle_retired' }]);
    });

    test("another vehicle's trip, an unknown trip and another driver's trip are 400 and record nothing", async () => {
      const depot = await createDepot();
      const [vehicle, otherVehicle] = [await createVehicle({ depot }), await createVehicle({ depot })];
      const { driver, cookie } = await driverWithLogin(depot);
      const { driver: colleague } = await createDriver({ depot });
      const wrongVehicle = await tripFor(otherVehicle, driver);
      const theirs = await tripFor(vehicle, colleague);

      const mismatch = await api.post('/dvir-reports', inspection(vehicle, { trip_id: pub(wrongVehicle) }), cookie);
      expect(mismatch.status).toBe(400);
      expect(mismatch.body.error.details).toEqual([{ field: 'trip_id', reason: 'trip_vehicle_mismatch' }]);

      for (const tripId of [randomUUID(), pub(theirs)]) {
        const res = await api.post('/dvir-reports', inspection(vehicle, { trip_id: tripId }), cookie);
        expect(res.status).toBe(400);
        expect(res.body.error.details).toEqual([{ field: 'trip_id', reason: 'references_missing_record' }]);
      }
      expect(await reportCount(vehicle)).toBe(0);
      expect(await flagOf(vehicle)).toBe(false);
    });

    test("a depot admin links a trip planned on their depot's route, but not another depot's", async () => {
      const [mine, other] = [await createDepot(), await createDepot()];
      const vehicle = await createVehicle({ depot: mine });
      const { driver } = await createDriver({ depot: mine });
      const ownTrip = await tripFor(vehicle, driver, { route_id: (await routeIn(mine)).id });
      const foreignTrip = await tripFor(vehicle, driver, { route_id: (await routeIn(other)).id });
      const cookie = await signIn(['depot_admin'], mine);

      expect((await api.post('/dvir-reports', inspection(vehicle, { trip_id: pub(ownTrip), driver_id: pub(driver) }), cookie)).status).toBe(201);
      const res = await api.post('/dvir-reports', inspection(vehicle, { trip_id: pub(foreignTrip), driver_id: pub(driver) }), cookie);
      expect(res.status).toBe(400);
      expect(res.body.error.details).toEqual([{ field: 'trip_id', reason: 'references_missing_record' }]);
    });

    test('a refused submission leaves nothing behind: no report, no flag, no event', async () => {
      const depot = await createDepot();
      const vehicle = await createVehicle({ depot });
      const { cookie } = await driverWithLogin(depot);
      // Defects, but a bad trip: the whole request rolls back.
      const res = await api.post('/dvir-reports', inspection(vehicle, { items: [FAIL], trip_id: randomUUID() }), cookie);
      expect(res.status).toBe(400);
      expect(await reportCount(vehicle)).toBe(0);
      expect(await flagOf(vehicle)).toBe(false);
      expect(await publishedEvents('VehicleFaultDetected')).toEqual([]);
    });
  });
});

describe('GET /vehicles/{id}/dvir-reports', () => {
  test("staff list a vehicle's reports newest submission first, or oldest first, with paging and totals", async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const { driver } = await createDriver({ depot });
    const reports = [];
    for (let i = 0; i < 5; i++) reports.push(await insertReport(vehicle, driver, { submitted_at: `2026-10-0${i + 1}T08:00:00Z` }));
    const cookie = await signIn(['depot_admin'], depot);
    const newestFirst = reports.map((r) => r.public_id).reverse();

    const list = await api.get(`/vehicles/${pub(vehicle)}/dvir-reports`, cookie);
    expect(list.status).toBe(200);
    expect(ids(list)).toEqual(newestFirst);
    expect(ids(await api.get(`/vehicles/${pub(vehicle)}/dvir-reports?sort_order=asc`, cookie))).toEqual([...newestFirst].reverse());

    const page2 = await api.get(`/vehicles/${pub(vehicle)}/dvir-reports?page=2&page_size=2`, cookie);
    expect(ids(page2)).toEqual(newestFirst.slice(2, 4));
    expect(page2.body.meta).toMatchObject({ page: 2, page_size: 2, total_items: 5, total_pages: 3 });
    expect((await api.get(`/vehicles/${pub(vehicle)}/dvir-reports?page_size=1000`, cookie)).body.meta.page_size).toBe(100);
    expect((await api.get(`/vehicles/${pub(vehicle)}/dvir-reports?page=0`, cookie)).status).toBe(400);
  });

  test('a report is returned in full, with public ids and the checklist as submitted', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const { driver, cookie } = await driverWithLogin(depot);
    const trip = await tripFor(vehicle, driver);
    const created = await api.post('/dvir-reports', inspection(vehicle, { trip_id: pub(trip), type: 'post_trip', items: [PASS, FAIL] }), cookie);

    const res = await api.get(`/vehicles/${pub(vehicle)}/dvir-reports`, await signIn(['technician'], depot));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      {
        id: created.body.data.id,
        vehicle_id: pub(vehicle),
        driver_id: pub(driver),
        trip_id: pub(trip),
        type: 'post_trip',
        status: 'submitted',
        items: [
          { name: 'Brakes', passed: true, notes: null },
          { name: 'Left tail light', passed: false, notes: 'Cracked lens' },
        ],
        defects: [{ name: 'Left tail light', notes: 'Cracked lens' }],
        issues_found: true,
        submitted_at: expect.any(String),
        created_at: expect.any(String),
      },
    ]);
    expect(res.body.meta.request_id).toBe(res.headers['x-request-id']);
  });

  test('filters by type and issues_found, and by submission time in Addis Ababa days', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const { driver } = await createDriver({ depot });
    const defects = JSON.stringify([{ name: 'Horn', notes: null }]);
    // 2026-10-20 23:30 in Addis Ababa (UTC+3) is 20:30 UTC; 00:30 on the 21st there is 21:30 UTC on the 20th.
    const [preClean, postDefect, lateOn20, earlyOn21] = [
      await insertReport(vehicle, driver, { submitted_at: '2026-10-19T08:00:00Z' }),
      await insertReport(vehicle, driver, { inspection_type: 'post_trip', issues_found: true, defects, submitted_at: '2026-10-19T17:00:00Z' }),
      await insertReport(vehicle, driver, { inspection_type: 'routine', submitted_at: '2026-10-20T20:30:00Z' }),
      await insertReport(vehicle, driver, { inspection_type: 'other', submitted_at: '2026-10-20T21:30:00Z' }),
    ];
    const cookie = await signIn(['depot_admin'], depot);
    const path = `/vehicles/${pub(vehicle)}/dvir-reports`;

    expect(ids(await api.get(`${path}?type=post_trip`, cookie))).toEqual([postDefect.public_id]);
    expect(ids(await api.get(`${path}?issues_found=true`, cookie))).toEqual([postDefect.public_id]);
    expect((await api.get(`${path}?issues_found=false`, cookie)).body.meta.total_items).toBe(3);
    expect(ids(await api.get(`${path}?from=2026-10-21&to=2026-10-21`, cookie))).toEqual([earlyOn21.public_id]);
    expect(ids(await api.get(`${path}?to=2026-10-19&sort_order=asc`, cookie))).toEqual([preClean.public_id, postDefect.public_id]);
    expect(ids(await api.get(`${path}?from=2026-10-20&to=2026-10-20`, cookie))).toEqual([lateOn20.public_id]);

    const badType = await api.get(`${path}?type=weekly`, cookie);
    expect(badType.status).toBe(400);
    expect(badType.body.error.code).toBe('VALIDATION_INVALID_ENUM');
    expect((await api.get(`${path}?issues_found=maybe`, cookie)).status).toBe(400);
    expect((await api.get(`${path}?from=21-10-2026`, cookie)).status).toBe(400);
  });

  test("a driver sees only their own reports of the vehicle, never a colleague's", async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const { driver, cookie } = await driverWithLogin(depot);
    const { driver: colleague } = await createDriver({ depot });
    const mine = await insertReport(vehicle, driver);
    await insertReport(vehicle, colleague);

    const res = await api.get(`/vehicles/${pub(vehicle)}/dvir-reports`, cookie);
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([mine.public_id]);
    expect(res.body.meta.total_items).toBe(1);

    const bare = await createUser({ roles: ['driver'], depot, password: PASSWORD });
    const none = await api.get(`/vehicles/${pub(vehicle)}/dvir-reports`, await login(bare.email as string));
    expect(none.status).toBe(200);
    expect(none.body.data).toEqual([]);
  });

  test("another depot's vehicle, an unknown vehicle and a malformed id are the same 404; a fleet manager reads any depot", async () => {
    const [mine, other] = [await createDepot(), await createDepot()];
    const foreign = await createVehicle({ depot: other });
    const { driver } = await createDriver({ depot: other });
    const report = await insertReport(foreign, driver);
    const admin = await signIn(['depot_admin'], mine);

    const elsewhere = await api.get(`/vehicles/${pub(foreign)}/dvir-reports`, admin);
    const unknown = await api.get(`/vehicles/${randomUUID()}/dvir-reports`, admin);
    expect(elsewhere.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(elsewhere.body.error).toEqual(unknown.body.error);
    expect((await api.get('/vehicles/not-a-uuid/dvir-reports', admin)).status).toBe(404);

    expect(ids(await api.get(`/vehicles/${pub(foreign)}/dvir-reports`, await signIn(['fleet_manager'])))).toEqual([report.public_id]);
  });

  test('roles without dvir:read get 403; no sign-in is 401', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    for (const role of ['dispatcher', 'finance_clerk', 'fleet_owner'] as const) {
      expect((await api.get(`/vehicles/${pub(vehicle)}/dvir-reports`, await signIn([role], depot))).status, role).toBe(403);
    }
    expect((await request(app).get(`/api/v1/vehicles/${pub(vehicle)}/dvir-reports`)).status).toBe(401);
    expect((await api.get(`/vehicles/${pub(vehicle)}/dvir-reports`, await signIn(['compliance_officer']))).status).toBe(200);
  });
});

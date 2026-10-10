import { randomUUID } from 'node:crypto';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import type { DomainEvent } from '../../src/shared/events/domain-event';
import { eventBus } from '../../src/shared/events/event-bus';
import { createDepot, createDriver, createTrip, createUser, createVehicle, type RoleName } from '../support/factories';

const app = createApp();
const PASSWORD = 'Vehicle-Test-1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Depot = Awaited<ReturnType<typeof createDepot>>;

/** Signs in a new user with the roles (and home depot) and returns the cookie header. */
async function signIn(roles: RoleName[], depot: Depot | null = null): Promise<string> {
  const user = await createUser({ roles, depot, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

const api = {
  get: (path: string, cookie = '') => request(app).get(`/api/v1${path}`).set('Cookie', cookie),
  post: (path: string, body: object, cookie = '') => request(app).post(`/api/v1${path}`).set('Cookie', cookie).send(body),
  patch: (path: string, body: object, cookie = '') => request(app).patch(`/api/v1${path}`).set('Cookie', cookie).send(body),
  delete: (path: string, cookie = '') => request(app).delete(`/api/v1${path}`).set('Cookie', cookie),
};

const plate = () => `AA ${randomUUID().slice(0, 6).toUpperCase()}`;

function vehicleBody(depot: Depot, overrides: Record<string, unknown> = {}) {
  return {
    registration_number: plate(),
    make: 'Isuzu',
    model: 'FSR',
    year: 2022,
    vehicle_type: 'truck',
    fuel_type: 'diesel',
    fuel_efficiency_ml_per_km: 320,
    depot_id: depot.public_id,
    odometer_km: 1200.5,
    ...overrides,
  };
}

/** audit.audit_logs rows written while serving this response. */
async function auditRows(res: Response) {
  const rows = await pool.query<{ action: string; entity_type: string }>(
    'SELECT action, entity_type FROM audit.audit_logs WHERE correlation_id = $1 ORDER BY id',
    [res.headers['x-request-id']],
  );
  return rows.rows;
}

const ids = (res: Response) => (res.body.data as { id: string }[]).map((v) => v.id);

describe('POST /vehicles', () => {
  test('registers a vehicle: 201, contract fields, public ids only, one audit row', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['depot_admin'], depot);

    const res = await api.post('/vehicles', vehicleBody(depot, { registration_number: '  aa   3-12345 ', vin: '1hgcm82633a004352' }), cookie);

    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(`/api/v1/vehicles/${res.body.data.id}`);
    expect(res.body.data).toMatchObject({
      registration_number: 'AA 3-12345',
      vin: '1HGCM82633A004352',
      make: 'Isuzu',
      year: 2022,
      vehicle_type: 'truck',
      fuel_type: 'diesel',
      fuel_efficiency_ml_per_km: 320,
      status: 'active',
      maintenance_flag: false,
      health_score: null,
      depot_id: depot.public_id,
      odometer_km: 1200.5,
    });
    expect(res.body.data.id).toMatch(UUID);
    expect(Object.keys(res.body.data).sort()).toEqual(
      [
        'created_at', 'current_trip', 'depot_id', 'fuel_efficiency_ml_per_km', 'fuel_type', 'health_score', 'id', 'maintenance_flag',
        'make', 'model', 'odometer_km', 'registration_number', 'status', 'updated_at', 'vehicle_type', 'version', 'vin', 'year',
      ].sort(),
    );
    expect(await auditRows(res)).toEqual([{ action: 'INSERT', entity_type: 'fleet.vehicles' }]);
  });

  test('a duplicate registration returns 409 CONFLICT_DUPLICATE_PLATE, whatever its case and spacing', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['depot_admin'], depot);
    expect((await api.post('/vehicles', vehicleBody(depot, { registration_number: 'AB 777' }), cookie)).status).toBe(201);

    const res = await api.post('/vehicles', vehicleBody(depot, { registration_number: ' ab  777' }), cookie);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT_DUPLICATE_PLATE');
  });

  test('a duplicate VIN returns 409 CONFLICT_DUPLICATE naming the field', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['depot_admin'], depot);
    await api.post('/vehicles', vehicleBody(depot, { vin: '1HGCM82633A004352' }), cookie);
    const res = await api.post('/vehicles', vehicleBody(depot, { vin: '1HGCM82633A004352' }), cookie);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'CONFLICT_DUPLICATE', details: [{ field: 'vin', reason: 'already_exists' }] });
  });

  test('a diesel vehicle without fuel efficiency returns 400 VALIDATION_FAILED; an electric one does not need it', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['depot_admin'], depot);

    const diesel = await api.post('/vehicles', vehicleBody(depot, { fuel_efficiency_ml_per_km: undefined }), cookie);
    expect(diesel.status).toBe(400);
    expect(diesel.body.error.code).toBe('VALIDATION_FAILED');
    expect(diesel.body.error.details).toContainEqual({ field: 'fuel_efficiency_ml_per_km', reason: 'required' });

    const electric = await api.post('/vehicles', vehicleBody(depot, { fuel_type: 'electric', fuel_efficiency_ml_per_km: null }), cookie);
    expect(electric.status).toBe(201);
    expect(electric.body.data.fuel_efficiency_ml_per_km).toBeNull();
  });

  test('a fractional fuel efficiency returns 400 VALIDATION_FLOAT_IN_MONEY_PATH', async () => {
    const depot = await createDepot();
    const res = await api.post('/vehicles', vehicleBody(depot, { fuel_efficiency_ml_per_km: 320.5 }), await signIn(['depot_admin'], depot));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FLOAT_IN_MONEY_PATH');
    expect(res.body.error.details).toContainEqual({ field: 'fuel_efficiency_ml_per_km', reason: 'float_in_money_path' });
  });

  test('fields set by other workflows are not writable', async () => {
    const depot = await createDepot();
    const res = await api.post(
      '/vehicles',
      vehicleBody(depot, { status: 'retired', maintenance_flag: true, health_score: 90 }),
      await signIn(['depot_admin'], depot),
    );
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual(
      expect.arrayContaining([
        { field: 'status', reason: 'not_writable' },
        { field: 'maintenance_flag', reason: 'not_writable' },
        { field: 'health_score', reason: 'not_writable' },
      ]),
    );
  });

  test('an unknown enum value returns 400 VALIDATION_INVALID_ENUM; a malformed VIN 400 VALIDATION_FAILED', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['depot_admin'], depot);
    const badType = await api.post('/vehicles', vehicleBody(depot, { vehicle_type: 'tank' }), cookie);
    expect(badType.status).toBe(400);
    expect(badType.body.error).toMatchObject({ code: 'VALIDATION_INVALID_ENUM', details: [{ field: 'vehicle_type', reason: 'invalid_enum' }] });

    const badVin = await api.post('/vehicles', vehicleBody(depot, { vin: 'IOQ123' }), cookie);
    expect(badVin.status).toBe(400);
    expect(badVin.body.error.code).toBe('VALIDATION_FAILED');
  });

  test('a driver calling POST receives 403; so does a dispatcher; no session is 401', async () => {
    const depot = await createDepot();
    for (const role of ['driver', 'dispatcher'] as const) {
      const res = await api.post('/vehicles', vehicleBody(depot), await signIn([role], depot));
      expect(res.status, role).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN_INSUFFICIENT_ROLE');
    }
    expect((await api.post('/vehicles', vehicleBody(depot))).status).toBe(401);
  });

  test("a depot admin cannot register a vehicle in another depot; an admin can", async () => {
    const [mine, other] = [await createDepot(), await createDepot()];
    const denied = await api.post('/vehicles', vehicleBody(other), await signIn(['depot_admin'], mine));
    expect(denied.status).toBe(400);
    expect(denied.body.error.details).toEqual([{ field: 'depot_id', reason: 'references_missing_record' }]);

    expect((await api.post('/vehicles', vehicleBody(other), await signIn(['admin']))).status).toBe(201);
  });
});

describe('GET /vehicles', () => {
  test('a list from depot A never contains depot B rows; an admin sees both', async () => {
    const [a, b] = [await createDepot(), await createDepot()];
    const [va, vb] = [await createVehicle({ depot: a }), await createVehicle({ depot: b })];

    const fromA = ids(await api.get('/vehicles?page_size=100', await signIn(['dispatcher'], a)));
    expect(fromA).toContain(va.public_id);
    expect(fromA).not.toContain(vb.public_id);

    const all = ids(await api.get(`/vehicles?page_size=100&search=${encodeURIComponent('AA-')}`, await signIn(['admin'])));
    expect(all).toEqual(expect.arrayContaining([va.public_id, vb.public_id]));
  });

  test('filters by depot, maintenance flag, status and a case-insensitive search', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['fleet_manager']);
    const flagged = await createVehicle({ depot, maintenance_flag: true, make: 'Toyota', model: 'Hilux' });
    const plain = await createVehicle({ depot, make: 'Isuzu', model: 'NPR' });
    const parked = await createVehicle({ depot, status: 'inactive' });

    expect(ids(await api.get(`/vehicles?depot_id=${depot.public_id}`, cookie)).sort()).toEqual(
      [flagged.public_id, plain.public_id, parked.public_id].sort(),
    );
    expect(ids(await api.get(`/vehicles?depot_id=${depot.public_id}&maintenance_flag=true`, cookie))).toEqual([flagged.public_id]);
    expect(ids(await api.get(`/vehicles?depot_id=${depot.public_id}&status=inactive`, cookie))).toEqual([parked.public_id]);
    expect(ids(await api.get(`/vehicles?depot_id=${depot.public_id}&search=hilux`, cookie))).toEqual([flagged.public_id]);
    // LIKE wildcards in the search are literal characters.
    expect(ids(await api.get(`/vehicles?depot_id=${depot.public_id}&search=${encodeURIComponent('%')}`, cookie))).toEqual([]);
  });

  test('pages with contract meta, caps page_size at 100 and sorts by an allowed column', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['fleet_manager']);
    for (const year of [2019, 2021, 2020]) await createVehicle({ depot, model_year: year });

    const page = await api.get(`/vehicles?depot_id=${depot.public_id}&page=2&page_size=2&sort_by=year&sort_order=desc`, cookie);
    expect(page.status).toBe(200);
    expect(page.body.meta).toMatchObject({ page: 2, page_size: 2, total_items: 3, total_pages: 2 });
    expect(page.body.data.map((v: { year: number }) => v.year)).toEqual([2019]);

    const capped = await api.get(`/vehicles?depot_id=${depot.public_id}&page_size=500`, cookie);
    expect(capped.body.meta.page_size).toBe(100);

    const badSort = await api.get('/vehicles?sort_by=password_hash', cookie);
    expect(badSort.status).toBe(400);
    expect(badSort.body.error.code).toBe('VALIDATION_INVALID_ENUM');
  });
});

describe('current_trip', () => {
  test('a vehicle on an assigned or en-route trip shows it (en route first); others show null', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['dispatcher'], depot);
    const { driver } = await createDriver({ depot });
    const { driver: other } = await createDriver({ depot });
    const idle = await createVehicle({ depot });
    const busy = await createVehicle({ depot });
    const tomorrow = Date.now() + 24 * 60 * 60 * 1000;
    await createTrip({ vehicle: idle, driver, status: 'completed' });
    await createTrip({
      vehicle: busy,
      driver: other,
      status: 'assigned',
      origin: 'Addis Ababa',
      destination: 'Adama',
      scheduled_start: new Date(tomorrow).toISOString(),
      scheduled_end: new Date(tomorrow + 60 * 60 * 1000).toISOString(),
    });
    const enRoute = await createTrip({
      vehicle: busy,
      driver,
      status: 'en_route',
      origin: 'Addis Ababa',
      destination: 'Hawassa',
      actual_start: new Date().toISOString(),
    });

    const list = await api.get(`/vehicles?depot_id=${depot.public_id}`, cookie);
    const byId = new Map(list.body.data.map((v: { id: string }) => [v.id, v]));
    expect((byId.get(idle.public_id) as { current_trip: unknown }).current_trip).toBeNull();
    expect((byId.get(busy.public_id) as { current_trip: unknown }).current_trip).toMatchObject({
      id: enRoute.public_id,
      status: 'en_route',
      origin: 'Addis Ababa',
      destination: 'Hawassa',
    });
    expect((await api.get(`/vehicles/${busy.public_id}`, cookie)).body.data.current_trip.id).toBe(enRoute.public_id);
  });
});

describe('GET /vehicles/{id}', () => {
  test('returns a vehicle in scope; another depot, an unknown or a malformed id is 404', async () => {
    const [a, b] = [await createDepot(), await createDepot()];
    const [va, vb] = [await createVehicle({ depot: a }), await createVehicle({ depot: b })];
    const cookie = await signIn(['dispatcher'], a);

    const own = await api.get(`/vehicles/${va.public_id}`, cookie);
    expect(own.status).toBe(200);
    expect(own.body.data.id).toBe(va.public_id);

    for (const id of [String(vb.public_id), randomUUID(), 'not-a-uuid', '1']) {
      const res = await api.get(`/vehicles/${id}`, cookie);
      expect(res.status, id).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    }
  });
});

describe('PATCH /vehicles/{id}', () => {
  test('updates writable fields with one audit row', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const res = await api.patch(`/vehicles/${vehicle.public_id}`, { model: 'FVR', odometer_km: 5000 }, await signIn(['depot_admin'], depot));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: vehicle.public_id, model: 'FVR', odometer_km: 5000 });
    expect(await auditRows(res)).toEqual([{ action: 'UPDATE', entity_type: 'fleet.vehicles' }]);
  });

  test('a lower odometer reading returns 409 CONFLICT_ODOMETER_REGRESSION', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot, odometer_km: 10000 });
    const res = await api.patch(`/vehicles/${vehicle.public_id}`, { odometer_km: 9999.9 }, await signIn(['depot_admin'], depot));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT_ODOMETER_REGRESSION');
  });

  test('the fuel-efficiency rule holds for the vehicle after the change', async () => {
    const depot = await createDepot();
    const ev = await createVehicle({ depot, fuel_type: 'electric', fuel_efficiency_ml_per_km: null });
    const cookie = await signIn(['depot_admin'], depot);

    const res = await api.patch(`/vehicles/${ev.public_id}`, { fuel_type: 'diesel' }, cookie);
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([{ field: 'fuel_efficiency_ml_per_km', reason: 'required' }]);

    const ok = await api.patch(`/vehicles/${ev.public_id}`, { fuel_type: 'diesel', fuel_efficiency_ml_per_km: 300 }, cookie);
    expect(ok.status).toBe(200);
  });

  test('another depot is 404, moving into another depot is 400, an empty body is 400', async () => {
    const [a, b] = [await createDepot(), await createDepot()];
    const [va, vb] = [await createVehicle({ depot: a }), await createVehicle({ depot: b })];
    const cookie = await signIn(['depot_admin'], a);

    expect((await api.patch(`/vehicles/${vb.public_id}`, { model: 'X' }, cookie)).status).toBe(404);
    const move = await api.patch(`/vehicles/${va.public_id}`, { depot_id: b.public_id }, cookie);
    expect(move.status).toBe(400);
    expect(move.body.error.details).toEqual([{ field: 'depot_id', reason: 'references_missing_record' }]);
    const empty = await api.patch(`/vehicles/${va.public_id}`, {}, cookie);
    expect(empty.status).toBe(400);
    expect(empty.body.error.details).toEqual([{ reason: 'empty_update' }]);
  });

  test('a retired vehicle cannot be changed', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot, is_active: false, status: 'retired' });
    const res = await api.patch(`/vehicles/${vehicle.public_id}`, { model: 'X' }, await signIn(['depot_admin'], depot));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT_INVALID_STATE_TRANSITION');
  });
});

describe('DELETE /vehicles/{id}', () => {
  test('retiring an idle vehicle hides it from the default list, keeps it readable, and writes one audit row', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const cookie = await signIn(['depot_admin'], depot);

    const res = await api.delete(`/vehicles/${vehicle.public_id}`, cookie);
    expect(res.status).toBe(204);
    expect(await auditRows(res)).toEqual([{ action: 'DELETE', entity_type: 'fleet.vehicles' }]);

    expect(ids(await api.get(`/vehicles?depot_id=${depot.public_id}`, cookie))).not.toContain(vehicle.public_id);
    expect(ids(await api.get(`/vehicles?depot_id=${depot.public_id}&status=retired`, cookie))).toEqual([vehicle.public_id]);
    const read = await api.get(`/vehicles/${vehicle.public_id}`, cookie);
    expect(read.body.data.status).toBe('retired');

    const row = await pool.query('SELECT is_active, status FROM fleet.vehicles WHERE id = $1', [vehicle.id]);
    expect(row.rows[0]).toEqual({ is_active: false, status: 'retired' });

    // Retiring again succeeds and changes nothing.
    const again = await api.delete(`/vehicles/${vehicle.public_id}`, cookie);
    expect(again.status).toBe(204);
    expect(await auditRows(again)).toEqual([]);
  });

  test('retiring a vehicle on an active trip returns 409 CONFLICT_VEHICLE_IN_USE', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['depot_admin'], depot);
    const { driver } = await createDriver({ depot });

    for (const status of ['assigned', 'en_route'] as const) {
      const vehicle = await createVehicle({ depot });
      await createTrip({ vehicle, driver, status, ...(status === 'en_route' ? { actual_start: new Date().toISOString() } : {}) });
      const res = await api.delete(`/vehicles/${vehicle.public_id}`, cookie);
      expect(res.status, status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT_VEHICLE_IN_USE');
      await pool.query("UPDATE trip.trips SET status = 'cancelled' WHERE vehicle_id = $1", [vehicle.id]);
    }
  });

  test('a completed or cancelled trip does not block retirement; an active driver assignment does', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['depot_admin'], depot);
    const { driver } = await createDriver({ depot });

    const done = await createVehicle({ depot });
    await createTrip({ vehicle: done, driver, status: 'completed', actual_start: '2026-01-01T08:00:00Z', actual_end: '2026-01-01T10:00:00Z' });
    expect((await api.delete(`/vehicles/${done.public_id}`, cookie)).status).toBe(204);

    const assigned = await createVehicle({ depot });
    await pool.query('INSERT INTO fleet.driver_vehicle_assignments (driver_id, vehicle_id) VALUES ($1, $2)', [driver.id, assigned.id]);
    const res = await api.delete(`/vehicles/${assigned.public_id}`, cookie);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT_VEHICLE_IN_USE');
  });

  test('another depot is 404; a dispatcher (no vehicle:delete) is 403', async () => {
    const [a, b] = [await createDepot(), await createDepot()];
    const vb = await createVehicle({ depot: b });
    expect((await api.delete(`/vehicles/${vb.public_id}`, await signIn(['depot_admin'], a))).status).toBe(404);
    expect((await api.delete(`/vehicles/${vb.public_id}`, await signIn(['dispatcher'], b))).status).toBe(403);
  });
});

describe('vehicle events', () => {
  const received: DomainEvent[] = [];
  let unsubscribe: (() => void)[] = [];
  beforeAll(() => {
    unsubscribe = ['VehicleRegistered', 'VehicleUpdated', 'VehicleRetired'].map((type) =>
      eventBus.subscribe(type, (event) => {
        received.push(event);
      }),
    );
  });
  beforeEach(() => {
    received.length = 0;
  });
  afterAll(() => unsubscribe.forEach((u) => u()));

  test('register, update and retire each publish one event with the envelope; a failed write publishes nothing', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['depot_admin'], depot);

    const created = await api.post('/vehicles', vehicleBody(depot, { registration_number: 'EV 1' }), cookie);
    await api.post('/vehicles', vehicleBody(depot, { registration_number: 'EV 1' }), cookie); // duplicate: 409
    await api.patch(`/vehicles/${created.body.data.id}`, { model: 'FVR', make: 'Isuzu' }, cookie);
    const retired = await api.delete(`/vehicles/${created.body.data.id}`, cookie);

    expect(received.map((e) => e.type)).toEqual(['VehicleRegistered', 'VehicleUpdated', 'VehicleRetired']);
    const id = created.body.data.id;
    expect(received[0].payload).toEqual({ vehicle_id: id, depot_id: depot.public_id });
    expect(received[1].payload).toEqual({ vehicle_id: id, depot_id: depot.public_id, changed_fields: ['make', 'model'] });
    expect(received[2]).toMatchObject({ version: 1, correlation_id: retired.headers['x-request-id'] });
    expect(received[2].id).toMatch(UUID);
    expect(received[2].actor).toMatch(UUID);
    expect(Number.isNaN(Date.parse(received[2].occurred_at))).toBe(false);
  });
});

describe('If-Match on PATCH /vehicles/{id}', () => {
  test('the ETag is the version; a stale If-Match is 409 CONFLICT_CONCURRENT_MODIFICATION', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const cookie = await signIn(['depot_admin'], depot);

    const read = await api.get(`/vehicles/${vehicle.public_id}`, cookie);
    expect(read.headers.etag).toBe('"0"');
    expect(read.body.data.version).toBe(0);

    const first = await api.patch(`/vehicles/${vehicle.public_id}`, { model: 'FVR' }, cookie).set('If-Match', '"0"');
    expect(first.status).toBe(200);
    expect(first.headers.etag).toBe('"1"');

    const stale = await api.patch(`/vehicles/${vehicle.public_id}`, { model: 'NPR' }, cookie).set('If-Match', '"0"');
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('CONFLICT_CONCURRENT_MODIFICATION');
    expect((await api.get(`/vehicles/${vehicle.public_id}`, cookie)).body.data.model).toBe('FVR');
  });
});

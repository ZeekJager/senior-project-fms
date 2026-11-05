import request, { type Response } from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { createDepot, createDriver, createUser, createVehicle } from '../support/factories';
import { responseProblems, type Method } from '../support/openapi';

// FMS-65: the spec is true. Each test calls the real API and checks the response against what docs/openapi.yaml
// says that operation returns with that status: its body against the schema, and the status against the ones it
// lists. The routes themselves are compared in openapi.test.ts; this is what they return.
//
// When you add an operation, call it here (or in your own test with `expectContract`) so its schema is checked.

const app = createApp();
const PASSWORD = 'Contract-Test-1x';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

/** Fails with the validator's words when `res` is not what the spec says `method path` returns with that status. */
function expectContract(res: Response, method: Method, path: string) {
  const problem = responseProblems(path, method, res.status, res.body);
  if (problem) throw new Error(`${method.toUpperCase()} ${path} -> ${res.status} is not what docs/openapi.yaml says:\n${problem}\nbody: ${JSON.stringify(res.body).slice(0, 600)}`);
}

const cookieOf = (res: Response) => (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');

async function signIn(roles: string[], depot?: { id: string } | null) {
  const user = await createUser({ roles: roles as never, depot: depot ?? null, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return { user, cookie: cookieOf(res), login: res };
}

const as = (cookie: string) => ({
  get: (path: string) => request(app).get(`/api/v1${path}`).set('Cookie', cookie),
  post: (path: string, body?: object) => request(app).post(`/api/v1${path}`).set('Cookie', cookie).send(body),
  put: (path: string, body: object) => request(app).put(`/api/v1${path}`).set('Cookie', cookie).send(body),
  patch: (path: string, body: object) => request(app).patch(`/api/v1${path}`).set('Cookie', cookie).send(body),
  delete: (path: string) => request(app).delete(`/api/v1${path}`).set('Cookie', cookie),
});

describe('auth and users', () => {
  test('sign in, who am I, renew, sign out: each response is the spec’s, and a wrong password is its 401', async () => {
    const { user, login, cookie } = await signIn(['dispatcher'], await createDepot());
    expectContract(login, 'post', '/auth/login');
    const me = await as(cookie).get('/auth/me');
    expectContract(me, 'get', '/auth/me');
    expect(me.body.data.user.email).toBe(user.email);

    const refreshed = await request(app).post('/api/v1/auth/refresh').set('Cookie', cookieOf(login));
    expectContract(refreshed, 'post', '/auth/refresh');
    const out = await request(app).post('/api/v1/auth/logout').set('Cookie', cookieOf(refreshed));
    expectContract(out, 'post', '/auth/logout');

    const wrong = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: 'not-the-password' });
    expect(wrong.status).toBe(401);
    expectContract(wrong, 'post', '/auth/login');
    expectContract(await request(app).get('/api/v1/auth/me'), 'get', '/auth/me');
  });

  test('users: create with a setup link, list, read, change, reissue a link, and the roles', async () => {
    const depot = await createDepot();
    const { cookie } = await signIn(['admin']);
    const api = as(cookie);

    const created = await api.post('/users', { email: `new.${Date.now()}@fms.test`, full_name: 'Contract User', phone: '+251 911 234567', depot_id: depot.public_id, roles: ['dispatcher'] });
    expect(created.status).toBe(201);
    expectContract(created, 'post', '/users');
    const id = created.body.data.id;
    expect(created.body.meta.password_setup.purpose).toBe('setup');

    expectContract(await api.get('/users?search=Contract'), 'get', '/users');
    expectContract(await api.get(`/users/${id}`), 'get', '/users/{user_id}');
    expectContract(await api.patch(`/users/${id}`, { full_name: 'Contract User Two' }), 'patch', '/users/{user_id}');
    const link = await api.post(`/users/${id}/password-reset`);
    expect(link.status).toBe(201);
    expectContract(link, 'post', '/users/{user_id}/password-reset');
    expectContract(await api.get('/roles'), 'get', '/roles');

    // The link sets a password; a used or wrong one is the spec's 400.
    const set = await request(app).post('/api/v1/auth/password').send({ token: link.body.data.token, password: 'a-long-enough-password-1' });
    expect(set.status).toBe(204);
    expectContract(set, 'post', '/auth/password');
    const again = await request(app).post('/api/v1/auth/password').send({ token: link.body.data.token, password: 'a-long-enough-password-1' });
    expect(again.status).toBe(400);
    expectContract(again, 'post', '/auth/password');

    const duplicate = await api.post('/users', { email: created.body.data.email, full_name: 'Again', roles: ['finance_clerk'], depot_id: depot.public_id });
    expect(duplicate.status).toBe(409);
    expectContract(duplicate, 'post', '/users');
  });
});

describe('depots, vehicles and drivers', () => {
  test('depots: create, list, read, change, replace, delete, reactivate; a depot with a vehicle will not be deleted', async () => {
    const { cookie } = await signIn(['admin']);
    const api = as(cookie);
    const code = `C${Date.now().toString(36).toUpperCase()}`.slice(0, 12);

    const created = await api.post('/depots', { name: `Contract ${code}`, location: 'Addis Ababa', code, timezone: 'Africa/Addis_Ababa', latitude: 9.03, longitude: 38.74, capacity: 40 });
    expect(created.status).toBe(201);
    expectContract(created, 'post', '/depots');
    const id = created.body.data.id;
    expectContract(await api.get('/depots?status=all'), 'get', '/depots');
    expectContract(await api.get(`/depots/${id}`), 'get', '/depots/{depot_id}');
    expectContract(await api.patch(`/depots/${id}`, { city: 'Addis Ababa' }), 'patch', '/depots/{depot_id}');
    expectContract(await api.put(`/depots/${id}`, { name: `Contract ${code}`, location: 'Addis Ababa' }), 'put', '/depots/{depot_id}');
    const deleted = await api.delete(`/depots/${id}`);
    expect(deleted.status).toBe(204);
    expectContract(deleted, 'delete', '/depots/{depot_id}');
    const back = await api.post(`/depots/${id}/reactivate`);
    expect(back.status).toBe(200);
    expectContract(back, 'post', '/depots/{depot_id}/reactivate');

    await createVehicle({ depot: { id: (await createDepot()).id } });
    const busy = await createDepot();
    await createVehicle({ depot: busy });
    const refused = await api.delete(`/depots/${busy.public_id}`);
    expect(refused.status).toBe(409);
    expectContract(refused, 'delete', '/depots/{depot_id}');
    expect(refused.body.error.code).toBe('CONFLICT_DEPOT_NOT_EMPTY');
  });

  test('vehicles: register, list, read, change, retire; a duplicate plate is the spec’s 409', async () => {
    const depot = await createDepot();
    const { cookie } = await signIn(['admin']);
    const api = as(cookie);
    const plate = `AA 3-${Date.now().toString().slice(-6)}`;
    const body = { registration_number: plate, make: 'Isuzu', model: 'FSR', year: 2019, vehicle_type: 'truck', fuel_type: 'diesel', fuel_efficiency_ml_per_km: 320, depot_id: depot.public_id, odometer_km: 1200.5 };

    const created = await api.post('/vehicles', body);
    expect(created.status).toBe(201);
    expectContract(created, 'post', '/vehicles');
    const id = created.body.data.id;
    expectContract(await api.get(`/vehicles?depot_id=${depot.public_id}&sort_by=registration_number`), 'get', '/vehicles');
    expectContract(await api.get(`/vehicles/${id}`), 'get', '/vehicles/{vehicle_id}');
    expectContract(await api.patch(`/vehicles/${id}`, { odometer_km: 1300 }), 'patch', '/vehicles/{vehicle_id}');
    const dup = await api.post('/vehicles', body);
    expect(dup.status).toBe(409);
    expectContract(dup, 'post', '/vehicles');
    const retired = await api.delete(`/vehicles/${id}`);
    expect(retired.status).toBe(204);
    expectContract(retired, 'delete', '/vehicles/{vehicle_id}');
  });

  test('drivers: register with a new account, list, read, change, retire, reinstate; an import (dry run, then for real); your own profile', async () => {
    const depot = await createDepot();
    const { cookie } = await signIn(['admin']);
    const api = as(cookie);
    const stamp = Date.now();

    const created = await api.post('/drivers', {
      account: { full_name: 'Contract Driver', email: `driver.${stamp}@fms.test`, phone: '+251 911 000111' },
      license_number: `LIC-${stamp}`,
      license_categories: ['B', 'CE'],
      license_expiry: '2031-05-01',
      hire_date: '2024-02-01',
      emergency_phone: '+251 911 000222',
      depot_id: depot.public_id,
    });
    expect(created.status).toBe(201);
    expectContract(created, 'post', '/drivers');
    const id = created.body.data.id;
    expectContract(await api.get(`/drivers?depot_id=${depot.public_id}`), 'get', '/drivers');
    expectContract(await api.get(`/drivers/${id}`), 'get', '/drivers/{driver_id}');
    expectContract(await api.patch(`/drivers/${id}`, { license_expiry: '2032-05-01' }), 'patch', '/drivers/{driver_id}');
    const retired = await api.delete(`/drivers/${id}`);
    expect(retired.status).toBe(204);
    expectContract(retired, 'delete', '/drivers/{driver_id}');
    const back = await api.post(`/drivers/${id}/reinstate`);
    expect(back.status).toBe(200);
    expectContract(back, 'post', '/drivers/{driver_id}/reinstate');
    const dup = await api.post('/drivers', { account: { full_name: 'Twin', email: `twin.${stamp}@fms.test` }, license_number: `LIC-${stamp}`, license_expiry: '2031-05-01', depot_id: depot.public_id });
    expect(dup.status).toBe(409);
    expectContract(dup, 'post', '/drivers');

    // The CSV import registers existing driver accounts by email.
    const account = await createUser({ roles: ['driver'], depot, password: PASSWORD });
    const csv = `email,license_number,license_expiry,depot_code\n${account.email},LIC-CSV-${stamp},2030-01-31,${depot.code}\n`;
    const send = (query: string) => request(app).post(`/api/v1/drivers/import${query}`).set('Cookie', cookie).set('Content-Type', 'text/csv').send(csv);
    const dry = await send('?dry_run=true');
    expect(dry.status).toBe(200);
    expectContract(dry, 'post', '/drivers/import');
    const real = await send('');
    expect(real.status).toBe(201);
    expectContract(real, 'post', '/drivers/import');
    const bad = await request(app).post('/api/v1/drivers/import').set('Cookie', cookie).set('Content-Type', 'text/csv').send('email,nonsense\nx@y.z,1\n');
    expect(bad.status).toBe(400);
    expectContract(bad, 'post', '/drivers/import');

    // A signed-in driver reads their own profile without driver:read.
    const mine = await request(app).post('/api/v1/auth/login').send({ email: account.email, password: PASSWORD });
    const own = await as(cookieOf(mine)).get('/drivers/me');
    expect(own.status).toBe(200);
    expectContract(own, 'get', '/drivers/me');
  });

  test('attendance: record, the day’s roster, read, replace and change; a second record for the day is the spec’s 409', async () => {
    const depot = await createDepot();
    const { driver } = await createDriver({ depot });
    const { cookie } = await signIn(['admin']);
    const api = as(cookie);
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Addis_Ababa' }).format(new Date());

    const created = await api.post('/attendance', { driver_id: driver.public_id, date, status: 'present', notes: 'On time' });
    expect(created.status).toBe(201);
    expectContract(created, 'post', '/attendance');
    const id = created.body.data.id;
    const roster = await api.get(`/attendance?depot_id=${depot.public_id}&date=${date}`);
    expectContract(roster, 'get', '/attendance');
    expect(roster.body.data.some((r: { attendance: unknown }) => r.attendance !== null)).toBe(true);
    expectContract(await api.get(`/attendance/${id}`), 'get', '/attendance/{attendance_id}');
    expectContract(await api.put(`/attendance/${id}`, { status: 'late', notes: 'Traffic' }), 'put', '/attendance/{attendance_id}');
    expectContract(await api.patch(`/attendance/${id}`, { status: 'present' }), 'patch', '/attendance/{attendance_id}');
    const dup = await api.post('/attendance', { driver_id: driver.public_id, date, status: 'absent' });
    expect(dup.status).toBe(409);
    expectContract(dup, 'post', '/attendance');
  });

  test('documents: upload, list, read with a signed link, fetch the bytes, delete; a text file is the spec’s 415', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const { cookie } = await signIn(['admin']);
    const api = as(cookie);

    const upload = await request(app)
      .post('/api/v1/documents')
      .set('Cookie', cookie)
      .field('owner_type', 'vehicle')
      .field('owner_id', String(vehicle.public_id))
      .field('document_type', 'registration')
      .field('expires_on', '2031-01-01')
      .attach('file', PNG, { filename: 'registration.png', contentType: 'image/png' });
    expect(upload.status).toBe(201);
    expectContract(upload, 'post', '/documents');
    const id = upload.body.data.id;
    expectContract(await api.get(`/documents?owner_type=vehicle&owner_id=${vehicle.public_id}`), 'get', '/documents');
    const one = await api.get(`/documents/${id}`);
    expectContract(one, 'get', '/documents/{document_id}');

    const content = await request(app).get(one.body.data.url);
    expect(content.status).toBe(200);
    expect(content.headers['content-type']).toBe('image/png');
    expect(content.headers['x-content-type-options']).toBe('nosniff');
    const tampered = await request(app).get(`${one.body.data.url}0`);
    expect(tampered.status).toBe(401);
    expectContract(tampered, 'get', '/documents/{document_id}/content');

    const text = await request(app)
      .post('/api/v1/documents')
      .set('Cookie', cookie)
      .field('owner_type', 'vehicle')
      .field('owner_id', String(vehicle.public_id))
      .field('document_type', 'other')
      .attach('file', Buffer.from('not an image'), { filename: 'notes.txt', contentType: 'text/plain' });
    expect(text.status).toBe(415);
    expectContract(text, 'post', '/documents');

    const gone = await api.delete(`/documents/${id}`);
    expect(gone.status).toBe(204);
    expectContract(gone, 'delete', '/documents/{document_id}');
  });
});

describe('maintenance, inventory, audit and health', () => {
  test('inventory: add a part, list (both paths), read, change, adjust stock, the ledger; taking out more than there is is the spec’s 409', async () => {
    const depot = await createDepot();
    const { cookie } = await signIn(['admin']);
    const api = as(cookie);
    const number = `CT-${Date.now()}`;

    const created = await api.post('/inventory', { part_number: number, name: 'Oil filter', depot_id: depot.public_id, unit_cost_cents: 45_000, reorder_threshold: 5, stock_quantity: 10, service_item: 'engine_oil' });
    expect(created.status).toBe(201);
    expectContract(created, 'post', '/inventory');
    const id = created.body.data.id;
    expectContract(await api.get(`/inventory?depot_id=${depot.public_id}`), 'get', '/inventory');
    expectContract(await api.get(`/inventory/parts?depot_id=${depot.public_id}&below_reorder=false`), 'get', '/inventory/parts');
    expectContract(await api.get(`/inventory/${id}`), 'get', '/inventory/{part_id}');
    expectContract(await api.put(`/inventory/${id}`, { reorder_threshold: 8 }), 'put', '/inventory/{part_id}');
    expectContract(await api.post(`/inventory/${id}/adjust`, { quantity: -3, reason: 'Used in the workshop' }), 'post', '/inventory/{part_id}/adjust');
    const ledger = await api.get(`/inventory/${id}/movements`);
    expectContract(ledger, 'get', '/inventory/{part_id}/movements');
    expect(ledger.body.data).toHaveLength(2);
    const over = await api.post(`/inventory/${id}/adjust`, { quantity: -100, reason: 'Too many' });
    expect(over.status).toBe(409);
    expectContract(over, 'post', '/inventory/{part_id}/adjust');
  });

  test('maintenance: open work with a part, list, read, change, complete; and the same on the legacy /maintenance paths', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const { cookie } = await signIn(['admin']);
    const api = as(cookie);
    const part = (await api.post('/inventory', { part_number: `MT-${Date.now()}`, name: 'Brake pads', depot_id: depot.public_id, unit_cost_cents: 90_000, stock_quantity: 4 })).body.data;

    const created = await api.post('/maintenance-records', {
      vehicle_id: vehicle.public_id,
      description: 'Scheduled brake service',
      maintenance_type: 'preventive',
      labour_hours: 1.5,
      total_cost_cents: 200_000,
      parts: [{ part_id: part.id, quantity: 2, unit_cost_cents: 90_000 }],
    });
    expect(created.status).toBe(201);
    expectContract(created, 'post', '/maintenance-records');
    const id = created.body.data.id;
    expectContract(await api.get(`/maintenance-records?vehicle_id=${vehicle.public_id}&open=true`), 'get', '/maintenance-records');
    expectContract(await api.get(`/maintenance-records/${id}`), 'get', '/maintenance-records/{record_id}');
    expectContract(await api.patch(`/maintenance-records/${id}`, { notes: 'Pads at 30%' }), 'patch', '/maintenance-records/{record_id}');
    expectContract(await api.put(`/maintenance-records/${id}`, { priority: 'high' }), 'put', '/maintenance-records/{record_id}');
    const done = await api.post(`/maintenance-records/${id}/complete`, {});
    expect(done.status).toBe(200);
    expectContract(done, 'post', '/maintenance-records/{record_id}/complete');
    const closed = await api.patch(`/maintenance-records/${id}`, { notes: 'Too late' });
    expect(closed.status).toBe(409);
    expectContract(closed, 'patch', '/maintenance-records/{record_id}');

    // The legacy mounts answer the same.
    const legacy = await api.post('/maintenance', { vehicle_id: vehicle.public_id, description: 'Oil change', maintenance_type: 'preventive', labour_hours: 1, total_cost_cents: 50_000 });
    expect(legacy.status).toBe(201);
    expectContract(legacy, 'post', '/maintenance');
    const legacyId = legacy.body.data.id;
    expectContract(await api.get(`/maintenance?vehicle_id=${vehicle.public_id}`), 'get', '/maintenance');
    expectContract(await api.get(`/maintenance/${legacyId}`), 'get', '/maintenance/{record_id}');
    expectContract(await api.put(`/maintenance/${legacyId}`, { notes: 'Filter too' }), 'put', '/maintenance/{record_id}');
    expectContract(await api.patch(`/maintenance/${legacyId}`, { priority: 'low' }), 'patch', '/maintenance/{record_id}');
    expectContract(await api.post(`/maintenance/${legacyId}/complete`, {}), 'post', '/maintenance/{record_id}/complete');
    const failure = await api.post(`/maintenance/${id}/failures`, { component: 'brakes', failure_mode: 'wear', unplanned: false });
    expect(failure.status).toBe(201);
    expectContract(failure, 'post', '/maintenance/{record_id}/failures');
  });

  test('the audit trail, on both paths, with the freshness of the data it was read from', async () => {
    const { cookie } = await signIn(['admin']);
    const api = as(cookie);
    await api.post('/depots', { name: `Audit ${Date.now()}`, location: 'Addis Ababa' });
    const logs = await api.get('/audit-logs?page_size=5');
    expect(logs.status).toBe(200);
    expectContract(logs, 'get', '/audit-logs');
    expect(logs.body.data.length).toBeGreaterThan(0);
    expectContract(await api.get('/audit?action=INSERT,auth.*&entity_type=fleet.depots'), 'get', '/audit');
    const bad = await api.get('/audit-logs?action=');
    expect(bad.status).toBe(400);
    expectContract(bad, 'get', '/audit-logs');
  });

  test('health: the probes are at the root, not under /api/v1', async () => {
    expectContract(await request(app).get('/health/live'), 'get', '/health/live');
    const ready = await request(app).get('/health/ready');
    expect([200, 503]).toContain(ready.status);
    expectContract(ready, 'get', '/health/ready');
    expect((await request(app).get('/api/v1/health/live')).status).toBe(404);
  });
});

describe('the Sprint 3 operations (FMS-119)', () => {
  test('routes, trips, inspections and fuel logs return what the spec says', async () => {
    const depot = await createDepot();
    const { cookie } = await signIn(['admin']);
    const api = as(cookie);

    const route = await api.post('/routes', {
      name: 'Contract route',
      depot_id: depot.public_id,
      origin_name: 'A',
      origin: { latitude: 9.005401, longitude: 38.763611 },
      destination_name: 'B',
      destination: { latitude: 8.54, longitude: 39.27 },
      stops: [{ name: 'Mojo' }, { name: 'Bishoftu', latitude: 8.75, longitude: 38.98 }],
      distance_km: 99.5,
      estimated_duration_seconds: 7200,
    });
    expect(route.status).toBe(201);
    expectContract(route, 'post', '/routes');
    const routeId = route.body.data.id;
    expectContract(await api.get('/routes'), 'get', '/routes');
    expectContract(await api.get(`/routes/${routeId}`), 'get', '/routes/{route_id}');
    expectContract(await api.patch(`/routes/${routeId}`, { distance_km: 100, origin: null }), 'patch', '/routes/{route_id}');

    const trip = await api.post('/trips', { route_id: routeId, scheduled_start: '2032-03-01T06:00:00Z', scheduled_end: '2032-03-01T10:00:00Z' });
    expect(trip.status).toBe(201);
    expectContract(trip, 'post', '/trips');
    const tripId = trip.body.data.id;
    expectContract(await api.get('/trips'), 'get', '/trips');
    expectContract(await api.get(`/trips/${tripId}`), 'get', '/trips/{trip_id}');
    const moved = await api.patch(`/trips/${tripId}`, { scheduled_end: '2032-03-01T11:00:00Z' });
    expect(moved.status).toBe(200);
    expectContract(moved, 'patch', '/trips/{trip_id}');

    const vehicle = await createVehicle({ depot });
    const { driver } = await createDriver({ depot });
    const inspection = { vehicle_id: vehicle.public_id, driver_id: driver.public_id, trip_id: tripId, type: 'pre_trip', items: [{ name: 'Brakes', passed: true }, { name: 'Lights', passed: false, notes: 'Cracked' }] };
    const first = await api.post('/dvir-reports', inspection);
    expect(first.status).toBe(201);
    expectContract(first, 'post', '/dvir-reports');
    const again = await api.post('/dvir-reports', inspection);
    expect(again.status).toBe(200);
    expectContract(again, 'post', '/dvir-reports');
    const history = await api.get(`/vehicles/${vehicle.public_id}/dvir-reports`);
    expect(history.body.data).toHaveLength(1);
    expectContract(history, 'get', '/vehicles/{vehicle_id}/dvir-reports');

    const fuel = await api.post('/fuel-logs', { vehicle_id: vehicle.public_id, quantity_ml: 45_500, total_cost_cents: 380_000, odometer_km: 12_000.5 });
    expect(fuel.status).toBe(201);
    expectContract(await api.get('/fuel-logs'), 'get', '/fuel-logs');
    expectContract(await api.get(`/fuel-logs/${fuel.body.data.id}`), 'get', '/fuel-logs/{fuel_log_id}');
  });
});

describe('geofences and route deviation (FMS-90)', () => {
  test('geofences: draw, list, read, change, remove, restore; a crossing outline and a stale version are the spec’s; thresholds and flags with the new fields', async () => {
    const depot = await createDepot();
    const { cookie } = await signIn(['admin']);
    const api = as(cookie);
    const polygon = { type: 'Polygon', coordinates: [[[38.7603, 9.0098], [38.7623, 9.0098], [38.7623, 9.0118], [38.7603, 9.0118]]] };

    const created = await api.post('/geofences', { depot_id: depot.public_id, name: 'Contract yard', kind: 'keep_in', applies: 'off_trip', polygon });
    expect(created.status).toBe(201);
    expectContract(created, 'post', '/geofences');
    const id = created.body.data.geofence_id;
    expectContract(await api.get(`/geofences?depot_id=${depot.public_id}`), 'get', '/geofences');
    expectContract(await api.get(`/geofences/${id}`), 'get', '/geofences/{geofence_id}');
    expectContract(await api.patch(`/geofences/${id}`, { name: 'Contract night yard', description: 'Parked after 18:00' }), 'patch', '/geofences/{geofence_id}');
    const stale = await request(app).patch(`/api/v1/geofences/${id}`).set('Cookie', cookie).set('If-Match', '"0"').send({ name: 'Late' });
    expect(stale.status).toBe(409);
    expectContract(stale, 'patch', '/geofences/{geofence_id}');
    const crossing = await api.post('/geofences', { depot_id: depot.public_id, name: 'Bow', kind: 'keep_out', polygon: { type: 'Polygon', coordinates: [[[38.76, 9.01], [38.77, 9.02], [38.77, 9.01], [38.76, 9.02]]] } });
    expect(crossing.status).toBe(400);
    expectContract(crossing, 'post', '/geofences');
    const removed = await api.delete(`/geofences/${id}`);
    expect(removed.status).toBe(204);
    expectContract(removed, 'delete', '/geofences/{geofence_id}');
    expectContract(await api.post(`/geofences/${id}/reactivate`), 'post', '/geofences/{geofence_id}/reactivate');

    const thresholds = await api.put(`/settings/telemetry-rules/depots/${depot.public_id}`, { speed_limit_kmh: 80, speeding_pings: 3, clear_pings: 3, idle_minutes: 5, route_deviation_m: 800 });
    expect(thresholds.status).toBe(200);
    expectContract(thresholds, 'put', '/settings/telemetry-rules/depots/{depot_id}');
    expectContract(await api.get('/settings/telemetry-rules'), 'get', '/settings/telemetry-rules');
    const vehicle = await createVehicle({ depot });
    expectContract(await api.get(`/vehicles/${vehicle.public_id}/telemetry-flags`), 'get', '/vehicles/{vehicle_id}/telemetry-flags');
  });
});

describe('the contract check itself', () => {
  test('it names a body that does not match, a status the spec does not list, and an operation it does not have', () => {
    const wrong = responseProblems('/auth/me', 'get', 200, { data: { user: { id: 'not-a-uuid' } }, meta: { request_id: 'x' } });
    expect(wrong).toContain('instancePath');
    expect(responseProblems('/auth/me', 'get', 418, {})).toContain('lists no 418 response');
    expect(responseProblems('/this/path/is/not/in/the/spec', 'get', 200, {})).toContain('is not in the spec');
    expect(responseProblems('/auth/logout', 'post', 204, '')).toBeNull();
  });
});

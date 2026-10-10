import { randomUUID } from 'node:crypto';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import type { DomainEvent } from '../../src/shared/events/domain-event';
import { eventBus } from '../../src/shared/events/event-bus';
import { createDepot, createDriver, createUser, createVehicle, type RoleName } from '../support/factories';

const app = createApp();
const PASSWORD = 'Depot-Test-1';

type Depot = Awaited<ReturnType<typeof createDepot>>;

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
  put: (path: string, body: object, cookie = '') => request(app).put(`/api/v1${path}`).set('Cookie', cookie).send(body),
  delete: (path: string, cookie = '') => request(app).delete(`/api/v1${path}`).set('Cookie', cookie),
};

const code = () => `T-${randomUUID().slice(0, 6).toUpperCase()}`;

async function auditRows(res: Response) {
  const rows = await pool.query<{ action: string; entity_type: string }>(
    'SELECT action, entity_type FROM audit.audit_logs WHERE correlation_id = $1 ORDER BY id',
    [res.headers['x-request-id']],
  );
  return rows.rows;
}

describe('POST /depots', () => {
  test('creates a depot: 201, Location, ETag, code stored upper case, one audit row', async () => {
    const cookie = await signIn(['admin']);
    const c = code();
    const res = await api.post(
      '/depots',
      { name: ' Dire Dawa Yard ', location: 'Dire Dawa', code: ` ${c.toLowerCase()} `, timezone: 'Africa/Addis_Ababa', latitude: 9.6, longitude: 41.85, capacity: 40 },
      cookie,
    );
    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(`/api/v1/depots/${res.body.data.id}`);
    expect(res.headers.etag).toBe('"0"');
    expect(res.body.data).toMatchObject({
      name: 'Dire Dawa Yard',
      code: c,
      location: 'Dire Dawa',
      timezone: 'Africa/Addis_Ababa',
      latitude: 9.6,
      longitude: 41.85,
      capacity: 40,
      is_active: true,
      version: 0,
    });
    expect(await auditRows(res)).toEqual([{ action: 'INSERT', entity_type: 'fleet.depots' }]);
  });

  test('admin and fleet_owner may write; a fleet_manager gets 403, as does every other role', async () => {
    expect((await api.post('/depots', { name: 'A', location: 'B' }, await signIn(['fleet_owner']))).status).toBe(201);
    for (const role of ['fleet_manager', 'depot_admin', 'dispatcher', 'compliance_officer', 'driver'] as RoleName[]) {
      const res = await api.post('/depots', { name: 'A', location: 'B' }, await signIn([role], await createDepot()));
      expect(res.status, role).toBe(403);
    }
  });

  test('validates: required fields, unknown fields, a code twice, a bad time zone, half a coordinate pair', async () => {
    const cookie = await signIn(['admin']);
    expect((await api.post('/depots', { name: 'Only a name' }, cookie)).status).toBe(400);
    const extra = await api.post('/depots', { name: 'A', location: 'B', is_active: false }, cookie);
    expect(extra.body.error.details).toEqual([{ field: 'is_active', reason: 'not_writable' }]);

    const c = code();
    expect((await api.post('/depots', { name: 'A', location: 'B', code: c }, cookie)).status).toBe(201);
    const dup = await api.post('/depots', { name: 'C', location: 'D', code: c.toLowerCase() }, cookie);
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatchObject({ code: 'CONFLICT_DUPLICATE', details: [{ field: 'code', reason: 'already_exists' }] });

    expect((await api.post('/depots', { name: 'A', location: 'B', timezone: 'Mars/Olympus' }, cookie)).status).toBe(400);
    const half = await api.post('/depots', { name: 'A', location: 'B', latitude: 9 }, cookie);
    expect(half.status).toBe(400);
    expect(half.body.error.details).toEqual([{ field: 'longitude', reason: 'coordinates_pair' }]);
  });
});

describe('GET /depots', () => {
  test('any signed-in user sees every live depot; in_scope=true narrows to their own', async () => {
    const mine = await createDepot({ name: 'Zz Mine' });
    const other = await createDepot({ name: 'Zz Other' });
    const cookie = await signIn(['driver'], mine);

    const all = await api.get('/depots?page_size=100&search=Zz', cookie);
    expect(all.status).toBe(200);
    expect(all.body.data.map((d: { id: string }) => d.id)).toEqual(expect.arrayContaining([mine.public_id, other.public_id]));

    const scoped = await api.get('/depots?in_scope=true&page_size=100', await signIn(['depot_admin'], mine));
    expect(scoped.body.data.map((d: { id: string }) => d.id)).toEqual([mine.public_id]);
    expect((await api.get('/depots')).status).toBe(401);
  });

  test('deleted depots: listed and readable for depot:write only; 404 / 403 for everyone else', async () => {
    const depot = await createDepot({ name: `Zz Closed ${code()}`, is_active: false });
    const admin = await signIn(['admin']);
    const manager = await signIn(['fleet_manager']);

    expect((await api.get(`/depots?status=inactive&page_size=100`, admin)).body.data.map((d: { id: string }) => d.id)).toContain(depot.public_id);
    expect((await api.get('/depots?status=inactive', manager)).status).toBe(403);
    expect((await api.get(`/depots/${depot.public_id}`, admin)).body.data.is_active).toBe(false);
    expect((await api.get(`/depots/${depot.public_id}`, manager)).status).toBe(404);
    expect((await api.get('/depots/not-a-uuid', admin)).status).toBe(404);
  });
});

describe('PATCH and PUT /depots/{id}', () => {
  test('PATCH changes the fields sent with If-Match; a stale version is 409', async () => {
    const cookie = await signIn(['admin']);
    const depot = await createDepot();
    const res = await api.patch(`/depots/${depot.public_id}`, { name: 'Renamed', capacity: 12 }, cookie).set('If-Match', '"0"');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: 'Renamed', capacity: 12, version: 1, location: depot.location });
    expect(res.headers.etag).toBe('"1"');
    expect(await auditRows(res)).toEqual([{ action: 'UPDATE', entity_type: 'fleet.depots' }]);

    const stale = await api.patch(`/depots/${depot.public_id}`, { name: 'Again' }, cookie).set('If-Match', '"0"');
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('CONFLICT_CONCURRENT_MODIFICATION');
  });

  test('PUT replaces: optional fields it leaves out are cleared', async () => {
    const cookie = await signIn(['fleet_owner']);
    const created = await api.post('/depots', { name: 'Full', location: 'Adama', city: 'Adama', capacity: 30 }, cookie);
    const res = await api.put(`/depots/${created.body.data.id}`, { name: 'Full', location: 'Adama Hub' }, cookie);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ location: 'Adama Hub', city: null, capacity: null });
    expect((await api.put(`/depots/${created.body.data.id}`, { name: 'No location' }, cookie)).status).toBe(400);
  });

  test('a fleet_manager cannot change a depot; a deleted depot cannot be changed', async () => {
    const depot = await createDepot({ is_active: false });
    expect((await api.patch(`/depots/${depot.public_id}`, { name: 'X' }, await signIn(['fleet_manager']))).status).toBe(403);
    const res = await api.patch(`/depots/${depot.public_id}`, { name: 'X' }, await signIn(['admin']));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT_INVALID_STATE_TRANSITION');
  });
});

describe('DELETE /depots/{id}', () => {
  test('a depot with active vehicles is 409 CONFLICT_DEPOT_NOT_EMPTY, and so with drivers or user accounts', async () => {
    const cookie = await signIn(['admin']);
    const withVehicle = await createDepot();
    await createVehicle({ depot: withVehicle });
    const res = await api.delete(`/depots/${withVehicle.public_id}`, cookie);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'CONFLICT_DEPOT_NOT_EMPTY', details: [{ field: 'vehicles', reason: 'still_active' }] });
    expect(res.body.error.message).toContain('1 active vehicle');

    const withDriver = await createDepot();
    await createDriver({ depot: withDriver });
    const drivers = await api.delete(`/depots/${withDriver.public_id}`, cookie);
    expect(drivers.body.error.details).toEqual([
      { field: 'drivers', reason: 'still_active' },
      { field: 'users', reason: 'still_active' },
    ]);

    const withUser = await createDepot();
    await createUser({ roles: ['dispatcher'], depot: withUser });
    expect((await api.delete(`/depots/${withUser.public_id}`, cookie)).body.error.details).toEqual([{ field: 'users', reason: 'still_active' }]);
  });

  test("deleting soft-deletes with one audit row; the depot's vehicles stay in the database but leave GET /vehicles", async () => {
    const admin = await signIn(['admin']);
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot, status: 'retired', is_active: false });
    const before = await api.get(`/vehicles?status=retired&page_size=100`, admin);
    expect(before.body.data.map((v: { id: string }) => v.id)).toContain(vehicle.public_id);

    const res = await api.delete(`/depots/${depot.public_id}`, admin);
    expect(res.status).toBe(204);
    expect(await auditRows(res)).toEqual([{ action: 'DELETE', entity_type: 'fleet.depots' }]);
    const after = await api.get(`/vehicles?status=retired&page_size=100`, admin);
    expect(after.body.data.map((v: { id: string }) => v.id)).not.toContain(vehicle.public_id);
    expect((await pool.query('SELECT 1 FROM fleet.vehicles WHERE id = $1', [vehicle.id])).rowCount).toBe(1);
    expect((await api.get('/depots?page_size=100', admin)).body.data.map((d: { id: string }) => d.id)).not.toContain(depot.public_id);

    // Again: nothing to do, still 204. A new vehicle cannot go into it.
    expect((await api.delete(`/depots/${depot.public_id}`, admin)).status).toBe(204);
    const vehicleInto = await api.post(
      '/vehicles',
      { registration_number: `AA ${code()}`, make: 'Isuzu', model: 'FSR', vehicle_type: 'truck', fuel_type: 'diesel', fuel_efficiency_ml_per_km: 300, depot_id: depot.public_id },
      admin,
    );
    expect(vehicleInto.status).toBe(400);
  });

  test("a deleted depot's retired drivers leave GET /drivers too", async () => {
    const admin = await signIn(['admin']);
    const depot = await createDepot();
    const { user, driver } = await createDriver({ depot, is_active: false });
    await pool.query("UPDATE auth.users SET status = 'inactive' WHERE id = $1", [user.id]);
    const listed = async () => (await api.get('/drivers?status=retired&page_size=100', admin)).body.data.map((d: { id: string }) => d.id);
    expect(await listed()).toContain(driver.public_id);
    expect((await api.delete(`/depots/${depot.public_id}`, admin)).status).toBe(204);
    expect(await listed()).not.toContain(driver.public_id);
  });

  test('a fleet_manager cannot delete; reactivate brings a depot back', async () => {
    const depot = await createDepot();
    expect((await api.delete(`/depots/${depot.public_id}`, await signIn(['fleet_manager']))).status).toBe(403);
    const owner = await signIn(['fleet_owner']);
    expect((await api.delete(`/depots/${depot.public_id}`, owner)).status).toBe(204);
    const back = await api.post(`/depots/${depot.public_id}/reactivate`, {}, owner);
    expect(back.status).toBe(200);
    expect(back.body.data.is_active).toBe(true);
  });
});

describe('depot events', () => {
  const seen: DomainEvent[] = [];
  const unsubscribe: (() => void)[] = [];
  beforeAll(() => {
    for (const type of ['DepotCreated', 'DepotUpdated', 'DepotDeactivated', 'DepotReactivated']) {
      unsubscribe.push(eventBus.subscribe(type, (e) => void seen.push(e)));
    }
  });
  afterAll(() => unsubscribe.forEach((u) => u()));
  beforeEach(() => {
    seen.length = 0;
  });

  test('create, update, delete and reactivate each publish one event; a refused delete publishes nothing', async () => {
    const cookie = await signIn(['admin']);
    const created = await api.post('/depots', { name: 'Evented', location: 'Bahir Dar' }, cookie);
    const id = created.body.data.id;
    await api.patch(`/depots/${id}`, { capacity: 5 }, cookie);
    await api.delete(`/depots/${id}`, cookie);
    await api.post(`/depots/${id}/reactivate`, {}, cookie);
    const full = await createDepot();
    await createVehicle({ depot: full });
    await api.delete(`/depots/${full.public_id}`, cookie);

    expect(seen.map((e) => [e.type, e.payload.depot_id])).toEqual([
      ['DepotCreated', id],
      ['DepotUpdated', id],
      ['DepotDeactivated', id],
      ['DepotReactivated', id],
    ]);
    expect(seen[1].payload.changed_fields).toEqual(['capacity']);
  });
});

import { randomUUID } from 'node:crypto';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { checkDriverEligibility, fleetModule, isDriverEligible } from '../../src/modules/fleet';
import type { DomainEvent } from '../../src/shared/events/domain-event';
import { eventBus } from '../../src/shared/events/event-bus';
import { createDepot, createDriver, createTrip, createUser, createVehicle, type RoleName } from '../support/factories';

const app = createApp();
const PASSWORD = 'Driver-Test-1';

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
  delete: (path: string, cookie = '') => request(app).delete(`/api/v1${path}`).set('Cookie', cookie),
};

const licence = () => `DL-${randomUUID().slice(0, 8).toUpperCase()}`;

function driverBody(user: Record<string, unknown>, depot: Depot, overrides: Record<string, unknown> = {}) {
  return { user_id: user.public_id, license_number: licence(), license_expiry: '2030-06-30', depot_id: depot.public_id, ...overrides };
}

async function auditRows(res: Response) {
  const rows = await pool.query<{ action: string; entity_type: string }>(
    'SELECT action, entity_type FROM audit.audit_logs WHERE correlation_id = $1 ORDER BY id',
    [res.headers['x-request-id']],
  );
  return rows.rows;
}

const ids = (res: Response) => (res.body.data as { id: string }[]).map((d) => d.id);

describe('POST /drivers', () => {
  test("registers a driver: the licence on fleet.drivers, the depot on the user account, one audit row per change", async () => {
    const depot = await createDepot();
    const cookie = await signIn(['depot_admin'], depot);
    const user = await createUser({ roles: ['driver'], fullName: 'Abebe Kebede' }); // no depot yet

    const res = await api.post(
      '/drivers',
      driverBody(user, depot, { license_number: ' aa  12345 ', license_categories: ['CE', 'B'], hire_date: '2024-02-01', emergency_phone: '+251 911 234567' }),
      cookie,
    );

    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(`/api/v1/drivers/${res.body.data.id}`);
    expect(res.body.data).toMatchObject({
      user_id: user.public_id,
      full_name: 'Abebe Kebede',
      email: user.email,
      depot_id: depot.public_id,
      license_number: 'AA 12345',
      license_categories: ['B', 'CE'],
      license_expiry: '2030-06-30',
      hire_date: '2024-02-01',
      emergency_phone: '+251 911 234567',
      status: 'active',
    });
    expect(await auditRows(res)).toEqual([
      { action: 'INSERT', entity_type: 'fleet.drivers' },
      { action: 'UPDATE', entity_type: 'auth.users' },
    ]);
    const account = await pool.query('SELECT depot_id FROM auth.users WHERE id = $1', [user.id]);
    expect(account.rows[0].depot_id).toBe(depot.id);
  });

  test('a user already in that depot gets no account change and no second audit row', async () => {
    const depot = await createDepot();
    const user = await createUser({ roles: ['driver'], depot });
    const res = await api.post('/drivers', driverBody(user, depot), await signIn(['depot_admin'], depot));
    expect(res.status).toBe(201);
    expect(await auditRows(res)).toEqual([{ action: 'INSERT', entity_type: 'fleet.drivers' }]);
  });

  test('a duplicate licence returns 409 CONFLICT_DUPLICATE_LICENSE, whatever its case and spacing', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['depot_admin'], depot);
    const [a, b] = [await createUser({ roles: ['driver'], depot }), await createUser({ roles: ['driver'], depot })];
    expect((await api.post('/drivers', driverBody(a, depot, { license_number: 'AB 999' }), cookie)).status).toBe(201);

    const res = await api.post('/drivers', driverBody(b, depot, { license_number: 'ab  999' }), cookie);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT_DUPLICATE_LICENSE');
  });

  test('the same account cannot be registered twice', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['depot_admin'], depot);
    const user = await createUser({ roles: ['driver'], depot });
    await api.post('/drivers', driverBody(user, depot), cookie);
    const res = await api.post('/drivers', driverBody(user, depot), cookie);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'CONFLICT_DUPLICATE', details: [{ field: 'user_id', reason: 'already_exists' }] });
  });

  test('the account must exist in the caller’s depots, be active and hold the driver role', async () => {
    const [mine, other] = [await createDepot(), await createDepot()];
    const cookie = await signIn(['depot_admin'], mine);
    const cases: [object, string][] = [
      [{ public_id: randomUUID() }, 'references_missing_record'],
      [await createUser({ roles: ['driver'], depot: other }), 'references_missing_record'],
      [await createUser({ roles: ['driver'], depot: mine, status: 'suspended' }), 'account_not_active'],
      [await createUser({ roles: ['dispatcher'], depot: mine }), 'not_a_driver'],
    ];
    for (const [user, reason] of cases) {
      const res = await api.post('/drivers', driverBody(user as Record<string, unknown>, mine), cookie);
      expect(res.status, reason).toBe(400);
      expect(res.body.error.details).toEqual([{ field: 'user_id', reason }]);
    }
  });

  test('a depot outside the caller’s scope is a missing record', async () => {
    const [mine, other] = [await createDepot(), await createDepot()];
    const user = await createUser({ roles: ['driver'] });
    const res = await api.post('/drivers', driverBody(user, other), await signIn(['depot_admin'], mine));
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([{ field: 'depot_id', reason: 'references_missing_record' }]);
  });

  test('validates dates and fields: bad expiry, future hire date, unknown fields', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['depot_admin'], depot);
    const user = await createUser({ roles: ['driver'], depot });
    const bad = async (overrides: Record<string, unknown>) => (await api.post('/drivers', driverBody(user, depot, overrides), cookie)).body.error;

    expect((await bad({ license_expiry: '2030-02-30' })).details).toContainEqual(expect.objectContaining({ field: 'license_expiry' }));
    expect((await bad({ hire_date: '2999-01-01' })).details).toEqual([{ field: 'hire_date', reason: 'in_future' }]);
    expect((await bad({ full_name: 'X' })).details).toEqual([{ field: 'full_name', reason: 'not_writable' }]);
  });

  test('a dispatcher (no driver:write) gets 403, a driver 403, no session 401', async () => {
    const depot = await createDepot();
    const user = await createUser({ roles: ['driver'], depot });
    for (const role of ['dispatcher', 'driver'] as const) {
      expect((await api.post('/drivers', driverBody(user, depot), await signIn([role], depot))).status, role).toBe(403);
    }
    expect((await api.post('/drivers', driverBody(user, depot))).status).toBe(401);
  });
});

describe('GET /drivers', () => {
  test('?license_expiring_before=2026-12-31 returns only licences expiring before that date', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['fleet_manager']);
    const expiry = async (date: string) => (await createDriver({ depot, license_expiry: date })).driver.public_id;
    const [expired, soon, onDate, later] = [await expiry('2025-03-01'), await expiry('2026-06-30'), await expiry('2026-12-31'), await expiry('2027-01-01')];

    const res = await api.get(`/drivers?depot_id=${depot.public_id}&license_expiring_before=2026-12-31&sort_by=license_expiry`, cookie);
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([expired, soon]);
    expect(ids(res)).not.toContain(onDate);
    expect(ids(res)).not.toContain(later);
  });

  test("a dispatcher sees only their depot's drivers; an admin sees all", async () => {
    const [a, b] = [await createDepot(), await createDepot()];
    const [da, db] = [await createDriver({ depot: a }), await createDriver({ depot: b })];

    const fromA = ids(await api.get('/drivers?page_size=100', await signIn(['dispatcher'], a)));
    expect(fromA).toContain(da.driver.public_id);
    expect(fromA).not.toContain(db.driver.public_id);

    const all = ids(await api.get('/drivers?page_size=100', await signIn(['admin'])));
    expect(all).toEqual(expect.arrayContaining([da.driver.public_id, db.driver.public_id]));

    // Asking for another depot by id does not get round the scope.
    expect(ids(await api.get(`/drivers?depot_id=${b.public_id}`, await signIn(['dispatcher'], a)))).toEqual([]);
  });

  test('searches name, email and licence number, case-insensitively', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['fleet_manager']);
    const named = await createUser({ roles: ['driver'], depot, fullName: 'Tigist Alemu', email: `tigist-${randomUUID().slice(0, 6)}@fleet.et` });
    const { rows } = await pool.query(
      "INSERT INTO fleet.drivers (user_id, license_number, license_expiry) VALUES ($1, $2, '2030-01-01') RETURNING public_id",
      [named.id, `ZX-${randomUUID().slice(0, 6).toUpperCase()}`],
    );
    const other = await createDriver({ depot });

    const search = async (term: string) => ids(await api.get(`/drivers?depot_id=${depot.public_id}&search=${encodeURIComponent(term)}`, cookie));
    expect(await search('tigist')).toEqual([rows[0].public_id]);
    expect(await search('FLEET.ET')).toEqual([rows[0].public_id]);
    expect(await search('zx-')).toEqual([rows[0].public_id]);
    expect(await search('%')).toEqual([]);
    expect((await search('LIC-')).sort()).toEqual([other.driver.public_id]);
  });

  test('pages with contract meta; retired drivers leave the default list', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['fleet_manager']);
    for (let i = 0; i < 3; i++) await createDriver({ depot });
    const retired = await createDriver({ depot, is_active: false });

    const page = await api.get(`/drivers?depot_id=${depot.public_id}&page=2&page_size=2`, cookie);
    expect(page.body.meta).toMatchObject({ page: 2, page_size: 2, total_items: 3, total_pages: 2 });
    expect(ids(await api.get(`/drivers?depot_id=${depot.public_id}&status=retired`, cookie))).toEqual([retired.driver.public_id]);
  });
});

describe('GET /drivers/{id}', () => {
  test('returns a driver in scope with their personal data; another depot or a bad id is 404', async () => {
    const [a, b] = [await createDepot(), await createDepot()];
    const [da, db] = [await createDriver({ depot: a }), await createDriver({ depot: b })];
    const cookie = await signIn(['dispatcher'], a);

    const own = await api.get(`/drivers/${da.driver.public_id}`, cookie);
    expect(own.status).toBe(200);
    expect(own.body.data).toMatchObject({ id: da.driver.public_id, user_id: da.user.public_id, depot_id: a.public_id, email: da.user.email });

    for (const id of [String(db.driver.public_id), randomUUID(), 'nope']) {
      expect((await api.get(`/drivers/${id}`, cookie)).status, id).toBe(404);
    }
  });
});

describe('PATCH /drivers/{id}', () => {
  test('updates licence fields with one audit row; moving depot updates the account', async () => {
    const [a, b] = [await createDepot(), await createDepot()];
    const { driver, user } = await createDriver({ depot: a });
    const cookie = await signIn(['fleet_manager']);

    const licenceOnly = await api.patch(`/drivers/${driver.public_id}`, { license_expiry: '2031-01-31' }, cookie);
    expect(licenceOnly.status).toBe(200);
    expect(licenceOnly.body.data.license_expiry).toBe('2031-01-31');
    expect(await auditRows(licenceOnly)).toEqual([{ action: 'UPDATE', entity_type: 'fleet.drivers' }]);

    const move = await api.patch(`/drivers/${driver.public_id}`, { depot_id: b.public_id }, cookie);
    expect(move.body.data.depot_id).toBe(b.public_id);
    expect(await auditRows(move)).toEqual([{ action: 'UPDATE', entity_type: 'auth.users' }]);
    expect((await pool.query('SELECT depot_id FROM auth.users WHERE id = $1', [user.id])).rows[0].depot_id).toBe(b.id);
  });

  test('another depot is 404; moving into a depot outside the scope is 400; a retired driver is 409; user_id is fixed', async () => {
    const [a, b] = [await createDepot(), await createDepot()];
    const [da, db] = [await createDriver({ depot: a }), await createDriver({ depot: b })];
    const retired = await createDriver({ depot: a, is_active: false });
    const cookie = await signIn(['depot_admin'], a);

    expect((await api.patch(`/drivers/${db.driver.public_id}`, { license_categories: ['B'] }, cookie)).status).toBe(404);
    const move = await api.patch(`/drivers/${da.driver.public_id}`, { depot_id: b.public_id }, cookie);
    expect(move.status).toBe(400);
    expect(move.body.error.details).toEqual([{ field: 'depot_id', reason: 'references_missing_record' }]);
    const old = await api.patch(`/drivers/${retired.driver.public_id}`, { license_categories: ['B'] }, cookie);
    expect(old.status).toBe(409);
    expect(old.body.error.code).toBe('CONFLICT_INVALID_STATE_TRANSITION');
    const fixed = await api.patch(`/drivers/${da.driver.public_id}`, { user_id: randomUUID() }, cookie);
    expect(fixed.body.error.details).toContainEqual({ field: 'user_id', reason: 'not_writable' });
  });
});

describe('DELETE /drivers/{id}', () => {
  test('retiring an idle driver: 204, one audit row, hidden from the default list, still readable', async () => {
    const depot = await createDepot();
    const { driver } = await createDriver({ depot });
    const cookie = await signIn(['depot_admin'], depot);

    const res = await api.delete(`/drivers/${driver.public_id}`, cookie);
    expect(res.status).toBe(204);
    expect(await auditRows(res)).toEqual([{ action: 'DELETE', entity_type: 'fleet.drivers' }]);
    expect(ids(await api.get(`/drivers?depot_id=${depot.public_id}`, cookie))).not.toContain(driver.public_id);
    expect((await api.get(`/drivers/${driver.public_id}`, cookie)).body.data.status).toBe('retired');

    const again = await api.delete(`/drivers/${driver.public_id}`, cookie);
    expect(again.status).toBe(204);
    expect(await auditRows(again)).toEqual([]);
  });

  test('retiring a driver with an active trip returns 409 CONFLICT_DRIVER_IN_USE', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['depot_admin'], depot);
    for (const status of ['assigned', 'en_route'] as const) {
      const { driver } = await createDriver({ depot });
      await createTrip({ vehicle: await createVehicle({ depot }), driver, status });
      const res = await api.delete(`/drivers/${driver.public_id}`, cookie);
      expect(res.status, status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT_DRIVER_IN_USE');
    }
  });

  test('a completed trip does not block retirement; an active vehicle assignment does', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['depot_admin'], depot);

    const done = await createDriver({ depot });
    await createTrip({ vehicle: await createVehicle({ depot }), driver: done.driver, status: 'completed', actual_start: '2026-01-01T08:00:00Z', actual_end: '2026-01-01T10:00:00Z' });
    expect((await api.delete(`/drivers/${done.driver.public_id}`, cookie)).status).toBe(204);

    const assigned = await createDriver({ depot });
    const vehicle = await createVehicle({ depot });
    await pool.query('INSERT INTO fleet.driver_vehicle_assignments (driver_id, vehicle_id) VALUES ($1, $2)', [assigned.driver.id, vehicle.id]);
    expect((await api.delete(`/drivers/${assigned.driver.public_id}`, cookie)).body.error.code).toBe('CONFLICT_DRIVER_IN_USE');
  });
});

describe('isDriverEligible (for the trip module)', () => {
  test('active driver, active account, licence valid on the date in Addis Ababa', async () => {
    const depot = await createDepot();
    const { driver } = await createDriver({ depot, license_expiry: '2026-12-31' });
    expect(await isDriverEligible(driver.id, new Date('2026-06-01T08:00:00Z'))).toBe(true);
    // 31 Dec 23:00 in Addis Ababa (UTC+3) is still the last valid day...
    expect(await isDriverEligible(driver.id, new Date('2026-12-31T20:00:00Z'))).toBe(true);
    // ...but 21:30 UTC on 31 Dec is already 1 January there.
    expect(await isDriverEligible(driver.id, new Date('2026-12-31T21:30:00Z'))).toBe(false);
  });

  test('a retired driver, a suspended account or an unknown id is not eligible', async () => {
    const depot = await createDepot();
    const at = new Date('2026-06-01T08:00:00Z');
    const retired = await createDriver({ depot, is_active: false });
    const suspended = await createDriver({ depot });
    await pool.query("UPDATE auth.users SET status = 'suspended' WHERE id = $1", [suspended.user.id]);

    expect(await isDriverEligible(retired.driver.id, at)).toBe(false);
    expect(await isDriverEligible(suspended.driver.id, at)).toBe(false);
    expect(await isDriverEligible('999999999', at)).toBe(false);
  });
});

describe('driver events', () => {
  const received: DomainEvent[] = [];
  let unsubscribe: (() => void)[] = [];
  beforeAll(() => {
    unsubscribe = ['DriverRegistered', 'DriverRetired'].map((type) => eventBus.subscribe(type, (e) => void received.push(e)));
  });
  beforeEach(() => {
    received.length = 0;
  });
  afterAll(() => unsubscribe.forEach((u) => u()));

  test('register and retire each publish one event; a failed register publishes nothing', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['depot_admin'], depot);
    const user = await createUser({ roles: ['driver'], depot });

    const created = await api.post('/drivers', driverBody(user, depot, { license_number: 'EVT 1' }), cookie);
    await api.post('/drivers', driverBody(await createUser({ roles: ['driver'], depot }), depot, { license_number: 'EVT 1' }), cookie);
    await api.delete(`/drivers/${created.body.data.id}`, cookie);

    expect(received.map((e) => e.type)).toEqual(['DriverRegistered', 'DriverRetired']);
    expect(received[0].payload).toEqual({ driver_id: created.body.data.id, user_id: user.public_id, depot_id: depot.public_id });
  });
});

/** A date `days` from today in Addis Ababa, `YYYY-MM-DD` (the date the API judges licences by). */
function addisDate(days: number): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Addis_Ababa' }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe('license_status (enhancement 2)', () => {
  test('every driver shows valid, expiring_soon (within 30 days) or expired, and the list filters on it', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['fleet_manager']);
    const [expired, soon, valid] = [
      await createDriver({ depot, license_expiry: addisDate(-1) }),
      await createDriver({ depot, license_expiry: addisDate(30) }),
      await createDriver({ depot, license_expiry: addisDate(31) }),
    ];

    const statusOf = async (d: { driver: Record<string, unknown> }) =>
      (await api.get(`/drivers/${d.driver.public_id}`, cookie)).body.data.license_status;
    expect([await statusOf(expired), await statusOf(soon), await statusOf(valid)]).toEqual(['expired', 'expiring_soon', 'valid']);

    expect(ids(await api.get(`/drivers?depot_id=${depot.public_id}&license_status=expiring_soon`, cookie))).toEqual([soon.driver.public_id]);
    expect(ids(await api.get(`/drivers?depot_id=${depot.public_id}&license_status=expired`, cookie))).toEqual([expired.driver.public_id]);
  });
});

describe('GET /drivers/me (enhancement 3)', () => {
  test("a driver reads their own profile, though they cannot list drivers", async () => {
    const depot = await createDepot();
    const user = await createUser({ roles: ['driver'], depot, password: PASSWORD });
    const { rows } = await pool.query(
      "INSERT INTO fleet.drivers (user_id, license_number, license_expiry) VALUES ($1, $2, '2030-01-01') RETURNING public_id",
      [user.id, licence()],
    );
    const login = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
    const cookie = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');

    const me = await api.get('/drivers/me', cookie);
    expect(me.status).toBe(200);
    expect(me.body.data).toMatchObject({ id: rows[0].public_id, user_id: user.public_id, depot_id: depot.public_id, license_status: 'valid' });
    expect((await api.get('/drivers', cookie)).status).toBe(403);
  });

  test('a signed-in user who is not a driver gets 404; no session gets 401', async () => {
    expect((await api.get('/drivers/me', await signIn(['dispatcher'], await createDepot()))).status).toBe(404);
    expect((await api.get('/drivers/me')).status).toBe(401);
  });
});

describe('checkDriverEligibility (enhancement 1)', () => {
  const at = new Date('2026-06-01T08:00:00Z');

  test('the licence class must cover the vehicle type', async () => {
    const depot = await createDepot();
    const truck = await createVehicle({ depot, vehicle_type: 'truck' });
    const car = await createVehicle({ depot, vehicle_type: 'car' });
    const { driver } = await createDriver({ depot, license_categories: ['B'] });

    expect(await checkDriverEligibility(driver.id, at, { vehicleId: car.id })).toEqual({ eligible: true, reasons: [] });
    expect(await checkDriverEligibility(driver.id, at, { vehicleId: truck.id })).toEqual({
      eligible: false,
      reasons: ['license_category_not_valid_for_vehicle'],
    });
  });

  test('every reason is reported, and isDriverEligible agrees', async () => {
    const depot = await createDepot();
    const truck = await createVehicle({ depot, vehicle_type: 'truck' });
    const { driver, user } = await createDriver({ depot, license_expiry: '2026-01-31', is_active: false });
    await pool.query("UPDATE auth.users SET status = 'locked' WHERE id = $1", [user.id]);

    expect(await checkDriverEligibility(driver.id, at, { vehicleId: truck.id })).toEqual({
      eligible: false,
      reasons: ['driver_retired', 'account_not_active', 'license_expired', 'license_category_missing'],
    });
    expect(await isDriverEligible(driver.id, at)).toBe(false);
    expect(await checkDriverEligibility('999999999', at)).toEqual({ eligible: false, reasons: ['driver_not_found'] });
  });
});

describe('licence expiry warnings (enhancement 2)', () => {
  const received: DomainEvent[] = [];
  let off: () => void = () => {};
  beforeAll(() => {
    off = eventBus.subscribe('DriverLicenseExpiring', (e) => void received.push(e));
  });
  beforeEach(() => {
    received.length = 0;
  });
  afterAll(() => off());

  test('the daily job warns 30 and 7 days before expiry, once per fact', async () => {
    const depot = await createDepot();
    const in30 = await createDriver({ depot, license_expiry: addisDate(30) });
    const in7 = await createDriver({ depot, license_expiry: addisDate(7) });
    await createDriver({ depot, license_expiry: addisDate(8) });
    await createDriver({ depot, license_expiry: addisDate(7), is_active: false });

    const job = fleetModule.jobs!.find((j) => j.name === 'driver-licence-expiry-warnings')!;
    await job.run(new Date());
    const mine = received.filter((e) => [in30.driver.public_id, in7.driver.public_id].includes(e.payload.driver_id));
    expect(mine.map((e) => e.payload.days_left).sort()).toEqual([30, 7]);
    expect(mine.find((e) => e.payload.days_left === 7)!.payload).toEqual({
      driver_id: in7.driver.public_id,
      user_id: in7.user.public_id,
      depot_id: depot.public_id,
      license_expiry: addisDate(7),
      days_left: 7,
    });

    // A rerun the same day publishes the same event ids, so consumers process each fact once.
    const firstIds = mine.map((e) => e.id).sort();
    received.length = 0;
    await job.run(new Date());
    const again = received.filter((e) => [in30.driver.public_id, in7.driver.public_id].includes(e.payload.driver_id));
    expect(again.map((e) => e.id).sort()).toEqual(firstIds);
  });
});

describe('POST /drivers/{id}/reinstate (enhancement 4)', () => {
  test('a retired driver becomes active again with one audit row and an event; reinstating twice changes nothing', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['depot_admin'], depot);
    const { driver } = await createDriver({ depot });
    await api.delete(`/drivers/${driver.public_id}`, cookie);

    const received: DomainEvent[] = [];
    const off = eventBus.subscribe('DriverReinstated', (e) => void received.push(e));
    try {
      const res = await api.post(`/drivers/${driver.public_id}/reinstate`, {}, cookie);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ id: driver.public_id, status: 'active' });
      expect(await auditRows(res)).toEqual([{ action: 'UPDATE', entity_type: 'fleet.drivers' }]);
      expect(ids(await api.get(`/drivers?depot_id=${depot.public_id}`, cookie))).toContain(driver.public_id);

      const again = await api.post(`/drivers/${driver.public_id}/reinstate`, {}, cookie);
      expect(again.status).toBe(200);
      expect(await auditRows(again)).toEqual([]);
      expect(received.map((e) => e.payload.driver_id)).toEqual([driver.public_id]);
    } finally {
      off();
    }
  });

  test('another depot is 404; a dispatcher (no driver:write) is 403', async () => {
    const [a, b] = [await createDepot(), await createDepot()];
    const { driver } = await createDriver({ depot: b, is_active: false });
    expect((await api.post(`/drivers/${driver.public_id}/reinstate`, {}, await signIn(['depot_admin'], a))).status).toBe(404);
    expect((await api.post(`/drivers/${driver.public_id}/reinstate`, {}, await signIn(['dispatcher'], b))).status).toBe(403);
  });
});

describe('DriverUpdated and DriverTransferred (enhancement 5)', () => {
  test('a licence change publishes DriverUpdated; a depot move DriverTransferred; both in one PATCH publish both', async () => {
    const [a, b] = [await createDepot(), await createDepot()];
    const { driver, user } = await createDriver({ depot: a });
    const cookie = await signIn(['fleet_manager']);
    const received: DomainEvent[] = [];
    const offs = ['DriverUpdated', 'DriverTransferred'].map((t) => eventBus.subscribe(t, (e) => void received.push(e)));
    try {
      await api.patch(`/drivers/${driver.public_id}`, { license_expiry: '2031-01-31', license_categories: ['B'], depot_id: b.public_id }, cookie);
      expect(received.map((e) => e.type)).toEqual(['DriverUpdated', 'DriverTransferred']);
      expect(received[0].payload).toEqual({
        driver_id: driver.public_id,
        user_id: user.public_id,
        depot_id: b.public_id,
        changed_fields: ['license_categories', 'license_expiry'],
      });
      expect(received[1].payload).toMatchObject({ from_depot_id: a.public_id, to_depot_id: b.public_id });

      received.length = 0;
      await api.patch(`/drivers/${driver.public_id}`, { depot_id: b.public_id }, cookie); // already there
      expect(received).toEqual([]);
    } finally {
      offs.forEach((off) => off());
    }
  });
});

describe('If-Match on PATCH /drivers/{id} (enhancement 6)', () => {
  test('the ETag is the version; a stale If-Match is 409 CONFLICT_CONCURRENT_MODIFICATION', async () => {
    const [a, b] = [await createDepot(), await createDepot()];
    const { driver } = await createDriver({ depot: a });
    const cookie = await signIn(['fleet_manager']);

    const read = await api.get(`/drivers/${driver.public_id}`, cookie);
    expect(read.headers.etag).toBe('"0"');
    expect(read.body.data.version).toBe(0);

    const first = await api.patch(`/drivers/${driver.public_id}`, { license_categories: ['B'] }, cookie).set('If-Match', '"0"');
    expect(first.status).toBe(200);
    expect(first.headers.etag).toBe('"1"');

    const stale = await api.patch(`/drivers/${driver.public_id}`, { license_categories: ['C'] }, cookie).set('If-Match', '"0"');
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('CONFLICT_CONCURRENT_MODIFICATION');

    // A depot move changes only the account, but still moves the driver's version on.
    const moved = await api.patch(`/drivers/${driver.public_id}`, { depot_id: b.public_id }, cookie).set('If-Match', '"1"');
    expect(moved.headers.etag).toBe('"2"');

    expect((await api.patch(`/drivers/${driver.public_id}`, { license_categories: [] }, cookie).set('If-Match', 'v2')).status).toBe(400);
    expect((await api.patch(`/drivers/${driver.public_id}`, { license_categories: [] }, cookie)).status).toBe(200); // no If-Match: allowed
  });
});

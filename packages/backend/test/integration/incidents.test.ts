import { randomUUID } from 'node:crypto';
import request, { type Response } from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { hashPassword } from '../../src/modules/auth';
import { createDepot, createDriver, createTrip, createUser, createVehicle, type RoleName } from '../support/factories';
import { deliverEvents, publishedEvents } from '../support/events';

// FMS-38: incident reports. A critical one flags the vehicle in the same transaction and, once its
// IncidentReported event is delivered, becomes an alert (FMS-92).

const app = createApp();
const PASSWORD = 'Incident-Test-1';
type Row = Record<string, unknown> & { id: string };

async function login(email: string): Promise<string> {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

async function signIn(roles: RoleName[], depot: Row | null = null): Promise<{ cookie: string; user: Row }> {
  const user = await createUser({ roles, depot, password: PASSWORD });
  return { cookie: await login(user.email as string), user };
}

/** A driver who can sign in, with their fleet.drivers row. */
async function driverWithLogin(depot: Row) {
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
  patch: (path: string, body: object, cookie: string) => request(app).patch(`/api/v1${path}`).set('Cookie', cookie).send(body),
};

const pub = (row: Record<string, unknown>) => row.public_id as string;

const report = (extra: Record<string, unknown> = {}) => ({ description: 'Rear-ended at the Bole junction, bumper hanging.', severity: 'high', ...extra });

const flagOf = async (vehicle: Row) => (await pool.query<{ f: boolean }>('SELECT maintenance_flag AS f FROM fleet.vehicles WHERE id = $1', [vehicle.id])).rows[0].f;
const incidentCount = async () => (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM alert.incident_reports')).rows[0].n;
const incidentAlerts = async () => (await pool.query("SELECT * FROM alert.alerts WHERE alert_type = 'incident' ORDER BY id")).rows as Row[];
const ids = (res: Response) => (res.body.data as { id: string }[]).map((i) => i.id);

async function auditRows(res: Response) {
  const rows = await pool.query<{ action: string; entity_type: string }>('SELECT action, entity_type FROM audit.audit_logs WHERE correlation_id = $1 ORDER BY id', [
    res.headers['x-request-id'],
  ]);
  return rows.rows.map((r) => `${r.action} ${r.entity_type}`);
}

/** An incident straight into the table, for the read tests (the API writes are tested above them). */
async function insertIncident(reporter: Row, extra: Record<string, unknown> = {}) {
  const values = { reported_by: reporter.id, description: 'Seeded', severity: 'medium', ...extra };
  const keys = Object.keys(values);
  const res = await pool.query<{ id: string; public_id: string }>(
    `INSERT INTO alert.incident_reports (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id, public_id`,
    Object.values(values),
  );
  return res.rows[0];
}

describe('POST /incidents', () => {
  test("a driver's critical incident on their trip: 201, the vehicle flagged in the same transaction, IncidentReported, then an alert", async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot, registration_number: 'AA 3-38001' });
    const { user, driver, cookie } = await driverWithLogin(depot);
    const trip = await createTrip({ vehicle, driver, status: 'en_route', actual_start: new Date().toISOString() });
    const dispatcher = await createUser({ roles: ['dispatcher'], depot });
    const depotAdmin = await createUser({ roles: ['depot_admin'], depot });
    const occurredAt = new Date(Date.now() - 10 * 60_000).toISOString();

    const res = await api.post(
      '/incidents',
      report({ severity: 'critical', incident_type: 'accident', vehicle_id: pub(vehicle), trip_id: pub(trip), latitude: 8.995, longitude: 38.789, occurred_at: occurredAt }),
      cookie,
    );
    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(`/api/v1/incidents/${res.body.data.id}`);
    expect(res.body.meta.created).toBe(true);
    expect(res.body.data).toMatchObject({
      incident_type: 'accident',
      severity: 'critical',
      status: 'open',
      description: 'Rear-ended at the Bole junction, bumper hanging.',
      vehicle_id: pub(vehicle),
      driver_id: pub(driver),
      trip_id: pub(trip),
      depot_id: pub(depot),
      reported_by: pub(user),
      latitude: 8.995,
      longitude: 38.789,
      occurred_at: occurredAt,
    });
    expect(await flagOf(vehicle)).toBe(true);
    expect(await auditRows(res)).toEqual(['INSERT alert.incident_reports', 'UPDATE fleet.vehicles']);

    const [event, ...rest] = await publishedEvents('IncidentReported');
    expect(rest).toEqual([]);
    expect(event.aggregate).toBe(`incident:${res.body.data.id}`);
    expect(event.actor).toBe(pub(user));
    expect(event.payload).toEqual({
      incident_id: res.body.data.id,
      depot_id: pub(depot),
      vehicle_id: pub(vehicle),
      driver_id: pub(driver),
      trip_id: pub(trip),
      severity: 'critical',
      incident_type: 'accident',
      status: 'open',
      latitude: 8.995,
      longitude: 38.789,
      occurred_at: occurredAt,
      maintenance_flag_set: true,
      reported_by_driver_id: pub(driver),
    });
    expect(event.payload).not.toHaveProperty('description');

    await deliverEvents();
    const [alert, ...more] = await incidentAlerts();
    expect(more).toEqual([]);
    expect(alert).toMatchObject({
      severity: 'critical',
      status: 'open',
      source_event_type: 'IncidentReported',
      title: 'Accident reported on AA 3-38001',
      description: 'A critical incident was reported and the vehicle is flagged for maintenance. Review it and follow up.',
      depot_id: depot.id,
      vehicle_id: vehicle.id,
      driver_id: driver.id,
      trip_id: trip.id,
      entity_type: 'incident',
      entity_id: res.body.data.id,
    });
    const told = await pool.query<{ id: string }>('SELECT recipient_user_id::text AS id FROM alert.notifications WHERE alert_id = $1 ORDER BY 1', [alert.id]);
    expect(told.rows.map((r) => r.id).sort()).toEqual([dispatcher.id, depotAdmin.id].map(String).sort());
  });

  test('defaults: type other, now, and without a vehicle the reporter depot; a high incident is no alert and flags nothing', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const { cookie } = await driverWithLogin(depot);

    const before = Date.now();
    const bare = await api.post('/incidents', { description: '  Stone thrown at the windscreen.  ', severity: 'medium' }, cookie);
    expect(bare.status).toBe(201);
    expect(bare.body.data).toMatchObject({ incident_type: 'other', description: 'Stone thrown at the windscreen.', vehicle_id: null, trip_id: null, depot_id: pub(depot), latitude: null });
    expect(Date.parse(bare.body.data.occurred_at)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(bare.body.data.occurred_at)).toBeLessThanOrEqual(Date.now() + 1000);

    const high = await api.post('/incidents', report({ vehicle_id: pub(vehicle) }), cookie);
    expect(high.status).toBe(201);
    expect(await flagOf(vehicle)).toBe(false);
    expect((await publishedEvents('IncidentReported')).map((e) => e.payload.maintenance_flag_set)).toEqual([false, false]);
    await deliverEvents();
    expect(await incidentAlerts()).toEqual([]);
  });

  test('a critical incident on a vehicle already flagged leaves the flag, says so, and is still an alert; one with no vehicle is an alert too', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot, maintenance_flag: true });
    const { cookie } = await driverWithLogin(depot);

    const res = await api.post('/incidents', report({ severity: 'critical', vehicle_id: pub(vehicle) }), cookie);
    expect(await auditRows(res)).toEqual(['INSERT alert.incident_reports']);
    expect(await flagOf(vehicle)).toBe(true);
    expect((await api.post('/incidents', report({ severity: 'critical', incident_type: 'injury' }), cookie)).status).toBe(201);

    expect((await publishedEvents('IncidentReported')).map((e) => e.payload.maintenance_flag_set)).toEqual([false, false]);
    await deliverEvents();
    const [onVehicle, noVehicle, ...more] = await incidentAlerts();
    expect(more).toEqual([]);
    const message = 'A critical incident was reported. Review it and follow up.';
    expect(onVehicle).toMatchObject({ title: expect.stringMatching(/^Other reported on /), depot_id: depot.id, vehicle_id: vehicle.id, description: message });
    expect(noVehicle).toMatchObject({ title: 'Injury reported', depot_id: depot.id, vehicle_id: null, description: message });
  });

  test('the cached vehicle shows the flag once the event is delivered', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const { cookie } = await driverWithLogin(depot);
    const staff = await signIn(['depot_admin'], depot);
    expect((await api.get(`/vehicles/${pub(vehicle)}`, staff.cookie)).body.data.maintenance_flag).toBe(false);

    await api.post('/incidents', report({ severity: 'critical', vehicle_id: pub(vehicle) }), cookie);
    await deliverEvents();
    expect((await api.get(`/vehicles/${pub(vehicle)}`, staff.cookie)).body.data.maintenance_flag).toBe(true);
  });

  test("staff report about a trip: its driver by default, in the vehicle's depot; the driver's socket is not the reporter", async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const { driver } = await createDriver({ depot });
    // Staff see a trip through its route's depot.
    const route = (await pool.query<{ id: string }>('INSERT INTO trip.routes (name, depot_id) VALUES ($1, $2) RETURNING id', [`R ${randomUUID().slice(0, 6)}`, depot.id])).rows[0];
    const trip = await createTrip({ vehicle, driver, route_id: route.id });
    const { cookie } = await signIn(['depot_admin'], depot);

    const res = await api.post('/incidents', report({ vehicle_id: pub(vehicle), trip_id: pub(trip) }), cookie);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({ driver_id: pub(driver), depot_id: pub(depot) });
    expect((await publishedEvents('IncidentReported'))[0].payload).toMatchObject({ driver_id: pub(driver), reported_by_driver_id: null });
  });

  describe('refusals', () => {
    test('description and severity are required; status and the reporter are not writable; the lists are enums', async () => {
      const depot = await createDepot();
      const { cookie } = await driverWithLogin(depot);

      const missing = await api.post('/incidents', { description: '   ' }, cookie);
      expect(missing.status).toBe(400);
      expect(missing.body.error.details).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'description' }), expect.objectContaining({ field: 'severity' })]));

      const extra = await api.post('/incidents', report({ status: 'closed', reported_by: randomUUID() }), cookie);
      expect(extra.status).toBe(400);
      expect(extra.body.error.details).toEqual([
        { field: 'status', reason: 'not_writable' },
        { field: 'reported_by', reason: 'not_writable' },
      ]);

      for (const body of [report({ severity: 'urgent' }), report({ incident_type: 'meteor' })]) {
        const res = await api.post('/incidents', body, cookie);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_INVALID_ENUM');
      }
      expect(await incidentCount()).toBe(0);
    });

    test('a location is both coordinates, in range', async () => {
      const depot = await createDepot();
      const { cookie } = await driverWithLogin(depot);
      const half = await api.post('/incidents', report({ latitude: 9.01 }), cookie);
      expect(half.status).toBe(400);
      expect(half.body.error.details).toEqual([expect.objectContaining({ field: 'longitude', reason: 'location_incomplete' })]);
      expect((await api.post('/incidents', report({ latitude: 91, longitude: 38 }), cookie)).status).toBe(400);
    });

    test('occurred_at is neither in the future nor more than 30 days ago (5 minutes of clock drift allowed)', async () => {
      const depot = await createDepot();
      const { cookie } = await driverWithLogin(depot);
      const at = (ms: number) => new Date(Date.now() + ms).toISOString();

      const future = await api.post('/incidents', report({ occurred_at: at(10 * 60_000) }), cookie);
      expect(future.body.error.details).toEqual([{ field: 'occurred_at', reason: 'in_future' }]);
      const old = await api.post('/incidents', report({ occurred_at: at(-31 * 86_400_000) }), cookie);
      expect(old.body.error.details).toEqual([{ field: 'occurred_at', reason: 'too_old' }]);
      expect((await api.post('/incidents', report({ occurred_at: at(2 * 60_000) }), cookie)).status).toBe(201);
      expect((await api.post('/incidents', report({ occurred_at: at(-29 * 86_400_000) }), cookie)).status).toBe(201);
    });

    test("another depot's vehicle, a retired one, someone else's trip, a trip of another vehicle, another driver", async () => {
      const depot = await createDepot();
      const vehicle = await createVehicle({ depot });
      const elsewhere = await createVehicle({ depot: await createDepot() });
      const retired = await createVehicle({ depot, is_active: false, status: 'retired' });
      const { driver, cookie } = await driverWithLogin(depot);
      const { driver: colleague } = await createDriver({ depot });
      const othersTrip = await createTrip({ vehicle, driver: colleague });
      const mine = await createTrip({ vehicle: await createVehicle({ depot }), driver, scheduled_start: '2031-05-01T08:00:00Z', scheduled_end: '2031-05-01T10:00:00Z' });

      const cases: [Record<string, unknown>, { field: string; reason: string }][] = [
        [{ vehicle_id: pub(elsewhere) }, { field: 'vehicle_id', reason: 'references_missing_record' }],
        [{ vehicle_id: randomUUID() }, { field: 'vehicle_id', reason: 'references_missing_record' }],
        [{ vehicle_id: pub(retired) }, { field: 'vehicle_id', reason: 'vehicle_retired' }],
        [{ trip_id: pub(othersTrip) }, { field: 'trip_id', reason: 'references_missing_record' }],
        [{ vehicle_id: pub(vehicle), trip_id: pub(mine) }, { field: 'trip_id', reason: 'trip_vehicle_mismatch' }],
        [{ driver_id: pub(colleague) }, { field: 'driver_id', reason: 'not_writable' }],
      ];
      for (const [extra, detail] of cases) {
        const res = await api.post('/incidents', report({ severity: 'critical', ...extra }), cookie);
        expect(res.status, JSON.stringify(extra)).toBe(400);
        expect(res.body.error.details).toEqual([detail]);
      }
      expect((await api.post('/incidents', report({ driver_id: pub(driver) }), cookie)).status).toBe(201);
      expect(await flagOf(vehicle)).toBe(false);
      expect(await incidentCount()).toBe(1);
    });

    test('incident:write to report, incident:read to read', async () => {
      const depot = await createDepot();
      const dispatcher = await signIn(['dispatcher'], depot);
      const technician = await signIn(['technician'], depot);
      const clerk = await signIn(['finance_clerk'], depot);
      expect((await api.post('/incidents', report(), dispatcher.cookie)).status).toBe(403);
      expect((await api.post('/incidents', report(), technician.cookie)).status).toBe(201);
      expect((await api.get('/incidents', dispatcher.cookie)).status).toBe(200);
      expect((await api.get('/incidents', clerk.cookie)).status).toBe(403);
      expect((await request(app).get('/api/v1/incidents')).status).toBe(401);
    });
  });

  describe('offline submissions', () => {
    test('a retry with the same Idempotency-Key replays the original: one row, one event', async () => {
      const depot = await createDepot();
      const { cookie } = await driverWithLogin(depot);
      const key = `incident-${randomUUID()}`;
      const body = report({ occurred_at: new Date(Date.now() - 60_000).toISOString() });

      const first = await api.post('/incidents', body, cookie, key);
      const retry = await api.post('/incidents', body, cookie, key);
      expect(first.status).toBe(201);
      expect(retry.status).toBe(201);
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(retry.body.data).toEqual(first.body.data);
      expect(await incidentCount()).toBe(1);
      expect(await publishedEvents('IncidentReported')).toHaveLength(1);
    });

    test('after the key expired, the same report (same moment, same words) answers 200 with the original; another one is recorded', async () => {
      const depot = await createDepot();
      const vehicle = await createVehicle({ depot });
      const { cookie } = await driverWithLogin(depot);
      const other = await driverWithLogin(depot);
      const body = report({ severity: 'critical', vehicle_id: pub(vehicle), occurred_at: new Date(Date.now() - 2 * 86_400_000).toISOString() });

      const first = await api.post('/incidents', body, cookie, `incident-${randomUUID()}`);
      const late = await api.post('/incidents', body, cookie, `incident-${randomUUID()}`);
      expect(late.status).toBe(200);
      expect(late.body.meta.created).toBe(false);
      expect(late.body.data).toEqual(first.body.data);
      expect(await publishedEvents('IncidentReported')).toHaveLength(1);

      expect((await api.post('/incidents', { ...body, description: 'A second thing happened.' }, cookie)).status).toBe(201);
      expect((await api.post('/incidents', body, other.cookie)).status).toBe(201);
      expect(await incidentCount()).toBe(3);
    });
  });
});

describe('GET /incidents', () => {
  test("a driver's list holds only what they reported, newest first; anyone else's by id is 404", async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const me = await driverWithLogin(depot);
    const colleague = await driverWithLogin(depot);
    const staff = await signIn(['depot_admin'], depot);

    const older = await api.post('/incidents', report({ occurred_at: new Date(Date.now() - 3_600_000).toISOString() }), me.cookie);
    const newer = await api.post('/incidents', report({ vehicle_id: pub(vehicle) }), me.cookie);
    const theirs = await api.post('/incidents', report(), colleague.cookie);
    // About my trip's vehicle and naming me, but reported by staff: not mine to list.
    const aboutMe = await api.post('/incidents', report({ vehicle_id: pub(vehicle), driver_id: pub(me.driver) }), staff.cookie);
    expect(aboutMe.body.data.driver_id).toBe(pub(me.driver));

    const list = await api.get('/incidents', me.cookie);
    expect(list.status).toBe(200);
    expect(ids(list)).toEqual([newer.body.data.id, older.body.data.id]);
    expect(list.body.meta).toMatchObject({ page: 1, total_items: 2, total_pages: 1 });
    expect((await api.get(`/incidents/${older.body.data.id}`, me.cookie)).body.data).toEqual(older.body.data);
    for (const id of [theirs.body.data.id, aboutMe.body.data.id, randomUUID(), 'not-a-uuid']) {
      expect((await api.get(`/incidents/${id}`, me.cookie)).status, id).toBe(404);
    }
  });

  test("staff see their depot's incidents; those who see every depot see all, an incident with no depot too", async () => {
    const depot = await createDepot();
    const otherDepot = await createDepot();
    const reporter = await createUser({ roles: ['driver'], depot });
    const here = await insertIncident(reporter, { depot_id: depot.id });
    const there = await insertIncident(reporter, { depot_id: otherDepot.id });
    const nowhere = await insertIncident(reporter, { depot_id: null });

    const dispatcher = await signIn(['dispatcher'], depot);
    expect(ids(await api.get('/incidents', dispatcher.cookie))).toEqual([here.public_id]);
    expect((await api.get(`/incidents/${there.public_id}`, dispatcher.cookie)).status).toBe(404);

    const manager = await signIn(['fleet_manager']);
    expect(ids(await api.get('/incidents?page_size=100', manager.cookie))).toEqual(expect.arrayContaining([here.public_id, there.public_id, nowhere.public_id]));
  });

  test('filters: status, severity, incident_type, vehicle_id, from and to; bad values are refused', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const reporter = await createUser({ roles: ['driver'], depot });
    const { cookie } = await signIn(['dispatcher'], depot);
    const at = (iso: string) => ({ depot_id: depot.id, occurred_at: iso });
    const a = await insertIncident(reporter, { ...at('2026-10-20T09:00:00Z'), severity: 'critical', incident_type: 'accident', vehicle_id: vehicle.id });
    const b = await insertIncident(reporter, { ...at('2026-10-21T09:00:00Z'), severity: 'low', incident_type: 'tyre', status: 'resolved', resolved_at: '2026-10-21T10:00:00Z' });
    const c = await insertIncident(reporter, { ...at('2026-10-22T09:00:00Z'), severity: 'high', incident_type: 'accident' });

    const q = async (query: string) => ids(await api.get(`/incidents?${query}`, cookie));
    expect(await q('')).toEqual([c.public_id, b.public_id, a.public_id]);
    expect(await q('severity=critical,high')).toEqual([c.public_id, a.public_id]);
    expect(await q('status=resolved')).toEqual([b.public_id]);
    expect(await q('incident_type=accident')).toEqual([c.public_id, a.public_id]);
    expect(await q(`vehicle_id=${pub(vehicle)}`)).toEqual([a.public_id]);
    expect(await q(`vehicle_id=${randomUUID()}`)).toEqual([]);
    expect(await q('from=2026-10-21&to=2026-10-21')).toEqual([b.public_id]);
    expect(await q('page=2&page_size=2')).toEqual([a.public_id]);

    for (const bad of ['severity=urgent', 'status=open,lost', 'incident_type=meteor', 'vehicle_id=1', 'sort=priority']) {
      expect((await api.get(`/incidents?${bad}`, cookie)).status, bad).toBe(400);
    }
  });
});

describe('PATCH /incidents/{id} (FMS-89)', () => {
  async function scene() {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const { user: reporter, driver, cookie: driverCookie } = await driverWithLogin(depot);
    const incident = await insertIncident(reporter, { depot_id: depot.id, vehicle_id: vehicle.id, driver_id: driver.id, severity: 'high' });
    const dispatcher = await signIn(['dispatcher'], depot);
    return { depot, vehicle, driver, incident, dispatcher, driverCookie };
  }
  const path = (incident: { public_id: string }) => `/incidents/${incident.public_id}`;
  const stored = async (incident: { id: string }) => (await pool.query('SELECT status FROM alert.incident_reports WHERE id = $1', [incident.id])).rows[0].status as string;

  test('a dispatcher takes it on: investigating, assigned to themselves, one audited row, IncidentUpdated without the notes', async () => {
    const { depot, driver, incident, dispatcher } = await scene();
    const res = await api.patch(path(incident), { status: 'investigating', assigned_to: pub(dispatcher.user), notes: 'Calling the driver.' }, dispatcher.cookie);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: incident.public_id,
      status: 'investigating',
      assigned_to: { id: pub(dispatcher.user), full_name: dispatcher.user.full_name },
      notes: 'Calling the driver.',
      resolved_at: null,
      resolved_by: null,
    });
    expect(await auditRows(res)).toEqual(['UPDATE alert.incident_reports']);
    const [event, ...rest] = await publishedEvents('IncidentUpdated');
    expect(rest).toEqual([]);
    expect(event.payload).toMatchObject({
      incident_id: incident.public_id,
      depot_id: pub(depot),
      status: 'investigating',
      previous_status: 'open',
      assigned_to: pub(dispatcher.user),
      changes: ['status', 'assigned_to', 'notes'],
      // The driver reported it about themselves: their socket hears of it too.
      reported_by_driver_id: pub(driver),
    });
    expect(event.payload).not.toHaveProperty('notes');
  });

  test('resolving needs notes; it records when and by whom; reopening clears that; closing is final', async () => {
    const { incident, dispatcher } = await scene();

    const bare = await api.patch(path(incident), { status: 'resolved' }, dispatcher.cookie);
    expect(bare.status).toBe(400);
    expect(bare.body.error.details).toEqual([expect.objectContaining({ field: 'notes', reason: 'required' })]);
    expect(await stored(incident)).toBe('open');

    const resolved = await api.patch(path(incident), { status: 'resolved', notes: 'Bumper replaced, driver unhurt.' }, dispatcher.cookie);
    expect(resolved.status).toBe(200);
    expect(resolved.body.data).toMatchObject({ status: 'resolved', resolved_by: pub(dispatcher.user) });
    expect(resolved.body.data.resolved_at).not.toBeNull();

    const reopened = await api.patch(path(incident), { status: 'investigating' }, dispatcher.cookie);
    expect(reopened.body.data).toMatchObject({ status: 'investigating', resolved_at: null, resolved_by: null, notes: 'Bumper replaced, driver unhurt.' });

    // The notes kept from before are enough to close.
    expect((await api.patch(path(incident), { status: 'closed' }, dispatcher.cookie)).body.data).toMatchObject({ status: 'closed', resolved_by: pub(dispatcher.user) });
    for (const body of [{ status: 'investigating' }, { notes: 'One more thing.' }, { assigned_to: null }]) {
      const res = await api.patch(path(incident), body, dispatcher.cookie);
      expect(res.status, JSON.stringify(body)).toBe(409);
      expect(res.body.error).toMatchObject({ code: 'CONFLICT_INVALID_STATE_TRANSITION', details: [{ field: 'status', reason: 'incident_closed' }] });
    }
    expect((await publishedEvents('IncidentUpdated')).map((e) => e.payload.status)).toEqual(['resolved', 'investigating', 'closed']);
  });

  test('a transition that is not allowed is 409; a request that changes nothing writes and publishes nothing', async () => {
    const { incident, dispatcher } = await scene();
    expect((await api.patch(path(incident), { status: 'investigating' }, dispatcher.cookie)).status).toBe(200);

    const back = await api.patch(path(incident), { status: 'open' }, dispatcher.cookie);
    expect(back.status).toBe(409);
    expect(back.body.error.details).toEqual([{ field: 'status', reason: 'incident_investigating' }]);

    const same = await api.patch(path(incident), { status: 'investigating', notes: '' }, dispatcher.cookie);
    expect(same.status).toBe(200);
    expect(await auditRows(same)).toEqual([]);
    expect(await publishedEvents('IncidentUpdated')).toHaveLength(1);
  });

  test('the assignee: someone who handles incidents in its depot, or sees every depot; anyone else is 400', async () => {
    const { depot, incident, dispatcher } = await scene();
    const colleague = await createUser({ roles: ['depot_admin'], depot });
    const manager = await createUser({ roles: ['fleet_manager'] });
    const elsewhere = await createUser({ roles: ['dispatcher'], depot: await createDepot() });
    const technician = await createUser({ roles: ['technician'], depot });
    const gone = await createUser({ roles: ['dispatcher'], depot, status: 'inactive' });

    expect((await api.patch(path(incident), { assigned_to: pub(colleague) }, dispatcher.cookie)).body.data.assigned_to.id).toBe(pub(colleague));
    expect((await api.patch(path(incident), { assigned_to: pub(manager) }, dispatcher.cookie)).body.data.assigned_to.id).toBe(pub(manager));
    for (const who of [elsewhere, technician, gone, { public_id: randomUUID() }]) {
      const res = await api.patch(path(incident), { assigned_to: pub(who) }, dispatcher.cookie);
      expect(res.status).toBe(400);
      expect(res.body.error.details).toEqual([expect.objectContaining({ field: 'assigned_to', reason: 'references_missing_record' })]);
    }
    expect((await api.patch(path(incident), { assigned_to: null }, dispatcher.cookie)).body.data.assigned_to).toBeNull();
  });

  test("a driver reports but does not handle (403, even their own); another depot's incident is 404; bad bodies are 400", async () => {
    const { incident, dispatcher, driverCookie } = await scene();
    const driverRes = await api.patch(path(incident), { status: 'closed', notes: 'Fine now.' }, driverCookie);
    expect(driverRes.status).toBe(403);
    expect(driverRes.body.error.code).toBe('FORBIDDEN_INSUFFICIENT_ROLE');

    const other = await signIn(['dispatcher'], await createDepot());
    expect((await api.patch(path(incident), { status: 'investigating' }, other.cookie)).status).toBe(404);
    expect((await api.patch(`/incidents/${randomUUID()}`, { status: 'investigating' }, dispatcher.cookie)).status).toBe(404);

    for (const body of [{}, { status: 'lost' }, { assigned_to: 'me' }, { notes: 'x'.repeat(4001) }, { severity: 'low' }]) {
      expect((await api.patch(path(incident), body, dispatcher.cookie)).status, JSON.stringify(body)).toBe(400);
    }
    expect(await stored(incident)).toBe('open');
  });

  test('GET /incidents/{id} carries the handling fields', async () => {
    const { incident, dispatcher } = await scene();
    await api.patch(path(incident), { assigned_to: pub(dispatcher.user) }, dispatcher.cookie);
    const res = await api.get(path(incident), dispatcher.cookie);
    expect(res.body.data).toMatchObject({ assigned_to: { id: pub(dispatcher.user) }, notes: null, resolved_at: null, resolved_by: null });
    expect(res.body.data.updated_at).toEqual(expect.any(String));
  });
});

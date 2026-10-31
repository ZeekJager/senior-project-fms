import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { serviceDueJob } from '../../src/modules/maintenance';
import { createDepot, createUser, createVehicle, type RoleName } from '../support/factories';
import { deliverEvents, publishedEvents } from '../support/events';

// Preventive service programs (FMS-129): intervals by distance, time and engine hours, whichever comes
// first; each vehicle's service due under them; ServiceDue and ServiceOverdue once per move; a completed
// preventive repair for the program starting the count again; the dispatch board's warning.

const app = createApp();
const PASSWORD = 'Service-Programs-Test-1';

type Row = Record<string, unknown> & { id: string; public_id: string };
type Depot = Awaited<ReturnType<typeof createDepot>>;

async function signIn(roles: RoleName[], depot: Depot | null = null): Promise<string> {
  const user = await createUser({ roles, depot, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

const api = {
  get: (path: string, cookie: string) => request(app).get(`/api/v1${path}`).set('Cookie', cookie),
  post: (path: string, body: object, cookie: string) => request(app).post(`/api/v1${path}`).set('Cookie', cookie).send(body),
  patch: (path: string, body: object, cookie: string) => request(app).patch(`/api/v1${path}`).set('Cookie', cookie).send(body),
};

const runJob = () => serviceDueJob.run({ now: new Date(), correlationId: randomUUID(), runKey: new Date().toISOString().slice(0, 10) });
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);

/** A vehicle registered `daysOld` days ago at `km`: what a program counts from when no service is on record. */
async function vehicle(depot: Depot, km = 0, daysOld = 1, overrides: Record<string, unknown> = {}): Promise<Row> {
  return (await createVehicle({ depot, odometer_km: km, created_at: daysAgo(daysOld), ...overrides })) as Row;
}

const drive = (v: Row, km: number) => pool.query('UPDATE fleet.vehicles SET odometer_km = $2 WHERE id = $1', [v.id, km]);

/** An engine-hours reading as the nightly job records it (FMS-126). */
const engineHours = (v: Row, hours: number, at = daysAgo(1)) =>
  pool.query(
    `INSERT INTO fleet.meter_readings (vehicle_id, meter, value, source, source_ref, recorded_at)
     VALUES ($1, 'engine_hours', $2, 'gps_derived', $3, $4)`,
    [v.id, hours, at.toISOString().slice(0, 10), at],
  );

async function program(cookie: string, body: object): Promise<Record<string, unknown> & { id: string }> {
  const res = await api.post('/service-programs', body, cookie);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data;
}

type DueRow = Record<string, unknown> & { program: { id: string; name: string }; status: string };

async function dueOf(v: Row, cookie: string): Promise<DueRow[]> {
  const res = await api.get(`/vehicles/${v.public_id}/service-due`, cookie);
  expect(res.status).toBe(200);
  return res.body.data;
}

describe('service due: whichever comes first', () => {
  test('a vehicle at 9,600 km on a 10,000 km program with a 500 km lead window is due', async () => {
    const depot = await createDepot();
    const manager = await signIn(['fleet_manager'], depot);
    const truck = await vehicle(depot, 0);
    const created = await program(manager, { name: 'A-service', interval_km: 10_000, lead_km: 500, tasks: ['Engine oil', 'Oil filter'] });
    expect(created).toMatchObject({ depot_id: null, interval_km: 10_000, lead_km: 500, interval_days: null, tasks: ['Engine oil', 'Oil filter'] });

    // Computed on creation: far from it.
    expect(await dueOf(truck, manager)).toMatchObject([{ program: { id: created.id, name: 'A-service' }, status: 'upcoming', next_due: { odometer_km: 10_000 } }]);

    await drive(truck, 9600);
    await runJob();
    const [due] = await dueOf(truck, manager);
    expect(due).toMatchObject({
      status: 'due',
      due_by: ['km'],
      last_service: null,
      since: { odometer_km: 0 },
      next_due: { odometer_km: 10_000, at: null, engine_hours: null },
      readings: { odometer_km: 9600 },
      remaining: { km: 400 },
    });
    // The list shows due and overdue by default, in the caller's depots.
    const list = await api.get(`/service-due?depot_id=${depot.public_id}`, manager);
    expect(list.body.data.map((d: { vehicle_id: string }) => d.vehicle_id)).toEqual([truck.public_id]);
  });

  test('by time and by engine hours too; a vehicle without engine-hour readings is not judged on them', async () => {
    const depot = await createDepot();
    const manager = await signIn(['fleet_manager'], depot);
    const old = await vehicle(depot, 1000, 95);
    const recent = await vehicle(depot, 1000, 86);
    const fresh = await vehicle(depot, 1000, 10);
    const worked = await vehicle(depot, 1000, 10);
    await engineHours(worked, 240);
    const quarterly = await program(manager, { name: 'Quarterly', depot_id: depot.public_id, interval_days: 90, lead_days: 7 });
    const hours = await program(manager, { name: 'Hours', depot_id: depot.public_id, interval_engine_hours: 250 });
    expect(hours).toMatchObject({ interval_engine_hours: 250, lead_engine_hours: 25 });

    const status = async (v: Row, p: { id: string }) => (await dueOf(v, manager)).find((d) => d.program.id === p.id);
    expect(await status(old, quarterly)).toMatchObject({ status: 'overdue', due_by: ['days'] });
    expect(await status(recent, quarterly)).toMatchObject({ status: 'due', due_by: ['days'], remaining: { days: 3 } });
    expect(await status(fresh, quarterly)).toMatchObject({ status: 'upcoming' });
    expect(await status(worked, hours)).toMatchObject({ status: 'due', due_by: ['engine_hours'], next_due: { engine_hours: 250 }, readings: { engine_hours: 240 } });
    expect(await status(fresh, hours)).toMatchObject({ status: 'upcoming', next_due: { engine_hours: null }, readings: { engine_hours: null } });

    // A program names what it applies to: a van program leaves the trucks alone.
    await program(manager, { name: 'Vans', depot_id: depot.public_id, vehicle_type: 'van', interval_km: 5000 });
    expect((await dueOf(old, manager)).map((d) => d.program.name).sort()).toEqual(['Hours', 'Quarterly']);
  });
});

describe('ServiceDue and ServiceOverdue, once per move', () => {
  test('each move publishes once; due then overdue is one alert raised to high', async () => {
    const depot = await createDepot();
    const manager = await signIn(['fleet_manager'], depot);
    const truck = await vehicle(depot, 9600);
    const p = await program(manager, { name: 'B-service', interval_km: 10_000, lead_km: 500 });
    await runJob();
    await runJob();
    const due = await publishedEvents('ServiceDue');
    expect(due.map((e) => e.payload)).toEqual([
      expect.objectContaining({
        vehicle_id: truck.public_id,
        depot_id: depot.public_id,
        program_id: p.id,
        program_name: 'B-service',
        status: 'due',
        previous_status: null,
        due_by: ['km'],
        next_due_km: 10_000,
        odometer_km: 9600,
      }),
    ]);
    expect(due[0].aggregate).toBe(`vehicle:${truck.public_id}`);

    await drive(truck, 10_050);
    await runJob();
    await runJob();
    expect((await publishedEvents('ServiceOverdue')).map((e) => e.payload)).toEqual([
      expect.objectContaining({ vehicle_id: truck.public_id, status: 'overdue', previous_status: 'due', odometer_km: 10_050 }),
    ]);

    await deliverEvents();
    const alerts = await pool.query<{ alert_type: string; severity: string; occurrence_count: number; title: string }>(
      `SELECT alert_type, severity, occurrence_count, title FROM alert.alerts WHERE vehicle_id = $1`,
      [truck.id],
    );
    expect(alerts.rows).toEqual([{ alert_type: 'service_due', severity: 'high', occurrence_count: 2, title: `B-service overdue: ${truck.registration_number}` }]);
  });
});

describe('completing a preventive repair for the program starts its count again', () => {
  test('the repair carries the program; on completion the vehicle is upcoming from the repair', async () => {
    const depot = await createDepot();
    const manager = await signIn(['fleet_manager'], depot);
    const tech = await signIn(['technician'], depot);
    const truck = await vehicle(depot, 10_200);
    const bus = await vehicle(depot, 500, 1, { vehicle_type: 'bus' });
    const p = await program(manager, { name: 'C-service', depot_id: depot.public_id, vehicle_type: 'truck', interval_km: 10_000, lead_km: 500 });
    expect((await dueOf(truck, tech))[0]).toMatchObject({ status: 'overdue' });

    const repair = { vehicle_id: truck.public_id, description: 'C-service', labour_hours: 2, total_cost_cents: 50_000 };
    // Only preventive work carries out a program, and only one that applies to the vehicle.
    const corrective = await api.post('/maintenance', { ...repair, maintenance_type: 'corrective', service_program_id: p.id }, tech);
    expect(corrective.status).toBe(400);
    expect(corrective.body.error.details).toEqual([{ field: 'service_program_id', reason: 'needs_preventive' }]);
    const elsewhere = await api.post('/maintenance', { ...repair, vehicle_id: bus.public_id, maintenance_type: 'preventive', service_program_id: p.id }, tech);
    expect(elsewhere.body.error.details).toEqual([{ field: 'service_program_id', reason: 'program_not_applicable' }]);

    const booked = await api.post('/maintenance', { ...repair, maintenance_type: 'preventive', service_program_id: p.id, odometer_km: 10_200 }, tech);
    expect(booked.status).toBe(201);
    expect(booked.body.data.service_program).toEqual({ id: p.id, name: 'C-service' });
    // Booked, not yet done: still overdue, with the work showing.
    expect((await dueOf(truck, tech))[0]).toMatchObject({ status: 'overdue', open_record: { id: booked.body.data.id, status: 'open' } });

    const done = await api.post(`/maintenance-records/${booked.body.data.id}/complete`, {}, tech);
    expect(done.status).toBe(200);
    const [after] = await dueOf(truck, tech);
    expect(after).toMatchObject({
      status: 'upcoming',
      due_by: [],
      last_service: { maintenance_record_id: booked.body.data.id },
      since: { odometer_km: 10_200 },
      next_due: { odometer_km: 20_200 },
      open_record: null,
    });
    // The nightly run agrees: it counts from the repair too.
    await runJob();
    expect((await dueOf(truck, tech))[0]).toMatchObject({ status: 'upcoming', next_due: { odometer_km: 20_200 } });
  });
});

describe('programs: who defines them, and where', () => {
  test('a depot admin defines their depot’s programs, not fleet-wide ones; a technician defines none', async () => {
    const depot = await createDepot();
    const other = await createDepot();
    const manager = await signIn(['fleet_manager'], depot);
    const admin = await signIn(['depot_admin'], depot);
    const otherAdmin = await signIn(['depot_admin'], other);
    const tech = await signIn(['technician'], depot);

    const fleetWide = await program(manager, { name: 'Fleet A', interval_km: 10_000 });
    const own = await program(admin, { name: 'Depot A', interval_days: 180 });
    expect(own).toMatchObject({ depot_id: depot.public_id, lead_days: 18 });
    await program(otherAdmin, { name: 'Other A', interval_days: 180 });

    expect((await api.post('/service-programs', { name: 'Fleet B', depot_id: null, interval_km: 5000 }, admin)).body.error.details).toEqual([
      { field: 'depot_id', reason: 'fleet_wide_not_allowed' },
    ]);
    expect((await api.patch(`/service-programs/${fleetWide.id}`, { interval_km: 8000 }, admin)).status).toBe(403);
    expect((await api.post('/service-programs', { name: 'Tech A', interval_km: 5000 }, tech)).status).toBe(403);
    // Another depot's program is not there for them.
    const names = (await api.get('/service-programs', admin)).body.data.map((p: { name: string }) => p.name);
    expect(names).toContain('Fleet A');
    expect(names).toContain('Depot A');
    expect(names).not.toContain('Other A');
    expect((await api.get(`/service-programs/${own.id}`, otherAdmin)).status).toBe(404);
  });

  test('the editor’s rules: an interval, leads below them, a make with a model, one active name; retiring takes its vehicles off', async () => {
    const depot = await createDepot();
    const manager = await signIn(['fleet_manager'], depot);
    const truck = await vehicle(depot, 9800);
    const details = async (body: object) => (await api.post('/service-programs', body, manager)).body.error?.details;
    expect(await details({ name: 'X' })).toEqual([{ field: 'interval_km', reason: 'interval_required' }]);
    expect(await details({ name: 'X', interval_km: 1000, lead_km: 1000 })).toEqual([{ field: 'lead_km', reason: 'not_below_interval' }]);
    expect(await details({ name: 'X', interval_days: 30, lead_km: 100 })).toEqual([{ field: 'lead_km', reason: 'interval_missing' }]);
    expect(await details({ name: 'X', interval_km: 1000, model: 'NPR' })).toEqual([{ field: 'make', reason: 'required' }]);
    expect(await details({ name: 'X', interval_km: 1000, tasks: ['Oil', 'oil'] })).toEqual([{ field: 'tasks', reason: 'duplicate_task' }]);

    const p = await program(manager, { name: 'D-service', depot_id: depot.public_id, interval_km: 10_000, lead_km: 500 });
    const dup = await api.post('/service-programs', { name: 'd-service', depot_id: depot.public_id, interval_km: 5000 }, manager);
    expect(dup.status).toBe(409);
    expect((await dueOf(truck, manager))[0]).toMatchObject({ status: 'due' });

    // Changing the interval computes its vehicles again; its lead stays while it still fits.
    const longer = await api.patch(`/service-programs/${p.id}`, { interval_km: 20_000 }, manager);
    expect(longer.body.data).toMatchObject({ interval_km: 20_000, lead_km: 500, version: 1 });
    expect((await dueOf(truck, manager))[0]).toMatchObject({ status: 'upcoming', next_due: { odometer_km: 20_000 } });

    const retired = await api.patch(`/service-programs/${p.id}`, { is_active: false }, manager);
    expect(retired.body.data.is_active).toBe(false);
    expect(await dueOf(truck, manager)).toEqual([]);
    expect((await api.get('/service-programs?status=retired', manager)).body.data.map((r: { id: string }) => r.id)).toContain(p.id);
    // A stale version is refused.
    const stale = await request(app).patch(`/api/v1/service-programs/${p.id}`).set('Cookie', manager).set('If-Match', '"1"').send({ is_active: true });
    expect(stale.status).toBe(409);
  });
});

describe('the dispatch board warns on an overdue vehicle', () => {
  test('its card says which program, without blocking it', async () => {
    const depot = await createDepot();
    const manager = await signIn(['fleet_manager'], depot);
    const dispatcher = await signIn(['dispatcher'], depot);
    const late = await vehicle(depot, 12_000);
    const fine = await vehicle(depot, 100);
    const p = await program(manager, { name: 'E-service', interval_km: 10_000 });

    const res = await api.get(`/dispatch/availability?depot_id=${depot.public_id}`, dispatcher);
    expect(res.status).toBe(200);
    const card = (v: Row) => res.body.data.vehicles.find((x: { vehicle_id: string }) => x.vehicle_id === v.public_id);
    expect(card(late).service_due).toEqual({ status: 'overdue', programs: [{ program_id: p.id, name: 'E-service', status: 'overdue', due_by: ['km'] }] });
    expect(card(late).availability.availability).toBe('available');
    expect(card(fine).service_due).toBeNull();
  });
});

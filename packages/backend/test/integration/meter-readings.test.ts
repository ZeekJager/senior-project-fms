import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { fleetModule } from '../../src/modules/fleet';
import { gpsDevices, ignitionTime } from '../../src/modules/integration';
import { createDepot, createUser, createVehicle, type RoleName } from '../support/factories';
import { deliverEvents } from '../support/events';

// Odometer and engine-hour readings over time (FMS-126): from fuel logs, completed repairs, devices'
// pings and the nightly engine-hours job, with suspect readings kept but not followed.

const app = createApp();
const PASSWORD = 'Meter-Readings-Test-1';

type Row = Record<string, unknown> & { id: string; public_id: string };
const newVehicle = async (options: Parameters<typeof createVehicle>[0]) => (await createVehicle(options)) as Row;

async function signIn(roles: RoleName[], depot: Awaited<ReturnType<typeof createDepot>> | null = null): Promise<string> {
  const user = await createUser({ roles, depot, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

const api = {
  get: (path: string, cookie: string) => request(app).get(`/api/v1${path}`).set('Cookie', cookie),
  post: (path: string, body: object, cookie: string) => request(app).post(`/api/v1${path}`).set('Cookie', cookie).send(body),
  patch: (path: string, body: object, cookie: string) => request(app).patch(`/api/v1${path}`).set('Cookie', cookie).send(body),
  put: (path: string, body: object, cookie: string) => request(app).put(`/api/v1${path}`).set('Cookie', cookie).send(body),
};

/** Whole seconds, so a timestamp round-trips through PostgreSQL unchanged. */
const daysAgo = (days: number) => new Date(Math.floor((Date.now() - days * 86_400_000) / 1000) * 1000).toISOString();
const job = (name: string) => fleetModule.jobs!.find((j) => j.name === name)!;
const readModel = fleetModule.readModels!.find((m) => m.name === 'fleet.meter_readings')!;

async function readings(vehicle: Row, meter = 'odometer') {
  const res = await pool.query<{ value: number; source: string; source_ref: string | null; suspect: boolean; recorded_at: Date }>(
    `SELECT value::float8 AS value, source, source_ref, suspect, recorded_at FROM fleet.meter_readings
      WHERE vehicle_id = $1 AND meter = $2 ORDER BY recorded_at, id`,
    [vehicle.id, meter],
  );
  return res.rows;
}

const odometerOf = async (vehicle: Row) =>
  (await pool.query<{ km: number }>('SELECT odometer_km::float8 AS km FROM fleet.vehicles WHERE id = $1', [vehicle.id])).rows[0].km;

/** A completed repair on the vehicle at `at`, with this odometer if given. */
async function repair(vehicle: Row, at: string, cookie: string, odometer_km?: number): Promise<string> {
  const created = await api.post(
    '/maintenance',
    { vehicle_id: vehicle.public_id, description: 'Brake check', maintenance_type: 'preventive', labour_hours: 1, total_cost_cents: 10_000, ...(odometer_km !== undefined ? { odometer_km } : {}) },
    cookie,
  );
  expect(created.status).toBe(201);
  await pool.query('UPDATE maintenance.maintenance_records SET created_at = $2 WHERE public_id = $1', [created.body.data.id, new Date(Date.parse(at) - 3_600_000)]);
  expect((await api.put(`/maintenance/${created.body.data.id}`, { completed_at: at }, cookie)).status).toBe(200);
  return created.body.data.id as string;
}

/** A ping stored as ingestion stores it, at a local Addis Ababa time. */
async function storedPing(vehicle: Row, local: string, ignition: boolean | null, source = 'device') {
  await pool.query(
    `INSERT INTO tracking.gps_pings (vehicle_id, latitude, longitude, speed_kmh, ignition_on, source, recorded_at)
     VALUES ($1, 9.01, 38.76, 30, $2, $3, $4)`,
    [vehicle.id, ignition, source, new Date(`${local}+03:00`)],
  );
}

describe('a fuel log and a completed repair each add an odometer reading', () => {
  test('the fill-up and the repair are readings once delivered; the vehicle odometer follows the higher', async () => {
    const depot = await createDepot();
    const vehicle = await newVehicle({ depot, odometer_km: 10_000 });
    const manager = await signIn(['fleet_manager'], depot);
    const tech = await signIn(['technician'], depot);

    const [filledAt, repairedAt] = [daysAgo(3), daysAgo(2)];
    const fill = await api.post('/fuel-logs', { vehicle_id: vehicle.public_id, quantity_ml: 40_000, total_cost_cents: 300_000, odometer_km: 12_000.5, fueled_at: filledAt }, manager);
    expect(fill.status).toBe(201);
    const record = await repair(vehicle, repairedAt, tech, 12_480);
    // Not yet: readings come from the events, after commit.
    expect(await readings(vehicle)).toEqual([]);

    await deliverEvents();
    expect(await readings(vehicle)).toEqual([
      { value: 12_000.5, source: 'fuel_log', source_ref: fill.body.data.id, suspect: false, recorded_at: new Date(filledAt) },
      { value: 12_480, source: 'maintenance', source_ref: record, suspect: false, recorded_at: new Date(repairedAt) },
    ]);
    expect(await odometerOf(vehicle)).toBe(12_480);

    // A repair without an odometer reads nothing.
    await repair(vehicle, daysAgo(1), tech);
    await deliverEvents();
    expect(await readings(vehicle)).toHaveLength(2);
  });

  test('a reading lower than an earlier one is kept as suspect and does not lower the odometer', async () => {
    const depot = await createDepot();
    const vehicle = await newVehicle({ depot, odometer_km: 0 });
    const tech = await signIn(['technician'], depot);
    await repair(vehicle, '2026-09-01T10:00:00Z', tech, 50_000);
    await deliverEvents();
    // A typo: 5,000 for 50,500.
    await repair(vehicle, '2026-09-10T10:00:00Z', tech, 5_000);
    await deliverEvents();

    expect((await readings(vehicle)).map((r) => [r.value, r.suspect])).toEqual([
      [50_000, false],
      [5_000, true],
    ]);
    expect(await odometerOf(vehicle)).toBe(50_000);
    // Later readings are checked against the trusted one, not the suspect one.
    await repair(vehicle, '2026-09-20T10:00:00Z', tech, 50_900);
    await deliverEvents();
    expect((await readings(vehicle)).at(-1)).toMatchObject({ value: 50_900, suspect: false });
    expect(await odometerOf(vehicle)).toBe(50_900);
  });

  test('a redelivered event, and the sync, add nothing twice; the sync adds what an event missed', async () => {
    const depot = await createDepot();
    const vehicle = await newVehicle({ depot, odometer_km: 0 });
    const manager = await signIn(['fleet_manager'], depot);
    expect((await api.post('/fuel-logs', { vehicle_id: vehicle.public_id, quantity_ml: 40_000, total_cost_cents: 300_000, odometer_km: 8_000, fueled_at: daysAgo(3) }, manager)).status).toBe(201);
    await deliverEvents();
    expect(await readModel.rebuild()).toEqual({ added: 0 });

    // A fuel log written without its event (the seed, a restore).
    const direct = (at: string, km: number) =>
      pool.query<{ public_id: string }>(
        `INSERT INTO fuel.fuel_logs (vehicle_id, fuel_type, quantity_ml, total_cost_cents, odometer_km, source, recorded_at)
         VALUES ($1, 'diesel', 30000, 200000, $2, 'manual', $3) RETURNING public_id`,
        [vehicle.id, km, at],
      );
    const missed = await direct(daysAgo(2), 8_400);
    expect(await readModel.rebuild()).toEqual({ added: 1 });
    expect((await readings(vehicle)).at(-1)).toMatchObject({ value: 8_400, source: 'fuel_log', source_ref: missed.rows[0].public_id });
    expect(await readModel.rebuild()).toEqual({ added: 0 });

    // The daily job looks back 30 days only; the rebuild looks at everything.
    await direct(daysAgo(40), 7_000);
    const sync = () => job('meter-reading-sync').run({ now: new Date(), correlationId: randomUUID(), runKey: daysAgo(0).slice(0, 10) });
    expect(await sync()).toEqual({ added: 0 });
    expect(await readModel.rebuild()).toEqual({ added: 1 });
    expect((await readings(vehicle))[0]).toMatchObject({ value: 7_000, suspect: false });
  });
});

describe("a device's odometer, sampled", () => {
  test('one reading an hour per vehicle, from devices only; a lower one is suspect', async () => {
    const depot = await createDepot();
    const vehicle = await newVehicle({ depot, odometer_km: 20_000 });
    const { token } = await gpsDevices.register({ vehicleId: vehicle.public_id, identifier: `dev-${randomUUID().slice(0, 8)}` }, { userId: null, correlationId: randomUUID() });
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
    const send = (pings: object[]) => request(app).post('/api/v1/tracking/gps-pings').set('Authorization', `Bearer ${token}`).send({ pings });
    const p = (minutesAgo: number, odometer_km: number) => ({ recorded_at: at(minutesAgo), lat: 9.01, lng: 38.76, speed_kmh: 40, odometer_km });

    // The newest of the batch is the reading.
    expect((await send([p(150, 20_100), p(149, 20_101)])).status).toBe(202);
    // Within the hour: sampled out.
    await send([p(120, 20_140)]);
    await send([p(80, 20_190)]);
    expect((await readings(vehicle)).map((r) => [r.value, r.source])).toEqual([
      [20_101, 'telematics'],
      [20_190, 'telematics'],
    ]);
    expect(await odometerOf(vehicle)).toBe(20_190);
    expect((await readings(vehicle))[0].source_ref).toMatch(/^[0-9a-f-]{36}$/);

    // A device reporting a lower odometer an hour later: suspect, the vehicle keeps its odometer.
    await send([p(10, 19_000)]);
    expect((await readings(vehicle)).at(-1)).toMatchObject({ value: 19_000, suspect: true });
    expect(await odometerOf(vehicle)).toBe(20_190);
  });

  test('an odometer sent by a signed-in user, not a device, is not a reading', async () => {
    const depot = await createDepot();
    const vehicle = await newVehicle({ depot, odometer_km: 0 });
    const user = await signIn(['admin']);
    const res = await request(app)
      .post('/api/v1/tracking/gps-pings')
      .set('Cookie', user)
      .send({ pings: [{ vehicle_id: vehicle.public_id, recorded_at: new Date(Date.now() - 60_000).toISOString(), lat: 9, lng: 38.7, speed_kmh: 10, odometer_km: 99_999 }] });
    expect(res.status).toBe(202);
    expect(await readings(vehicle)).toEqual([]);
  });
});

describe('the nightly engine-hours job', () => {
  test('sums ignition-on time from device pings, skips a long gap, and phone-only vehicles get none', async () => {
    const depot = await createDepot();
    const truck = await newVehicle({ depot });
    const phoneOnly = await newVehicle({ depot });
    // 9 September (Addis Ababa): 08:00 to 08:18 on (18 min), then off.
    for (const [time, on] of [['08:00', true], ['08:06', true], ['08:12', true], ['08:18', false]] as const) await storedPing(truck, `2026-09-09T${time}:00`, on);
    // On at 09:00, then nothing until 12:00: the 3-hour gap says nothing. 12:00 to 12:06 counts.
    for (const [time, on] of [['09:00', true], ['12:00', true], ['12:06', false]] as const) await storedPing(truck, `2026-09-09T${time}:00`, on);
    // A device ping without ignition data, and a phone that says the ignition is on: neither counts.
    await storedPing(truck, '2026-09-09T08:03:00', null);
    for (const time of ['08:00', '08:05', '08:10']) await storedPing(phoneOnly, `2026-09-09T${time}:00`, true, 'phone');

    const run = (runKey: string) => job('engine-hours').run({ now: new Date(`${runKey}T01:00:00+03:00`), correlationId: randomUUID(), runKey });
    expect(await run('2026-09-10')).toEqual({ days: 7, readings: 1 });
    expect(await readings(truck, 'engine_hours')).toEqual([
      // 18 + 6 minutes = 0.4 h, at the end of the local day.
      { value: 0.4, source: 'gps_derived', source_ref: '2026-09-09', suspect: false, recorded_at: new Date('2026-09-10T00:00:00+03:00') },
    ]);
    expect(await readings(phoneOnly, 'engine_hours')).toEqual([]);

    // A re-run adds nothing; the next day adds to the total, and a day with the ignition off all day reads 0 more.
    expect(await run('2026-09-10')).toEqual({ days: 7, readings: 0 });
    for (const [time, on] of [['10:00', true], ['10:06', true], ['10:12', false]] as const) await storedPing(truck, `2026-09-10T${time}:00`, on);
    await storedPing(truck, '2026-09-11T10:00:00', false);
    expect(await run('2026-09-12')).toEqual({ days: 7, readings: 2 });
    expect((await readings(truck, 'engine_hours')).map((r) => [r.source_ref, r.value])).toEqual([
      ['2026-09-09', 0.4],
      ['2026-09-10', 0.6],
      ['2026-09-11', 0.6],
    ]);
  });

  test('an interval across midnight counts on each day only its own part', async () => {
    const depot = await createDepot();
    const truck = await newVehicle({ depot });
    await storedPing(truck, '2026-09-08T23:57:00', true);
    await storedPing(truck, '2026-09-09T00:03:00', true);
    await storedPing(truck, '2026-09-09T00:09:00', false);
    const [start8, start9, start10] = ['2026-09-08', '2026-09-09', '2026-09-10'].map((d) => new Date(`${d}T00:00:00+03:00`));
    expect((await ignitionTime.seconds(pool, start8, start9, 600)).get(String(truck.id))).toBe(180);
    expect((await ignitionTime.seconds(pool, start9, start10, 600)).get(String(truck.id))).toBe(540);
  });
});

describe('GET /vehicles/{vehicle_id}/meter-readings', () => {
  test('the history newest first, by meter and time, in depot scope', async () => {
    const depot = await createDepot();
    const manager = await signIn(['fleet_manager'], depot);
    const created = await api.post(
      '/vehicles',
      { registration_number: `AA-${randomUUID().slice(0, 6)}`, make: 'Isuzu', model: 'FSR', vehicle_type: 'truck', fuel_type: 'diesel', fuel_efficiency_ml_per_km: 300, depot_id: depot.public_id, odometer_km: 1_000 },
      manager,
    );
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;
    expect((await api.patch(`/vehicles/${id}`, { odometer_km: 1_500 }, manager)).status).toBe(200);
    const vehicle = (await pool.query<Row>('SELECT id, public_id FROM fleet.vehicles WHERE public_id = $1', [id])).rows[0];
    await pool.query(
      `INSERT INTO fleet.meter_readings (vehicle_id, meter, value, source, source_ref, recorded_at) VALUES ($1, 'engine_hours', 12.5, 'gps_derived', '2026-09-09', '2026-09-10T00:00:00+03:00')`,
      [vehicle.id],
    );

    const res = await api.get(`/vehicles/${id}/meter-readings`, manager);
    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ page: 1, total_items: 3 });
    expect(res.body.data.map((r: { meter: string; value: number; source: string }) => [r.meter, r.value, r.source])).toEqual([
      ['odometer', 1_500, 'manual'],
      ['odometer', 1_000, 'manual'],
      ['engine_hours', 12.5, 'gps_derived'],
    ]);
    expect(Object.keys(res.body.data[0]).sort()).toEqual(['created_at', 'id', 'meter', 'recorded_at', 'source', 'source_ref', 'suspect', 'value']);

    const hours = await api.get(`/vehicles/${id}/meter-readings?meter=engine_hours`, manager);
    expect(hours.body.data).toEqual([expect.objectContaining({ value: 12.5, source_ref: '2026-09-09', suspect: false, recorded_at: '2026-09-09T21:00:00.000Z' })]);
    const window = await api.get(`/vehicles/${id}/meter-readings?from=2026-09-01&to=2026-09-09`, manager);
    expect(window.body.data).toEqual([]);
    expect((await api.get(`/vehicles/${id}/meter-readings?from=2026-09-01&to=2026-09-10`, manager)).body.data).toHaveLength(1);
    expect((await api.get(`/vehicles/${id}/meter-readings?meter=fuel`, manager)).status).toBe(400);
  });

  test("another depot's vehicle or a bad id is 404; a role without vehicle:read is 403", async () => {
    const depot = await createDepot();
    const vehicle = await newVehicle({ depot });
    expect((await api.get(`/vehicles/${vehicle.public_id}/meter-readings`, await signIn(['technician'], await createDepot()))).status).toBe(404);
    expect((await api.get(`/vehicles/${randomUUID()}/meter-readings`, await signIn(['admin']))).status).toBe(404);
    expect((await api.get('/vehicles/not-a-uuid/meter-readings', await signIn(['admin']))).status).toBe(404);
    expect((await api.get(`/vehicles/${vehicle.public_id}/meter-readings`, await signIn(['finance_clerk'], depot))).status).toBe(403);
    expect((await api.get(`/vehicles/${vehicle.public_id}/meter-readings`, await signIn(['dispatcher'], depot))).status).toBe(200);
  });
});

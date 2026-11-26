import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { vehicleDepotOf } from '../../src/modules/fleet';
import { createDepot, createUser, createVehicle, type RoleName } from '../support/factories';

// FMS-99 (docs/ev.md#the-ev-dashboard): the EV dashboard's API. GET /ev/fleet lists the electric vehicles lowest
// charge first with the session charging each now; GET /ev/charging-sessions is the fleet's session history.

const app = createApp();
const PASSWORD = 'Ev-Test-1';

async function signIn(roles: RoleName[], depot: { id: string } | null = null): Promise<string> {
  const user = await createUser({ roles, depot, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

const post = (path: string, body: object, cookie: string) => request(app).post(`/api/v1${path}`).set('Cookie', cookie).send(body);
const get = (path: string, cookie: string) => request(app).get(`/api/v1${path}`).set('Cookie', cookie);
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

async function station(name: string) {
  return (
    await pool.query<{ public_id: string }>(
      "INSERT INTO ev.charging_stations (external_station_id, name, latitude, longitude, connector_type, power_kw) VALUES ($1, $2, 9.0, 38.76, 'CCS2', 60) RETURNING public_id",
      [`st-${Math.random()}`, name],
    )
  ).rows[0].public_id;
}

const log = (cookie: string, vehicleId: unknown, soc: number, at: string, source?: string) =>
  post('/ev/battery-logs', { vehicle_id: vehicleId, state_of_charge: soc, battery_health: 95, recorded_at: at, ...(source ? { source } : {}) }, cookie);

describe('GET /ev/fleet (FMS-99)', () => {
  test('lists the electric vehicles lowest charge first, no reading last, each with its newest reading and the session charging it', async () => {
    const depot = await createDepot();
    const full = await createVehicle({ depot, fuel_type: 'electric', vehicle_type: 'van' });
    const low = await createVehicle({ depot, fuel_type: 'electric', vehicle_type: 'van' });
    const unread = await createVehicle({ depot, fuel_type: 'electric', vehicle_type: 'van' });
    await createVehicle({ depot, fuel_type: 'diesel' });
    const cookie = await signIn(['fleet_manager']);

    // The newest reading counts, not the lowest: `full` was low yesterday and is charged now.
    expect((await log(cookie, full.public_id, 9, hoursAgo(30))).status).toBe(201);
    expect((await log(cookie, full.public_id, 84, hoursAgo(1))).status).toBe(201);
    expect((await log(cookie, low.public_id, 14, hoursAgo(2), 'synthetic')).status).toBe(201);
    const hub = await station('Bole charging hub');
    const charging = await post('/ev/charging-sessions', { vehicle_id: low.public_id, station_id: hub, status: 'in_progress', start_soc: 14 }, cookie);
    expect(charging.status, JSON.stringify(charging.body)).toBe(201);

    const res = await get(`/ev/fleet?depot_id=${depot.public_id}`, cookie);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.map((v: { vehicle_id: string }) => v.vehicle_id)).toEqual([low.public_id, full.public_id, unread.public_id]);
    expect(res.body.meta).toMatchObject({ count: 3, charging_now: 1 });
    const [first, second, third] = res.body.data;
    expect(first).toMatchObject({
      registration_number: low.registration_number,
      depot: { id: depot.public_id },
      latest: { state_of_charge: 14, battery_health: 95, source: 'synthetic' },
      charging: { id: charging.body.data.id, station: { id: hub, name: 'Bole charging hub' }, start_soc: 14, source: 'manual' },
    });
    expect(second).toMatchObject({ latest: { state_of_charge: 84, source: 'manual' }, charging: null });
    expect(third).toMatchObject({ latest: null, charging: null });
  });

  test('depot scope: a depot admin sees only their depot’s EVs; a technician holds no ev permission', async () => {
    const mine = await createDepot();
    const theirs = await createDepot();
    const ours = await createVehicle({ depot: mine, fuel_type: 'electric', vehicle_type: 'van' });
    await createVehicle({ depot: theirs, fuel_type: 'electric', vehicle_type: 'van' });
    const admin = await signIn(['depot_admin'], mine);
    const res = await get('/ev/fleet', admin);
    expect(res.status).toBe(200);
    expect(res.body.data.map((v: { vehicle_id: string }) => v.vehicle_id)).toEqual([ours.public_id]);
    // Another depot's id is not a way in: it lists nothing.
    expect((await get(`/ev/fleet?depot_id=${theirs.public_id}`, admin)).body.data).toEqual([]);
    expect((await get('/ev/fleet', await signIn(['technician']))).status).toBe(403);
    expect((await get('/ev/fleet?depot_id=nope', admin)).status).toBe(400);
  });
});

describe('GET /ev/charging-sessions (FMS-99)', () => {
  test('the fleet’s sessions newest first, by status, vehicle and start; another depot’s are not listed', async () => {
    const depot = await createDepot();
    const other = await createDepot();
    const a = await createVehicle({ depot, fuel_type: 'electric', vehicle_type: 'van' });
    const b = await createVehicle({ depot, fuel_type: 'electric', vehicle_type: 'van' });
    const away = await createVehicle({ depot: other, fuel_type: 'electric', vehicle_type: 'van' });
    const manager = await signIn(['fleet_manager']);
    const older = await post('/ev/charging-sessions', { vehicle_id: a.public_id, status: 'in_progress', started_at: hoursAgo(5) }, manager);
    const newer = await post('/ev/charging-sessions', { vehicle_id: b.public_id, status: 'in_progress', started_at: hoursAgo(1) }, manager);
    const planned = await post('/ev/charging-sessions', { vehicle_id: away.public_id }, manager);
    for (const r of [older, newer, planned]) expect(r.status, JSON.stringify(r.body)).toBe(201);

    const all = await get('/ev/charging-sessions?status=in_progress', manager);
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    const ids = all.body.data.map((s: { id: string }) => s.id);
    expect(ids.indexOf(newer.body.data.id)).toBeLessThan(ids.indexOf(older.body.data.id));
    expect(ids).not.toContain(planned.body.data.id);

    const one = await get(`/ev/charging-sessions?vehicle_id=${a.public_id}`, manager);
    expect(one.body.data.map((s: { id: string }) => s.id)).toEqual([older.body.data.id]);
    expect(one.body.meta).toMatchObject({ total_items: 1 });
    const recent = await get(`/ev/charging-sessions?from=${encodeURIComponent(hoursAgo(2))}&status=in_progress`, manager);
    expect(recent.body.data.map((s: { id: string }) => s.id)).toContain(newer.body.data.id);
    expect(recent.body.data.map((s: { id: string }) => s.id)).not.toContain(older.body.data.id);

    const admin = await signIn(['depot_admin'], depot);
    const scoped = await get('/ev/charging-sessions', admin);
    expect(scoped.body.data.map((s: { id: string }) => s.id).sort()).toEqual([older.body.data.id, newer.body.data.id].sort());
    expect((await get(`/ev/charging-sessions?vehicle_id=${away.public_id}`, admin)).body.data).toEqual([]);
  });
});

describe('the socket’s EV events (FMS-99)', () => {
  test('a vehicle’s depot is looked up by its public id, so its EV events reach that depot’s readers', async () => {
    const depot = await createDepot();
    const ev = await createVehicle({ depot, fuel_type: 'electric', vehicle_type: 'van' });
    expect(await vehicleDepotOf(String(ev.public_id))).toBe(depot.public_id);
    expect(await vehicleDepotOf('00000000-0000-4000-8000-000000000000')).toBeNull();
    expect(await vehicleDepotOf('not-a-uuid')).toBeNull();
  });
});

import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { EV_EVENTS } from '../../src/modules/ev';
import { publishedEvents } from '../support/events';
import { createDepot, createUser, createVehicle, type RoleName } from '../support/factories';

// FMS-96 (docs/ev.md): EV battery logs, charging stations and sessions, and the battery summary.

const app = createApp();
const PASSWORD = 'Ev-Test-1';

async function signIn(roles: RoleName[], depot: { id: string } | null = null): Promise<string> {
  const user = await createUser({ roles, depot, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

const post = (path: string, body: object, cookie: string) => request(app).post(`/api/v1${path}`).set('Cookie', cookie).send(body);
const patch = (path: string, body: object, cookie: string) => request(app).patch(`/api/v1${path}`).set('Cookie', cookie).send(body);
const get = (path: string, cookie: string) => request(app).get(`/api/v1${path}`).set('Cookie', cookie);
const daysAgo = (d: number, h = 9) => new Date(Date.now() - d * 86_400_000 - (Date.now() % 86_400_000) + h * 3_600_000).toISOString();

async function station(name = 'Bole charging hub') {
  return (
    await pool.query<{ public_id: string }>(
      "INSERT INTO ev.charging_stations (external_station_id, name, latitude, longitude, connector_type, power_kw) VALUES ($1, $2, 9.0, 38.76, 'CCS2', 60) RETURNING public_id",
      [`st-${Math.random()}`, name],
    )
  ).rows[0].public_id;
}

async function fleet() {
  const depot = await createDepot();
  const ev = await createVehicle({ depot, fuel_type: 'electric', vehicle_type: 'van' });
  const diesel = await createVehicle({ depot, fuel_type: 'diesel' });
  return { depot, ev, diesel };
}

describe('battery logs (FMS-96)', () => {
  test('an electric vehicle takes a battery log, audited and published; any other vehicle is refused', async () => {
    const { ev, diesel } = await fleet();
    const cookie = await signIn(['fleet_manager']);
    const logged = await post('/ev/battery-logs', { vehicle_id: ev.public_id, state_of_charge: 72.5, battery_health: 96, estimated_range_km: 180 }, cookie);
    expect(logged.status, JSON.stringify(logged.body)).toBe(201);
    expect(logged.body.data).toMatchObject({ vehicle_id: ev.public_id, registration_number: ev.registration_number, state_of_charge: 72.5, battery_health: 96, estimated_range_km: 180 });
    const [event] = await publishedEvents(EV_EVENTS.batteryLogged);
    expect(event.payload).toMatchObject({ battery_log_id: logged.body.data.id, vehicle_id: ev.public_id, state_of_charge: 72.5 });
    const audit = await pool.query("SELECT action FROM audit.audit_logs WHERE entity_type = 'ev.ev_battery_logs' AND correlation_id = $1", [logged.headers['x-request-id']]);
    expect(audit.rows.map((r) => r.action)).toEqual(['INSERT']);

    // The card's rule: only electric vehicles accept battery logs.
    const refused = await post('/ev/battery-logs', { vehicle_id: diesel.public_id, state_of_charge: 50 }, cookie);
    expect(refused.status).toBe(400);
    expect(refused.body.error.details).toEqual([{ field: 'vehicle_id', reason: 'not_electric' }]);
    expect((await post('/ev/battery-logs', { vehicle_id: ev.public_id, state_of_charge: 120 }, cookie)).status).toBe(400);

    const list = await get(`/ev/battery-logs?vehicle_id=${ev.public_id}`, cookie);
    expect(list.status).toBe(200);
    expect(list.body.data.map((l: { id: string }) => l.id)).toEqual([logged.body.data.id]);
  });

  test('depot scope: another depot cannot log or read this depot’s vehicle; a technician holds no ev permission', async () => {
    const { ev } = await fleet();
    const other = await createDepot();
    const outsider = await signIn(['depot_admin'], other);
    const hidden = await post('/ev/battery-logs', { vehicle_id: ev.public_id, state_of_charge: 50 }, outsider);
    expect(hidden.status).toBe(400);
    expect(hidden.body.error.details).toEqual([{ field: 'vehicle_id', reason: 'references_missing_record' }]);
    expect((await get(`/vehicles/${ev.public_id}/battery-summary`, outsider)).status).toBe(404);
    expect((await get(`/ev/battery-logs?vehicle_id=${ev.public_id}`, outsider)).body.data).toEqual([]);
    const tech = await signIn(['technician']);
    expect((await get('/ev/charging-stations', tech)).status).toBe(403);
  });
});

describe('charging sessions (FMS-96)', () => {
  test('planned → in_progress → completed, each move published; illegal moves are 409 with where it can go', async () => {
    const { ev } = await fleet();
    const stationId = await station();
    const cookie = await signIn(['fleet_manager']);
    const planned = await post('/ev/charging-sessions', { vehicle_id: ev.public_id, station_id: stationId, start_soc: 20 }, cookie);
    expect(planned.status, JSON.stringify(planned.body)).toBe(201);
    expect(planned.body.data).toMatchObject({ status: 'planned', allowed_transitions: ['in_progress', 'cancelled'], station: { id: stationId, name: 'Bole charging hub' }, started_at: null });
    const id = planned.body.data.id;

    // The card's rule: an illegal transition is 409.
    const skip = await patch(`/ev/charging-sessions/${id}`, { status: 'completed' }, cookie);
    expect(skip.status).toBe(409);
    expect(skip.body.error).toMatchObject({ code: 'CONFLICT_INVALID_STATE_TRANSITION', details: [{ field: 'status', reason: 'planned_to_completed', allowed_transitions: ['in_progress', 'cancelled'] }] });

    const started = await patch(`/ev/charging-sessions/${id}`, { status: 'in_progress' }, cookie);
    expect(started.status).toBe(200);
    expect(started.body.data.status).toBe('in_progress');
    expect(started.body.data.started_at).not.toBeNull();
    expect((await publishedEvents(EV_EVENTS.sessionStarted))[0].payload).toMatchObject({ charging_session_id: id });

    const done = await patch(`/ev/charging-sessions/${id}`, { status: 'completed', energy_kwh: 42.5, cost_cents: 212_500, end_soc: 88 }, cookie);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.data).toMatchObject({ status: 'completed', energy_kwh: 42.5, cost_cents: 212_500, end_soc: 88, allowed_transitions: [] });
    expect(done.body.data.ended_at).not.toBeNull();
    expect((await publishedEvents(EV_EVENTS.sessionCompleted))[0].payload).toMatchObject({ charging_session_id: id, energy_kwh: 42.5, end_soc: 88 });

    const after = await patch(`/ev/charging-sessions/${id}`, { energy_kwh: 50 }, cookie);
    expect(after.status).toBe(409);
    expect(after.body.error.details).toEqual([{ field: 'status', reason: 'completed', allowed_transitions: [] }]);
    // Money is whole cents: a fraction is refused before anything else.
    expect((await patch(`/ev/charging-sessions/${id}`, { cost_cents: 10.5 }, cookie)).status).toBe(400);

    const history = await get(`/vehicles/${ev.public_id}/charging-sessions`, cookie);
    expect(history.body.data.map((s: { id: string; status: string }) => [s.id, s.status])).toEqual([[id, 'completed']]);
  });

  test('a vehicle charges in one session at a time; cancelled and failed are final; only electric vehicles charge', async () => {
    const { ev, diesel } = await fleet();
    const cookie = await signIn(['fleet_manager']);
    const first = await post('/ev/charging-sessions', { vehicle_id: ev.public_id, status: 'in_progress' }, cookie);
    expect(first.status).toBe(201);
    const second = await post('/ev/charging-sessions', { vehicle_id: ev.public_id, status: 'in_progress' }, cookie);
    expect(second.status).toBe(409);
    expect(second.body.error).toMatchObject({ code: 'CONFLICT_VEHICLE_IN_USE', details: [{ field: 'vehicle_id', reason: 'already_charging', record_id: first.body.data.id }] });

    const failed = await patch(`/ev/charging-sessions/${first.body.data.id}`, { status: 'failed' }, cookie);
    expect(failed.body.data.status).toBe('failed');
    expect((await publishedEvents(EV_EVENTS.sessionFailed))[0].payload).toMatchObject({ charging_session_id: first.body.data.id });
    expect((await patch(`/ev/charging-sessions/${first.body.data.id}`, { status: 'in_progress' }, cookie)).status).toBe(409);

    const plan = await post('/ev/charging-sessions', { vehicle_id: ev.public_id }, cookie);
    expect((await patch(`/ev/charging-sessions/${plan.body.data.id}`, { status: 'cancelled' }, cookie)).body.data.status).toBe('cancelled');
    expect((await patch(`/ev/charging-sessions/${plan.body.data.id}`, { status: 'in_progress' }, cookie)).status).toBe(409);

    const notEv = await post('/ev/charging-sessions', { vehicle_id: diesel.public_id }, cookie);
    expect(notEv.status).toBe(400);
    expect(notEv.body.error.details).toEqual([{ field: 'vehicle_id', reason: 'not_electric' }]);
  });

  test('stations are listed for every ev:read holder', async () => {
    await station('Adama fast charger');
    const cookie = await signIn(['fleet_owner']);
    const list = await get('/ev/charging-stations?page_size=100', cookie);
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Adama fast charger', power_kw: 60, connector_type: 'CCS2' })]));
  });
});

describe('battery summary (FMS-96)', () => {
  test('returns the SoC trend by day, the health and its change, and the charging of the period', async () => {
    const { ev, diesel } = await fleet();
    const cookie = await signIn(['fleet_manager']);
    for (const [day, soc, health] of [
      [10, 90, 97.5],
      [10, 40, null],
      [5, 70, 97],
      [1, 55, 96.8],
    ] as const) {
      await post('/ev/battery-logs', { vehicle_id: ev.public_id, state_of_charge: soc, battery_health: health, recorded_at: daysAgo(day) }, cookie);
    }
    const s = await post('/ev/charging-sessions', { vehicle_id: ev.public_id, status: 'in_progress' }, cookie);
    await patch(`/ev/charging-sessions/${s.body.data.id}`, { status: 'completed', energy_kwh: 30, cost_cents: 150_000 }, cookie);

    const summary = await get(`/vehicles/${ev.public_id}/battery-summary?days=30`, cookie);
    expect(summary.status, JSON.stringify(summary.body)).toBe(200);
    const data = summary.body.data;
    expect(data).toMatchObject({ vehicle_id: ev.public_id, days: 30, latest: { state_of_charge: 55, battery_health: 96.8 } });
    expect(data.soc_trend.map((p: { average: number; minimum: number; maximum: number; readings: number }) => [p.average, p.minimum, p.maximum, p.readings])).toEqual([
      [65, 40, 90, 2],
      [70, 70, 70, 1],
      [55, 55, 55, 1],
    ]);
    expect(data.health).toEqual({ current: 96.8, at_start: 97.5, change: -0.7 });
    expect(data.charging).toEqual({ sessions_completed: 1, energy_kwh: 30, cost_cents: 150_000 });

    const notEv = await get(`/vehicles/${diesel.public_id}/battery-summary`, cookie);
    expect(notEv.status).toBe(400);
    expect(notEv.body.error.details).toEqual([{ field: 'vehicle_id', reason: 'not_electric' }]);
  });
});

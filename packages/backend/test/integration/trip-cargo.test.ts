import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { createDepot, createDriver, createUser, createVehicle } from '../support/factories';
import { publishedEvents } from '../support/events';

// FMS-153: a trip records what it carries, and its job load (light, standard, heavy) is worked out from the plan,
// the schedule, the stops and the cargo's share of the vehicle's payload, never typed (docs/job-load.md).

const app = createApp();
const PASSWORD = 'Cargo-Test-1';

type Depot = Awaited<ReturnType<typeof createDepot>>;
type Row = Record<string, unknown> & { id: string; public_id: string };

async function dispatcher(depot: Depot) {
  const user = await createUser({ roles: ['dispatcher'], depot, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

const post = (cookie: string, path: string, body: Record<string, unknown>) => request(app).post(`/api/v1${path}`).set('Cookie', cookie).send(body);
const patch = (cookie: string, trip: { id: string; version: number }, body: Record<string, unknown>) =>
  request(app).patch(`/api/v1/trips/${trip.id}`).set('Cookie', cookie).set('If-Match', `"${trip.version}"`).send(body);

/** A route of the depot: a 20 km city run of an hour, unless told otherwise. */
async function route(depot: Depot, plan: { km?: number; seconds?: number; stops?: number } = {}) {
  const stops = Array.from({ length: plan.stops ?? 0 }, (_, i) => ({ name: `Stop ${i + 1}`, latitude: null, longitude: null }));
  return (
    await pool.query<Row>(
      `INSERT INTO trip.routes (name, depot_id, origin_name, destination_name, distance_km, estimated_duration_seconds, stops)
       VALUES ('Route ' || gen_random_uuid(), $1, 'Bole', 'Merkato', $2, $3, $4) RETURNING *`,
      [depot.id, plan.km ?? 20, plan.seconds ?? 3600, JSON.stringify(stops)],
    )
  ).rows[0];
}

/** 09:00 to 10:00 in Addis Ababa: a day trip. */
const DAY = { scheduled_start: '2026-11-02T06:00:00Z', scheduled_end: '2026-11-02T07:00:00Z' };

/** A truck that carries `kg`, and a truck driver of the depot. */
async function crew(depot: Depot, kg: number | null) {
  const vehicle = (await createVehicle({ depot, payload_capacity_kg: kg })) as Row;
  const driver = (await createDriver({ depot, license_categories: ['dry_cargo_2'] })).driver as Row;
  return { vehicle, driver };
}

describe('cargo on a trip (FMS-153)', () => {
  test('a trip without cargo is general, and loads from its route alone', async () => {
    const depot = await createDepot();
    const cookie = await dispatcher(depot);
    const city = await post(cookie, '/trips', { route_id: (await route(depot)).public_id, ...DAY });
    expect(city.status).toBe(201);
    expect(city.body.data).toMatchObject({ cargo_weight_kg: null, cargo_kind: 'general', job_load: 'light', job_load_reasons: [] });

    // A loaded 400 km haul overnight, before anything is loaded or anyone assigned: heavy from the route and the night.
    const haul = await post(cookie, '/trips', {
      route_id: (await route(depot, { km: 400, seconds: 7 * 3600, stops: 2 })).public_id,
      scheduled_start: '2026-11-02T17:00:00Z',
      scheduled_end: '2026-11-03T00:00:00Z',
    });
    expect(haul.status).toBe(201);
    expect(haul.body.data).toMatchObject({ job_load: 'heavy', job_load_reasons: ['long_haul', 'long_hours', 'night'] });

    // Listed the same way.
    const list = await request(app).get('/api/v1/trips').set('Cookie', cookie);
    expect(list.body.data.find((t: { id: string }) => t.id === haul.body.data.id)).toMatchObject({ job_load: 'heavy', cargo_kind: 'general' });
  });

  test('the dispatcher records cargo on create and changes it before the trip starts; each change is audited and published', async () => {
    const depot = await createDepot();
    const cookie = await dispatcher(depot);
    const created = await post(cookie, '/trips', { route_id: (await route(depot)).public_id, ...DAY, cargo_weight_kg: 1200.5, cargo_kind: 'fragile' });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ cargo_weight_kg: 1200.5, cargo_kind: 'fragile' });

    const changed = await patch(cookie, created.body.data, { cargo_kind: 'refrigerated', cargo_weight_kg: null });
    expect(changed.status).toBe(200);
    expect(changed.body.data).toMatchObject({ cargo_weight_kg: null, cargo_kind: 'refrigerated', version: created.body.data.version + 1 });
    const audit = await pool.query(
      "SELECT new_values->>'cargo_kind' AS kind FROM audit.audit_logs WHERE correlation_id = $1 AND entity_type = 'trip.trips' AND action = 'UPDATE'",
      [changed.headers['x-request-id']],
    );
    expect(audit.rows).toEqual([{ kind: 'refrigerated' }]);
    const [event] = (await publishedEvents('TripUpdated')).filter((e) => e.payload.trip_id === created.body.data.id);
    expect(event.payload).toMatchObject({ changed_fields: ['cargo_kind', 'cargo_weight_kg'] });

    // The same cargo again is no change.
    const same = await patch(cookie, changed.body.data, { cargo_kind: 'refrigerated' });
    expect(same.body.data.version).toBe(changed.body.data.version);
  });

  test('cargo over the vehicle’s payload is refused (400): on a change of an assigned trip, and on assignment', async () => {
    const depot = await createDepot();
    const cookie = await dispatcher(depot);
    const small = await crew(depot, 1000);
    const trip = (await post(cookie, '/trips', { route_id: (await route(depot)).public_id, ...DAY, cargo_weight_kg: 1500 })).body.data;

    // Assigning a 1,500 kg trip to a truck that carries 1,000 kg.
    const refused = await post(cookie, `/trips/${trip.id}/assign`, { driver_id: small.driver.public_id, vehicle_id: small.vehicle.public_id, version: trip.version });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: [{ field: 'vehicle_id', reason: 'over_payload' }] });

    // Exactly the payload goes.
    const lighter = (await patch(cookie, trip, { cargo_weight_kg: 1000 })).body.data;
    const assigned = await post(cookie, `/trips/${trip.id}/assign`, { driver_id: small.driver.public_id, vehicle_id: small.vehicle.public_id, version: lighter.version });
    expect(assigned.status).toBe(200);
    expect(assigned.body.data).toMatchObject({ status: 'assigned', job_load: 'standard', job_load_reasons: ['near_payload'] });

    // More on the assigned trip than its truck carries: refused, nothing changes.
    const over = await patch(cookie, assigned.body.data, { cargo_weight_kg: 1000.01 });
    expect(over.status).toBe(400);
    expect(over.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: [{ field: 'cargo_weight_kg', reason: 'over_payload' }] });
    expect((await pool.query("SELECT cargo_weight_kg::float8 AS kg FROM trip.trips WHERE public_id = $1", [trip.id])).rows[0].kg).toBe(1000);

    // A vehicle with no payload recorded is not checked, and the share is unknown.
    const unknown = await crew(depot, null);
    const other = (await post(cookie, '/trips', { route_id: (await route(depot)).public_id, scheduled_start: '2026-11-03T06:00:00Z', scheduled_end: '2026-11-03T07:00:00Z', cargo_weight_kg: 9000 })).body.data;
    const anyLoad = await post(cookie, `/trips/${other.id}/assign`, { driver_id: unknown.driver.public_id, vehicle_id: unknown.vehicle.public_id, version: other.version });
    expect(anyLoad.status).toBe(200);
    expect(anyLoad.body.data).toMatchObject({ job_load: 'light', job_load_reasons: [] });
  });

  test('the job load follows each input: distance, time, stops, night and the cargo’s share', async () => {
    const depot = await createDepot();
    const cookie = await dispatcher(depot);
    const load = async (plan: Parameters<typeof route>[1], times = DAY) =>
      (await post(cookie, '/trips', { route_id: (await route(depot, plan)).public_id, ...times })).body.data as { id: string; version: number; job_load: string; job_load_reasons: string[] };

    expect((await load({ km: 150 })).job_load_reasons).toEqual(['regional']);
    expect((await load({ seconds: 9 * 3600 }, { scheduled_start: DAY.scheduled_start, scheduled_end: '2026-11-02T15:00:00Z' })).job_load_reasons).toEqual(['long_day']);
    expect((await load({ stops: 6 })).job_load_reasons).toEqual(['many_stops']);

    // Moved into the night: 21:00 to 00:00 in Addis Ababa.
    const moved = await load({});
    const night = await patch(cookie, moved, { scheduled_start: '2026-11-02T18:00:00Z', scheduled_end: '2026-11-02T21:00:00Z' });
    expect(night.body.data).toMatchObject({ job_load: 'standard', job_load_reasons: expect.arrayContaining(['night']) });

    // The cargo's share once a vehicle is assigned: 3,000 of 5,000 kg is loaded.
    const { vehicle, driver } = await crew(depot, 5000);
    const carrying = (await post(cookie, '/trips', { route_id: (await route(depot)).public_id, ...DAY, cargo_weight_kg: 3000 })).body.data;
    expect(carrying.job_load_reasons).toEqual([]);
    const assigned = await post(cookie, `/trips/${carrying.id}/assign`, { driver_id: driver.public_id, vehicle_id: vehicle.public_id, version: carrying.version });
    expect(assigned.body.data).toMatchObject({ job_load: 'standard', job_load_reasons: ['loaded'] });
  });

  test('cargo is checked: a known kind, a positive weight, and never changed once the trip is under way', async () => {
    const depot = await createDepot();
    const cookie = await dispatcher(depot);
    const plan = (await route(depot)).public_id;
    for (const bad of [{ cargo_kind: 'livestock' }, { cargo_weight_kg: 0 }, { cargo_weight_kg: -3 }, { cargo_weight_kg: 100_001 }, { cargo_weight_kg: 1.234 }]) {
      const res = await post(cookie, '/trips', { route_id: plan, ...DAY, ...bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }

    const { vehicle, driver } = await crew(depot, null);
    const trip = (await post(cookie, '/trips', { route_id: plan, ...DAY })).body.data;
    expect((await post(cookie, `/trips/${trip.id}/assign`, { driver_id: driver.public_id, vehicle_id: vehicle.public_id, version: trip.version })).status).toBe(200);
    const started = await pool.query<{ version: number }>(
      "UPDATE trip.trips SET status = 'en_route', actual_start = scheduled_start WHERE public_id = $1 RETURNING version",
      [trip.id],
    );
    const underWay = await patch(cookie, { id: trip.id, version: started.rows[0].version }, { cargo_kind: 'hazardous' });
    expect(underWay.status).toBe(409);
    expect(underWay.body.error).toMatchObject({ code: 'CONFLICT_INVALID_STATE_TRANSITION', details: [{ field: 'status', reason: 'trip_en_route' }] });
  });
});

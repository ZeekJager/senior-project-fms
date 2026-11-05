import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { GEOFENCE_EVENTS, TRACKING_EVENTS, gpsDevices } from '../../src/modules/integration';
import { createDepot, createDriver, createTrip, createUser, createVehicle, type RoleName } from '../support/factories';
import { deliverEvents, publishedEvents } from '../support/events';

// FMS-90: geofences and route deviation. Fences are drawn through the API; pings go in through the API as a
// device sends them, and the relay delivers VehicleLocationUpdated to the rules and their events to the alert
// engine, as in production.

const app = createApp();
const PASSWORD = 'Geofences-Test-1';
const SEC = 1000;
type Row = Record<string, unknown> & { id: string };

async function signIn(roles: RoleName[], depot: Row | null = null): Promise<string> {
  const user = await createUser({ roles, depot, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

/** About 220 m across, around Meskel Square. */
const YARD = { type: 'Polygon', coordinates: [[[38.7603, 9.0098], [38.7623, 9.0098], [38.7623, 9.0118], [38.7603, 9.0118], [38.7603, 9.0098]]] };
const IN = { lat: 9.0108, lng: 38.7613 };
const OUT = { lat: 9.0108, lng: 38.77 };

async function drawFence(admin: string, depot: Row, body: Record<string, unknown> = {}) {
  const res = await request(app)
    .post('/api/v1/geofences')
    .set('Cookie', admin)
    .send({ depot_id: depot.public_id, name: `Yard ${randomUUID().slice(0, 6)}`, kind: 'keep_in', polygon: YARD, ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as { geofence_id: string; version: number; name: string };
}

async function withDevice(depot: Row) {
  const vehicle = await createVehicle({ depot });
  const { token } = await gpsDevices.register({ vehicleId: vehicle.public_id as string, identifier: `dev-${randomUUID().slice(0, 8)}` }, { userId: null, correlationId: randomUUID() });
  return { vehicle, token };
}

/** One ping per position, 10 s apart, the last `endAgo` ms ago, one request each; then the relay delivers. */
async function drive(token: string, positions: { lat: number; lng: number }[], endAgo = 0) {
  for (const [i, p] of positions.entries()) {
    const recorded_at = new Date(Date.now() - endAgo - (positions.length - 1 - i) * 10 * SEC).toISOString();
    const res = await request(app).post('/api/v1/tracking/gps-pings').set('Authorization', `Bearer ${token}`).send({ pings: [{ recorded_at, ...p, speed_kmh: 30, ignition_on: true }] });
    expect(res.status).toBe(202);
  }
  await deliverEvents();
}

const flagsOf = async (vehicle: Row, type: string) =>
  (await pool.query('SELECT * FROM tracking.telemetry_flags WHERE vehicle_id = $1 AND flag_type = $2 ORDER BY observed_at, id', [vehicle.id, type])).rows as Row[];
const alertsOf = async (vehicle: Row) =>
  (await pool.query('SELECT alert_type, severity, title, description AS message, occurrence_count, entity_type FROM alert.alerts WHERE vehicle_id = $1 ORDER BY id', [vehicle.id])).rows;
const eventsOf = async (vehicle: Row, type: string) => (await publishedEvents(type)).filter((e) => e.payload.vehicle_id === vehicle.public_id);

describe('geofences through the API', () => {
  test('an admin draws one; the depot’s dispatcher sees it, another depot’s does not; only an admin may draw', async () => {
    const depot = await createDepot();
    const other = await createDepot();
    const admin = await signIn(['admin']);
    const fence = await drawFence(admin, depot, { name: 'Bole yard', applies: 'off_trip', description: 'Night parking' });
    expect(fence).toMatchObject({ name: 'Bole yard', depot_id: depot.public_id, kind: 'keep_in', applies: 'off_trip', description: 'Night parking', is_active: true, version: 0 });
    expect((fence as unknown as { area_m2: number }).area_m2).toBeGreaterThan(45_000);

    const dispatcher = await signIn(['dispatcher'], depot);
    expect((await request(app).get('/api/v1/geofences').set('Cookie', dispatcher)).body.data.map((f: { name: string }) => f.name)).toEqual(['Bole yard']);
    const stranger = await signIn(['dispatcher'], other);
    expect((await request(app).get('/api/v1/geofences').set('Cookie', stranger)).body.data).toEqual([]);
    expect((await request(app).get(`/api/v1/geofences/${fence.geofence_id}`).set('Cookie', stranger)).status).toBe(404);
    expect((await request(app).get(`/api/v1/geofences?depot_id=${depot.public_id}`).set('Cookie', stranger)).status).toBe(404);

    expect((await request(app).post('/api/v1/geofences').set('Cookie', dispatcher).send({ depot_id: depot.public_id, name: 'X', kind: 'keep_in', polygon: YARD })).status).toBe(403);
    const driver = await signIn(['driver'], depot);
    expect((await request(app).get('/api/v1/geofences').set('Cookie', driver)).status).toBe(403);

    const [audit] = (await pool.query(`SELECT action FROM audit.audit_logs WHERE entity_type = 'tracking.geofences' AND new_values->>'public_id' = $1`, [fence.geofence_id])).rows;
    expect(audit).toEqual({ action: 'INSERT' });
    const [changed] = await publishedEvents(GEOFENCE_EVENTS.changed);
    expect(changed.payload).toMatchObject({ geofence_id: fence.geofence_id, depot_id: depot.public_id, change: 'created' });
  });

  test('a crossing outline, a hole and a second "Bole yard" are refused; a stale version is 409', async () => {
    const depot = await createDepot();
    const admin = await signIn(['admin']);
    const bowTie = { type: 'Polygon', coordinates: [[[38.76, 9.01], [38.77, 9.02], [38.77, 9.01], [38.76, 9.02]]] };
    const crossing = await request(app).post('/api/v1/geofences').set('Cookie', admin).send({ depot_id: depot.public_id, name: 'Bow', kind: 'keep_in', polygon: bowTie });
    expect(crossing.status).toBe(400);
    expect(crossing.body.error.details).toEqual([{ field: 'polygon', reason: 'self_intersecting' }]);
    const holed = { type: 'Polygon', coordinates: [YARD.coordinates[0], YARD.coordinates[0]] };
    expect((await request(app).post('/api/v1/geofences').set('Cookie', admin).send({ depot_id: depot.public_id, name: 'Holed', kind: 'keep_in', polygon: holed })).status).toBe(400);

    const fence = await drawFence(admin, depot, { name: 'Bole yard' });
    const again = await request(app).post('/api/v1/geofences').set('Cookie', admin).send({ depot_id: depot.public_id, name: 'bole YARD', kind: 'keep_out', polygon: YARD });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('CONFLICT_DUPLICATE');

    const renamed = await request(app).patch(`/api/v1/geofences/${fence.geofence_id}`).set('Cookie', admin).set('If-Match', '"0"').send({ name: 'Bole night yard' });
    expect(renamed.status).toBe(200);
    expect(renamed.headers.etag).toBe('"1"');
    const stale = await request(app).patch(`/api/v1/geofences/${fence.geofence_id}`).set('Cookie', admin).set('If-Match', '"0"').send({ name: 'Late' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('CONFLICT_CONCURRENT_MODIFICATION');
  });

  test('removed, it leaves the list and can be restored', async () => {
    const depot = await createDepot();
    const admin = await signIn(['admin']);
    const fence = await drawFence(admin, depot);
    expect((await request(app).delete(`/api/v1/geofences/${fence.geofence_id}`).set('Cookie', admin)).status).toBe(204);
    expect((await request(app).get(`/api/v1/geofences?depot_id=${depot.public_id}`).set('Cookie', admin)).body.data).toEqual([]);
    const removed = (await request(app).get(`/api/v1/geofences?depot_id=${depot.public_id}&status=inactive`).set('Cookie', admin)).body.data;
    expect(removed).toEqual([expect.objectContaining({ geofence_id: fence.geofence_id, is_active: false })]);
    expect((await request(app).patch(`/api/v1/geofences/${fence.geofence_id}`).set('Cookie', admin).send({ name: 'Back' })).status).toBe(409);
    const restored = await request(app).post(`/api/v1/geofences/${fence.geofence_id}/reactivate`).set('Cookie', admin);
    expect(restored.status).toBe(200);
    expect(restored.body.data.is_active).toBe(true);
  });
});

describe('leaving a geofence', () => {
  test('raises one flag, one GeofenceViolated and one high alert, however long the vehicle stays out', async () => {
    const depot = await createDepot();
    const admin = await signIn(['admin']);
    const fence = await drawFence(admin, depot, { name: 'Bole yard' });
    const { vehicle, token } = await withDevice(depot);
    await drive(token, [IN, IN, OUT, OUT, OUT, OUT], 60 * SEC);

    const [flag, ...more] = await flagsOf(vehicle, 'geofence_violation');
    expect(more).toEqual([]);
    expect(flag).toMatchObject({ severity: 'high', resolved_at: null });
    expect(flag.details).toMatchObject({ kind: 'keep_in', geofence_name: 'Bole yard', lat: OUT.lat, lng: OUT.lng });

    const [violated, ...others] = await eventsOf(vehicle, GEOFENCE_EVENTS.violated);
    expect(others).toEqual([]);
    expect(violated.payload).toMatchObject({ flag_id: flag.public_id, geofence_id: fence.geofence_id, geofence_name: 'Bole yard', kind: 'keep_in', depot_id: depot.public_id });
    const [raised] = await eventsOf(vehicle, TRACKING_EVENTS.flagRaised);
    expect(raised.payload).toMatchObject({ flag_type: 'geofence_violation', geofence_id: fence.geofence_id });

    expect(await alertsOf(vehicle)).toEqual([
      {
        alert_type: 'geofence_violation',
        severity: 'high',
        title: `Left Bole yard: ${vehicle.registration_number}`,
        message: `${vehicle.registration_number} left Bole yard, an area it must stay inside. Check it is authorised to.`,
        occurrence_count: 1,
        entity_type: 'telemetry_flag',
      },
    ]);

    // Its flag lists with the fence.
    const listed = await request(app).get(`/api/v1/vehicles/${vehicle.public_id}/telemetry-flags?flag_type=geofence_violation`).set('Cookie', admin);
    expect(listed.body.data).toEqual([expect.objectContaining({ flag_id: flag.public_id, geofence: { geofence_id: fence.geofence_id, name: 'Bole yard' } })]);
  });

  test('3 pings back inside resolve it; entering a keep-out zone is a violation too', async () => {
    const depot = await createDepot();
    const admin = await signIn(['admin']);
    await drawFence(admin, depot, { name: 'Bole yard' });
    await drawFence(admin, depot, { name: 'Market', kind: 'keep_out', polygon: { type: 'Polygon', coordinates: [[[38.769, 9.0098], [38.771, 9.0098], [38.771, 9.0118], [38.769, 9.0118]]] } });
    const { vehicle, token } = await withDevice(depot);
    await drive(token, [IN, OUT, OUT, IN, IN, IN], 60 * SEC);

    const flags = await flagsOf(vehicle, 'geofence_violation');
    expect(flags.map((f) => [f.details && (f.details as { geofence_name: string }).geofence_name, f.resolved_at !== null])).toEqual([
      ['Bole yard', true],
      ['Market', true],
    ]);
    expect(flags[0].details).toMatchObject({ end_reason: 'cleared' });
    const titles = (await alertsOf(vehicle)).map((a) => a.title);
    expect(titles).toEqual([`Left Bole yard: ${vehicle.registration_number}`, `Entered Market: ${vehicle.registration_number}`]);
  });

  test('changing the fence’s outline closes its open flags; removing the fence does too', async () => {
    const depot = await createDepot();
    const admin = await signIn(['admin']);
    const fence = await drawFence(admin, depot);
    const { vehicle, token } = await withDevice(depot);
    await drive(token, [IN, OUT]);
    expect((await flagsOf(vehicle, 'geofence_violation'))[0].resolved_at).toBeNull();

    const bigger = { type: 'Polygon', coordinates: [[[38.7603, 9.0098], [38.7723, 9.0098], [38.7723, 9.0118], [38.7603, 9.0118]]] };
    expect((await request(app).patch(`/api/v1/geofences/${fence.geofence_id}`).set('Cookie', admin).send({ polygon: bigger })).status).toBe(200);
    const [closed] = await flagsOf(vehicle, 'geofence_violation');
    expect(closed.resolved_at).not.toBeNull();
    expect(closed.details).toMatchObject({ end_reason: 'geofence_changed' });
    expect((await eventsOf(vehicle, TRACKING_EVENTS.flagResolved)).map((e) => e.payload.flag_id)).toEqual([closed.public_id]);
  });
});

describe('route deviation', () => {
  /** A trip under way on a route whose road runs east along latitude 9.0108. */
  async function onTrip() {
    const depot = await createDepot();
    const { vehicle, token } = await withDevice(depot);
    const { driver } = await createDriver({ depot });
    const road = { type: 'LineString', coordinates: [[38.7, 9.0108], [38.8, 9.0108]] };
    const [route] = (
      await pool.query(
        `INSERT INTO trip.routes (name, depot_id, geometry, measured_at, distance_km, distance_source) VALUES ($1, $2, $3, now(), 11, 'road') RETURNING *`,
        [`Route ${randomUUID().slice(0, 6)}`, depot.id, road],
      )
    ).rows as Row[];
    const startedAt = new Date(Date.now() - 30 * 60 * SEC).toISOString();
    const trip = await createTrip({ vehicle, driver, route_id: route.id, status: 'en_route', actual_start: startedAt, scheduled_start: startedAt });
    return { depot, vehicle, token, driver, route, trip };
  }
  const onRoad = { lat: 9.0108, lng: 38.75 };
  const off = (m: number) => ({ lat: 9.0108 + m / 111_195, lng: 38.75 });

  test('600 m off the road for 3 pings raises one flag, a RouteDeviationDetected and one alert', async () => {
    const { depot, vehicle, token, driver, route, trip } = await onTrip();
    await drive(token, [onRoad, off(600), off(600), off(600), off(650)], 30 * SEC);

    const [flag, ...more] = await flagsOf(vehicle, 'route_deviation');
    expect(more).toEqual([]);
    expect(flag).toMatchObject({ severity: 'medium', trip_id: trip.id, resolved_at: null });
    expect(flag.details).toMatchObject({ distance_m: 600, route_deviation_m: 500, consecutive_pings: 3 });

    const [detected] = await eventsOf(vehicle, GEOFENCE_EVENTS.routeDeviationDetected);
    expect(detected.payload).toMatchObject({
      flag_id: flag.public_id,
      trip_id: trip.public_id,
      driver_id: driver.public_id,
      depot_id: depot.public_id,
      route_id: route.public_id,
      distance_m: 600,
      route_deviation_m: 500,
      consecutive_pings: 3,
    });
    expect(await alertsOf(vehicle)).toEqual([
      expect.objectContaining({
        alert_type: 'route_deviation',
        severity: 'medium',
        title: `Off route: ${vehicle.registration_number}`,
        message: `${vehicle.registration_number} was 600 m from its route for 3 pings in a row. Contact the driver.`,
        occurrence_count: 1,
      }),
    ]);
  });

  test('2 pings off the road raise nothing; 3 back on it resolve a flag, with the furthest it strayed', async () => {
    const { vehicle, token } = await onTrip();
    await drive(token, [off(600), off(600), onRoad], 200 * SEC);
    expect(await flagsOf(vehicle, 'route_deviation')).toEqual([]);

    await drive(token, [off(600), off(900), off(600), onRoad, onRoad, onRoad], 60 * SEC);
    const [flag] = await flagsOf(vehicle, 'route_deviation');
    expect(flag.resolved_at).not.toBeNull();
    expect(flag.details).toMatchObject({ end_reason: 'cleared', max_distance_m: 900 });
  });

  test('the depot’s threshold from the settings: at 1 km, 600 m off the road is no deviation', async () => {
    const { depot, vehicle, token } = await onTrip();
    const admin = await signIn(['admin']);
    const set = await request(app)
      .put(`/api/v1/settings/telemetry-rules/depots/${depot.public_id}`)
      .set('Cookie', admin)
      .send({ speed_limit_kmh: 80, speeding_pings: 3, clear_pings: 3, idle_minutes: 5, route_deviation_m: 1000 });
    expect(set.status).toBe(200);
    const row = set.body.data.depots.find((d: { depot_id: string }) => d.depot_id === depot.public_id);
    expect(row).toMatchObject({ route_deviation_m: 1000, route_deviation_pings: 3 });
    expect(set.body.data.fleet).toMatchObject({ route_deviation_m: 500, route_deviation_pings: 3 });

    await drive(token, [off(600), off(600), off(600), off(600)]);
    expect(await flagsOf(vehicle, 'route_deviation')).toEqual([]);
  });
});

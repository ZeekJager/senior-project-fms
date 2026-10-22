import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { trackingRefs } from '../../src/modules/fleet';
import { TRACKING_EVENTS, gpsDevices } from '../../src/modules/integration';
import { TelemetryRulesService } from '../../src/modules/integration/application/telemetry-rules.service';
import { MemoryRuleStateStore, RedisRuleStateStore } from '../../src/modules/integration/infrastructure/rule-state.store';
import { TelemetryFlagRepository } from '../../src/modules/integration/infrastructure/telemetry-flag.repository';
import { TrackingRepository } from '../../src/modules/integration/infrastructure/tracking.repository';
import { tripPartiesByIds } from '../../src/modules/trip';
import { redis } from '../../src/shared/cache';
import { createEvent } from '../../src/shared/events/domain-event';
import { eventBus } from '../../src/shared/events/event-bus';
import { withTransaction } from '../../src/shared/infrastructure/transaction';
import { createDepot, createDriver, createTrip, createUser, createVehicle, type RoleName } from '../support/factories';
import { deliverEvents, publishedEvents } from '../support/events';

// FMS-46: the telemetry rules. Pings go in through the API as a device sends them; the relay delivers
// VehicleLocationUpdated to the rules, as in production.

const app = createApp();
const PASSWORD = 'Telemetry-Rules-Test-1';
const SEC = 1000;
type Row = Record<string, unknown> & { id: string };

async function signIn(roles: RoleName[], depot: Row | null = null): Promise<string> {
  const user = await createUser({ roles, depot, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

async function withDevice(depot?: Row) {
  const d = depot ?? (await createDepot());
  const vehicle = await createVehicle({ depot: d });
  const { token } = await gpsDevices.register({ vehicleId: vehicle.public_id as string, identifier: `dev-${randomUUID().slice(0, 8)}` }, { userId: null, correlationId: randomUUID() });
  return { depot: d, vehicle, token };
}

const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

/** Pings 10 s apart, the last one `endAgo` ms ago, one per speed. */
function pings(speeds: readonly number[], endAgo = 0, extra: Record<string, unknown> = {}) {
  return speeds.map((speed_kmh, i) => ({ recorded_at: at(endAgo + (speeds.length - 1 - i) * 10 * SEC), lat: 9.0108, lng: 38.7613, speed_kmh, ignition_on: true, ...extra }));
}

/** Sends pings one request each, as a device reporting every 10 s does, then lets the relay deliver. */
async function report(token: string, list: readonly Record<string, unknown>[]) {
  for (const p of list) expect((await request(app).post('/api/v1/tracking/gps-pings').set('Authorization', `Bearer ${token}`).send({ pings: [p] })).status).toBe(202);
  await deliverEvents();
}

const flagsOf = async (vehicle: Row) =>
  (await pool.query('SELECT * FROM tracking.telemetry_flags WHERE vehicle_id = $1 ORDER BY observed_at, id', [vehicle.id])).rows as Row[];
const eventsOf = async (vehicle: Row, type: string) => (await publishedEvents(type)).filter((e) => e.payload.vehicle_id === vehicle.public_id);

describe('speeding (over 80 km/h for 3 pings)', () => {
  test('3 pings at 90 km/h open one flag and raise TelemetryFlagRaised, which becomes an unsafe driving alert', async () => {
    const { depot, vehicle, token } = await withDevice();
    const list = pings([90, 90, 90], 20 * SEC);
    await report(token, list);

    const [flag, ...more] = await flagsOf(vehicle);
    expect(more).toEqual([]);
    expect(flag).toMatchObject({ flag_type: 'speeding', severity: 'high', status: 'open', resolved_at: null, trip_id: null });
    expect((flag.observed_at as Date).toISOString()).toBe(list[0].recorded_at);
    expect(flag.details).toMatchObject({ speed_limit_kmh: 80, speed_kmh: 90, consecutive_pings: 3, lat: 9.0108, lng: 38.7613, flagged_at: list[2].recorded_at });

    const [event] = await eventsOf(vehicle, TRACKING_EVENTS.flagRaised);
    expect(event).toMatchObject({
      actor: null,
      aggregate: `vehicle:${vehicle.public_id}`,
      payload: { flag_id: flag.public_id, vehicle_id: vehicle.public_id, depot_id: depot.public_id, trip_id: null, driver_id: null, flag_type: 'speeding', severity: 'high', observed_at: list[0].recorded_at },
    });

    const alerts = (await pool.query('SELECT alert_type, severity, entity_type, entity_id, source_module FROM alert.alerts WHERE vehicle_id = $1', [vehicle.id])).rows;
    expect(alerts).toEqual([{ alert_type: 'unsafe_driving', severity: 'high', entity_type: 'telemetry_flag', entity_id: flag.public_id, source_module: 'integration' }]);
  });

  test('2 pings at 90 km/h open none', async () => {
    const { vehicle, token } = await withDevice();
    await report(token, pings([90, 90]));
    expect(await flagsOf(vehicle)).toEqual([]);
  });

  test('more pings over the limit, sent in one batch or many, keep one flag', async () => {
    const { vehicle, token } = await withDevice();
    await report(token, pings([90, 95, 100, 105], 60 * SEC));
    const res = await request(app).post('/api/v1/tracking/gps-pings').set('Authorization', `Bearer ${token}`).send({ pings: pings([110, 120, 130], 10 * SEC) });
    expect(res.status).toBe(202);
    await deliverEvents();
    expect(await flagsOf(vehicle)).toHaveLength(1);
    expect(await eventsOf(vehicle, TRACKING_EVENTS.flagRaised)).toHaveLength(1);
  });

  test('3 pings at or under 80 km/h resolve it, with the top speed and how long it lasted', async () => {
    const { vehicle, token } = await withDevice();
    const list = pings([90, 112, 90, 80, 60, 40], 0);
    await report(token, list);

    const [flag] = await flagsOf(vehicle);
    expect((flag.resolved_at as Date).toISOString()).toBe(list[3].recorded_at);
    expect(flag.details).toMatchObject({ end_reason: 'cleared', max_speed_kmh: 112, duration_seconds: 30 });
    expect(flag.status).toBe('open'); // the review status is someone's to change

    const [event] = await eventsOf(vehicle, TRACKING_EVENTS.flagResolved);
    expect(event.payload).toMatchObject({ flag_id: flag.public_id, flag_type: 'speeding', resolved_at: list[3].recorded_at, details: expect.objectContaining({ end_reason: 'cleared' }) });
  });

  test('on a trip under way, the flag and its event name the trip and the driver', async () => {
    const { depot, vehicle, token } = await withDevice();
    const { driver } = await createDriver({ depot });
    const trip = await createTrip({ vehicle, driver, status: 'en_route', actual_start: at(30 * 60 * SEC), scheduled_start: at(30 * 60 * SEC) });
    await report(token, pings([95, 95, 95]));

    const [flag] = await flagsOf(vehicle);
    expect(flag.trip_id).toBe(trip.id);
    const [event] = await eventsOf(vehicle, TRACKING_EVENTS.flagRaised);
    expect(event.payload).toMatchObject({ trip_id: trip.public_id, driver_id: driver.public_id });
  });

  test("a depot's own thresholds replace the fleet's", async () => {
    const { depot, vehicle, token } = await withDevice();
    await pool.query('INSERT INTO tracking.rule_thresholds (depot_id, speed_limit_kmh, speeding_pings) VALUES ($1, 60, 2)', [depot.id]);
    await report(token, pings([70, 70]));
    const [flag] = await flagsOf(vehicle);
    expect(flag.details).toMatchObject({ speed_limit_kmh: 60, consecutive_pings: 2 });
  });
});

describe('idling (5 minutes at 0 km/h, engine on)', () => {
  test('a 5-minute stop opens an idling flag from its first ping; moving off resolves it', async () => {
    const { vehicle, token } = await withDevice();
    const stop = pings(Array(31).fill(0), 20 * SEC);
    const res = await request(app).post('/api/v1/tracking/gps-pings').set('Authorization', `Bearer ${token}`).send({ pings: stop });
    expect(res.status).toBe(202);
    await deliverEvents();

    const [flag] = await flagsOf(vehicle);
    expect(flag).toMatchObject({ flag_type: 'idling', severity: 'medium', resolved_at: null, details: expect.objectContaining({ idle_minutes: 5 }) });
    expect((flag.observed_at as Date).toISOString()).toBe(stop[0].recorded_at);
    const alerts = (await pool.query('SELECT alert_type, severity FROM alert.alerts WHERE vehicle_id = $1', [vehicle.id])).rows;
    expect(alerts).toEqual([{ alert_type: 'unsafe_driving', severity: 'medium' }]);

    await report(token, pings([25], 5 * SEC));
    const [ended] = await flagsOf(vehicle);
    expect(ended.details).toMatchObject({ end_reason: 'moving', duration_seconds: 315 });
  });

  test('stopped with the engine off is parked, not idling', async () => {
    const { vehicle, token } = await withDevice();
    await request(app).post('/api/v1/tracking/gps-pings').set('Authorization', `Bearer ${token}`).send({ pings: pings(Array(31).fill(0), 0, { ignition_on: false }) });
    await deliverEvents();
    expect(await flagsOf(vehicle)).toEqual([]);
  });
});

describe('counters and delivery', () => {
  /** A rules service as another process would build it: its own in-process state, Redis shared. */
  const freshProcess = () => {
    const local = new MemoryRuleStateStore();
    return new TelemetryRulesService({
      db: pool,
      tracking: new TrackingRepository(),
      flags: new TelemetryFlagRepository(),
      state: redis ? new RedisRuleStateStore(redis, local, () => {}) : local,
      refs: { vehicles: { byPublicIds: trackingRefs.vehicles.byPublicIds }, trips: { partiesByIds: tripPartiesByIds }, drivers: { publicIds: trackingRefs.drivers.publicIds } },
      events: eventBus,
    });
  };
  const announce = (vehicle: Row, recordedAt: string) =>
    createEvent(TRACKING_EVENTS.locationUpdated, { vehicle_id: vehicle.public_id, recorded_at: recordedAt }, { actor: null, correlationId: randomUUID() });

  /** Stores pings without delivering their events: the test hands events to the service itself. */
  const store = async (token: string, list: readonly Record<string, unknown>[]) => {
    for (const p of list) await request(app).post('/api/v1/tracking/gps-pings').set('Authorization', `Bearer ${token}`).send({ pings: [p] });
  };

  test.skipIf(!redis)('restarting the app does not reset the counters: they are in Redis', async () => {
    const { vehicle, token } = await withDevice();
    const list = pings([90, 90, 90]);
    await store(token, list);

    const before = freshProcess();
    for (const p of list.slice(0, 2)) await withTransaction(pool, (tx) => before.onLocationUpdated(tx, announce(vehicle, p.recorded_at)));
    expect(await flagsOf(vehicle)).toEqual([]);

    // A new process: nothing in memory. The third ping still completes the run of three.
    const after = freshProcess();
    await withTransaction(pool, (tx) => after.onLocationUpdated(tx, announce(vehicle, list[2].recorded_at)));
    expect(await flagsOf(vehicle)).toHaveLength(1);
  });

  test('an event delivered twice decides the same once: one flag, one TelemetryFlagRaised', async () => {
    const { vehicle, token } = await withDevice();
    const list = pings([90, 90, 90]);
    await store(token, list);
    const service = freshProcess();
    const event = announce(vehicle, list[2].recorded_at);
    await withTransaction(pool, (tx) => service.onLocationUpdated(tx, event));
    await withTransaction(pool, (tx) => service.onLocationUpdated(tx, event));
    expect(await flagsOf(vehicle)).toHaveLength(1);
    expect(await eventsOf(vehicle, TRACKING_EVENTS.flagRaised)).toHaveLength(1);
  });

  test('an event whose transaction rolled back is replayed from the counters before it', async () => {
    const { vehicle, token } = await withDevice();
    const list = pings([90, 90, 90]);
    await store(token, list);
    const service = freshProcess();
    for (const p of list.slice(0, 2)) await withTransaction(pool, (tx) => service.onLocationUpdated(tx, announce(vehicle, p.recorded_at)));
    const third = announce(vehicle, list[2].recorded_at);
    // The consumer ran, then its transaction failed: the flag is gone, the counters say the ping was seen.
    await expect(
      withTransaction(pool, async (tx) => {
        await service.onLocationUpdated(tx, third);
        throw new Error('commit failed');
      }),
    ).rejects.toThrow('commit failed');
    expect(await flagsOf(vehicle)).toEqual([]);
    await withTransaction(pool, (tx) => service.onLocationUpdated(tx, third));
    expect(await flagsOf(vehicle)).toHaveLength(1);
  });

  test('a flag opened meanwhile is not opened twice (one ongoing flag per type)', async () => {
    const { vehicle } = await withDevice();
    const insert = () =>
      pool.query("INSERT INTO tracking.telemetry_flags (vehicle_id, flag_type, observed_at) VALUES ($1, 'speeding', now()) ON CONFLICT DO NOTHING RETURNING id", [vehicle.id]);
    expect((await insert()).rowCount).toBe(1);
    expect((await insert()).rowCount).toBe(0);
    await expect(pool.query("INSERT INTO tracking.telemetry_flags (vehicle_id, flag_type, observed_at) VALUES ($1, 'speeding', now())", [vehicle.id])).rejects.toThrow(/ux_telemetry_flags_ongoing/);
  });
});

describe('GET /vehicles/{vehicle_id}/telemetry-flags', () => {
  test("a dispatcher reads their depot's vehicle's flags, newest first, filtered by type and ongoing", async () => {
    const { depot, vehicle, token } = await withDevice();
    await report(token, [...pings([90, 90, 90, 50, 50, 50], 7 * 60 * SEC), ...pings(Array(31).fill(0), 0)]);
    const cookie = await signIn(['dispatcher'], depot);

    const all = await request(app).get(`/api/v1/vehicles/${vehicle.public_id}/telemetry-flags`).set('Cookie', cookie);
    expect(all.status).toBe(200);
    expect(all.body.data.map((f: Row) => [f.flag_type, f.resolved_at === null])).toEqual([
      ['idling', true],
      ['speeding', false],
    ]);
    expect(all.body.data[1]).toMatchObject({ vehicle_id: vehicle.public_id, trip_id: null, severity: 'high', status: 'open', details: expect.objectContaining({ max_speed_kmh: 90 }) });

    const speeding = await request(app).get(`/api/v1/vehicles/${vehicle.public_id}/telemetry-flags?flag_type=speeding`).set('Cookie', cookie);
    expect(speeding.body.data.map((f: Row) => f.flag_type)).toEqual(['speeding']);
    const ongoing = await request(app).get(`/api/v1/vehicles/${vehicle.public_id}/telemetry-flags?ongoing=true`).set('Cookie', cookie);
    expect(ongoing.body.data.map((f: Row) => f.flag_type)).toEqual(['idling']);
  });

  test("behavioural data: drivers may not read it, another depot's staff see no such vehicle", async () => {
    const { vehicle } = await withDevice();
    const path = `/api/v1/vehicles/${vehicle.public_id}/telemetry-flags`;
    expect((await request(app).get(path).set('Cookie', await signIn(['driver']))).status).toBe(403);
    expect((await request(app).get(path).set('Cookie', await signIn(['dispatcher'], await createDepot()))).status).toBe(404);
    expect((await request(app).get('/api/v1/vehicles/not-a-uuid/telemetry-flags').set('Cookie', await signIn(['admin']))).status).toBe(404);
    const bad = await request(app).get(`${path}?flag_type=sleeping&limit=500`).set('Cookie', await signIn(['admin']));
    expect(bad.status).toBe(400);
  });

  test('the live map shows an open flag', async () => {
    const { vehicle, token } = await withDevice();
    await report(token, pings([90, 90, 90]));
    const res = await request(app).get('/api/v1/tracking/vehicles/current').set('Cookie', await signIn(['admin']));
    const mine = res.body.data.find((v: Row) => v.vehicle_id === vehicle.public_id);
    expect(mine.flags).toEqual([{ flag_type: 'speeding', severity: 'high', observed_at: expect.any(String) }]);
  });
});

// FMS-59 (SE-95): socket rooms, generated from the event contract. Every domain event type the gateway forwards
// has a sample here (a forwarded type without one fails CI), is raised in depot B, and must reach no depot A
// socket, of any role, and no driver's trips or incidents but the driver it names; depot B's own sockets receive
// it, so the test is not vacuous.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import request from 'supertest';
import { afterEach, describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { hashPassword } from '../../src/modules/auth';
import { attachRealtime, SOCKET_PATH } from '../../src/modules/realtime';
import { CHANNELS, deliveriesFor, FORWARDED_TYPES, roomsFor, roomsOf, type SocketIdentity } from '../../src/modules/realtime/domain/contract';
import { createDepot, createDriver, createUser, createVehicle, type RoleName } from '../support/factories';

type Row = Awaited<ReturnType<typeof createDepot>>;
const pid = (row: Row) => String(row.public_id);

const app = createApp();
const PASSWORD = 'Socket-Audit-1';

const ROLES: RoleName[] = ['admin', 'fleet_manager', 'dispatcher', 'driver', 'technician', 'depot_admin', 'finance_clerk', 'compliance_officer', 'fleet_owner'];
const DEPOT_ROLES: RoleName[] = ['dispatcher', 'technician', 'depot_admin', 'finance_clerk'];
/** The channels whose events are a driver's own (CHANNELS driverOwn): another driver never receives them. */
const DRIVER_OWN = Object.entries(CHANNELS).filter(([, rule]) => rule.driverOwn).map(([channel]) => channel);

/** Who and what depot B's events are about, in public ids. */
interface World {
  depot: string;
  vehicle: string;
  driver: string;
  user: string;
  trip: string;
}

/** One depot B event per forwarded type, as its publisher sends it. */
const SAMPLES: Record<string, (w: World) => Record<string, unknown>> = {
  VehicleStatusChanged: (w) => ({ vehicle_id: w.vehicle, depot_id: w.depot, previous_status: 'active', new_status: 'inactive', reason: 'Audit' }),
  VehicleLocationUpdated: (w) => ({ vehicle_id: w.vehicle, depot_id: w.depot, lat: 9.03, lng: 38.74, speed: 40, heading: 180, trip_id: w.trip }),
  TelemetryFlagRaised: (w) => ({ flag_id: crypto.randomUUID(), vehicle_id: w.vehicle, trip_id: w.trip, depot_id: w.depot, flag_type: 'speeding', severity: 'high' }),
  TelemetryFlagResolved: (w) => ({ flag_id: crypto.randomUUID(), vehicle_id: w.vehicle, trip_id: w.trip, depot_id: w.depot, flag_type: 'idling', severity: 'low', resolved_at: new Date().toISOString() }),
  AlertCreated: (w) => ({ alert_id: crypto.randomUUID(), depot_id: w.depot, alert_type: 'vehicle_fault', severity: 'high', status: 'open', title: 'B', message: 'Depot B' }),
  AlertUpdated: (w) => ({ alert_id: crypto.randomUUID(), depot_id: w.depot, status: 'open', occurrence_count: 2 }),
  AlertAcknowledged: (w) => ({ alert_id: crypto.randomUUID(), depot_id: w.depot, status: 'acknowledged' }),
  AlertResolved: (w) => ({ alert_id: crypto.randomUUID(), depot_id: w.depot, status: 'resolved' }),
  AlertEscalated: (w) => ({ alert_id: crypto.randomUUID(), depot_id: w.depot, escalation_level: 1 }),
  NotificationUnreadChanged: (w) => ({ user_id: w.user, unread_count: 3, reason: 'created' }),
  IncidentReported: (w) => ({ incident_id: crypto.randomUUID(), depot_id: w.depot, reported_by_driver_id: w.driver, vehicle_id: w.vehicle, severity: 'medium' }),
  ...Object.fromEntries(['TripCreated', 'TripUpdated', 'TripCancelled', 'TripAssigned', 'TripStarted', 'TripCompleted'].map((t) => [t, (w: World) => ({ trip_id: w.trip, driver_id: w.driver })])),
};

const envelope = (type: string, payload: Record<string, unknown>) => ({
  id: crypto.randomUUID(),
  type,
  version: 1,
  occurred_at: new Date().toISOString(),
  actor: null,
  correlation_id: null,
  payload,
});

async function grantsOf(role: RoleName): Promise<string[]> {
  const res = await pool.query<{ code: string }>(
    `SELECT p.code FROM auth.role_permissions rp
       JOIN auth.roles r ON r.id = rp.role_id JOIN auth.permissions p ON p.id = rp.permission_id WHERE r.name = $1`,
    [role],
  );
  return res.rows.map((r) => r.code);
}

describe('the forwarded events (FMS-59)', () => {
  test('every type the gateway forwards has a depot B sample here', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...FORWARDED_TYPES].sort());
  });

  test("no depot A room, of any role's seeded grants, is a room a depot B event goes to; nor another driver's", async () => {
    const b: World = { depot: 'depot-b', vehicle: 'vehicle-b', driver: 'driver-b', user: 'user-b', trip: 'trip-b' };
    const lookups = { tripSummary: async () => ({ depot_id: b.depot, driver_id: b.driver }) };
    const deliveries = (await Promise.all(FORWARDED_TYPES.map((type) => deliveriesFor(envelope(type, SAMPLES[type](b)), lookups)))).flat();
    expect(deliveries.length).toBeGreaterThanOrEqual(FORWARDED_TYPES.length);
    const targeted = new Set(deliveries.flatMap(roomsOf));

    const shared: string[] = [];
    const reached = new Set<string>();
    for (const role of ROLES) {
      const permissions = await grantsOf(role);
      const driver = role === 'driver' ? { driverId: 'driver-a' } : null;
      // In depot A nothing of depot B's; and a colleague of driver B in depot B none of B's trips or incidents
      // (their depot's vehicles they may watch, as they may read them).
      for (const room of roomsFor({ userId: `${role}-a`, permissions, depots: { kind: 'depot', depotId: 'depot-a' }, driver })) {
        if (targeted.has(room)) shared.push(`${role} in depot A: ${room}`);
      }
      if (driver) {
        for (const room of roomsFor({ userId: 'driver-b2', permissions, depots: { kind: 'depot', depotId: b.depot }, driver: { driverId: 'driver-b2' } })) {
          if (targeted.has(room) && DRIVER_OWN.some((channel) => room.startsWith(`${channel}:`))) shared.push(`a colleague of driver B: ${room}`);
        }
      }
      // The same role in depot B (or as driver B) is reached: the rooms are not empty by construction.
      const inB: SocketIdentity = { userId: b.user, permissions, depots: { kind: 'depot', depotId: b.depot }, driver: driver ? { driverId: b.driver } : null };
      if (roomsFor(inB).some((room) => targeted.has(room))) reached.add(role);
    }
    expect(shared).toEqual([]);
    expect([...reached].sort()).toEqual(expect.arrayContaining(['depot_admin', 'dispatcher', 'driver']));
  });
});

describe('depot B events on live sockets (FMS-59)', () => {
  const open: { close(): Promise<void> }[] = [];
  const sockets: ClientSocket[] = [];
  afterEach(async () => {
    sockets.splice(0).forEach((s) => s.close());
    await Promise.all(open.splice(0).map((o) => o.close()));
  });

  async function start() {
    const server = createServer(createApp());
    const realtime = attachRealtime(server, { redis: null, allowedOrigins: [] });
    open.push(realtime);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    await realtime.ready;
    return { realtime, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  }

  async function login(email: unknown): Promise<string> {
    const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
    expect(res.status).toBe(200);
    return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
  }

  /** A connected socket and everything it receives. Waits for the handshake, which queries in this test's transaction. */
  async function watch(url: string, cookie: string) {
    const s = connect(url, { path: SOCKET_PATH, transports: ['websocket'], reconnection: false, forceNew: true, extraHeaders: { cookie } });
    sockets.push(s);
    const got: string[] = [];
    s.onAny((event: string) => got.push(event));
    await new Promise<void>((resolve, reject) => {
      s.once('connect', () => resolve());
      s.once('connect_error', reject);
    });
    return got;
  }

  async function driverWithLogin(depot: Row) {
    const made = await createDriver({ depot });
    await pool.query('UPDATE auth.users SET password_hash = $1 WHERE id = $2', [await hashPassword(PASSWORD), made.user.id]);
    return made;
  }

  test("no depot A socket, of any depot role or a driver, receives any of depot B's events; depot B's do", async () => {
    const { url, realtime } = await start();
    const [a, b] = [await createDepot(), await createDepot()];
    const vehicleB = await createVehicle({ depot: b });
    const driverB = await driverWithLogin(b);
    const colleagueB = await driverWithLogin(b);
    const route = (await pool.query<Row>("INSERT INTO trip.routes (name, depot_id) VALUES ('Scope ' || gen_random_uuid(), $1) RETURNING id", [b.id])).rows[0];
    const at = new Date(Date.now() + 3_600_000);
    const trip = (
      await pool.query<Row>(
        "INSERT INTO trip.trips (route_id, vehicle_id, driver_id, status, scheduled_start, scheduled_end) VALUES ($1, $2, $3, 'assigned', $4, $5) RETURNING public_id",
        [route.id, vehicleB.id, driverB.driver.id, at, new Date(at.getTime() + 7_200_000)],
      )
    ).rows[0];
    const dispatcherB = await createUser({ roles: ['dispatcher'], depot: b, password: PASSWORD });
    const world: World = { depot: pid(b), vehicle: pid(vehicleB), driver: pid(driverB.driver), user: pid(dispatcherB), trip: pid(trip) };

    const inA: { who: string; got: string[] }[] = [];
    for (const role of DEPOT_ROLES) {
      const user = await createUser({ roles: [role], depot: a, password: PASSWORD });
      inA.push({ who: role, got: await watch(url, await login(user.email)) });
    }
    inA.push({ who: 'driver of A', got: await watch(url, await login((await driverWithLogin(a)).user.email)) });
    const colleague = await watch(url, await login(colleagueB.user.email));
    const atB = await watch(url, await login(dispatcherB.email));
    const atDriverB = await watch(url, await login(driverB.user.email));
    await new Promise((r) => setTimeout(r, 200));

    for (const type of FORWARDED_TYPES) await realtime.gateway.deliver(envelope(type, SAMPLES[type](world)));
    const until = Date.now() + 3000;
    while (Date.now() < until && !(atB.includes('notifications.unread') && atDriverB.includes('incident.created'))) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 300));

    expect(inA.filter((s) => s.got.length > 0).map((s) => `${s.who}: ${s.got.join(', ')}`)).toEqual([]);
    // Driver B's colleague watches the depot's vehicles, as they may read them, and nothing of driver B's.
    expect(new Set(colleague)).toEqual(new Set(['vehicle.status.changed']));
    expect(new Set(atB)).toEqual(
      new Set(['vehicle.status.changed', 'vehicle.location.updated', 'vehicle_position', 'vehicle.flag.changed', 'alert.created', 'alert_created', 'alert.updated', 'notifications.unread', 'incident.created', 'trip.updated']),
    );
    expect(new Set(atDriverB)).toEqual(new Set(['vehicle.status.changed', 'trip.updated', 'incident.created']));
  });
});

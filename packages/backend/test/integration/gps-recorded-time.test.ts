import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { hashPassword } from '../../src/modules/auth';
import { TRACKING_EVENTS, gpsDevices } from '../../src/modules/integration';
import { createDepot, createDriver, createTrip, createVehicle } from '../support/factories';
import { publishedEvents } from '../support/events';

// FMS-124: a position belongs to the trip it was recorded in, however late the phone delivers it.

const app = createApp();
const PASSWORD = 'Gps-Time-1';
type Row = Record<string, unknown> & { id: string };

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
/** An instant `minutes` ago. */
const ago = (minutes: number) => new Date(Date.now() - minutes * MIN);
/** A ping recorded `minutes` ago. */
const ping = (minutes: number | Date, extra: Record<string, unknown> = {}) => ({
  recorded_at: (typeof minutes === 'number' ? ago(minutes) : minutes).toISOString(),
  lat: 9.0108 + (typeof minutes === 'number' ? minutes : 0) / 100_000,
  lng: 38.7613,
  speed_kmh: 42,
  heading: 90,
  accuracy_m: 6,
  ...extra,
});

async function login(email: string): Promise<string> {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

/** A driver who can sign in (the phone), in a depot. */
async function phoneOf(depot: Row) {
  const { user, driver } = await createDriver({ depot });
  await pool.query('UPDATE auth.users SET password_hash = $2 WHERE id = $1', [user.id, await hashPassword(PASSWORD)]);
  return { driver, cookie: await login(user.email as string) };
}

const send = (pings: unknown[], auth: { cookie?: string; token?: string }) => {
  const req = request(app).post('/api/v1/tracking/gps-pings');
  if (auth.cookie) req.set('Cookie', auth.cookie);
  if (auth.token) req.set('Authorization', `Bearer ${auth.token}`);
  return req.send({ pings });
};

/** A trip as driven: it started and (unless `endedMinutesAgo` is null) ended at the times given; scheduled the same. */
function drivenTrip(vehicle: Row, driver: Row, startedMinutesAgo: number | Date, endedMinutesAgo: number | Date | null) {
  const at = (v: number | Date) => (typeof v === 'number' ? ago(v) : v).toISOString();
  return createTrip({
    vehicle,
    driver,
    status: endedMinutesAgo === null ? 'en_route' : 'completed',
    scheduled_start: at(startedMinutesAgo),
    scheduled_end: endedMinutesAgo === null ? new Date(Date.now() + 60 * MIN).toISOString() : at(endedMinutesAgo),
    actual_start: at(startedMinutesAgo),
    ...(endedMinutesAgo === null ? {} : { actual_end: at(endedMinutesAgo) }),
  });
}

const pingsOf = async (vehicle: Row) =>
  (await pool.query<{ trip_id: string | null; source: string; at: string }>(
    "SELECT trip_id, source, to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS at FROM tracking.gps_pings WHERE vehicle_id = $1 ORDER BY recorded_at",
    [vehicle.id],
  )).rows;
const currentOf = async (vehicle: Row) => (await pool.query('SELECT latitude::float8 AS lat, recorded_at FROM tracking.vehicle_current_location WHERE vehicle_id = $1', [vehicle.id])).rows;
const locationEvents = async (vehicle: Row) => (await publishedEvents(TRACKING_EVENTS.locationUpdated)).filter((e) => e.payload.vehicle_id === vehicle.public_id);

describe("a driver's phone sends pings recorded during a trip that has since ended", () => {
  test('a phone offline for the last 20 minutes of a trip gets all of them stored under that trip', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const { driver, cookie } = await phoneOf(depot);
    const trip = await drivenTrip(vehicle, driver, 120, 5); // ended 5 minutes ago, the phone reconnects now

    const buffered = [25, 22, 19, 16, 13, 10, 7, 6].map((m) => ping(m));
    const res = await send(buffered, { cookie });
    expect(res.status).toBe(202);
    expect(res.body.data).toEqual({ accepted: 8, duplicates: 0, rejected: [] });
    const rows = await pingsOf(vehicle);
    expect(rows).toHaveLength(8);
    expect(rows.every((r) => r.trip_id === trip.id && r.source === 'phone')).toBe(true);
  });

  test('a batch mixing pings inside the trip with pings before it and after it stores the first and rejects the rest alone', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const { driver, cookie } = await phoneOf(depot);
    const trip = await drivenTrip(vehicle, driver, 180, 30);

    const res = await send([ping(40), ping(35), ping(20), ping(10), ping(200)], { cookie });
    expect(res.status).toBe(202);
    expect(res.body.data).toEqual({
      accepted: 2,
      duplicates: 0,
      rejected: [
        { index: 2, reason: 'no_trip_at_time' },
        { index: 3, reason: 'no_trip_at_time' },
        { index: 4, reason: 'no_trip_at_time' },
      ],
    });
    expect((await pingsOf(vehicle)).map((r) => r.trip_id)).toEqual([trip.id, trip.id]);
  });

  test('the start and the end of the trip are inside it, a millisecond either side is not', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const { driver, cookie } = await phoneOf(depot);
    const start = new Date(Date.now() - 120 * MIN);
    const end = new Date(Date.now() - 60 * MIN);
    const trip = await drivenTrip(vehicle, driver, start, end);
    const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);

    const res = await send([ping(plus(start, -1)), ping(start), ping(end), ping(plus(end, 1))], { cookie });
    expect(res.body.data.accepted).toBe(2);
    expect(res.body.data.rejected).toEqual([
      { index: 0, reason: 'no_trip_at_time' },
      { index: 3, reason: 'no_trip_at_time' },
    ]);
    expect((await pingsOf(vehicle)).map((r) => [r.at, r.trip_id])).toEqual([
      [start.toISOString(), trip.id],
      [end.toISOString(), trip.id],
    ]);
  });

  test('the same batch again is all duplicates and stores nothing more', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const { driver, cookie } = await phoneOf(depot);
    await drivenTrip(vehicle, driver, 120, 5);
    const batch = [ping(30), ping(20), ping(10)];
    expect((await send(batch, { cookie })).body.data.accepted).toBe(3);
    const retry = await send(batch, { cookie });
    expect(retry.body.data).toEqual({ accepted: 0, duplicates: 3, rejected: [] });
    expect(await pingsOf(vehicle)).toHaveLength(3);
  });

  test("a batch across two trips puts each ping on that trip's vehicle", async () => {
    const depot = await createDepot();
    const [vanA, vanB] = [await createVehicle({ depot }), await createVehicle({ depot })];
    const { driver, cookie } = await phoneOf(depot);
    const first = await drivenTrip(vanA, driver, 300, 240);
    const second = await drivenTrip(vanB, driver, 180, 30);

    const res = await send([ping(270), ping(260), ping(100), ping(90), ping(200)], { cookie });
    expect(res.body.data).toEqual({ accepted: 4, duplicates: 0, rejected: [{ index: 4, reason: 'no_trip_at_time' }] });
    expect((await pingsOf(vanA)).map((r) => r.trip_id)).toEqual([first.id, first.id]);
    expect((await pingsOf(vanB)).map((r) => r.trip_id)).toEqual([second.id, second.id]);
  });

  test('a ping too old or too far ahead says so, not that it had no trip', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const { driver, cookie } = await phoneOf(depot);
    await drivenTrip(vehicle, driver, 120, 30);
    const res = await send([ping(8 * 24 * 60), ping(-10), ping(60)], { cookie });
    expect(res.body.data.rejected).toEqual([
      { index: 0, reason: 'too_old' },
      { index: 1, reason: 'future_timestamp' },
    ]);
    expect(res.body.data.accepted).toBe(1);
  });
});

describe("a driver's phone is still refused when it has no business reporting", () => {
  test('a driver with no trip in the last 7 days gets 403 no_trip_under_way and nothing is stored', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const { driver, cookie } = await phoneOf(depot);

    const none = await send([ping(10)], { cookie });
    expect([none.status, none.body.error.details[0].reason]).toEqual([403, 'no_trip_under_way']);

    await drivenTrip(vehicle, driver, 9 * 24 * 60, 8 * 24 * 60); // ended 8 days ago
    const old = await send([ping(10)], { cookie });
    expect([old.status, old.body.error.details[0].reason]).toEqual([403, 'no_trip_under_way']);

    // A trip that never started (assigned, scheduled) is no trip.
    await createTrip({ vehicle, driver, status: 'assigned', scheduled_start: new Date(Date.now() + 2 * DAY).toISOString(), scheduled_end: new Date(Date.now() + 2 * DAY + 60 * MIN).toISOString() });
    expect((await send([ping(10)], { cookie })).status).toBe(403);
    expect(await pingsOf(vehicle)).toEqual([]);
  });

  test('a trip that ended 6 days ago still takes the pings recorded in it', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const { driver, cookie } = await phoneOf(depot);
    const trip = await drivenTrip(vehicle, driver, 6 * 24 * 60 + 60, 6 * 24 * 60);
    const res = await send([ping(6 * 24 * 60 + 30)], { cookie });
    expect(res.body.data).toEqual({ accepted: 1, duplicates: 0, rejected: [] });
    expect((await pingsOf(vehicle))[0].trip_id).toBe(trip.id);
  });

  test('naming another vehicle refuses the whole batch, however good the other pings are', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const other = await createVehicle({ depot: await createDepot() });
    const { driver, cookie } = await phoneOf(depot);
    await drivenTrip(vehicle, driver, 120, 30);

    const res = await send([ping(60), ping(50, { vehicle_id: other.public_id })], { cookie });
    expect([res.status, res.body.error.details]).toEqual([403, [{ field: 'vehicle_id', reason: 'not_your_vehicle' }]]);
    expect(await pingsOf(vehicle)).toEqual([]);
    expect(await pingsOf(other)).toEqual([]);

    // Naming its own vehicle is fine; so is naming it for a ping outside any trip (that one is refused alone).
    const ok = await send([ping(60, { vehicle_id: vehicle.public_id }), ping(10, { vehicle_id: vehicle.public_id })], { cookie });
    expect(ok.body.data).toEqual({ accepted: 1, duplicates: 0, rejected: [{ index: 1, reason: 'no_trip_at_time' }] });
    // A ping outside every trip that names a stranger's vehicle is still a 403, not a quiet rejection.
    expect((await send([ping(10, { vehicle_id: other.public_id })], { cookie })).status).toBe(403);
  });

  test("naming the driver's other vehicle for a ping in a trip it was not used on refuses the batch", async () => {
    const depot = await createDepot();
    const [vanA, vanB] = [await createVehicle({ depot }), await createVehicle({ depot })];
    const { driver, cookie } = await phoneOf(depot);
    await drivenTrip(vanA, driver, 300, 240);
    await drivenTrip(vanB, driver, 180, 30);
    const res = await send([ping(100, { vehicle_id: vanA.public_id })], { cookie });
    expect([res.status, res.body.error.details[0].reason]).toEqual([403, 'not_your_vehicle']);
    expect(await pingsOf(vanA)).toEqual([]);
    expect(await pingsOf(vanB)).toEqual([]);
  });
});

describe('a device or a user places each ping in the vehicle’s trip of that time', () => {
  test('a buffered device ping is attached to the trip of its time, not the one under way now', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const { token } = await gpsDevices.register({ vehicleId: vehicle.public_id as string, identifier: `dev-${randomUUID().slice(0, 8)}` }, { userId: null, correlationId: randomUUID() });
    const { driver } = await createDriver({ depot });
    const earlier = await drivenTrip(vehicle, driver, 300, 240);
    const now = await drivenTrip(vehicle, driver, 60, null); // under way

    const res = await send([ping(270), ping(120), ping(10)], { token });
    expect(res.body.data).toEqual({ accepted: 3, duplicates: 0, rejected: [] });
    // The first is in the earlier trip, the second in neither (stored without a trip), the last in the one under way.
    expect((await pingsOf(vehicle)).map((r) => r.trip_id)).toEqual([earlier.id, null, now.id]);
  });
});

describe('pings of a trip that has ended are history, not the vehicle’s position', () => {
  test('buffered pings of an ended trip are stored but neither set the current position nor announce it', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const { driver, cookie } = await phoneOf(depot);
    const trip = await drivenTrip(vehicle, driver, 120, 5);

    const res = await send([ping(30), ping(20), ping(10)], { cookie });
    expect(res.body.data.accepted).toBe(3);
    expect((await pingsOf(vehicle)).map((r) => r.trip_id)).toEqual([trip.id, trip.id, trip.id]);
    expect(await currentOf(vehicle)).toEqual([]);
    expect(await locationEvents(vehicle)).toEqual([]);
  });

  test('they do not move a position the vehicle already has, even though they are newer than it', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const { token } = await gpsDevices.register({ vehicleId: vehicle.public_id as string, identifier: `dev-${randomUUID().slice(0, 8)}` }, { userId: null, correlationId: randomUUID() });
    const { driver, cookie } = await phoneOf(depot);
    await drivenTrip(vehicle, driver, 180, 30);
    // The vehicle's position is a ping from before the trip (in no trip): that is its current location.
    expect((await send([ping(200, { lat: 9.5 })], { token })).body.data.accepted).toBe(1);
    expect((await currentOf(vehicle))[0].lat).toBe(9.5);
    const announced = (await locationEvents(vehicle)).length;

    const res = await send([ping(100, { lat: 9.1 }), ping(40, { lat: 9.2 })], { cookie });
    expect(res.body.data.accepted).toBe(2);
    expect((await currentOf(vehicle))[0].lat).toBe(9.5);
    expect(await locationEvents(vehicle)).toHaveLength(announced);
  });

  test('a position recorded after the trip still becomes current: only the ended trip’s own pings are history', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const { token } = await gpsDevices.register({ vehicleId: vehicle.public_id as string, identifier: `dev-${randomUUID().slice(0, 8)}` }, { userId: null, correlationId: randomUUID() });
    const { driver } = await createDriver({ depot });
    await drivenTrip(vehicle, driver, 180, 30);

    // Both pings go in one batch: the one in the ended trip is history, the one after it is the position.
    const res = await send([ping(60, { lat: 9.1 }), ping(5, { lat: 9.7 })], { token });
    expect(res.body.data.accepted).toBe(2);
    expect((await currentOf(vehicle))[0].lat).toBe(9.7);
    expect(await locationEvents(vehicle)).toHaveLength(1);
  });

  test('a trip under way still moves the position and is announced with its trip', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const { driver, cookie } = await phoneOf(depot);
    const trip = await drivenTrip(vehicle, driver, 30, null);

    const res = await send([ping(2, { lat: 9.3 })], { cookie });
    expect(res.body.data.accepted).toBe(1);
    expect((await currentOf(vehicle))[0].lat).toBe(9.3);
    const [event] = await locationEvents(vehicle);
    expect(event.payload).toMatchObject({ trip_id: trip.public_id, lat: 9.3 });
  });
});

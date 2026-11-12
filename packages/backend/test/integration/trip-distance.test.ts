import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { metresBetween } from '../../src/modules/trip/domain/eta';
import { tripDistance } from '../../src/modules/trip';
import { addisDate } from '../support/dates';
import { publishedEvents } from '../support/events';
import { createDepot, createDriver, createUser, createVehicle, type RoleName } from '../support/factories';

// FMS-145: a trip ended through the API knows how far it went, from the positions stored during it.

const app = createApp();
const PASSWORD = 'Distance-Test-1';
type Row = Record<string, unknown> & { id: string };

const MIN = 60_000;
const ago = (minutes: number) => new Date(Date.now() - minutes * MIN);
/** Degrees of longitude per km east, at 9° N: 0.001° is this many metres, so 1° is as many km. */
const DEG_PER_KM = 1 / metresBetween({ latitude: 9, longitude: 38.7 }, { latitude: 9, longitude: 38.701 });

async function signIn(roles: RoleName[], depot: Row | null = null) {
  const user = await createUser({ roles, depot, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

/** A depot, a truck, a driver, and a trip of theirs under way since `startedMinutesAgo`, on a route of the depot. */
async function underWay(startedMinutesAgo = 60) {
  const depot = await createDepot();
  const vehicle = await createVehicle({ depot });
  const { driver } = await createDriver({ depot, license_categories: ['dry_cargo_2'] });
  const route = (await pool.query<Row>("INSERT INTO trip.routes (name, depot_id) VALUES ('Distance ' || gen_random_uuid(), $1) RETURNING id", [depot.id])).rows[0];
  const started = ago(startedMinutesAgo);
  const trip = (
    await pool.query<Row>(
      `INSERT INTO trip.trips (route_id, vehicle_id, driver_id, status, scheduled_start, scheduled_end, actual_start)
       VALUES ($1, $2, $3, 'en_route', $4, $5, $4) RETURNING *`,
      [route.id, vehicle.id, driver.id, started, new Date(Date.now() + 60 * MIN)],
    )
  ).rows[0];
  return { depot, vehicle, driver, trip, started };
}

interface Position {
  minutesAgo: number;
  km: number;
  speed?: number;
  odometer?: number | null;
  source?: string;
  tripId?: string | null;
}

/** Stores positions of the vehicle as ingestion would: `km` east of a fixed point, on the trip unless told otherwise. */
async function positions(vehicle: Row, trip: Row, list: Position[]) {
  for (const p of list) {
    await pool.query(
      `INSERT INTO tracking.gps_pings (vehicle_id, trip_id, latitude, longitude, speed_kmh, odometer_km, source, recorded_at)
       VALUES ($1, $2, 9, $3, $4, $5, $6, $7)`,
      [vehicle.id, p.tripId === undefined ? trip.id : p.tripId, 38.7 + p.km * DEG_PER_KM, p.speed ?? 40, p.odometer ?? null, p.source ?? 'phone', ago(p.minutesAgo)],
    );
  }
}

/** A drive east at 40 km/h, a position a minute, from `from` minutes ago to `to` minutes ago. */
const drive = (from: number, to: number, extra: (kmSoFar: number) => Partial<Position> = () => ({})): Position[] =>
  Array.from({ length: from - to + 1 }, (_, i) => {
    const km = (40 * i) / 60;
    return { minutesAgo: from - i, km, ...extra(km) };
  });

const end = (cookie: string, trip: Row) => request(app).post(`/api/v1/trips/${trip.public_id}/end`).set('Cookie', cookie).send({});
const stored = async (trip: Row) =>
  (
    await pool.query(
      'SELECT actual_distance_km::float8 AS km, actual_distance_source AS source, actual_distance_points AS points, actual_distance_measured_at AS measured_at FROM trip.trips WHERE id = $1',
      [trip.id],
    )
  ).rows[0];

describe('POST /trips/{id}/end measures the distance (FMS-145)', () => {
  test("from the phone's GPS track: in the response, the event and the end's one audit row", async () => {
    const s = await underWay(60);
    await positions(s.vehicle, s.trip, drive(59, 1)); // 58 minutes at 40 km/h
    const res = await end(await signIn(['admin']), s.trip);
    expect(res.status).toBe(200);
    expect(res.body.data.actual_distance_source).toBe('gps');
    expect(res.body.data.actual_distance_km).toBeCloseTo((40 * 58) / 60, 1);

    expect(await stored(s.trip)).toMatchObject({ source: 'gps', points: 59 });
    const [event] = (await publishedEvents('TripCompleted')).filter((e) => e.payload.trip_id === s.trip.public_id);
    expect(event.payload).toMatchObject({ actual_distance_km: res.body.data.actual_distance_km, actual_distance_source: 'gps' });
    const audit = await pool.query("SELECT new_values FROM audit.audit_logs WHERE entity_type = 'trip.trips' AND entity_id = $1 AND action = 'UPDATE'", [s.trip.id]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].new_values).toMatchObject({ status: 'completed', actual_distance_source: 'gps', actual_distance_points: 59 });
  });

  test("from the vehicle's own odometer when its readings bracket the trip, not a phone's", async () => {
    const s = await underWay(60);
    // The device's odometer says 50 km; its track is shorter (it cut a corner the GPS cannot see).
    await positions(s.vehicle, s.trip, drive(58, 2, (km) => ({ source: 'device', odometer: 80_000 + km * (50 / 37.333) })));
    const res = await end(await signIn(['admin']), s.trip);
    expect(res.body.data).toMatchObject({ actual_distance_source: 'odometer' });
    expect(res.body.data.actual_distance_km).toBeCloseTo(50, 1);

    const phone = await underWay(60);
    await positions(phone.vehicle, phone.trip, drive(58, 2, (km) => ({ odometer: 80_000 + km * 2 })));
    expect((await end(await signIn(['admin']), phone.trip)).body.data.actual_distance_source).toBe('gps');
  });

  test('counts positions of this trip, or of none, between its start and end; not those of other trips or outside it', async () => {
    const s = await underWay(60);
    await positions(s.vehicle, s.trip, [
      ...drive(50, 20),
      { minutesAgo: 90, km: -30 }, // before the start
      { minutesAgo: 19, km: 20.7, tripId: null }, // stored with no trip: still this vehicle, during this trip
    ]);
    const res = await end(await signIn(['admin']), s.trip);
    expect(res.body.data.actual_distance_km).toBeCloseTo(20.7, 1);
    expect((await stored(s.trip)).points).toBe(32);
  });

  test('with no positions the trip has no distance, but is recorded as measured', async () => {
    const s = await underWay(60);
    const res = await end(await signIn(['admin']), s.trip);
    expect(res.body.data).toMatchObject({ actual_distance_km: null, actual_distance_source: null });
    expect(await stored(s.trip)).toMatchObject({ km: null, source: null, points: 0, measured_at: expect.any(Date) });
  });

  test("the driver performance report counts the distance of a trip ended through the API, never set directly", async () => {
    const s = await underWay(60);
    await positions(s.vehicle, s.trip, drive(59, 1));
    await end(await signIn(['admin']), s.trip);
    const month = addisDate(0, s.started).slice(0, 7);
    const report = await request(app).get(`/api/v1/reports/drivers?month=${month}&depot_id=${s.depot.public_id}`).set('Cookie', await signIn(['admin']));
    expect(report.status).toBe(200);
    expect(report.body.data.rows).toHaveLength(1);
    expect(report.body.data.rows[0].distance_m).toBeGreaterThan(38_000);
  });
});

describe('the trip-distance job and the backfill (FMS-145)', () => {
  test('positions that arrive after the end (a phone that was offline) are measured in; a second run changes nothing', async () => {
    const s = await underWay(60);
    await positions(s.vehicle, s.trip, drive(59, 40));
    const ended = await end(await signIn(['admin']), s.trip);
    expect(ended.body.data.actual_distance_km).toBeCloseTo((40 * 19) / 60, 1);

    await positions(s.vehicle, s.trip, drive(39, 1).map((p) => ({ ...p, km: p.km + (40 * 20) / 60 })));
    const first = await tripDistance.remeasureRecent('00000000-0000-4000-8000-000000000145');
    expect(first.measured).toBeGreaterThanOrEqual(1);
    expect(await stored(s.trip)).toMatchObject({ source: 'gps', points: 59 });
    expect((await stored(s.trip)).km).toBeCloseTo((40 * 58) / 60, 1);

    const again = await tripDistance.remeasureRecent('00000000-0000-4000-8000-000000000146');
    const audits = await pool.query("SELECT count(*)::int AS n FROM audit.audit_logs WHERE entity_type = 'trip.trips' AND entity_id = $1 AND action = 'UPDATE'", [s.trip.id]);
    expect(audits.rows[0].n).toBe(2); // the end, and the one re-measure
    expect(again.checked).toBeGreaterThanOrEqual(1);
  });

  test('the backfill measures completed trips never measured, once, and leaves a distance entered before (the seed) alone', async () => {
    const s = await underWay(60);
    await positions(s.vehicle, s.trip, drive(59, 1));
    await pool.query("UPDATE trip.trips SET status = 'completed', actual_end = $2 WHERE id = $1", [s.trip.id, ago(0)]);
    const seeded = await underWay(60);
    await pool.query("UPDATE trip.trips SET status = 'completed', actual_end = $2, actual_distance_km = 123.4 WHERE id = $1", [seeded.trip.id, ago(0)]);

    const first = await tripDistance.backfill('00000000-0000-4000-8000-000000000147');
    expect(first.bySource.gps).toBeGreaterThanOrEqual(1);
    expect((await stored(s.trip)).km).toBeCloseTo((40 * 58) / 60, 1);
    expect(await stored(seeded.trip)).toMatchObject({ km: 123.4, source: null, measured_at: null });

    const second = await tripDistance.backfill('00000000-0000-4000-8000-000000000148');
    expect(second.checked).toBe(0);
    // The job leaves the seeded distance alone too.
    await tripDistance.remeasureRecent('00000000-0000-4000-8000-000000000149');
    expect(await stored(seeded.trip)).toMatchObject({ km: 123.4, source: null, measured_at: null });
  });
});

import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { createDepot, createDriver, createUser, createVehicle, type RoleName } from '../support/factories';

// FMS-156: a driver is never assigned a trip that takes their load-weighted distance past their depot's daily or weekly
// limit (docs/driving-distance-limits.md). A safety rule: never held for approval, and never stops a trip under way.

const app = createApp();
const PASSWORD = 'Distance-Test-1';

type Depot = Awaited<ReturnType<typeof createDepot>>;
type Row = Record<string, unknown> & { id: string; public_id: string };

async function account(roles: RoleName[], depot: Depot | null = null) {
  const user = await createUser({ roles, depot, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return { user, cookie: (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ') };
}

const api = (cookie: string) => ({
  post: (path: string, body: object = {}) => request(app).post(`/api/v1${path}`).set('Cookie', cookie).send(body),
  patch: (path: string, body: object) => request(app).patch(`/api/v1${path}`).set('Cookie', cookie).send(body),
  put: (path: string, body: object) => request(app).put(`/api/v1${path}`).set('Cookie', cookie).send(body),
  get: (path: string) => request(app).get(`/api/v1${path}`).set('Cookie', cookie),
});

/** Addis Ababa local time (UTC+3), as the API takes it. Thursday 12 November 2026 is in the week of Monday 9 to Sunday 15. */
const addis = (local: string) => new Date(`${local}+03:00`).toISOString();

/**
 * A trip of the depot, three hours from `start` (Addis Ababa), of `km` planned. Below 300 km and four hours its job is
 * standard (FMS-153: 100 km or more is one point), below 100 km light; a weight of 1 and 0.8 at the defaults.
 */
async function trip(depot: Depot, start: string, km: number, extra: Record<string, unknown> = {}) {
  const route = (await pool.query<Row>("INSERT INTO trip.routes (name, depot_id) VALUES ('Addis Ababa - Adama ' || gen_random_uuid(), $1) RETURNING *", [depot.id])).rows[0];
  const from = new Date(addis(start));
  const columns = { route_id: route.id, status: 'scheduled', scheduled_start: from.toISOString(), scheduled_end: new Date(from.getTime() + 3 * 3_600_000).toISOString(), planned_distance_km: km, ...extra };
  const names = Object.keys(columns);
  return (
    await pool.query<Row>(
      `INSERT INTO trip.trips (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      Object.values(columns),
    )
  ).rows[0];
}

/** A depot with its own limits (so the fleet's, which other tests change, do not matter), its dispatcher, a truck and a truck driver. */
async function setup(limits: { daily?: number; weekly?: number; heavy?: number } = {}) {
  const depot = await createDepot();
  await pool.query('INSERT INTO tracking.rule_thresholds (depot_id, daily_distance_km, weekly_distance_km, distance_weight_heavy) VALUES ($1, $2, $3, $4)', [
    depot.id,
    limits.daily ?? 500,
    limits.weekly ?? 2500,
    limits.heavy ?? 1.5,
  ]);
  const dispatcher = await account(['dispatcher'], depot);
  const vehicle = (await createVehicle({ depot })) as Row;
  const other = (await createVehicle({ depot })) as Row;
  const driver = (await createDriver({ depot, license_categories: ['dry_cargo_2'] })).driver as Row;
  return { depot, dispatcher, vehicle, other, driver, as: api(dispatcher.cookie) };
}

describe('the driving distance limits (FMS-156)', () => {
  test('refused just over the daily limit, allowed exactly on it, with the period, the limit and both totals', async () => {
    const s = await setup();
    // Driven this morning: planned 200, measured 250 (counted), standard.
    await trip(s.depot, '2026-11-12T05:00:00', 200, { status: 'completed', driver_id: s.driver.id, vehicle_id: s.other.id, actual_distance_km: 250 });
    const exactly = await trip(s.depot, '2026-11-12T09:00:00', 250);
    const assign = (t: Row) => s.as.post(`/trips/${t.public_id}/assign`, { driver_id: s.driver.public_id, vehicle_id: s.vehicle.public_id, version: 0 });

    // 250 + 250 is 500 of 500: allowed.
    expect((await assign(exactly)).status).toBe(200);

    // A light 1 km more counts 0.8: over.
    const over = await trip(s.depot, '2026-11-12T13:00:00', 1);
    const refused = await assign(over);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({
      code: 'CONFLICT_DRIVER_DISTANCE_LIMIT',
      message: "Would drive 500.8 of 500 km today: the driver's daily distance limit.",
      details: [{ field: 'driver_id', reason: 'distance_limit', period: 'day', limit_km: 500, total_km: 500.8, without_trip_km: 500 }],
    });
    expect((await pool.query('SELECT status, driver_id FROM trip.trips WHERE id = $1', [over.id])).rows[0]).toEqual({ status: 'scheduled', driver_id: null });

    // Tomorrow is a new day.
    const tomorrow = await trip(s.depot, '2026-11-13T09:00:00', 1);
    expect((await assign(tomorrow)).status).toBe(200);
  });

  test("a depot's own limits and weights: the week Monday to Sunday, a heavy job counting more", async () => {
    const s = await setup({ daily: 1000, weekly: 1200, heavy: 2 });
    // Monday, not measured: its 600 km planned count. A long haul over five hours is heavy (FMS-153), so 600 x 2 = 1200.
    await trip(s.depot, '2026-11-09T05:00:00', 600, { status: 'completed', driver_id: s.driver.id, vehicle_id: s.other.id, planned_duration_seconds: 5 * 3600 });
    const assign = (t: Row) => s.as.post(`/trips/${t.public_id}/assign`, { driver_id: s.driver.public_id, vehicle_id: s.vehicle.public_id, version: 0 });

    // A light 50 km on Thursday counts 40: 1240 of 1200 this week.
    const thursday = await trip(s.depot, '2026-11-12T09:00:00', 50);
    const refused = await assign(thursday);
    expect(refused.status).toBe(409);
    expect(refused.body.error.details).toEqual([{ field: 'driver_id', reason: 'distance_limit', period: 'week', limit_km: 1200, total_km: 1240, without_trip_km: 1200 }]);

    // The next Monday starts a new week.
    const monday = await trip(s.depot, '2026-11-16T09:00:00', 50);
    expect((await assign(monday)).status).toBe(200);
  });

  test('a time change re-checks the rule; a trip under way is never stopped by it', async () => {
    const s = await setup();
    await trip(s.depot, '2026-11-11T05:00:00', 280, { status: 'assigned', driver_id: s.driver.id, vehicle_id: s.other.id }); // Wednesday: 280
    const thursday = await trip(s.depot, '2026-11-12T09:00:00', 280, { status: 'assigned', driver_id: s.driver.id, vehicle_id: s.vehicle.id });

    // Moved to Wednesday afternoon: 560 of 500. Refused, and nothing moves.
    const moved = await s.as.patch(`/trips/${thursday.public_id}`, { scheduled_start: addis('2026-11-11T12:00:00'), scheduled_end: addis('2026-11-11T15:00:00'), reason: 'Customer asked' });
    expect(moved.status).toBe(409);
    expect(moved.body.error).toMatchObject({ code: 'CONFLICT_DRIVER_DISTANCE_LIMIT', message: expect.stringMatching(/^Would drive 560 of 500 km today/) });
    expect((await pool.query('SELECT scheduled_start FROM trip.trips WHERE id = $1', [thursday.id])).rows[0].scheduled_start.toISOString()).toBe(addis('2026-11-12T09:00:00'));

    // Friday instead: fine.
    expect((await s.as.patch(`/trips/${thursday.public_id}`, { scheduled_start: addis('2026-11-13T09:00:00'), scheduled_end: addis('2026-11-13T12:00:00'), reason: 'Customer asked' })).status).toBe(200);

    // Under way, a trip whose end moves past the limit is not stopped: the rule decides assignments.
    const underWay = await trip(s.depot, '2026-11-14T05:00:00', 499, { status: 'en_route', driver_id: s.driver.id, vehicle_id: s.other.id, actual_start: addis('2026-11-14T05:00:00') });
    await pool.query('UPDATE tracking.rule_thresholds SET daily_distance_km = 100 WHERE depot_id = $1', [s.depot.id]);
    expect((await s.as.patch(`/trips/${underWay.public_id}`, { scheduled_end: addis('2026-11-14T10:00:00'), reason: 'Road works' })).status).toBe(200);
  });

  test('never held for approval: a held warning with a reason still refuses past the limit', async () => {
    const s = await setup({ daily: 100 });
    await pool.query("UPDATE tracking.rule_thresholds SET attendance_exception = 'approve' WHERE depot_id = $1", [s.depot.id]);
    const clerk = await createUser({ roles: ['depot_admin'], depot: s.depot });
    await pool.query("INSERT INTO fleet.driver_attendance (driver_id, attendance_date, status, logged_by) VALUES ($1, '2026-11-12', 'absent', $2)", [s.driver.id, clerk.id]);
    const long = await trip(s.depot, '2026-11-12T09:00:00', 150);
    const res = await s.as.post(`/trips/${long.public_id}/assign`, { driver_id: s.driver.public_id, vehicle_id: s.vehicle.public_id, version: 0, exception_reason: 'Nobody else' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT_DRIVER_DISTANCE_LIMIT');
    expect((await pool.query('SELECT count(*)::int AS n FROM trip.assignment_exceptions WHERE trip_id = $1', [long.id])).rows[0].n).toBe(0);
  });

  test('the dispatch console: over the limit unavailable with the reason, near it a warning, below it what is left', async () => {
    const s = await setup();
    const near = (await createDriver({ depot: s.depot, license_categories: ['dry_cargo_2'] })).driver as Row;
    const fresh = (await createDriver({ depot: s.depot, license_categories: ['dry_cargo_2'] })).driver as Row;
    await trip(s.depot, '2026-11-12T05:00:00', 280, { status: 'completed', driver_id: s.driver.id, vehicle_id: s.other.id, actual_distance_km: 280 });
    await trip(s.depot, '2026-11-12T01:00:00', 150, { status: 'assigned', driver_id: near.id, vehicle_id: s.other.id });
    await trip(s.depot, '2026-11-10T09:00:00', 900, { status: 'completed', driver_id: fresh.id, vehicle_id: s.other.id, actual_distance_km: 720, planned_duration_seconds: 10 * 3600 });
    const staffing = await trip(s.depot, '2026-11-12T09:00:00', 250);

    const res = await s.as.get(
      `/dispatch/availability?${new URLSearchParams({ depot_id: String(s.depot.public_id), exclude_trip_id: staffing.public_id, from: addis('2026-11-12T09:00:00'), to: addis('2026-11-12T12:00:00') })}`,
    );
    expect(res.status).toBe(200);
    const byId = new Map((res.body.data.drivers as { driver_id: string }[]).map((d) => [d.driver_id, d as Record<string, unknown>]));

    expect(byId.get(s.driver.public_id)).toMatchObject({
      state: 'unavailable',
      availability: { availability: 'unavailable', reasons: [{ code: 'distance_limit', severity: 'block', period: 'day', limit_km: 500, total_km: 530 }] },
      distance: { trip_km: 250, day: { with_km: 530, left_km: -30 }, over: { period: 'day' } },
    });
    expect(byId.get(near.public_id)).toMatchObject({
      availability: { availability: 'available_with_warning', reasons: [{ code: 'distance_limit_near', severity: 'warning', period: 'day', total_km: 400 }] },
      distance: { day: { left_km: 100 }, over: null },
    });
    // 900 planned over ten hours, heavy (1.5), and 720 measured: 1080 this week; 250 today.
    expect(byId.get(fresh.public_id)).toMatchObject({
      availability: { availability: 'available', reasons: [] },
      distance: { day: { without_km: 0, with_km: 250, left_km: 250 }, week: { without_km: 1080, with_km: 1330, left_km: 1170 }, over: null, near: null },
    });

    // Without a trip, no distance.
    const plain = await s.as.get(`/dispatch/availability?${new URLSearchParams({ depot_id: String(s.depot.public_id) })}`);
    expect((plain.body.data.drivers as { distance: unknown }[]).every((d) => d.distance === null)).toBe(true);
  });

  test('the limits and weights are driving rules: audited, ranges checked, a week at least a day, heavier never lighter', async () => {
    const depot = await createDepot();
    const admin = api((await account(['admin'])).cookie);
    const base = { speed_limit_kmh: 80, speeding_pings: 3, clear_pings: 3, idle_minutes: 10 };
    const path = `/settings/telemetry-rules/depots/${depot.public_id}`;

    const set = await admin.put(path, { ...base, daily_distance_km: 600, weekly_distance_km: 3000, distance_weight_light: 0.75, distance_weight_standard: 1, distance_weight_heavy: 1.6 });
    expect(set.status).toBe(200);
    expect(set.body.data.depots).toEqual([
      expect.objectContaining({ depot_id: depot.public_id, daily_distance_km: 600, weekly_distance_km: 3000, distance_weight_light: 0.75, distance_weight_standard: 1, distance_weight_heavy: 1.6 }),
    ]);
    const audit = await pool.query("SELECT new_values FROM audit.audit_logs WHERE correlation_id = $1 AND entity_type = 'tracking.rule_thresholds'", [set.headers['x-request-id']]);
    expect(audit.rows[0].new_values).toMatchObject({ daily_distance_km: 600, weekly_distance_km: 3000 });

    // Left out, they keep the row's.
    expect((await admin.put(path, { ...base, idle_minutes: 12 })).body.data.depots[0]).toMatchObject({ idle_minutes: 12, daily_distance_km: 600, distance_weight_heavy: 1.6 });

    for (const [body, field] of [
      [{ daily_distance_km: 40 }, 'daily_distance_km'],
      [{ weekly_distance_km: 20_000 }, 'weekly_distance_km'],
      [{ distance_weight_heavy: 3.5 }, 'distance_weight_heavy'],
      [{ distance_weight_light: 0.755 }, 'distance_weight_light'],
      [{ daily_distance_km: 800, weekly_distance_km: 700 }, 'weekly_distance_km'],
      [{ distance_weight_light: 1.2 }, 'distance_weight_light'],
      [{ distance_weight_heavy: 0.9 }, 'distance_weight_heavy'],
    ] as const) {
      const res = await admin.put(path, { ...base, ...body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.details.map((d: { field: string }) => d.field), JSON.stringify(body)).toContain(field);
    }
  });
});

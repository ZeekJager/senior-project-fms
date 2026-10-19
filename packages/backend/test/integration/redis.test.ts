import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createApp } from '../../src/app';
import { config } from '../../src/config';
import { pool } from '../../src/db';
import { VehicleRepository } from '../../src/modules/fleet/infrastructure/vehicle.repository';
import { cache, redis, redisKey } from '../../src/shared/cache';
import { PostgresJobLock } from '../../src/shared/jobs/job-lock';
import { RedisJobLock } from '../../src/shared/jobs/redis-job-lock';
import { deliverEvents } from '../support/events';
import { createDepot, createDriver, createUser, createVehicle, type RoleName } from '../support/factories';

// FMS-72 against a real Redis. CI starts one (scripts/ci/start-redis.sh);
// locally, set REDIS_HOST/REDIS_PORT/REDIS_PASSWORD to run these.
const configured = Boolean(config.redis);
if (process.env.CI && !configured) throw new Error('Redis tests must run in CI: set REDIS_HOST for the backend job.');

const app = createApp();
const PASSWORD = 'Cache-Test-1';

type Depot = Awaited<ReturnType<typeof createDepot>>;

async function signIn(roles: RoleName[], depot: Depot | null = null) {
  const user = await createUser({ roles, depot, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

const vehicleKey = (publicId: string) => cache.key('fleet', 'vehicle', publicId);

async function waitFor(check: () => Promise<boolean>, ms = 3000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('condition not met in time');
}

afterEach(() => vi.restoreAllMocks());

describe.skipIf(!configured)('vehicle cache', () => {
  test('a cached vehicle read skips PostgreSQL on the second call', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const cookie = await signIn(['admin']);
    const reads = vi.spyOn(VehicleRepository.prototype, 'findViewWithDepot');

    const first = await request(app).get(`/api/v1/vehicles/${vehicle.public_id}`).set('Cookie', cookie);
    const second = await request(app).get(`/api/v1/vehicles/${vehicle.public_id}`).set('Cookie', cookie);
    expect(first.status).toBe(200);
    expect(second.body.data).toEqual(first.body.data);
    expect(second.headers.etag).toBe(first.headers.etag);
    expect(reads).toHaveBeenCalledTimes(1);

    const ttl = await redis!.ttl(vehicleKey(String(vehicle.public_id)));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
    // No internal id leaves the server: the cached depot id is only in Redis.
    expect(JSON.stringify(second.body)).not.toContain('"depotId"');
  });

  test('updating the vehicle invalidates its key', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const cookie = await signIn(['admin']);
    const id = String(vehicle.public_id);
    await request(app).get(`/api/v1/vehicles/${id}`).set('Cookie', cookie);
    expect(await redis!.exists(vehicleKey(id))).toBe(1);

    const patched = await request(app).patch(`/api/v1/vehicles/${id}`).set('Cookie', cookie).send({ model: 'FVZ' });
    expect(patched.status).toBe(200);
    expect(await redis!.exists(vehicleKey(id))).toBe(0);
    const after = await request(app).get(`/api/v1/vehicles/${id}`).set('Cookie', cookie);
    expect(after.body.data.model).toBe('FVZ');
  });

  test('the depot scope holds for a cached vehicle, without reading PostgreSQL', async () => {
    const [mine, other] = [await createDepot(), await createDepot()];
    const vehicle = await createVehicle({ depot: mine });
    await request(app).get(`/api/v1/vehicles/${vehicle.public_id}`).set('Cookie', await signIn(['admin']));
    const reads = vi.spyOn(VehicleRepository.prototype, 'findViewWithDepot');

    expect((await request(app).get(`/api/v1/vehicles/${vehicle.public_id}`).set('Cookie', await signIn(['depot_admin'], mine))).status).toBe(200);
    expect((await request(app).get(`/api/v1/vehicles/${vehicle.public_id}`).set('Cookie', await signIn(['depot_admin'], other))).status).toBe(404);
    expect(reads).not.toHaveBeenCalled();
  });

  test('a maintenance record that flags the vehicle drops its cached view', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const cookie = await signIn(['admin']);
    const id = String(vehicle.public_id);
    expect((await request(app).get(`/api/v1/vehicles/${id}`).set('Cookie', cookie)).body.data.maintenance_flag).toBe(false);

    const opened = await request(app)
      .post('/api/v1/maintenance')
      .set('Cookie', cookie)
      .send({ vehicle_id: id, description: 'Brakes squeal', labour_hours: 1, total_cost_cents: 50000, status: 'open' });
    expect(opened.status).toBe(201);
    // Dropped when the relay delivers MaintenanceRecordOpened (fleet.vehicle-cache), after commit.
    expect(await redis!.exists(vehicleKey(id))).toBe(1);
    await deliverEvents();
    expect(await redis!.exists(vehicleKey(id))).toBe(0);
    expect((await request(app).get(`/api/v1/vehicles/${id}`).set('Cookie', cookie)).body.data.maintenance_flag).toBe(true);
  });

  test('assigning a trip drops the cached vehicle and the one it replaced, so the current trip shows', async () => {
    const depot = await createDepot();
    const [first, second] = [await createVehicle({ depot }), await createVehicle({ depot })];
    const { driver } = await createDriver({ depot, license_categories: ['C'] });
    const route = (await pool.query("INSERT INTO trip.routes (name, depot_id) VALUES ('Cache route ' || gen_random_uuid(), $1) RETURNING id", [depot.id])).rows[0];
    const start = new Date(Date.now() + 60 * 60 * 1000);
    const trip = (
      await pool.query("INSERT INTO trip.trips (route_id, status, scheduled_start, scheduled_end) VALUES ($1, 'scheduled', $2, $3) RETURNING public_id", [
        route.id,
        start,
        new Date(start.getTime() + 2 * 60 * 60 * 1000),
      ])
    ).rows[0];
    const cookie = await signIn(['admin']);
    const view = (vehicle: Record<string, unknown>) => request(app).get(`/api/v1/vehicles/${String(vehicle.public_id)}`).set('Cookie', cookie);
    expect((await view(first)).body.data.current_trip).toBeNull();

    const assign = (vehicle: Record<string, unknown>, version: number) =>
      request(app).post(`/api/v1/trips/${trip.public_id}/assign`).set('Cookie', cookie).send({ driver_id: driver.public_id, vehicle_id: vehicle.public_id, version });
    expect((await assign(first, 0)).status).toBe(200);
    await deliverEvents();
    expect((await view(first)).body.data.current_trip).toMatchObject({ id: trip.public_id, status: 'assigned' });

    // Moved to the second vehicle: the first, cached with the trip, is dropped too.
    expect((await view(second)).body.data.current_trip).toBeNull();
    expect((await assign(second, 1)).status).toBe(200);
    await deliverEvents();
    expect(await redis!.exists(vehicleKey(String(first.public_id)))).toBe(0);
    expect((await view(first)).body.data.current_trip).toBeNull();
    expect((await view(second)).body.data.current_trip).toMatchObject({ id: trip.public_id });
  });
});

describe.skipIf(!configured)('cache helper', () => {
  test('miss loads and stores, hit skips the loader, invalidate drops by pattern; revive restores Dates', async () => {
    const ns = `helper-${randomUUID()}`;
    const loader = vi.fn(async () => ({ at: new Date('2026-10-10T07:00:00Z'), n: 1 }));
    const revive = (raw: unknown) => ({ ...(raw as { at: string; n: number }), at: new Date((raw as { at: string }).at) });
    const first = await cache.getOrSet(cache.key(ns, 'a'), 30, loader, revive);
    const second = await cache.getOrSet(cache.key(ns, 'a'), 30, loader, revive);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(second.at).toBeInstanceOf(Date);

    await cache.getOrSet(cache.key(ns, 'b'), 30, loader);
    expect(await cache.invalidate(`${ns}:*`)).toBe(2);
    expect(await redis!.exists(cache.key(ns, 'a'), cache.key(ns, 'b'))).toBe(0);
    expect(cache.key('fleet', 'vehicle', 'x')).toBe(`${config.redis!.keyPrefix}:cache:fleet:vehicle:x`);
  });
});

describe.skipIf(!configured)('login throttle in Redis', () => {
  test('failures are counted in Redis under a hashed key; the sixth attempt is 429', async () => {
    const user = await createUser({ password: PASSWORD });
    const email = String(user.email);
    for (let i = 0; i < 5; i++) {
      expect((await request(app).post('/api/v1/auth/login').send({ email, password: 'wrong-password' })).status).toBe(401);
    }
    expect((await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD })).status).toBe(429);

    // One sorted set per account and address, named by a SHA-256: no email in Redis.
    const keys = await redis!.keys(redisKey('throttle', 'login', '*'));
    expect(keys.every((k) => /:[0-9a-f]{64}$/.test(k) && !k.includes(email))).toBe(true);
    expect(await Promise.all(keys.map((k) => redis!.zcard(k)))).toContain(5);
  });
});

describe.skipIf(!configured)('job lock in Redis', () => {
  test('a second instance is turned away by the lease, without touching PostgreSQL; the lease goes with the run', async () => {
    const runs = new PostgresJobLock(pool);
    const pgClaims = vi.spyOn(runs, 'claim');
    const keyFor = (job: string, day: string) => redisKey('lock', 'job', job, day);
    const [a, b] = [new RedisJobLock(redis!, runs, keyFor), new RedisJobLock(redis!, runs, keyFor)];
    const input = { jobName: `redis-lock-${randomUUID()}`, runKey: '2026-10-10', leaseMs: 60_000, maxAttempts: 5 };

    const claim = await a.claim({ ...input, instanceId: 'a', correlationId: randomUUID() });
    expect(claim).not.toBeNull();
    expect(await b.claim({ ...input, instanceId: 'b', correlationId: randomUUID() })).toBeNull();
    expect(pgClaims).toHaveBeenCalledTimes(1);

    await a.succeed(claim!, { ok: true });
    expect(await redis!.exists(keyFor(input.jobName, input.runKey))).toBe(0);
    // Free in Redis, but the day's run is done: PostgreSQL still says no.
    expect(await b.claim({ ...input, instanceId: 'b', correlationId: randomUUID() })).toBeNull();
  });
});

describe.skipIf(!configured)('Redis stopped', () => {
  test('reads go straight to PostgreSQL, logins are still throttled, /health/ready reports it; on reconnect the cache is dropped', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const cookie = await signIn(['admin']);
    const id = String(vehicle.public_id);
    await request(app).get(`/api/v1/vehicles/${id}`).set('Cookie', cookie);
    expect(await redis!.exists(vehicleKey(id))).toBe(1);

    redis!.disconnect();
    try {
      await waitFor(async () => redis!.status === 'end');
      const reads = vi.spyOn(VehicleRepository.prototype, 'findViewWithDepot');
      const res = await request(app).get(`/api/v1/vehicles/${id}`).set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(res.body.data.id).toBe(id);
      expect(reads).toHaveBeenCalledTimes(1);

      const ready = await request(app).get('/health/ready');
      expect(ready.status).toBe(200);
      expect(ready.body).toMatchObject({ status: 'degraded', checks: { database: 'ok', redis: 'degraded' } });

      // The in-memory throttle stands in.
      const user = await createUser({ password: PASSWORD });
      for (let i = 0; i < 5; i++) await request(app).post('/api/v1/auth/login').send({ email: user.email, password: 'wrong-password' });
      expect((await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD })).status).toBe(429);
    } finally {
      await redis!.connect();
    }
    // Writes during the outage could not invalidate: everything cached before it is gone.
    await waitFor(async () => (await redis!.exists(vehicleKey(id))) === 0);
    expect((await request(app).get('/health/ready')).body.checks.redis).toBe('ok');
  });
});

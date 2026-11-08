import { Client } from 'pg';
import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { config } from '../../src/config';
import { pool } from '../../src/db';
import { integrationModule } from '../../src/modules/integration';
import { runJob } from '../../src/shared/jobs/scheduler';
import { PostgresJobLock } from '../../src/shared/jobs/job-lock';
import { setDataKey } from '../../src/shared/infrastructure/data-key';
import { createDepot, createUser, createVehicle, type RoleName } from '../support/factories';

// FMS-104: driver data protection (docs/driver-data-protection.md).

const DAY = 86_400_000;
const NOW = new Date('2026-11-10T03:30:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY);

describe('retention of GPS pings and telemetry flags', () => {
  const job = integrationModule.jobs!.find((j) => j.name === 'tracking-retention')!;
  async function ping(vehicleId: unknown, at: Date) {
    await pool.query('INSERT INTO tracking.gps_pings (vehicle_id, latitude, longitude, speed_kmh, recorded_at) VALUES ($1, 9.01, 38.76, 0, $2)', [vehicleId, at]);
  }
  async function flag(vehicleId: unknown, at: Date) {
    await pool.query("INSERT INTO tracking.telemetry_flags (vehicle_id, flag_type, observed_at, resolved_at) VALUES ($1, 'speeding', $2, $2::timestamptz + interval '1 hour')", [vehicleId, at]);
  }
  test('the defaults keep pings 180 days and flags a year', () => {
    expect(config.tracking.retention).toEqual({ pingDays: 180, flagDays: 365 });
  });

  test('older pings and flags are deleted, newer ones kept, exactly at the cutoff', async () => {
    const vehicle = await createVehicle({ depot: await createDepot() });
    const { pingDays, flagDays } = config.tracking.retention;
    await ping(vehicle.id, daysAgo(pingDays + 30)); // gone
    await ping(vehicle.id, new Date(daysAgo(pingDays).getTime() - 1000)); // a second past the cutoff: gone
    await ping(vehicle.id, new Date(daysAgo(pingDays).getTime() + 1000)); // a second inside: kept
    await ping(vehicle.id, daysAgo(1)); // kept
    await flag(vehicle.id, daysAgo(flagDays + 10)); // gone
    await flag(vehicle.id, daysAgo(flagDays - 10)); // kept
    await flag(vehicle.id, daysAgo(2)); // kept

    const outcome = await runWithNow();
    expect(outcome.result).toMatchObject({ pings_deleted: expect.any(Number), flags_deleted: expect.any(Number) });
    const left = async (table: string, column: string) =>
      (await pool.query<{ at: Date }>(`SELECT ${column} AS at FROM ${table} WHERE vehicle_id = $1 ORDER BY ${column}`, [vehicle.id])).rows.map((r) => r.at.getTime());
    expect(await left('tracking.gps_pings', 'recorded_at')).toEqual([daysAgo(pingDays).getTime() + 1000, daysAgo(1).getTime()]);
    expect(await left('tracking.telemetry_flags', 'observed_at')).toEqual([daysAgo(flagDays - 10).getTime(), daysAgo(2).getTime()]);
  });

  test('the run reports counts, not data, on its audit entry, and a second run has nothing to delete', async () => {
    const vehicle = await createVehicle({ depot: await createDepot() });
    await ping(vehicle.id, daysAgo(config.tracking.retention.pingDays + 5));
    await ping(vehicle.id, daysAgo(config.tracking.retention.pingDays + 6));
    const first = await runWithNow();
    expect(first.result.pings_deleted).toBeGreaterThanOrEqual(2);
    const audited = await pool.query("SELECT details FROM audit.audit_logs WHERE action = 'job.succeeded' AND correlation_id = $1", [first.correlationId]);
    expect(JSON.stringify(audited.rows[0].details)).not.toMatch(/38\.76|9\.01|latitude|longitude/);
    expect(audited.rows[0].details).toMatchObject({ result: { pings_deleted: first.result.pings_deleted } });
    const second = await runWithNow();
    expect(second.result).toMatchObject({ pings_deleted: 0, flags_deleted: 0 });
  });

  test('a vehicle’s latest known position is not removed with its old pings', async () => {
    const vehicle = await createVehicle({ depot: await createDepot() });
    await ping(vehicle.id, daysAgo(1));
    await ping(vehicle.id, daysAgo(config.tracking.retention.pingDays + 20));
    const before = (await pool.query('SELECT count(*)::int AS n FROM tracking.vehicle_current_location WHERE vehicle_id = $1', [vehicle.id])).rows[0].n;
    await runWithNow();
    const after = (await pool.query('SELECT count(*)::int AS n FROM tracking.vehicle_current_location WHERE vehicle_id = $1', [vehicle.id])).rows[0].n;
    expect(after).toBe(before);
  });

  /** Runs the job as of NOW, with the run's result and correlation id. */
  async function runWithNow() {
    const outcome = await runJob(
      { ...job, name: `tracking-retention-${Math.random()}` },
      { lock: new PostgresJobLock(pool), audit: pool, timeZone: 'Africa/Addis_Ababa', instanceId: 'test', now: () => NOW },
    );
    if (outcome.status !== 'succeeded') throw new Error(`job ${outcome.status}`);
    return { result: outcome.result as Record<string, number>, correlationId: outcome.correlationId };
  }
});

describe('licence and phone numbers are encrypted at rest (migration 063)', () => {
  const app = createApp();
  const PASSWORD = 'Protect-Test-1';
  const api = {
    get: (path: string, cookie: string) => request(app).get(`/api/v1${path}`).set('Cookie', cookie),
    post: (path: string, body: object, cookie: string) => request(app).post(`/api/v1${path}`).set('Cookie', cookie).send(body),
    patch: (path: string, body: object, cookie: string) => request(app).patch(`/api/v1${path}`).set('Cookie', cookie).send(body),
  };

  async function signIn(roles: RoleName[], depot: { id: string } | null) {
    const user = await createUser({ roles, depot, password: PASSWORD });
    const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
    expect(res.status).toBe(200);
    return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
  }

  async function newDriver(cookie: string, depot: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const user = await createUser({ roles: ['driver'], depot: depot as { id: string }, password: PASSWORD });
    const res = await api.post('/drivers', { user_id: user.public_id, license_expiry: '2030-06-30', depot_id: depot.public_id, ...extra }, cookie);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { user, res, id: res.body.data.id as string };
  }

  const raw = async (driverPublicId: string) =>
    (await pool.query('SELECT license_number, license_number_idx, emergency_phone FROM fleet.drivers WHERE public_id = $1', [driverPublicId])).rows[0] as {
      license_number: string;
      license_number_idx: string;
      emergency_phone: string | null;
    };

  test('the stored licence number and phones are ciphertext; the API still returns them in the clear', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['depot_admin'], depot);
    const { id } = await newDriver(cookie, depot, { license_number: 'ET-ENC-0001', emergency_phone: '+251 911 555 0001' });

    const stored = await raw(id);
    expect(stored.license_number).toMatch(/^enc:v1:/);
    expect(stored.license_number).not.toContain('ET-ENC-0001');
    expect(stored.emergency_phone).toMatch(/^enc:v1:/);
    expect(stored.emergency_phone).not.toContain('911');
    expect(stored.license_number_idx).toMatch(/^[0-9a-f]{64}$/);

    const read = await api.get(`/drivers/${id}`, cookie);
    expect(read.status).toBe(200);
    expect(read.body.data).toMatchObject({ license_number: 'ET-ENC-0001', emergency_phone: '+251 911 555 0001' });
  });

  test('a user’s phone is stored encrypted and read back in the clear', async () => {
    const depot = await createDepot();
    const admin = await signIn(['admin'], null);
    const user = await createUser({ roles: ['dispatcher'], depot, password: PASSWORD });
    const set = await api.patch(`/users/${String(user.public_id)}`, { phone: '+251 922 000 104' }, admin);
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const stored = (await pool.query('SELECT phone FROM auth.users WHERE public_id = $1', [user.public_id])).rows[0].phone as string;
    expect(stored).toMatch(/^enc:v1:/);
    expect(stored).not.toContain('922');
    const read = await api.get(`/users/${String(user.public_id)}`, admin);
    expect(read.body.data.phone).toBe('+251 922 000 104');
  });

  test('the audit trail holds the ciphertext, not the number', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['depot_admin'], depot);
    const { res } = await newDriver(cookie, depot, { license_number: 'ET-AUDIT-7777', emergency_phone: '+251 933 777 777' });
    const rows = await pool.query("SELECT coalesce(old_values::text, '') || coalesce(new_values::text, '') || coalesce(details::text, '') AS body FROM audit.audit_logs WHERE correlation_id = $1", [
      res.headers['x-request-id'],
    ]);
    expect(rows.rowCount).toBeGreaterThan(0);
    for (const r of rows.rows) {
      expect(r.body).not.toContain('ET-AUDIT-7777');
      expect(r.body).not.toContain('933 777 777');
    }
  });

  test('changing the licence re-encrypts it and moves its blind index; a duplicate is still refused', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['depot_admin'], depot);
    const first = await newDriver(cookie, depot, { license_number: 'ET-CHG-0001' });
    const before = await raw(first.id);
    const changed = await api.patch(`/drivers/${first.id}`, { license_number: 'ET-CHG-0002' }, cookie);
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    const after = await raw(first.id);
    expect(after.license_number).not.toBe(before.license_number);
    expect(after.license_number_idx).not.toBe(before.license_number_idx);
    expect((await api.get(`/drivers/${first.id}`, cookie)).body.data.license_number).toBe('ET-CHG-0002');

    const user = await createUser({ roles: ['driver'], depot, password: PASSWORD });
    const dup = await api.post('/drivers', { user_id: user.public_id, license_number: 'ET-CHG-0002', license_expiry: '2030-06-30', depot_id: depot.public_id }, cookie);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('CONFLICT_DUPLICATE_LICENSE');
  });

  test('searching by part of a licence number and sorting by it still work', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['depot_admin'], depot);
    const b = await newDriver(cookie, depot, { license_number: 'ET-SRT-B222' });
    const a = await newDriver(cookie, depot, { license_number: 'ET-SRT-A111' });
    const c = await newDriver(cookie, depot, { license_number: 'ET-SRT-C333' });

    const found = await api.get('/drivers?search=SRT-B2', cookie);
    expect(found.status).toBe(200);
    expect(found.body.data.map((d: { id: string }) => d.id)).toEqual([b.id]);

    const sorted = await api.get(`/drivers?search=ET-SRT&sort_by=license_number&sort_order=asc`, cookie);
    expect(sorted.body.data.map((d: { license_number: string }) => d.license_number)).toEqual(['ET-SRT-A111', 'ET-SRT-B222', 'ET-SRT-C333']);
    void a;
    void c;
  });

  test('the same licence number twice is refused by the database itself, whatever the application does', async () => {
    const depot = await createDepot();
    const make = async (licence: string) => {
      const user = await createUser({ roles: ['driver'], depot });
      return pool.query("INSERT INTO fleet.drivers (user_id, license_number, license_expiry) VALUES ($1, $2, '2030-01-01')", [user.id, licence]);
    };
    await make('ET-DB-DUP-1');
    await expect(make('ET-DB-DUP-1')).rejects.toMatchObject({ code: '23505', constraint: 'ux_drivers_license_number_idx' });
  });

  describe('the key', () => {
    async function connection(key: string | null) {
      const client = new Client(config.db);
      await client.connect();
      if (key !== null) await setDataKey(client, key);
      return client;
    }
    const KEY_A = 'a'.repeat(40);
    const KEY_B = 'b'.repeat(40);

    test('a connection without the key can neither read nor write: error 55000', async () => {
      const client = await connection(null);
      try {
        await expect(client.query("SELECT privacy.decrypt_text('enc:v1:AAAA')")).rejects.toMatchObject({ code: '55000' });
        await expect(client.query("SELECT privacy.encrypt_text('secret')")).rejects.toMatchObject({ code: '55000' });
      } finally {
        await client.end();
      }
    });

    test('a key under 32 characters is refused rather than used', async () => {
      const client = await connection('too-short');
      try {
        await expect(client.query("SELECT privacy.encrypt_text('secret')")).rejects.toMatchObject({ code: '55000' });
      } finally {
        await client.end();
      }
    });

    test('data encrypted under one key cannot be read under another, and is never the plain text', async () => {
      const a = await connection(KEY_A);
      const b = await connection(KEY_B);
      try {
        const stored = (await a.query<{ c: string }>("SELECT privacy.encrypt_text('ET-SECRET-1') AS c")).rows[0].c;
        expect(stored).toMatch(/^enc:v1:/);
        expect(stored).not.toContain('SECRET');
        expect((await a.query<{ p: string }>('SELECT privacy.decrypt_text($1) AS p', [stored])).rows[0].p).toBe('ET-SECRET-1');
        await expect(b.query('SELECT privacy.decrypt_text($1)', [stored])).rejects.toThrow();
        // The blind index is keyed too: the same number gives a different index under another key.
        const ia = (await a.query<{ i: string }>("SELECT privacy.blind_index('ET-SECRET-1') AS i")).rows[0].i;
        const ib = (await b.query<{ i: string }>("SELECT privacy.blind_index('ET-SECRET-1') AS i")).rows[0].i;
        expect(ia).not.toBe(ib);
        expect(ia).toBe((await a.query<{ i: string }>("SELECT privacy.blind_index('ET-SECRET-1') AS i")).rows[0].i);
      } finally {
        await a.end();
        await b.end();
      }
    });

    test('the same text encrypts differently each time, and a value written before encryption existed reads as it is', async () => {
      const a = await connection(KEY_A);
      try {
        const one = (await a.query<{ c: string }>("SELECT privacy.encrypt_text('same') AS c")).rows[0].c;
        const two = (await a.query<{ c: string }>("SELECT privacy.encrypt_text('same') AS c")).rows[0].c;
        expect(one).not.toBe(two);
        expect((await a.query<{ p: string | null }>("SELECT privacy.decrypt_text('written before 063') AS p")).rows[0].p).toBe('written before 063');
        expect((await a.query<{ p: string | null }>('SELECT privacy.decrypt_text(NULL) AS p')).rows[0].p).toBeNull();
        // Encrypting what is already encrypted changes nothing.
        expect((await a.query<{ c: string }>('SELECT privacy.encrypt_text($1) AS c', [one])).rows[0].c).toBe(one);
      } finally {
        await a.end();
      }
    });
  });
});

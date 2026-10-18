import { randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { config } from '../../src/config';
import { loadMigrationConfig } from '../../src/config/schema';
import { pool } from '../../src/db';
import { fleetModule } from '../../src/modules/fleet';
import { PostgresJobLock } from '../../src/shared/jobs/job-lock';
import type { ScheduledJob } from '../../src/shared/jobs/job';
import { runJob } from '../../src/shared/jobs/scheduler';
import { deliverEvents, publishedEvents } from '../support/events';
import { createDepot, createDriver, createUser, createVehicle } from '../support/factories';

const app = createApp();
const TZ = 'Africa/Addis_Ababa';
const PASSWORD = 'Expire-Test-1';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');

/** A date `days` from today in Addis Ababa, YYYY-MM-DD. */
function addisDate(days: number): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const job = (name: string) => fleetModule.jobs!.find((j) => j.name === name)!;
const deps = (instanceId = 'test-instance') => ({ lock: new PostgresJobLock(pool), audit: pool, timeZone: TZ, instanceId });


async function vehicleWithDocument(expiresOn: string | null, extra: { deleted?: boolean; retired?: boolean } = {}) {
  const depot = await createDepot();
  const vehicle = await createVehicle({ depot, ...(extra.retired ? { status: 'retired', is_active: false } : {}) });
  const uploader = await createUser({ roles: ['admin'] });
  const doc = await pool.query<{ id: string; public_id: string }>(
    `INSERT INTO document.documents (owner_type, owner_id, document_type, storage_key, content_type, size_bytes, sha256, uploaded_by, expires_on, deleted_at, deleted_by)
     VALUES ('vehicle', $1, 'insurance', $2, 'application/pdf', 100, $3, $4, $5, $6, $7) RETURNING id, public_id`,
    [vehicle.id, `test/${randomUUID()}`, randomBytes(32).toString('hex'), uploader.id, expiresOn, extra.deleted ? new Date() : null, extra.deleted ? uploader.id : null],
  );
  return { vehicle, document: doc.rows[0] };
}

/** The expiry events raised for these documents or drivers, oldest first. */
const mine = async (ids: string[]) =>
  (await publishedEvents('DocumentExpiring', 'LicenceExpiring')).filter((e) => ids.includes(String(e.payload.document_id ?? e.payload.driver_id)));

describe('document expiry check', () => {
  test('a document expiring in 15 days raises one amber DocumentExpiring; re-running the job raises nothing', async () => {
    const { vehicle, document } = await vehicleWithDocument(addisDate(15));
    const first = await runJob(job('document-expiry-check'), deps());
    expect(first.status).toBe('succeeded');

    const events = await mine([document.public_id]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'DocumentExpiring',
      actor: null,
      correlation_id: first.status === 'succeeded' ? first.correlationId : '',
      payload: { document_id: document.public_id, owner_type: 'vehicle', owner_id: vehicle.public_id, document_type: 'insurance', expires_on: addisDate(15), days_left: 15, level: 'amber' },
    });

    // The same day: the lock skips the run. Forced again (another day's key): the notice is already there.
    expect(await runJob(job('document-expiry-check'), deps('another-instance'))).toEqual({ status: 'skipped' });
    await job('document-expiry-check').run({ now: new Date(), correlationId: randomUUID(), runKey: 'forced' });
    expect(await mine([document.public_id])).toHaveLength(1);
  });

  test('levels: 30 amber, 7 and 0 red; 31 days, already expired, deleted, no date or a retired vehicle: nothing', async () => {
    const at = async (days: number) => (await vehicleWithDocument(addisDate(days))).document.public_id;
    const in30 = await at(30);
    const in7 = await at(7);
    const today = await at(0);
    const quiet = [await at(31), await at(-1), (await vehicleWithDocument(addisDate(5), { deleted: true })).document.public_id, (await vehicleWithDocument(null)).document.public_id];
    const retired = (await vehicleWithDocument(addisDate(5), { retired: true })).document.public_id;

    await job('document-expiry-check').run({ now: new Date(), correlationId: randomUUID(), runKey: 't' });
    const levels = Object.fromEntries((await mine([in30, in7, today])).map((e) => [e.payload.document_id, e.payload.level]));
    expect(levels).toEqual({ [in30]: 'amber', [in7]: 'red', [today]: 'red' });
    expect(await mine([...quiet, retired])).toEqual([]);
  });

  test('amber then red as the date nears, once each; a new expiry date starts again', async () => {
    const { document } = await vehicleWithDocument(addisDate(20));
    const check = () => job('document-expiry-check').run({ now: new Date(), correlationId: randomUUID(), runKey: 't' });
    await check();
    await pool.query('UPDATE document.documents SET expires_on = $2 WHERE id = $1', [document.id, addisDate(6)]);
    await check();
    await check();
    expect((await mine([document.public_id])).map((e) => e.payload.level)).toEqual(['amber', 'red']);

    // Renewed: a different expiry date is a different fact.
    await pool.query('UPDATE document.documents SET expires_on = $2 WHERE id = $1', [document.id, addisDate(25)]);
    await check();
    expect((await mine([document.public_id])).map((e) => e.payload.level)).toEqual(['amber', 'red', 'amber']);
  });

  test('an upload already inside the window is flagged at once, and the daily job does not repeat it', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const admin = await createUser({ roles: ['admin'], password: PASSWORD });
    const login = await request(app).post('/api/v1/auth/login').send({ email: admin.email, password: PASSWORD });
    const cookie = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');

    const res = await request(app)
      .post('/api/v1/documents')
      .set('Cookie', cookie)
      .field('owner_type', 'vehicle')
      .field('owner_id', String(vehicle.public_id))
      .field('document_type', 'registration')
      .field('expires_on', addisDate(5))
      .attach('file', PDF, { filename: 'registration.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(201);
    // The check runs when the relay delivers DocumentUploaded (fleet.document-expiry).
    expect(await mine([res.body.data.id])).toEqual([]);
    await deliverEvents();
    const flagged = await mine([res.body.data.id]);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].payload).toMatchObject({ level: 'red', days_left: 5 });
    // Traced to the upload that caused it.
    expect(flagged[0].correlation_id).toBe(res.headers['x-request-id']);

    await job('document-expiry-check').run({ now: new Date(), correlationId: randomUUID(), runKey: 't' });
    expect(await mine([res.body.data.id])).toHaveLength(1);
  });
});

describe('licence expiry check', () => {
  test('amber at 30 and 8 days, red at 7; inactive drivers and 31 days are left out; re-running raises nothing', async () => {
    const depot = await createDepot();
    const in30 = await createDriver({ depot, license_expiry: addisDate(30) });
    const in8 = await createDriver({ depot, license_expiry: addisDate(8) });
    const in7 = await createDriver({ depot, license_expiry: addisDate(7) });
    const in31 = await createDriver({ depot, license_expiry: addisDate(31) });
    const retired = await createDriver({ depot, license_expiry: addisDate(7), is_active: false });

    const run = () => job('licence-expiry-check').run({ now: new Date(), correlationId: randomUUID(), runKey: 't' });
    expect(await run()).toMatchObject({ raised: expect.any(Number) });
    const ids = [in30, in8, in7, in31, retired].map((d) => String(d.driver.public_id));
    const events = await mine(ids);
    expect(Object.fromEntries(events.map((e) => [e.payload.driver_id, e.payload.level]))).toEqual({
      [in30.driver.public_id as string]: 'amber',
      [in8.driver.public_id as string]: 'amber',
      [in7.driver.public_id as string]: 'red',
    });
    expect(events.find((e) => e.payload.driver_id === in7.driver.public_id)!.payload).toEqual({
      driver_id: in7.driver.public_id,
      user_id: in7.user.public_id,
      depot_id: depot.public_id,
      license_expiry: addisDate(7),
      days_left: 7,
      level: 'red',
    });

    await run();
    expect(await mine(ids)).toHaveLength(3);
  });
});

describe('scheduler lock and run history', () => {
  test('a run is audited as the system with one UUID correlation id, which its events carry', async () => {
    const { document } = await vehicleWithDocument(addisDate(10));
    const outcome = await runJob(job('document-expiry-check'), deps());
    expect(outcome.status).toBe('succeeded');
    const correlationId = outcome.status === 'succeeded' ? outcome.correlationId : '';
    expect(correlationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    const audit = await pool.query<{ action: string; user_id: string | null; details: Record<string, unknown> }>(
      'SELECT action, user_id, details FROM audit.audit_logs WHERE correlation_id = $1 ORDER BY id',
      [correlationId],
    );
    expect(audit.rows.map((r) => [r.action, r.user_id])).toEqual([
      ['job.started', null],
      ['job.succeeded', null],
    ]);
    expect(audit.rows[1].details).toMatchObject({ job: 'document-expiry-check', result: { raised: expect.any(Number) } });
    expect((await mine([document.public_id]))[0].correlation_id).toBe(correlationId);

    const history = await pool.query('SELECT status, attempts, result FROM jobs.job_runs WHERE correlation_id = $1', [correlationId]);
    expect(history.rows).toEqual([{ status: 'succeeded', attempts: 1, result: expect.objectContaining({ raised: expect.any(Number) }) }]);
  });

  test('a run whose instance died (lease ran out) is taken over; the late finisher cannot overwrite it', async () => {
    const lock = new PostgresJobLock(pool);
    const input = { jobName: `lease-${randomUUID()}`, runKey: '2026-10-10', leaseMs: 1, maxAttempts: 5 };
    const dead = await lock.claim({ ...input, instanceId: 'a', correlationId: randomUUID() });
    expect(dead).not.toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    const takeover = await lock.claim({ ...input, instanceId: 'b', correlationId: randomUUID(), leaseMs: 60_000 });
    expect(takeover).toMatchObject({ attempts: 2 });
    expect(await lock.claim({ ...input, instanceId: 'c', correlationId: randomUUID(), leaseMs: 60_000 })).toBeNull();

    await lock.succeed(dead!, { stale: true });
    const row = await pool.query('SELECT status, instance_id, result FROM jobs.job_runs WHERE job_name = $1', [input.jobName]);
    expect(row.rows).toEqual([{ status: 'running', instance_id: 'b', result: null }]);
  });
});

describe('two app instances', () => {
  // Real separate connections, outside the test's transaction: two
  // instances racing for the same day's run on committed rows. Audit goes
  // nowhere here (the test above covers it: audit rows cannot be deleted),
  // and the schema owner removes the run row afterwards (the app role has
  // no DELETE on run history).
  const instances = [new Pool(config.db), new Pool(config.db)];
  const owner = new Pool(loadMigrationConfig(process.env));
  const noAudit = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool;
  let jobName = '';
  afterAll(async () => {
    await owner.query('DELETE FROM jobs.job_runs WHERE job_name = $1', [jobName]);
    await Promise.all([...instances, owner].map((p) => p.end()));
  });

  test('run a job once', async () => {
    let runs = 0;
    const slow: ScheduledJob = {
      name: (jobName = `two-instances-${randomUUID()}`),
      at: '00:00',
      run: async () => {
        runs += 1;
        await new Promise((r) => setTimeout(r, 100));
        return { runs };
      },
    };
    const outcomes = await Promise.all(
      instances.map((db, i) => runJob(slow, { lock: new PostgresJobLock(db), audit: noAudit, timeZone: TZ, instanceId: `instance-${i}` })),
    );
    expect(runs).toBe(1);
    expect(outcomes.map((o) => o.status).sort()).toEqual(['skipped', 'succeeded']);
    const history = await instances[0].query('SELECT count(*)::int AS n, max(status) AS status FROM jobs.job_runs WHERE job_name = $1', [slow.name]);
    expect(history.rows[0]).toEqual({ n: 1, status: 'succeeded' });
  });
});

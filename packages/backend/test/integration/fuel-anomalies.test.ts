import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { createDepot, createUser, createVehicle, type RoleName } from '../support/factories';

// Fuel anomalies (FMS-42, api-contract §9.1): the finance screen's list, and closing one, which records who closed
// it, when and why.

const app = createApp();
const PASSWORD = 'Fuel-Test-1';

type Row = Record<string, unknown> & { id: string; public_id: string };
type Depot = Awaited<ReturnType<typeof createDepot>>;

async function signIn(roles: RoleName[], depot: Depot | null = null, fullName?: string): Promise<{ cookie: string; user: Row }> {
  const user = (await createUser({ roles, depot, password: PASSWORD, fullName })) as unknown as Row;
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return { cookie: (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; '), user };
}

const get = (path: string, cookie: string) => request(app).get(`/api/v1${path}`).set('Cookie', cookie);
const close = (id: string, body: object, cookie: string) => request(app).post(`/api/v1/fuel-anomalies/${id}/resolve`).set('Cookie', cookie).send(body);

/** A reconciliation anomaly for a vehicle's September, as the monthly job writes it. */
async function anomaly(vehicle: Row, extra: { detected?: string; deviation?: number; status?: string } = {}): Promise<Row> {
  const deviation = extra.deviation ?? 25;
  const res = await pool.query<Row>(
    `INSERT INTO fuel.fuel_anomalies (vehicle_id, anomaly_type, severity, status, period_start, period_end, distance_km, expected_ml, actual_ml,
                                      expected_consumption_ml_100km, actual_consumption_ml_100km, deviation_percentage, detected_at)
     VALUES ($1, $2, 'medium', $3, '2026-09-01T00:00:00+03:00', '2026-10-01T00:00:00+03:00', 1000, 320000, $4::bigint, 32000, $4::bigint / 10, $5, $6)
     RETURNING id, public_id`,
    [
      vehicle.id,
      deviation > 0 ? 'consumption_above_expected' : 'consumption_below_expected',
      extra.status ?? 'open',
      320_000 + deviation * 3_200,
      deviation,
      extra.detected ?? '2026-10-01T01:30:00Z',
    ],
  );
  return res.rows[0];
}

describe('GET /fuel-anomalies', () => {
  test("lists the caller's depots' anomalies newest first, naming the vehicle and depot, filtered by status", async () => {
    const depot = await createDepot();
    const elsewhere = await createDepot();
    const vehicle = (await createVehicle({ depot })) as Row;
    const older = await anomaly(vehicle, { detected: '2026-09-01T01:30:00Z', deviation: -30 });
    const newer = await anomaly((await createVehicle({ depot })) as Row, { detected: '2026-10-01T01:30:00Z' });
    await anomaly((await createVehicle({ depot })) as Row, { detected: '2026-08-01T01:30:00Z', status: 'resolved' });
    await anomaly((await createVehicle({ depot: elsewhere })) as Row);
    const { cookie } = await signIn(['finance_clerk'], depot);

    const all = await get('/fuel-anomalies', cookie);
    expect(all.status).toBe(200);
    expect(all.body.meta.total_items).toBe(3);
    const open = await get('/fuel-anomalies?status=open,reviewed', cookie);
    expect(open.body.data.map((a: { id: string }) => a.id)).toEqual([newer.public_id, older.public_id]);
    expect(open.body.data[1]).toEqual({
      id: older.public_id,
      vehicle_id: vehicle.public_id,
      registration_number: vehicle.registration_number,
      depot_id: depot.public_id,
      depot_name: depot.name,
      fuel_log_id: null,
      anomaly_type: 'consumption_below_expected',
      severity: 'medium',
      status: 'open',
      period_from: '2026-08-31T21:00:00.000Z',
      period_to: '2026-09-30T21:00:00.000Z',
      distance_km: 1000,
      expected_ml: 320_000,
      actual_ml: 224_000,
      deviation_pct: -30,
      detected_at: '2026-09-01T01:30:00.000Z',
      reviewed_by: null,
      reviewed_by_name: null,
      reviewed_at: null,
      notes: null,
    });
    expect((await get(`/fuel-anomalies?vehicle_id=${vehicle.public_id}`, cookie)).body.data.map((a: { id: string }) => a.id)).toEqual([older.public_id]);
    expect((await get('/fuel-anomalies?status=bad', cookie)).status).toBe(400);
  });

  test('a driver, a dispatcher and a fleet owner are refused; another depot’s anomaly is 404', async () => {
    const depot = await createDepot();
    const theirs = await anomaly((await createVehicle({ depot: await createDepot() })) as Row);
    for (const roles of [['driver'], ['dispatcher'], ['fleet_owner']] as RoleName[][]) {
      expect((await get('/fuel-anomalies', (await signIn(roles, depot)).cookie)).status, roles[0]).toBe(403);
    }
    const { cookie } = await signIn(['depot_admin'], depot);
    expect((await get(`/fuel-anomalies/${theirs.public_id}`, cookie)).status).toBe(404);
    expect((await get('/fuel-anomalies/not-a-uuid', cookie)).status).toBe(404);
  });
});

describe('POST /fuel-anomalies/{id}/resolve', () => {
  test('resolving records who resolved it, when and why, audited', async () => {
    const depot = await createDepot();
    const found = await anomaly((await createVehicle({ depot })) as Row);
    const { cookie, user } = await signIn(['finance_clerk'], depot, 'Hanna Tesfaye');
    const before = Date.now();

    const res = await close(found.public_id, { notes: 'Receipts for two extra fill-ups were for another vehicle.' }, cookie);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      status: 'resolved',
      reviewed_by: user.public_id,
      reviewed_by_name: 'Hanna Tesfaye',
      notes: 'Receipts for two extra fill-ups were for another vehicle.',
    });
    expect(Date.parse(res.body.data.reviewed_at)).toBeGreaterThanOrEqual(before - 1000);
    const audit = await pool.query("SELECT action, user_id, new_values FROM audit.audit_logs WHERE correlation_id = $1 AND entity_type = 'fuel.fuel_anomalies'", [
      res.headers['x-request-id'],
    ]);
    expect(audit.rows).toMatchObject([{ action: 'UPDATE', user_id: user.id, new_values: { status: 'resolved' } }]);
    expect((await get(`/fuel-anomalies/${found.public_id}`, cookie)).body.data.status).toBe('resolved');
  });

  test('dismissing needs a note; a closed anomaly cannot be closed again', async () => {
    const depot = await createDepot();
    const found = await anomaly((await createVehicle({ depot })) as Row);
    const { cookie } = await signIn(['fleet_manager']);

    const bare = await close(found.public_id, { outcome: 'dismissed' }, cookie);
    expect(bare.status).toBe(400);
    expect(bare.body.error.details).toEqual([expect.objectContaining({ field: 'notes', reason: 'required_to_dismiss' })]);

    expect((await close(found.public_id, { outcome: 'dismissed', notes: 'Tank was filled for a generator test.' }, cookie)).body.data.status).toBe('dismissed');
    const again = await close(found.public_id, {}, cookie);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('CONFLICT_INVALID_STATE_TRANSITION');
    expect((await close(found.public_id, { outcome: 'deleted' }, cookie)).status).toBe(400);
  });

  test('needs fuel-anomaly:write: a depot admin and a compliance officer can read but not close; unknown is 404', async () => {
    const depot = await createDepot();
    const found = await anomaly((await createVehicle({ depot })) as Row);
    expect((await close(found.public_id, {}, (await signIn(['depot_admin'], depot)).cookie)).status).toBe(403);
    expect((await close(found.public_id, {}, (await signIn(['compliance_officer'])).cookie)).status).toBe(403);
    expect((await close(randomUUID(), {}, (await signIn(['admin'])).cookie)).status).toBe(404);
  });
});

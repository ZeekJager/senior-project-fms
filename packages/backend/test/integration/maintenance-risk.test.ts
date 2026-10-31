import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { createDepot, createUser, createVehicle, type RoleName } from '../support/factories';

// The health score screen's reads (FMS-56): a vehicle's latest prediction with the inputs behind it
// (prediction:read), and the health score bands on the vehicle list (everyone who reads vehicles).

const app = createApp();
const PASSWORD = 'Health-Test-1';
const HOUR = 3_600_000;

type Row = Record<string, unknown> & { id: string };

async function signIn(roles: RoleName[], depot: Row | null = null): Promise<string> {
  const user = await createUser({ roles, depot, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

const get = (path: string, cookie: string) => request(app).get(`/api/v1${path}`).set('Cookie', cookie);

/** A registered model, which every stored prediction must name. */
async function model(): Promise<{ name: string; version: string }> {
  const version = `pm-test.${randomUUID().slice(0, 8)}`;
  await pool.query(
    `INSERT INTO maintenance.ml_models (name, version, algorithm, features, feature_spec_version, feature_spec_hash, metrics, training_data, trained_at, artefact_sha256)
     VALUES ('predictive-maintenance', $1, 'RandomForestClassifier', '["mileage_km"]', 2, $2, '{}', '{}', now(), $2)`,
    [version, 'a'.repeat(64)],
  );
  return { name: 'predictive-maintenance', version };
}

/** A stored prediction as the nightly scoring writes it, scored `hoursAgo`, and the vehicle's snapshot with it. */
async function scored(vehicle: Row, m: { name: string; version: string }, score: number, hoursAgo = 2, status = 'active'): Promise<string> {
  const at = new Date(Date.now() - hoursAgo * HOUR);
  const p = (100 - score) / 100;
  const level = score >= 75 ? 'low' : score <= 40 ? 'high' : 'medium';
  const factors = score < 75 ? ['days_since_last_service', 'km_since_oil_change'] : [];
  const row = await pool.query<{ public_id: string }>(
    `INSERT INTO maintenance.maintenance_predictions
       (vehicle_id, model_name, model_version, prediction_type, risk_score, prediction_horizon_days, feature_snapshot, health_score, risk_level, factors, as_of, generated_at, status)
     VALUES ($1, $2, $3, 'failure_within_30_days', $4, 30, $5, $6, $7, $8, $9, $9, $10) RETURNING public_id`,
    [vehicle.id, m.name, m.version, p, JSON.stringify({ days_since_last_service: 100, km_since_oil_change: 17380.5, mileage_km: 4200 }), score, level, JSON.stringify(factors), at, status],
  );
  if (status === 'active') await pool.query('UPDATE fleet.vehicles SET health_score = $2, health_score_updated_at = $3 WHERE id = $1', [vehicle.id, score, at]);
  return row.rows[0].public_id;
}

describe('GET /vehicles/{vehicle_id}/maintenance-risk', () => {
  test("the latest prediction: score, level, probability and the factors with the vehicle's values", async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const m = await model();
    await scored(vehicle, m, 82, 26, 'superseded');
    const id = await scored(vehicle, m, 60);
    const tech = await signIn(['technician'], depot);

    const res = await get(`/vehicles/${String(vehicle.public_id)}/maintenance-risk`, tech);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      vehicle_id: vehicle.public_id,
      prediction_id: id,
      health_score: 60,
      risk_level: 'medium',
      failure_probability: 0.4,
      prediction_horizon_days: 30,
      factors: [
        { feature: 'days_since_last_service', value: 100, unit: 'd' },
        { feature: 'km_since_oil_change', value: 17380.5, unit: 'km' },
      ],
      model_name: 'predictive-maintenance',
      model_version: m.version,
      stale: false,
    });
    expect(Date.parse(res.body.data.scored_at)).toBeLessThan(Date.now() - HOUR);
  });

  test('a score more than 25 hours old is stale; a vehicle never scored has no score', async () => {
    const depot = await createDepot();
    const [old, never] = [await createVehicle({ depot }), await createVehicle({ depot })];
    await scored(old, await model(), 88, 26);
    const manager = await signIn(['fleet_manager']);

    expect((await get(`/vehicles/${String(old.public_id)}/maintenance-risk`, manager)).body.data).toMatchObject({ health_score: 88, factors: [], stale: true });
    expect((await get(`/vehicles/${String(never.public_id)}/maintenance-risk`, manager)).body.data).toEqual({
      vehicle_id: never.public_id,
      prediction_id: null,
      health_score: null,
      risk_level: null,
      failure_probability: null,
      prediction_horizon_days: null,
      factors: [],
      model_name: null,
      model_version: null,
      as_of: null,
      scored_at: null,
      stale: false,
      feedback: null,
    });
  });

  test("a dispatcher may not read the breakdown; another depot's vehicle or a bad id is not found", async () => {
    const [depot, other] = [await createDepot(), await createDepot()];
    const [mine, theirs] = [await createVehicle({ depot }), await createVehicle({ depot: other })];

    expect((await get(`/vehicles/${String(mine.public_id)}/maintenance-risk`, await signIn(['dispatcher'], depot))).status).toBe(403);
    const tech = await signIn(['technician'], depot);
    expect((await get(`/vehicles/${String(theirs.public_id)}/maintenance-risk`, tech)).status).toBe(404);
    expect((await get('/vehicles/not-a-uuid/maintenance-risk', tech)).status).toBe(404);
  });
});

describe('the health score on the vehicle list', () => {
  test('every vehicle reader sees the score and when it was set, and can filter by its band', async () => {
    const depot = await createDepot();
    const m = await model();
    const v = {
      risky: await createVehicle({ depot }),
      watch: await createVehicle({ depot }),
      healthy: await createVehicle({ depot }),
      stale: await createVehicle({ depot }),
      unscored: await createVehicle({ depot }),
    };
    await scored(v.risky, m, 60);
    await scored(v.watch, m, 80);
    await scored(v.healthy, m, 91);
    await scored(v.stale, m, 40, 30);
    // A dispatcher reads the score (the badge), not the breakdown.
    const dispatcher = await signIn(['dispatcher'], depot);

    const all = await get(`/vehicles?depot_id=${String(depot.public_id)}&sort_by=health_score`, dispatcher);
    expect(all.status).toBe(200);
    const risky = all.body.data.find((x: { id: string }) => x.id === v.risky.public_id);
    expect(risky.health_score).toBe(60);
    expect(Date.parse(risky.health_score_updated_at)).toBeGreaterThan(Date.now() - 3 * HOUR);
    expect(all.body.data.find((x: { id: string }) => x.id === v.unscored.public_id).health_score_updated_at).toBeNull();

    const band = async (health: string) =>
      ((await get(`/vehicles?depot_id=${String(depot.public_id)}&health=${health}`, dispatcher)).body.data as { id: string }[]).map((x) => x.id);
    expect(await band('at_risk')).toEqual([v.risky.public_id]);
    expect(await band('watch')).toEqual([v.watch.public_id]);
    expect(await band('healthy')).toEqual([v.healthy.public_id]);
    // Stale is stale whatever the score: 40 is not counted at risk.
    expect(await band('stale')).toEqual([v.stale.public_id]);
    expect(await band('unscored')).toEqual([v.unscored.public_id]);
    expect((await get('/vehicles?health=sick', dispatcher)).status).toBe(400);
  });
});

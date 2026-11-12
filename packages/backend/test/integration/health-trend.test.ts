import request from 'supertest';
import { beforeEach, describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { addisDay, dayStart, shiftDay } from '../../src/modules/analytics/domain/kpis';
import { createDepot, createUser, createVehicle, type RoleName } from '../support/factories';

// FMS-150: the fleet-wide health score trend, read from the scores the nightly batch stored (FMS-55): a day's mean,
// the share of vehicles scored that were high risk, gaps on days with no run, in the caller's depots.

const app = createApp();
const PASSWORD = 'Trend-Test-1';
type Row = Record<string, unknown> & { id: string; public_id: string };
type Depot = Awaited<ReturnType<typeof createDepot>>;

async function signIn(roles: RoleName[], depot: Depot | null = null): Promise<string> {
  const user = await createUser({ roles, depot, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}
const get = (path: string, cookie: string) => request(app).get(`/api/v1${path}`).set('Cookie', cookie);

const today = addisDay(new Date());
/** 02:00 Addis Ababa, `daysAgo` days ago: when the nightly batch scores. */
const night = (daysAgo: number, hour = 2) => new Date(dayStart(shiftDay(today, -daysAgo)).getTime() + hour * 3_600_000);
const riskOf = (score: number) => (score >= 75 ? 'low' : score <= 40 ? 'high' : 'medium');

/** The registered model the scores name (FMS-127), once per test. */
let registered = false;
async function model() {
  if (registered) return;
  await pool.query(
    `INSERT INTO maintenance.ml_models (name, version, algorithm, features, feature_spec_version, feature_spec_hash, metrics, training_data, trained_at, artefact_sha256)
     VALUES ('fms-maintenance-risk', 'v-test', 'RandomForestClassifier', '["mileage_km"]', 2, $1, '{}', '{}', now(), $1)
     ON CONFLICT DO NOTHING`,
    ['b'.repeat(64)],
  );
  registered = true;
}

beforeEach(() => {
  registered = false;
});

/** A score as the nightly batch stores it; a later night's supersedes it, as the batch does. */
async function scored(vehicle: Row, score: number, at: Date, status: 'active' | 'superseded' = 'superseded') {
  await model();
  await pool.query(
    `INSERT INTO maintenance.maintenance_predictions
            (vehicle_id, model_name, model_version, prediction_type, risk_score, health_score, risk_level, factors, as_of, generated_at, status)
     VALUES ($1, 'fms-maintenance-risk', 'v-test', 'failure_within_30_days', $2, $3, $4, '[]'::jsonb, $5, $5, $6)`,
    [vehicle.id, (100 - score) / 100, score, riskOf(score), at, status],
  );
}

describe('GET /analytics/health-trend (FMS-150)', () => {
  test("three nights of stored scores: each day's mean and high-risk share; a night with no run is a gap, not a zero", async () => {
    const depot = await createDepot();
    const [a, b, c] = [await createVehicle({ depot }), await createVehicle({ depot }), await createVehicle({ depot })] as Row[];
    // 4 nights ago: a 80, b 30 (high). 3 nights ago: no run. 2 nights ago: a 70, b 35 (high), c 90. Last night: a 60, b 50, c 88.
    await scored(a, 80, night(4));
    await scored(b, 30, night(4));
    await scored(a, 70, night(2));
    await scored(b, 35, night(2));
    await scored(c, 90, night(2));
    // Scored twice the same night (a rerun): the later one counts, once.
    await scored(a, 99, night(1, 1));
    await scored(a, 60, night(1, 3), 'active');
    await scored(b, 50, night(1), 'active');
    await scored(c, 88, night(1), 'active');

    const res = await get(`/analytics/health-trend?from=${shiftDay(today, -4)}`, await signIn(['fleet_owner']));
    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ from: shiftDay(today, -4), to: today, days: 5, data_freshness: expect.any(Object) });
    // A fleet owner sees every depot: only this depot's vehicles were scored in the test.
    const days = res.body.data.days as { date: string; vehicles_scored: number | null; mean_health_score: number | null; high_risk_pct: number | null }[];
    expect(days.map((d) => d.date)).toEqual([4, 3, 2, 1, 0].map((n) => shiftDay(today, -n)));
    expect(days[0]).toEqual({ date: shiftDay(today, -4), vehicles_scored: 2, mean_health_score: 55, high_risk_pct: 50 });
    expect(days[1]).toEqual({ date: shiftDay(today, -3), vehicles_scored: null, mean_health_score: null, high_risk_pct: null });
    expect(days[2]).toEqual({ date: shiftDay(today, -2), vehicles_scored: 3, mean_health_score: 65, high_risk_pct: 33 });
    expect(days[3]).toEqual({ date: shiftDay(today, -1), vehicles_scored: 3, mean_health_score: 66, high_risk_pct: 0 });
    expect(days[4].vehicles_scored).toBeNull();
  });

  test("the 90 days to today by default; the caller's depots only; a depot filter; prediction:read and analytics:read both", async () => {
    const depot = await createDepot();
    const otherDepot = await createDepot();
    const mine = (await createVehicle({ depot })) as Row;
    const theirs = (await createVehicle({ depot: otherDepot })) as Row;
    await scored(mine, 40, night(1), 'active');
    await scored(theirs, 100, night(1), 'active');

    const admin = await signIn(['depot_admin'], depot);
    // A depot admin reads health scores but not analytics.
    expect((await get('/analytics/health-trend', admin)).status).toBe(403);
    // A finance clerk reads analytics but not health scores.
    expect((await get('/analytics/health-trend', await signIn(['finance_clerk'], depot))).status).toBe(403);

    const compliance = await signIn(['compliance_officer']);
    const all = await get('/analytics/health-trend', compliance);
    expect(all.status).toBe(200);
    expect(all.body.meta).toMatchObject({ from: shiftDay(today, -89), to: today, days: 90 });
    const yesterday = (r: request.Response) => (r.body.data.days as { date: string }[]).find((d) => d.date === shiftDay(today, -1));
    const narrowed = await get(`/analytics/health-trend?depot_id=${depot.public_id}`, compliance);
    expect(yesterday(narrowed)).toEqual({ date: shiftDay(today, -1), vehicles_scored: 1, mean_health_score: 40, high_risk_pct: 100 });
    expect(yesterday(await get(`/analytics/health-trend?depot_id=${otherDepot.public_id}`, compliance))).toMatchObject({ mean_health_score: 100, high_risk_pct: 0 });

    expect((await get(`/analytics/health-trend?from=${today}&to=${shiftDay(today, -1)}`, compliance)).status).toBe(400);
    expect((await get(`/analytics/health-trend?from=${shiftDay(today, -400)}`, compliance)).status).toBe(400);
  });
});

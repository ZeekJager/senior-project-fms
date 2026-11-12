import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { mlModelCommand } from '../../scripts/lib/ml-model-cli';
import { createApp } from '../../src/app';
import { config } from '../../src/config';
import { pool } from '../../src/db';
import { tripRisk } from '../../src/modules/analytics';
import { tripRiskFeatures, type RiskInput, type RiskJob, type RiskPast } from '../../src/modules/analytics/domain/trip-risk';
import { tripRiskModels } from '../../src/modules/maintenance';
import { JOB_LOAD_LEVELS, jobLoad, nightHours } from '../../src/modules/trip';
import { createDepot, createDriver, createUser, createVehicle, type RoleName } from '../support/factories';

// The trip risk model on the dispatch console (FMS-155, docs/ml-trip-risk.md): its inputs computed as the ML service
// computes them, the facts they come from, the board's chances once a model is active, and the console keeping the
// rules when there is none, it did not beat them, or the service fails. Against a stub of the ML service.

const app = createApp();
const PASSWORD = 'Trip-Risk-Test-1';
const TOKEN = 'r'.repeat(40);
const HOUR = 3_600_000;
const FIXTURE = path.resolve(__dirname, '../../../ai-service/tests/fixtures/trip_risk_features.json');

type Depot = Awaited<ReturnType<typeof createDepot>>;
type Row = Record<string, unknown> & { id: string; public_id: string };

const spec = () => tripRiskModels.spec();
const inputs = () => spec().inputs as RiskInput[];

// --- The inputs: the same numbers as the ML service's features.py, for the fixture both sides check -------------------

interface FixturePast {
  scheduled_end: string | null;
  actual_start: string;
  actual_end: string | null;
  late: boolean | null;
  safety_event: boolean;
  job_load_points: number;
}

const at = (s: string | null) => (s ? new Date(s) : null);
const levelOf = (points: number) => (points >= JOB_LOAD_LEVELS.heavy ? 'heavy' : points >= JOB_LOAD_LEVELS.standard ? 'standard' : 'light');

describe('the inputs', () => {
  test('are the ML service’s, to the decimal, for every case of the shared fixture', () => {
    const { cases } = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
      cases: { name: string; job: Record<string, never>; driver: FixturePast[]; route: FixturePast[]; expected: Record<string, number> }[];
    };
    expect(cases.length).toBeGreaterThanOrEqual(3);
    for (const c of cases) {
      const j = c.job as unknown as {
        scheduled_start: string;
        scheduled_end: string | null;
        planned_distance_km: number | null;
        planned_duration_seconds: number | null;
        stops: number;
        cargo_weight_kg: number | null;
        cargo_kind: string;
        payload_capacity_kg: number | null;
      };
      const start = new Date(j.scheduled_start);
      const end = at(j.scheduled_end);
      const load = jobLoad({
        plannedDistanceKm: j.planned_distance_km,
        plannedDurationSeconds: j.planned_duration_seconds,
        scheduledStart: start,
        scheduledEnd: end,
        stopCount: j.stops,
        cargoWeightKg: j.cargo_weight_kg,
        payloadCapacityKg: j.payload_capacity_kg,
      });
      const job: RiskJob = {
        scheduledStart: start,
        scheduledEnd: end,
        plannedDistanceKm: j.planned_distance_km,
        plannedDurationSeconds: j.planned_duration_seconds,
        stops: j.stops,
        cargoWeightKg: j.cargo_weight_kg,
        cargoKind: j.cargo_kind,
        payloadCapacityKg: j.payload_capacity_kg,
        jobLoadPoints: load.points,
        jobLoadLevel: load.level,
        nightHours: end && end > start ? nightHours(start, end) : 0,
      };
      const past = (list: FixturePast[]): RiskPast[] =>
        list.map((p) => ({
          scheduledEnd: at(p.scheduled_end),
          actualStart: new Date(p.actual_start),
          actualEnd: at(p.actual_end),
          late: p.late,
          safetyEvent: p.safety_event,
          jobLoadLevel: levelOf(p.job_load_points),
        }));
      expect(tripRiskFeatures(job, past(c.driver), past(c.route), inputs()), c.name).toEqual(c.expected);
    }
  });

  test('are the spec’s 22, in its order, with no protected attribute among them', () => {
    expect(spec().features).toHaveLength(22);
    expect(spec().features.join(' ')).not.toMatch(/name|age\b|gender|address|photo|phone|email/);
  });
});

// --- The facts ------------------------------------------------------------------------------------------------------

async function route(depot: Depot): Promise<Row> {
  return (await pool.query<Row>("INSERT INTO trip.routes (name, depot_id) VALUES ('Risk ' || gen_random_uuid(), $1) RETURNING *", [depot.id])).rows[0];
}

/** A trip written directly: `ago` hours before now it was scheduled to start; it ran `hours` and ended `lateMin` past its end. */
async function pastTrip(r: Row, f: { driver: Row; vehicle: Row; ago: number; hours: number; lateMin: number; measured?: boolean }): Promise<Row> {
  const start = new Date(Date.now() - f.ago * HOUR);
  const end = new Date(start.getTime() + f.hours * HOUR);
  const actualEnd = new Date(end.getTime() + f.lateMin * 60_000);
  return (
    await pool.query<Row>(
      `INSERT INTO trip.trips (route_id, driver_id, vehicle_id, status, scheduled_start, scheduled_end, actual_start, actual_end,
                               planned_distance_km, actual_distance_km, actual_distance_source)
       VALUES ($1, $2, $3, 'completed', $4, $5, $4, $6, 120, 121, $7) RETURNING *`,
      [r.id, f.driver.id, f.vehicle.id, start, end, actualEnd, f.measured === false ? null : 'gps'],
    )
  ).rows[0];
}

describe('analytics.trip_risk_facts', () => {
  test('a trip is late past its depot’s margin, and has a safety event for a speeding flag or its driver’s accident', async () => {
    const depot = await createDepot();
    const r = await route(depot);
    const driver = (await createDriver({ depot })).driver as Row;
    const vehicle = (await createVehicle({ depot, payload_capacity_kg: 8000 })) as Row;
    const late = await pastTrip(r, { driver, vehicle, ago: 30, hours: 3, lateMin: 20 });
    const onTime = await pastTrip(r, { driver, vehicle, ago: 20, hours: 3, lateMin: 15, measured: false });
    const crashed = await pastTrip(r, { driver, vehicle, ago: 10, hours: 3, lateMin: 0 });
    await pool.query("INSERT INTO tracking.telemetry_flags (vehicle_id, trip_id, flag_type, observed_at) VALUES ($1, $2, 'speeding', now())", [vehicle.id, late.id]);
    await pool.query("INSERT INTO tracking.telemetry_flags (vehicle_id, trip_id, flag_type, observed_at) VALUES ($1, $2, 'idling', now())", [vehicle.id, onTime.id]);
    await pool.query(
      "INSERT INTO alert.incident_reports (vehicle_id, driver_id, reported_by, incident_type, severity, description, occurred_at) VALUES ($1, $2, $3, 'accident', 'medium', 'Minor collision', $4)",
      [vehicle.id, driver.id, driver.user_id, new Date(Date.now() - 9 * HOUR)],
    );
    const facts = await pool.query(
      'SELECT public_id, late, safety_event, measured, payload_capacity_kg, depot_public_id FROM analytics.trip_risk_facts WHERE trip_id = ANY($1::bigint[]) ORDER BY scheduled_start',
      [[late.id, onTime.id, crashed.id]],
    );
    expect(facts.rows).toEqual([
      { public_id: late.public_id, late: true, safety_event: true, measured: true, payload_capacity_kg: 8000, depot_public_id: depot.public_id },
      // Exactly on the 15-minute margin is on time; an idling flag is not a safety event; not measured.
      { public_id: onTime.public_id, late: false, safety_event: false, measured: false, payload_capacity_kg: 8000, depot_public_id: depot.public_id },
      { public_id: crashed.public_id, late: false, safety_event: true, measured: true, payload_capacity_kg: 8000, depot_public_id: depot.public_id },
    ]);
  });
});

// --- The board, against a stub ML service ----------------------------------------------------------------------------

/** GET /models/trip-risk's data: a demonstration that beat the rules, unless overridden. */
function servedTripModel(version: string, overrides: Record<string, unknown> = {}) {
  return {
    name: 'trip-risk',
    model_version: version,
    trained_at: '2026-11-10T08:00:00+00:00',
    algorithm: 'HistGradientBoostingClassifier per label (late, safety_event) with isotonic calibration',
    features: spec().features,
    feature_spec_version: 1,
    feature_spec_hash: spec().hash,
    artefact_sha256: 'c'.repeat(64),
    training_data: { file: 'trip_risk_generated.csv', sha256: 'd'.repeat(64), source: 'generated', rows: 11852, drivers: 60 },
    metrics: {
      late: { model: { roc_auc: 0.757, brier: 0.112 }, rules: { roc_auc: 0.684, brier: 0.122 } },
      safety_event: { model: { roc_auc: 0.693, brier: 0.072 }, rules: { roc_auc: 0.644, brier: 0.074 } },
      decision: { beats_rules: true, why: [], min_auc_gain: 0.01 },
    },
    demonstration: true,
    ...overrides,
  };
}

let served: Record<string, unknown> | null = null;
let failPredict = false;
const asked: { items: { trip_id: string; driver_id: string; features: Record<string, number> }[] }[] = [];
let stub: http.Server;
const savedService = config.ml.service;

beforeAll(async () => {
  stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.headers['x-internal-token'] !== TOKEN) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: { code: 'AUTH_TOKEN_INVALID' } }));
        return;
      }
      if (req.method === 'GET' && req.url === '/models/trip-risk') {
        res.statusCode = served ? 200 : 404;
        res.end(JSON.stringify(served ? { data: served } : { error: { code: 'NOT_FOUND', message: 'No trip risk model is loaded.' } }));
        return;
      }
      if (req.method === 'POST' && req.url === '/internal/ml/predict-trip-risk') {
        const parsed = JSON.parse(body) as (typeof asked)[number];
        asked.push(parsed);
        if (failPredict) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: { code: 'INTERNAL' } }));
          return;
        }
        // The stub's "model": tiredness raises lateness, so a test can tell drivers apart.
        const data = parsed.items.map((i) => ({
          trip_id: i.trip_id,
          driver_id: i.driver_id,
          late_probability: Math.min(0.9, 0.1 + i.features.hours_driven_24h / 20),
          safety_event_probability: 0.05,
          factors: { late: [{ feature: 'hours_driven_24h', value: i.features.hours_driven_24h }], safety_event: [] },
          model_version: String(served?.model_version),
          demonstration: true,
        }));
        res.end(JSON.stringify({ data }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND' } }));
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  config.ml.service = { url: `http://127.0.0.1:${(stub.address() as AddressInfo).port}`, token: TOKEN };
});

afterAll(async () => {
  config.ml.service = savedService;
  await new Promise<void>((resolve) => stub.close(() => resolve()));
});

beforeEach(() => {
  served = null;
  failPredict = false;
  asked.length = 0;
  tripRisk.forget();
});

async function signIn(roles: RoleName[], depot: Depot | null = null): Promise<string> {
  const user = await createUser({ roles, depot, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

const board = (cookie: string, q: Record<string, string>) => request(app).get(`/api/v1/dispatch/availability?${new URLSearchParams(q)}`).set('Cookie', cookie);

/** A depot with a scheduled trip three hours ahead, a rested driver, a tired one (driven 9 h, ended 1 h ago) and one with an expired licence. */
async function scene() {
  const depot = await createDepot();
  // The trip is a heavy 340 km (510 load-weighted): above the default daily distance limit (FMS-156), which is not what this tests.
  await pool.query('INSERT INTO tracking.rule_thresholds (depot_id, daily_distance_km) VALUES ($1, 1000)', [depot.id]);
  const r = await route(depot);
  const vehicle = (await createVehicle({ depot })) as Row;
  const rested = (await createDriver({ depot })).driver as Row;
  const tired = (await createDriver({ depot })).driver as Row;
  const expired = (await createDriver({ depot, license_expiry: '2020-01-01' })).driver as Row;
  await pastTrip(r, { driver: tired, vehicle, ago: 10, hours: 9, lateMin: 0 });
  await pastTrip(r, { driver: rested, vehicle, ago: 72, hours: 4, lateMin: 30 });
  const start = new Date(Date.now() + 3 * HOUR);
  const trip = (
    await pool.query<Row>(
      "INSERT INTO trip.trips (route_id, status, scheduled_start, scheduled_end, planned_distance_km, cargo_kind) VALUES ($1, 'scheduled', $2, $3, 340, 'hazardous') RETURNING *",
      [r.id, start, new Date(start.getTime() + 6 * HOUR)],
    )
  ).rows[0];
  const window = { from: start.toISOString(), to: new Date(start.getTime() + 6 * HOUR).toISOString() };
  return { depot, trip, rested, tired, expired, query: { depot_id: String(depot.public_id), exclude_trip_id: trip.public_id, ...window } };
}

const driverOf = (res: request.Response, d: Row) => (res.body.data.drivers as { driver_id: string; trip_risk: unknown }[]).find((x) => x.driver_id === d.public_id)!;

async function activate(version: string) {
  const admin = await signIn(['admin']);
  const id = (await pool.query<{ public_id: string }>("SELECT public_id FROM maintenance.ml_models WHERE name = 'trip-risk' AND version = $1", [version])).rows[0].public_id;
  return request(app).post(`/api/v1/ml-models/${id}/activate`).set('Cookie', admin);
}

describe('trip risk on GET /dispatch/availability', () => {
  test('without a usable model the console says there are not enough trips yet, and gives no chances', async () => {
    const s = await scene();
    const cookie = await signIn(['dispatcher'], s.depot);
    const res = await board(cookie, s.query);
    expect(res.status).toBe(200);
    expect(res.body.data.trip_risk).toMatchObject({ status: 'not_enough_trips', reason: 'no_model', model_version: null, demonstration: false, minimum: { trips: 2000, drivers: 20 } });
    expect(res.body.data.trip_risk.trips).toBeLessThan(2000);
    expect(driverOf(res, s.rested).trip_risk).toBeNull();
    // Without a trip being staffed there is nothing to judge.
    const plain = await board(cookie, { depot_id: String(s.depot.public_id) });
    expect(plain.body.data.trip_risk).toBeNull();
    expect(asked).toHaveLength(0);
  });

  test('a served model is registered, used only once active, and then gives each free driver their chances with what raises them', async () => {
    const s = await scene();
    const cookie = await signIn(['dispatcher'], s.depot);
    const version = `tr-2026.${Math.floor(Math.random() * 1e6)}`;
    served = servedTripModel(version);

    const before = await board(cookie, s.query);
    expect(before.body.data.trip_risk).toMatchObject({ status: 'not_enough_trips', reason: 'not_active', model_version: version });
    expect(asked).toHaveLength(0);

    expect((await activate(version)).status).toBe(200);
    tripRisk.forget();
    const res = await board(cookie, s.query);
    expect(res.status).toBe(200);
    expect(res.body.data.trip_risk).toMatchObject({ status: 'ok', reason: null, model_version: version, demonstration: true });

    // Only the drivers free for the trip are asked about; one with an expired licence is blocked, and gets none.
    expect(asked).toHaveLength(1);
    const sent = new Map(asked[0].items.map((i) => [i.driver_id, i]));
    expect(sent.has(s.expired.public_id as string)).toBe(false);
    expect(driverOf(res, s.expired).trip_risk).toBeNull();
    for (const item of asked[0].items) {
      expect(item.trip_id).toBe(s.trip.public_id);
      expect(Object.keys(item.features)).toEqual(spec().features);
    }
    const tired = sent.get(s.tired.public_id as string)!.features;
    const rested = sent.get(s.rested.public_id as string)!.features;
    // The tired driver drove 9 h ending 1 h before now, 4 h before the trip starts: inside the last day, and 4 h of rest.
    expect(tired).toMatchObject({ hours_driven_24h: 9, hours_since_last_trip: 4, driver_trips_90d: 1, driver_late_share_90d: 0, cargo_hazardous: 1, planned_distance_km: 340 });
    expect(rested).toMatchObject({ hours_driven_24h: 0, driver_trips_90d: 1, driver_late_share_90d: 1, route_trips_90d: 2 });

    expect(driverOf(res, s.tired).trip_risk).toEqual({
      late_probability: 0.55,
      safety_event_probability: 0.05,
      factors: { late: [{ feature: 'hours_driven_24h', value: 9 }], safety_event: [] },
    });
    expect(driverOf(res, s.rested).trip_risk).toMatchObject({ late_probability: 0.1 });
  });

  test('a model that did not beat the rules is recorded but can never be activated', async () => {
    const s = await scene();
    const cookie = await signIn(['dispatcher'], s.depot);
    const version = `tr-2026.${Math.floor(Math.random() * 1e6)}`;
    served = servedTripModel(version, {
      metrics: { decision: { beats_rules: false, why: ['late: ROC-AUC 0.690, the rules’ 0.684; needs at least 0.01 more'] } },
    });
    await board(cookie, s.query);
    const refused = await activate(version);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'CONFLICT_INVALID_STATE_TRANSITION', details: [{ field: 'metrics', reason: 'does_not_beat_rules' }] });
    expect(refused.body.error.message).toContain('needs at least 0.01 more');
    const row = await pool.query("SELECT status FROM maintenance.ml_models WHERE name = 'trip-risk' AND version = $1", [version]);
    expect(row.rows).toEqual([{ status: 'registered' }]);
  });

  test('a model trained on other inputs is refused; an ML service that fails leaves the board with the rules', async () => {
    const s = await scene();
    const cookie = await signIn(['dispatcher'], s.depot);
    const other = `tr-2026.${Math.floor(Math.random() * 1e6)}`;
    served = servedTripModel(other, { feature_spec_hash: 'f'.repeat(64) });
    await board(cookie, s.query);
    expect((await activate(other)).status).toBe(409);

    const version = `tr-2026.${Math.floor(Math.random() * 1e6)}`;
    served = servedTripModel(version);
    tripRisk.forget();
    await board(cookie, s.query);
    expect((await activate(version)).status).toBe(200);
    tripRisk.forget();
    failPredict = true;
    const res = await board(cookie, s.query);
    expect(res.status).toBe(200);
    expect(res.body.data.trip_risk).toMatchObject({ status: 'unavailable', reason: 'unavailable' });
    expect(driverOf(res, s.tired).trip_risk).toBeNull();
    expect(res.body.data.drivers.length).toBe(3);
  });

  test('npm run ml:model -- list registers the served trip risk model and labels it a demonstration', async () => {
    const version = `tr-2026.${Math.floor(Math.random() * 1e6)}`;
    served = servedTripModel(version);
    const lines: string[] = [];
    await mlModelCommand(['list'], (line) => lines.push(line));
    const line = lines.find((l) => l.includes(version))!;
    expect(line.split(/\s+/).slice(0, 4)).toEqual(['trip-risk', version, 'registered', 'yes']);
    expect(line).toContain('0.757 demonstration');
  });
});

// --- The training dataset ----------------------------------------------------------------------------------------------

describe('the training dataset (npm run ml:trip-risk-dataset)', () => {
  test('every completed, measured trip, with its inputs as of its start and its labels, in the spec’s columns', async () => {
    const depot = await createDepot();
    const r = await route(depot);
    const driver = (await createDriver({ depot })).driver as Row;
    const vehicle = (await createVehicle({ depot })) as Row;
    const first = await pastTrip(r, { driver, vehicle, ago: 50, hours: 3, lateMin: 40 });
    const second = await pastTrip(r, { driver, vehicle, ago: 20, hours: 3, lateMin: 0 });
    const unmeasured = await pastTrip(r, { driver, vehicle, ago: 10, hours: 2, lateMin: 0, measured: false });

    const { csv } = await tripRisk.dataset();
    const [header, ...lines] = csv.trimEnd().split('\n');
    expect(header.split(',')).toEqual(['trip_id', 'driver_id', 'depot_id', 'as_of', 'source', ...spec().features, 'late', 'safety_event']);
    const rows = new Map(lines.map((l) => l.split(',')).map((cells) => [cells[0], Object.fromEntries(header.split(',').map((h, i) => [h, cells[i]]))]));
    expect(rows.has(unmeasured.public_id)).toBe(false);
    expect(rows.get(first.public_id)).toMatchObject({ driver_id: driver.public_id, depot_id: depot.public_id, source: 'fleet', late: '1', safety_event: '0', driver_trips_90d: '0' });
    // The second trip's record holds the first: one trip, late.
    expect(rows.get(second.public_id)).toMatchObject({ late: '0', driver_trips_90d: '1', driver_late_share_90d: '1', route_trips_90d: '1' });
    expect(rows.get(second.public_id)!.as_of).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});

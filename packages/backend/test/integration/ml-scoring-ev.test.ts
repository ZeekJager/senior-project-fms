import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { config } from '../../src/config';
import { pool } from '../../src/db';
// The modules as the app wires them: the EV module provides the EVs' battery and charging to the scoring.
import '../../src/modules';
import { integrationGateway } from '../../src/modules/integration';
import { EV_MAINTENANCE_MODEL, MAINTENANCE_MODEL, maintenanceScoring, mlModelAdmin, mlRegistry } from '../../src/modules/maintenance';
import { publishedEvents } from '../support/events';
import { createDepot, createUser, createVehicle } from '../support/factories';

// FMS-135: the nightly scoring sends every EV to the EV model (predictive-maintenance-ev, feature_spec_ev.json) and every
// other vehicle to the combustion model. Without an EV model that may score, the EVs are skipped and keep their score.
// Against a stub of the ML service serving both models (GET /model?name=, the batch's ?model=).

const TOKEN = 'z'.repeat(40);
const DAY_MS = 86_400_000;

type Row = Record<string, unknown> & { id: string };
type Item = { vehicle_id: string; as_of: string; features: Record<string, number> };

let combustionVersion = 'pm-test';
let evVersion: string | null = 'pm-ev-test';
const batches: { model: string; items: Item[] }[] = [];
let stub: http.Server;
const savedService = config.ml.service;

function described(name: string, version: string) {
  const spec = name === EV_MAINTENANCE_MODEL ? mlRegistry.evFeatureSpec() : mlRegistry.featureSpec();
  return {
    name,
    model_version: version,
    trained_at: '2026-11-20T08:00:00+00:00',
    algorithm: 'RandomForestClassifier with isotonic calibration',
    features: spec.features,
    feature_spec_version: spec.version,
    feature_spec_hash: spec.hash,
    artefact_sha256: (name === EV_MAINTENANCE_MODEL ? 'e' : 'c').repeat(64),
    training_data: { rows: 12000 },
    metrics: { roc_auc: 0.8 },
  };
}

beforeAll(async () => {
  stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.headers['x-internal-token'] !== TOKEN) {
        res.statusCode = 401;
        res.end('{}');
        return;
      }
      const url = new URL(req.url ?? '/', 'http://stub');
      const notFound = () => {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { code: 'NOT_FOUND' } }));
      };
      if (req.method === 'GET' && url.pathname === '/model') {
        const name = url.searchParams.get('name') ?? MAINTENANCE_MODEL;
        if (name === EV_MAINTENANCE_MODEL) return evVersion ? void res.end(JSON.stringify({ data: described(name, evVersion) })) : notFound();
        return void res.end(JSON.stringify({ data: described(MAINTENANCE_MODEL, combustionVersion) }));
      }
      if (req.method === 'POST' && url.pathname === '/internal/ml/predict-maintenance/batch') {
        const model = url.searchParams.get('model') ?? MAINTENANCE_MODEL;
        if (model === EV_MAINTENANCE_MODEL && !evVersion) return notFound();
        const { items } = JSON.parse(body) as { items: Item[] };
        batches.push({ model, items });
        const version = model === EV_MAINTENANCE_MODEL ? evVersion! : combustionVersion;
        // The EV model scores by the pack's health, the combustion model 90 for all.
        const score = (i: Item) => (model === EV_MAINTENANCE_MODEL ? Math.round(i.features.battery_health_pct) : 90);
        const data = items.map((i) => ({
          vehicle_id: i.vehicle_id,
          as_of: i.as_of,
          failure_probability: (100 - score(i)) / 100,
          health_score: score(i),
          risk_level: score(i) >= 75 ? 'low' : 'medium',
          prediction_horizon_days: 30,
          model_name: model,
          model_version: version,
          factors: [],
        }));
        return void res.end(JSON.stringify({ data }));
      }
      notFound();
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
  combustionVersion = `pm-test.${randomUUID().slice(0, 8)}`;
  evVersion = `pm-ev-test.${randomUUID().slice(0, 8)}`;
  batches.length = 0;
});

afterEach(() => integrationGateway.shutdown());

const localDay = (days = 1) => new Date(Date.now() + 3 * 3_600_000 + days * DAY_MS).toISOString().slice(0, 10);
const job = (runKey = localDay()) => ({ now: new Date(), correlationId: randomUUID(), runKey });

/** Registers the served model of that name and activates it as an administrator; returns its registry id. */
async function activate(name: string, version: string): Promise<string> {
  await mlRegistry.checkServing(job(), name === EV_MAINTENANCE_MODEL ? EV_MAINTENANCE_MODEL : MAINTENANCE_MODEL);
  const admin = await createUser({ roles: ['admin'] });
  const { rows } = await pool.query<{ public_id: string }>('SELECT public_id FROM maintenance.ml_models WHERE name = $1 AND version = $2', [name, version]);
  await mlModelAdmin.activate(rows[0].public_id, { userId: admin.id, correlationId: randomUUID() });
  return rows[0].public_id;
}

const statusOf = async (name: string, version: string) =>
  (await pool.query<{ status: string }>('SELECT status FROM maintenance.ml_models WHERE name = $1 AND version = $2', [name, version])).rows[0]?.status;
const predictionsOf = async (vehicle: Row) =>
  (await pool.query<{ model_name: string; health_score: number }>('SELECT model_name, health_score FROM maintenance.maintenance_predictions WHERE vehicle_id = $1 ORDER BY id', [vehicle.id])).rows;
const healthOf = async (vehicle: Row) => (await pool.query<{ health_score: number | null }>('SELECT health_score FROM fleet.vehicles WHERE id = $1', [vehicle.id])).rows[0].health_score;

async function mixedFleet() {
  const depot = await createDepot();
  const diesel = [await createVehicle({ depot, fuel_type: 'diesel' }), await createVehicle({ depot, fuel_type: 'diesel' })];
  const evs = [await createVehicle({ depot, fuel_type: 'electric', vehicle_type: 'van' }), await createVehicle({ depot, fuel_type: 'electric', vehicle_type: 'van' })];
  return { diesel, evs };
}

const ids = (rows: Row[]) => rows.map((r) => String(r.public_id)).sort();

describe('the nightly scoring of a mixed fleet (FMS-135)', () => {
  test('every EV is scored by the EV model on its own inputs, every other vehicle by the combustion model', async () => {
    await activate(MAINTENANCE_MODEL, combustionVersion);
    await activate(EV_MAINTENANCE_MODEL, evVersion!);
    const { diesel, evs } = await mixedFleet();
    // One EV reports its pack: 83% health, hot for a while yesterday.
    const t = new Date(`${localDay()}T00:00:00+03:00`);
    await pool.query(
      `INSERT INTO ev.ev_battery_logs (vehicle_id, state_of_charge, battery_health, battery_temperature_c, recorded_at)
       VALUES ($1, 60, 86, 30, $2), ($1, 40, 83, 47, $3), ($1, 35, 83, 30, $4)`,
      [evs[0].id, new Date(t.getTime() - 60 * DAY_MS), new Date(t.getTime() - DAY_MS), new Date(t.getTime() - DAY_MS + 5 * 3_600_000)],
    );

    const result = await maintenanceScoring.run(job());

    expect(result).toMatchObject({ vehicles: 4, scored: 4, skipped: 0, ev_vehicles: 2, skipped_no_model: 0, model_version: combustionVersion, ev_model_version: evVersion, blocked: null, ev_blocked: null });
    const byModel = (m: string) => batches.filter((b) => b.model === m).flatMap((b) => b.items);
    // The combustion model never gets an EV, nor the EV model anything else.
    expect(byModel(MAINTENANCE_MODEL).map((i) => i.vehicle_id).sort()).toEqual(ids(diesel));
    expect(byModel(EV_MAINTENANCE_MODEL).map((i) => i.vehicle_id).sort()).toEqual(ids(evs));
    for (const item of byModel(MAINTENANCE_MODEL)) expect(Object.keys(item.features)).toEqual(mlRegistry.featureSpec().features);
    for (const item of byModel(EV_MAINTENANCE_MODEL)) expect(Object.keys(item.features)).toEqual(mlRegistry.evFeatureSpec().features);
    const reported = byModel(EV_MAINTENANCE_MODEL).find((i) => i.vehicle_id === String(evs[0].public_id))!;
    // From its logs: newest health 83, 3 points down in 90 days, the hot reading 5 h to the next.
    expect(reported.features).toMatchObject({ battery_health_pct: 83, battery_health_drop_90d: 3, high_temp_hours_30d: 5 });

    expect(await predictionsOf(evs[0])).toEqual([{ model_name: EV_MAINTENANCE_MODEL, health_score: 83 }]);
    expect(await predictionsOf(diesel[0])).toEqual([{ model_name: MAINTENANCE_MODEL, health_score: 90 }]);
    expect(await healthOf(evs[0])).toBe(83);
  });

  test('with no EV model served, the EVs are skipped and keep their last score; the combustion model scores the rest', async () => {
    await activate(MAINTENANCE_MODEL, combustionVersion);
    const { diesel, evs } = await mixedFleet();
    await pool.query('UPDATE fleet.vehicles SET health_score = 77, health_score_updated_at = now() WHERE id = $1', [evs[0].id]);
    evVersion = null;

    const result = await maintenanceScoring.run(job());

    expect(result).toMatchObject({ vehicles: 4, scored: 2, skipped: 2, ev_vehicles: 2, skipped_no_model: 2, ev_blocked: 'no_model', ev_model_version: null, blocked: null });
    expect(batches.map((b) => b.model)).toEqual([MAINTENANCE_MODEL]);
    expect(batches[0].items.map((i) => i.vehicle_id).sort()).toEqual(ids(diesel));
    expect(await healthOf(evs[0])).toBe(77);
    expect(await predictionsOf(evs[0])).toEqual([]);
    // No alert: there is no EV model to fix.
    expect((await publishedEvents('MlScoringBlocked')).filter((e) => e.payload.model_name === EV_MAINTENANCE_MODEL)).toEqual([]);
  });

  test('an EV model served but not active scores nothing: the EVs are skipped, counted, and keep their score', async () => {
    await activate(MAINTENANCE_MODEL, combustionVersion);
    const { evs } = await mixedFleet();

    const result = await maintenanceScoring.run(job());

    expect(result).toMatchObject({ scored: 2, skipped_no_model: 2, ev_blocked: 'not_active', ev_model_version: evVersion });
    expect(batches.every((b) => b.model === MAINTENANCE_MODEL)).toBe(true);
    expect(await statusOf(EV_MAINTENANCE_MODEL, evVersion!)).toBe('registered');
    // Unlike no model at all, a model waiting for activation is an administrator's to act on.
    expect((await publishedEvents('MlScoringBlocked')).some((e) => e.payload.model_name === EV_MAINTENANCE_MODEL && e.payload.reason === 'not_active')).toBe(true);
    expect(await predictionsOf(evs[1])).toEqual([]);
  });

  test('an EV model trained on other inputs is refused, and an EV is never sent to the combustion model instead', async () => {
    await activate(MAINTENANCE_MODEL, combustionVersion);
    const { diesel } = await mixedFleet();
    // The service serves, under the EV name, a model of the combustion spec.
    const evName = evVersion!;
    const original = mlRegistry.evFeatureSpec;
    await mlRegistry.checkServing(job(), EV_MAINTENANCE_MODEL);
    await pool.query("UPDATE maintenance.ml_models SET feature_spec_hash = $1 WHERE name = $2 AND version = $3", [mlRegistry.featureSpec().hash, EV_MAINTENANCE_MODEL, evName]);

    const result = await maintenanceScoring.run(job());

    expect(original).toBe(mlRegistry.evFeatureSpec);
    expect(result).toMatchObject({ scored: 2, skipped_no_model: 2, ev_blocked: 'feature_spec_mismatch' });
    expect(batches.flatMap((b) => b.items).map((i) => i.vehicle_id).sort()).toEqual(ids(diesel));
  });

  test('activating or rolling back one model does not change the other', async () => {
    const firstCombustion = combustionVersion;
    await activate(MAINTENANCE_MODEL, firstCombustion);
    const firstEv = evVersion!;
    await activate(EV_MAINTENANCE_MODEL, firstEv);

    // A new combustion model: the EV model stays active.
    combustionVersion = `pm-test.${randomUUID().slice(0, 8)}`;
    await activate(MAINTENANCE_MODEL, combustionVersion);
    expect(await statusOf(MAINTENANCE_MODEL, firstCombustion)).toBe('retired');
    expect(await statusOf(EV_MAINTENANCE_MODEL, firstEv)).toBe('active');

    // A new EV model, then a rollback to the first: the combustion model is untouched throughout.
    evVersion = `pm-ev-test.${randomUUID().slice(0, 8)}`;
    await activate(EV_MAINTENANCE_MODEL, evVersion);
    expect(await statusOf(EV_MAINTENANCE_MODEL, firstEv)).toBe('retired');
    const admin = await createUser({ roles: ['admin'] });
    const { rows } = await pool.query<{ public_id: string }>('SELECT public_id FROM maintenance.ml_models WHERE name = $1 AND version = $2', [EV_MAINTENANCE_MODEL, firstEv]);
    await mlModelAdmin.activate(rows[0].public_id, { userId: admin.id, correlationId: randomUUID() });
    expect(await statusOf(EV_MAINTENANCE_MODEL, firstEv)).toBe('active');
    expect(await statusOf(EV_MAINTENANCE_MODEL, evVersion)).toBe('retired');
    expect(await statusOf(MAINTENANCE_MODEL, combustionVersion)).toBe('active');
  });
});

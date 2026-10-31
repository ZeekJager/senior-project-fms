import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { config } from '../../src/config';
import { pool } from '../../src/db';
import { integrationGateway } from '../../src/modules/integration';
import { maintenanceScoring, mlModelAdmin, mlRegistry } from '../../src/modules/maintenance';
import { logger } from '../../src/shared/logging/logger';
import { createDepot, createDriver, createUser, createVehicle } from '../support/factories';
import { deliverEvents, publishedEvents } from '../support/events';

// The nightly scoring (FMS-55): every vehicle in service gets the inputs of feature_spec.json from the
// core's tables, a health score from the active model through the ML service in batches, and a risk event
// below 75. Against a stub of the ML service (GET /model and the batch endpoint, api-contract §10.3).

const TOKEN = 'y'.repeat(40);
const DAY_MS = 86_400_000;
const NAME = 'predictive-maintenance';

type Row = Record<string, unknown> & { id: string };

/** The stub ML service. `mode`: everything up, everything down, or only predictions failing (503). */
let mode: 'up' | 'down' | 'batch_down' = 'up';
let servingVersion = 'pm-test';
/** When set, predictions say they come from this model rather than the one GET /model describes. */
let predictedVersion: string | null = null;
/** The health score the stub gives each vehicle (public id); 90 otherwise. */
const scores = new Map<string, number>();
const batches: { items: { vehicle_id: string; as_of: string; features: Record<string, number> }[]; token: unknown; requestId: unknown }[] = [];
let stub: http.Server;
const savedService = config.ml.service;

function servedModel(version: string) {
  return {
    name: NAME,
    model_version: version,
    trained_at: '2026-10-20T08:00:00+00:00',
    algorithm: 'RandomForestClassifier with isotonic calibration',
    features: mlRegistry.featureSpec().features,
    feature_spec_version: 2,
    feature_spec_hash: mlRegistry.featureSpec().hash,
    artefact_sha256: 'a'.repeat(64),
    training_data: { rows: 12000 },
    metrics: { roc_auc: 0.831 },
  };
}

function predict(item: { vehicle_id: string; as_of: string }) {
  const score = scores.get(item.vehicle_id) ?? 90;
  return {
    vehicle_id: item.vehicle_id,
    as_of: item.as_of,
    failure_probability: (100 - score) / 100,
    health_score: score,
    risk_level: score >= 75 ? 'low' : score <= 40 ? 'high' : 'medium',
    prediction_horizon_days: 30,
    model_version: predictedVersion ?? servingVersion,
    factors: score < 75 ? ['days_since_last_service', 'km_since_oil_change'] : [],
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
        res.end(JSON.stringify({ error: { code: 'AUTH_TOKEN_INVALID' } }));
        return;
      }
      if (mode === 'down') {
        res.statusCode = 503;
        res.end('{}');
        return;
      }
      if (req.method === 'GET' && req.url === '/model') {
        res.end(JSON.stringify({ data: servedModel(servingVersion) }));
        return;
      }
      if (req.method === 'POST' && req.url === '/internal/ml/predict-maintenance/batch') {
        const parsed = JSON.parse(body) as { items: (typeof batches)[number]['items'] };
        batches.push({ items: parsed.items, token: req.headers['x-internal-token'], requestId: req.headers['x-request-id'] });
        if (mode === 'batch_down') {
          res.statusCode = 503;
          res.end('{}');
          return;
        }
        res.end(JSON.stringify({ data: parsed.items.map(predict) }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
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
  mode = 'up';
  servingVersion = `pm-test.${randomUUID().slice(0, 8)}`;
  predictedVersion = null;
  scores.clear();
  batches.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  // Each test starts with the ML service's breaker closed.
  integrationGateway.shutdown();
});

/** The local day `days` from today (Addis Ababa), a run key. Tomorrow by default, so what the test writes now is before t. */
const localDay = (days = 1) => new Date(Date.now() + 3 * 3_600_000 + days * DAY_MS).toISOString().slice(0, 10);
const job = (runKey = localDay()) => ({ now: new Date(), correlationId: randomUUID(), runKey });
/** The scoring time of a run key: the start of that day, Addis Ababa. */
const tOf = (runKey: string) => new Date(`${runKey}T00:00:00+03:00`);

/** Registers the served model, and activates it as an administrator. */
async function activeModel(): Promise<void> {
  await mlRegistry.checkServing(job());
  const admin = await createUser({ roles: ['admin'] });
  const { rows } = await pool.query<{ public_id: string }>('SELECT public_id FROM maintenance.ml_models WHERE name = $1 AND version = $2', [NAME, servingVersion]);
  await mlModelAdmin.activate(rows[0].public_id, { userId: admin.id, correlationId: randomUUID() });
}

const predictions = async (vehicle: Row) =>
  (await pool.query('SELECT * FROM maintenance.maintenance_predictions WHERE vehicle_id = $1 ORDER BY id', [vehicle.id])).rows as Record<string, unknown>[];
const vehicleRow = async (vehicle: Row) => (await pool.query('SELECT * FROM fleet.vehicles WHERE id = $1', [vehicle.id])).rows[0] as Record<string, unknown>;

/** `n` vehicles in one statement, each with a completed trip and a fill-up in the last 30 days. */
async function fleetOf(n: number, depot: Row): Promise<Row[]> {
  const { driver } = await createDriver({ depot });
  const tag = randomUUID().slice(0, 6);
  const vehicles = (
    await pool.query<Row>(
      `INSERT INTO fleet.vehicles (depot_id, registration_number, vehicle_type, fuel_type, fuel_efficiency_ml_per_km, make, model, model_year, odometer_km)
       SELECT $1, 'SC-' || $2 || '-' || g, 'truck', 'diesel', 320, 'Isuzu', 'FSR', 2015 + g % 10, 50000 + g * 100
         FROM generate_series(1, $3) g
       RETURNING id, public_id`,
      [depot.id, tag, n],
    )
  ).rows;
  const ids = vehicles.map((v) => v.id);
  const end = new Date(Date.now() - 2 * DAY_MS);
  await pool.query(
    `INSERT INTO trip.trips (vehicle_id, driver_id, status, scheduled_start, scheduled_end, actual_start, actual_end, actual_distance_km, actual_duration_seconds)
     SELECT v, $2, 'completed', $3::timestamptz - interval '5 hours', $3, $3::timestamptz - interval '5 hours', $3, 350, 18000
       FROM unnest($1::bigint[]) v`,
    [ids, driver.id, end],
  );
  await pool.query(
    `INSERT INTO fuel.fuel_logs (vehicle_id, fuel_type, quantity_ml, total_cost_cents, recorded_at)
     SELECT v, 'diesel', 120000, 900000, $2 FROM unnest($1::bigint[]) v`,
    [ids, end],
  );
  return vehicles;
}

describe('the nightly scoring', () => {
  test('scores every vehicle in service with the active model, and keeps each prediction and the health score', async () => {
    await activeModel();
    const depot = await createDepot();
    const [active, inWorkshop, retired, parked] = [
      await createVehicle({ depot }),
      await createVehicle({ depot, status: 'maintenance' }),
      await createVehicle({ depot, status: 'retired', is_active: false }),
      await createVehicle({ depot, status: 'inactive' }),
    ];
    scores.set(String(active.public_id), 82);
    const context = job();

    const result = await maintenanceScoring.run(context);

    expect(result).toMatchObject({ vehicles: 3, scored: 3, skipped: 0, already_scored: 0, risk_events: 0, batches_failed: 0, model_version: servingVersion, blocked: null });
    // One batch, with the token and the run's correlation id, every input of the spec for each vehicle.
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ token: TOKEN, requestId: context.correlationId });
    expect(batches[0].items.map((i) => i.vehicle_id)).toEqual([active.public_id, inWorkshop.public_id, parked.public_id]);
    expect(batches[0].items[0].as_of).toBe(`${context.runKey}T00:00:00+03:00`);
    expect(Object.keys(batches[0].items[0].features)).toEqual(mlRegistry.featureSpec().features);

    const [stored] = await predictions(active);
    expect(stored).toMatchObject({
      model_name: NAME,
      model_version: servingVersion,
      prediction_type: 'failure_within_30_days',
      risk_score: '0.18000',
      health_score: 82,
      risk_level: 'low',
      factors: [],
      prediction_horizon_days: 30,
      status: 'active',
      feature_snapshot: batches[0].items[0].features,
    });
    expect((stored.as_of as Date).toISOString()).toBe(tOf(context.runKey).toISOString());
    expect(await vehicleRow(active)).toMatchObject({ health_score: 82, health_score_updated_at: context.now });
    expect((await vehicleRow(inWorkshop)).health_score).toBe(90);
    expect(await predictions(retired)).toEqual([]);
    expect((await vehicleRow(retired)).health_score).toBeNull();

    // Audited as the system, with the run's correlation id.
    const audit = await pool.query(
      `SELECT entity_type, action, user_id FROM audit.audit_logs WHERE correlation_id = $1 AND entity_type IN ('maintenance.maintenance_predictions', 'fleet.vehicles') ORDER BY id`,
      [context.correlationId],
    );
    expect(audit.rows).toHaveLength(6);
    expect(audit.rows.every((r) => r.user_id === null)).toBe(true);
  });

  test("computes each input from the core's own tables, as of the start of the day", async () => {
    await activeModel();
    const depot = await createDepot();
    const { user, driver } = await createDriver({ depot });
    const vehicle = await createVehicle({ depot, model_year: 2018, odometer_km: 87_000, fuel_efficiency_ml_per_km: 320 });
    const runKey = localDay();
    const t = tOf(runKey);
    const ago = (days: number, hours = 0) => new Date(t.getTime() - days * DAY_MS - hours * 3_600_000);

    const trip = (end: Date, km: number, seconds: number, status = 'completed') =>
      pool.query(
        `INSERT INTO trip.trips (vehicle_id, driver_id, status, scheduled_start, scheduled_end, actual_start, actual_end, actual_distance_km, actual_duration_seconds)
         VALUES ($1, $2, $3, $4, $5, $4, $6, $7, $8)`,
        [vehicle.id, driver.id, status, new Date(end.getTime() - seconds * 1000), end, status === 'completed' ? end : null, km, seconds],
      );
    await trip(ago(5), 300.5, 5 * 3600);
    await trip(ago(10), 199.5, 3 * 3600);
    // Before the window (and before the oil change), and one not completed.
    await trip(ago(40), 1000, 10 * 3600);
    await trip(ago(1), 80, 3600, 'en_route');
    // After t: never seen.
    await trip(new Date(t.getTime() + 3_600_000), 500, 3600);

    // 165 l over 500 km is 330 ml/km against 320 expected: +3.1%.
    await pool.query(`INSERT INTO fuel.fuel_logs (vehicle_id, fuel_type, quantity_ml, total_cost_cents, recorded_at) VALUES ($1, 'diesel', 165000, 1, $2)`, [vehicle.id, ago(6)]);
    await pool.query(`INSERT INTO fuel.fuel_logs (vehicle_id, fuel_type, quantity_ml, total_cost_cents, recorded_at) VALUES ($1, 'diesel', 90000, 1, $2)`, [vehicle.id, ago(45)]);

    // Faults: a DVIR with issues and a breakdown in the last 90 days; not a clean DVIR, an accident or an old breakdown.
    const dvir = (at: Date, issues: boolean) =>
      pool.query(`INSERT INTO fleet.dvir_reports (vehicle_id, driver_id, inspection_type, issues_found, submitted_at) VALUES ($1, $2, 'pre_trip', $3, $4)`, [vehicle.id, driver.id, issues, at]);
    await dvir(ago(10), true);
    await dvir(ago(11), false);
    const incident = (type: string, at: Date) =>
      pool.query(`INSERT INTO alert.incident_reports (vehicle_id, reported_by, incident_type, description, occurred_at) VALUES ($1, $2, $3, 'Test', $4)`, [vehicle.id, user.id, type, at]);
    await incident('breakdown', ago(20));
    await incident('accident', ago(21));
    await incident('tyre', ago(120));

    // A service 30 days ago changed the oil; an older repair 200 days ago changed the battery; a repair still open changed the coolant.
    const part = async (item: string | null) =>
      (await pool.query<Row>(`INSERT INTO maintenance.inventory_parts (part_number, name, unit_cost_cents, service_item) VALUES ($1, $1, 100, $2) RETURNING id`, [`P-${randomUUID().slice(0, 8)}`, item])).rows[0];
    const repair = async (type: string, status: string, completedAt: Date | null, parts: Row[]) => {
      const record = (
        await pool.query<Row>(
          `INSERT INTO maintenance.maintenance_records (vehicle_id, maintenance_type, status, description, completed_at, created_at) VALUES ($1, $2, $3, 'Test', $4, $5) RETURNING id`,
          [vehicle.id, type, status, completedAt, completedAt ? new Date(completedAt.getTime() - 3_600_000) : new Date()],
        )
      ).rows[0];
      for (const p of parts) await pool.query('INSERT INTO maintenance.maintenance_parts (maintenance_record_id, inventory_part_id, quantity, unit_cost_cents) VALUES ($1, $2, 1, 100)', [record.id, p.id]);
    };
    await repair('preventive', 'completed', ago(30, 2), [await part('engine_oil'), await part(null)]);
    await repair('corrective', 'completed', ago(200), [await part('battery')]);
    await repair('corrective', 'in_progress', null, [await part('coolant')]);

    // The engine-hour meter was read 35 days ago and yesterday: 1,200.0 to 1,242.5 h.
    for (const [value, at] of [
      [1200, ago(35)],
      [1242.5, t],
    ] as const) {
      await pool.query(`INSERT INTO fleet.meter_readings (vehicle_id, meter, value, source, recorded_at) VALUES ($1, 'engine_hours', $2, 'manual', $3)`, [vehicle.id, value, at]);
    }

    await maintenanceScoring.run(job(runKey));

    const sinceBuilt = Math.floor((t.getTime() - Date.parse('2018-01-01T00:00:00+03:00')) / DAY_MS);
    expect(batches[0].items[0].features).toEqual({
      mileage_km: 500,
      engine_hours: 42.5,
      days_since_last_service: 30,
      num_fault_reports: 2,
      fuel_variance_pct: 3.1,
      age_years: Math.round((sinceBuilt / 365.25) * 10) / 10,
      days_since_oil_change: 30,
      km_since_oil_change: 500,
      km_since_air_filter_change: 87_000,
      km_since_fuel_filter_change: 87_000,
      days_since_coolant_change: sinceBuilt,
      km_since_brake_pad_change: 87_000,
      days_since_brake_fluid_change: sinceBuilt,
      days_since_clutch_fluid_change: sinceBuilt,
      km_since_tyre_change: 87_000,
      days_since_tyre_change: sinceBuilt,
      days_since_battery_change: 200,
      km_since_gearbox_oil_change: 87_000,
      km_since_belt_change: 87_000,
    });
  });

  test('a score of 60 raises a risk event and an alert; 80 does not; staying below raises no other', async () => {
    await activeModel();
    const depot = await createDepot();
    const [risky, fine] = [await createVehicle({ depot }), await createVehicle({ depot })];
    scores.set(String(risky.public_id), 60);
    scores.set(String(fine.public_id), 80);

    const first = await maintenanceScoring.run(job());

    expect(first.risk_events).toBe(1);
    const [event] = await publishedEvents('MaintenanceRiskDetected');
    const [prediction] = await predictions(risky);
    expect(event.payload).toEqual({
      prediction_id: prediction.public_id,
      vehicle_id: risky.public_id,
      risk_level: 'medium',
      failure_probability: 0.4,
      health_score: 60,
      previous_health_score: null,
      factors: ['days_since_last_service', 'km_since_oil_change'],
      component: null,
      model_name: NAME,
      model_version: servingVersion,
      as_of: tOf(localDay()).toISOString(),
    });
    await deliverEvents();
    const alerts = await pool.query("SELECT vehicle_id, severity, title, description FROM alert.alerts WHERE alert_type = 'maintenance_risk' ORDER BY id");
    expect(alerts.rows).toEqual([
      {
        vehicle_id: risky.id,
        severity: 'medium',
        title: `Maintenance risk on ${String(risky.registration_number)}`,
        description:
          'Health score 60, a 40% chance of a breakdown within 30 days, mostly from days since last service, km since oil change. Schedule an inspection.',
      },
    ]);

    // The next night: still 60, no new event; worse (35, high), one.
    await maintenanceScoring.run(job(localDay(2)));
    expect(await publishedEvents('MaintenanceRiskDetected')).toHaveLength(1);
    scores.set(String(risky.public_id), 35);
    const third = await maintenanceScoring.run(job(localDay(3)));
    expect(third.risk_events).toBe(1);
    expect((await publishedEvents('MaintenanceRiskDetected')).at(-1)!.payload).toMatchObject({ risk_level: 'high', health_score: 35, previous_health_score: 60 });
    // Each night's prediction supersedes the last.
    expect((await predictions(risky)).map((p) => [p.health_score, p.status])).toEqual([
      [60, 'superseded'],
      [60, 'superseded'],
      [35, 'active'],
    ]);
  });

  test('a run retried the same day scores only what it had not', async () => {
    await activeModel();
    const depot = await createDepot();
    await createVehicle({ depot });
    const runKey = localDay();
    await maintenanceScoring.run(job(runKey));

    await createVehicle({ depot });
    const retry = await maintenanceScoring.run(job(runKey));

    expect(retry).toMatchObject({ vehicles: 2, scored: 1, already_scored: 1 });
    expect(batches.map((b) => b.items.length)).toEqual([1, 1]);
  });

  test('ML service down: the run logs it, skips every vehicle and finishes', async () => {
    await activeModel();
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    mode = 'down';
    const errors = vi.spyOn(logger, 'error');

    const result = await maintenanceScoring.run(job());

    expect(result).toMatchObject({ vehicles: 1, scored: 0, skipped: 1, blocked: 'ml_unavailable' });
    expect(errors).toHaveBeenCalledWith(expect.objectContaining({ event: 'maintenance.scoring_skipped', reason: 'GET /model answered 503' }), expect.any(String));
    expect(await predictions(vehicle)).toEqual([]);
    expect((await vehicleRow(vehicle)).health_score).toBeNull();
  });

  test('predictions failing: the breaker opens, the remaining batches fail fast, and the run finishes', async () => {
    await activeModel();
    const depot = await createDepot();
    await fleetOf(250, depot);
    mode = 'batch_down';
    const errors = vi.spyOn(logger, 'error');

    const result = await maintenanceScoring.run(job());

    expect(result).toMatchObject({ vehicles: 250, scored: 0, skipped: 250, batches_failed: 3 });
    // Two GET /model calls succeeded; batch 1's three attempts fail, which opens the breaker (3 of 5 calls
    // failed). Batches 2 and 3 never reach the service.
    expect(batches).toHaveLength(3);
    const reasons = errors.mock.calls.map(([obj]) => (obj as { reason?: string }).reason);
    expect(reasons).toEqual([
      'POST /internal/ml/predict-maintenance/batch answered 503',
      'Calls to ml-service are paused after repeated failures',
      'Calls to ml-service are paused after repeated failures',
    ]);
  });

  test('scores nothing while the served model may not score, or when a batch comes back from another model', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });

    // Registered on sight, not yet active.
    const waiting = await maintenanceScoring.run(job());
    expect(waiting).toMatchObject({ scored: 0, skipped: 1, blocked: 'not_active', model_version: servingVersion });
    expect(batches).toHaveLength(0);
    expect(await publishedEvents('MlScoringBlocked')).toHaveLength(1);

    await activeModel();
    // The service restarted with another model after the check: its answers are not stored.
    predictedVersion = 'pm-other';
    const errors = vi.spyOn(logger, 'error');
    const result = await maintenanceScoring.run(job(localDay(2)));
    expect(result).toMatchObject({ scored: 0, skipped: 1, batches_failed: 1 });
    expect(errors).toHaveBeenCalledWith(expect.objectContaining({ reason: `the ML service answered with model pm-other, not ${servingVersion}` }), expect.any(String));
    expect(await predictions(vehicle)).toEqual([]);
  });

  test('scores 200 vehicles in under 90 seconds', async () => {
    await activeModel();
    const depot = await createDepot();
    await fleetOf(200, depot);

    const started = Date.now();
    const result = await maintenanceScoring.run(job());
    const seconds = (Date.now() - started) / 1000;

    expect(result).toMatchObject({ vehicles: 200, scored: 200, skipped: 0 });
    expect(batches.map((b) => b.items.length)).toEqual([100, 100]);
    expect(seconds).toBeLessThan(90);
  }, 120_000);
});

import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { createApp } from '../../src/app';
import { config } from '../../src/config';
import { pool } from '../../src/db';
import { MlServiceError, mlRegistry } from '../../src/modules/maintenance';
import { logger } from '../../src/shared/logging/logger';
import { mlModelCommand } from '../../scripts/lib/ml-model-cli';
import { createDepot, createUser, createVehicle, type RoleName } from '../support/factories';
import { deliverEvents, publishedEvents } from '../support/events';

// The model registry (FMS-127): every model the ML service serves is registered the first time the
// scoring job sees it, scores only once an administrator activates it, and never when its inputs are not
// the ones the core computes. Against a stub of the ML service's GET /model (FMS-54).

const app = createApp();
const PASSWORD = 'Ml-Models-Test-1';
const TOKEN = 'x'.repeat(40);
const CORE_HASH = mlRegistry.featureSpec().hash;
const OTHER_HASH = 'f'.repeat(64);

/** GET /model's data, as the ML service describes a model (docs/ml-service.md). */
function servedModel(version: string, overrides: Record<string, unknown> = {}) {
  return {
    name: 'predictive-maintenance',
    model_version: version,
    trained_at: '2026-10-20T08:00:00+00:00',
    algorithm: 'RandomForestClassifier with isotonic calibration (CalibratedClassifierCV, ensemble=False)',
    features: mlRegistry.featureSpec().features,
    feature_spec_version: 2,
    feature_spec_hash: CORE_HASH,
    artefact_sha256: 'a'.repeat(64),
    training_data: { file: 'training_data.csv', sha256: 'b'.repeat(64), rows: 12000, vehicles: 500, from: '2025-01-01', to: '2026-09-30' },
    metrics: { roc_auc: 0.831, brier: 0.11, at_alert_threshold: { health_score_below: 75, precision: 0.5, recall: 0.66, f1: 0.57 } },
    health_score: 'round((1 - p) * 100)',
    ...overrides,
  };
}

/** The stub ML service: answers GET /model with `serving`, and 401 without the token. */
let serving: Record<string, unknown> = {};
let stub: http.Server;
const requests: { token: string | undefined; requestId: string | undefined }[] = [];
const savedService = config.ml.service;

beforeAll(async () => {
  stub = http.createServer((req, res) => {
    requests.push({ token: req.headers['x-internal-token'] as string | undefined, requestId: req.headers['x-request-id'] as string | undefined });
    res.setHeader('content-type', 'application/json');
    if (req.headers['x-internal-token'] !== TOKEN) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: { code: 'AUTH_TOKEN_INVALID' } }));
      return;
    }
    res.end(JSON.stringify({ data: serving, meta: { request_id: req.headers['x-request-id'] } }));
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  config.ml.service = { url: `http://127.0.0.1:${(stub.address() as AddressInfo).port}`, token: TOKEN };
});

afterAll(async () => {
  config.ml.service = savedService;
  await new Promise<void>((resolve) => stub.close(() => resolve()));
});

beforeEach(() => {
  requests.length = 0;
});

const job = (runKey = '2026-10-25') => ({ now: new Date(), correlationId: randomUUID(), runKey });
const version = () => `pm-2026.${String(Math.floor(Math.random() * 1e6))}`;

async function signIn(roles: RoleName[]): Promise<{ cookie: string; user: Record<string, unknown> }> {
  const user = await createUser({ roles, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return { cookie: (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; '), user };
}

const api = {
  get: (path: string, cookie: string) => request(app).get(`/api/v1${path}`).set('Cookie', cookie),
  post: (path: string, cookie: string) => request(app).post(`/api/v1${path}`).set('Cookie', cookie).send({}),
};

const registry = async () =>
  (await pool.query('SELECT * FROM maintenance.ml_models ORDER BY id')).rows as (Record<string, unknown> & { id: string; public_id: string })[];

async function adminAlerts(admin: Record<string, unknown>) {
  const res = await pool.query(
    `SELECT a.alert_type, a.severity, a.title, a.description, a.entity_type, a.entity_id, a.occurrence_count
       FROM alert.alerts a JOIN alert.notifications n ON n.alert_id = a.id
      WHERE n.recipient_user_id = $1 ORDER BY a.id`,
    [admin.id],
  );
  return res.rows;
}

describe('a new model version is registered the first time the scoring job sees it', () => {
  test('with its features, feature spec hash, metrics, training data and checksum; once', async () => {
    const v = version();
    serving = servedModel(v);
    const first = await mlRegistry.checkServing(job());
    expect(first).toMatchObject({ ok: false, reason: 'not_active', registered: true, model: { name: 'predictive-maintenance', version: v, status: 'registered' } });
    expect(requests).toHaveLength(1);
    expect(requests[0].token).toBe(TOKEN);
    expect(requests[0].requestId).toMatch(/^[0-9a-f-]{36}$/);

    const [row] = await registry();
    expect(row).toMatchObject({
      name: 'predictive-maintenance',
      version: v,
      status: 'registered',
      features: mlRegistry.featureSpec().features,
      feature_spec_version: 2,
      feature_spec_hash: CORE_HASH,
      artefact_sha256: 'a'.repeat(64),
      training_data: expect.objectContaining({ rows: 12000, sha256: 'b'.repeat(64) }),
      metrics: expect.objectContaining({ roc_auc: 0.831, at_alert_threshold: expect.objectContaining({ precision: 0.5, recall: 0.66, f1: 0.57 }) }),
      activated_at: null,
      retired_at: null,
    });
    const audit = await pool.query("SELECT action FROM audit.audit_logs WHERE entity_type = 'maintenance.ml_models' AND entity_id = $1", [row.id]);
    expect(audit.rows).toEqual([{ action: 'INSERT' }]);

    // Seen again: the same registration, nothing new.
    const again = await mlRegistry.checkServing(job());
    expect(again).toMatchObject({ ok: false, reason: 'not_active', registered: false, model: { publicId: row.public_id } });
    expect(await registry()).toHaveLength(1);
  });

  test('the registry is read with prediction:read; a driver cannot', async () => {
    const v = version();
    serving = servedModel(v);
    await mlRegistry.checkServing(job());
    const { cookie: tech } = await signIn(['technician']);
    const res = await api.get('/ml-models', tech);
    expect(res.status).toBe(200);
    expect(res.body.meta.total_items).toBe(1);
    const [model] = res.body.data;
    expect(model).toMatchObject({
      name: 'predictive-maintenance',
      version: v,
      status: 'registered',
      features_match: true,
      feature_spec_hash: CORE_HASH,
      metrics: { roc_auc: 0.831 },
      training_data: { rows: 12000 },
      activated_at: null,
      activated_by: null,
    });
    expect(model).not.toHaveProperty('id', expect.stringMatching(/^\d+$/));
    expect((await api.get(`/ml-models/${model.id}`, tech)).body.data).toEqual(model);
    expect((await api.get('/ml-models?status=active', tech)).body.data).toEqual([]);
    expect((await api.get(`/ml-models/${randomUUID()}`, tech)).status).toBe(404);
    expect((await api.get('/ml-models/42', tech)).status).toBe(404);
    expect((await api.get('/ml-models?status=deleted', tech)).status).toBe(400);

    const { cookie: driver } = await signIn(['driver']);
    expect((await api.get('/ml-models', driver)).status).toBe(403);
  });
});

describe('a model scores only once an administrator activates it', () => {
  test('until then the scoring job is told not to score, and administrators are alerted', async () => {
    const v = version();
    serving = servedModel(v);
    const { user: admin } = await signIn(['admin']);
    expect((await mlRegistry.checkServing(job())).ok).toBe(false);
    await deliverEvents();
    expect(await adminAlerts(admin)).toEqual([
      expect.objectContaining({ alert_type: 'ml_scoring_blocked', severity: 'medium', entity_type: 'ml_model', title: `Maintenance scoring paused: model ${v}` }),
    ]);
  });

  test('activation lets it score; a newer one retires it; activating the older again is a rollback', async () => {
    const [older, newer] = [version(), version()];
    const { cookie: admin, user: adminUser } = await signIn(['admin']);
    serving = servedModel(older);
    const { model } = await mlRegistry.checkServing(job());

    const { cookie: manager } = await signIn(['fleet_manager']);
    expect((await api.post(`/ml-models/${model.publicId}/activate`, manager)).status).toBe(403);

    const activated = await api.post(`/ml-models/${model.publicId}/activate`, admin);
    expect(activated.status).toBe(200);
    expect(activated.body.data).toMatchObject({ version: older, status: 'active', activated_by: adminUser.public_id, retired_at: null });
    expect(activated.body.data.activated_at).toBeTruthy();
    // Again: nothing changes.
    expect((await api.post(`/ml-models/${model.publicId}/activate`, admin)).body.data).toEqual(activated.body.data);

    expect(await mlRegistry.checkServing(job())).toMatchObject({ ok: true, model: { version: older, status: 'active' } });

    // A new version is deployed: registered, not scoring until activated.
    serving = servedModel(newer, { artefact_sha256: 'c'.repeat(64) });
    const next = await mlRegistry.checkServing(job());
    expect(next).toMatchObject({ ok: false, reason: 'not_active', registered: true });
    expect((await api.post(`/ml-models/${next.model.publicId}/activate`, admin)).body.data.status).toBe('active');
    expect(await mlRegistry.checkServing(job())).toMatchObject({ ok: true, model: { version: newer } });
    const byVersion = Object.fromEntries((await registry()).map((r) => [r.version, r]));
    expect(byVersion[older]).toMatchObject({ status: 'retired' });
    expect(byVersion[older].retired_at).toBeTruthy();

    // Rollback: the older is active again, the newer retired; the service still serving the newer is told not to score.
    expect((await api.post(`/ml-models/${model.publicId}/activate`, admin)).body.data).toMatchObject({ status: 'active', retired_at: null });
    expect(await mlRegistry.checkServing(job())).toMatchObject({ ok: false, reason: 'not_active', model: { version: newer, status: 'retired' } });
    expect((await registry()).filter((r) => r.status === 'active').map((r) => r.version)).toEqual([older]);
  });
});

describe('a model trained on other inputs than the core computes never scores', () => {
  test('scoring stops, the error is logged, administrators are alerted, and it cannot be activated', async () => {
    const v = version();
    serving = servedModel(v, { feature_spec_hash: OTHER_HASH, feature_spec_version: 3 });
    const { cookie, user: admin } = await signIn(['admin']);
    const logged = vi.spyOn(logger, 'error');
    try {
      const check = await mlRegistry.checkServing(job());
      expect(check).toMatchObject({ ok: false, reason: 'feature_spec_mismatch', registered: true, model: { version: v } });
      expect(logged).toHaveBeenCalledWith(
        expect.objectContaining({ model_version: v, reason: 'feature_spec_mismatch', feature_spec_hash: OTHER_HASH, expected_feature_spec_hash: CORE_HASH }),
        expect.stringContaining('scoring refused'),
      );
    } finally {
      logged.mockRestore();
    }

    const [event] = await publishedEvents('MlScoringBlocked');
    expect(event.payload).toMatchObject({ model_version: v, reason: 'feature_spec_mismatch', feature_spec_hash: OTHER_HASH, expected_feature_spec_hash: CORE_HASH });
    expect(event.actor).toBeNull();
    await deliverEvents();
    expect(await adminAlerts(admin)).toEqual([expect.objectContaining({ alert_type: 'ml_scoring_blocked', severity: 'high', entity_id: event.payload.model_id })]);

    // Recorded all the same, so it can be traced; marked as not matching.
    const listed = (await api.get('/ml-models', cookie)).body.data;
    expect(listed).toEqual([expect.objectContaining({ version: v, feature_spec_hash: OTHER_HASH, features_match: false, status: 'registered' })]);
    const refused = await api.post(`/ml-models/${listed[0].id}/activate`, cookie);
    expect(refused.status).toBe(409);
    expect(refused.body.error.details).toEqual([{ field: 'feature_spec_hash', reason: 'feature_spec_mismatch' }]);
    expect((await registry())[0].status).toBe('registered');

    // The same night again: one alert, not two.
    await mlRegistry.checkServing(job());
    await deliverEvents();
    expect(await adminAlerts(admin)).toHaveLength(1);
  });

  test('an active model served under its version with another artefact stops scoring too', async () => {
    const v = version();
    serving = servedModel(v);
    const { cookie } = await signIn(['admin']);
    const { model } = await mlRegistry.checkServing(job());
    await api.post(`/ml-models/${model.publicId}/activate`, cookie);
    serving = servedModel(v, { artefact_sha256: 'd'.repeat(64) });
    expect(await mlRegistry.checkServing(job())).toMatchObject({ ok: false, reason: 'artefact_mismatch', model: { status: 'active' } });
    expect((await registry())[0].artefact_sha256).toBe('a'.repeat(64));
  });
});

describe('the ML service', () => {
  test('a wrong token, a bad answer or no service registers nothing', async () => {
    serving = servedModel(version());
    config.ml.service = { ...config.ml.service!, token: 'y'.repeat(40) };
    await expect(mlRegistry.checkServing(job())).rejects.toThrow(new MlServiceError('GET /model answered 401'));
    config.ml.service = { ...config.ml.service, token: TOKEN };

    serving = { ...servedModel(version()), feature_spec_hash: 'not-a-hash' };
    await expect(mlRegistry.checkServing(job())).rejects.toThrow(/without feature_spec_hash/);

    const url = config.ml.service.url;
    config.ml.service = null;
    try {
      await expect(mlRegistry.checkServing(job())).rejects.toThrow(/ML_SERVICE_URL is not set/);
    } finally {
      config.ml.service = { url, token: TOKEN };
    }
    expect(await registry()).toEqual([]);
  });
});

describe('every stored prediction names a registered model', () => {
  test('a version the registry does not hold cannot be stored', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const v = version();
    const insert = (modelVersion: string) =>
      pool.query(
        `INSERT INTO maintenance.maintenance_predictions (vehicle_id, model_name, model_version, prediction_type, risk_score, prediction_horizon_days)
         VALUES ($1, 'predictive-maintenance', $2, 'unplanned_failure', 0.4, 30)`,
        [vehicle.id, modelVersion],
      );
    await expect(insert(v)).rejects.toMatchObject({ code: '23503', constraint: 'fk_predictions_ml_model' });

    serving = servedModel(v);
    await mlRegistry.checkServing(job());
    await insert(v);
    const stored = await pool.query(
      `SELECT m.version, m.feature_spec_hash FROM maintenance.maintenance_predictions p
         JOIN maintenance.ml_models m ON m.name = p.model_name AND m.version = p.model_version WHERE p.vehicle_id = $1`,
      [vehicle.id],
    );
    expect(stored.rows).toEqual([{ version: v, feature_spec_hash: CORE_HASH }]);
  });
});

describe('npm run ml:model: the registry from the command line', () => {
  const run = async (...argv: string[]) => {
    const lines: string[] = [];
    await mlModelCommand(argv, (line) => lines.push(line));
    return lines;
  };

  test('lists the models, and activates one as the named administrator', async () => {
    expect(await run('list')).toEqual([expect.stringContaining('No model registered yet')]);
    const v = version();
    serving = servedModel(v);
    await mlRegistry.checkServing(job());
    const admin = await createUser({ roles: ['admin'] });
    const listed = await run('list');
    expect(listed[0]).toMatch(/^VERSION\s+STATUS\s+FEATURES MATCH/);
    expect(listed[1].split(/\s+/).slice(0, 4)).toEqual([v, 'registered', 'yes', '0.831']);

    expect(await run('activate', v, '--by', String(admin.email).toUpperCase())).toEqual([expect.stringContaining(`predictive-maintenance ${v} is active`)]);
    const [row] = await registry();
    expect(row).toMatchObject({ status: 'active', activated_by: admin.id });
    const audit = await pool.query("SELECT user_id::text, request_source->>'channel' AS channel FROM audit.audit_logs WHERE entity_type = 'maintenance.ml_models' AND entity_id = $1 AND action = 'UPDATE'", [row.id]);
    expect(audit.rows).toEqual([{ user_id: String(admin.id), channel: 'script' }]);
    expect(await mlRegistry.checkServing(job())).toMatchObject({ ok: true });
    expect((await run('list', '--status', 'active'))[1]).toMatch(/\sactive\s/);
  });

  test('refuses anyone but an active administrator, an unknown version, and a model on other inputs', async () => {
    const v = version();
    serving = servedModel(v);
    await mlRegistry.checkServing(job());
    const manager = await createUser({ roles: ['fleet_manager'] });
    const gone = await createUser({ roles: ['admin'], status: 'inactive' });
    await expect(run('activate', v, '--by', String(manager.email))).rejects.toThrow(/may not activate/);
    await expect(run('activate', v, '--by', String(gone.email))).rejects.toThrow(/No active account/);
    await expect(run('activate', 'pm-1999.01', '--by', String(manager.email))).rejects.toThrow(/No registered model/);
    await expect(run('activate', v)).rejects.toThrow(/Usage/);
    await expect(run('list', '--status', 'deleted')).rejects.toThrow(/Usage/);

    const other = version();
    serving = servedModel(other, { feature_spec_hash: OTHER_HASH });
    await mlRegistry.checkServing(job());
    const admin = await createUser({ roles: ['admin'] });
    await expect(run('activate', other, '--by', String(admin.email))).rejects.toThrow(/not the ones the core computes/);
    expect((await registry()).every((r) => r.status === 'registered')).toBe(true);
  });
});

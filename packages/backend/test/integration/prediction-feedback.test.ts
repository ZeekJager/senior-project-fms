import { randomUUID } from 'node:crypto';
import request, { type Response } from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { createDepot, createUser, createVehicle, type RoleName } from '../support/factories';
import { publishedEvents } from '../support/events';

// FMS-128: what a technician found when they inspected a vehicle the model flagged.

const app = createApp();
const PASSWORD = 'Feedback-Test-1';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type Row = Record<string, unknown> & { id: string };
type Model = { name: string; version: string };

async function signIn(roles: RoleName[], depot: Row | null = null): Promise<string> {
  const user = await createUser({ roles, depot, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

const api = {
  get: (path: string, cookie: string) => request(app).get(`/api/v1${path}`).set('Cookie', cookie),
  post: (path: string, body: object, cookie: string) => request(app).post(`/api/v1${path}`).set('Cookie', cookie).send(body),
  patch: (path: string, body: object, cookie: string) => request(app).patch(`/api/v1${path}`).set('Cookie', cookie).send(body),
};

/** A registered model, which every stored prediction must name. */
async function model(): Promise<Model> {
  const version = `fb-test.${randomUUID().slice(0, 8)}`;
  await pool.query(
    `INSERT INTO maintenance.ml_models (name, version, algorithm, features, feature_spec_version, feature_spec_hash, metrics, training_data, trained_at, artefact_sha256)
     VALUES ('predictive-maintenance', $1, 'RandomForestClassifier', '["mileage_km"]', 2, $2, '{}', '{}', now(), $2)`,
    [version, 'a'.repeat(64)],
  );
  return { name: 'predictive-maintenance', version };
}

/** A scored prediction as the nightly scoring writes it. Returns its public id. */
let scoredCount = 0;
async function scored(vehicle: Row, m: Model, score = 30, status = 'active'): Promise<string> {
  const level = score >= 75 ? 'low' : score <= 40 ? 'high' : 'medium';
  // One prediction per vehicle, type, scoring time and model: each gets its own second.
  const at = new Date(Date.now() - ++scoredCount * 1000);
  const row = await pool.query<{ public_id: string }>(
    `INSERT INTO maintenance.maintenance_predictions
       (vehicle_id, model_name, model_version, prediction_type, risk_score, prediction_horizon_days, feature_snapshot, health_score, risk_level, factors, as_of, generated_at, status)
     VALUES ($1, $2, $3, 'failure_within_30_days', $4, 30, '{"mileage_km": 4200}', $5, $6, '["mileage_km"]', $8, $8, $7) RETURNING public_id`,
    [vehicle.id, m.name, m.version, (100 - score) / 100, score, level, status, at],
  );
  return row.rows[0].public_id;
}

const fbPath = (predictionId: string) => `/maintenance-predictions/${predictionId}/feedback`;
const feedbackRows = async () => (await pool.query('SELECT * FROM maintenance.prediction_feedback')).rows;

async function auditRows(res: Response) {
  const rows = await pool.query<{ action: string; entity_type: string }>('SELECT action, entity_type FROM audit.audit_logs WHERE correlation_id = $1 ORDER BY id', [
    res.headers['x-request-id'],
  ]);
  return rows.rows.map((r) => `${r.action} ${r.entity_type}`);
}

/** A failure record on a vehicle (a corrective repair that found a worn brake). Returns its public id. */
async function failureOn(vehicle: Row, cookie: string, extra: Record<string, unknown> = { component: 'brakes', failure_mode: 'wear', unplanned: true }): Promise<string> {
  const repair = await api.post(
    '/maintenance-records',
    { vehicle_id: vehicle.public_id, description: 'Brakes grinding', labour_hours: 1, total_cost_cents: 50_000, odometer_km: 80_000 },
    cookie,
  );
  expect(repair.status).toBe(201);
  const failure = await api.post(`/maintenance-records/${repair.body.data.id}/failures`, extra, cookie);
  expect(failure.status).toBe(201);
  return failure.body.data.id;
}

/** A depot with a flagged vehicle, a model, its high-risk prediction, and a technician. */
async function setup() {
  const depot = await createDepot();
  const vehicle = await createVehicle({ depot });
  const m = await model();
  const prediction = await scored(vehicle, m);
  const tech = await signIn(['technician'], depot);
  return { depot, vehicle, m, prediction, tech };
}

describe('POST /maintenance-predictions/{id}/feedback', () => {
  test('a technician records an outcome on a prediction in their depot: 201, audited, PredictionFeedbackRecorded', async () => {
    const { vehicle, m, prediction, tech } = await setup();
    const res = await api.post(fbPath(prediction), { outcome: 'confirmed_issue', component: 'brakes', comment: '  Pads worn to the metal  ' }, tech);

    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(`/api/v1/maintenance-predictions/${prediction}/feedback`);
    expect(res.body.data).toMatchObject({
      prediction_id: prediction,
      outcome: 'confirmed_issue',
      component: 'brakes',
      failure_event_id: null,
      comment: 'Pads worn to the metal',
      can_edit: true,
    });
    expect(Date.parse(res.body.data.editable_until) - Date.parse(res.body.data.created_at)).toBe(7 * DAY);
    expect(await auditRows(res)).toEqual(['INSERT maintenance.prediction_feedback']);

    const [event] = await publishedEvents('PredictionFeedbackRecorded');
    expect(event.aggregate).toBe(`vehicle:${vehicle.public_id}`);
    expect(event.payload).toEqual({
      feedback_id: res.body.data.id,
      prediction_id: prediction,
      vehicle_id: vehicle.public_id,
      model_name: m.name,
      model_version: m.version,
      risk_level: 'high',
      outcome: 'confirmed_issue',
      component: 'brakes',
      failure_event_id: null,
      edited: false,
    });
  });

  test.each([
    ['no_issue_found', 'Nothing wrong after a full inspection'],
    ['already_fixed', 'Replaced last week'],
    ['not_inspected', null],
  ] as const)('%s is recorded with no component and no failure', async (outcome, comment) => {
    const { prediction, tech } = await setup();
    const res = await api.post(fbPath(prediction), { outcome, ...(comment ? { comment } : {}) }, tech);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ outcome, component: null, failure_event_id: null, comment });
  });

  test('a confirmed issue names the failure record it led to; the component follows it', async () => {
    const { vehicle, prediction, tech } = await setup();
    const failure = await failureOn(vehicle, tech);

    const res = await api.post(fbPath(prediction), { outcome: 'confirmed_issue', failure_event_id: failure }, tech);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ outcome: 'confirmed_issue', failure_event_id: failure, component: 'brakes' });
    const [event] = await publishedEvents('PredictionFeedbackRecorded');
    expect(event.payload).toMatchObject({ failure_event_id: failure, component: 'brakes' });
  });

  test('the failure must be this vehicle’s, in the caller’s depots, and agree with the component', async () => {
    const { depot, vehicle, prediction, tech } = await setup();
    const otherVehicle = await createVehicle({ depot });
    const foreignVehicle = await createVehicle({ depot: await createDepot() });
    const onOther = await failureOn(otherVehicle, tech);
    const foreign = await failureOn(foreignVehicle, await signIn(['admin']));
    const own = await failureOn(vehicle, tech);

    const other = await api.post(fbPath(prediction), { outcome: 'confirmed_issue', failure_event_id: onOther }, tech);
    expect([other.status, other.body.error.details]).toEqual([400, [{ field: 'failure_event_id', reason: 'failure_other_vehicle' }]]);
    const outside = await api.post(fbPath(prediction), { outcome: 'confirmed_issue', failure_event_id: foreign }, tech);
    expect([outside.status, outside.body.error.details]).toEqual([400, [{ field: 'failure_event_id', reason: 'references_missing_record' }]]);
    const unknown = await api.post(fbPath(prediction), { outcome: 'confirmed_issue', failure_event_id: randomUUID() }, tech);
    expect(unknown.body.error.details).toEqual([{ field: 'failure_event_id', reason: 'references_missing_record' }]);
    const mismatch = await api.post(fbPath(prediction), { outcome: 'confirmed_issue', failure_event_id: own, component: 'engine' }, tech);
    expect([mismatch.status, mismatch.body.error.details]).toEqual([400, [{ field: 'component', reason: 'component_mismatch' }]]);
    expect(await feedbackRows()).toEqual([]);
  });

  test('what was found, and the failure it led to, belong to a confirmed issue only', async () => {
    const { vehicle, prediction, tech } = await setup();
    const failure = await failureOn(vehicle, tech);
    for (const outcome of ['no_issue_found', 'already_fixed', 'not_inspected']) {
      const withComponent = await api.post(fbPath(prediction), { outcome, component: 'brakes' }, tech);
      expect([withComponent.status, withComponent.body.error.details]).toEqual([400, [{ field: 'component', reason: 'only_for_confirmed_issue' }]]);
      const withFailure = await api.post(fbPath(prediction), { outcome, failure_event_id: failure }, tech);
      expect([withFailure.status, withFailure.body.error.details]).toEqual([400, [{ field: 'failure_event_id', reason: 'only_for_confirmed_issue' }]]);
    }
    expect(await feedbackRows()).toEqual([]);
  });

  test('a bad body is 400: an unknown outcome, an unknown component, a stray field, a long comment, nothing', async () => {
    const { prediction, tech } = await setup();
    expect((await api.post(fbPath(prediction), { outcome: 'maybe' }, tech)).body.error.code).toBe('VALIDATION_INVALID_ENUM');
    expect((await api.post(fbPath(prediction), { outcome: 'confirmed_issue', component: 'wings' }, tech)).status).toBe(400);
    expect((await api.post(fbPath(prediction), { outcome: 'no_issue_found', user_id: 1 }, tech)).body.error.details).toContainEqual({ field: 'user_id', reason: 'not_writable' });
    expect((await api.post(fbPath(prediction), { outcome: 'no_issue_found', comment: 'x'.repeat(1001) }, tech)).status).toBe(400);
    expect((await api.post(fbPath(prediction), {}, tech)).status).toBe(400);
    expect(await feedbackRows()).toEqual([]);
  });

  test('one feedback per prediction: a second, from the author or another technician, is 409 and names the first', async () => {
    const { depot, prediction, tech } = await setup();
    const first = await api.post(fbPath(prediction), { outcome: 'no_issue_found' }, tech);
    const again = await api.post(fbPath(prediction), { outcome: 'confirmed_issue' }, tech);
    expect([again.status, again.body.error.code, again.body.error.details]).toEqual([409, 'CONFLICT_DUPLICATE', [{ reason: 'already_recorded', record_id: first.body.data.id }]]);
    const colleague = await signIn(['technician'], depot);
    expect((await api.post(fbPath(prediction), { outcome: 'confirmed_issue' }, colleague)).status).toBe(409);
    expect(await feedbackRows()).toHaveLength(1);
  });

  test('a prediction outside the caller’s depots, an unknown one or an unscored one is 404', async () => {
    const { depot, vehicle, m, prediction } = await setup();
    const elsewhere = await signIn(['technician'], await createDepot());
    expect((await api.post(fbPath(prediction), { outcome: 'no_issue_found' }, elsewhere)).status).toBe(404);
    expect((await api.post(fbPath(randomUUID()), { outcome: 'no_issue_found' }, elsewhere)).status).toBe(404);
    expect((await api.post(fbPath('not-a-uuid'), { outcome: 'no_issue_found' }, elsewhere)).status).toBe(404);

    // A row from before the scoring stored a health score is not a prediction anyone reads.
    const old = await pool.query<{ public_id: string }>(
      `INSERT INTO maintenance.maintenance_predictions (vehicle_id, model_name, model_version, prediction_type, risk_score)
       VALUES ($1, $2, $3, 'failure_within_30_days', 0.9) RETURNING public_id`,
      [vehicle.id, m.name, m.version],
    );
    const tech = await signIn(['technician'], depot);
    expect((await api.post(fbPath(old.rows[0].public_id), { outcome: 'no_issue_found' }, tech)).status).toBe(404);
    expect(await feedbackRows()).toEqual([]);
  });

  test('a superseded prediction can still be given feedback: it is what the model said that night', async () => {
    const { vehicle, m, tech } = await setup();
    const older = await scored(vehicle, m, 35, 'superseded');
    expect((await api.post(fbPath(older), { outcome: 'confirmed_issue' }, tech)).status).toBe(201);
  });

  test('prediction:read and maintenance:write are both needed: technicians, depot admins, fleet managers and admins may; owners, auditors, dispatchers and drivers may not', async () => {
    const { depot, vehicle, m } = await setup();
    const allowed: RoleName[] = ['technician', 'depot_admin', 'fleet_manager', 'admin'];
    for (const role of allowed) {
      const cookie = await signIn([role], role === 'admin' || role === 'fleet_manager' ? null : depot);
      const res = await api.post(fbPath(await scored(vehicle, m)), { outcome: 'no_issue_found' }, cookie);
      expect([role, res.status]).toEqual([role, 201]);
    }
    const denied: RoleName[] = ['fleet_owner', 'compliance_officer', 'dispatcher', 'driver', 'finance_clerk'];
    for (const role of denied) {
      const res = await api.post(fbPath(await scored(vehicle, m)), { outcome: 'no_issue_found' }, await signIn([role], depot));
      expect([role, res.status]).toEqual([role, 403]);
    }
    expect((await request(app).post(`/api/v1${fbPath(await scored(vehicle, m))}`).send({ outcome: 'no_issue_found' })).status).toBe(401);
    expect(await feedbackRows()).toHaveLength(allowed.length);
  });
});

describe('PATCH /maintenance-predictions/{id}/feedback', () => {
  test('the author changes it: the outcome, the comment; a change from a confirmed issue drops what was found', async () => {
    const { vehicle, prediction, tech } = await setup();
    const failure = await failureOn(vehicle, tech);
    const first = await api.post(fbPath(prediction), { outcome: 'confirmed_issue', failure_event_id: failure, comment: 'Pads' }, tech);

    const res = await api.patch(fbPath(prediction), { outcome: 'no_issue_found', comment: null }, tech);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: first.body.data.id, outcome: 'no_issue_found', component: null, failure_event_id: null, comment: null });
    expect(await auditRows(res)).toEqual(['UPDATE maintenance.prediction_feedback']);
    const events = await publishedEvents('PredictionFeedbackRecorded');
    expect(events).toHaveLength(2);
    expect(events[1].payload).toMatchObject({ feedback_id: first.body.data.id, outcome: 'no_issue_found', failure_event_id: null, edited: true });

    // Back to a confirmed issue, naming the component only.
    const again = await api.patch(fbPath(prediction), { outcome: 'confirmed_issue', component: 'engine' }, tech);
    expect(again.body.data).toMatchObject({ outcome: 'confirmed_issue', component: 'engine' });
  });

  test('a change that changes nothing writes and publishes nothing', async () => {
    const { prediction, tech } = await setup();
    await api.post(fbPath(prediction), { outcome: 'confirmed_issue', component: 'brakes', comment: 'Pads' }, tech);
    const res = await api.patch(fbPath(prediction), { outcome: 'confirmed_issue', component: 'brakes', comment: 'Pads' }, tech);
    expect(res.status).toBe(200);
    expect(await auditRows(res)).toEqual([]);
    expect(await publishedEvents('PredictionFeedbackRecorded')).toHaveLength(1);
  });

  test('only the author, and only for 7 days: another technician is 403, day 8 is 409', async () => {
    const { depot, prediction, tech } = await setup();
    const first = await api.post(fbPath(prediction), { outcome: 'no_issue_found' }, tech);
    const colleague = await signIn(['technician'], depot);
    const notAuthor = await api.patch(fbPath(prediction), { outcome: 'confirmed_issue' }, colleague);
    expect([notAuthor.status, notAuthor.body.error.details]).toEqual([403, [{ reason: 'not_author' }]]);

    await pool.query("UPDATE maintenance.prediction_feedback SET created_at = now() - interval '6 days 23 hours' WHERE public_id = $1", [first.body.data.id]);
    expect((await api.patch(fbPath(prediction), { comment: 'Still within the week' }, tech)).status).toBe(200);

    await pool.query("UPDATE maintenance.prediction_feedback SET created_at = now() - interval '7 days 1 hour' WHERE public_id = $1", [first.body.data.id]);
    const late = await api.patch(fbPath(prediction), { comment: 'Too late' }, tech);
    expect([late.status, late.body.error.code, late.body.error.details]).toEqual([409, 'CONFLICT_INVALID_STATE_TRANSITION', [{ reason: 'edit_window_closed' }]]);
    expect((await feedbackRows())[0].comment).toBe('Still within the week');
  });

  test('no feedback yet is 404; an empty body, a component on a non-issue, or another depot’s prediction is refused', async () => {
    const { prediction, tech } = await setup();
    expect((await api.patch(fbPath(prediction), { comment: 'x' }, tech)).status).toBe(404);
    await api.post(fbPath(prediction), { outcome: 'no_issue_found' }, tech);
    expect((await api.patch(fbPath(prediction), {}, tech)).body.error.details).toEqual([expect.objectContaining({ reason: 'empty_update' })]);
    const found = await api.patch(fbPath(prediction), { component: 'brakes' }, tech);
    expect([found.status, found.body.error.details]).toEqual([400, [{ field: 'component', reason: 'only_for_confirmed_issue' }]]);
    const elsewhere = await signIn(['technician'], await createDepot());
    expect((await api.patch(fbPath(prediction), { comment: 'x' }, elsewhere)).status).toBe(404);
  });
});

describe('the feedback in GET /vehicles/{id}/maintenance-risk', () => {
  test('the latest prediction carries its feedback, and can_edit is the author’s only', async () => {
    const { depot, vehicle, prediction, tech } = await setup();
    const before = await api.get(`/vehicles/${vehicle.public_id}/maintenance-risk`, tech);
    expect(before.body.data).toMatchObject({ prediction_id: prediction, feedback: null });

    await api.post(fbPath(prediction), { outcome: 'confirmed_issue', component: 'brakes' }, tech);
    const mine = await api.get(`/vehicles/${vehicle.public_id}/maintenance-risk`, tech);
    expect(mine.body.data.feedback).toMatchObject({ prediction_id: prediction, outcome: 'confirmed_issue', component: 'brakes', can_edit: true });

    const colleague = await signIn(['technician'], depot);
    expect((await api.get(`/vehicles/${vehicle.public_id}/maintenance-risk`, colleague)).body.data.feedback).toMatchObject({ outcome: 'confirmed_issue', can_edit: false });

    // A newer prediction has none of its own: last night's feedback was about last night's score.
    await pool.query("UPDATE maintenance.maintenance_predictions SET status = 'superseded' WHERE public_id = $1", [prediction]);
    await scored(vehicle, await model(), 28);
    expect((await api.get(`/vehicles/${vehicle.public_id}/maintenance-risk`, tech)).body.data.feedback).toBeNull();
  });
});

describe('the confirmed share of high-risk predictions, per model version (GET /ml-models)', () => {
  /** A high-risk prediction on a fresh vehicle with feedback `outcome` (or none) given `monthsAgo` months ago. */
  async function judged(m: Model, outcome: string | null, opts: { monthsAgo?: number; score?: number } = {}) {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const id = await scored(vehicle, m, opts.score ?? 30);
    if (outcome) {
      const author = await createUser({ roles: ['technician'], depot });
      await pool.query(
        `INSERT INTO maintenance.prediction_feedback (prediction_id, user_id, outcome, created_at)
         SELECT p.id, $2, $3::maintenance.prediction_outcome, now() - make_interval(months => $4) FROM maintenance.maintenance_predictions p WHERE p.public_id = $1`,
        [id, author.id, outcome, opts.monthsAgo ?? 0],
      );
    }
    return id;
  }

  const statsOf = async (m: Model, cookie: string) => {
    const list = await api.get('/ml-models?page_size=100', cookie);
    return (list.body.data as { version: string; feedback: Record<string, unknown> }[]).find((x) => x.version === m.version)!.feedback;
  };

  test('counts the feedback on a version’s high-risk predictions; precision is confirmed over judged, not_inspected judges nothing', async () => {
    const m = await model();
    for (const outcome of ['confirmed_issue', 'confirmed_issue', 'no_issue_found', 'already_fixed', 'not_inspected', null]) await judged(m, outcome);
    await judged(m, 'confirmed_issue', { score: 60 }); // a medium prediction: not part of the figure
    const other = await model();
    await judged(other, 'no_issue_found');
    const reader = await signIn(['fleet_owner']);

    const stats = await statsOf(m, reader);
    expect(stats).toMatchObject({
      high_risk_predictions: 6,
      with_feedback: 5,
      confirmed_issue: 2,
      no_issue_found: 1,
      already_fixed: 1,
      not_inspected: 1,
      reviewed: 4,
      precision: 0.5,
    });
    // Each version is its own: the other model's figure does not include these.
    expect(await statsOf(other, reader)).toMatchObject({ high_risk_predictions: 1, reviewed: 1, confirmed_issue: 0, precision: 0 });
    // One model, one request.
    const one = await api.get(`/ml-models/${(await pool.query<{ public_id: string }>('SELECT public_id FROM maintenance.ml_models WHERE version = $1', [m.version])).rows[0].public_id}`, reader);
    expect(one.body.data.feedback.precision).toBe(0.5);
  });

  test('a version nobody has judged has zeros and no precision; three decimals otherwise', async () => {
    const quiet = await model();
    const reader = await signIn(['fleet_owner']);
    expect(await statsOf(quiet, reader)).toEqual({
      high_risk_predictions: 0,
      with_feedback: 0,
      confirmed_issue: 0,
      no_issue_found: 0,
      already_fixed: 0,
      not_inspected: 0,
      reviewed: 0,
      precision: null,
      by_month: [],
    });
    const m = await model();
    for (const outcome of ['confirmed_issue', 'no_issue_found', 'no_issue_found']) await judged(m, outcome);
    expect((await statsOf(m, reader)).precision).toBe(0.333);
  });

  test('by month: the months feedback was given in, newest first, the last 12 only; older feedback still counts in the totals', async () => {
    const m = await model();
    await judged(m, 'confirmed_issue');
    await judged(m, 'confirmed_issue');
    await judged(m, 'no_issue_found');
    await judged(m, 'no_issue_found', { monthsAgo: 2 });
    await judged(m, 'confirmed_issue', { monthsAgo: 2 });
    await judged(m, 'not_inspected'); // judges nothing: not in a month's figure
    await judged(m, 'confirmed_issue', { monthsAgo: 13 });
    const stats = (await statsOf(m, await signIn(['fleet_owner']))) as { reviewed: number; confirmed_issue: number; by_month: { month: string; reviewed: number; confirmed_issue: number; precision: number }[] };

    expect(stats.by_month).toHaveLength(2);
    expect(stats.by_month[0]).toMatchObject({ reviewed: 3, confirmed_issue: 2, precision: 0.667 });
    expect(stats.by_month[1]).toMatchObject({ reviewed: 2, confirmed_issue: 1, precision: 0.5 });
    expect(stats.by_month[0].month > stats.by_month[1].month).toBe(true);
    expect(stats.by_month[0].month).toMatch(/^\d{4}-\d{2}$/);
    expect([stats.reviewed, stats.confirmed_issue]).toEqual([6, 4]);
  });
});

import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { fleetModule } from '../../src/modules/fleet';
import { addisDate } from '../support/dates';
import { deliverEvents, publishedEvents } from '../support/events';
import { createDepot, createUser, createVehicle, type RoleName } from '../support/factories';
import { responseProblems, type Method } from '../support/openapi';

// Warranty and recall tracking (FMS-133): a recall lists every vehicle of its make, model and years as open;
// a repair on a component under warranty, on its work day and within its end odometer, is claimable; a
// warranty ending within 30 days is warned of by the expiry job (FMS-26). Every answer is checked against
// docs/openapi.yaml.

const app = createApp();
const PASSWORD = 'Warranty-Test-1';

type Row = Awaited<ReturnType<typeof createVehicle>>;
type Depot = Awaited<ReturnType<typeof createDepot>>;

async function signIn(roles: RoleName[], depot: Depot | null = null): Promise<string> {
  const user = await createUser({ roles, depot, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

/** Calls the API and checks the answer against the spec's operation (`spec`: its path, e.g. `/warranties/{warranty_id}`). */
async function call(method: Method, spec: string, path: string, cookie: string, body?: object) {
  const req = request(app)[method](`/api/v1${path}`).set('Cookie', cookie);
  const res = method === 'get' ? await req : await req.send(body ?? {});
  expect(responseProblems(spec, method, res.status, res.body), `${method} ${path} ${res.status} ${JSON.stringify(res.body)}`).toBeNull();
  return res;
}

const job = (name: string) => fleetModule.jobs!.find((j) => j.name === name)!;
const runExpiry = () => job('warranty-expiry-check').run({ now: new Date(), correlationId: randomUUID(), runKey: randomUUID() });

/** A make no other test uses, so a recall here matches only this test's vehicles. */
const freshMake = () => `Make-${randomUUID().slice(0, 8)}`;

async function warranty(cookie: string, body: object): Promise<Record<string, unknown> & { id: string }> {
  const res = await call('post', '/warranties', '/warranties', cookie, body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data;
}

/** A corrective repair with what failed, completed `completedDaysAgo` days ago (null: left open). */
async function repair(
  cookie: string,
  vehicle: Row,
  components: string[],
  options: { odometerKm?: number | null; completedDaysAgo?: number | null } = {},
): Promise<Record<string, unknown> & { id: string; warranty_claim: Record<string, unknown> | null }> {
  const created = await call('post', '/maintenance-records', '/maintenance-records', cookie, {
    vehicle_id: vehicle.public_id,
    description: `Repair: ${components.join(', ') || 'service'}`,
    labour_hours: 2,
    total_cost_cents: 450_000,
    maintenance_type: 'corrective',
    ...(options.odometerKm !== undefined ? { odometer_km: options.odometerKm } : {}),
    failures: components.map((component) => ({ component, failure_mode: 'wear', unplanned: true })),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const days = options.completedDaysAgo === undefined ? 0 : options.completedDaysAgo;
  if (days === null) return created.body.data;
  const completed = await call('post', '/maintenance-records/{record_id}/complete', `/maintenance-records/${created.body.data.id}/complete`, cookie, {
    completed_at: new Date(Date.now() - days * 86_400_000).toISOString(),
  });
  expect(completed.status, JSON.stringify(completed.body)).toBe(200);
  return completed.body.data;
}

const recordOf = async (cookie: string, id: string) => (await call('get', '/maintenance-records/{record_id}', `/maintenance-records/${id}`, cookie)).body.data;

describe('recalls: matching by make, model and year', () => {
  test('a recall for a make, model and year range lists every matching vehicle as open', async () => {
    const north = await createDepot();
    const south = await createDepot();
    const manager = await signIn(['fleet_manager']);
    const make = freshMake();
    const inRange = [
      await createVehicle({ depot: north, make, model: 'FSR', model_year: 2018 }),
      await createVehicle({ depot: north, make: make.toUpperCase(), model: 'fsr ', model_year: 2020 }),
      await createVehicle({ depot: south, make, model: 'FSR', model_year: 2022 }),
    ];
    // Out: a year outside the range, another model, no year on record, retired.
    await createVehicle({ depot: north, make, model: 'FSR', model_year: 2017 });
    await createVehicle({ depot: north, make, model: 'NQR', model_year: 2020 });
    await createVehicle({ depot: north, make, model: 'FSR', model_year: null });
    await createVehicle({ depot: north, make, model: 'FSR', model_year: 2020, status: 'retired', is_active: false });

    const code = `RC-${randomUUID().slice(0, 6)}`;
    const created = await call('post', '/recalls', '/recalls', manager, {
      campaign_code: code,
      make,
      model: 'FSR',
      year_from: 2018,
      year_to: 2022,
      description: 'Brake hose may chafe against the frame.',
      remedy: 'Replace the front brake hoses and add a clip.',
      issued_on: addisDate(-3),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const recall = created.body.data;
    expect(recall).toMatchObject({ campaign_code: code, vehicles: { total: 3, open: 3, scheduled: 0, completed: 0 } });

    const listed = await call('get', '/recalls/{recall_id}/vehicles', `/recalls/${recall.id}/vehicles`, manager);
    expect(listed.body.data.map((v: { vehicle_id: string }) => v.vehicle_id).sort()).toEqual(inRange.map((v) => v.public_id).sort());
    expect(listed.body.data.every((v: { status: string }) => v.status === 'open')).toBe(true);

    // One RecallIssued, one VehicleRecallOpened per vehicle (an alert each, for its depot).
    expect((await publishedEvents('RecallIssued')).map((e) => e.payload)).toEqual([expect.objectContaining({ recall_id: recall.id, vehicles: 3 })]);
    const opened = await publishedEvents('VehicleRecallOpened');
    expect(opened.map((e) => e.payload.vehicle_id).sort()).toEqual(inRange.map((v) => v.public_id).sort());
    await deliverEvents();
    const alerts = await pool.query("SELECT vehicle_id, severity FROM alert.alerts WHERE alert_type = 'vehicle_recall'");
    expect(alerts.rows.map((a) => String(a.vehicle_id)).sort()).toEqual(inRange.map((v) => String(v.id)).sort());

    // A depot's technician sees their depot's vehicles under it, and the counts of their depot.
    const tech = await signIn(['technician'], south);
    const theirs = await call('get', '/recalls/{recall_id}/vehicles', `/recalls/${recall.id}/vehicles`, tech);
    expect(theirs.body.data.map((v: { vehicle_id: string }) => v.vehicle_id)).toEqual([inRange[2].public_id]);
    expect((await call('get', '/recalls/{recall_id}', `/recalls/${recall.id}`, tech)).body.data.vehicles).toMatchObject({ total: 1, open: 1 });

    // A vehicle registered later that matches falls under it; so does one whose year is corrected into the range.
    const late = await call('post', '/vehicles', '/vehicles', manager, {
      registration_number: `AA-${randomUUID().slice(0, 6)}`,
      depot_id: north.public_id,
      vehicle_type: 'truck',
      fuel_type: 'diesel',
      make,
      model: 'FSR',
      year: 2019,
      fuel_efficiency_ml_per_km: 300,
    });
    expect(late.status, JSON.stringify(late.body)).toBe(201);
    await deliverEvents();
    const after = await call('get', '/recalls/{recall_id}', `/recalls/${recall.id}`, manager);
    expect(after.body.data.vehicles).toMatchObject({ total: 4, open: 4 });
    const recalls = await call('get', '/vehicles/{vehicle_id}/recalls', `/vehicles/${late.body.data.id}/recalls`, manager);
    expect(recalls.body.data).toMatchObject([{ recall_id: recall.id, campaign_code: code, status: 'open', maintenance_record_id: null }]);

    // Narrowing the years drops the open ones no longer in it.
    const narrowed = await call('patch', '/recalls/{recall_id}', `/recalls/${recall.id}`, manager, { year_from: 2020 });
    expect(narrowed.status, JSON.stringify(narrowed.body)).toBe(200);
    expect(narrowed.body.data.vehicles).toMatchObject({ total: 2, open: 2 });
  });

  test('a recall is the whole fleet’s: a depot user cannot issue one; a campaign code once; years in order', async () => {
    const depot = await createDepot();
    const body = { campaign_code: `RC-${randomUUID().slice(0, 6)}`, make: freshMake(), model: 'FSR', year_from: 2020, year_to: 2021, description: 'Seat belt anchor.' };
    const depotAdmin = await signIn(['depot_admin'], depot);
    const refused = await call('post', '/recalls', '/recalls', depotAdmin, body);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('FORBIDDEN_INSUFFICIENT_ROLE');

    const manager = await signIn(['fleet_manager']);
    expect((await call('post', '/recalls', '/recalls', manager, body)).status).toBe(201);
    const again = await call('post', '/recalls', '/recalls', manager, { ...body, campaign_code: body.campaign_code.toLowerCase() });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('CONFLICT_DUPLICATE');
    const reversed = await call('post', '/recalls', '/recalls', manager, { ...body, campaign_code: `RC-${randomUUID().slice(0, 6)}`, year_from: 2022 });
    expect(reversed.status).toBe(400);
    expect(reversed.body.error.code).toBe('VALIDATION_INVALID_DATE_RANGE');
  });
});

describe('recall work through a work order', () => {
  test('linking a work order schedules it, completing the work completes it; cancelling puts it back to open', async () => {
    const depot = await createDepot();
    const manager = await signIn(['fleet_manager']);
    const tech = await signIn(['technician'], depot);
    const make = freshMake();
    const truck = await createVehicle({ depot, make, model: 'FSR', model_year: 2021 });
    const other = await createVehicle({ depot, make, model: 'FSR', model_year: 2021 });
    const recall = (
      await call('post', '/recalls', '/recalls', manager, {
        campaign_code: `RC-${randomUUID().slice(0, 6)}`,
        make,
        model: 'FSR',
        year_from: 2021,
        year_to: 2021,
        description: 'Fuel line clamp.',
      })
    ).body.data;
    const path = (v: Row) => `/recalls/${recall.id}/vehicles/${v.public_id}`;
    const spec = '/recalls/{recall_id}/vehicles/{vehicle_id}';

    // Scheduling needs the work order; another vehicle's is refused.
    expect((await call('patch', spec, path(truck), tech, { status: 'scheduled' })).status).toBe(400);
    const work = await repair(tech, truck, ['fuel_system'], { completedDaysAgo: null });
    const otherWork = await repair(tech, other, ['fuel_system'], { completedDaysAgo: null });
    expect((await call('patch', spec, path(truck), tech, { maintenance_record_id: otherWork.id })).status).toBe(400);

    const linked = await call('patch', spec, path(truck), tech, { maintenance_record_id: work.id, notes: 'Clamp kit ordered.' });
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);
    expect(linked.body.data).toMatchObject({ status: 'scheduled', maintenance_record_id: work.id, notes: 'Clamp kit ordered.', completed_at: null });

    const done = await call('post', '/maintenance-records/{record_id}/complete', `/maintenance-records/${work.id}/complete`, tech, {});
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const [row] = (await call('get', '/vehicles/{vehicle_id}/recalls', `/vehicles/${truck.public_id}/recalls`, tech)).body.data;
    expect(row).toMatchObject({ status: 'completed', maintenance_record_id: work.id, completed_at: done.body.data.completed_at });
    expect((await publishedEvents('VehicleRecallCompleted')).map((e) => e.payload)).toEqual([
      expect.objectContaining({ recall_id: recall.id, vehicle_id: truck.public_id, maintenance_record_id: work.id }),
    ]);
    // Completed is final.
    const reopen = await call('patch', spec, path(truck), tech, { status: 'open' });
    expect(reopen.status).toBe(409);
    expect(reopen.body.error.code).toBe('CONFLICT_INVALID_STATE_TRANSITION');

    // A cancelled work order puts its recall work back to open.
    await call('patch', spec, path(other), tech, { maintenance_record_id: otherWork.id });
    const cancelled = await call('patch', '/maintenance-records/{record_id}', `/maintenance-records/${otherWork.id}`, tech, { status: 'cancelled' });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    const [back] = (await call('get', '/vehicles/{vehicle_id}/recalls', `/vehicles/${other.public_id}/recalls`, tech)).body.data;
    expect(back).toMatchObject({ status: 'open', maintenance_record_id: null });

    // Done elsewhere (at the dealer): completed by hand.
    const byHand = await call('patch', spec, path(other), tech, { status: 'completed', notes: 'Done by the dealer.' });
    expect(byHand.body.data).toMatchObject({ status: 'completed', maintenance_record_id: null, notes: 'Done by the dealer.' });
  });
});

describe('claimable repairs', () => {
  test('a repair on a component under warranty is marked claimable; another component, or the whole vehicle', async () => {
    const depot = await createDepot();
    const tech = await signIn(['technician'], depot);
    const truck = await createVehicle({ depot });
    const brakes = await warranty(tech, {
      vehicle_id: truck.public_id,
      component: 'brakes',
      provider: 'Brake Co.',
      coverage: 'Pads, discs and callipers',
      starts_on: addisDate(-100),
      ends_on: addisDate(200),
    });
    expect(brakes).toMatchObject({ component: 'brakes', status: 'active', days_left: 200, claims: { claimable: 0 } });

    const onBrakes = await repair(tech, truck, ['brakes']);
    expect(onBrakes.warranty_claim).toMatchObject({ warranty_id: brakes.id, provider: 'Brake Co.', component: 'brakes', status: 'claimable', amount_cents: null, km_checked: true });
    const onEngine = await repair(tech, truck, ['engine']);
    expect(onEngine.warranty_claim).toBeNull();

    // A warranty on the whole vehicle covers any failure, and from when it is entered: the engine repair becomes claimable.
    const whole = await warranty(tech, { vehicle_id: truck.public_id, provider: 'Dealer', starts_on: addisDate(-100), ends_on: addisDate(600) });
    expect((await recordOf(tech, onEngine.id)).warranty_claim).toMatchObject({ warranty_id: whole.id, component: null, status: 'claimable' });
    // The brake repair stays under the brake warranty: the narrower cover first.
    expect((await recordOf(tech, onBrakes.id)).warranty_claim).toMatchObject({ warranty_id: brakes.id });

    // Nothing failed (a service): nothing to claim.
    const service = await call('post', '/maintenance-records', '/maintenance-records', tech, {
      vehicle_id: truck.public_id,
      description: 'Oil change',
      labour_hours: 1,
      total_cost_cents: 100_000,
      maintenance_type: 'preventive',
    });
    expect(service.body.data.warranty_claim).toBeNull();

    // The warranty's claims are counted on it.
    const read = await call('get', '/warranties/{warranty_id}', `/warranties/${brakes.id}`, tech);
    expect(read.body.data.claims).toMatchObject({ claimable: 1, submitted: 0, approved: 0, rejected: 0, recovered_cents: 0 });
  });

  test('claimable detection by date and km', async () => {
    const depot = await createDepot();
    const tech = await signIn(['technician'], depot);
    const truck = await createVehicle({ depot, odometer_km: 98_000 });
    const w = await warranty(tech, {
      vehicle_id: truck.public_id,
      component: 'transmission',
      provider: 'Gearbox Ltd',
      starts_on: addisDate(-365),
      ends_on: addisDate(-10),
      ends_km: 100_000,
    });
    // Ended 10 days ago: a repair done today is not covered; one done 20 days ago was.
    expect(w).toMatchObject({ status: 'expired', days_left: -10 });
    expect((await repair(tech, truck, ['transmission'], { odometerKm: 97_000 })).warranty_claim).toBeNull();
    expect((await repair(tech, truck, ['transmission'], { odometerKm: 97_000, completedDaysAgo: 20 })).warranty_claim).toMatchObject({ status: 'claimable' });
    // Past its end odometer: not covered, even in time. No odometer on the repair: covered, but the distance not checked.
    expect((await repair(tech, truck, ['transmission'], { odometerKm: 100_500, completedDaysAgo: 20 })).warranty_claim).toBeNull();
    expect((await repair(tech, truck, ['transmission'], { odometerKm: null, completedDaysAgo: 20 })).warranty_claim).toMatchObject({ status: 'claimable', km_checked: false });
    // Before it started: not covered.
    const later = await warranty(tech, { vehicle_id: truck.public_id, component: 'cooling', provider: 'Radiators', starts_on: addisDate(5), ends_km: 200_000 });
    expect(later).toMatchObject({ status: 'not_started', ends_on: null, km_left: 102_000 });
    expect((await repair(tech, truck, ['cooling'])).warranty_claim).toBeNull();

    // Correcting a repair's odometer judges it again.
    const open = await repair(tech, truck, ['transmission'], { odometerKm: 101_000, completedDaysAgo: null });
    expect(open.warranty_claim).toBeNull();
    const fixed = await call('patch', '/maintenance-records/{record_id}', `/maintenance-records/${open.id}`, tech, { odometer_km: 99_000 });
    expect(fixed.body.data.warranty_claim).toBeNull(); // still open, so judged on today, after the end date
    const completedEarlier = await call('post', '/maintenance-records/{record_id}/complete', `/maintenance-records/${open.id}/complete`, tech, {
      completed_at: new Date(Date.now() - 15 * 86_400_000).toISOString(),
    });
    expect(completedEarlier.body.data.warranty_claim).toMatchObject({ warranty_id: w.id, status: 'claimable' });
  });

  test('a claim goes submitted, then approved with the amount or rejected; voiding the warranty clears only unsent ones', async () => {
    const depot = await createDepot();
    const tech = await signIn(['technician'], depot);
    const truck = await createVehicle({ depot });
    const w = await warranty(tech, { vehicle_id: truck.public_id, provider: 'Dealer', starts_on: addisDate(-30), ends_on: addisDate(300) });
    const first = await repair(tech, truck, ['electrical']);
    const second = await repair(tech, truck, ['body']);
    const unsent = await repair(tech, truck, ['steering']);
    const spec = '/maintenance-records/{record_id}/warranty-claim';
    const claim = (r: { id: string }, body: object) => call('patch', spec, `/maintenance-records/${r.id}/warranty-claim`, tech, body);

    // Approved straight from claimable is not a step; approved needs the amount; only approved has one.
    expect((await claim(first, { status: 'approved', amount_cents: 1000 })).status).toBe(409);
    const submitted = await claim(first, { status: 'submitted', reference: 'CLM-0042' });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    expect(submitted.body.data).toMatchObject({ status: 'submitted', reference: 'CLM-0042', amount_cents: null });
    expect((await claim(first, { status: 'approved' })).status).toBe(400);
    expect((await claim(first, { status: 'rejected', amount_cents: 5 })).status).toBe(400);
    const approved = await claim(first, { status: 'approved', amount_cents: 380_000 });
    expect(approved.body.data).toMatchObject({ status: 'approved', amount_cents: 380_000, reference: 'CLM-0042' });
    const final = await claim(first, { status: 'submitted' });
    expect(final.status).toBe(409);
    expect(final.body.error.details[0]).toMatchObject({ reason: 'invalid_transition', allowed_transitions: [] });

    await claim(second, { status: 'submitted' });
    expect((await claim(second, { status: 'rejected' })).body.data.status).toBe('rejected');
    expect((await claim(second, { status: 'submitted' })).body.data.status).toBe('submitted');

    const counted = await call('get', '/warranties/{warranty_id}', `/warranties/${w.id}`, tech);
    expect(counted.body.data.claims).toEqual({ claimable: 1, submitted: 1, approved: 1, rejected: 0, recovered_cents: 380_000 });

    // Voided (entered by mistake): the claim not yet sent goes; the sent ones are the clerk's and stay.
    const voided = await call('patch', '/warranties/{warranty_id}', `/warranties/${w.id}`, tech, { is_active: false });
    expect(voided.body.data).toMatchObject({ is_active: false, status: 'void' });
    expect((await recordOf(tech, unsent.id)).warranty_claim).toBeNull();
    expect((await recordOf(tech, first.id)).warranty_claim).toMatchObject({ status: 'approved' });
    expect((await recordOf(tech, second.id)).warranty_claim).toMatchObject({ status: 'submitted' });

    // A repair no warranty covers has nothing to claim.
    const none = await claim(unsent, { status: 'submitted' });
    expect(none.status).toBe(409);
    expect(none.body.error.details[0].reason).toBe('not_claimable');
    // Writes are audited.
    const audit = await pool.query("SELECT count(*)::int AS n FROM audit.audit_logs WHERE entity_type = 'maintenance.warranties' AND entity_id = (SELECT id FROM maintenance.warranties WHERE public_id = $1)", [w.id]);
    expect(audit.rows[0].n).toBe(2);
  });
});

describe('warranty expiry warnings', () => {
  test('a warranty ending within 30 days raises an expiry warning, once per level', async () => {
    const depot = await createDepot();
    const tech = await signIn(['technician'], depot);
    const truck = await createVehicle({ depot });
    const retired = await createVehicle({ depot, status: 'retired', is_active: false });
    const soon = await warranty(tech, { vehicle_id: truck.public_id, component: 'tyres', provider: 'Tyre Co.', starts_on: addisDate(-300), ends_on: addisDate(20) });
    const urgent = await warranty(tech, { vehicle_id: truck.public_id, provider: 'Dealer', starts_on: addisDate(-300), ends_on: addisDate(5) });
    expect(soon).toMatchObject({ status: 'expiring', days_left: 20 });
    // Not warned of: ending later, ending by distance only, void, of a retired vehicle.
    await warranty(tech, { vehicle_id: truck.public_id, provider: 'Later', starts_on: addisDate(-10), ends_on: addisDate(45) });
    await warranty(tech, { vehicle_id: truck.public_id, provider: 'By km', starts_on: addisDate(-10), ends_km: 50_000 });
    const voided = await warranty(tech, { vehicle_id: truck.public_id, provider: 'Void', starts_on: addisDate(-10), ends_on: addisDate(10) });
    await call('patch', '/warranties/{warranty_id}', `/warranties/${voided.id}`, tech, { is_active: false });
    await pool.query("INSERT INTO maintenance.warranties (vehicle_id, provider, starts_on, ends_on) VALUES ($1, 'Retired', $2, $3)", [retired.id, addisDate(-10), addisDate(10)]);

    expect(await runExpiry()).toEqual({ checked: 2, raised: 2 });
    const raised = (await publishedEvents('WarrantyExpiring')).map((e) => e.payload);
    expect(raised).toEqual([
      { warranty_id: urgent.id, vehicle_id: truck.public_id, provider: 'Dealer', component: null, ends_on: addisDate(5), days_left: 5, level: 'red' },
      { warranty_id: soon.id, vehicle_id: truck.public_id, provider: 'Tyre Co.', component: 'tyres', ends_on: addisDate(20), days_left: 20, level: 'amber' },
    ]);
    // Again: nothing new.
    expect(await runExpiry()).toEqual({ checked: 2, raised: 0 });

    // The alert engine turns them into alerts for the vehicle's depot.
    await deliverEvents();
    const alerts = await pool.query("SELECT severity, depot_id, title FROM alert.alerts WHERE alert_type = 'warranty_expiring' ORDER BY id");
    expect(alerts.rows).toEqual([
      { severity: 'high', depot_id: depot.id, title: `Warranty ends in 5 days: ${truck.registration_number}` },
      { severity: 'medium', depot_id: depot.id, title: `Warranty ends in 20 days: ${truck.registration_number}` },
    ]);
  });
});

describe('warranties: rules, permissions and scope', () => {
  test('an end is needed and comes after the start; another depot’s warranty is not found; reading needs maintenance:read', async () => {
    const depot = await createDepot();
    const elsewhere = await createDepot();
    const tech = await signIn(['technician'], depot);
    const truck = await createVehicle({ depot });
    const theirs = await createVehicle({ depot: elsewhere });

    const noEnd = await call('post', '/warranties', '/warranties', tech, { vehicle_id: truck.public_id, provider: 'Dealer', starts_on: addisDate() });
    expect(noEnd.status).toBe(400);
    expect(noEnd.body.error.details[0].reason).toBe('end_required');
    const backwards = await call('post', '/warranties', '/warranties', tech, { vehicle_id: truck.public_id, provider: 'Dealer', starts_on: addisDate(), ends_on: addisDate(-1) });
    expect(backwards.status).toBe(400);
    expect(backwards.body.error.code).toBe('VALIDATION_INVALID_DATE_RANGE');
    expect((await call('post', '/warranties', '/warranties', tech, { vehicle_id: theirs.public_id, provider: 'Dealer', starts_on: addisDate(), ends_on: addisDate(9) })).status).toBe(400);

    const manager = await signIn(['fleet_manager']);
    const other = await warranty(manager, { vehicle_id: theirs.public_id, provider: 'Dealer', starts_on: addisDate(), ends_on: addisDate(9) });
    expect((await call('get', '/warranties/{warranty_id}', `/warranties/${other.id}`, tech)).status).toBe(404);
    expect((await call('patch', '/warranties/{warranty_id}', `/warranties/${other.id}`, tech, { provider: 'Mine now' })).status).toBe(404);
    expect((await call('get', '/warranties', `/warranties?vehicle_id=${theirs.public_id}`, tech)).body.data).toEqual([]);
    expect((await call('get', '/vehicles/{vehicle_id}/recalls', `/vehicles/${theirs.public_id}/recalls`, tech)).status).toBe(404);

    // The list: their depot's only; void ones on request.
    const mine = await warranty(tech, { vehicle_id: truck.public_id, provider: 'Dealer', starts_on: addisDate(), ends_on: addisDate(9) });
    expect((await call('get', '/warranties', '/warranties', tech)).body.data.map((w: { id: string }) => w.id)).toEqual([mine.id]);
    const stale = await request(app).patch(`/api/v1/warranties/${mine.id}`).set('Cookie', tech).set('If-Match', '"99"').send({ provider: 'X' });
    expect(stale.status).toBe(409);

    const clerk = await signIn(['finance_clerk'], depot);
    expect((await call('get', '/warranties', '/warranties', clerk)).status).toBe(403);
    expect((await call('get', '/recalls', '/recalls', clerk)).status).toBe(403);
  });
});

import { randomUUID } from 'node:crypto';
import request, { type Response } from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { createDepot, createUser, createVehicle, type RoleName } from '../support/factories';
import { responseProblems, spec, type Method } from '../support/openapi';

// FMS-130 (docs/work-orders.md): a repair record as a work order: requests and approval, tasks, labour per technician,
// outside vendors, itemised totals, rates for finance roles only, and the weekly workload report.

const app = createApp();
const PASSWORD = 'Work-Orders-Test-1';

type Depot = Awaited<ReturnType<typeof createDepot>>;
type User = Awaited<ReturnType<typeof createUser>>;

async function signIn(roles: RoleName[], depot: Depot | null = null): Promise<{ cookie: string; user: User }> {
  const user = await createUser({ roles, depot, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return { cookie: (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; '), user };
}

/** The spec's path for a URL: an exact one first, then the template it fills in. */
function specPath(url: string): string {
  const path = url.split('?')[0];
  if (spec.paths[path]) return path;
  return Object.keys(spec.paths).find((p) => new RegExp(`^${p.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(path)) ?? path;
}

/** Each response is checked against docs/openapi.yaml as well. */
async function call(method: Method, path: string, cookie: string, body?: object, headers: Record<string, string> = {}): Promise<Response> {
  let req = request(app)[method](`/api/v1${path}`).set('Cookie', cookie);
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  const res = body === undefined ? await req : await req.send(body);
  const problem = responseProblems(specPath(path), method, res.status, res.body);
  expect(problem, `${method.toUpperCase()} ${path} ${res.status}`).toBeNull();
  return res;
}

const flagOf = async (vehicle: { id: unknown }) =>
  (await pool.query<{ maintenance_flag: boolean }>('SELECT maintenance_flag FROM fleet.vehicles WHERE id = $1', [vehicle.id])).rows[0].maintenance_flag;

async function createPart(depot: Depot, unitCost: number) {
  const res = await pool.query<{ public_id: string }>(
    `INSERT INTO maintenance.inventory_parts (depot_id, part_number, name, unit_cost_cents, stock_quantity)
     VALUES ($1, $2, 'Clutch kit', $3, 10) RETURNING public_id`,
    [depot.id, `CK-${randomUUID().slice(0, 8)}`, unitCost],
  );
  return res.rows[0];
}

/** Today in Addis Ababa (UTC+3), YYYY-MM-DD. */
const addisDay = (offsetDays = 0) => new Date(Date.now() + 3 * 3600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);

const order = (vehicle: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  vehicle_id: vehicle.public_id,
  description: 'Gearbox overhaul',
  labour_hours: 0,
  total_cost_cents: 2_500_000,
  maintenance_type: 'preventive',
  ...extra,
});

describe('requests and approval', () => {
  test('a request above the threshold cannot start until approved; approving it opens the work and flags the vehicle', async () => {
    const depot = await createDepot();
    const tech = await signIn(['technician'], depot);
    const approver = await signIn(['depot_admin'], depot);
    const vehicle = await createVehicle({ depot });

    const created = await call('post', '/maintenance-records', tech.cookie, order(vehicle, { status: 'requested' }));
    expect(created.status).toBe(201);
    const id = created.body.data.id;
    expect(created.body.data.status).toBe('requested');
    expect(created.body.data.work_order).toMatchObject({ approval_required: true, approved_by: null, itemised: false, tasks: [], labour: [] });
    expect(await flagOf(vehicle)).toBe(false);

    for (const status of ['scheduled', 'open', 'in_progress'] as const) {
      const start = await call('patch', `/maintenance-records/${id}`, tech.cookie, { status });
      expect(start.status).toBe(409);
      expect(start.body.error.details).toEqual([{ field: 'status', reason: 'approval_required' }]);
    }
    const complete = await call('post', `/maintenance-records/${id}/complete`, tech.cookie, {});
    expect(complete.status).toBe(409);

    const notAllowed = await call('post', `/maintenance-records/${id}/approve`, tech.cookie);
    expect(notAllowed.status).toBe(403);

    const approved = await call('post', `/maintenance-records/${id}/approve`, approver.cookie);
    expect(approved.status).toBe(200);
    expect(approved.body.data.status).toBe('open');
    expect(approved.body.data.work_order).toMatchObject({ approval_required: false, approved_by: approver.user.public_id });
    expect(approved.body.data.work_order.approved_at).toEqual(expect.any(String));
    expect(await flagOf(vehicle)).toBe(true);

    const started = await call('patch', `/maintenance-records/${id}`, tech.cookie, { status: 'in_progress' });
    expect(started.status).toBe(200);
    const again = await call('post', `/maintenance-records/${id}/approve`, approver.cookie);
    expect(again.status).toBe(409);
    expect((await call('patch', `/maintenance-records/${id}`, tech.cookie, { status: 'requested' })).body.error.details).toEqual([
      { field: 'status', reason: 'back_to_requested' },
    ]);
  });

  test('a request at or below the threshold starts without approval; a request can be cancelled', async () => {
    const depot = await createDepot();
    const tech = await signIn(['technician'], depot);
    const vehicle = await createVehicle({ depot });

    const small = await call('post', '/maintenance-records', tech.cookie, order(vehicle, { status: 'requested', total_cost_cents: 2_000_000 }));
    expect(small.body.data.work_order.approval_required).toBe(false);
    const started = await call('patch', `/maintenance-records/${small.body.data.id}`, tech.cookie, { status: 'in_progress' });
    expect(started.status).toBe(200);
    expect(await flagOf(vehicle)).toBe(true);

    const big = await call('post', '/maintenance-records', tech.cookie, order(vehicle, { status: 'requested' }));
    const cancelled = await call('patch', `/maintenance-records/${big.body.data.id}`, tech.cookie, { status: 'cancelled' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe('cancelled');
  });

  test('open=true lists work, not requests', async () => {
    const depot = await createDepot();
    const tech = await signIn(['technician'], depot);
    const vehicle = await createVehicle({ depot });
    await call('post', '/maintenance-records', tech.cookie, order(vehicle, { status: 'requested' }));
    const open = await call('get', `/maintenance-records?vehicle_id=${vehicle.public_id}&open=true`, tech.cookie);
    expect(open.body.data).toEqual([]);
    const requested = await call('get', `/maintenance-records?vehicle_id=${vehicle.public_id}&status=requested`, tech.cookie);
    expect(requested.body.data).toHaveLength(1);
  });
});

describe('itemised totals', () => {
  test("an order's total is parts plus labour plus vendor, and cannot be typed once itemised", async () => {
    const depot = await createDepot();
    const tech = await signIn(['technician'], depot);
    const manager = await signIn(['depot_admin'], depot);
    const finance = await signIn(['finance_clerk'], depot);
    const vehicle = await createVehicle({ depot });
    const part = await createPart(depot, 120_000);

    const created = await call(
      'post',
      '/maintenance-records',
      tech.cookie,
      order(vehicle, { total_cost_cents: 400_000, labour_hours: 1, parts: [{ part_id: part.public_id, quantity: 2, unit_cost_cents: 120_000 }] }),
    );
    const id = created.body.data.id;
    expect(created.body.data.parts_cost_cents).toBe(240_000);

    // Two technicians, at the default rate (300 ETB an hour) and a rate a finance role set.
    const labour = await call('post', `/maintenance-records/${id}/labour`, tech.cookie, { technician_id: tech.user.public_id, hours: 3.5 });
    expect(labour.status).toBe(201);
    const other = await signIn(['technician'], depot);
    const rated = await call('post', `/maintenance-records/${id}/labour`, finance.cookie, { technician_id: other.user.public_id, hours: 2, rate_cents: 45_000 });
    expect(rated.status).toBe(403); // finance clerks read work orders but do not write them
    const managerRated = await call('post', `/maintenance-records/${id}/labour`, manager.cookie, {
      technician_id: other.user.public_id,
      hours: 2,
      rate_cents: 45_000,
    });
    expect(managerRated.status).toBe(403); // depot admins write work orders but may not set rates

    await pool.query(
      `INSERT INTO auth.user_roles (user_id, role_id) SELECT $1, id FROM auth.roles WHERE name = 'finance_clerk'`,
      [manager.user.id],
    );
    const reSigned = await request(app).post('/api/v1/auth/login').send({ email: manager.user.email, password: PASSWORD });
    const managerFinance = (reSigned.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
    const set = await call('post', `/maintenance-records/${id}/labour`, managerFinance, { technician_id: other.user.public_id, hours: 2, rate_cents: 45_000 });
    expect(set.status).toBe(201);

    const vendor = await call('post', '/vendors', manager.cookie, { name: `Gearbox Masters ${randomUUID().slice(0, 4)}`, vendor_type: 'workshop', depot_id: depot.public_id });
    expect(vendor.status).toBe(201);
    const withVendor = await call('put', `/maintenance-records/${id}/vendor`, tech.cookie, {
      vendor_id: vendor.body.data.id,
      vendor_invoice_ref: 'INV-2207',
      vendor_cost_cents: 800_000,
    });
    expect(withVendor.status).toBe(200);

    // 240,000 parts + (3.5 h x 30,000 + 2 h x 45,000 = 195,000) labour + 800,000 vendor.
    const seen = await call('get', `/maintenance-records/${id}`, finance.cookie);
    expect(seen.body.data).toMatchObject({ total_cost_cents: 1_235_000, labour_hours: 5.5 });
    expect(seen.body.data.work_order).toMatchObject({
      itemised: true,
      labour_cost_cents: 195_000,
      vendor_cost_cents: 800_000,
      vendor_invoice_ref: 'INV-2207',
      vendor: { id: vendor.body.data.id, vendor_type: 'workshop' },
    });
    expect(seen.body.data.work_order.labour.map((l: { rate_cents: number }) => l.rate_cents).sort()).toEqual([30_000, 45_000]);

    // The technician sees the total but no rates.
    const techView = await call('get', `/maintenance-records/${id}`, tech.cookie);
    expect(techView.body.data.total_cost_cents).toBe(1_235_000);
    expect(techView.body.data.work_order.labour_cost_cents).toBeNull();
    expect(techView.body.data.work_order.labour.every((l: { rate_cents: unknown; cost_cents: unknown }) => l.rate_cents === null && l.cost_cents === null)).toBe(true);
    const ownRate = await call('post', `/maintenance-records/${id}/labour`, tech.cookie, { technician_id: tech.user.public_id, hours: 1, rate_cents: 1 });
    expect(ownRate.status).toBe(403);

    for (const field of ['total_cost_cents', 'labour_hours'] as const) {
      const typed = await call('patch', `/maintenance-records/${id}`, tech.cookie, { [field]: 1 });
      expect(typed.status).toBe(400);
      expect(typed.body.error.details).toEqual([{ field, reason: 'itemised_order' }]);
    }

    // A mistaken entry comes off and the total follows.
    const entry = seen.body.data.work_order.labour.find((l: { rate_cents: number }) => l.rate_cents === 45_000);
    const removed = await call('delete', `/maintenance-records/${id}/labour/${entry.id}`, tech.cookie);
    expect(removed.body.data).toMatchObject({ total_cost_cents: 1_145_000, labour_hours: 3.5 });
  });

  test('labour: not on a request, not on a day to come, only by a technician of the depot', async () => {
    const depot = await createDepot();
    const otherDepot = await createDepot();
    const tech = await signIn(['technician'], depot);
    const stranger = await createUser({ roles: ['technician'], depot: otherDepot });
    const driver = await createUser({ roles: ['driver'], depot });
    const vehicle = await createVehicle({ depot });

    const request_ = await call('post', '/maintenance-records', tech.cookie, order(vehicle, { status: 'requested' }));
    const onRequest = await call('post', `/maintenance-records/${request_.body.data.id}/labour`, tech.cookie, { technician_id: tech.user.public_id, hours: 1 });
    expect(onRequest.status).toBe(409);

    const open = await call('post', '/maintenance-records', tech.cookie, order(vehicle, { total_cost_cents: 10_000 }));
    const id = open.body.data.id;
    const future = await call('post', `/maintenance-records/${id}/labour`, tech.cookie, { technician_id: tech.user.public_id, hours: 1, work_date: addisDay(2) });
    expect(future.body.error.details).toEqual([{ field: 'work_date', reason: 'in_future' }]);
    for (const who of [stranger, driver]) {
      const res = await call('post', `/maintenance-records/${id}/labour`, tech.cookie, { technician_id: who.public_id, hours: 1 });
      expect(res.body.error.details).toEqual([{ field: 'technician_id', reason: 'references_missing_record' }]);
    }
    const tooLong = await call('post', `/maintenance-records/${id}/labour`, tech.cookie, { technician_id: tech.user.public_id, hours: 25 });
    expect(tooLong.status).toBe(400);
  });
});

describe('tasks', () => {
  test('tasks are added, changed and removed; their actual hours are the labour booked to them', async () => {
    const depot = await createDepot();
    const tech = await signIn(['technician'], depot);
    const vehicle = await createVehicle({ depot });
    const created = await call('post', '/maintenance-records', tech.cookie, order(vehicle, { total_cost_cents: 10_000 }));
    const id = created.body.data.id;

    const added = await call('post', `/maintenance-records/${id}/tasks`, tech.cookie, { description: 'Drain gearbox oil', component: 'transmission', estimated_hours: 1.5 });
    expect(added.status).toBe(201);
    await call('post', `/maintenance-records/${id}/tasks`, tech.cookie, { description: 'Replace clutch plate', estimated_hours: 3 });
    const [first, second] = (await call('get', `/maintenance-records/${id}`, tech.cookie)).body.data.work_order.tasks;
    expect([first.description, second.description]).toEqual(['Drain gearbox oil', 'Replace clutch plate']);
    expect(first).toMatchObject({ component: 'transmission', status: 'pending', estimated_hours: 1.5, actual_hours: 0 });

    await call('post', `/maintenance-records/${id}/labour`, tech.cookie, { technician_id: tech.user.public_id, task_id: first.id, hours: 2 });
    const changed = await call('patch', `/maintenance-records/${id}/tasks/${first.id}`, tech.cookie, { status: 'done' }, { 'If-Match': `"${first.version}"` });
    expect(changed.status).toBe(200);
    expect(changed.body.data.work_order.tasks[0]).toMatchObject({ status: 'done', actual_hours: 2 });
    const stale = await call('patch', `/maintenance-records/${id}/tasks/${first.id}`, tech.cookie, { status: 'skipped' }, { 'If-Match': `"${first.version}"` });
    expect(stale.status).toBe(409);

    const removed = await call('delete', `/maintenance-records/${id}/tasks/${first.id}`, tech.cookie);
    expect(removed.body.data.work_order.tasks.map((t: { id: string }) => t.id)).toEqual([second.id]);
    // Its labour stays on the order, without a task.
    expect(removed.body.data.work_order.labour).toHaveLength(1);
    expect(removed.body.data.work_order.labour[0].task_id).toBeNull();

    const wrongTask = await call('post', `/maintenance-records/${id}/labour`, tech.cookie, { technician_id: tech.user.public_id, task_id: first.id, hours: 1 });
    expect(wrongTask.body.error.details).toEqual([{ field: 'task_id', reason: 'references_missing_record' }]);

    await call('post', `/maintenance-records/${id}/complete`, tech.cookie, {});
    const closed = await call('post', `/maintenance-records/${id}/tasks`, tech.cookie, { description: 'Too late' });
    expect(closed.status).toBe(409);
  });
});

describe('vendors', () => {
  test('a depot sees its own and fleet-wide vendors; names are unique per depot; an order takes only a vendor of its depot', async () => {
    const depot = await createDepot();
    const otherDepot = await createDepot();
    const admin = await signIn(['admin']);
    const manager = await signIn(['depot_admin'], depot);
    const otherManager = await signIn(['depot_admin'], otherDepot);
    const tech = await signIn(['technician'], depot);
    const vehicle = await createVehicle({ depot });
    const tag = randomUUID().slice(0, 6);

    const fleetWide = await call('post', '/vendors', admin.cookie, { name: `Tyre World ${tag}`, vendor_type: 'tyres', depot_id: null });
    expect(fleetWide.status).toBe(201);
    expect(fleetWide.body.data.depot_id).toBeNull();
    const mine = await call('post', '/vendors', manager.cookie, { name: `Dealer ${tag}`, vendor_type: 'dealer', depot_id: depot.public_id, email: 'service@dealer.example' });
    const theirs = await call('post', '/vendors', otherManager.cookie, { name: `Dealer ${tag}`, vendor_type: 'dealer', depot_id: otherDepot.public_id });
    expect(theirs.status).toBe(201); // the same name in another depot
    const duplicate = await call('post', '/vendors', manager.cookie, { name: `dealer ${tag.toUpperCase()}`, vendor_type: 'parts', depot_id: depot.public_id });
    expect(duplicate.status).toBe(409);
    const fleetByDepotAdmin = await call('post', '/vendors', manager.cookie, { name: `Fleet ${tag}`, vendor_type: 'parts', depot_id: null });
    expect(fleetByDepotAdmin.body.error.details).toEqual([{ field: 'depot_id', reason: 'required' }]);
    expect((await call('post', '/vendors', tech.cookie, { name: `Tech ${tag}`, vendor_type: 'parts', depot_id: depot.public_id })).status).toBe(403);

    const listed = await call('get', `/vendors?search=${tag}`, tech.cookie);
    expect(listed.body.data.map((v: { id: string }) => v.id).sort()).toEqual([fleetWide.body.data.id, mine.body.data.id].sort());
    expect((await call('get', `/vendors/${theirs.body.data.id}`, tech.cookie)).status).toBe(404);

    const created = await call('post', '/maintenance-records', tech.cookie, order(vehicle, { total_cost_cents: 10_000 }));
    const id = created.body.data.id;
    const otherDepots = await call('put', `/maintenance-records/${id}/vendor`, tech.cookie, { vendor_id: theirs.body.data.id });
    expect(otherDepots.body.error.details).toEqual([{ field: 'vendor_id', reason: 'references_missing_record' }]);
    const ok = await call('put', `/maintenance-records/${id}/vendor`, tech.cookie, { vendor_id: fleetWide.body.data.id, vendor_cost_cents: 50_000 });
    expect(ok.body.data.work_order.vendor.name).toBe(`Tyre World ${tag}`);
    expect(ok.body.data.total_cost_cents).toBe(50_000);

    // Retired: no new orders take it; the order that named it keeps it.
    const retired = await call('patch', `/vendors/${fleetWide.body.data.id}`, admin.cookie, { is_active: false }, { 'If-Match': `"${fleetWide.body.data.version}"` });
    expect(retired.body.data.is_active).toBe(false);
    expect((await call('get', `/maintenance-records/${id}`, tech.cookie)).body.data.work_order.vendor.id).toBe(fleetWide.body.data.id);
    const second = await call('post', '/maintenance-records', tech.cookie, order(vehicle, { total_cost_cents: 10_000 }));
    const refused = await call('put', `/maintenance-records/${second.body.data.id}/vendor`, tech.cookie, { vendor_id: fleetWide.body.data.id });
    expect(refused.status).toBe(400);

    const off = await call('put', `/maintenance-records/${id}/vendor`, tech.cookie, { vendor_id: null });
    expect(off.body.data.work_order).toMatchObject({ vendor: null, vendor_cost_cents: 0, itemised: false });
  });
});

describe('GET /labour-hours', () => {
  test('hours per technician per week, in the caller’s depots; costs for finance roles only', async () => {
    const depot = await createDepot();
    const otherDepot = await createDepot();
    const tech = await signIn(['technician'], depot);
    const other = await signIn(['technician'], otherDepot);
    const finance = await signIn(['finance_clerk'], depot);
    const vehicle = await createVehicle({ depot });
    const otherVehicle = await createVehicle({ depot: otherDepot });

    // A Monday and the Wednesday after it, both in the past.
    const today = addisDay();
    const weekday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
    const monday = addisDay(-weekday - 14);
    const wednesday = addisDay(-weekday - 12);
    const nextMonday = addisDay(-weekday - 7);

    const a = await call('post', '/maintenance-records', tech.cookie, order(vehicle, { total_cost_cents: 10_000 }));
    const b = await call('post', '/maintenance-records', tech.cookie, order(vehicle, { total_cost_cents: 10_000 }));
    await call('post', `/maintenance-records/${a.body.data.id}/labour`, tech.cookie, { technician_id: tech.user.public_id, hours: 4, work_date: monday });
    await call('post', `/maintenance-records/${b.body.data.id}/labour`, tech.cookie, { technician_id: tech.user.public_id, hours: 2.5, work_date: wednesday });
    await call('post', `/maintenance-records/${b.body.data.id}/labour`, tech.cookie, { technician_id: tech.user.public_id, hours: 1, work_date: nextMonday });
    const c = await call('post', '/maintenance-records', other.cookie, order(otherVehicle, { total_cost_cents: 10_000 }));
    await call('post', `/maintenance-records/${c.body.data.id}/labour`, other.cookie, { technician_id: other.user.public_id, hours: 8, work_date: monday });

    const report = await call('get', `/labour-hours?from=${monday}&to=${today}`, tech.cookie);
    expect(report.status).toBe(200);
    expect(report.body.data).toEqual([
      { technician_id: tech.user.public_id, technician_name: tech.user.full_name, week_start: monday, hours: 6.5, cost_cents: null, work_orders: 2 },
      { technician_id: tech.user.public_id, technician_name: tech.user.full_name, week_start: nextMonday, hours: 1, cost_cents: null, work_orders: 1 },
    ]);
    const costed = await call('get', `/labour-hours?from=${monday}&to=${today}&technician_id=${tech.user.public_id}`, finance.cookie);
    expect(costed.body.data.map((w: { cost_cents: number }) => w.cost_cents)).toEqual([195_000, 30_000]);

    expect((await call('get', `/labour-hours?from=${today}&to=${monday}`, tech.cookie)).status).toBe(400);
    expect((await call('get', `/labour-hours?from=2020-01-01&to=${today}`, tech.cookie)).body.error.details).toEqual([{ field: 'to', reason: 'range_too_long' }]);
  });
});

describe('GET /maintenance-records/{id}/technicians', () => {
  test("the technicians of the vehicle's depot and fleet-wide ones, not another depot's or a driver", async () => {
    const depot = await createDepot();
    const otherDepot = await createDepot();
    const tech = await signIn(['technician'], depot);
    const stranger = await createUser({ roles: ['technician'], depot: otherDepot });
    const driver = await createUser({ roles: ['driver'], depot });
    const manager = await createUser({ roles: ['fleet_manager'] });
    const vehicle = await createVehicle({ depot });
    const created = await call('post', '/maintenance-records', tech.cookie, order(vehicle, { total_cost_cents: 10_000 }));

    const res = await call('get', `/maintenance-records/${created.body.data.id}/technicians`, tech.cookie);
    const ids = res.body.data.map((t: { id: string }) => t.id);
    expect(ids).toContain(tech.user.public_id);
    expect(ids).toContain(manager.public_id);
    expect(ids).not.toContain(stranger.public_id);
    expect(ids).not.toContain(driver.public_id);
  });
});

import { randomUUID } from 'node:crypto';
import request, { type Response } from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { createDepot, createUser, createVehicle, type RoleName } from '../support/factories';
import { publishedEvents } from '../support/events';

const app = createApp();
const PASSWORD = 'Maintenance-Test-1';

type Depot = Awaited<ReturnType<typeof createDepot>>;

async function signIn(roles: RoleName[], depot: Depot | null = null): Promise<string> {
  const user = await createUser({ roles, depot, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

const api = {
  get: (path: string, cookie = '') => request(app).get(`/api/v1${path}`).set('Cookie', cookie),
  post: (path: string, body: object, cookie = '') => request(app).post(`/api/v1${path}`).set('Cookie', cookie).send(body),
  put: (path: string, body: object, cookie = '') => request(app).put(`/api/v1${path}`).set('Cookie', cookie).send(body),
};

/** A stocked part; `depot` null means stock shared by every depot. */
async function createPart(options: { depot?: Depot | null; stock?: number; unitCost?: number; active?: boolean } = {}) {
  const res = await pool.query<{ id: string; public_id: string; part_number: string }>(
    `INSERT INTO maintenance.inventory_parts (depot_id, part_number, name, unit_cost_cents, stock_quantity, is_active)
     VALUES ($1, $2, 'Brake pad set', $3, $4, $5) RETURNING id, public_id, part_number`,
    [options.depot?.id ?? null, `BP-${randomUUID().slice(0, 8)}`, options.unitCost ?? 4500, options.stock ?? 10, options.active ?? true],
  );
  return res.rows[0];
}

const flagOf = async (vehicle: { id: unknown }) =>
  (await pool.query<{ maintenance_flag: boolean }>('SELECT maintenance_flag FROM fleet.vehicles WHERE id = $1', [vehicle.id])).rows[0].maintenance_flag;
const stockOf = async (part: { id: string }) =>
  (await pool.query<{ stock_quantity: number }>('SELECT stock_quantity FROM maintenance.inventory_parts WHERE id = $1', [part.id])).rows[0].stock_quantity;

async function auditRows(res: Response) {
  const rows = await pool.query<{ action: string; entity_type: string }>(
    'SELECT action, entity_type FROM audit.audit_logs WHERE correlation_id = $1 ORDER BY id',
    [res.headers['x-request-id']],
  );
  return rows.rows.map((r) => `${r.action} ${r.entity_type}`);
}

/** What failed on a brake job (FMS-125): a corrective repair is completed only with one. */
const WORN_PADS = { component: 'brakes', failure_mode: 'wear', unplanned: false };

const body = (vehicle: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  vehicle_id: vehicle.public_id,
  description: 'Replace front brake pads',
  labour_hours: 2.5,
  total_cost_cents: 150_000,
  ...extra,
});

describe('POST /maintenance', () => {
  test('a float in a money field is 400 VALIDATION_FLOAT_IN_MONEY_PATH, whatever it is called', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['technician'], depot);
    const vehicle = await createVehicle({ depot });

    const camel = await api.post('/maintenance', { ...body(vehicle), total_cost_cents: undefined, totalCost: 1500.5 }, cookie);
    expect(camel.status).toBe(400);
    expect(camel.body.error.code).toBe('VALIDATION_FLOAT_IN_MONEY_PATH');
    expect(camel.body.error.details).toEqual([{ field: 'totalCost', reason: 'float_in_money_path' }]);

    const cents = await api.post('/maintenance', body(vehicle, { total_cost_cents: 1500.5 }), cookie);
    expect(cents.body.error.code).toBe('VALIDATION_FLOAT_IN_MONEY_PATH');
    const part = await api.post('/maintenance', body(vehicle, { parts: [{ part_id: randomUUID(), quantity: 1, unit_cost_cents: 99.9 }] }), cookie);
    expect(part.body.error.details).toEqual([{ field: 'parts.0.unit_cost_cents', reason: 'float_in_money_path' }]);
    expect(await flagOf(vehicle)).toBe(false);
  });

  test('creating a record flags the vehicle for maintenance in the same transaction, with audit rows', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['technician'], depot);
    const vehicle = await createVehicle({ depot });

    const res = await api.post('/maintenance', body(vehicle), cookie);
    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(`/api/v1/maintenance-records/${res.body.data.id}`);
    expect(res.body.data).toMatchObject({
      vehicle_id: vehicle.public_id,
      registration_number: vehicle.registration_number,
      description: 'Replace front brake pads',
      labour_hours: 2.5,
      total_cost_cents: 150_000,
      parts_cost_cents: 0,
      status: 'open',
      maintenance_type: 'corrective',
      parts: [],
    });
    expect(res.body.meta.warnings).toEqual([]);
    expect(await flagOf(vehicle)).toBe(true);
    expect(await auditRows(res)).toEqual(['INSERT maintenance.maintenance_records', 'UPDATE fleet.vehicles']);
  });

  test('a failed write leaves the flag as it was: the record and the flag commit together', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['technician'], depot);
    const vehicle = await createVehicle({ depot });
    const missing = await api.post('/maintenance', body(vehicle, { parts: [{ part_id: randomUUID(), quantity: 1, unit_cost_cents: 100 }] }), cookie);
    expect(missing.status).toBe(400);
    expect(missing.body.error.details).toEqual([{ field: 'parts.0.part_id', reason: 'references_missing_record' }]);
    expect(await flagOf(vehicle)).toBe(false);
  });

  test('parts used come off the shelf, are listed on the record, and enter the inventory ledger', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['depot_admin'], depot);
    const vehicle = await createVehicle({ depot });
    const pads = await createPart({ depot, stock: 10 });
    const filter = await createPart({ depot: null, stock: 3 });

    const res = await api.post(
      '/maintenance',
      body(vehicle, {
        parts: [
          { part_id: pads.public_id, quantity: 4, unit_cost_cents: 4500 },
          { part_id: filter.public_id, quantity: 1, unit_cost_cents: 1200 },
        ],
      }),
      cookie,
    );
    expect(res.status).toBe(201);
    expect(await stockOf(pads)).toBe(6);
    expect(await stockOf(filter)).toBe(2);
    expect(res.body.data.parts_cost_cents).toBe(4 * 4500 + 1200);
    expect(res.body.data.parts).toEqual(
      expect.arrayContaining([expect.objectContaining({ part_id: pads.public_id, quantity: 4, unit_cost_cents: 4500, line_cost_cents: 18_000 })]),
    );
    const ledger = await pool.query(
      `SELECT movement_type, quantity_delta, reference_type FROM maintenance.inventory_movements WHERE inventory_part_id = $1`,
      [pads.id],
    );
    expect(ledger.rows).toEqual([{ movement_type: 'consumption', quantity_delta: -4, reference_type: 'maintenance_record' }]);
  });

  test('using more than the stock record holds is still recorded; stock stops at zero with a LOW_STOCK warning', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['technician'], depot);
    const vehicle = await createVehicle({ depot });
    const part = await createPart({ depot, stock: 1 });

    const res = await api.post('/maintenance', body(vehicle, { parts: [{ part_id: part.public_id, quantity: 3, unit_cost_cents: 4500 }] }), cookie);
    expect(res.status).toBe(201);
    expect(res.body.data.parts).toEqual([expect.objectContaining({ part_id: part.public_id, quantity: 3 })]);
    expect(await stockOf(part)).toBe(0);
    expect(res.body.meta.warnings).toEqual([
      { warning: 'LOW_STOCK', part_id: part.public_id, part_number: part.part_number, stock_quantity: 0, shortfall: 2 },
    ]);
    const ledger = await pool.query('SELECT quantity_delta, notes FROM maintenance.inventory_movements WHERE inventory_part_id = $1', [part.id]);
    expect(ledger.rows).toEqual([{ quantity_delta: -1, notes: '2 more used than the stock record held' }]);

    // Nothing left at all: the record is still saved, with no stock change and no ledger entry.
    const again = await api.post('/maintenance', body(vehicle, { parts: [{ part_id: part.public_id, quantity: 1, unit_cost_cents: 4500 }] }), cookie);
    expect(again.status).toBe(201);
    expect(again.body.meta.warnings).toEqual([expect.objectContaining({ warning: 'LOW_STOCK', stock_quantity: 0, shortfall: 1 })]);
  });

  test('warns when the total is less than the parts; refuses a part from another depot, a retired vehicle, a vehicle elsewhere', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['technician'], depot);
    const vehicle = await createVehicle({ depot });
    const part = await createPart({ depot, stock: 5 });
    const cheap = await api.post('/maintenance', body(vehicle, { total_cost_cents: 1000, parts: [{ part_id: part.public_id, quantity: 1, unit_cost_cents: 4500 }] }), cookie);
    expect(cheap.body.meta.warnings).toEqual([{ warning: 'COST_BELOW_PARTS', total_cost_cents: 1000, parts_cost_cents: 4500 }]);

    const foreignPart = await createPart({ depot: await createDepot() });
    const other = await api.post('/maintenance', body(vehicle, { parts: [{ part_id: foreignPart.public_id, quantity: 1, unit_cost_cents: 1 }] }), cookie);
    expect(other.body.error.details).toEqual([{ field: 'parts.0.part_id', reason: 'part_in_other_depot' }]);

    const retired = await createVehicle({ depot, status: 'retired', is_active: false });
    expect((await api.post('/maintenance', body(retired), cookie)).status).toBe(409);
    const elsewhere = await createVehicle({ depot: await createDepot() });
    expect((await api.post('/maintenance', body(elsewhere), cookie)).body.error.details).toEqual([
      { field: 'vehicle_id', reason: 'references_missing_record' },
    ]);
  });

  test('a dispatcher cannot create maintenance records: 403', async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    expect((await api.post('/maintenance', body(vehicle), await signIn(['dispatcher'], depot))).status).toBe(403);
  });
});

describe('completing work', () => {
  test('PUT with completed_at completes it and clears the maintenance flag in the same transaction', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['technician'], depot);
    const vehicle = await createVehicle({ depot });
    const created = await api.post('/maintenance', body(vehicle, { failures: [WORN_PADS] }), cookie);
    expect(await flagOf(vehicle)).toBe(true);

    const completedAt = new Date(Date.now() - 60_000).toISOString();
    const res = await api.put(`/maintenance/${created.body.data.id}`, { completed_at: completedAt }, cookie);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'completed', version: 1 });
    expect(new Date(res.body.data.completed_at).toISOString()).toBe(completedAt);
    expect(res.body.data.completed_by).toMatch(/^[0-9a-f-]{36}$/);
    expect(await flagOf(vehicle)).toBe(false);
    expect(await auditRows(res)).toEqual(['UPDATE maintenance.maintenance_records', 'UPDATE fleet.vehicles']);

    // Closed work cannot change again.
    expect((await api.put(`/maintenance/${created.body.data.id}`, { notes: 'late note' }, cookie)).status).toBe(409);
  });

  test('the flag stays while other work on the vehicle is still open; POST .../complete needs maintenance:execute', async () => {
    const depot = await createDepot();
    const tech = await signIn(['technician'], depot);
    const vehicle = await createVehicle({ depot });
    const a = await api.post('/maintenance', body(vehicle, { failures: [WORN_PADS] }), tech);
    const b = await api.post('/maintenance', body(vehicle, { description: 'Oil change' }), tech);

    expect((await api.post(`/maintenance-records/${a.body.data.id}/complete`, {}, tech)).status).toBe(200);
    expect(await flagOf(vehicle)).toBe(true);
    expect((await api.post(`/maintenance-records/${b.body.data.id}/complete`, {}, await signIn(['depot_admin'], depot))).status).toBe(403);
    expect((await api.put(`/maintenance-records/${b.body.data.id}`, { status: 'cancelled' }, tech)).status).toBe(200);
    expect(await flagOf(vehicle)).toBe(false);
  });

  test('completion cannot be in the future; a stale If-Match is 409; another depot is 404', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['technician'], depot);
    const vehicle = await createVehicle({ depot });
    const created = await api.post('/maintenance', body(vehicle), cookie);
    const id = created.body.data.id;

    const future = await api.put(`/maintenance/${id}`, { completed_at: new Date(Date.now() + 3_600_000).toISOString() }, cookie);
    expect(future.body.error.details).toEqual([{ field: 'completed_at', reason: 'in_future' }]);
    expect((await api.put(`/maintenance/${id}`, { notes: 'x' }, cookie).set('If-Match', '"7"')).status).toBe(409);
    expect((await api.put(`/maintenance/${id}`, { notes: 'x' }, await signIn(['technician'], await createDepot()))).status).toBe(404);
    expect((await api.get(`/maintenance/${id}`, await signIn(['technician'], await createDepot()))).status).toBe(404);
  });
});

describe('GET /maintenance', () => {
  test("a vehicle's history, newest first, limited to the caller's depots; open=true for unfinished work", async () => {
    const depot = await createDepot();
    const cookie = await signIn(['depot_admin'], depot);
    const vehicle = await createVehicle({ depot });
    const first = await api.post('/maintenance', body(vehicle, { description: 'First', failures: [WORN_PADS] }), cookie);
    const second = await api.post('/maintenance', body(vehicle, { description: 'Second' }), cookie);
    await api.put(`/maintenance/${first.body.data.id}`, { completed_at: new Date().toISOString() }, cookie);
    const foreign = await createVehicle({ depot: await createDepot() });
    await api.post('/maintenance', body(foreign), await signIn(['admin']));

    const history = await api.get(`/maintenance?vehicle_id=${vehicle.public_id}`, cookie);
    expect(history.body.data.map((r: { id: string }) => r.id)).toEqual([second.body.data.id, first.body.data.id]);
    const open = await api.get('/maintenance-records?open=true&page_size=100', cookie);
    expect(open.body.data.map((r: { id: string }) => r.id)).toEqual([second.body.data.id]);
    expect((await api.get(`/maintenance?vehicle_id=${foreign.public_id}`, cookie)).body.data).toEqual([]);
  });

  test('sort_by=work_date orders by when the work happened, not when it was entered (FMS-136)', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['depot_admin'], depot);
    const vehicle = await createVehicle({ depot });
    const recent = await api.post('/maintenance', body(vehicle, { description: 'Done today', maintenance_type: 'preventive' }), cookie);
    const backlog = await api.post('/maintenance', body(vehicle, { description: 'Logged late', maintenance_type: 'preventive', scheduled_at: '2026-01-15T06:00:00Z' }), cookie);
    await api.put(`/maintenance/${recent.body.data.id}`, { completed_at: new Date().toISOString() }, cookie);
    expect((await api.put(`/maintenance/${backlog.body.data.id}`, { completed_at: '2026-01-15T08:00:00Z' }, cookie)).body).toMatchObject({ data: { status: 'completed' } });

    const ids = async (query: string) => ((await api.get(`/maintenance?vehicle_id=${vehicle.public_id}${query}`, cookie)).body.data as { id: string }[]).map((r) => r.id);
    expect(await ids('')).toEqual([backlog.body.data.id, recent.body.data.id]);
    expect(await ids('&sort_by=work_date')).toEqual([recent.body.data.id, backlog.body.data.id]);
    expect(await ids('&sort_by=work_date&sort_order=asc')).toEqual([backlog.body.data.id, recent.body.data.id]);
    expect((await api.get('/maintenance?sort_by=cost', cookie)).status).toBe(400);
  });
});

describe('maintenance events', () => {
  test('open and complete each publish one event; completion says whether the flag was cleared', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['technician'], depot);
    const vehicle = await createVehicle({ depot });
    const created = await api.post('/maintenance', body(vehicle, { maintenance_type: 'preventive' }), cookie);
    await api.put(`/maintenance/${created.body.data.id}`, { completed_at: new Date().toISOString() }, cookie);

    const seen = await publishedEvents('MaintenanceRecordOpened', 'MaintenanceRecordUpdated', 'MaintenanceRecordCompleted');
    expect(seen.map((e) => e.type)).toEqual(['MaintenanceRecordOpened', 'MaintenanceRecordCompleted']);
    expect(seen[1].aggregate).toBe(`maintenance:${created.body.data.id}`);
    expect(seen[1].payload).toMatchObject({ vehicle_id: vehicle.public_id, maintenance_flag_cleared: true });
  });
});

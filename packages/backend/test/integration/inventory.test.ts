import { randomUUID } from 'node:crypto';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import type { DomainEvent } from '../../src/shared/events/domain-event';
import { eventBus } from '../../src/shared/events/event-bus';
import { createDepot, createUser, createVehicle, type RoleName } from '../support/factories';

const app = createApp();
const PASSWORD = 'Inventory-Test-1';

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

const pn = () => `bp-${randomUUID().slice(0, 8)}`;

async function auditRows(res: Response) {
  const rows = await pool.query<{ action: string; entity_type: string; old_values: Record<string, unknown> | null; new_values: Record<string, unknown> }>(
    'SELECT action, entity_type, old_values, new_values FROM audit.audit_logs WHERE correlation_id = $1 ORDER BY id',
    [res.headers['x-request-id']],
  );
  return rows.rows;
}

async function newPart(cookie: string, depot: Depot | null, extra: Record<string, unknown> = {}) {
  const res = await api.post('/inventory', { part_number: pn(), name: 'Brake pad set', depot_id: depot?.public_id ?? null, unit_cost_cents: 4500, ...extra }, cookie);
  expect(res.status).toBe(201);
  return res.body.data as { id: string; stock_quantity: number; version: number };
}

describe('POST /inventory', () => {
  test('creates a part with opening stock, recorded in the ledger as a purchase', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['depot_admin'], depot);
    const number = pn();
    const res = await api.post('/inventory', { part_number: ` ${number} `, name: 'Oil filter', depot_id: depot.public_id, unit_cost_cents: 1200, reorder_threshold: 5, stock_quantity: 12 }, cookie);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      part_number: number.toUpperCase(),
      name: 'Oil filter',
      depot_id: depot.public_id,
      unit_cost_cents: 1200,
      stock_quantity: 12,
      reorder_threshold: 5,
      below_reorder: false,
      stock_status: 'ok',
      is_active: true,
    });
    const ledger = await api.get(`/inventory/${res.body.data.id}/movements`, cookie);
    expect(ledger.body.data).toEqual([expect.objectContaining({ movement_type: 'purchase', quantity_delta: 12, notes: 'Opening stock' })]);
  });

  test('a fractional unit cost is VALIDATION_FLOAT_IN_MONEY_PATH; a part number twice is 409; shared stock needs a fleet-wide role', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['technician'], depot);
    const float = await api.post('/inventory', { part_number: pn(), name: 'X', depot_id: depot.public_id, unit_cost_cents: 12.5 }, cookie);
    expect(float.body.error.code).toBe('VALIDATION_FLOAT_IN_MONEY_PATH');

    const number = pn();
    await newPart(cookie, depot, { part_number: number });
    const dup = await api.post('/inventory', { part_number: number.toUpperCase(), name: 'X', depot_id: depot.public_id }, cookie);
    expect(dup.status).toBe(409);
    expect(dup.body.error.details).toEqual([{ field: 'part_number', reason: 'already_exists' }]);

    expect((await api.post('/inventory', { part_number: pn(), name: 'X' }, cookie)).status).toBe(403);
    expect((await api.post('/inventory', { part_number: pn(), name: 'X' }, await signIn(['fleet_manager']))).status).toBe(201);
    const other = await api.post('/inventory', { part_number: pn(), name: 'X', depot_id: (await createDepot()).public_id }, cookie);
    expect(other.body.error.details).toEqual([{ field: 'depot_id', reason: 'references_missing_record' }]);
  });
});

describe('POST /inventory/{id}/adjust', () => {
  test('a quantity that would make stock negative is 409 CONFLICT_INSUFFICIENT_STOCK and changes nothing', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['technician'], depot);
    const part = await newPart(cookie, depot, { stock_quantity: 50 });

    const res = await api.post(`/inventory/${part.id}/adjust`, { quantity: -100, reason: 'Stock take' }, cookie);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'CONFLICT_INSUFFICIENT_STOCK', details: [{ field: 'quantity', reason: 'insufficient_stock' }] });
    expect((await api.get(`/inventory/${part.id}`, cookie)).body.data.stock_quantity).toBe(50);
    expect(await auditRows(res)).toEqual([]);
  });

  test('each adjustment writes an audit row with the old and new stock_quantity, and a ledger line with the reason', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['depot_admin'], depot);
    const part = await newPart(cookie, depot, { stock_quantity: 50 });

    const out = await api.post(`/inventory/${part.id}/adjust`, { quantity: -50, reason: 'Damaged in storage' }, cookie);
    expect(out.status).toBe(200);
    expect(out.body.data).toMatchObject({ stock_quantity: 0, stock_status: 'out' });
    const audit = await auditRows(out);
    expect(audit.map((r) => `${r.action} ${r.entity_type}`)).toEqual(['UPDATE maintenance.inventory_parts', 'INSERT maintenance.inventory_movements']);
    expect(audit[0].old_values).toMatchObject({ stock_quantity: 50 });
    expect(audit[0].new_values).toMatchObject({ stock_quantity: 0 });

    const back = await api.post(`/inventory/${part.id}/adjust`, { quantity: 20, reason: 'Delivery received' }, cookie);
    expect(back.body.data.stock_quantity).toBe(20);
    const ledger = await api.get(`/inventory/${part.id}/movements`, cookie);
    expect(ledger.body.data.map((m: { quantity_delta: number; notes: string }) => [m.quantity_delta, m.notes])).toEqual([
      [20, 'Delivery received'],
      [-50, 'Damaged in storage'],
      [50, 'Opening stock'],
    ]);
  });

  test('a reason is required and zero is refused', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['technician'], depot);
    const part = await newPart(cookie, depot);
    expect((await api.post(`/inventory/${part.id}/adjust`, { quantity: 5 }, cookie)).status).toBe(400);
    expect((await api.post(`/inventory/${part.id}/adjust`, { quantity: 0, reason: 'Nothing' }, cookie)).status).toBe(400);
    expect((await api.post(`/inventory/${part.id}/adjust`, { quantity: 1.5, reason: 'Half' }, cookie)).status).toBe(400);
  });
});

describe('GET /inventory', () => {
  test('belowReorder=true returns only parts at or below their reorder threshold, within the caller\'s depots and shared stock', async () => {
    const depot = await createDepot();
    const admin = await signIn(['admin']);
    const low = await newPart(admin, depot, { stock_quantity: 2, reorder_threshold: 5 });
    const atThreshold = await newPart(admin, depot, { stock_quantity: 5, reorder_threshold: 5 });
    const fine = await newPart(admin, depot, { stock_quantity: 50, reorder_threshold: 5 });
    const sharedLow = await newPart(admin, null, { stock_quantity: 0, reorder_threshold: 1 });
    const elsewhereLow = await newPart(admin, await createDepot(), { stock_quantity: 0, reorder_threshold: 3 });
    const cookie = await signIn(['technician'], depot);

    for (const q of ['belowReorder=true', 'below_reorder=true']) {
      const res = await api.get(`/inventory?${q}&page_size=100`, cookie);
      const ids = res.body.data.map((p: { id: string }) => p.id);
      expect(ids, q).toEqual(expect.arrayContaining([low.id, atThreshold.id, sharedLow.id]));
      expect(ids, q).not.toContain(fine.id);
      expect(ids, q).not.toContain(elsewhereLow.id);
      expect(res.body.data.every((p: { below_reorder: boolean }) => p.below_reorder)).toBe(true);
    }
    expect((await api.get(`/inventory/${elsewhereLow.id}`, cookie)).status).toBe(404);
    expect((await api.get('/inventory/parts?search=brake&page_size=100', cookie)).body.data.length).toBeGreaterThanOrEqual(4);
  });
});

describe('GET /inventory?stock_status=', () => {
  test('out, low and ok split parts the way the stock_status field does', async () => {
    const depot = await createDepot();
    const admin = await signIn(['admin']);
    const out = await newPart(admin, depot, { stock_quantity: 0, reorder_threshold: 3 });
    const low = await newPart(admin, depot, { stock_quantity: 3, reorder_threshold: 3 });
    const ok = await newPart(admin, depot, { stock_quantity: 4, reorder_threshold: 3 });
    for (const [status, part] of [['out', out], ['low', low], ['ok', ok]] as const) {
      const res = await api.get(`/inventory?stock_status=${status}&depot_id=${depot.public_id}&page_size=100`, admin);
      expect(res.body.data.map((p: { id: string }) => p.id), status).toEqual([part.id]);
      expect(res.body.data[0].stock_status).toBe(status);
    }
  });
});

describe('PUT /inventory/{id}', () => {
  test('changes the fields sent with If-Match; stock is not writable here', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['depot_admin'], depot);
    const part = await newPart(cookie, depot, { stock_quantity: 3 });
    const res = await api.put(`/inventory/${part.id}`, { reorder_threshold: 10, name: 'Brake pad set (front)' }, cookie).set('If-Match', '"0"');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ reorder_threshold: 10, name: 'Brake pad set (front)', below_reorder: true, stock_status: 'low', version: 1 });
    const stock = await api.put(`/inventory/${part.id}`, { stock_quantity: 99 }, cookie);
    expect(stock.status).toBe(400);
    expect(stock.body.error.details).toContainEqual({ field: 'stock_quantity', reason: 'not_writable' });
    expect((await api.put(`/inventory/${part.id}`, { name: 'X' }, cookie).set('If-Match', '"0"')).status).toBe(409);
  });
});

describe('who may use inventory', () => {
  test('a driver gets 403 on every inventory endpoint; a dispatcher too', async () => {
    const depot = await createDepot();
    const part = await newPart(await signIn(['admin']), depot);
    for (const role of ['driver', 'dispatcher'] as RoleName[]) {
      const cookie = await signIn([role], depot);
      const calls = [
        api.get('/inventory', cookie),
        api.get('/inventory/parts', cookie),
        api.get(`/inventory/${part.id}`, cookie),
        api.get(`/inventory/${part.id}/movements`, cookie),
        api.post('/inventory', { part_number: pn(), name: 'X', depot_id: depot.public_id }, cookie),
        api.put(`/inventory/${part.id}`, { name: 'X' }, cookie),
        api.post(`/inventory/${part.id}/adjust`, { quantity: 1, reason: 'Test' }, cookie),
      ];
      for (const call of calls) expect((await call).status, role).toBe(403);
    }
  });
});

describe('reorder events', () => {
  const seen: DomainEvent[] = [];
  let off: () => void;
  beforeAll(() => {
    off = eventBus.subscribe('InventoryReorderNeeded', (e) => void seen.push(e));
  });
  afterAll(() => off());
  beforeEach(() => {
    seen.length = 0;
  });

  test('stock crossing the reorder point publishes InventoryReorderNeeded once, from an adjustment or a repair', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['technician'], depot);
    const part = await newPart(cookie, depot, { stock_quantity: 10, reorder_threshold: 4 });
    await api.post(`/inventory/${part.id}/adjust`, { quantity: -5, reason: 'Stock take' }, cookie); // 5: still above
    await api.post(`/inventory/${part.id}/adjust`, { quantity: -1, reason: 'Stock take' }, cookie); // 4: crosses
    await api.post(`/inventory/${part.id}/adjust`, { quantity: -1, reason: 'Stock take' }, cookie); // 3: already below
    expect(seen.map((e) => e.payload)).toEqual([expect.objectContaining({ part_id: part.id, stock_quantity: 4, reorder_threshold: 4 })]);

    const other = await newPart(cookie, depot, { stock_quantity: 6, reorder_threshold: 2 });
    const vehicle = await createVehicle({ depot });
    await api.post(
      '/maintenance',
      { vehicle_id: vehicle.public_id, description: 'Pads', labour_hours: 1, total_cost_cents: 10_000, parts: [{ part_id: other.id, quantity: 5, unit_cost_cents: 1000 }] },
      cookie,
    );
    expect(seen.map((e) => e.payload.part_id)).toEqual([part.id, other.id]);
    expect(seen[1].payload).toMatchObject({ stock_quantity: 1, depot_id: depot.public_id });
  });
});

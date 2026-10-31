import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { maintenanceRefs } from '../../src/modules/maintenance';
import { createDepot, createUser, createVehicle, type RoleName } from '../support/factories';
import { publishedEvents } from '../support/events';

// What a part renews, and when each wearing part and fluid was last changed (FMS-52, the predictive
// model's part history).

const app = createApp();
const PASSWORD = 'Service-Items-Test-1';

type Depot = Awaited<ReturnType<typeof createDepot>>;
type Vehicle = Awaited<ReturnType<typeof createVehicle>>;

async function signIn(roles: RoleName[], depot: Depot | null = null): Promise<string> {
  const user = await createUser({ roles, depot, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

const api = {
  get: (path: string, cookie: string) => request(app).get(`/api/v1${path}`).set('Cookie', cookie),
  post: (path: string, body: object, cookie: string) => request(app).post(`/api/v1${path}`).set('Cookie', cookie).send(body),
  put: (path: string, body: object, cookie: string) => request(app).put(`/api/v1${path}`).set('Cookie', cookie).send(body),
};

const part = (depot: Depot, number: string, extra: Record<string, unknown> = {}) => ({
  part_number: `${number}-${randomUUID().slice(0, 6)}`,
  name: number,
  depot_id: depot.public_id,
  unit_cost_cents: 10_000,
  stock_quantity: 50,
  ...extra,
});

/** A completed service on the vehicle that used these parts, completed at `at`. */
async function service(vehicle: Vehicle, parts: string[], at: string, cookie: string, odometer_km?: number) {
  const created = await api.post(
    '/maintenance',
    {
      vehicle_id: vehicle.public_id,
      description: 'Scheduled service',
      maintenance_type: 'preventive',
      labour_hours: 1,
      total_cost_cents: 50_000,
      parts: parts.map((part_id) => ({ part_id, quantity: 1, unit_cost_cents: 10_000 })),
      ...(odometer_km !== undefined ? { odometer_km } : {}),
    },
    cookie,
  );
  expect(created.status).toBe(201);
  // Created now, completed at `at`: the record's start must not be after it.
  await pool.query('UPDATE maintenance.maintenance_records SET created_at = $2 WHERE public_id = $1', [created.body.data.id, new Date(Date.parse(at) - 3_600_000)]);
  const done = await api.put(`/maintenance/${created.body.data.id}`, { completed_at: at }, cookie);
  expect(done.status).toBe(200);
  return created.body.data.id as string;
}

describe('what a part renews', () => {
  test('is set on create, changed or cleared on update, refused outside the list, and shown on the part', async () => {
    const depot = await createDepot();
    const tech = await signIn(['technician'], depot);

    const created = await api.post('/inventory', part(depot, 'OIL-15W40', { service_item: 'engine_oil' }), tech);
    expect(created.status).toBe(201);
    expect(created.body.data.service_item).toBe('engine_oil');
    const plain = await api.post('/inventory', part(depot, 'WIPER'), tech);
    expect(plain.body.data.service_item).toBeNull();

    const changed = await api.put(`/inventory/${created.body.data.id}`, { service_item: 'gearbox_oil' }, tech);
    expect(changed.body.data.service_item).toBe('gearbox_oil');
    expect((await publishedEvents('InventoryPartUpdated')).at(-1)!.payload).toMatchObject({ changed_fields: ['service_item'] });
    expect((await api.put(`/inventory/${created.body.data.id}`, { service_item: null }, tech)).body.data.service_item).toBeNull();

    const wrong = await api.post('/inventory', part(depot, 'FLUX', { service_item: 'flux_capacitor' }), tech);
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.details[0].field).toBe('service_item');
  });
});

describe('GET /vehicles/{vehicle_id}/service-items', () => {
  test("every item, with the latest completed repair that used a part renewing it; open work and other vehicles don't count", async () => {
    const depot = await createDepot();
    const tech = await signIn(['technician'], depot);
    const vehicle = await createVehicle({ depot });
    const other = await createVehicle({ depot });
    const oil = (await api.post('/inventory', part(depot, 'OIL', { service_item: 'engine_oil' }), tech)).body.data;
    const pads = (await api.post('/inventory', part(depot, 'PADS', { service_item: 'brake_pads' }), tech)).body.data;
    const battery = (await api.post('/inventory', part(depot, 'BAT', { service_item: 'battery' }), tech)).body.data;
    const wiper = (await api.post('/inventory', part(depot, 'WIPER'), tech)).body.data;

    await service(vehicle, [oil.id, pads.id, wiper.id], '2026-06-01T08:00:00Z', tech, 81_000);
    const latest = await service(vehicle, [oil.id], '2026-09-01T08:00:00Z', tech, 92_500.5);
    await service(other, [battery.id], '2026-09-10T08:00:00Z', tech);
    // Open work on the vehicle: the battery is not changed until the work is done.
    await api.post('/maintenance', { vehicle_id: vehicle.public_id, description: 'Battery', maintenance_type: 'preventive', labour_hours: 1, total_cost_cents: 1, parts: [{ part_id: battery.id, quantity: 1, unit_cost_cents: 1 }] }, tech);

    const res = await api.get(`/vehicles/${vehicle.public_id}/service-items`, tech);
    expect(res.status).toBe(200);
    expect(res.body.data.map((i: { service_item: string }) => i.service_item)).toEqual([
      'engine_oil', 'air_filter', 'fuel_filter', 'coolant', 'brake_pads', 'brake_fluid', 'clutch_fluid', 'tyres', 'battery', 'gearbox_oil', 'belts',
    ]);
    const byItem = Object.fromEntries(res.body.data.map((i: { service_item: string }) => [i.service_item, i]));
    expect(byItem.engine_oil).toEqual({
      service_item: 'engine_oil',
      last_changed_at: '2026-09-01T08:00:00.000Z',
      maintenance_record_id: latest,
      odometer_km: 92_500.5,
      part_number: oil.part_number,
    });
    expect(byItem.brake_pads).toMatchObject({ last_changed_at: '2026-06-01T08:00:00.000Z', odometer_km: 81_000, part_number: pads.part_number });
    expect(byItem.battery).toEqual({ service_item: 'battery', last_changed_at: null, maintenance_record_id: null, odometer_km: null, part_number: null });

    // For the nightly scoring: as of a time, only changes before it.
    const asOfJuly = await maintenanceRefs.lastServiceItems(pool, String(vehicle.id), new Date('2026-07-01T00:00:00Z'));
    expect(asOfJuly.map((r) => [r.item, r.changedAt.toISOString()])).toEqual([
      ['engine_oil', '2026-06-01T08:00:00.000Z'],
      ['brake_pads', '2026-06-01T08:00:00.000Z'],
    ]);
  });

  test("another depot's vehicle or a bad id is 404; a dispatcher cannot read it", async () => {
    const depot = await createDepot();
    const vehicle = await createVehicle({ depot });
    const elsewhere = await signIn(['technician'], await createDepot());
    expect((await api.get(`/vehicles/${vehicle.public_id}/service-items`, elsewhere)).status).toBe(404);
    expect((await api.get(`/vehicles/${randomUUID()}/service-items`, await signIn(['admin']))).status).toBe(404);
    expect((await api.get('/vehicles/not-a-uuid/service-items', await signIn(['admin']))).status).toBe(404);
    expect((await api.get(`/vehicles/${vehicle.public_id}/service-items`, await signIn(['dispatcher'], depot))).status).toBe(403);
  });
});

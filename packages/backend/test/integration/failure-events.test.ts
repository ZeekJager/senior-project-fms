import request, { type Response } from 'supertest';
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { createDepot, createUser, createVehicle, type RoleName } from '../support/factories';
import { publishedEvents } from '../support/events';

// Failure records on corrective repairs (FMS-125).

const app = createApp();
const PASSWORD = 'Maintenance-Test-2';

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

const WORN_PADS = { component: 'brakes', failure_mode: 'wear', unplanned: false };
const BURST_HOSE = { component: 'cooling', failure_mode: 'leak', unplanned: true, detected_by: 'breakdown' };

const repair = (vehicle: Vehicle, extra: Record<string, unknown> = {}) => ({
  vehicle_id: vehicle.public_id,
  description: 'Front brake pads replaced',
  labour_hours: 1.5,
  total_cost_cents: 120_000,
  odometer_km: 84_200.5,
  ...extra,
});

const flagOf = async (vehicle: Vehicle) =>
  (await pool.query<{ maintenance_flag: boolean }>('SELECT maintenance_flag FROM fleet.vehicles WHERE id = $1', [vehicle.id])).rows[0].maintenance_flag;

async function auditRows(res: Response) {
  const rows = await pool.query<{ action: string; entity_type: string }>('SELECT action, entity_type FROM audit.audit_logs WHERE correlation_id = $1 ORDER BY id', [
    res.headers['x-request-id'],
  ]);
  return rows.rows.map((r) => `${r.action} ${r.entity_type}`);
}

describe('completing a corrective repair', () => {
  test('without a failure record is 400 failure_required; the repair stays open and the vehicle flagged', async () => {
    const depot = await createDepot();
    const tech = await signIn(['technician'], depot);
    const vehicle = await createVehicle({ depot });
    const id = (await api.post('/maintenance', repair(vehicle), tech)).body.data.id;

    for (const res of [
      await api.put(`/maintenance/${id}`, { completed_at: new Date().toISOString() }, tech),
      await api.put(`/maintenance-records/${id}`, { status: 'completed' }, tech),
      await api.post(`/maintenance-records/${id}/complete`, {}, tech),
    ]) {
      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: 'VALIDATION_FAILED', details: [{ field: 'failures', reason: 'failure_required' }] });
    }
    expect((await api.get(`/maintenance/${id}`, tech)).body.data).toMatchObject({ status: 'open', failures: [] });
    expect(await flagOf(vehicle)).toBe(true);

    // Recorded afterwards, the completion goes through.
    expect((await api.post(`/maintenance-records/${id}/failures`, WORN_PADS, tech)).status).toBe(201);
    expect((await api.post(`/maintenance-records/${id}/complete`, {}, tech)).status).toBe(200);
    expect(await flagOf(vehicle)).toBe(false);
  });

  test('other work needs none; work changed to corrective as it completes does', async () => {
    const depot = await createDepot();
    const tech = await signIn(['technician'], depot);
    const vehicle = await createVehicle({ depot });
    const service = (await api.post('/maintenance', repair(vehicle, { maintenance_type: 'preventive', description: 'Oil change' }), tech)).body.data.id;
    const inspection = (await api.post('/maintenance', repair(vehicle, { maintenance_type: 'inspection' }), tech)).body.data.id;

    const changed = await api.put(`/maintenance/${inspection}`, { maintenance_type: 'corrective', completed_at: new Date().toISOString() }, tech);
    expect(changed.body.error.details).toEqual([{ field: 'failures', reason: 'failure_required' }]);
    expect((await api.put(`/maintenance/${service}`, { completed_at: new Date().toISOString() }, tech)).status).toBe(200);
  });

  test('POST .../complete with failures records them and completes in one transaction, one FailureRecorded each', async () => {
    const depot = await createDepot();
    const tech = await signIn(['technician'], depot);
    const vehicle = await createVehicle({ depot });
    const id = (await api.post('/maintenance', repair(vehicle), tech)).body.data.id;

    const res = await api.post(`/maintenance-records/${id}/complete`, { failures: [WORN_PADS, BURST_HOSE] }, tech);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('completed');
    expect(res.body.data.failures).toHaveLength(2);
    expect(await auditRows(res)).toEqual([
      'INSERT maintenance.failure_events',
      'INSERT maintenance.failure_events',
      'UPDATE maintenance.maintenance_records',
      'UPDATE fleet.vehicles',
    ]);

    const events = await publishedEvents('FailureRecorded');
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.aggregate)).toEqual([`vehicle:${vehicle.public_id}`, `vehicle:${vehicle.public_id}`]);
    expect(events[1].payload).toMatchObject({
      failure_event_id: res.body.data.failures.find((f: { component: string }) => f.component === 'cooling').id,
      vehicle_id: vehicle.public_id,
      maintenance_record_id: id,
      component: 'cooling',
      failure_mode: 'leak',
      unplanned: true,
      detected_by: 'breakdown',
      odometer_km: 84_200.5,
    });
  });

  test('a failure on the completion that is refused is not kept: the request is one transaction', async () => {
    const depot = await createDepot();
    const tech = await signIn(['technician'], depot);
    const vehicle = await createVehicle({ depot });
    const id = (await api.post('/maintenance', repair(vehicle), tech)).body.data.id;
    const res = await api.post(`/maintenance-records/${id}/complete`, { completed_at: new Date(Date.now() + 3_600_000).toISOString(), failures: [WORN_PADS] }, tech);
    expect(res.body.error.details).toEqual([{ field: 'completed_at', reason: 'in_future' }]);
    expect((await api.get(`/maintenance/${id}`, tech)).body.data.failures).toEqual([]);
    expect(await publishedEvents('FailureRecorded')).toEqual([]);
  });
});

describe('recording a failure', () => {
  test('with the repair: defaults to the repair opening and odometer, by the technician; shown on the record', async () => {
    const depot = await createDepot();
    const tech = await signIn(['technician'], depot);
    const vehicle = await createVehicle({ depot });
    const created = await api.post('/maintenance', repair(vehicle, { failures: [WORN_PADS] }), tech);
    expect(created.status).toBe(201);
    const [failure] = created.body.data.failures;
    expect(failure).toMatchObject({
      vehicle_id: vehicle.public_id,
      registration_number: vehicle.registration_number,
      maintenance_record_id: created.body.data.id,
      incident_id: null,
      component: 'brakes',
      failure_mode: 'wear',
      unplanned: false,
      detected_by: 'technician',
      odometer_km: 84_200.5,
      notes: null,
    });
    expect(failure.occurred_at).toBe(created.body.data.created_at);
    expect(failure.recorded_by).toMatch(/^[0-9a-f-]{36}$/);
    expect(await auditRows(created)).toContain('INSERT maintenance.failure_events');
  });

  test('a component or mode outside the catalogue is 400, as is a failure in the future', async () => {
    const depot = await createDepot();
    const tech = await signIn(['technician'], depot);
    const vehicle = await createVehicle({ depot });
    const id = (await api.post('/maintenance', repair(vehicle), tech)).body.data.id;

    const component = await api.post(`/maintenance-records/${id}/failures`, { ...WORN_PADS, component: 'flux_capacitor' }, tech);
    expect(component.status).toBe(400);
    expect(component.body.error.details[0].field).toBe('component');
    const mode = await api.post(`/maintenance-records/${id}/failures`, { ...WORN_PADS, failure_mode: 'gremlins' }, tech);
    expect(mode.body.error.details[0].field).toBe('failure_mode');
    const missing = await api.post(`/maintenance-records/${id}/failures`, { component: 'brakes', failure_mode: 'wear' }, tech);
    expect(missing.body.error.details[0].field).toBe('unplanned');
    const onCreate = await api.post('/maintenance', repair(vehicle, { failures: [{ ...WORN_PADS, component: 'warp_drive' }] }), tech);
    expect(onCreate.body.error.details[0].field).toBe('failures.0.component');
    const future = await api.post(`/maintenance-records/${id}/failures`, { ...WORN_PADS, occurred_at: new Date(Date.now() + 3_600_000).toISOString() }, tech);
    expect(future.body.error.details).toEqual([{ field: 'occurred_at', reason: 'in_future' }]);
    expect((await api.get(`/maintenance/${id}`, tech)).body.data.failures).toEqual([]);
  });

  test("on a completed repair (added later), not a cancelled one; another depot's is 404; a dispatcher cannot", async () => {
    const depot = await createDepot();
    const tech = await signIn(['technician'], depot);
    const vehicle = await createVehicle({ depot });
    const done = (await api.post('/maintenance', repair(vehicle, { maintenance_type: 'preventive', failures: [] }), tech)).body.data.id;
    await api.post(`/maintenance-records/${done}/complete`, {}, tech);
    const cancelled = (await api.post('/maintenance', repair(vehicle), tech)).body.data.id;
    await api.put(`/maintenance-records/${cancelled}`, { status: 'cancelled' }, tech);

    expect((await api.post(`/maintenance-records/${done}/failures`, { ...WORN_PADS, notes: 'Found at the service' }, tech)).status).toBe(201);
    expect((await api.post(`/maintenance-records/${cancelled}/failures`, WORN_PADS, tech)).status).toBe(409);
    expect((await api.post(`/maintenance-records/${done}/failures`, WORN_PADS, await signIn(['technician'], await createDepot()))).status).toBe(404);
    expect((await api.post(`/maintenance-records/${randomUUID()}/failures`, WORN_PADS, tech)).status).toBe(404);
    expect((await api.post(`/maintenance-records/${done}/failures`, WORN_PADS, await signIn(['dispatcher'], depot))).status).toBe(403);
  });

  test("names the incident that reported it: the same vehicle's only", async () => {
    const depot = await createDepot();
    const tech = await signIn(['technician'], depot);
    const vehicle = await createVehicle({ depot });
    const other = await createVehicle({ depot });
    const incident = await api.post('/incidents', { description: 'Steam from the bonnet on the ring road.', severity: 'high', vehicle_id: vehicle.public_id }, tech);
    const elsewhere = await api.post('/incidents', { description: 'Flat tyre at the depot gate.', severity: 'medium', vehicle_id: other.public_id }, tech);
    const id = (await api.post('/maintenance', repair(vehicle), tech)).body.data.id;

    const linked = await api.post(`/maintenance-records/${id}/failures`, { ...BURST_HOSE, incident_id: incident.body.data.id }, tech);
    expect(linked.status).toBe(201);
    expect(linked.body.data.incident_id).toBe(incident.body.data.id);
    const wrong = await api.post(`/maintenance-records/${id}/failures`, { ...BURST_HOSE, incident_id: elsewhere.body.data.id }, tech);
    expect(wrong.body.error.details).toEqual([{ field: 'incident_id', reason: 'incident_other_vehicle' }]);
    const missing = await api.post(`/maintenance-records/${id}/failures`, { ...BURST_HOSE, incident_id: randomUUID() }, tech);
    expect(missing.body.error.details).toEqual([{ field: 'incident_id', reason: 'references_missing_record' }]);
  });
});

describe('GET /failure-events', () => {
  test("a vehicle's failures newest first, in the caller's depots, filtered by component, unplanned and time", async () => {
    const depot = await createDepot();
    const tech = await signIn(['technician'], depot);
    const vehicle = await createVehicle({ depot });
    const id = (await api.post('/maintenance', repair(vehicle), tech)).body.data.id;
    const at = (iso: string) => new Date(iso).toISOString();
    await api.post(`/maintenance-records/${id}/failures`, { ...WORN_PADS, occurred_at: '2026-09-01T08:00:00+03:00' }, tech);
    await api.post(`/maintenance-records/${id}/failures`, { ...BURST_HOSE, occurred_at: '2026-10-01T08:00:00+03:00' }, tech);
    await api.post(`/maintenance-records/${id}/failures`, { ...WORN_PADS, unplanned: true, occurred_at: '2026-09-15T08:00:00+03:00' }, tech);
    const foreign = await createVehicle({ depot: await createDepot() });
    const admin = await signIn(['admin']);
    const foreignId = (await api.post('/maintenance', repair(foreign, { failures: [BURST_HOSE] }), admin)).body.data.id;

    const list = await api.get(`/failure-events?vehicle_id=${vehicle.public_id}`, tech);
    expect(list.status).toBe(200);
    expect(list.body.data.map((f: { occurred_at: string }) => f.occurred_at)).toEqual([
      at('2026-10-01T08:00:00+03:00'),
      at('2026-09-15T08:00:00+03:00'),
      at('2026-09-01T08:00:00+03:00'),
    ]);
    expect(list.body.meta).toMatchObject({ total_items: 3, page: 1 });

    const ids = (res: Response) => res.body.data.map((f: { component: string; unplanned: boolean }) => `${f.component}:${f.unplanned}`);
    expect(ids(await api.get(`/failure-events?vehicle_id=${vehicle.public_id}&component=brakes`, tech))).toEqual(['brakes:true', 'brakes:false']);
    expect(ids(await api.get(`/failure-events?vehicle_id=${vehicle.public_id}&unplanned=true`, tech))).toEqual(['cooling:true', 'brakes:true']);
    // A date is that local day, `to` included.
    expect(ids(await api.get(`/failure-events?vehicle_id=${vehicle.public_id}&from=2026-09-02&to=2026-09-15`, tech))).toEqual(['brakes:true']);

    // Another depot's vehicle is not there; without a vehicle, only the caller's depots.
    expect((await api.get(`/failure-events?vehicle_id=${foreign.public_id}`, tech)).body.data).toEqual([]);
    const mine = await api.get('/failure-events?page_size=100', tech);
    expect(mine.body.data.every((f: { vehicle_id: string }) => f.vehicle_id === vehicle.public_id)).toBe(true);
    const all = await api.get(`/failure-events?vehicle_id=${foreign.public_id}`, admin);
    expect(all.body.data.map((f: { maintenance_record_id: string }) => f.maintenance_record_id)).toEqual([foreignId]);

    expect((await api.get('/failure-events?component=warp_drive', tech)).status).toBe(400);
    expect((await api.get('/failure-events', await signIn(['dispatcher'], depot))).status).toBe(403);
  });
});

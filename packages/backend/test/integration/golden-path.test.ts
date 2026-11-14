// The Golden Path (FMS-63, docs/DEFENCE_NOTES.md): one trip from dispatch to its end, through the HTTP API as each role would
// use it, with the real business rules. A dispatcher plans and assigns a trip; the driver's pre-trip inspection finds a
// brake defect, which flags the van and makes START TRIP refuse; a technician repairs it, which clears the flag; the driver
// drives with the phone as GPS, logs fuel, reports a hazard and ends the trip; the audit log holds the whole story.
import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { hashPassword } from '../../src/modules/auth';
import { deliverEvents } from '../support/events';
import { createDepot, createDriver, createUser, createVehicle, type RoleName } from '../support/factories';

const app = createApp();
const PASSWORD = 'Golden-Path-1';
const HOUR = 60 * 60 * 1000;

type Row = Record<string, unknown> & { id: string; public_id: string };

async function login(email: unknown): Promise<string> {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

const call = (method: 'get' | 'post', path: string, cookie: string, body: object = {}) => {
  const req = request(app)[method](`/api/v1${path}`).set('Cookie', cookie);
  return method === 'get' ? req : req.send(body);
};

const vehicleFlag = async (vehicle: Row) => (await pool.query<{ f: boolean }>('SELECT maintenance_flag AS f FROM fleet.vehicles WHERE id = $1', [vehicle.id])).rows[0].f;

describe('the Golden Path', () => {
  test('dispatch, a failed inspection, the repair, the drive, fuel, a hazard and the end of the trip', async () => {
    // The depot and its people.
    const depot = await createDepot();
    const staff = async (role: RoleName) => login((await createUser({ roles: [role], depot, password: PASSWORD })).email);
    const dispatcher = await staff('dispatcher');
    const technician = await staff('technician');
    const manager = await staff('fleet_manager');
    const vehicle = (await createVehicle({ depot })) as unknown as Row;
    const { user, driver } = await createDriver({ depot, license_categories: ['dry_cargo_2'] });
    await pool.query('UPDATE auth.users SET password_hash = $2 WHERE id = $1', [user.id, await hashPassword(PASSWORD)]);
    const driverCookie = await login(user.email);

    // Step 1. The dispatcher creates a one-off trip and assigns the driver and the van.
    const start = new Date(Date.now() + HOUR);
    const created = await call('post', '/trips', dispatcher, {
      route: { origin_name: 'Addis Ababa Central depot', destination_name: 'Bole International Airport cargo terminal' },
      scheduled_start: start.toISOString(),
      scheduled_end: new Date(start.getTime() + 2 * HOUR).toISOString(),
    });
    expect(created.status).toBe(201);
    const tripId = created.body.data.id as string;
    const assigned = await call('post', `/trips/${tripId}/assign`, dispatcher, { driver_id: driver.public_id, vehicle_id: vehicle.public_id, version: created.body.data.version });
    expect(assigned.status).toBe(200);
    expect(assigned.body.data.status).toBe('assigned');

    // Step 2. The driver's pre-trip inspection finds the brakes.
    expect(await vehicleFlag(vehicle)).toBe(false);
    const inspection = await call('post', '/dvir-reports', driverCookie, {
      vehicle_id: vehicle.public_id,
      trip_id: tripId,
      type: 'pre_trip',
      items: [
        { name: 'Tyres', passed: true },
        { name: 'Lights', passed: true },
        { name: 'Brakes', passed: false, notes: 'Brake pedal goes soft and the van pulls to the left' },
      ],
    });
    expect(inspection.status).toBe(201);
    expect(inspection.body.data.issues_found).toBe(true);

    // Step 3. The van is flagged in the same transaction, and START TRIP is refused.
    expect(await vehicleFlag(vehicle)).toBe(true);
    const refused = await call('post', `/trips/${tripId}/start`, driverCookie);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('CONFLICT_VEHICLE_FLAGGED');

    // Step 4. The technician and the depot's staff are alerted by the inspection itself.
    await deliverEvents();
    const alerts = await pool.query<{ alert_type: string; severity: string; title: string }>('SELECT alert_type, severity, title FROM alert.alerts WHERE vehicle_id = $1', [vehicle.id]);
    expect(alerts.rows.length).toBeGreaterThan(0);
    expect(alerts.rows.some((a) => /defect|fault/i.test(a.title))).toBe(true);

    // Step 5. The technician logs the repair, saying what failed, and completes it: the flag clears.
    const repair = await call('post', '/maintenance', technician, {
      vehicle_id: vehicle.public_id,
      description: 'Replace worn brake pads',
      labour_hours: 2,
      total_cost_cents: 350_000,
      failures: [{ component: 'brakes', failure_mode: 'wear', unplanned: false, detected_by: 'dvir' }],
    });
    expect(repair.status).toBe(201);
    expect(await vehicleFlag(vehicle)).toBe(true);
    const completed = await call('post', `/maintenance-records/${repair.body.data.id}/complete`, technician);
    expect(completed.status).toBe(200);

    // Steps 6 and 7. The van is available again; the trip, the driver and the van are as dispatch left them.
    expect(await vehicleFlag(vehicle)).toBe(false);
    const board = await call('get', `/trips/${tripId}`, dispatcher);
    expect(board.body.data).toMatchObject({ status: 'assigned' });

    // Step 8. The driver starts the trip, and the phone is the van's GPS.
    const started = await call('post', `/trips/${tripId}/start`, driverCookie);
    expect(started.status).toBe(200);
    expect(started.body.data.status).toBe('en_route');
    const ping = await call('post', '/tracking/gps-pings', driverCookie, { pings: [{ recorded_at: new Date().toISOString(), lat: 9.0108, lng: 38.7613, speed_kmh: 38, heading: 90, accuracy_m: 6 }] });
    expect(ping.status).toBe(202);
    expect(ping.body.data.accepted).toBe(1);
    const status = await call('get', `/vehicles/${vehicle.public_id}/status`, dispatcher);
    expect(status.body.data.current_assignment).toMatchObject({ trip_id: tripId, status: 'en_route' });

    // Step 9. On the way: fuel, and a road hazard the dispatcher sees.
    const fuel = await call('post', '/fuel-logs', driverCookie, { vehicle_id: vehicle.public_id, quantity_ml: 45_000, total_cost_cents: 495_000, odometer_km: 12_345 });
    expect(fuel.status).toBe(201);
    const hazard = await call('post', '/incidents', driverCookie, { vehicle_id: vehicle.public_id, severity: 'low', incident_type: 'road_hazard', description: 'Large pothole on the Bole road, lane closed' });
    expect(hazard.status).toBe(201);
    const incidents = await call('get', '/incidents', dispatcher);
    expect((incidents.body.data as { id: string }[]).map((i) => i.id)).toContain(hazard.body.data.id);

    // Step 10. The driver ends the trip.
    const ended = await call('post', `/trips/${tripId}/end`, driverCookie);
    expect(ended.status).toBe(200);
    expect(ended.body.data.status).toBe('completed');

    // The close. Every step is in the audit log, with who did it; the fleet manager sees the trip completed.
    const audit = await pool.query<{ action: string; entity_type: string }>(
      `SELECT DISTINCT action, entity_type FROM audit.audit_logs WHERE entity_type IN ('trip.trips', 'fleet.vehicles', 'maintenance.maintenance_records')`,
    );
    const seen = audit.rows.map((r) => `${r.action} ${r.entity_type}`);
    expect(seen).toEqual(expect.arrayContaining(['UPDATE trip.trips', 'UPDATE fleet.vehicles', 'INSERT maintenance.maintenance_records']));
    expect((await call('get', `/trips/${tripId}`, manager)).body.data.status).toBe('completed');
  });
});

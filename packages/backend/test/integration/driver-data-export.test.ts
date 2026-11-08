import request, { type Response } from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { hashPassword } from '../../src/modules/auth';
import { createDepot, createDriver, createTrip, createUser, createVehicle, type RoleName } from '../support/factories';
import { responseProblems, type Method } from '../support/openapi';

// FMS-104: a person's own data export (docs/driver-data-protection.md).
const app = createApp();

function expectContract(res: Response, method: Method, path: string) {
  const problem = responseProblems(path, method, res.status, res.body);
  if (problem) throw new Error(`${method.toUpperCase()} ${path} -> ${res.status} is not what docs/openapi.yaml says:\n${problem}\nbody: ${JSON.stringify(res.body).slice(0, 600)}`);
}
const PASSWORD = 'Export-Test-1';
const PATH = '/auth/me/data-export';

async function login(email: string): Promise<string> {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}
const download = (cookie: string) => request(app).get(`/api/v1${PATH}`).set('Cookie', cookie);

async function driverWithLogin(depot: { id: string }) {
  const { user, driver } = await createDriver({ depot, license_number: 'ET-LIC-104-A' });
  await pool.query('UPDATE auth.users SET password_hash = $2, phone = $3 WHERE id = $1', [user.id, await hashPassword(PASSWORD), '+251911000104']);
  return { user, driver, cookie: await login(user.email as string) };
}

async function fuelLog(vehicle: Record<string, unknown>, driver: Record<string, unknown>, trip: Record<string, unknown> | null) {
  await pool.query(
    "INSERT INTO fuel.fuel_logs (vehicle_id, driver_id, trip_id, fuel_type, quantity_ml, total_cost_cents, odometer_km, station_name) VALUES ($1, $2, $3, 'diesel', 40000, 340000, 5000, 'Total Bole')",
    [vehicle.id, driver.id, trip?.id ?? null],
  );
}

describe('GET /auth/me/data-export', () => {
  test('a driver gets their account, licence, trips, fuel, incident reports and locations, by public id, and the download is audited', async () => {
    const depot = await createDepot();
    const { user, driver, cookie } = await driverWithLogin(depot);
    const vehicle = await createVehicle({ depot });
    const trip = await createTrip({ vehicle, driver, status: 'completed' });
    await fuelLog(vehicle, driver, trip);
    await pool.query("INSERT INTO alert.incident_reports (vehicle_id, driver_id, trip_id, reported_by, incident_type, severity, description) VALUES ($1, $2, $3, $4, 'minor_collision', 'low', 'Scratched a mirror')", [
      vehicle.id, driver.id, trip.id, user.id,
    ]);
    await pool.query('INSERT INTO tracking.gps_pings (vehicle_id, trip_id, latitude, longitude, speed_kmh, recorded_at) VALUES ($1, $2, 9.01, 38.76, 42, now() - interval \'1 hour\')', [vehicle.id, trip.id]);

    // Another driver's trip and ping on a vehicle of the same depot: not in this export.
    const colleague = await createDriver({ depot });
    const colleagueTrip = await createTrip({ vehicle, driver: colleague.driver, status: 'completed' });
    await pool.query('INSERT INTO tracking.gps_pings (vehicle_id, trip_id, latitude, longitude, speed_kmh) VALUES ($1, $2, 8.5, 39.9, 77)', [vehicle.id, colleagueTrip.id]);

    const res = await download(cookie);
    expect(res.status).toBe(200);
    expectContract(res, 'get', PATH);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="fms-my-data-\d{4}-\d{2}-\d{2}\.json"$/);

    const data = res.body.data;
    expect(data.account).toMatchObject({ id: user.public_id, email: user.email, phone: '+251911000104', roles: ['driver'] });
    expect(data.driver).toMatchObject({ id: driver.public_id, license_number: 'ET-LIC-104-A' });
    expect(data.trips).toEqual([expect.objectContaining({ id: trip.public_id, status: 'completed', vehicle_id: vehicle.public_id, vehicle_registration: vehicle.registration_number })]);
    expect(data.fuel_logs).toEqual([expect.objectContaining({ vehicle_id: vehicle.public_id, trip_id: trip.public_id, station_name: 'Total Bole', quantity_ml: 40000 })]);
    expect(data.incident_reports).toEqual([expect.objectContaining({ description: 'Scratched a mirror', trip_id: trip.public_id })]);
    expect(data.location_history).toMatchObject({ truncated: false, retention_days: 180 });
    expect(data.location_history.points).toEqual([expect.objectContaining({ trip_id: trip.public_id, lat: 9.01, lng: 38.76, speed_kmh: 42 })]);

    // Nothing internal or secret leaves: no password hash, no numeric ids, no internal id fields.
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/password|internalId|internal_id|"driverId"|"vehicleId"|"tripId"/);
    expect(text).not.toContain(String(user.password_hash));

    const audited = await pool.query("SELECT details, user_id FROM audit.audit_logs WHERE action = 'privacy.data_exported' AND correlation_id = $1", [res.headers['x-request-id']]);
    expect(audited.rows).toHaveLength(1);
    expect(String(audited.rows[0].user_id)).toBe(String(user.id));
    expect(audited.rows[0].details).toEqual({ driver: true, trips: 1, fuel_logs: 1, incident_reports: 1, location_points: 1, truncated: false });
  });

  test('only their own: another driver’s trips, fuel and locations are not in it', async () => {
    const depot = await createDepot();
    const mine = await driverWithLogin(depot);
    const theirs = await createDriver({ depot });
    const vehicle = await createVehicle({ depot });
    const theirTrip = await createTrip({ vehicle, driver: theirs.driver, status: 'completed' });
    await fuelLog(vehicle, theirs.driver, theirTrip);
    await pool.query('INSERT INTO tracking.gps_pings (vehicle_id, trip_id, latitude, longitude, speed_kmh) VALUES ($1, $2, 9.5, 39.5, 10)', [vehicle.id, theirTrip.id]);

    const res = await download(mine.cookie);
    expect(res.status).toBe(200);
    expect(res.body.data.trips).toEqual([]);
    expect(res.body.data.fuel_logs).toEqual([]);
    expect(res.body.data.location_history.points).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain(String(theirTrip.public_id));
  });

  test('someone who is not a driver gets their account and no driver section', async () => {
    const depot = await createDepot();
    const user = await createUser({ roles: ['dispatcher' as RoleName], depot, password: PASSWORD });
    const res = await download(await login(user.email as string));
    expect(res.status).toBe(200);
    expectContract(res, 'get', PATH);
    expect(res.body.data.account).toMatchObject({ id: user.public_id, roles: ['dispatcher'] });
    expect(res.body.data.driver).toBeNull();
    expect(res.body.data.trips).toEqual([]);
  });

  test('without signing in it is 401, and there is no way to ask for another person’s', async () => {
    expect((await request(app).get(`/api/v1${PATH}`)).status).toBe(401);
    const depot = await createDepot();
    const { cookie } = await driverWithLogin(depot);
    const other = await createDriver({ depot });
    expect((await request(app).get(`/api/v1${PATH}?user_id=${String(other.user.public_id)}`).set('Cookie', cookie)).body.data.account.id).not.toBe(other.user.public_id);
    expect((await request(app).get(`/api/v1/drivers/${String(other.driver.public_id)}/data-export`).set('Cookie', cookie)).status).toBe(404);
  });
});

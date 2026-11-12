import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { createDepot, createDriver, createUser, createVehicle, type CreateUserOptions } from '../support/factories';

// SE-198: Ethiopian driving licence classes, checked against what the vehicle is: its body, passenger seats and
// gross weight (docs/driving-licences.md). A class that does not cover the vehicle refuses the assignment (BR-8).

const app = createApp();
const PASSWORD = 'Licence-Test-1';

type Depot = Awaited<ReturnType<typeof createDepot>>;
type Row = Record<string, unknown> & { id: string; public_id: string };

async function signIn(roles: CreateUserOptions['roles'], depot: Depot) {
  const user = await createUser({ roles, depot, password: PASSWORD });
  const res = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: PASSWORD });
  expect(res.status).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

/** A scheduled trip of the depot, on its own day so trips never overlap. */
async function scheduled(depot: Depot, day: number) {
  const route = (await pool.query<Row>("INSERT INTO trip.routes (name, depot_id) VALUES ('Route ' || gen_random_uuid(), $1) RETURNING *", [depot.id])).rows[0];
  return (
    await pool.query<Row>(
      "INSERT INTO trip.trips (route_id, status, scheduled_start, scheduled_end) VALUES ($1, 'scheduled', $2::timestamptz, $2::timestamptz + interval '3 hours') RETURNING *",
      [route.id, `2026-12-${String(day).padStart(2, '0')}T06:00:00Z`],
    )
  ).rows[0];
}

async function assign(cookie: string, trip: Row, driver: Row, vehicle: Row) {
  return request(app).post(`/api/v1/trips/${trip.public_id}/assign`).set('Cookie', cookie).send({ driver_id: driver.public_id, vehicle_id: vehicle.public_id, version: 0 });
}

const driverWith = async (depot: Depot, classes: string[]) => (await createDriver({ depot, license_categories: classes })).driver as Row;

describe('Ethiopian licence classes on assignment (SE-198)', () => {
  test('dry cargo by gross weight: a 25 t truck needs dry cargo 3; dry cargo 2 is refused with the reason', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['dispatcher'], depot);
    const truck = (await createVehicle({ depot, body: 'dry_cargo', seats: 1, gross_weight_kg: 25_000 })) as Row;

    const refused = await assign(cookie, await scheduled(depot, 1), await driverWith(depot, ['automobile', 'dry_cargo_2']), truck);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({ code: 'CONFLICT_DRIVER_NOT_ELIGIBLE', details: [{ field: 'driver_id', reason: 'license_category_not_valid_for_vehicle' }] });

    expect((await assign(cookie, await scheduled(depot, 2), await driverWith(depot, ['dry_cargo_3']), truck)).status).toBe(200);
  });

  test('a tanker needs a liquid cargo class, whatever dry cargo grade the driver holds', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['dispatcher'], depot);
    const tanker = (await createVehicle({ depot, body: 'tanker', gross_weight_kg: 16_000 })) as Row;
    expect((await assign(cookie, await scheduled(depot, 3), await driverWith(depot, ['dry_cargo_3']), tanker)).status).toBe(409);
    expect((await assign(cookie, await scheduled(depot, 4), await driverWith(depot, ['liquid_cargo_1']), tanker)).status).toBe(200);
  });

  test('a bus by its seats: public 1 up to 24, public 2 beyond; an automobile licence never drives it', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['dispatcher'], depot);
    const coach = (await createVehicle({ depot, vehicle_type: 'bus', body: 'passenger', seats: 49 })) as Row;
    expect((await assign(cookie, await scheduled(depot, 5), await driverWith(depot, ['automobile', 'public_1']), coach)).status).toBe(409);
    expect((await assign(cookie, await scheduled(depot, 6), await driverWith(depot, ['public_2']), coach)).status).toBe(200);
  });

  test('a vehicle with nothing recorded beyond its type is checked by the type: any dry cargo grade drives a truck', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['dispatcher'], depot);
    const truck = (await createVehicle({ depot })) as Row;
    expect((await assign(cookie, await scheduled(depot, 7), await driverWith(depot, ['dry_cargo_1']), truck)).status).toBe(200);
    expect((await assign(cookie, await scheduled(depot, 8), await driverWith(depot, ['automobile']), truck)).status).toBe(409);
  });

  test('drivers record Ethiopian classes only: a European code is refused', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['depot_admin'], depot);
    const driver = await driverWith(depot, []);
    const ok = await request(app).patch(`/api/v1/drivers/${driver.public_id}`).set('Cookie', cookie).send({ license_categories: ['dry_cargo_3', 'automobile'] });
    expect(ok.status).toBe(200);
    expect(ok.body.data.license_categories).toEqual(['automobile', 'dry_cargo_3']);
    const european = await request(app).patch(`/api/v1/drivers/${driver.public_id}`).set('Cookie', cookie).send({ license_categories: ['CE'] });
    expect(european.status).toBe(400);
    expect(european.body.error).toMatchObject({ code: 'VALIDATION_INVALID_ENUM' });
  });

  test('vehicles record body, seats and gross weight, each optional and checked', async () => {
    const depot = await createDepot();
    const cookie = await signIn(['depot_admin'], depot);
    const body = { registration_number: `AA 3-${Math.floor(Math.random() * 90000) + 10000}`, make: 'Sino', model: 'HOWO 371', vehicle_type: 'truck', fuel_type: 'diesel', fuel_efficiency_ml_per_km: 420, depot_id: depot.public_id };
    for (const bad of [{ body: 'flatbed' }, { seats: -1 }, { seats: 121 }, { seats: 2.5 }, { gross_weight_kg: 0 }, { gross_weight_kg: 100_001 }]) {
      const res = await request(app).post('/api/v1/vehicles').set('Cookie', cookie).send({ ...body, ...bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    const created = await request(app).post('/api/v1/vehicles').set('Cookie', cookie).send({ ...body, body: 'dry_cargo', seats: 1, gross_weight_kg: 25_000 });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ body: 'dry_cargo', seats: 1, gross_weight_kg: 25_000 });
    const cleared = await request(app).patch(`/api/v1/vehicles/${created.body.data.id}`).set('Cookie', cookie).send({ body: null, seats: null, gross_weight_kg: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data).toMatchObject({ body: null, seats: null, gross_weight_kg: null });
  });
});

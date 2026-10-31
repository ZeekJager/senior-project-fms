// FMS-59 (SE-95): data scope, generated from the route registry against a seeded fleet. A depot A user calls every
// route they hold (reads with depot B's ids and filters, writes against depot B's records) and nothing that comes
// back may name a depot B record; a driver, in addition, never sees another driver's records (§24.3). The ids to
// look for are found from the schema (every table with a public id and a depot, vehicle, driver, trip or user
// column), so a table added tomorrow is covered too.
import request from 'supertest';
import { describe, expect, test } from 'vitest';
import { runSeed } from '../../scripts/seed/apply';
import { createApp } from '../../src/app';
import { pool } from '../../src/db';
import { hashPassword } from '../../src/modules/auth';
import { routeRegistry } from '../../src/shared/authz/route-policy';
import { createUser, type RoleName } from '../support/factories';

const app = createApp();
const SEED = { profile: 'small', seed: 20261030, anchor: '2026-10-01', password: 'Scope-Audit-Seed-1' } as const;
const PASSWORD = 'Scope-Audit-1';

/** The roles limited to their home depot (scope.ts DEPOT_UNSCOPED_ROLES are the others). */
const DEPOT_ROLES: RoleName[] = ['dispatcher', 'technician', 'depot_admin', 'finance_clerk'];

/**
 * Path parameters naming a record no depot owns: the same for every caller, by design. Depots are a directory: every
 * signed-in user may read any depot's name and address (api-contract §6.1); `in_scope=true` narrows the list.
 */
const GLOBAL_PARAMS = new Set(['modelId', 'providerId', 'provider', 'depotId']);

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const IS_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Ids = { [K in 'vehicles' | 'drivers' | 'users' | 'trips' | 'routes']: string[] };

/** Internal ids of what belongs to a depot: its vehicles, its drivers and other users, the trips on its routes. */
async function owned(depotId: string): Promise<Ids> {
  const q = async (sql: string) => (await pool.query<{ id: string }>(sql, [depotId])).rows.map((r) => String(r.id));
  return {
    vehicles: await q('SELECT id FROM fleet.vehicles WHERE depot_id = $1'),
    drivers: await q('SELECT d.id FROM fleet.drivers d JOIN auth.users u ON u.id = d.user_id WHERE u.depot_id = $1'),
    users: await q('SELECT id FROM auth.users WHERE depot_id = $1'),
    routes: await q('SELECT id FROM trip.routes WHERE depot_id = $1'),
    trips: await q('SELECT t.id FROM trip.trips t JOIN trip.routes r ON r.id = t.route_id WHERE r.depot_id = $1'),
  };
}

/** Tables with a public id, and the columns among those that say whose a row is. */
async function ownedTables(): Promise<{ table: string; columns: string[] }[]> {
  const res = await pool.query<{ table: string; columns: string[] }>(
    `SELECT c.table_schema || '.' || c.table_name AS table, array_agg(c.column_name::text ORDER BY c.column_name) AS columns
       FROM information_schema.columns c
       JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
      WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema', 'public')
        AND c.column_name IN ('public_id', 'depot_id', 'vehicle_id', 'driver_id', 'trip_id', 'route_id', 'user_id', 'recipient_user_id', 'owner_type', 'owner_id')
      GROUP BY 1
     HAVING bool_or(c.column_name = 'public_id')`,
  );
  return res.rows;
}

/**
 * Every public id (and plate) of a record that belongs to `ids`' owner, by table. A column says whose a row is:
 * depot_id the depot, vehicle_id / driver_id / trip_id / route_id / user_id its owner's, a document its owner's.
 */
async function markers(depotId: string | null, ids: Ids, extra: { driverRows?: boolean } = {}): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const self: Record<string, keyof Ids> = { 'fleet.vehicles': 'vehicles', 'fleet.drivers': 'drivers', 'auth.users': 'users', 'trip.trips': 'trips', 'trip.routes': 'routes' };
  for (const { table, columns } of await ownedTables()) {
    // A driver's own scope: only the rows that name a driver (or are one), not depot-wide ones such as vehicles.
    if (extra.driverRows && !columns.includes('driver_id') && table !== 'fleet.drivers') continue;
    const params: unknown[] = [];
    const p = (value: unknown) => `$${params.push(value)}`;
    const rules: string[] = [];
    const has = (c: string) => columns.includes(c);
    if (has('depot_id') && depotId) rules.push(`depot_id = ${p(depotId)}`);
    if (has('vehicle_id')) rules.push(`vehicle_id = ANY(${p(ids.vehicles)}::bigint[])`);
    if (has('driver_id')) rules.push(`driver_id = ANY(${p(ids.drivers)}::bigint[])`);
    if (has('user_id')) rules.push(`user_id = ANY(${p(ids.users)}::bigint[])`);
    if (has('recipient_user_id')) rules.push(`recipient_user_id = ANY(${p(ids.users)}::bigint[])`);
    if (has('trip_id')) rules.push(`trip_id = ANY(${p(ids.trips)}::bigint[])`);
    if (has('route_id')) rules.push(`route_id = ANY(${p(ids.routes)}::bigint[])`);
    if (has('owner_type') && has('owner_id')) {
      rules.push(`(owner_type = 'vehicle' AND owner_id = ANY(${p(ids.vehicles)}::bigint[])) OR (owner_type = 'driver' AND owner_id = ANY(${p(ids.drivers)}::bigint[]))`);
    }
    if (self[table]) rules.push(`id = ANY(${p(ids[self[table]])}::bigint[])`);
    if (rules.length === 0) continue;
    const res = await pool.query<{ public_id: string }>(`SELECT public_id::text FROM ${table} WHERE ${rules.join(' OR ')}`, params);
    for (const r of res.rows) found.set(r.public_id, table);
  }
  if (depotId && !extra.driverRows) {
    const plates = await pool.query<{ registration_number: string }>('SELECT registration_number FROM fleet.vehicles WHERE id = ANY($1::bigint[])', [ids.vehicles]);
    for (const r of plates.rows) found.set(r.registration_number, 'fleet.vehicles (plate)');
  }
  return found;
}

/** What the small seed leaves out of a depot: its own spare part, a prediction, an alert, an incident, a notification, a service program. */
async function fillGaps(depotId: string, ids: Ids): Promise<void> {
  const none = async (sql: string, params: unknown[]) => (await pool.query(`SELECT 1 FROM ${sql} LIMIT 1`, params)).rowCount === 0;
  const [vehicle, user] = [ids.vehicles[0], ids.users[0]];
  if (await none('maintenance.inventory_parts WHERE depot_id = $1', [depotId])) {
    await pool.query("INSERT INTO maintenance.inventory_parts (depot_id, part_number, name, unit_cost_cents, stock_quantity) VALUES ($1, 'SCOPE-B-1', 'Depot B filter', 1000, 3)", [depotId]);
  }
  if (await none('maintenance.maintenance_predictions WHERE vehicle_id = ANY($1::bigint[])', [ids.vehicles])) {
    await pool.query(
      `INSERT INTO maintenance.ml_models (name, version, algorithm, features, feature_spec_version, feature_spec_hash, metrics, training_data, trained_at, artefact_sha256)
       VALUES ('scope-audit', '1.0.0', 'RandomForestClassifier', '["mileage_km"]', 2, $1, '{}', '{}', now(), $1)`,
      ['a'.repeat(64)],
    );
    await pool.query(
      `INSERT INTO maintenance.maintenance_predictions (vehicle_id, model_name, model_version, prediction_type, risk_score, prediction_horizon_days, health_score, risk_level, factors, as_of, generated_at, status)
       VALUES ($1, 'scope-audit', '1.0.0', 'failure_within_30_days', 0.8, 30, 40, 'high', '[]', now(), now(), 'active')`,
      [vehicle],
    );
  }
  if (await none('alert.alerts WHERE depot_id = $1', [depotId])) {
    await pool.query("INSERT INTO alert.alerts (alert_type, severity, status, source_module, title, depot_id, vehicle_id) VALUES ('vehicle_fault', 'high', 'open', 'fleet', 'Depot B fault', $1, $2)", [depotId, vehicle]);
  }
  if (await none('alert.incident_reports WHERE depot_id = $1', [depotId])) {
    await pool.query("INSERT INTO alert.incident_reports (reported_by, description, severity, depot_id, vehicle_id) VALUES ($1, 'Depot B incident', 'medium', $2, $3)", [user, depotId, vehicle]);
  }
  if (await none('fuel.fuel_anomalies WHERE vehicle_id = ANY($1::bigint[])', [ids.vehicles])) {
    await pool.query(
      `INSERT INTO fuel.fuel_anomalies (vehicle_id, anomaly_type, severity, status, period_start, period_end, distance_km, expected_ml, actual_ml,
                                        expected_consumption_ml_100km, actual_consumption_ml_100km, deviation_percentage, detected_at)
       VALUES ($1, 'consumption_above_expected', 'medium', 'open', '2026-09-01T00:00:00+03:00', '2026-10-01T00:00:00+03:00', 1000, 320000, 400000, 32000, 40000, 25, now())`,
      [vehicle],
    );
  }
  if (await none('maintenance.service_programs WHERE depot_id = $1', [depotId])) {
    await pool.query("INSERT INTO maintenance.service_programs (depot_id, name, interval_km, lead_km) VALUES ($1, 'Depot B service', 10000, 1000)", [depotId]);
  }
  if (await none('alert.notifications WHERE recipient_user_id = ANY($1::bigint[])', [ids.users])) {
    await pool.query("INSERT INTO alert.notifications (recipient_user_id, notification_type, title, message, channel, status) VALUES ($1, 'alert', 'Depot B', 'For depot B', 'in_app', 'delivered')", [user]);
  }
}

/** One record of depot B per path parameter, so a route is called on something the caller must not reach. */
async function samples(depotId: string, ids: Ids): Promise<Record<string, string | undefined>> {
  const one = async (sql: string, params: unknown[]) => (await pool.query<{ id: string }>(`${sql} LIMIT 1`, params)).rows[0]?.id;
  const byVehicle = (table: string) => one(`SELECT public_id::text AS id FROM ${table} WHERE vehicle_id = ANY($1::bigint[]) ORDER BY id`, [ids.vehicles]);
  return {
    depotId: await one('SELECT public_id::text AS id FROM fleet.depots WHERE id = $1', [depotId]),
    vehicleId: await one('SELECT public_id::text AS id FROM fleet.vehicles WHERE id = ANY($1::bigint[]) ORDER BY id', [ids.vehicles]),
    driverId: await one('SELECT public_id::text AS id FROM fleet.drivers WHERE id = ANY($1::bigint[]) ORDER BY id', [ids.drivers]),
    userId: await one('SELECT public_id::text AS id FROM auth.users WHERE id = ANY($1::bigint[]) ORDER BY id', [ids.users]),
    routeId: await one('SELECT public_id::text AS id FROM trip.routes WHERE id = ANY($1::bigint[]) ORDER BY id', [ids.routes]),
    tripId: await one('SELECT public_id::text AS id FROM trip.trips WHERE id = ANY($1::bigint[]) ORDER BY id', [ids.trips]),
    attendanceId: await one('SELECT public_id::text AS id FROM fleet.driver_attendance WHERE driver_id = ANY($1::bigint[]) ORDER BY id', [ids.drivers]),
    documentId: await one("SELECT public_id::text AS id FROM document.documents WHERE owner_type = 'vehicle' AND owner_id = ANY($1::bigint[]) ORDER BY id", [ids.vehicles]),
    fuelLogId: await byVehicle('fuel.fuel_logs'),
    anomalyId: await byVehicle('fuel.fuel_anomalies'),
    recordId: await byVehicle('maintenance.maintenance_records'),
    predictionId: await byVehicle('maintenance.maintenance_predictions'),
    partId: await one('SELECT public_id::text AS id FROM maintenance.inventory_parts WHERE depot_id = $1 ORDER BY id', [depotId]),
    alertId: await one('SELECT public_id::text AS id FROM alert.alerts WHERE depot_id = $1 ORDER BY id', [depotId]),
    incidentId: await one('SELECT public_id::text AS id FROM alert.incident_reports WHERE depot_id = $1 ORDER BY id', [depotId]),
    notificationId: await one('SELECT public_id::text AS id FROM alert.notifications WHERE recipient_user_id = ANY($1::bigint[]) ORDER BY id', [ids.users]),
    programId: await one('SELECT public_id::text AS id FROM maintenance.service_programs WHERE depot_id = $1 ORDER BY id', [depotId]),
  };
}

async function login(email: string, password: string): Promise<string> {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
  expect(res.status, `${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
}

const permissionsOf = async (email: string) =>
  new Set(
    (
      await pool.query<{ code: string }>(
        `SELECT DISTINCT p.code FROM auth.users u JOIN auth.user_roles ur ON ur.user_id = u.id
           JOIN auth.role_permissions rp ON rp.role_id = ur.role_id JOIN auth.permissions p ON p.id = rp.permission_id WHERE u.email = $1`,
        [email],
      )
    ).rows.map((r) => r.code),
  );

const endpoints = routeRegistry(app)
  .filter((r) => !r.policies.some((p) => p.kind === 'public'))
  .map((r) => ({ ...r, needs: r.policies.flatMap((p) => (p.kind === 'permission' ? [p.codes] : [])), params: [...r.path.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]) }));
type Endpoint = (typeof endpoints)[number];

/** Filters that would ask for depot B outright; a route that does not know one answers 400, which is fine. */
const probes = (s: Record<string, string | undefined>) => ['', `?depot_id=${s.depotId}`, `?vehicle_id=${s.vehicleId}`, `?driver_id=${s.driverId}`, `?trip_id=${s.tripId}`];

/**
 * Calls every route `cookie` may call: reads plain and with depot B's filters, and every route with a path parameter
 * on depot B's record. Returns what leaked: a 2xx on another's record, or a forbidden id or plate in any answer.
 */
async function sweep(who: string, cookie: string, grants: Set<string>, forbidden: Map<string, string>, sample: Record<string, string | undefined>, options = { lists: true }) {
  const leaks: string[] = [];
  const unsampled = new Set<string>();
  const plates = [...forbidden.keys()].filter((k) => !IS_UUID.test(k));
  const scan = (label: string, text: string, asked: string[]) => {
    for (const id of text.match(UUID) ?? []) {
      if (forbidden.has(id) && !asked.includes(id)) leaks.push(`${label}: ${forbidden.get(id)} ${id}`);
    }
    for (const plate of plates) if (text.includes(`"${plate}"`)) leaks.push(`${label}: ${forbidden.get(plate)} ${plate}`);
  };
  const holds = (e: Endpoint) => e.needs.every((set) => set.some((code) => grants.has(code)));
  for (const e of endpoints.filter(holds)) {
    const method = e.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
    const send = (path: string) => {
      const req = request(app)[method](path).set('Cookie', cookie);
      return method === 'get' || method === 'delete' ? req : req.send({});
    };
    if (e.params.length === 0) {
      for (const query of method === 'get' && options.lists ? probes(sample) : []) {
        const res = await send(`${e.path}${query}`);
        scan(`${who} GET ${e.path}${query} ${res.status}`, res.text, []);
      }
      continue;
    }
    if (e.params.some((p) => GLOBAL_PARAMS.has(p))) continue;
    const missing = e.params.filter((p) => !sample[p]);
    if (missing.length) {
      missing.forEach((p) => unsampled.add(p));
      continue;
    }
    const asked = e.params.map((p) => sample[p]!);
    const path = e.path.replace(/:([A-Za-z]+)/g, (_, p: string) => sample[p]!);
    const res = await send(path);
    const label = `${who} ${e.method} ${e.path} ${res.status}`;
    if (res.status < 400) leaks.push(`${label}: answered for another's ${e.params.join(', ')}`);
    scan(label, res.text, asked);
  }
  return { leaks, unsampled: [...unsampled] };
}

describe('data scope across every route (FMS-59)', () => {
  test("a depot A user never receives depot B's data, and a driver never another driver's", { timeout: 300_000 }, async () => {
    await runSeed(SEED);
    const depots = await pool.query<{ depot_id: string }>('SELECT depot_id FROM fleet.vehicles GROUP BY depot_id ORDER BY count(*) DESC, depot_id LIMIT 2');
    const [a, b] = depots.rows.map((r) => String(r.depot_id));
    const ownedByB = await owned(b);
    await fillGaps(b, ownedByB);
    const forbiddenB = await markers(b, ownedByB);
    const sampleB = await samples(b, ownedByB);
    const sampleA = await samples(a, await owned(a));

    // The sweep is only as good as what it looks for: depot B has records in every part of the API.
    const tables = new Set(forbiddenB.values());
    for (const t of ['fleet.vehicles', 'fleet.drivers', 'auth.users', 'trip.trips', 'trip.routes', 'fuel.fuel_logs', 'maintenance.maintenance_records', 'maintenance.maintenance_predictions', 'maintenance.inventory_parts', 'document.documents', 'fleet.driver_attendance', 'fleet.meter_readings', 'alert.alerts', 'alert.incident_reports', 'alert.notifications']) {
      expect(tables, t).toContain(t);
    }

    const leaks: string[] = [];
    const unsampled = new Set<string>();
    const depotA = { id: a };
    for (const role of DEPOT_ROLES) {
      const user = await createUser({ roles: [role], depot: depotA, password: PASSWORD });
      const cookie = await login(String(user.email), PASSWORD);
      // Not vacuous: the same user does see depot A's fleet. And the depot pickers' list is their depot alone.
      if (role === 'dispatcher') {
        const own = await request(app).get('/api/v1/vehicles').set('Cookie', cookie);
        expect(own.body.data.length).toBeGreaterThan(0);
        const pickers = await request(app).get('/api/v1/depots?in_scope=true').set('Cookie', cookie);
        expect(pickers.body.data.map((d: { id: string }) => d.id)).toEqual([sampleA.depotId]);
      }
      const result = await sweep(role, cookie, await permissionsOf(String(user.email)), forbiddenB, sampleB);
      leaks.push(...result.leaks);
      result.unsampled.forEach((p) => unsampled.add(p));
    }

    // A driver of depot A with trips: depot B is out of reach, and so is every other driver's record in depot A.
    const driver = await pool.query<{ user_id: string; driver_id: string; email: string }>(
      `SELECT u.id AS user_id, d.id AS driver_id, u.email FROM fleet.drivers d JOIN auth.users u ON u.id = d.user_id
        WHERE u.depot_id = $1 AND EXISTS (SELECT 1 FROM trip.trips t WHERE t.driver_id = d.id) ORDER BY d.id LIMIT 1`,
      [a],
    );
    const me = driver.rows[0];
    await pool.query('UPDATE auth.users SET password_hash = $1 WHERE id = $2', [await hashPassword(PASSWORD), me.user_id]);
    const ownedByA = await owned(a);
    const others: Ids = { ...ownedByA, vehicles: [], routes: [], drivers: ownedByA.drivers.filter((d) => d !== String(me.driver_id)), users: ownedByA.users.filter((u) => u !== String(me.user_id)) };
    others.trips = (await pool.query<{ id: string }>('SELECT id FROM trip.trips WHERE driver_id = ANY($1::bigint[])', [others.drivers])).rows.map((r) => String(r.id));
    const forbiddenToDriver = new Map([...forbiddenB, ...(await markers(null, others, { driverRows: true }))]);
    expect([...forbiddenToDriver.values()]).toContain('trip.trips');
    const driverCookie = await login(me.email, PASSWORD);
    const driverResult = await sweep('driver', driverCookie, await permissionsOf(me.email), forbiddenToDriver, sampleB);
    leaks.push(...driverResult.leaks);
    // And another driver's own records in depot A, by id.
    const sampleOther = await samples(a, others);
    const otherDriverResult = await sweep('driver (another driver of A)', driverCookie, await permissionsOf(me.email), forbiddenToDriver, {
      driverId: sampleOther.driverId,
      tripId: sampleOther.tripId,
      attendanceId: sampleOther.attendanceId,
      fuelLogId: (await pool.query<{ id: string }>('SELECT public_id::text AS id FROM fuel.fuel_logs WHERE driver_id = ANY($1::bigint[]) LIMIT 1', [others.drivers])).rows[0]?.id,
    }, { lists: false });
    leaks.push(...otherDriverResult.leaks);

    expect(leaks).toEqual([]);
    // Every depot-owned parameter was tried on a real depot B record.
    expect([...unsampled].sort()).toEqual([]);
  });
});

import { randomUUID } from 'node:crypto';
import { config } from '../../src/config';
import { pool } from '../../src/db';
import { hashPassword } from '../../src/modules/auth';
import { auditedMutation, type MutationContext } from '../../src/shared/infrastructure/audited-mutation';
import { withTransaction } from '../../src/shared/infrastructure/transaction';
import { SeedApi } from './api-client';
import { fingerprint } from './fingerprint';
import { assertNotProduction } from './guard';
import { buildPlan, type ProfileName, type SeedPlan } from './plan';

export interface SeedOptions {
  profile: ProfileName;
  seed: number;
  /** YYYY-MM-DD: "today" for the dataset. Dates are relative to it, so the same seed and anchor give the same data. */
  anchor: string;
  /** Password of every account that can sign in (the seed admin and one user per role). */
  password: string;
  log?: (line: string) => void;
}

export interface SeedSummary {
  counts: Record<string, number>;
  /** SHA-256 of the business content: equal across runs with the same seed and anchor. */
  fingerprint: string;
  logins: { role: string; email: string }[];
}

/** The account the seed signs in with; created directly, like `npm run user:create`, because the API needs a first admin. */
export const SEED_ADMIN_EMAIL = 'seed.admin@fleet.demo';

const TIMEZONE = 'Africa/Addis_Ababa';

/**
 * Writes the plan for (profile, seed, anchor). Everything with an API goes
 * through it; trips, routes and fuel logs have no API yet (their cards come
 * later), so they are inserted with auditedMutation, which audits each row
 * like the services do. Refuses a database that already holds data: reset
 * first (`--reset`), so a run always starts from the same state.
 */
export async function runSeed(options: SeedOptions): Promise<SeedSummary> {
  assertNotProduction({ NODE_ENV: config.nodeEnv });
  const log = options.log ?? (() => {});
  const plan = buildPlan(options.profile, options.seed, options.anchor);

  const existing = await pool.query<{ users: number; vehicles: number }>(
    'SELECT (SELECT count(*) FROM auth.users)::int AS users, (SELECT count(*) FROM fleet.vehicles)::int AS vehicles',
  );
  if (existing.rows[0].users > 0 || existing.rows[0].vehicles > 0) {
    throw new Error(`The database already holds data (${existing.rows[0].users} users, ${existing.rows[0].vehicles} vehicles). Run with --reset to rebuild it first.`);
  }

  const admin = await withTransaction(pool, async (client) => {
    const user = await auditedMutation(client, { userId: null, correlationId: randomUUID() }, 'auth.users', 'INSERT', null, {
      email: SEED_ADMIN_EMAIL,
      password_hash: await hashPassword(options.password),
      full_name: 'Seed Administrator',
    });
    await client.query("INSERT INTO auth.user_roles (user_id, role_id) SELECT $1, id FROM auth.roles WHERE name = 'admin'", [user.id]);
    return user;
  });

  const api = await SeedApi.start();
  try {
    await api.signIn(SEED_ADMIN_EMAIL, options.password);
    const ids = await writeThroughApi(api, plan, options.password, log);
    await writeDirect(plan, ids, { userId: String(admin.id), correlationId: randomUUID() }, log);
  } finally {
    await api.close();
  }

  const counts = await countRows();
  const logins = [{ role: 'admin', email: SEED_ADMIN_EMAIL }, ...plan.staff.filter((s, i) => plan.staff.findIndex((x) => x.role === s.role) === i).map((s) => ({ role: s.role, email: s.email })), { role: 'driver', email: plan.drivers[0].email }];
  return { counts, fingerprint: await fingerprint(pool), logins };
}

interface PublicIds {
  depots: string[];
  vehicles: string[];
  drivers: string[];
}

async function writeThroughApi(api: SeedApi, plan: SeedPlan, password: string, log: (line: string) => void): Promise<PublicIds> {
  const depots: string[] = [];
  for (const d of plan.depots) {
    const { data } = await api.post<{ id: string }>('/depots', {
      name: d.name,
      code: d.code,
      location: d.city,
      city: d.city,
      country: 'Ethiopia',
      timezone: TIMEZONE,
      latitude: d.latitude,
      longitude: d.longitude,
      capacity: d.capacity,
    });
    depots.push(data.id);
  }
  log(`depots: ${depots.length}`);

  // One account per role signs in with the seed password: the invitation
  // link POST /users returns is used here as the person would.
  const signedUp = new Set<string>();
  for (const s of plan.staff) {
    const { meta } = await api.post('/users', {
      email: s.email,
      full_name: s.full_name,
      phone: s.phone,
      depot_id: s.depot === null ? null : depots[s.depot],
      roles: [s.role],
    });
    if (!signedUp.has(s.role)) {
      const setup = meta.password_setup as { token: string };
      await api.post('/auth/password', { token: setup.token, password });
      signedUp.add(s.role);
    }
  }
  log(`staff accounts: ${plan.staff.length}`);

  const vehicles: string[] = [];
  for (const v of plan.vehicles) {
    const { data } = await api.post<{ id: string }>('/vehicles', {
      registration_number: v.registration_number,
      vin: v.vin,
      make: v.make,
      model: v.model,
      year: v.year,
      vehicle_type: v.vehicle_type,
      fuel_type: v.fuel_type,
      fuel_efficiency_ml_per_km: v.fuel_efficiency_ml_per_km,
      depot_id: depots[v.depot],
      odometer_km: v.odometer_km,
    });
    vehicles.push(data.id);
  }
  log(`vehicles: ${vehicles.length}`);

  const drivers: string[] = [];
  for (const [i, d] of plan.drivers.entries()) {
    const { data } = await api.post<{ id: string; user_id: string }>('/drivers', {
      account: { full_name: d.full_name, email: d.email, phone: d.phone },
      depot_id: depots[d.depot],
      license_number: d.license_number,
      license_categories: d.license_categories,
      license_expiry: d.license_expiry,
      hire_date: d.hire_date,
      emergency_phone: d.emergency_phone,
    });
    drivers.push(data.id);
    // The first driver signs in too (the driver portal); the rest are invited.
    if (i === 0) {
      const { data: link } = await api.post<{ token: string }>(`/users/${data.user_id}/password-reset`, {});
      await api.post('/auth/password', { token: link.token, password });
    }
  }
  log(`drivers: ${drivers.length}`);

  const parts: string[] = [];
  for (const p of plan.parts) {
    const { data } = await api.post<{ id: string }>('/inventory', {
      part_number: p.part_number,
      name: p.name,
      unit_cost_cents: p.unit_cost_cents,
      stock_quantity: p.stock_quantity,
      reorder_threshold: p.reorder_threshold,
    });
    parts.push(data.id);
  }
  log(`spare parts: ${parts.length}`);

  for (const m of plan.maintenance) {
    const { data } = await api.post<{ id: string }>('/maintenance', {
      vehicle_id: vehicles[m.vehicle],
      description: m.description,
      maintenance_type: m.maintenance_type,
      // Past work is recorded as open, then completed on its date: created
      // in progress it would carry today as its start, and the API rightly
      // refuses a completion before the start.
      status: m.status === 'completed' ? 'open' : m.status,
      priority: m.priority,
      labour_hours: m.labour_hours,
      total_cost_cents: m.total_cost_cents,
      parts: m.parts.map((u) => ({ part_id: parts[u.part], quantity: u.quantity, unit_cost_cents: plan.parts[u.part].unit_cost_cents })),
      scheduled_at: m.scheduled_at,
      odometer_km: m.odometer_km,
      workshop: m.workshop,
    });
    if (m.completed_at) await api.patch(`/maintenance/${data.id}`, { completed_at: m.completed_at });
  }
  log(`maintenance records: ${plan.maintenance.length}`);

  for (const a of plan.attendance) {
    await api.post('/attendance', { driver_id: drivers[a.driver], date: a.date, status: a.status });
  }
  log(`attendance records: ${plan.attendance.length}`);

  return { depots, vehicles, drivers };
}

/** Internal ids for public ids, in the same order. */
async function internalIds(table: string, publicIds: string[]): Promise<string[]> {
  const res = await pool.query<{ id: string; public_id: string }>(`SELECT id, public_id FROM ${table} WHERE public_id = ANY($1::uuid[])`, [publicIds]);
  const byPublic = new Map(res.rows.map((r) => [r.public_id, r.id]));
  return publicIds.map((p) => byPublic.get(p)!);
}

async function writeDirect(plan: SeedPlan, ids: PublicIds, ctx: MutationContext, log: (line: string) => void): Promise<void> {
  const depots = await internalIds('fleet.depots', ids.depots);
  const vehicles = await internalIds('fleet.vehicles', ids.vehicles);
  const drivers = await internalIds('fleet.drivers', ids.drivers);

  await withTransaction(pool, async (client) => {
    const routes: string[] = [];
    for (const r of plan.routes) {
      const row = await auditedMutation(client, ctx, 'trip.routes', 'INSERT', null, {
        name: r.name,
        depot_id: depots[r.depot],
        origin_name: r.origin.city,
        destination_name: r.destination.city,
        origin_latitude: r.origin.latitude,
        origin_longitude: r.origin.longitude,
        destination_latitude: r.destination.latitude,
        destination_longitude: r.destination.longitude,
        distance_km: r.distance_km,
        estimated_duration_seconds: r.duration_seconds,
      });
      routes.push(String(row.id));
    }
    log(`routes: ${routes.length}`);

    const trips: string[] = [];
    for (const t of plan.trips) {
      const route = plan.routes[t.route];
      const row = await auditedMutation(client, ctx, 'trip.trips', 'INSERT', null, {
        route_id: routes[t.route],
        vehicle_id: t.vehicle === null ? null : vehicles[t.vehicle],
        driver_id: t.driver === null ? null : drivers[t.driver],
        status: t.status,
        origin: route.origin.city,
        destination: route.destination.city,
        scheduled_start: t.scheduled_start,
        scheduled_end: t.scheduled_end,
        actual_start: t.actual_start,
        actual_end: t.actual_end,
        planned_distance_km: t.planned_distance_km,
        actual_distance_km: t.actual_distance_km,
        planned_duration_seconds: t.planned_duration_seconds,
        actual_duration_seconds: t.actual_duration_seconds,
      });
      trips.push(String(row.id));
    }
    log(`trips: ${trips.length}`);

    for (const f of plan.fuelLogs) {
      await auditedMutation(client, ctx, 'fuel.fuel_logs', 'INSERT', null, {
        vehicle_id: vehicles[f.vehicle],
        driver_id: drivers[f.driver],
        trip_id: trips[f.trip],
        fuel_type: f.fuel_type,
        quantity_ml: f.quantity_ml,
        unit_price_cents: f.unit_price_cents,
        total_cost_cents: f.total_cost_cents,
        odometer_km: f.odometer_km,
        latitude: f.latitude,
        longitude: f.longitude,
        station_name: f.station_name,
        source: f.source,
        recorded_at: f.recorded_at,
      });
    }
    log(`fuel logs: ${plan.fuelLogs.length}`);
  });
}

async function countRows(): Promise<Record<string, number>> {
  const res = await pool.query<Record<string, number>>(`
    SELECT (SELECT count(*) FROM fleet.depots)::int AS depots,
           (SELECT count(*) FROM auth.users)::int AS users,
           (SELECT count(DISTINCT r.name) FROM auth.user_roles ur JOIN auth.roles r ON r.id = ur.role_id)::int AS roles_held,
           (SELECT count(*) FROM fleet.vehicles)::int AS vehicles,
           (SELECT count(*) FROM fleet.vehicles WHERE fuel_type = 'electric')::int AS electric_vehicles,
           (SELECT count(*) FROM fleet.drivers)::int AS drivers,
           (SELECT count(*) FROM trip.routes)::int AS routes,
           (SELECT count(*) FROM trip.trips)::int AS trips,
           (SELECT count(DISTINCT status) FROM trip.trips)::int AS trip_statuses,
           (SELECT count(*) FROM fuel.fuel_logs)::int AS fuel_logs,
           (SELECT count(*) FROM maintenance.maintenance_records)::int AS maintenance_records,
           (SELECT count(*) FROM maintenance.inventory_parts)::int AS spare_parts,
           (SELECT count(*) FROM fleet.driver_attendance)::int AS attendance`);
  return res.rows[0];
}

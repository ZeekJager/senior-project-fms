/**
 * GPS simulator (FMS-88): drives N vehicles along their depots' seeded routes (on their roads, FMS-84) and posts each one's
 * position every interval to the running API, as its own device would. For the demo, the live map
 * (FMS-45) and the load target of FMS-61 (200 vehicles every 10 s).
 *
 *   npm run simulate:gps                                  # 200 vehicles, every 10 s, for 60 s
 *   npm run simulate:gps -- --vehicles 50 --interval 5 --duration 0     # until Ctrl+C
 *   npm run simulate:gps -- --speeding 0.2 --idling 0.1 --api http://localhost:3000/api/v1
 *
 * Each vehicle gets a simulated device (`sim-<vehicle id>`) and a fresh token, so it can only report for
 * itself. That takes the place of a device already installed in the vehicle: never run it against
 * production (it refuses NODE_ENV=production). It reads vehicles and routes from the database the API
 * uses (the same .env), and ends by checking each vehicle's current location moved.
 */
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { config } from '../src/config';
import { pool } from '../src/db';
import { gpsDevices } from '../src/modules/integration';
import { closeRedis } from '../src/shared/cache';
import { loopAround, pathLength, scenarioFor, step, type Point, type VehicleState } from './simulator/motion';

interface SimVehicle {
  id: string;
  publicId: string;
  plate: string;
  token: string;
  state: VehicleState;
}

const ADDIS: Point = { lat: 9.0108, lng: 38.7613 };

function options() {
  const { values } = parseArgs({
    options: {
      vehicles: { type: 'string', default: '200' },
      interval: { type: 'string', default: '10' },
      duration: { type: 'string', default: '60' },
      speeding: { type: 'string', default: '0.1' },
      idling: { type: 'string', default: '0.1' },
      api: { type: 'string', default: `http://localhost:${config.port}/api/v1` },
    },
  });
  const num = (name: keyof typeof values, min: number, max: number) => {
    const n = Number(values[name]);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`--${name} must be between ${min} and ${max}`);
    return n;
  };
  return {
    vehicles: num('vehicles', 1, 5000),
    intervalS: num('interval', 1, 3600),
    durationS: num('duration', 0, 86_400),
    shares: { speeding: num('speeding', 0, 1), idling: num('idling', 0, 1) },
    api: String(values.api).replace(/\/+$/, ''),
  };
}

/**
 * Each route's path: its road when it has been measured (FMS-84), so vehicles keep to the roads; otherwise
 * origin, the stops that have coordinates, destination, in straight lines.
 */
async function routesByDepot(): Promise<Map<string, Point[][]>> {
  const res = await pool.query<{
    depot_id: string;
    olat: number;
    olng: number;
    dlat: number;
    dlng: number;
    stops: { latitude?: number; longitude?: number }[];
    road: { coordinates: [number, number][] } | null;
  }>(
    `SELECT depot_id, origin_latitude::float8 AS olat, origin_longitude::float8 AS olng,
            destination_latitude::float8 AS dlat, destination_longitude::float8 AS dlng, stops, geometry AS road
       FROM trip.routes
      WHERE is_active AND origin_latitude IS NOT NULL AND destination_latitude IS NOT NULL`,
  );
  const byDepot = new Map<string, Point[][]>();
  for (const r of res.rows) {
    const stops = (r.stops ?? []).flatMap((s) => (typeof s.latitude === 'number' && typeof s.longitude === 'number' ? [{ lat: s.latitude, lng: s.longitude }] : []));
    const path = r.road ? r.road.coordinates.map(([lng, lat]) => ({ lat, lng })) : [{ lat: r.olat, lng: r.olng }, ...stops, { lat: r.dlat, lng: r.dlng }];
    if (pathLength(path) > 0) byDepot.set(r.depot_id, [...(byDepot.get(r.depot_id) ?? []), path]);
  }
  return byDepot;
}

async function setUp(opts: ReturnType<typeof options>): Promise<SimVehicle[]> {
  const res = await pool.query<{ id: string; public_id: string; registration_number: string; depot_id: string; lat: number | null; lng: number | null }>(
    `SELECT v.id, v.public_id, v.registration_number, v.depot_id, d.latitude::float8 AS lat, d.longitude::float8 AS lng
       FROM fleet.vehicles v LEFT JOIN fleet.depots d ON d.id = v.depot_id
      WHERE v.is_active ORDER BY v.id LIMIT $1`,
    [opts.vehicles],
  );
  if (res.rows.length < opts.vehicles) console.warn(`! Only ${res.rows.length} active vehicles (asked for ${opts.vehicles}); seed more with SIZE=budget.`);
  const routes = await routesByDepot();
  const anyRoutes = [...routes.values()].flat();
  const ctx = { userId: null, correlationId: randomUUID() };
  const sims: SimVehicle[] = [];
  for (const [i, v] of res.rows.entries()) {
    const own = routes.get(v.depot_id) ?? anyRoutes;
    const path = own.length > 0 ? own[i % own.length] : loopAround(v.lat !== null && v.lng !== null ? { lat: v.lat, lng: v.lng } : ADDIS);
    const { token } = await gpsDevices.register({ vehicleId: v.public_id, identifier: `sim-${v.public_id}`, model: 'FMS GPS simulator' }, ctx);
    sims.push({
      id: v.id,
      publicId: v.public_id,
      plate: v.registration_number,
      token,
      state: { path, at: Math.random() * pathLength(path), direction: 1, scenario: scenarioFor(i, res.rows.length, opts.shares) },
    });
  }
  return sims;
}

const percentile = (sorted: number[], p: number) => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]);

async function main(): Promise<void> {
  if (config.nodeEnv === 'production') throw new Error('The simulator replaces vehicles\' devices: it does not run with NODE_ENV=production.');
  const opts = options();
  console.log(`Setting up ${opts.vehicles} vehicles (devices and routes)...`);
  const sims = await setUp(opts);
  const counts = { normal: 0, speeding: 0, idling: 0 };
  for (const s of sims) counts[s.state.scenario]++;
  console.log(`✔ ${sims.length} vehicles: ${counts.normal} normal, ${counts.speeding} speeding, ${counts.idling} idling. Posting to ${opts.api} every ${opts.intervalS} s${opts.durationS ? ` for ${opts.durationS} s` : ' until Ctrl+C'}.`);

  const started = new Date();
  const totals = { sent: 0, accepted: 0, duplicates: 0, rejected: 0, failed: new Map<string, number>() };
  const latencies: number[] = [];
  let window: number[] = [];
  const inFlight = new Set<Promise<void>>();

  const send = (sim: SimVehicle) => {
    const { state, ping } = step(sim.state, opts.intervalS, Math.random);
    sim.state = state;
    const body = JSON.stringify({ pings: [{ ...ping, recorded_at: new Date().toISOString(), accuracy_m: 5, ignition_on: true }] });
    const t0 = performance.now();
    totals.sent++;
    const work = fetch(`${opts.api}/tracking/gps-pings`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${sim.token}` }, body })
      .then(async (res) => {
        const ms = performance.now() - t0;
        latencies.push(ms);
        window.push(ms);
        if (res.status !== 202) {
          const key = String(res.status);
          totals.failed.set(key, (totals.failed.get(key) ?? 0) + 1);
          return;
        }
        const { data } = (await res.json()) as { data: { accepted: number; duplicates: number; rejected: unknown[] } };
        totals.accepted += data.accepted;
        totals.duplicates += data.duplicates;
        totals.rejected += data.rejected.length;
      })
      .catch(() => {
        totals.failed.set('network', (totals.failed.get('network') ?? 0) + 1);
      })
      .finally(() => inFlight.delete(work));
    inFlight.add(work);
  };

  // Each vehicle reports on its own schedule, spread evenly over the interval, as real devices would.
  const timers: NodeJS.Timeout[] = [];
  sims.forEach((sim, i) => {
    const offset = (i / sims.length) * opts.intervalS * 1000;
    timers.push(
      setTimeout(() => {
        send(sim);
        timers.push(setInterval(() => send(sim), opts.intervalS * 1000));
      }, offset),
    );
  });
  const report = setInterval(() => {
    const sorted = [...window].sort((a, b) => a - b);
    const failed = [...totals.failed.values()].reduce((a, b) => a + b, 0);
    console.log(`  ${new Date().toISOString().slice(11, 19)}  sent ${totals.sent}  accepted ${totals.accepted}  failed ${failed}  latency p50 ${percentile(sorted, 50).toFixed(0)} ms  p95 ${percentile(sorted, 95).toFixed(0)} ms`);
    window = [];
  }, opts.intervalS * 1000);

  const stop = new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    if (opts.durationS > 0) setTimeout(resolve, opts.durationS * 1000);
  });
  await stop;
  timers.forEach((t) => clearTimeout(t));
  clearInterval(report);
  await Promise.allSettled([...inFlight]);

  const moved = await pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM tracking.vehicle_current_location WHERE vehicle_id = ANY($1::bigint[]) AND updated_at >= $2',
    [sims.map((s) => s.id), started],
  );
  const sorted = latencies.sort((a, b) => a - b);
  const seconds = (Date.now() - started.getTime()) / 1000;
  const failed = [...totals.failed.entries()].map(([k, n]) => `${k}: ${n}`).join(', ') || 'none';
  console.log('\nSummary');
  console.log(`  pings sent ${totals.sent} in ${seconds.toFixed(0)} s (${(totals.sent / seconds).toFixed(1)}/s); accepted ${totals.accepted}, duplicates ${totals.duplicates}, rejected ${totals.rejected}; failed ${failed}`);
  console.log(`  latency p50 ${percentile(sorted, 50).toFixed(0)} ms, p95 ${percentile(sorted, 95).toFixed(0)} ms, max ${(sorted.at(-1) ?? 0).toFixed(0)} ms`);
  console.log(`  current location updated for ${moved.rows[0].n} of ${sims.length} vehicles`);
  if (totals.failed.size > 0 || moved.rows[0].n < sims.length) process.exitCode = 1;
}

main()
  .catch((err: unknown) => {
    console.error(`[❌ FAILED] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => Promise.all([pool.end(), closeRedis()]));

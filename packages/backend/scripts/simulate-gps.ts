/**
 * GPS simulator (FMS-88, FMS-138): drives N vehicles along their depots' seeded routes (on their roads, FMS-84) and
 * reports each one's position every interval to the running API. For the demo, the live map (FMS-45) and the load
 * target of FMS-61 (200 vehicles every 10 s).
 *
 *   npm run simulate:gps                                  # 200 vehicles, every 10 s, for 60 s
 *   npm run simulate:gps -- --vehicles 50 --interval 5 --duration 0     # until Ctrl+C
 *   npm run simulate:gps -- --speeding 0.2 --idling 0.1 --api http://localhost:3000/api/v1
 *   npm run simulate:gps -- --provider geotab-et          # as a real provider would, with its secret
 *   npm run simulate:gps -- --via device                  # each vehicle as its own device, with a token
 *
 * By default it is a telematics provider (`--provider fms-simulator`): each vehicle's simulated device
 * (`sim-<provider>-<vehicle id>`) is linked to the vehicle in the device registry, and once a second the positions
 * due are posted as one signed webhook to /webhooks/telematics/<provider>, the path a real provider uses. It signs
 * with INTEGRATION_<PROVIDER>_WEBHOOK_SECRET from the same environment as the API. With `--via device` each vehicle
 * gets a token instead and posts to /tracking/gps-pings itself.
 *
 * Either way the simulated device takes the place of one installed in the vehicle: never run it against production
 * (it refuses NODE_ENV=production). It reads vehicles and routes from the database the API uses (the same .env),
 * and ends by checking each vehicle's current location moved.
 */
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { config } from '../src/config';
import { pool } from '../src/db';
import { gpsDevices } from '../src/modules/integration';
import { closeRedis } from '../src/shared/cache';
import { signedDeliveries, type ProviderPosition } from './simulator/delivery';
import { loopAround, pathLength, scenarioFor, step, type Point, type VehicleState } from './simulator/motion';

interface SimVehicle {
  id: string;
  publicId: string;
  plate: string;
  /** Its device: a token (`--via device`), or the identifier its provider names it by. */
  token: string | null;
  identifier: string;
  state: VehicleState;
}

/** How positions reach the API: as a telematics provider's signed webhooks, or each vehicle's own device. */
type Channel = { via: 'webhook'; code: string; providerId: string; hmacKey: string } | { via: 'device' };

const ADDIS: Point = { lat: 9.0108, lng: 38.7613 };
/** The telematics provider the simulator is by default (migration 061). */
const SIMULATOR_PROVIDER = 'fms-simulator';

function options() {
  const { values } = parseArgs({
    options: {
      vehicles: { type: 'string', default: '200' },
      interval: { type: 'string', default: '10' },
      duration: { type: 'string', default: '60' },
      speeding: { type: 'string', default: '0.1' },
      idling: { type: 'string', default: '0.1' },
      api: { type: 'string', default: `http://localhost:${config.port}/api/v1` },
      via: { type: 'string', default: 'webhook' },
      provider: { type: 'string', default: SIMULATOR_PROVIDER },
    },
  });
  if (values.via !== 'webhook' && values.via !== 'device') throw new Error('--via must be webhook or device');
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
    via: values.via as 'webhook' | 'device',
    provider: String(values.provider),
  };
}

/** The provider to post as: an active telematics provider, with its webhook secret in this environment. */
async function channelFor(opts: ReturnType<typeof options>): Promise<Channel> {
  if (opts.via === 'device') return { via: 'device' };
  const res = await pool.query<{ public_id: string; is_active: boolean }>(
    "SELECT public_id, is_active FROM integration.external_providers WHERE code = $1 AND provider_type = 'telematics'",
    [opts.provider],
  );
  const row = res.rows[0];
  if (!row) throw new Error(`No telematics provider with code '${opts.provider}' (migration 061 adds fms-simulator; docs/telematics.md adds others).`);
  if (!row.is_active && opts.provider === SIMULATOR_PROVIDER) {
    // Added switched off (migration 061), so a production database never has it on; this script never runs there.
    await pool.query('UPDATE integration.external_providers SET is_active = TRUE WHERE code = $1', [SIMULATOR_PROVIDER]);
    console.log(`✔ Switched on the ${SIMULATOR_PROVIDER} provider.`);
  } else if (!row.is_active) {
    throw new Error(`The provider '${opts.provider}' is switched off (integration.external_providers.is_active).`);
  }
  const hmacKey = config.integrations.secrets[opts.provider]?.webhookSecret;
  const name = `INTEGRATION_${opts.provider.toUpperCase().replace(/-/g, '_')}_WEBHOOK_SECRET`;
  if (!hmacKey) throw new Error(`Set ${name} (at least 32 characters) for the API and the simulator, or run with --via device.`);
  return { via: 'webhook', code: opts.provider, providerId: row.public_id, hmacKey };
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

async function setUp(opts: ReturnType<typeof options>, channel: Channel): Promise<SimVehicle[]> {
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
    let token: string | null = null;
    let identifier: string;
    if (channel.via === 'webhook') {
      identifier = `sim-${channel.code}-${v.public_id}`;
      await gpsDevices.link({ providerId: channel.providerId, identifier, vehicleId: v.public_id, model: 'FMS GPS simulator', replace: true }, ctx);
    } else {
      identifier = `sim-${v.public_id}`;
      ({ token } = await gpsDevices.register({ vehicleId: v.public_id, identifier, model: 'FMS GPS simulator' }, ctx));
    }
    sims.push({
      id: v.id,
      publicId: v.public_id,
      plate: v.registration_number,
      token,
      identifier,
      state: { path, at: Math.random() * pathLength(path), direction: 1, scenario: scenarioFor(i, res.rows.length, opts.shares) },
    });
  }
  return sims;
}

const percentile = (sorted: number[], p: number) => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]);

async function main(): Promise<void> {
  if (config.nodeEnv === 'production') throw new Error('The simulator replaces vehicles\' devices: it does not run with NODE_ENV=production.');
  const opts = options();
  const channel = await channelFor(opts);
  console.log(`Setting up ${opts.vehicles} vehicles (devices and routes)...`);
  const sims = await setUp(opts, channel);
  const counts = { normal: 0, speeding: 0, idling: 0 };
  for (const s of sims) counts[s.state.scenario]++;
  const target = channel.via === 'webhook' ? `${opts.api}/webhooks/telematics/${channel.code} as provider ${channel.code}` : `${opts.api}/tracking/gps-pings`;
  console.log(`✔ ${sims.length} vehicles: ${counts.normal} normal, ${counts.speeding} speeding, ${counts.idling} idling. Posting to ${target} every ${opts.intervalS} s${opts.durationS ? ` for ${opts.durationS} s` : ' until Ctrl+C'}.`);

  const started = new Date();
  const totals = { sent: 0, accepted: 0, duplicates: 0, rejected: 0, deliveries: 0, failed: new Map<string, number>() };
  const latencies: number[] = [];
  let window: number[] = [];
  const inFlight = new Set<Promise<void>>();
  const fail = (key: string): void => {
    totals.failed.set(key, (totals.failed.get(key) ?? 0) + 1);
  };

  // As a provider: the positions due since the last delivery, posted together once a second, signed.
  let due: ProviderPosition[] = [];
  const deliver = () => {
    if (channel.via !== 'webhook' || due.length === 0) return;
    for (const delivery of signedDeliveries(channel.hmacKey, due)) {
      const t0 = performance.now();
      totals.deliveries++;
      const work = fetch(`${opts.api}/webhooks/telematics/${channel.code}`, { method: 'POST', headers: delivery.headers, body: delivery.raw })
        .then((res) => {
          const ms = performance.now() - t0;
          latencies.push(ms);
          window.push(ms);
          // Stored and answered at once; the positions become pings after, so they are counted on the way out.
          if (res.status === 202) totals.accepted += delivery.positions;
          else fail(String(res.status));
        })
        .catch(() => fail('network'))
        .finally(() => inFlight.delete(work));
      inFlight.add(work);
    }
    due = [];
  };

  const send = (sim: SimVehicle) => {
    const { state, ping } = step(sim.state, opts.intervalS, Math.random);
    sim.state = state;
    const position = { ...ping, recorded_at: new Date().toISOString(), accuracy_m: 5, ignition_on: true };
    totals.sent++;
    if (channel.via === 'webhook') {
      due.push({ device_id: sim.identifier, ...position });
      return;
    }
    const body = JSON.stringify({ pings: [position] });
    const t0 = performance.now();
    const work = fetch(`${opts.api}/tracking/gps-pings`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${sim.token}` }, body })
      .then(async (res) => {
        const ms = performance.now() - t0;
        latencies.push(ms);
        window.push(ms);
        if (res.status !== 202) {
          fail(String(res.status));
          return;
        }
        const { data } = (await res.json()) as { data: { accepted: number; duplicates: number; rejected: unknown[] } };
        totals.accepted += data.accepted;
        totals.duplicates += data.duplicates;
        totals.rejected += data.rejected.length;
      })
      .catch(() => fail('network'))
      .finally(() => inFlight.delete(work));
    inFlight.add(work);
  };
  const flusher = setInterval(deliver, 1000);

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
  clearInterval(flusher);
  deliver();
  await Promise.allSettled([...inFlight]);

  // A provider's positions become pings after its delivery is stored (the outbox): give the consumer a moment.
  const movedCount = async () =>
    (
      await pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM tracking.vehicle_current_location WHERE vehicle_id = ANY($1::bigint[]) AND updated_at >= $2',
        [sims.map((s) => s.id), started],
      )
    ).rows[0].n;
  let moved = await movedCount();
  for (let waited = 0; channel.via === 'webhook' && moved < sims.length && waited < 15_000; waited += 500) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    moved = await movedCount();
  }
  const sorted = latencies.sort((a, b) => a - b);
  const seconds = (Date.now() - started.getTime()) / 1000;
  const failed = [...totals.failed.entries()].map(([k, n]) => `${k}: ${n}`).join(', ') || 'none';
  console.log('\nSummary');
  if (channel.via === 'webhook') {
    console.log(`  positions sent ${totals.sent} in ${seconds.toFixed(0)} s (${(totals.sent / seconds).toFixed(1)}/s) in ${totals.deliveries} deliveries; delivered ${totals.accepted}; failed ${failed}`);
  } else {
    console.log(`  pings sent ${totals.sent} in ${seconds.toFixed(0)} s (${(totals.sent / seconds).toFixed(1)}/s); accepted ${totals.accepted}, duplicates ${totals.duplicates}, rejected ${totals.rejected}; failed ${failed}`);
  }
  console.log(`  latency p50 ${percentile(sorted, 50).toFixed(0)} ms, p95 ${percentile(sorted, 95).toFixed(0)} ms, max ${(sorted.at(-1) ?? 0).toFixed(0)} ms`);
  console.log(`  current location updated for ${moved} of ${sims.length} vehicles`);
  if (totals.failed.size > 0 || moved < sims.length) process.exitCode = 1;
}

main()
  .catch((err: unknown) => {
    console.error(`[❌ FAILED] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => Promise.all([pool.end(), closeRedis()]));

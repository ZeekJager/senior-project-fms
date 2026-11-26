/**
 * EV charging simulator (FMS-97, decision D-06): the simulated charging network, in real time. It plugs the fleet's
 * electric vehicles into its stations around Addis Ababa and reports each session to the running API as a real
 * charging provider would: a signed webhook to POST /webhooks/ev/simulated when it starts, and another when it
 * completes or fails. For the demo and the EV dashboard (FMS-99).
 *
 *   npm run simulate:ev                                   # a session every 5 s for 60 s, each charging for 20 s
 *   npm run simulate:ev -- --rate 30 --duration 0         # 30 sessions a minute until Ctrl+C
 *   npm run simulate:ev -- --duplicates 0.2 --replays 0.1 --failures 0.25
 *
 * Like a real provider it is not perfect: `--duplicates` of the deliveries are sent twice (the same event id, as a
 * provider resends one it saw no answer to), `--replays` are sent again under a new event id, and `--failures` of
 * the sessions fail. A delivery the API does not take (a network error, 429, 5xx) is retried three times with
 * backoff. None of it may create a second session: it ends by checking each session it reported is stored once.
 *
 * It signs with INTEGRATION_SIMULATED_WEBHOOK_SECRET from the same environment as the API, switches the provider on
 * (it is added switched off, migration 084), adds the network's stations if the seed (`--with-ev`) has not, and
 * refuses NODE_ENV=production. Every session it reports is stored as synthetic.
 */
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { config } from '../src/config';
import { pool } from '../src/db';
import { closeRedis } from '../src/shared/cache';
import { auditedMutation } from '../src/shared/infrastructure/audited-mutation';
import { withTransaction } from '../src/shared/infrastructure/transaction';
import { Rng } from './seed/random';
import {
  SIMULATED_PROVIDER,
  SIM_STATIONS,
  chargeCostCents,
  chargeEnergyKwh,
  evDelivery,
  evProfileOf,
  signEvDelivery,
  type SimSession,
  type SimStation,
} from './simulator/ev-charging';
import type { EvChargingDelivery } from '../src/modules/integration/domain/ev-charging-schema';

if (process.env.NODE_ENV === 'production') {
  console.error('✖ The EV simulator fabricates charging sessions: it never runs against production (NODE_ENV=production).');
  process.exit(1);
}

function options() {
  const { values } = parseArgs({
    options: {
      rate: { type: 'string', default: '12' },
      duration: { type: 'string', default: '60' },
      charge: { type: 'string', default: '20' },
      duplicates: { type: 'string', default: '0.1' },
      replays: { type: 'string', default: '0.05' },
      failures: { type: 'string', default: '0.1' },
      seed: { type: 'string', default: String(Date.now() % 1_000_000_000) },
      api: { type: 'string', default: `http://localhost:${config.port}/api/v1` },
    },
  });
  const num = (name: keyof typeof values, min: number, max: number) => {
    const n = Number(values[name]);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`--${name} must be between ${min} and ${max}`);
    return n;
  };
  return {
    perMinute: num('rate', 1, 600),
    durationS: num('duration', 0, 86_400),
    chargeS: num('charge', 1, 3600),
    duplicates: num('duplicates', 0, 1),
    replays: num('replays', 0, 1),
    failures: num('failures', 0, 1),
    seed: num('seed', 0, 2 ** 31),
    api: String(values.api).replace(/\/+$/, ''),
  };
}

interface Ev {
  publicId: string;
  plate: string;
  make: string;
  model: string;
  soc: number;
  health: number;
  busy: boolean;
}

/** The simulated provider, switched on, and its stations (added if missing). */
async function setUp(): Promise<{ secret: string; stations: readonly SimStation[] }> {
  const res = await pool.query<{ id: string; is_active: boolean }>(
    "SELECT id, is_active FROM integration.external_providers WHERE code = $1 AND provider_type = 'ev_charging'",
    [SIMULATED_PROVIDER],
  );
  const provider = res.rows[0];
  if (!provider) throw new Error(`No ev_charging provider '${SIMULATED_PROVIDER}': run the migrations (084).`);
  if (!provider.is_active) {
    // Added switched off (migration 084), so a production database never has it on; this script never runs there.
    await pool.query('UPDATE integration.external_providers SET is_active = TRUE WHERE id = $1', [provider.id]);
    console.log(`✔ Switched on the ${SIMULATED_PROVIDER} charging provider.`);
  }
  const secret = config.integrations.secrets[SIMULATED_PROVIDER]?.webhookSecret;
  if (!secret) throw new Error('Set INTEGRATION_SIMULATED_WEBHOOK_SECRET (at least 32 characters) for the API and the simulator (make env adds it).');

  const known = await pool.query<{ external_station_id: string }>('SELECT external_station_id FROM ev.charging_stations WHERE provider_id = $1', [provider.id]);
  const have = new Set(known.rows.map((r) => r.external_station_id));
  const missing = SIM_STATIONS.filter((s) => !have.has(s.external_station_id));
  if (missing.length > 0) {
    await withTransaction(pool, async (client) => {
      for (const s of missing) {
        await auditedMutation(client, { userId: null, correlationId: randomUUID() }, 'ev.charging_stations', 'INSERT', null, {
          external_station_id: s.external_station_id,
          name: s.name,
          latitude: s.latitude,
          longitude: s.longitude,
          connector_type: s.connector_type,
          power_kw: s.power_kw,
          provider_id: provider.id,
          status: 'available',
          source: 'synthetic',
        });
      }
    });
    console.log(`✔ Added ${missing.length} simulated charging stations.`);
  }
  return { secret, stations: SIM_STATIONS };
}

async function electricVehicles(): Promise<Ev[]> {
  const res = await pool.query<{ public_id: string; registration_number: string; make: string; model: string; soc: number | null; health: number | null }>(
    `SELECT v.public_id, v.registration_number, v.make, v.model,
            (SELECT l.state_of_charge::float8 FROM ev.ev_battery_logs l WHERE l.vehicle_id = v.id ORDER BY l.recorded_at DESC LIMIT 1) AS soc,
            (SELECT l.battery_health::float8 FROM ev.ev_battery_logs l WHERE l.vehicle_id = v.id AND l.battery_health IS NOT NULL ORDER BY l.recorded_at DESC LIMIT 1) AS health
       FROM fleet.vehicles v
      WHERE v.fuel_type = 'electric' AND v.is_active AND v.status <> 'retired'
        AND NOT EXISTS (SELECT 1 FROM ev.charging_sessions s WHERE s.vehicle_id = v.id AND s.status = 'in_progress')
      ORDER BY v.registration_number`,
  );
  return res.rows.map((r) => ({ publicId: r.public_id, plate: r.registration_number, make: r.make, model: r.model, soc: r.soc ?? 40, health: r.health ?? 96, busy: false }));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const opts = options();
  const { secret, stations } = await setUp();
  const fleet = await electricVehicles();
  if (fleet.length === 0) throw new Error('No electric vehicle free to charge. Seed some (npm run seed -- --with-ev) or register one with fuel_type electric.');
  const rng = new Rng(opts.seed);
  const url = `${opts.api}/webhooks/ev/${SIMULATED_PROVIDER}`;
  const counts = { deliveries: 0, accepted: 0, duplicates: 0, retried: 0, refused: 0, started: 0, completed: 0, failed: 0 };
  const reported = new Set<string>();

  /** One delivery, signed afresh on each attempt; retried on a network error, 429 or 5xx. */
  async function send(body: EvChargingDelivery): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) {
        counts.retried += 1;
        await sleep(500 * 2 ** (attempt - 1));
      }
      const signed = signEvDelivery(secret, body);
      counts.deliveries += 1;
      try {
        const res = await fetch(url, { method: 'POST', headers: signed.headers, body: signed.raw });
        if (res.status === 429 || res.status >= 500) continue;
        const json = (await res.json().catch(() => null)) as { data?: { duplicate?: boolean } } | null;
        if (res.status !== 202) {
          counts.refused += 1;
          console.error(`  ✖ ${body.type} ${body.session.session_id}: ${res.status} ${JSON.stringify(json)}`);
        } else if (json?.data?.duplicate) counts.duplicates += 1;
        else counts.accepted += 1;
        return;
      } catch {
        // A network error: try again.
      }
    }
    counts.refused += 1;
    console.error(`  ✖ ${body.type} ${body.session.session_id}: no answer after 4 attempts`);
  }

  /** Sends a delivery as an imperfect provider does: sometimes twice, sometimes again under a new id. */
  async function report(body: EvChargingDelivery): Promise<void> {
    await send(body);
    if (rng.chance(opts.duplicates)) await send(body);
    if (rng.chance(opts.replays)) await send({ ...body, event_id: `sim-${randomUUID()}` });
  }

  async function charge(ev: Ev): Promise<void> {
    ev.busy = true;
    const profile = evProfileOf(ev.make, ev.model);
    const station = rng.pick(stations.filter((s) => profile.capacityKwh <= 150 || s.power_kw >= 60));
    const startedAt = new Date();
    const session: SimSession = {
      session_id: `sim-s-${randomUUID()}`,
      vehicle_id: ev.publicId,
      station_id: station.external_station_id,
      started_at: startedAt.toISOString(),
      start_soc: Math.round(ev.soc * 10) / 10,
    };
    reported.add(session.session_id);
    await report(evDelivery('session_started', session, startedAt));
    counts.started += 1;
    console.log(`  ⚡ ${ev.plate} at ${station.name}, from ${session.start_soc}%`);

    await sleep(opts.chargeS * 1000 * rng.between(0.7, 1.3));
    const failed = rng.chance(opts.failures);
    const endSoc = failed ? Math.min(100, ev.soc + rng.between(0, 4)) : rng.between(80, 100);
    const energy = chargeEnergyKwh(profile, ev.health, ev.soc, endSoc);
    const endedAt = new Date();
    const done: SimSession = { ...session, ended_at: endedAt.toISOString(), end_soc: Math.round(endSoc * 10) / 10, energy_kwh: energy, cost_cents: chargeCostCents(station, energy) };
    await report(evDelivery(failed ? 'session_failed' : 'session_completed', done, endedAt));
    counts[failed ? 'failed' : 'completed'] += 1;
    console.log(`  ${failed ? '✖' : '✔'} ${ev.plate} ${failed ? 'failed' : 'charged'} at ${done.end_soc}% (${energy} kWh)`);
    ev.soc = endSoc;
    ev.busy = false;
  }

  console.log(`Charging ${fleet.length} EVs at ${stations.length} simulated stations: ${opts.perMinute} sessions a minute, ${opts.durationS || '∞'} s.`);
  const stopAt = opts.durationS > 0 ? Date.now() + opts.durationS * 1000 : Infinity;
  let stopping = false;
  process.on('SIGINT', () => (stopping = true));
  const running: Promise<void>[] = [];
  while (!stopping && Date.now() < stopAt) {
    const free = fleet.filter((v) => !v.busy);
    if (free.length > 0) running.push(charge(rng.pick(free)));
    await sleep(60_000 / opts.perMinute);
  }
  await Promise.all(running);

  // Every session reported is stored exactly once, however many times its deliveries came.
  const stored = await pool.query<{ external_session_id: string; n: number; source: string }>(
    'SELECT external_session_id, count(*)::int AS n, min(source) AS source FROM ev.charging_sessions WHERE external_session_id = ANY($1) GROUP BY 1',
    [[...reported]],
  );
  const once = stored.rows.filter((r) => r.n === 1 && r.source === 'synthetic').length;
  console.table(counts);
  console.log(`${once} of ${reported.size} sessions stored once, as synthetic (the consumer may still be catching up on the last).`);
}

main()
  .catch((err: unknown) => {
    console.error(`✖ ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => Promise.all([pool.end(), closeRedis()]));

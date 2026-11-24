/**
 * The game day's GPS sender (FMS-162, docs/disaster-recovery.md#game-day): a GPS device in a vehicle sends N positions
 * to POST /api/v1/tracking/gps-pings, --batch a request every --interval-ms (10 and 550 by default: under the device
 * rate limit of 120 a minute), while the database fails over (scripts/dr/gameday.sh runs promote.sh partway through).
 * Like the phone's queue and a device, it sends a batch again after a 503 (as Retry-After says, at most 2 s here), a
 * 429 (as Retry-After says) or a dropped connection, until it is accepted. Then it counts what was stored.
 *
 *   npx tsx scripts/dr-gameday.ts [--points 1000] [--batch 10] [--interval-ms 550] [--vehicle <plate or id>] [--api ...]
 *
 * Prints "sent <n>" every 100 positions (gameday.sh waits on it), then one line of JSON: sent, stored, lost, retries
 * and how long the API answered 503. Exits 1 when any position was lost.
 */
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pool } from '../src/db';
import { gpsDevices } from '../src/modules/integration';
import { closeRedis } from '../src/shared/cache';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function vehicleOf(given: string | undefined): Promise<string> {
  if (given && UUID.test(given)) return given;
  const res = given
    ? await pool.query<{ public_id: string }>('SELECT public_id FROM fleet.vehicles WHERE registration_number = $1', [given])
    : await pool.query<{ public_id: string }>("SELECT public_id FROM fleet.vehicles WHERE status = 'active' ORDER BY id LIMIT 1");
  if (!res.rows[0]) throw new Error(given ? `No vehicle with plate '${given}'` : 'No vehicle to install the game day device in');
  return res.rows[0].public_id;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { points: { type: 'string' }, batch: { type: 'string' }, 'interval-ms': { type: 'string' }, vehicle: { type: 'string' }, api: { type: 'string' } },
  });
  const points = Number(values.points ?? 1000);
  const batch = Number(values.batch ?? 10);
  const intervalMs = Number(values['interval-ms'] ?? 550);
  const api = values.api ?? 'http://127.0.0.1:3000';
  const vehicleId = await vehicleOf(values.vehicle);
  const identifier = `GAMEDAY-${new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15)}`;
  const { deviceId, token } = await gpsDevices.register({ vehicleId, identifier, providerId: null, model: 'game day sender' }, { userId: null, correlationId: randomUUID() });

  // One position a second of the last `points` seconds: each its own time, so each is stored once however often it is sent.
  const first = Date.now() - points * 1000;
  let retries = 0;
  let unavailableMs = 0;
  let unavailableSince: number | null = null;
  const ping = (i: number) => ({ recorded_at: new Date(first + i * 1000).toISOString(), lat: 9.0108 + i * 0.00001, lng: 38.7613 + i * 0.00001, speed_kmh: 40, heading: 90, accuracy_m: 5, altitude_m: 2355 });
  for (let start = 0; start < points; start += batch) {
    const pings = Array.from({ length: Math.min(batch, points - start) }, (_, k) => ping(start + k));
    for (;;) {
      let status = 0;
      let retryAfter = 1;
      try {
        const res = await fetch(`${api}/api/v1/tracking/gps-pings`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ pings }),
        });
        status = res.status;
        retryAfter = Number(res.headers.get('retry-after') ?? 1);
        await res.body?.cancel();
      } catch {
        status = 0;
      }
      if (status === 202) break;
      if (status === 429) {
        retries++;
        await sleep(retryAfter * 1000);
        continue;
      }
      if (status !== 0 && status !== 503 && status !== 502 && status !== 504) throw new Error(`Positions from ${start} refused with ${status}`);
      if (status === 503) unavailableSince ??= Date.now();
      retries++;
      await sleep(Math.min(retryAfter, 2) * 1000);
    }
    if (unavailableSince !== null) {
      unavailableMs += Date.now() - unavailableSince;
      unavailableSince = null;
    }
    const sent = start + pings.length;
    if (sent % 100 === 0) console.log(`sent ${sent}`);
    await sleep(intervalMs);
  }

  const stored = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM tracking.gps_pings p JOIN integration.gps_devices d ON d.id = p.gps_device_id
      WHERE d.public_id = $1 AND p.recorded_at >= $2`,
    [deviceId, new Date(first)],
  );
  const n = Number(stored.rows[0].n);
  console.log(JSON.stringify({ device: identifier, vehicle: vehicleId, sent: points, stored: n, lost: points - n, retries, unavailable_seconds: Math.round(unavailableMs / 100) / 10 }));
  if (n !== points) process.exitCode = 1;
}

main()
  .catch((err: unknown) => {
    console.error(`[❌ FAILED] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
    await closeRedis();
  });

/**
 * Measures the actual distance of every completed trip that has none and was never measured (FMS-145,
 * docs/trip-distance.md): trips that ended before trips were measured as they ended. Idempotent: a trip measured
 * once, with a distance or without, is not measured again by this script (the hourly job re-measures recent ones).
 *
 *   npm run backfill:trip-distance -w fms-backend
 *
 * Positions are kept for the retention period (driver-data-protection.md), so an older trip may have none: it is
 * recorded as measured without a distance, and counted under "no positions".
 */
import { randomUUID } from 'node:crypto';
import { pool } from '../src/db';
import { modules } from '../src/modules';
import { tripDistance } from '../src/modules/trip';
import { closeRedis } from '../src/shared/cache';

async function main(): Promise<void> {
  // Importing the modules connects the trip module to the positions the integration module stores.
  if (!modules.length) throw new Error('No modules loaded.');
  const correlationId = randomUUID();
  console.log(`Measuring completed trips with no distance (correlation ${correlationId})…`);
  const s = await tripDistance.backfill(correlationId, (p) => console.log(`  ${p.checked} checked, ${p.measured} measured`));
  console.log(
    `[✅ DONE] ${s.checked} trips checked: ${s.bySource.odometer} measured by odometer, ${s.bySource.gps} by GPS track, ` +
      `${s.without.no_positions ?? 0} with no positions to measure from (left without a distance), ${s.unchanged} unchanged.`,
  );
}

main()
  .catch((err: unknown) => {
    console.error(`[❌ FAILED] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => Promise.all([pool.end(), closeRedis()]));

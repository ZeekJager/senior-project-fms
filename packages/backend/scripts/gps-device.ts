/**
 * Installs a GPS device in a vehicle and prints its token, once (FMS-88). The device then posts
 * positions to POST /api/v1/tracking/gps-pings with `Authorization: Bearer <token>`, for that vehicle only.
 *
 *   npm run device:register -- --vehicle "AA 3-12345" --identifier TRK-0042
 *   npm run device:register -- --vehicle <vehicle public id> --identifier GT-1001 --provider geotab-et
 *
 * The same identifier again issues a new token (the old one stops working). A vehicle has one active
 * device: registering another takes the first out of service. `--provider` ties the device to a
 * telematics provider, whose webhooks name it by its identifier.
 */
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pool } from '../src/db';
import { gpsDevices } from '../src/modules/integration';
import { closeRedis } from '../src/shared/cache';

const USAGE = 'Usage: npm run device:register -- --vehicle <plate or public id> --identifier <device id> [--provider <code>] [--model <model>]';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { vehicle: { type: 'string' }, identifier: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' } },
  });
  if (!values.vehicle || !values.identifier) throw new Error(USAGE);

  let vehicleId = values.vehicle.trim();
  if (!UUID.test(vehicleId)) {
    const found = await pool.query<{ public_id: string }>('SELECT public_id FROM fleet.vehicles WHERE registration_number = $1', [vehicleId]);
    if (!found.rows[0]) throw new Error(`No vehicle with plate '${vehicleId}'`);
    vehicleId = found.rows[0].public_id;
  }
  let providerId: string | null = null;
  if (values.provider) {
    const found = await pool.query<{ id: string }>("SELECT id FROM integration.external_providers WHERE code = $1 AND provider_type = 'telematics'", [values.provider]);
    if (!found.rows[0]) throw new Error(`No telematics provider with code '${values.provider}'`);
    providerId = found.rows[0].id;
  }

  const { deviceId, token } = await gpsDevices.register(
    { vehicleId, identifier: values.identifier.trim(), providerId, model: values.model ?? null },
    { userId: null, correlationId: randomUUID() },
  );
  console.log(`✔ Device ${values.identifier} (${deviceId}) installed in vehicle ${vehicleId}`);
  console.log(`  Token (shown once; only its hash is stored): ${token}`);
}

main()
  .catch((err: unknown) => {
    console.error(`[❌ FAILED] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => Promise.all([pool.end(), closeRedis()]));

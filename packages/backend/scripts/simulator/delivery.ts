import { randomUUID } from 'node:crypto';
// The pure parts only (not the module's index, which connects to the database), so the unit test runs without one.
import { MAX_PINGS_PER_BATCH } from '../../src/modules/integration/domain/gps';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signWebhook } from '../../src/modules/integration/domain/webhook-signature';

/** One position as a provider reports it: its device id and the ping's fields (FMS telematics format). */
export type ProviderPosition = { device_id: string; recorded_at: string; lat: number; lng: number; speed_kmh: number } & Record<string, unknown>;

/** A signed webhook delivery, ready to POST to /webhooks/telematics/{code}. */
export interface SignedDelivery {
  raw: string;
  headers: Record<string, string>;
  positions: number;
}

/**
 * The GPS simulator's webhook deliveries (FMS-138): the positions in batches of at most MAX_PINGS_PER_BATCH, each in
 * the FMS telematics format under a fresh event id, signed with the provider's secret as a real provider signs them
 * (docs/integrations.md). The integration test posts the same.
 */
export function signedDeliveries(secret: string, positions: readonly ProviderPosition[], nowMs = Date.now()): SignedDelivery[] {
  const deliveries: SignedDelivery[] = [];
  const ts = Math.floor(nowMs / 1000);
  for (let i = 0; i < positions.length; i += MAX_PINGS_PER_BATCH) {
    const batch = positions.slice(i, i + MAX_PINGS_PER_BATCH);
    const raw = JSON.stringify({ event_id: `sim-${randomUUID()}`, positions: batch });
    deliveries.push({
      raw,
      headers: { 'content-type': 'application/json', [TIMESTAMP_HEADER]: String(ts), [SIGNATURE_HEADER]: signWebhook(secret, ts, raw) },
      positions: batch.length,
    });
  }
  return deliveries;
}

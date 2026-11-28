import { randomUUID } from 'node:crypto';
// The pure parts only (not the module's index, which connects to the database), so the unit test runs without one.
import { MAX_DIAGNOSTICS_PER_BATCH, type DiagnosticEntry } from '../../src/modules/integration/domain/diagnostics';
import { MAX_PINGS_PER_BATCH } from '../../src/modules/integration/domain/gps';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signWebhook } from '../../src/modules/integration/domain/webhook-signature';

/** One position as a provider reports it: its device id and the ping's fields (FMS telematics format). */
export type ProviderPosition = { device_id: string; recorded_at: string; lat: number; lng: number; speed_kmh: number } & Record<string, unknown>;

/** One diagnostic trouble code as a provider reports it (FMS-132): its device id, the code, active or cleared. */
export type ProviderDiagnostic = DiagnosticEntry;

/** A signed webhook delivery, ready to POST to /webhooks/telematics/{code}. */
export interface SignedDelivery {
  raw: string;
  headers: Record<string, string>;
  positions: number;
  diagnostics: number;
}

/**
 * The GPS simulator's webhook deliveries (FMS-138): the positions in batches of at most MAX_PINGS_PER_BATCH, each in
 * the FMS telematics format under a fresh event id, signed with the provider's secret as a real provider signs them
 * (docs/integrations.md). Diagnostic trouble codes (FMS-132) ride with the first batches of positions, or go alone
 * when there are none, at most MAX_DIAGNOSTICS_PER_BATCH a delivery. The integration test posts the same.
 */
export function signedDeliveries(secret: string, positions: readonly ProviderPosition[], nowMs = Date.now(), diagnostics: readonly ProviderDiagnostic[] = []): SignedDelivery[] {
  const deliveries: SignedDelivery[] = [];
  const ts = Math.floor(nowMs / 1000);
  const batches = Math.max(Math.ceil(positions.length / MAX_PINGS_PER_BATCH), Math.ceil(diagnostics.length / MAX_DIAGNOSTICS_PER_BATCH));
  for (let i = 0; i < batches; i++) {
    const batch = positions.slice(i * MAX_PINGS_PER_BATCH, (i + 1) * MAX_PINGS_PER_BATCH);
    const codes = diagnostics.slice(i * MAX_DIAGNOSTICS_PER_BATCH, (i + 1) * MAX_DIAGNOSTICS_PER_BATCH);
    const raw = JSON.stringify({ event_id: `sim-${randomUUID()}`, ...(batch.length ? { positions: batch } : {}), ...(codes.length ? { diagnostics: codes } : {}) });
    deliveries.push({
      raw,
      headers: { 'content-type': 'application/json', [TIMESTAMP_HEADER]: String(ts), [SIGNATURE_HEADER]: signWebhook(secret, ts, raw) },
      positions: batch.length,
      diagnostics: codes.length,
    });
  }
  return deliveries;
}

/** The codes the simulator's faulty vehicles report (`--faults`): common ones, each in the dictionary (migration 088). */
export const SIMULATED_FAULTS: readonly ({ protocol: 'obd2'; code: string } | { protocol: 'j1939'; spn: number; fmi: number })[] = [
  { protocol: 'obd2', code: 'P0217' },
  { protocol: 'obd2', code: 'P0300' },
  { protocol: 'j1939', spn: 110, fmi: 0 },
  { protocol: 'obd2', code: 'P0524' },
  { protocol: 'obd2', code: 'P0420' },
];

/** The fault the i-th of n vehicles reports, or null: the first `share` of them, spread over the list. */
export function faultFor(i: number, n: number, share: number): (typeof SIMULATED_FAULTS)[number] | null {
  return i < Math.round(n * share) ? SIMULATED_FAULTS[i % SIMULATED_FAULTS.length] : null;
}

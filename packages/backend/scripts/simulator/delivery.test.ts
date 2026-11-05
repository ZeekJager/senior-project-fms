import assert from 'node:assert/strict';
import { test } from 'vitest';
import { MAX_PINGS_PER_BATCH } from '../../src/modules/integration/domain/gps';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signWebhook } from '../../src/modules/integration/domain/webhook-signature';
import { signedDeliveries, type ProviderPosition } from './delivery';

// FMS-138: the simulator's webhooks are what a real provider sends: the FMS telematics format, signed.

const SECRET = 's'.repeat(40);
const position = (i: number): ProviderPosition => ({ device_id: `sim-${i}`, recorded_at: '2026-11-05T09:00:00Z', lat: 9.01, lng: 38.76, speed_kmh: 40 });

test('batches of at most MAX_PINGS_PER_BATCH, each under its own event id, signed over the exact body', () => {
  const positions = Array.from({ length: MAX_PINGS_PER_BATCH + 1 }, (_, i) => position(i));
  const now = Date.parse('2026-11-05T09:00:05Z');
  const deliveries = signedDeliveries(SECRET, positions, now);
  assert.deepEqual(
    deliveries.map((d) => d.positions),
    [MAX_PINGS_PER_BATCH, 1],
  );
  const [first, second] = deliveries.map((d) => JSON.parse(d.raw) as { event_id: string; positions: ProviderPosition[] });
  assert.notEqual(first.event_id, second.event_id);
  assert.deepEqual(second.positions, [position(MAX_PINGS_PER_BATCH)]);
  const ts = Math.floor(now / 1000);
  assert.equal(deliveries[0].headers[TIMESTAMP_HEADER], String(ts));
  assert.equal(deliveries[0].headers[SIGNATURE_HEADER], signWebhook(SECRET, ts, deliveries[0].raw));
});

test('nothing due, nothing sent', () => {
  assert.deepEqual(signedDeliveries(SECRET, []), []);
});

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { MAX_PINGS_PER_BATCH } from '../../src/modules/integration/domain/gps';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, signWebhook } from '../../src/modules/integration/domain/webhook-signature';
import { faultFor, signedDeliveries, SIMULATED_FAULTS, type ProviderPosition } from './delivery';

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

// FMS-132: fault codes ride with the positions, or go alone; the faulty share of the vehicles reports one each.
test('diagnostic codes go with the first batch of positions, or alone when there are none', () => {
  const code = { device_id: 'sim-0', protocol: 'obd2' as const, code: 'P0217', status: 'active' as const, observed_at: '2026-11-05T09:00:00Z' };
  const [both] = signedDeliveries(SECRET, [position(0)], Date.now(), [code]);
  assert.deepEqual(JSON.parse(both.raw).diagnostics, [code]);
  assert.equal(both.diagnostics, 1);
  const [alone] = signedDeliveries(SECRET, [], Date.now(), [code]);
  assert.equal(JSON.parse(alone.raw).positions, undefined);
  assert.deepEqual(JSON.parse(alone.raw).diagnostics, [code]);
});

test('the first share of the vehicles reports a fault, spread over the codes', () => {
  const faults = Array.from({ length: 10 }, (_, i) => faultFor(i, 10, 0.3));
  assert.equal(faults.filter(Boolean).length, 3);
  assert.deepEqual(faults.slice(0, 3), SIMULATED_FAULTS.slice(0, 3));
  assert.equal(faultFor(0, 10, 0), null);
});

import { describe, expect, test } from 'vitest';
import { WebhookPayloadError } from './adapter';
import { MAX_ACCURACY_M, MAX_FUTURE_SKEW_MS, MAX_PING_AGE_MS, pingProblem, roundSpeed } from './gps';
import { apiPingBatch } from './ping-schema';
import { fmsTelematicsAdapter } from '../infrastructure/fms-telematics.adapter';

const NOW = Date.parse('2026-10-21T09:00:00Z');
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

describe('pingProblem', () => {
  test('keeps a ping from now, or buffered within a week', () => {
    expect(pingProblem({ recorded_at: at(0) }, NOW)).toBeNull();
    expect(pingProblem({ recorded_at: at(-MAX_PING_AGE_MS), accuracy_m: 12 }, NOW)).toBeNull();
    expect(pingProblem({ recorded_at: at(MAX_FUTURE_SKEW_MS) }, NOW)).toBeNull();
  });

  test('refuses a clock far ahead, a week-old ping and an imprecise fix', () => {
    expect(pingProblem({ recorded_at: at(MAX_FUTURE_SKEW_MS + 1000) }, NOW)).toBe('future_timestamp');
    expect(pingProblem({ recorded_at: at(-MAX_PING_AGE_MS - 1000) }, NOW)).toBe('too_old');
    expect(pingProblem({ recorded_at: at(0), accuracy_m: MAX_ACCURACY_M + 1 }, NOW)).toBe('low_accuracy');
  });
});

test('speed is stored as whole km/h, rounded to the nearest (api-contract §17)', () => {
  expect([roundSpeed(42.4), roundSpeed(42.5), roundSpeed(0.2), roundSpeed(80)]).toEqual([42, 43, 0, 80]);
});

describe('the API batch', () => {
  const ping = { recorded_at: at(0), lat: 9.01, lng: 38.76, speed_kmh: 40 };
  test('reads a batch of 1 to 500 pings', () => {
    expect(apiPingBatch.safeParse({ pings: [ping] }).success).toBe(true);
    expect(apiPingBatch.safeParse({ pings: [] }).success).toBe(false);
    expect(apiPingBatch.safeParse({ pings: Array.from({ length: 501 }, () => ping) }).success).toBe(false);
  });
  test('refuses coordinates and speeds out of range, and unknown fields', () => {
    for (const bad of [{ lat: 91 }, { lng: -181 }, { speed_kmh: -1 }, { speed_kmh: 301 }, { heading: 361 }, { recorded_at: '2026-10-21 09:00' }, { colour: 'red' }]) {
      expect(apiPingBatch.safeParse({ pings: [{ ...ping, ...bad }] }).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('fmsTelematicsAdapter', () => {
  const adapter = fmsTelematicsAdapter('geotab-et');
  test('normalises a delivery of positions; the event id is the de-duplication key', () => {
    const positions = [
      { device_id: 'GT-1', recorded_at: '2026-10-21T08:59:50Z', lat: 9.01, lng: 38.76, speed_kmh: 41.6 },
      { device_id: 'GT-2', recorded_at: '2026-10-21T09:00:00Z', lat: 8.98, lng: 38.79, speed_kmh: 0, ignition_on: true },
    ];
    expect(adapter.normalize!({ event_id: 'b-17', positions })).toEqual({
      eventId: 'b-17',
      kind: 'positions',
      occurredAt: new Date('2026-10-21T09:00:00Z'),
      data: { positions },
    });
  });
  test('names the field it cannot read', () => {
    expect(() => adapter.normalize!({ event_id: 'b-18', positions: [{ device_id: 'GT-1', recorded_at: 'now', lat: 9, lng: 38, speed_kmh: 1 }] })).toThrow(
      new WebhookPayloadError('positions.0.recorded_at', 'invalid_format'),
    );
    expect(() => adapter.normalize!({ positions: [] })).toThrow(WebhookPayloadError);
  });
});

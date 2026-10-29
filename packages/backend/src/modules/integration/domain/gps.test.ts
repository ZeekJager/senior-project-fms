import { describe, expect, test } from 'vitest';
import { WebhookPayloadError } from './adapter';
import { MAX_ACCURACY_M, MAX_FUTURE_SKEW_MS, MAX_PING_AGE_MS, pingProblem, roundSpeed, tripAt } from './gps';
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

describe('tripAt (FMS-124)', () => {
  const trip = (name: string, startMin: number, endMin: number | null) => ({
    name,
    actualStart: new Date(NOW + startMin * 60_000),
    actualEnd: endMin === null ? null : new Date(NOW + endMin * 60_000),
  });
  const find = (trips: ReturnType<typeof trip>[], atMin: number) => tripAt(trips, NOW + atMin * 60_000)?.name ?? null;

  test('a ping is in the trip driven when it was recorded, ends included', () => {
    const done = [trip('a', 0, 60)];
    expect(find(done, 30)).toBe('a');
    expect(find(done, 0)).toBe('a');
    expect(find(done, 60)).toBe('a');
  });

  test('a ping before the trip began or after it ended is in no trip, by a millisecond', () => {
    const done = [trip('a', 0, 60)];
    expect(tripAt(done, NOW - 1)).toBeNull();
    expect(tripAt(done, NOW + 60 * 60_000 + 1)).toBeNull();
    expect(find([], 5)).toBeNull();
  });

  test('a trip still under way has no end', () => {
    expect(find([trip('open', 0, null)], 10_000)).toBe('open');
    expect(find([trip('open', 0, null)], -1)).toBeNull();
  });

  test('picks among several the trip that fits, and the later start when two overlap', () => {
    const trips = [trip('first', 0, 60), trip('second', 120, 180), trip('third', 150, null)];
    expect(find(trips, 30)).toBe('first');
    expect(find(trips, 90)).toBeNull(); // between trips
    expect(find(trips, 130)).toBe('second');
    expect(find(trips, 160)).toBe('third'); // second ran on while third had begun
    expect(find([trip('x', 0, 60), trip('y', 60, 120)], 60)).toBe('y'); // one closed as the next began
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

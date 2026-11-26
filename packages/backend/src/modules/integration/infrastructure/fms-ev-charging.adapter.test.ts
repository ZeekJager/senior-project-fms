import { describe, expect, test } from 'vitest';
import { WebhookPayloadError } from '../domain/adapter';
import { fmsEvChargingAdapter } from './fms-ev-charging.adapter';

// FMS-97: the FMS EV charging webhook format, which the simulated network and any real network without an adapter of
// its own speak (docs/ev.md#the-charging-webhook).

const body = {
  event_id: 'evt-1',
  type: 'session_completed',
  occurred_at: '2026-11-26T18:40:00+03:00',
  session: {
    session_id: 's-1',
    vehicle_id: '5d0a8b4e-6f9c-4b0e-9a37-2f1c3e4d5a6b',
    station_id: 'ST-1',
    started_at: '2026-11-26T17:30:00+03:00',
    ended_at: '2026-11-26T18:40:00+03:00',
    energy_kwh: 41.2,
    cost_cents: 49440,
    start_soc: 18,
    end_soc: 80,
  },
};

function refusal(adapter: ReturnType<typeof fmsEvChargingAdapter>, input: unknown): { field: string; reason: string } {
  try {
    adapter.normalize!(input);
  } catch (err) {
    if (err instanceof WebhookPayloadError) return { field: err.field, reason: err.reason };
    throw err;
  }
  throw new Error('normalize accepted the body');
}

describe('the FMS EV charging adapter', () => {
  test('reads a session event: the event id is the de-duplication key, the session the data', () => {
    const normalized = fmsEvChargingAdapter('chargenet-et').normalize!(body);
    expect(normalized).toEqual({ eventId: 'evt-1', kind: 'session_completed', occurredAt: new Date('2026-11-26T15:40:00Z'), data: { session: body.session, synthetic: false } });
  });

  test('the simulated network’s deliveries are synthetic; any other provider’s are not', () => {
    expect(fmsEvChargingAdapter('simulated').normalize!(body).data.synthetic).toBe(true);
    expect(fmsEvChargingAdapter('chargenet-et').normalize!(body).data.synthetic).toBe(false);
  });

  test('a body it cannot read names the field', () => {
    const adapter = fmsEvChargingAdapter('chargenet-et');
    expect(refusal(adapter, { ...body, type: 'session_paused' })).toMatchObject({ field: 'type' });
    expect(refusal(adapter, { ...body, session: { ...body.session, vehicle_id: 'KA-123' } })).toMatchObject({ field: 'session.vehicle_id' });
    expect(refusal(adapter, { ...body, session: { ...body.session, cost_cents: 12.5 } })).toMatchObject({ field: 'session.cost_cents' });
    expect(refusal(adapter, { ...body, session: { ...body.session, end_soc: 120 } })).toMatchObject({ field: 'session.end_soc' });
    expect(refusal(adapter, { ...body, extra: 1 })).toEqual({ field: 'body', reason: 'not_expected' });
  });
});

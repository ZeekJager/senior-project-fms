import { describe, expect, test } from 'vitest';
import { createEvent, type DomainEvent } from './domain-event';
import { InProcessEventBus } from './in-process-event-bus';

const ctx = { actor: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', correlationId: '9b2c6f1e-2a4d-4c1b-8e7f-0a1b2c3d4e5f' };

describe('InProcessEventBus', () => {
  test('delivers each event to the handlers of its type, in order', async () => {
    const bus = new InProcessEventBus(() => {});
    const seen: string[] = [];
    bus.subscribe('VehicleRegistered', (e) => {
      seen.push(`a:${e.type}`);
    });
    bus.subscribe('VehicleRegistered', (e) => {
      seen.push(`b:${e.type}`);
    });
    bus.subscribe('VehicleRetired', (e) => {
      seen.push(`c:${e.type}`);
    });

    await bus.publish([createEvent('VehicleRegistered', {}, ctx), createEvent('VehicleRetired', {}, ctx), createEvent('Unheard', {}, ctx)]);
    expect(seen).toEqual(['a:VehicleRegistered', 'b:VehicleRegistered', 'c:VehicleRetired']);
  });

  test('a failing handler is reported and does not stop the others or the publish', async () => {
    const errors: [unknown, DomainEvent][] = [];
    const bus = new InProcessEventBus((err, event) => errors.push([err, event]));
    const seen: string[] = [];
    bus.subscribe('VehicleUpdated', () => {
      throw new Error('consumer bug');
    });
    bus.subscribe('VehicleUpdated', () => {
      seen.push('second');
    });

    const event = createEvent('VehicleUpdated', { vehicle_id: 'v' }, ctx);
    await expect(bus.publish([event])).resolves.toBeUndefined();
    expect(seen).toEqual(['second']);
    expect(errors).toHaveLength(1);
    expect(errors[0][1]).toBe(event);
  });

  test('unsubscribe removes the handler', async () => {
    const bus = new InProcessEventBus(() => {});
    let calls = 0;
    const off = bus.subscribe('VehicleRetired', () => {
      calls++;
    });
    off();
    await bus.publish([createEvent('VehicleRetired', {}, ctx)]);
    expect(calls).toBe(0);
  });
});

describe('createEvent', () => {
  test('builds the CONVENTIONS envelope', () => {
    const event = createEvent('VehicleRegistered', { vehicle_id: 'v' }, ctx);
    expect(event).toMatchObject({ type: 'VehicleRegistered', version: 1, actor: ctx.actor, correlation_id: ctx.correlationId, payload: { vehicle_id: 'v' } });
    expect(event.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(event.occurred_at).toISOString()).toBe(event.occurred_at);
    expect(createEvent('VehicleRegistered', {}, ctx).id).not.toBe(event.id);
  });
});

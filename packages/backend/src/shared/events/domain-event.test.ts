import { describe, expect, test } from 'vitest';
import { aggregateKey, createEvent, deterministicEventId, envelopeOf } from './domain-event';
import { SubscriberRegistry } from './subscribers';

const ctx = { actor: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', correlationId: '9b2c6f1e-2a4d-4c1b-8e7f-0a1b2c3d4e5f' };

describe('createEvent', () => {
  test('builds the CONVENTIONS envelope', () => {
    const event = createEvent('VehicleRegistered', { vehicle_id: 'v' }, ctx);
    expect(event).toMatchObject({ type: 'VehicleRegistered', version: 1, actor: ctx.actor, correlation_id: ctx.correlationId, payload: { vehicle_id: 'v' }, aggregate: null });
    expect(event.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(event.occurred_at).toISOString()).toBe(event.occurred_at);
    expect(createEvent('VehicleRegistered', {}, ctx).id).not.toBe(event.id);
  });

  test('carries the aggregate for the outbox, but not onto the published envelope', () => {
    const event = createEvent('VehicleRetired', { vehicle_id: 'v' }, ctx, { aggregate: aggregateKey('vehicle', 'v') });
    expect(event.aggregate).toBe('vehicle:v');
    expect(envelopeOf(event)).not.toHaveProperty('aggregate');
    expect(Object.keys(envelopeOf(event)).sort()).toEqual(['actor', 'correlation_id', 'id', 'occurred_at', 'payload', 'type', 'version']);
  });

  test('a deterministic id is a stable UUID per name', () => {
    expect(deterministicEventId('DocumentExpiring:d:2026-11-01:red')).toBe(deterministicEventId('DocumentExpiring:d:2026-11-01:red'));
    expect(deterministicEventId('a')).not.toBe(deterministicEventId('b'));
    expect(deterministicEventId('a')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('SubscriberRegistry', () => {
  test('names consumers <module>.<purpose>, once per event type', () => {
    const registry = new SubscriberRegistry();
    registry.subscribe('VehicleRetired', 'fleet.vehicle-cache', () => {});
    registry.subscribe('VehicleRetired', 'trip.reassign', () => {});
    registry.subscribe('VehicleUpdated', 'fleet.vehicle-cache', () => {});
    expect(registry.consumersOf('VehicleRetired')).toEqual(['fleet.vehicle-cache', 'trip.reassign']);

    expect(() => registry.subscribe('VehicleRetired', 'fleet.vehicle-cache', () => {})).toThrow(/already subscribes/);
    for (const bad of ['vehicleCache', 'fleet', 'Fleet.cache', 'fleet.vehicle cache']) {
      expect(() => registry.subscribe('VehicleRetired', bad, () => {}), bad).toThrow(/<module>.<purpose>/);
    }
  });

  test('unsubscribe removes only that consumer', () => {
    const registry = new SubscriberRegistry();
    const off = registry.subscribe('VehicleRetired', 'fleet.vehicle-cache', () => {});
    registry.subscribe('VehicleRetired', 'trip.reassign', () => {});
    off();
    expect(registry.consumersOf('VehicleRetired')).toEqual(['trip.reassign']);
    // Free again once removed.
    registry.subscribe('VehicleRetired', 'fleet.vehicle-cache', () => {});
  });
});

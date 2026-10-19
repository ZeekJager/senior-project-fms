import type { PoolClient } from 'pg';
import { describe, expect, test } from 'vitest';
import { createEvent, type DomainEvent } from './domain-event';
import { ProjectionRegistry } from './projections';

const tx = {} as PoolClient;
const ctx = { actor: null, correlationId: '00000000-0000-4000-8000-000000000001' };
const event = (type: string, n: number): DomainEvent => createEvent(type, { n }, ctx);

describe('projections (in the publishing transaction)', () => {
  test('each event, in order, to each projection of its type, in registration order, on the same client', async () => {
    const registry = new ProjectionRegistry();
    const seen: string[] = [];
    registry.register('TripUpdated', 'fleet.first', (e, client) => {
      expect(client).toBe(tx);
      seen.push(`first:${e.payload.n}`);
    });
    registry.register('TripUpdated', 'fleet.second', (e) => {
      seen.push(`second:${e.payload.n}`);
    });
    registry.register('TripCancelled', 'fleet.first', (e) => {
      seen.push(`cancelled:${e.payload.n}`);
    });
    await registry.apply(tx, [event('TripUpdated', 1), event('TripCancelled', 2), event('RouteCreated', 3)]);
    expect(seen).toEqual(['first:1', 'second:1', 'cancelled:2']);
  });

  test('a failing projection fails the publish, so the change rolls back with it', async () => {
    const registry = new ProjectionRegistry();
    registry.register('TripUpdated', 'fleet.broken', () => {
      throw new Error('read model write failed');
    });
    await expect(registry.apply(tx, [event('TripUpdated', 1)])).rejects.toThrow('read model write failed');
  });

  test('names are <module>.<purpose>, once per event type; the returned function removes it', () => {
    const registry = new ProjectionRegistry();
    expect(() => registry.register('TripUpdated', 'TripAssignments', () => {})).toThrow('<module>.<purpose>');
    const remove = registry.register('TripUpdated', 'fleet.trip-assignments', () => {});
    expect(() => registry.register('TripUpdated', 'fleet.trip-assignments', () => {})).toThrow('already projects');
    expect(registry.namesOf('TripUpdated')).toEqual(['fleet.trip-assignments']);
    remove();
    expect(registry.namesOf('TripUpdated')).toEqual([]);
  });
});

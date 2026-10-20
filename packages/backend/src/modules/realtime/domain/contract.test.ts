import { describe, expect, it } from 'vitest';
import { deliveriesFor, FORWARDED_TYPES, isStale, roomsFor, roomsOf, SESSION_EVENTS, type EventEnvelope, type SocketIdentity } from './contract';
import { cookieValue, originAllowed, RateLimit } from './handshake';

const DEPOT_A = 'a0000000-0000-4000-8000-00000000000a';
const DEPOT_B = 'b0000000-0000-4000-8000-00000000000b';

const identity = (overrides: Partial<SocketIdentity>): SocketIdentity => ({ userId: 'u1', permissions: [], depots: { kind: 'none' }, driver: null, ...overrides });

const envelope = (type: string, payload: Record<string, unknown>, occurredAt = new Date().toISOString()): EventEnvelope => ({
  id: 'e1',
  type,
  version: 1,
  occurred_at: occurredAt,
  actor: null,
  correlation_id: null,
  payload,
});

const noTrips = { tripSummary: async () => null };

describe('rooms (FMS-43)', () => {
  it('an admin joins every channel it may read for all depots, and its own user room', () => {
    const rooms = roomsFor(identity({ permissions: ['tracking:read', 'vehicle:read', 'trip:read', 'alert:read', 'incident:read'], depots: { kind: 'all' } }));
    expect(rooms.sort()).toEqual(['alerts:all', 'incidents:all', 'tracking:all', 'trips:all', 'user:u1', 'vehicles:all']);
  });

  it("a dispatcher joins only its depot's rooms, and only for what it may read", () => {
    expect(roomsFor(identity({ permissions: ['tracking:read', 'trip:read'], depots: { kind: 'depot', depotId: DEPOT_A } }))).toEqual([
      'user:u1',
      `tracking:depot:${DEPOT_A}`,
      `trips:depot:${DEPOT_A}`,
    ]);
  });

  it("a driver gets their own trips and their depot's vehicles, never depot-wide trips or incidents", () => {
    const rooms = roomsFor(
      identity({ permissions: ['vehicle:read', 'trip:read', 'incident:read'], depots: { kind: 'depot', depotId: DEPOT_A }, driver: { driverId: 'd1' } }),
    );
    expect(rooms).toEqual(['user:u1', `vehicles:depot:${DEPOT_A}`, 'trips:driver:d1']);
  });

  it('nobody to place (no depot, no driver profile) gets only the user room', () => {
    expect(roomsFor(identity({ permissions: ['trip:read', 'vehicle:read'], driver: { driverId: null } }))).toEqual(['user:u1']);
    expect(roomsFor(identity({ permissions: ['vehicle:read'] }))).toEqual(['user:u1']);
  });

  it('a delivery goes to the all-depot room, its depot, and the drivers it names', () => {
    expect(roomsOf({ event: 'trip.updated', channel: 'trips', payload: {}, depotId: DEPOT_B, driverIds: ['d1', 'd2'] })).toEqual([
      'trips:all',
      `trips:depot:${DEPOT_B}`,
      'trips:driver:d1',
      'trips:driver:d2',
    ]);
    expect(roomsOf({ event: 'alert.created', channel: 'alerts', payload: {}, depotId: null })).toEqual(['alerts:all']);
  });
});

describe('event mapping (api-contract §11.2)', () => {
  it('VehicleStatusChanged becomes vehicle.status.changed for the vehicle depot', async () => {
    const [d] = await deliveriesFor(
      envelope('VehicleStatusChanged', { vehicle_id: 'v1', depot_id: DEPOT_A, previous_status: 'active', new_status: 'maintenance', reason: 'Brakes', source: 'manual', changed_at: '2026-10-20T10:00:00Z' }),
      noTrips,
    );
    expect(d).toEqual({
      event: 'vehicle.status.changed',
      channel: 'vehicles',
      depotId: DEPOT_A,
      payload: { vehicle_id: 'v1', status: 'maintenance', previous_status: 'active', reason: 'Brakes', source: 'manual', changed_at: '2026-10-20T10:00:00Z' },
    });
  });

  it('VehicleLocationUpdated becomes vehicle.location.updated and the legacy vehicle_position, for tracking only', async () => {
    const ds = await deliveriesFor(
      envelope('VehicleLocationUpdated', { vehicle_id: 'v1', depot_id: DEPOT_A, trip_id: 't1', lat: 9.03, lng: 38.74, speed: 54.5, heading: 90, recorded_at: '2026-10-20T10:00:01Z' }),
      noTrips,
    );
    expect(ds.map((d) => [d.event, d.channel, d.depotId])).toEqual([
      ['vehicle.location.updated', 'tracking', DEPOT_A],
      ['vehicle_position', 'tracking', DEPOT_A],
    ]);
    expect(ds[0].payload).toEqual({ vehicle_id: 'v1', lat: 9.03, lng: 38.74, speed: 54.5, heading: 90, recorded_at: '2026-10-20T10:00:01Z' });
    expect(ds[1].payload).toEqual({ vehicleId: 'v1', tripId: 't1', lat: 9.03, lng: 38.74, speedKmh: 54.5, bearing: 90, lastSeen: '2026-10-20T10:00:01Z' });
    expect(await deliveriesFor(envelope('VehicleLocationUpdated', { vehicle_id: 'v1', lat: 'x', lng: 38 }), noTrips)).toEqual([]);
  });

  it('AlertCreated becomes alert.created and the legacy alert_created; acknowledge and resolve become alert.updated', async () => {
    const created = await deliveriesFor(
      envelope('AlertCreated', { alert_id: 'a1', depot_id: DEPOT_B, alert_type: 'speeding', severity: 'high', status: 'open', entity_type: 'vehicle', entity_id: 'v1', message: 'Over 80 km/h', internal: 'x' }),
      noTrips,
    );
    expect(created.map((d) => d.event)).toEqual(['alert.created', 'alert_created']);
    expect(created[0].payload).not.toHaveProperty('internal');
    expect(created[1].payload).toEqual({ alertType: 'speeding', entityId: 'v1', message: 'Over 80 km/h', severity: 'high' });
    const [acked] = await deliveriesFor(envelope('AlertAcknowledged', { alert_id: 'a1', depot_id: DEPOT_B, status: 'acknowledged', acknowledged_at: 'now' }), noTrips);
    expect(acked).toMatchObject({ event: 'alert.updated', channel: 'alerts', payload: { alert_id: 'a1', status: 'acknowledged', acknowledged_at: 'now' } });
  });

  it('IncidentReported becomes incident.created', async () => {
    const [d] = await deliveriesFor(envelope('IncidentReported', { incident_id: 'i1', depot_id: DEPOT_A, vehicle_id: 'v1', severity: 'critical', description: 'free text' }), noTrips);
    expect(d).toMatchObject({ event: 'incident.created', channel: 'incidents', depotId: DEPOT_A, payload: { incident_id: 'i1', vehicle_id: 'v1', severity: 'critical' } });
    expect(d.payload).not.toHaveProperty('description');
  });

  it('every trip event becomes a trip update carrying the trip as it is now, for its depot, its driver and the driver it lost', async () => {
    const lookups = { tripSummary: async (id: string) => ({ trip_id: id, status: 'assigned', depot_id: DEPOT_A, driver_id: 'd2', version: 4 }) };
    const [d] = await deliveriesFor(envelope('TripAssigned', { trip_id: 't1', driver_id: 'd2', previous_driver_id: 'd1' }), lookups);
    expect(d).toEqual({
      event: 'trip.updated',
      channel: 'trips',
      depotId: DEPOT_A,
      driverIds: ['d2', 'd1'],
      payload: { trip_id: 't1', status: 'assigned', depot_id: DEPOT_A, driver_id: 'd2', version: 4, change: 'TripAssigned' },
    });
    for (const type of ['TripCreated', 'TripUpdated', 'TripCancelled', 'TripStarted', 'TripCompleted']) {
      expect((await deliveriesFor(envelope(type, { trip_id: 't1' }), lookups))[0].event).toBe('trip.updated');
    }
    // A trip that no longer exists: nothing to say.
    expect(await deliveriesFor(envelope('TripUpdated', { trip_id: 't9' }), noTrips)).toEqual([]);
  });

  it('anything else is not forwarded; account events close sessions instead', async () => {
    expect(await deliveriesFor(envelope('FuelLogged', { fuel_log_id: 'f1' }), noTrips)).toEqual([]);
    expect(FORWARDED_TYPES).not.toContain('FuelLogged');
    expect(SESSION_EVENTS).toEqual(['UserDeactivated', 'UserRoleChanged', 'UserAccountChanged']);
  });

  it('a late event is dropped: a position after 30 s, anything else after 5 minutes', () => {
    const now = Date.parse('2026-10-20T10:10:00Z');
    expect(isStale(envelope('VehicleLocationUpdated', {}, '2026-10-20T10:09:20Z'), now)).toBe(true);
    expect(isStale(envelope('VehicleLocationUpdated', {}, '2026-10-20T10:09:40Z'), now)).toBe(false);
    expect(isStale(envelope('TripStarted', {}, '2026-10-20T10:06:00Z'), now)).toBe(false);
    expect(isStale(envelope('TripStarted', {}, '2026-10-20T10:04:00Z'), now)).toBe(true);
  });
});

describe('handshake rules', () => {
  it('origin: none, the same host, or the allow-list; anything else is refused', () => {
    const allow = ['http://localhost:5173'];
    expect(originAllowed(undefined, 'api.fms.local', allow)).toBe(true);
    expect(originAllowed('https://api.fms.local', 'api.fms.local', allow)).toBe(true);
    expect(originAllowed('http://localhost:5173', 'localhost:3000', allow)).toBe(true);
    expect(originAllowed('https://evil.example', 'api.fms.local', allow)).toBe(false);
    expect(originAllowed('http://localhost:5174', 'localhost:3000', allow)).toBe(false);
    expect(originAllowed('null', 'localhost:3000', allow)).toBe(false);
  });

  it('reads one cookie from the header', () => {
    expect(cookieValue('a=1; fms_access=tok.en%3D; b=2', 'fms_access')).toBe('tok.en=');
    expect(cookieValue('fms_access_old=x', 'fms_access')).toBeUndefined();
    expect(cookieValue(undefined, 'fms_access')).toBeUndefined();
  });

  it('rate limit: a burst, then the steady rate', () => {
    let t = 0;
    const limit = new RateLimit(5, 1, () => t);
    expect(Array.from({ length: 7 }, () => limit.take())).toEqual([true, true, true, true, true, false, false]);
    t = 1000;
    expect(limit.take()).toBe(true);
    expect(limit.take()).toBe(false);
  });
});

// The real-time event contract (api-contract §11.2, FMS-43): which domain
// events become which socket events, with what payload, for whom. Pure, so
// it is unit-tested apart from Socket.IO.

/** Where the socket server answers: under the API's prefix, so every proxy that forwards /api forwards it. */
export const SOCKET_PATH = '/api/v1/socket.io';

/** Server -> client event names (api-contract §11.2), canonical then legacy aliases. */
export const SOCKET_EVENTS = {
  locationUpdated: 'vehicle.location.updated',
  statusChanged: 'vehicle.status.changed',
  alertCreated: 'alert.created',
  alertUpdated: 'alert.updated',
  /** The user's unread in-app notification count changed (FMS-48): to that user's own sockets only. */
  notificationsUnread: 'notifications.unread',
  incidentCreated: 'incident.created',
  tripUpdated: 'trip.updated',
  flagChanged: 'vehicle.flag.changed',
  /** Legacy alias of vehicle.location.updated. */
  legacyPosition: 'vehicle_position',
  /** Legacy alias of alert.created. */
  legacyAlertCreated: 'alert_created',
} as const;

/** Client -> server: the legacy location event, accepted only when enabled (REALTIME_LEGACY_LOCATION). */
export const LEGACY_LOCATION_EVENT = 'location_update';

/**
 * A stream of events and the permission that opens it. Who may see it is
 * the API's own rule for the same data: depot scope for staff; for a driver,
 * their own trips only (and no depot-wide trips or incidents).
 */
export const CHANNELS = {
  tracking: { permission: 'tracking:read', driverOwn: false },
  vehicles: { permission: 'vehicle:read', driverOwn: false },
  alerts: { permission: 'alert:read', driverOwn: false },
  trips: { permission: 'trip:read', driverOwn: true },
  incidents: { permission: 'incident:read', driverOwn: true },
} as const;

export type Channel = keyof typeof CHANNELS;

/** Who is on a socket, in public ids: decided once at the handshake. */
export interface SocketIdentity {
  userId: string;
  permissions: readonly string[];
  /** As depotScope: every depot, one (its public id), or none. */
  depots: { kind: 'all' } | { kind: 'depot'; depotId: string } | { kind: 'none' };
  /** Set for a user who is only a driver (ownDriverScope): their driver profile's public id, or null without one. */
  driver: { driverId: string | null } | null;
}

export const userRoom = (userId: string) => `user:${userId}`;
const allRoom = (channel: Channel) => `${channel}:all`;
const depotRoom = (channel: Channel, depotId: string) => `${channel}:depot:${depotId}`;
const driverRoom = (channel: Channel, driverId: string) => `${channel}:driver:${driverId}`;

/** The rooms a socket joins: its user, and per channel it may read, all depots, its depot, or (a driver) its own records. */
export function roomsFor(identity: SocketIdentity): string[] {
  const rooms = [userRoom(identity.userId)];
  for (const [channel, rule] of Object.entries(CHANNELS) as [Channel, (typeof CHANNELS)[Channel]][]) {
    if (!identity.permissions.includes(rule.permission)) continue;
    if (identity.driver) {
      // A driver's trips and the incidents they reported are their own; depot-wide ones are not theirs to watch.
      if (rule.driverOwn) {
        if (identity.driver.driverId) rooms.push(driverRoom(channel, identity.driver.driverId));
        continue;
      }
    }
    if (identity.depots.kind === 'all') rooms.push(allRoom(channel));
    else if (identity.depots.kind === 'depot') rooms.push(depotRoom(channel, identity.depots.depotId));
  }
  return rooms;
}

/**
 * One socket event to send, and to whom. Either a channel's audience (its all-depot room, the event's depot, the
 * drivers named) or particular users (`userIds`: their own rooms, which only their own sockets join). A delivery
 * with only `userIds` reaches nobody else, whatever their permissions.
 */
export interface Delivery {
  event: string;
  /** The channel whose readers receive it; omitted for a delivery to named users only. */
  channel?: Channel;
  payload: Record<string, unknown>;
  depotId?: string | null;
  driverIds?: readonly string[];
  /** Public ids of the users whose sockets receive it. */
  userIds?: readonly string[];
}

/** The rooms a delivery goes to. A socket in several of them receives it once. */
export function roomsOf(delivery: Delivery): string[] {
  const rooms: string[] = [];
  if (delivery.channel) {
    rooms.push(allRoom(delivery.channel));
    if (delivery.depotId) rooms.push(depotRoom(delivery.channel, delivery.depotId));
    for (const driverId of delivery.driverIds ?? []) rooms.push(driverRoom(delivery.channel, driverId));
  }
  for (const userId of delivery.userIds ?? []) rooms.push(userRoom(userId));
  return rooms;
}

/** The envelope on Redis (docs/events.md): what the gateway reads. */
export interface EventEnvelope {
  id: string;
  type: string;
  version: number;
  occurred_at: string;
  actor: string | null;
  correlation_id: string | null;
  payload: Record<string, unknown>;
}

/** What a forwarder may look up: the API's current view, never more than the event names. */
export interface ForwardLookups {
  /** The trip as `trip.updated` sends it (the trip module's TripSummary); who gets it follows its depot and driver. */
  tripSummary(tripId: string): Promise<{ depot_id: string | null; driver_id: string | null } | null>;
}

type Forwarder = (event: EventEnvelope, lookups: ForwardLookups) => Promise<Delivery[]> | Delivery[];

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pick = (from: Record<string, unknown>, keys: readonly string[]) => Object.fromEntries(keys.filter((k) => k in from).map((k) => [k, from[k]]));

/** The trip events (TRIP_EVENTS): each becomes `trip.updated` with the trip as it is now. */
const TRIP_TYPES = ['TripCreated', 'TripUpdated', 'TripCancelled', 'TripAssigned', 'TripStarted', 'TripCompleted'] as const;

const tripUpdated: Forwarder = async (event, lookups) => {
  const tripId = str(event.payload.trip_id);
  const summary = tripId ? await lookups.tripSummary(tripId) : null;
  if (!summary) return [];
  // The driver it is assigned to now, and one it was taken from or cancelled for.
  const driverIds = [...new Set([summary.driver_id, str(event.payload.previous_driver_id), str(event.payload.driver_id)].filter((d): d is string => d !== null))];
  return [{ event: SOCKET_EVENTS.tripUpdated, channel: 'trips', depotId: summary.depot_id, driverIds, payload: { ...summary, change: event.type } }];
};

const FORWARDERS: Record<string, Forwarder> = {
  VehicleStatusChanged: (e) => [
    {
      event: SOCKET_EVENTS.statusChanged,
      channel: 'vehicles',
      depotId: str(e.payload.depot_id),
      payload: { vehicle_id: e.payload.vehicle_id, status: e.payload.new_status, previous_status: e.payload.previous_status, reason: e.payload.reason ?? null, source: e.payload.source ?? null, changed_at: e.payload.changed_at ?? e.occurred_at },
    },
  ],
  // Published by GPS ingestion (FMS-88): vehicle_id, depot_id, lat, lng, speed, heading, recorded_at, trip_id.
  VehicleLocationUpdated: (e) => {
    const lat = num(e.payload.lat);
    const lng = num(e.payload.lng);
    if (lat === null || lng === null || !str(e.payload.vehicle_id)) return [];
    const depotId = str(e.payload.depot_id);
    const speed = num(e.payload.speed);
    const heading = num(e.payload.heading);
    const recordedAt = str(e.payload.recorded_at) ?? e.occurred_at;
    return [
      { event: SOCKET_EVENTS.locationUpdated, channel: 'tracking', depotId, payload: { vehicle_id: e.payload.vehicle_id, lat, lng, speed, heading, recorded_at: recordedAt } },
      {
        event: SOCKET_EVENTS.legacyPosition,
        channel: 'tracking',
        depotId,
        payload: { vehicleId: e.payload.vehicle_id, tripId: str(e.payload.trip_id), lat, lng, speedKmh: speed, bearing: heading, lastSeen: recordedAt },
      },
    ];
  },
  // Published by the telemetry rules (FMS-46): a speeding or idling flag opened or closed. The live map
  // re-reads its snapshot on it. No driver: the flag names the vehicle and trip.
  TelemetryFlagRaised: (e) => [flagChanged(e, 'raised')],
  TelemetryFlagResolved: (e) => [flagChanged(e, 'resolved')],
  // Published by the alert engine (FMS-92): alert_id, depot_id, alert_type, severity, priority, status, entity_type, entity_id, title, message.
  AlertCreated: (e) => {
    const depotId = str(e.payload.depot_id);
    return [
      {
        event: SOCKET_EVENTS.alertCreated,
        channel: 'alerts',
        depotId,
        payload: pick(e.payload, ['alert_id', 'alert_type', 'severity', 'priority', 'status', 'entity_type', 'entity_id', 'vehicle_id', 'title', 'message', 'created_at']),
      },
      {
        event: SOCKET_EVENTS.legacyAlertCreated,
        channel: 'alerts',
        depotId,
        payload: { alertType: e.payload.alert_type ?? null, entityId: e.payload.entity_id ?? null, message: e.payload.message ?? null, severity: e.payload.severity ?? null },
      },
    ];
  },
  // Published by the inbox (FMS-48): user_id (public), unread_count, reason, changed_at. To that user's sockets and no one else's.
  NotificationUnreadChanged: (e) => {
    const userId = str(e.payload.user_id);
    const count = num(e.payload.unread_count);
    if (!userId || count === null) return [];
    return [
      {
        event: SOCKET_EVENTS.notificationsUnread,
        userIds: [userId],
        payload: { unread_count: count, reason: str(e.payload.reason), changed_at: str(e.payload.changed_at) ?? e.occurred_at },
      },
    ];
  },
  // A repeat of the source (one more occurrence) and an escalation are patches like acknowledge and resolve.
  AlertUpdated: (e) => [alertPatch(e)],
  AlertAcknowledged: (e) => [alertPatch(e)],
  AlertResolved: (e) => [alertPatch(e)],
  AlertEscalated: (e) => [alertPatch(e)],
  // Published by incident reporting (FMS-38): to the incident's depot, and to the driver who reported it.
  IncidentReported: (e) => {
    const reporter = str(e.payload.reported_by_driver_id);
    return [
      {
        event: SOCKET_EVENTS.incidentCreated,
        channel: 'incidents',
        depotId: str(e.payload.depot_id),
        ...(reporter ? { driverIds: [reporter] } : {}),
        payload: pick(e.payload, ['incident_id', 'vehicle_id', 'trip_id', 'severity', 'incident_type', 'status', 'latitude', 'longitude', 'occurred_at']),
      },
    ];
  },
  ...Object.fromEntries(TRIP_TYPES.map((type) => [type, tripUpdated])),
};

function flagChanged(e: EventEnvelope, change: 'raised' | 'resolved'): Delivery {
  return {
    event: SOCKET_EVENTS.flagChanged,
    channel: 'tracking',
    depotId: str(e.payload.depot_id),
    payload: { ...pick(e.payload, ['flag_id', 'vehicle_id', 'trip_id', 'flag_type', 'severity', 'observed_at']), resolved_at: str(e.payload.resolved_at), change },
  };
}

function alertPatch(e: EventEnvelope): Delivery {
  return {
    event: SOCKET_EVENTS.alertUpdated,
    channel: 'alerts',
    depotId: str(e.payload.depot_id),
    payload: pick(e.payload, [
      'alert_id',
      'status',
      'severity',
      'priority',
      'occurrence_count',
      'last_occurred_at',
      'escalation_level',
      'escalated_at',
      'acknowledged_at',
      'acknowledged_by',
      'resolved_at',
      'resolved_by',
    ]),
  };
}

/** Domain event types the gateway turns into socket events. */
export const FORWARDED_TYPES: readonly string[] = Object.keys(FORWARDERS);

/**
 * Account events after which a user's open sockets are closed: the client
 * reconnects, and the handshake decides again (a deactivated account is
 * refused, a new role or depot gets its rooms).
 */
export const SESSION_EVENTS: readonly string[] = ['UserDeactivated', 'UserRoleChanged', 'UserAccountChanged'];

/**
 * Events are hints (docs/events.md): one delivered late, after a Redis
 * outage, is dropped. A position is stale after 30 seconds; anything else
 * after 5 minutes, since a client reloads its state when it reconnects.
 */
export function isStale(event: EventEnvelope, now: number): boolean {
  const age = now - Date.parse(event.occurred_at);
  return age > (event.type === 'VehicleLocationUpdated' ? 30_000 : 300_000);
}

/** What to send for a domain event: nothing for a type the contract does not forward. */
export async function deliveriesFor(event: EventEnvelope, lookups: ForwardLookups): Promise<Delivery[]> {
  const forward = FORWARDERS[event.type];
  return forward ? forward(event, lookups) : [];
}

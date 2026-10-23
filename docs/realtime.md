# Real-time: Socket.IO gateway

Card: FMS-43 (SE-79). Code: `packages/backend/src/modules/realtime/` (server), `packages/frontend/src/lib/realtime/` (client). Contract: [api-contract §11.2](api-contract.md#112-real-time-socketio-event-contract).

Sockets push fleet changes to open screens: server to client only. Writes stay on the REST API. Telemetry comes in over REST and webhooks, except for the legacy `location_update` event (below).

## How an event reaches a browser

```text
service ──► events.outbox ──► relay ──► Redis PUBLISH <prefix>:events:<Type>
                                              │
              every API instance: PSUBSCRIBE <prefix>:events:*
                                              │
              gateway: is the type forwarded? to which rooms? (contract.ts)
                                              │
              io.local.to(rooms).emit(...)  ──►  this instance's sockets
```

- **Every instance hears every event** and sends it only to its own sockets (`io.local`). A socket on any instance gets it once.
- **The Redis adapter** (`@socket.io/redis-adapter`, key `<prefix>:socket.io`) joins the instances. Operations that must reach every instance, such as closing all of one user's sockets, then work wherever they start.
- **Without Redis** (development, one instance), `src/server.ts` gives the outbox relay a local broadcaster, which hands each committed event to this instance's sockets. Production requires Redis (config).
- **Events are hints, not records** ([events.md](events.md#redis-channels)). A client that reconnects reloads its screens over the API. Events delivered late are dropped: a position after 30 seconds, anything else after 5 minutes.

## Connecting

- **Path:** `/api/v1/socket.io`, on the API's own HTTP server and port. Every proxy that forwards `/api` must also forward WebSocket upgrades on this path. The Vite dev server has its own entry for it, which keeps the browser's Host header.
- **Session:** the access cookie (`fms_access`) on the handshake, checked as the REST API checks it: signature, expiry, account active, session not revoked. A refused handshake gets `connect_error` with the error code as its message (`AUTH_TOKEN_INVALID`, `AUTH_TOKEN_EXPIRED`, `AUTH_TOKEN_REVOKED`, `AUTH_ACCOUNT_DISABLED`) and the error body in `data`.
- **Origin** (cross-site WebSocket hijacking):
  - no `Origin` header: allowed. Browsers send it on every WebSocket and every cross-origin request, so its absence means a same-origin request or a non-browser client. The cookie is still required.
  - the API's own host: allowed.
  - an origin listed in `REALTIME_ALLOWED_ORIGINS` (comma-separated, for a web host on another origin): allowed.
  - anything else: refused before any session lookup.
- **Expiry:** the server closes a socket when its access token expires (15 minutes), and when the account is deactivated or its roles or account change (`UserDeactivated`, `UserRoleChanged`, `UserAccountChanged`). The client renews the session and reconnects, and the handshake decides again.

## Who receives what

At the handshake the socket joins one room per channel it may read. The rooms follow the API's own rules for the same data.

| Channel | Permission | Staff | Driver (only a driver) |
|---|---|---|---|
| `tracking` | `tracking:read` | all depots, or their depot | no (drivers lack the permission) |
| `vehicles` | `vehicle:read` | all depots, or their depot | their depot |
| `alerts` | `alert:read` | all depots, or their depot | no |
| `trips` | `trip:read` | all depots, or their depot | their own trips only |
| `incidents` | `incident:read` | all depots, or their depot | the incidents they reported (`reported_by_driver_id`) |

"All depots" means the depot-unscoped roles: admin, fleet manager, fleet owner and compliance officer. A depot-scoped user with no depot joins no depot rooms. Every socket also joins `user:<public id>`, which is used to close it and to send that user something meant for them alone: `notifications.unread` (below) goes only to that room, so no channel permission, depot or role reaches it.

## Event mapping

| Domain event | Socket event(s) | Channel | Payload |
|---|---|---|---|
| `VehicleStatusChanged` | `vehicle.status.changed` | vehicles | `vehicle_id`, `status`, `previous_status`, `reason`, `source`, `changed_at` |
| `TripCreated`, `TripUpdated`, `TripCancelled`, `TripAssigned`, `TripStarted`, `TripCompleted` | `trip.updated` | trips | The trip as it is now: `trip_id`, `status`, `route_name`, `depot_id`, `vehicle_id`, `driver_id`, schedule, actual times, `version`, `updated_at`, plus `change` (the event type). It goes to the trip's depot, its driver, and a driver it was taken from. |
| `VehicleLocationUpdated` (published since FMS-88, at most one per vehicle per 5 s) | `vehicle.location.updated`, legacy `vehicle_position` | tracking | `vehicle_id`, `lat`, `lng`, `speed`, `heading`, `recorded_at`; legacy: `vehicleId`, `tripId`, `lat`, `lng`, `speedKmh`, `bearing`, `lastSeen` |
| `AlertCreated` (published since FMS-92, docs/alerts.md) | `alert.created`, legacy `alert_created` | alerts | `alert_id`, `alert_type`, `severity`, `priority`, `status`, `entity_type`, `entity_id`, `vehicle_id`, `title`, `message`, `created_at`; legacy: `alertType`, `entityId`, `message`, `severity` |
| `AlertUpdated`, `AlertAcknowledged`, `AlertResolved`, `AlertEscalated` (FMS-92) | `alert.updated` | alerts | `alert_id`, `status`, and what changed: `severity`, `priority`, `occurrence_count`, `last_occurred_at` (a repeat); `acknowledged_at`/`_by`, `resolved_at`/`_by`; `escalation_level`, `escalated_at` |
| `NotificationUnreadChanged` (FMS-48, [alerts.md](alerts.md#the-inbox-fms-48)) | `notifications.unread` | the user's own room, not a channel | `unread_count`, `reason` (`delivered`, `read`, `read_all`), `changed_at`. Published when the alert engine notifies the user and when they mark notifications read, so their other tabs follow. |
| `IncidentReported` (published since FMS-38, docs/incidents.md) | `incident.created` | incidents | `incident_id`, `vehicle_id`, `trip_id`, `severity`, `incident_type`, `status`, `latitude`, `longitude`, `occurred_at`. It goes to the incident's depot and to the driver who reported it. |

- The events marked with a card are not published yet. Their payloads are the contract those cards must meet, `depot_id` included: it decides who receives the event.
- Payloads are picked field by field. A new field on a domain event is not forwarded until it is added here.
- To forward a new event, add it to `FORWARDERS` in `realtime/domain/contract.ts`, then to this table and to api-contract §11.2.
- `vehicle.location.updated` feeds the fleet map (FMS-44, `docs/shared-ui.md`): the page holding the socket passes each vehicle's latest position to `FleetMap` as a prop. The Fleet Command Center (FMS-45, [live-map.md](live-map.md)) applies them in 150 ms batches over its snapshot, and re-reads the snapshot on `trip.updated` and `vehicle.status.changed`.
- Opened and closed sockets are logged (`socket connected`, `socket disconnected` with the reason). The web client disconnects when the tab is closed or left (`pagehide`), logged as `client namespace disconnect`, and reconnects if the page comes back from the back/forward cache.

## Client to server

`location_update` (legacy, api-contract §11.2) is accepted only with `REALTIME_LEGACY_LOCATION=true`. Otherwise it is acknowledged `{ ok: false, error: { code: 'NOT_SUPPORTED' } }`.

When it is enabled:
- the caller needs `trip:execute` or `tracking:ingest`;
- the body is checked: `tripId`, `lat` and `lng` are required; `speedKmh`, `bearing` and `accuracyM` are optional;
- the update goes through GPS ingestion as a driver's phone (docs/gps-ingestion.md), stamped when it arrives: `tripId` must be the sender's trip under way (`FORBIDDEN_INSUFFICIENT_ROLE` otherwise), and a refused position answers `VALIDATION_FAILED` with the reason.

**Rate limit:** every client event counts. A socket may send 5 at once, then 1 a second. An event over the limit is refused (`RATE_LIMITED` in its acknowledgement), and after 20 refusals the socket is closed.

## Frontend

`RealtimeProvider` (in `App`) opens one socket while the user is signed in.
- On `connect_error` with an expired or invalid token, or when the server closes the socket, it renews the session (`/auth/refresh`) and reconnects. After 3 renewals in a row without connecting, it stops until the next sign-in.
- Each event marks the matching queries stale, and the screens re-read them over the API:
  - `trip.updated`: `['dispatch']`, `['driver', 'today']`, `['trips']`;
  - `vehicle.status.changed`: `['dispatch']`, `['vehicles']`;
  - alerts and incidents: their lists.
- Screens use `useRealtimeEvent(event, handler)` and `useRealtimeStatus()` (`lib/realtime/context.ts`; outside the provider they do nothing).
- Polling stays as the fallback. The dispatch console shows "Live" while the socket is up.

## Tests

- `realtime/domain/contract.test.ts`: rooms, the event mapping, staleness, origins, the rate limit.
- `test/integration/realtime.test.ts`, real sockets against the API:
  - refused handshakes (no, forged or revoked session; a foreign origin);
  - depot isolation;
  - a real status change through the outbox;
  - drivers' own trips;
  - closing on account change and on token expiry;
  - the legacy event and its rate limit;
  - with Redis, two instances: an event from instance A reaches a client on instance B once, within 500 ms.

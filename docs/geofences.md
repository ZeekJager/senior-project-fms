# Geofences and route deviation (FMS-90)

Two more rules on every vehicle's GPS pings, beside speeding and idling ([telemetry-rules.md](telemetry-rules.md)): a
vehicle **leaving a yard or entering a no-go zone**, and a vehicle on a trip **straying from its route's road**. Both
catch misuse and theft without anyone watching the map. Each opens a flag in `tracking.telemetry_flags`, becomes an
alert for the depot's dispatchers and depot admin ([alerts.md](alerts.md)), and shows on the live map.

Code: `integration/domain/geometry.ts` (point in polygon, distance to a line, polygon checks), `integration/domain/
location-rules.ts` (the rules, pure), `integration/application/location-rules.service.ts` (the consumer),
`integration/application/geofence.service.ts` and `api/geofence.routes.ts` (the fences), `infrastructure/
geofence.repository.ts`. Tables: migration 060. Screen: **S-32 Geofences** (`/geofences`, Command center menu).

## Geofences

A geofence is a polygon of a depot, one ring of corners (no holes), of one of two kinds:

| Kind | For | Broken when the vehicle |
|---|---|---|
| `keep_in` (*Stay inside*) | A yard, an operating area | crosses from inside to outside |
| `keep_out` (*Keep out*) | A no-go zone: a market, a border road | crosses from outside to inside |

and applies `always`, or `off_trip`: only while the vehicle is on no trip, so a vehicle may leave its yard on a trip
but not at night (the theft case). Each fence applies to the vehicles of its depot.

- **Who.** `tracking:read` sees them, in the caller's depot scope (the live map draws them). `geofence:write`, admin
  only, draws, changes, removes and restores them. Every change is audited (`tracking.geofences`) and published as
  `GeofenceChanged`.
- **Shape.** 3 to 500 corners, `[longitude, latitude]` as GeoJSON, sent open or closed. Stored closed, rounded to 6
  decimals (about 10 cm), repeated corners dropped, with its bounding box and area. Refused (400, on `polygon`):
  `too_few_points`, `too_many_points`, `out_of_range`, `self_intersecting` (edges that cross), `too_small` (under 400
  m², a GPS fix's error), `too_large` (over 500 km across). A fix exactly on an edge counts as inside.
- **Limits.** At most 50 active fences per depot (each ping is checked against all of its depot's, a bounding box
  first). Names are unique per depot among active fences, ignoring case (409).
- **Removing** is soft: the fence leaves the rules and the lists, its past violations stay, and it can be restored.

## When a fence is broken

The rule runs over each vehicle's pings in recorded order:

- **A crossing, not a position.** A flag opens on the first ping on the wrong side after one on the right side. A
  vehicle already outside its yard when it is first seen, or when the fence is drawn or changed, is not flagged until
  it has been in and left again: drawing a yard never floods the dispatchers with the vehicles already out on the road.
- **Across a gap.** The side is kept even when the signal stops: a vehicle that goes dark in the yard and reappears
  outside it has left it. The side is kept 24 hours (the counters' life, below).
- **One flag per vehicle and fence.** A fix jumping back and forth across the fence line keeps one flag: it resolves
  only after `clear_pings` (3) pings in a row back on the right side, from the first of them. Two fences broken at
  once are two flags (the unique index is on vehicle, type and fence).
- **Ends** with `end_reason`: `cleared` (back on the right side), `trip_started` (an `off_trip` fence while the
  vehicle starts a trip), `geofence_changed` (its outline, kind, applies or depot changed), `geofence_removed`.
- **Flag details:** `kind`, `geofence_name`, and the ping that crossed (`lat`, `lng`, `flagged_at`); severity `high`.

## Route deviation

For a ping stored with a trip whose route has a road (`trip.routes.geometry`, measured by the routing engine,
FMS-84), the rule measures the ping's distance to that road, to the nearest point of its nearest segment.

- **Off route** is further than `route_deviation_m` (500 m) for `route_deviation_pings` (3) pings in a row, at most 2
  minutes apart (the live map's no-ping limit); after a longer gap the count starts again. Exactly the threshold is on
  route.
- **One flag per vehicle.** `observed_at` is the first ping of the run; `details`: `distance_m` (the ping that crossed
  the count), `route_deviation_m`, `consecutive_pings`, `lat`, `lng`, `flagged_at`. Severity `medium`.
- **Ends** after `clear_pings` (3) pings in a row back within the threshold (`cleared`), or on the first ping of
  another trip or of no trip (`trip_ended`); `details` adds `max_distance_m`, the furthest it strayed.
- **Not judged:** a trip whose route has no road yet (no coordinates, or the routing engine was down), and pings on
  no trip. The road is cached 60 s per trip, so a route changed under a trip is followed within a minute.

## Thresholds (CFG-3)

`route_deviation_m` (100-5000, default 500) and `route_deviation_pings` (1-20, default 3) are columns of
`tracking.rule_thresholds`, with speeding's and idling's: the fleet's row and a depot's that differ. They are on the
Settings screen (S-27, *Off route beyond* and *Off route after*) and in `PUT /settings/telemetry-rules/...`, where
they are optional: one left out keeps the row's value, so a client from before them still works. `clear_pings` is
shared: it clears speeding, a geofence and a deviation alike.

## How it runs

`integration.location-rules` consumes `VehicleLocationUpdated`, apart from the speeding and idling rules:

1. It reads the vehicle's stored pings after the last one it checked, up to the announced one (at most 1,000).
2. It runs them past the vehicle's depot's active fences (cached 30 s per depot; a change on this instance clears it
   at once) and the roads of the trips they carry, from the counters and the flags open in the database.
3. It opens and closes flags on the event's transaction, each with `TelemetryFlagRaised` or `TelemetryFlagResolved`
   (with `geofence_id` for a fence's), and an opened one with `GeofenceViolated` or `RouteDeviationDetected`.
4. It saves the counters in Redis at `fms:state:integration:location:<vehicle public id>`, kept 24 hours, the state
   before each event kept too, so an event delivered again decides the same (as FMS-46's). Without Redis they are
   kept in process.

A fence changed or removed closes its open flags in the same transaction as the change, with `TelemetryFlagResolved`
for each, so no flag is left open on a fence no longer in force.

## Alerts and the screens

- **`GeofenceViolated`** becomes a `geofence_violation` alert, high: "Left Bole yard: AA 3-12345" or "Entered
  Merkato: ...". Each fence is its own source; a repeat within 30 minutes adds an occurrence.
- **`RouteDeviationDetected`** becomes a `route_deviation` alert, medium: "Off route: AA 3-12345", "AA 3-12345 was
  640 m from its route for 3 pings in a row." One per trip; a repeat within 60 minutes adds an occurrence.
- `TelemetryFlagRaised` makes no second alert for these two types. Both alerts go to the dispatcher and depot admin
  and escalate as any other.
- **S-32 Geofences** lists the depot's fences beside a map. An admin draws one by clicking its corners in order
  around the area (drag a corner to move it), names it, picks the kind and when it applies; a reader sees them.
- **The live map** draws its depot's fences under the vehicles (a yard as an outline, a no-go zone dashed and
  shaded), and a vehicle's popup says *Off route* or *Geofence broken since* while its flag is open.
- **Flags** list with the fence: `GET /vehicles/{vehicle_id}/telemetry-flags` adds `geofence: {geofence_id, name}`.

## Trying it

Draw a yard around a depot on S-32, then send pings leaving it (the simulator's vehicles drive around Addis Ababa):

```sh
npm run simulate:gps -w fms-backend -- --vehicles 20 --interval 10
```

A vehicle crossing the outline raises its alert on the next ping. For route deviation, a trip under way on a route
with a road, and a vehicle reporting 500 m or more from it for 3 pings.

## Not done here

- Fences shared by depots, or per vehicle; holes in a polygon; circles. A fence is one depot's ring.
- Arrival and departure events for a fence (a yard's gate log): only violations are recorded.
- Deviation before a trip's first stop: the whole road counts, from origin to destination.

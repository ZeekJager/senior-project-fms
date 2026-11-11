# Arrival times and stop order (FMS-86)

Card FMS-86 (SE-130), architecture §9.2. Dispatchers see when each trip under way will reach its stops and its destination, and can ask for a shorter order of a route's stops. Both use the routing engine (OSRM, [routing.md](routing.md)). A trip expected well past its scheduled end raises an alert ([The trip delay alert](#the-trip-delay-alert-fms-147), FMS-147).

## Live arrival times

**When.** GPS ingestion announces a vehicle's newest position as `VehicleLocationUpdated`, at most once per vehicle per `TRACKING_EVENT_INTERVAL_SECONDS` (5 s). The `trip.eta` consumer takes the positions that name a trip under way and makes an estimate at most once per **30 seconds of position time** per trip (the card's acceptance criterion).

- **Position time, not the clock.** The same pings give the same estimates, however late a phone delivers them.
- **Too old.** A position more than 5 minutes old when it is handled says too little about now, so no estimate is made from it.
- **One at a time.** The estimate's row (`trip.trip_etas.checked_at_position`) is claimed with a row lock, so two positions handled at once make one estimate.

**What it works out.** The code is `trip/domain/eta.ts` (pure) and `trip/application/eta.service.ts`.

1. **Stops reached.** The vehicle is within **150 m** of a stop ahead, so that stop is marked `arrived`, with `actual_arrival` set to the position's time.
   - **Stops ahead.** Only the stops after the last one reached count. A stop passed without coming near it is behind the vehicle once a later stop is reached, and is never routed back to.
   - **No coordinates.** A stop without coordinates gets no time and is not routed to.
   - **Marked done.** A stop the driver marked done (FMS-95, [trip-stops.md](trip-stops.md)) has an `actual_arrival`, so it counts as reached, and GPS never marks it again.
2. **The road ahead.** One request to the engine, from the position through the stops ahead to the route's destination. It uses OSRM's `route` service without the line: the legs only, never cached.
3. **Times.** Each stop ahead gets the position's time plus the driving time of the legs before it (`trip_stops.eta`). The trip gets its arrival at the destination, and the distance and time left (`trip.trip_etas`).
   - **At the destination.** Within 150 m of the destination: arrived at the position's time, with nothing left.
   - **No destination coordinates.** The stops are still estimated, and the trip has no arrival time.
4. **`TripEtaUpdated`.** Published on the same transaction. The real-time gateway sends it as `trip.updated`.

**When the engine cannot be asked** (down, unset or failing fast), the last estimate stays and its `updated_at` shows its age.

- **No retry.** The event is not retried: the next position asks again 30 seconds later.
- **No road.** When the engine finds no road, the estimate also stays as it was.
- **Stops still reached.** Arrivals at stops are recorded either way.

**Traffic.** OSRM has no live traffic feed. Its times come from the road types' speeds in the OpenStreetMap profile. A traffic-aware provider would replace the planner's `legs` call (decision D-05); nothing else changes.

### Storage (migration 053)

| Where | What |
|---|---|
| `trip.trip_stops.eta` | Expected arrival at the stop; `NULL` once reached, without coordinates, behind the vehicle, or before the first estimate |
| `trip.trip_etas` | One row per trip that has had an estimate: `arrival_at`, `remaining_km`, `remaining_seconds`, `position_at` (the position it is from), `computed_at`, and `checked_at_position` (the throttle) |

The estimate is a table of its own, not columns on `trip.trips`. An update every 30 seconds must not bump the trip's `version`, which is the `If-Match` a dispatcher's edit carries, or its `updated_at`.

### In the API

- **`GET /trips`, `GET /trips/{id}`:** each trip under way has `eta`:
  - `arrival_at`, `remaining_km`, `remaining_seconds`;
  - `next_stop` (`stop_id`, `name`, `eta`);
  - `position_at` and `updated_at`.

  Each of its `stops` has `eta`. Trips not under way have `eta: null`, as do their stops.
- **`GET /tracking/vehicles/current`:** each vehicle's trip has `eta` (`arrival_at`, `remaining_km`, `next_stop` with `name` and `eta`, `updated_at`). The snapshot is cached for a few seconds and is not dropped on every estimate; the socket brings the new ones.
- **`trip.updated`:** `change: "TripEtaUpdated"` and the trip summary with its `eta`, to the same audience as any other trip update.

`TripEtaUpdated` is not one of `TRIP_EVENTS`: fleet's availability read model and the live map's cache do not react to it.

### On the screens

- **Socket.** The browser does not re-read anything when `trip.updated` says `TripEtaUpdated` (RealtimeProvider). The screens showing the trip patch its `eta` in place, so a fleet of 200 trips under way does not cause a re-read every few hundred milliseconds.
- **Dispatch (S-07), Under way.**
  - Each card says when the trip is expected at its destination and how far is left.
  - The panel lists the stops with their arrival times, or when they were reached.
  - It says when the estimate is more than 2 minutes old.
- **Command center (S-16).**
  - Each vehicle card on a trip shows the arrival time and the next stop.
  - The driver focus panel shows the arrival time and the next stop.

## The trip delay alert (FMS-147)

Card FMS-147 (SE-191), FR-9. The dispatcher is told when a trip under way is expected at its destination well after its scheduled end.

**When.** After each new estimate, the `trip.eta` consumer holds the trip's `arrival_at` against its `scheduled_end`, by the margins of the route's depot. The code is `trip/domain/delay.ts` (pure) and `EtaService.judgeDelay`.

| How late (arrival after the scheduled end) | The trip is | What happens |
|---|---|---|
| Within `trip_delay_minutes` (15), or exactly on it | on time | Nothing. A late trip coming back within it **recovers** |
| More than `trip_delay_minutes` | late | A trip that was not late falls late: a new **episode**, and `TripDelayed` (`level: late`) |
| More than `trip_delay_urgent_minutes` (60) | urgent | A trip not yet urgent becomes urgent in the same episode: `TripDelayed` (`level: urgent`). A trip first judged this late is urgent at once |

- **Once per episode.** A late trip later still is not alerted again, and an urgent one between the margins stays urgent. Falling late again after recovering is a new episode, and a new alert.
- **A stale ETA is not a delay.** Only an estimate made from a fresh position is judged (one at most 5 minutes old, as above), so a vehicle that has gone quiet keeps its last estimate and raises nothing. With the routing engine down, there is no new estimate either.
- **No arrival time** (a route without destination coordinates) or no scheduled end: the trip is not judged.
- **State.** `trip.trip_etas.delay_level` (`late`, `urgent` or null) and `delay_episode`, with the estimate (migration 068). The estimate's row lock makes two positions at once judge the trip once.

**The margins** are columns of `tracking.rule_thresholds`, next to the telemetry rules' thresholds ([telemetry-rules.md](telemetry-rules.md)): the fleet's row and each depot's that differs. `trip_delay_minutes` is 5-240 and `trip_delay_urgent_minutes` 10-720, and the second must be above the first. An administrator changes them under **Settings → Driving rules** or with `PUT /settings/telemetry-rules/...`. The trip module reads them through the integration module (`trackingLookups.tripDelayMargins`, cached 30 seconds per depot like the thresholds), connected in `src/modules/index.ts`.

**`TripDelayed`** carries `trip_id`, `depot_id`, `vehicle_id`, `driver_id` (public ids), `level`, `episode`, `late_minutes`, `margin_minutes`, `scheduled_end`, `arrival_at`, `destination` and `position_at`.

**The alert** (`trip_delayed`, [alerts.md](alerts.md)) is for the dispatchers of the trip's depot.

- **Late.** Medium, in the app. The title is "Trip running late: AA 3-12345". The message says when the vehicle is expected and how late: "AA 3-12345 is expected at Adama at 14:35, 23 minutes after the trip's scheduled end at 14:12."
- **Urgent.** The same alert becomes critical, "Trip far behind schedule". The dispatchers are told again, by email, SMS and push as well ([notification-channels.md](notification-channels.md)). Critical, it escalates to fleet managers when nobody acknowledges it.
- **Its link** opens the trip on Dispatch (S-07), under Under way, in its own depot (`/dispatch?view=under-way&trip=<id>`).
- **Recovering does not resolve it.** A dispatcher resolves it once they have dealt with it.

## Stop-order optimisation

`POST /routes/{route_id}/optimise` (`route:write`, depot scope) suggests the order of a route's saved stops that makes the road from origin to destination shortest.

1. **Distance table.** The routing engine's `table` service gives the road distance and time between every pair of waypoints.
2. **Nearest neighbour, then 2-opt.** Nearest neighbour runs from the origin, then 2-opt runs with the ends fixed. Road distances are not symmetric (one-way streets), so each candidate order is costed whole, in the direction driven. A second 2-opt pass also runs from the saved order.
3. **Never longer.** The saved order is kept unless something strictly shorter was found, so the suggestion is never longer than the original (the card's acceptance criterion). `changed: false` says the saved order is already the shortest found.

**The answer:**

- `order`: the saved stops' indexes in the suggested order;
- `stops`: the stops in that order;
- `original` and `optimised`: `distance_km` and `duration_seconds` for each order;
- `version`: the route version it was worked out for.

**Nothing is saved.** The route editor (S-21) puts the suggested order into the form, and saving it is an ordinary `PATCH /routes/{route_id}` with `If-Match`. That edit is audited, measures the road again and publishes `RouteUpdated`. Trips already created keep their own copy of the stops.

**Refusals:**

| Case | Answer |
|---|---|
| No origin or destination coordinates | `400 VALIDATION_FAILED`, `route_without_ends` on `origin` or `destination` |
| A stop without coordinates | `400`, `stop_without_coordinates` on `stops` |
| No road between some of the points | `400`, `no_road` |
| No routing engine, or it cannot be reached | `503 UPSTREAM_UNAVAILABLE` (`routing_unavailable`, `Retry-After: 60`) |
| Another depot's route | `404` |
| No `route:write` | `403` |

## Tests

- **Unit:**
  - `trip/domain/eta.test.ts`: stops reached and behind, the legs into times, at the destination, no destination;
  - `trip/domain/delay.test.ts` (FMS-147): within and on the margin, falling late, later still, urgent after late and at once, urgent between the margins, recovering and falling late again, a depot's margins;
  - `trip/domain/optimise.test.ts`: fixtures in road order, already the shortest, asymmetric roads, and 200 random tables that are never longer;
  - the planner's `legs` and `table` (`osrm.planner.test.ts`);
  - the real-time contract.
- **Integration (`test/integration/trip-eta.test.ts`):** the routing engine is a stand-in that measures 1.25 times the straight line at 45 km/h. The cases:
  - times in the API, the event and the live map;
  - one estimate per 30 s;
  - a stop reached;
  - the engine down;
  - no destination;
  - no estimate off a trip;
  - the delay alert (FMS-147):
    - one alert past the margin for the depot's dispatchers, none for a second estimate past it;
    - urgent: the same alert critical, told again by email;
    - recovering, then a new alert;
    - a stale position, and a depot's own margin;
    - the margins in the thresholds API (defaults, urgent above late, kept when left out);
  - optimise: order, never longer, saved by `PATCH`, the refusals, permissions and scope.

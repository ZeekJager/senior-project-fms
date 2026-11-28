# Driver navigation (FMS-166)

Card: FMS-166 (SE-211). Code:

- backend: `packages/backend/src/modules/trip/domain/navigation.ts`, `TripService.navigation`, `OsrmRoadPlanner.directions` and the route in `api/trip.routes.ts`;
- frontend: `packages/frontend/src/pages/Driver/Navigate.tsx` and `navigation.ts`.

*My day* named the trip's destination but showed no map, so the driver could not see where the destination depot was or how to get there. The driver now has live navigation on the phone: a full-screen map that follows them, the road to the next stops and the destination, the next turn, and the time, distance and arrival left.

## The screen

`/driver/navigate` (trip:execute) opens from the trip on *My day*: **Navigate** on a trip under way, **Show the route** on one not started. It shows the trip under way, or the one named by `?trip=`.

| Part | What it shows |
|---|---|
| Next turn (top) | The arrow, the distance to the turn, and the instruction ("Turn left onto Ring Road", "At the roundabout, take the 3rd exit onto Bole Road", "Arrive at Adama depot") |
| Map | The road drawn to the stops left and the destination; each stop numbered; the destination labelled; the driver as a pulsing dot, with the GPS accuracy around it when it is poor. The map follows the driver; a drag stops following until **Recentre** |
| Progress (bottom) | The next stop or the destination, then the destination; the arrival time; the time and distance left; **My day**, and **Open in Google Maps** through the same waypoints, as a fallback |

The phone works out between two answers from the server where the driver is on the road, the distance left, the next turn and the time left (the road's time scaled by the distance left). It asks the server again:

- every 30 s while the driver moves (more than 30 m since the last answer), so the road follows the driver;
- at once (at most every 10 s) when the driver is more than 150 m from the road: *Off the road by 220 m: finding a new road…*

**With no signal** the last road stays on screen and the position still moves on it, since the phone's GPS needs no signal. **With no road** (the routing engine not set up, unreachable, or no road found), the banner points the way to the next waypoint as the crow flies, with the distance and the compass direction ("2.2 km · Head south-east"), and a dashed straight line on the map. **With no GPS fix** after 6 s, the road is asked from the vehicle's last stored position.

## API

`GET /trips/{id}/navigation?from=lat,lng` (trip:execute). A driver sees only their own trips; dispatch sees trips in its depots. Another's trip, or an id that is not a UUID, is a 404. A `from` that is not `lat,lng` is a 400.

| Field | Meaning |
|---|---|
| `origin` | Where the road starts: `from` (source `phone`), else the vehicle's newest stored position (source `vehicle`), else null |
| `waypoints` | The stops not completed or skipped and with coordinates, in order, then the route's destination |
| `destination` | The destination waypoint, or null when the route has no destination coordinates |
| `road` | From the routing engine (OSRM, `steps=true`): `distance_km`, `duration_seconds`, `arrival_at`, the line, and each step's `instruction`, maneuver `type` and `modifier`, `road`, `distance_m`, `duration_s` and position. Not cached, as the driver's position is never the same twice |
| `no_road` | Why `road` is null: `no_origin`, `no_waypoints`, `routing_not_configured`, `routing_unavailable`, `no_road` |
| `straight_line` | To the next waypoint as the crow flies: `distance_km` and `bearing_deg` |

The instructions are written on the server from OSRM's maneuvers (`domain/navigation.ts instruction`). Each `arrive` step names the waypoint it reaches.

## Tests

- `src/modules/trip/domain/navigation.test.ts`: the waypoints left, bearings and compass words, and every maneuver's instruction.
- `test/integration/trip-navigation.test.ts`: the road through the stop left to the destination, with a real OSRM v5.27.1 answer (`test/fixtures/osrm/bole-megenagna-steps.json`) and its turns in words; no road when the engine is not set up or is down, with the straight line; no origin; another driver's trip and a bad `from`.
- `packages/frontend/src/pages/Driver/navigation.test.ts`: the place on the road, the next turn, off the road, distance and time words, and the Google Maps link.
- `Navigate.test.tsx`: asking from the phone; the next turn, stop, time, distance and arrival; moving along the road without asking again; the straight line; a blocked location; no trip; and the **Navigate** button on *My day*.

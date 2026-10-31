# Fleet Command Center (live map)

Card: FMS-45 (SE-81), screen S-16 at `/command-center` ("Live map" in the Command center menu). Code: `packages/frontend/src/pages/FleetCommandCenter/` (the page), `packages/frontend/src/components/FleetMap/` (the map, [shared-ui.md](shared-ui.md#fleet-map)), and `GET /tracking/vehicles/current` in `packages/backend/src/modules/integration/` (`live-map.service.ts`). Alerts, incidents and the fleet-status panels of §11 are FMS-89.

Who: `command:read` and `tracking:read` (admin, fleet manager, dispatcher, depot admin, fleet owner). A depot's staff see their depot; the others see every depot, or one chosen in the Depot filter. A driver who opens the address gets nothing (RoleGate).

## What it shows

- **Map (70%).** One marker per vehicle that has reported, coloured by its state: moving, stopped, idling (0 km/h for 5+ minutes), speeding (an open flag, pulsing red), breakdown, offline (no ping for 2+ minutes, grey). Only the current position, never a trail (except for a driver in focus, below).
- **List (30%).** One card per vehicle: plate, state badge, driver, route, speed and "Last seen", which counts up every second. An offline vehicle's card says OFFLINE in red; a speeding one, SPEEDING.
  - **Views:** On trip (the default), Attention (speeding, idling, offline, or on a trip but not reported yet) and All.
  - **Order and search:** cards keep plate order, so they do not jump while states change. Search matches plate, driver or route.
- **Choosing.** A card flies the map to the vehicle (if it is off screen) and opens its popup: plate, state, speed, last seen, driver, route. A marker selects its card and scrolls it into view. The popup follows the vehicle as it moves. Its close button, Escape on the map or a click on the map closes it; nothing else does.

## Alerts, incidents and counters

Card FMS-89 (SE-133). What needs attention, beside the map. Code: `overview.ts` (the overview's types and the live patches), `StatusStrip.tsx`, `AlertsPanel.tsx`, `IncidentsPanel.tsx` and `IncidentDrawer.tsx`; the API is `GET /command-center/overview` in `packages/backend/src/modules/command-center/` (api-contract §11.1).

- **Counters** above the map: vehicles on a trip, available, in the workshop and flagged; drivers on a trip, available, absent today and with an expired licence; the day's trips under way, overdue, still to start and completed; and what needs attention: active alerts (and how many are critical), active incidents and vehicles whose health is at risk. A count that should be zero is red when it is not. Alerts and Incidents open their panels.
- **Panels.** The side panel switches between Fleet (the list above), Alerts and Incidents, kept in the address (`?panel=`). A user who may read neither has no switch.
- **Alerts.** Every open and acknowledged alert, most severe first, with its plate, how long ago and how often. *Acknowledge* (`alert:ack`) and *Resolve* (`alert:resolve`) act at once; *Show on map* selects its vehicle. A new alert arrives over the socket (`alert.created`) in its place within the second it is raised, and a critical one is also announced; another console's acknowledgement shows here as it happens (`alert.updated`).
- **Incidents.** Every open and investigating incident, most severe first, with its type, plate, description and who took it on. One opens a drawer with the report, the driver and where it happened. With `incident:manage`: *Take it on* (or take it over, or let it go), the status (only the moves the API allows), and what was found and done, which resolving or closing requires. A new incident is read in full when `incident.created` arrives; a change from another console (`incident.updated`) moves or removes it.
- **On the map.** A vehicle with an active breakdown incident is drawn as broken down (red, with a ring). A card whose vehicle is at risk or to watch carries its health score.
- **Freshness.** The overview is read with the snapshot (every 30 s) and cached 5 s on the server. Socket events change it at once, and it is re-read 6 s after the last one, past the cache, so a stale read cannot undo what an event changed.

## One driver in focus

Card FMS-140 (SE-184). On a busy map a dispatcher answering a call about one driver ("where is Abebe now, is he on his route?") needs that driver alone. Code: `focus.ts` (the pure parts) and `DriverFocus.tsx` (the map layers and the panel) beside the page.

- **Entering.** *Focus on driver* under a card whose vehicle is on a trip with a driver, or a link with `?driver=<driver id>`. The focus is kept in the address, so the link can be shared. It spans every depot in the user's scope, so the Depot filter is set aside while it lasts.
- **Map.** Only that driver's vehicle, live as before. Two lines:
  - the trip's planned route, dashed: origin, the stops that have a point, destination (`GET /trips/{id}` for its route, then `GET /routes/{id}`);
  - the vehicle's track today, solid: `GET /vehicles/{id}/tracking` from midnight in Addis Ababa up to when the focus began, read once and then extended by each live position.

  The view frames the vehicle, route and track when the focus begins and again as they load. After that it follows the vehicle, panning when the vehicle nears the edge, so zooming in or out still works.
- **Panel.** Takes the place of the list and of the Fleet, Alerts and Incidents switch (the counters above the map stay; choosing Alerts or Incidents there ends the focus): driver, vehicle and its state, trip, from and to, started, due to end, speed and last ping (counting up), which lines are drawn, and a link to the vehicle's history (S-22).
- **Not on the map.** A driver not on a trip in scope is looked up with `GET /drivers/{id}`. A driver who exists but is on no trip shows "not on a trip"; their vehicle appears as soon as they start one. An unknown driver, or one outside the user's depots (the API's `404`), shows "Driver not found".
- **Leaving.** *Whole fleet* or Escape clears the focus and brings every vehicle back.
- **Permissions.** No new ones: the page's `command:read` and `tracking:read`, plus `trip:read` and `route:read` for the planned route. Without them the route is simply not drawn. Every read is depot-scoped by the API.
- **Not yet.** The planned route is straight lines between its points. Road routing (FMS-84) is now in, so it could draw the route's road from `GET /routes/{id}/geometry` instead.

## Where the data comes from

```
GET /tracking/vehicles/current      once, then every 30 s, and when something changes
  + socket vehicle.location.updated  each vehicle's newest position, at most one per 5 s (FMS-88)
  = the page's fleet (liveFleet.ts)  -> FleetMap and the list
```

**The snapshot** (api-contract §11.1). Every vehicle in scope that is not retired and has a position or a trip under way. Each has:
- its newest position (and `stopped_since` while at 0 km/h, so idling shows as soon as the page opens);
- its trip under way, with route and driver;
- its open telemetry flags.

It is cached in Redis for 5 seconds (`LIVE_MAP_CACHE_TTL_SECONDS`): one snapshot per depot shown, or one for all depots, shared by everyone who sees it (`fms:cache:integration:live-map:<depot public id>`). Trip and vehicle events drop the cache after they commit.

**Positions** (`vehicle.location.updated`) are buffered and applied every 150 ms, so a burst of 200 is one render.
- A position older than the one shown is late and dropped.
- When a depot is chosen, another depot's positions are ignored (a fleet manager receives every depot's).

**Re-reading the snapshot.**
- Every 30 seconds. This is the fallback while the socket is down.
- On `trip.updated`, `vehicle.status.changed` or `vehicle.flag.changed`: the realtime provider marks `['tracking']` stale.
- After the socket reconnects.
- When a position names a vehicle the page does not have, or a different trip. Throttled to once every 5 seconds.
- A snapshot older than a position the socket already brought keeps that position.

**Speeding and idling flags** come from the telemetry rules (FMS-46, [telemetry-rules.md](telemetry-rules.md)), which open and close `tracking.telemetry_flags`. A flag opening or closing drops the cached snapshot and reaches the page as `vehicle.flag.changed`, which re-reads it: the legend and the marker change within a second or two of the ping that decided it.

## Budgets

| Budget | How it is met |
|---|---|
| 200 vehicles drawn within 2 s | One request; markers are light div icons. A marker re-renders only when its own vehicle changes: the map's clock runs in whole 10 s ticks, and each vehicle keeps its map object until it moves |
| A position moves its marker within 500 ms | Applied within 150 ms of arrival (`FLUSH_MS`); tested |
| No ping for 2 minutes turns grey without a reload | The list's clock ticks every second and the map's every 10 s; tested |
| Closing the tab closes the socket | The client disconnects on `pagehide` (RealtimeProvider). The server logs `socket disconnected` with reason `client namespace disconnect`; a dropped network shows `transport close` or `ping timeout` instead |

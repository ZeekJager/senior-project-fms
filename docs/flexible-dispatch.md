# Flexible dispatch (FMS-139)

Card: FMS-139 (SE-183). Code:

- `packages/backend/src/modules/trip/`: `domain/schedule.ts` (the turnaround, the shift and the errors), `application/trip.service.ts` (`create`, `update` and `shiftPlan`), `infrastructure/trip.repository.ts` (`clashing`) and `api/trip.routes.ts`;
- migration 048 (`routes.is_adhoc`);
- the console: `packages/frontend/src/pages/Dispatch/` (`NewTripDrawer`, `TripTimesDrawer`, the Under way view).

Contract §7.2, *Flexible dispatch*. Screen S-07.

A plan rarely survives the day. A customer calls with a delivery nobody planned, loading runs late, a road is closed. Before this card a dispatcher could only create a trip from a saved route, could not touch a trip once a driver had it except to cancel it, and could not move one under way at all. Every one of those was a dead end: cancel and recreate, or phone the driver and leave the system wrong.

## Trips nobody planned

`POST /trips` takes a `route` instead of a `route_id`: where it leaves from and where it goes, by name, with points and stops if known. The API saves that as a route of its own, `is_adhoc`, in the trip's depot, and creates the trip from it in the same transaction. The trip then works like any other: it copies the plan, is assigned, started and reconciled the same way.

- **Kept out of the way.** One-off routes never appear in `GET /routes` or the Routes screen, and do not take a name from the depot's saved routes (`ux_trip_routes_depot_name` skips them). Each one is named `"<origin> → <destination>"`, so the trip reads well in lists and history.
- **Depot.** `depot_id`, one of the caller's depots. A depot-scoped dispatcher may leave it out and gets their own; an admin or fleet manager, who sees every depot, must say.
- **End.** Optional for any trip: without it the trip ends the route's estimated time after its start. A one-off route has no estimate, so its trips need the end.

## Times that move

`PATCH /trips/{id}` moves `scheduled_start` and `scheduled_end` of a `draft`, `scheduled` or `assigned` trip, and the end of an `en_route` one. Its start already happened (`actual_start`), so a trip under way keeps it, and its end must come after that start.

**A reason, once someone is waiting.** Once the trip is `assigned` or `en_route`, a time change needs a `reason` (1-500 characters). It is kept on the `TripUpdated` event, so the change carries its why in the trip's history. For a trip nobody has yet it is optional. The driver's app re-reads the trip on `trip.updated` and shows the new times at once.

## Running into the next trip

A driver or vehicle is still never on two trips at once (`ex_trip_driver_overlap`, `ex_trip_vehicle_overlap`, touching ends included). So pushing an assigned trip's end later can run into the same driver's or vehicle's next trip. Before, that was a refusal and nothing more.

Now the `409 CONFLICT_DRIVER_OVERLAP` / `CONFLICT_VEHICLE_OVERLAP` says whether the trip in the way can move:

```json
{ "field": "driver_id", "reason": "overlapping_trip", "record_id": "<the next trip>", "shiftable": true, "shift_minutes": 31 }
```

It can when it is `assigned` and starts at or after the trip being changed. A trip under way never moves for someone else's change, and neither does one that starts earlier: there, the change itself must give way. Then the dispatcher sends the change again with `shift_following: true`:

1. The trip in the way moves later by just enough to start one minute after the changed trip ends (`TURNAROUND_MS`). Its length is kept.
2. If that move runs it into another trip, that one moves the same way, and so on along the chain. A chain of more than 20 (`MAX_SHIFTED`) is refused (`409`, `too_many_trips_to_shift`): something that large wants a person re-planning the day, not a cascade.
3. Every trip is written in one transaction, latest first, so no step ever overlaps another while it runs, and the database constraints hold throughout. Any refusal along the way leaves every trip as it was.
4. Each moved trip publishes its own `TripUpdated` with `shifted_by_trip_id` and a reason that says what moved it. The response lists them in `meta.shifted`.

The clashing trips are read `FOR UPDATE` (`TripRepository.clashing`), so two dispatchers moving trips of the same driver at once serialise instead of both succeeding.

## The console

S-07 shows what the API allows, to someone with `trip:write`:

- **New trip**, in the header: a saved route of the depot, or a one-off trip from a place to a place. Times are typed in Addis Ababa time (UTC+3, no daylight saving) whatever the browser's zone. For a saved route a blank end shows the time it will get.
- **Change times** on the chosen trip, **Change end** on one under way. A reason is asked for once the trip is assigned. When the change runs into another trip, the panel names that trip and offers *Move it N min later and save*; when it cannot move (`shiftable: false`), it says so and asks for other times. A refusal stays in the panel and is never a toast that disappears. After the save, a toast lists every trip moved.
- **Under way**, a third view beside Unassigned and Assigned: `en_route` trips whenever they started, since a trip that left yesterday is still on the road.

## Not in this card

- One-off routes are not measured by road at creation; the hourly route-roads job (FMS-84, [routing.md](routing.md)) measures one with both points within the hour.
- The driver's app shows the new times (it re-reads the trip on `trip.updated`) but not the reason, and has no "your next trip moved" notice of its own.

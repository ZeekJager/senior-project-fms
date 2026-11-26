# Driver–vehicle assignments (FMS-77)

Card FMS-77 (SE-121), api-contract §6.3, architecture §9.1. Which driver normally drives which vehicle, apart from
trips: for dispatch suggestions, and for who answers for a vehicle's condition. Stored in
`fleet.driver_vehicle_assignments` (migration 002); code in `packages/backend/src/modules/fleet/` (`assignment.*`).

## Kinds

| Kind | What | Rule |
|---|---|---|
| `primary` (the default) | The driver's regular vehicle | A driver has at most one primary vehicle at a time, and a vehicle one primary driver: periods may not overlap |
| `temporary` | A stand-in for a while (the regular vehicle in the workshop) | Needs an end; may overlap a primary one |

A period runs from `start_at` (now by default; it may be back-dated, to record the past, or in the future) to `end_at`,
open while it is not ended. It is `current` while active, started and not yet at its end.

## The API

| Call | Needs | Does |
|---|---|---|
| `POST /driver-vehicle-assignments` | `assignment:write` | Gives a driver a vehicle; `Idempotency-Key` makes a retry safe |
| `POST /driver-vehicle-assignments/{id}/end` | `assignment:write` | Ends it now, or at a time already past and after its start |
| `GET /driver-vehicle-assignments/{id}` | `assignment:read` | One assignment |
| `GET /drivers/{id}/assignments`, `GET /vehicles/{id}/assignments` | `assignment:read` | The history, newest start first, so the current one leads; paged |

`assignment:read` is held by administrators, fleet managers, dispatchers, depot admins and fleet owners;
`assignment:write` by the first four ([permissions.md](permissions.md)).

Refused:

- a driver or vehicle outside the caller's depots: `400`, `references_missing_record`; their histories: `404`;
- a driver and a vehicle of different depots: `409 CONFLICT_DEPOT_MISMATCH`;
- a retired driver: `409 CONFLICT_DRIVER_NOT_ELIGIBLE` (`driver_retired`); a retired vehicle:
  `409 CONFLICT_INVALID_STATE_TRANSITION` (`vehicle_retired`);
- **a second primary for the same driver:** `409 CONFLICT_DRIVER_IN_USE` (`driver_has_primary_vehicle`); for the same
  vehicle, `409 CONFLICT_VEHICLE_IN_USE` (`vehicle_has_primary_driver`). Each detail's `record_id` is the assignment in
  the way: end it first;
- a temporary one without an end, an end not after the start (`VALIDATION_INVALID_DATE_RANGE`), ending one in the
  future, or ending one already ended (`409 CONFLICT_INVALID_STATE_TRANSITION`).

The vehicle and the driver are row-locked (vehicle first, as for trips) before the overlap is checked, so two requests
for the same driver are decided one after the other; the schema's partial unique indexes (one open primary per driver
and per vehicle) are the backstop.

## Audit and events

Every create and end is one audited change of `fleet.driver_vehicle_assignments`. Events, ordered on the vehicle:

| Event | Payload |
|---|---|
| `DriverVehicleAssigned` | `assignment_id`, `driver_id`, `vehicle_id`, `depot_id`, `assignment_type`, `start_at`, `end_at` |
| `DriverVehicleAssignmentEnded` | `assignment_id`, `driver_id`, `vehicle_id`, `depot_id`, `end_at` |

## Elsewhere

- Retiring a driver or a vehicle that holds an active assignment is refused (`409 CONFLICT_DRIVER_IN_USE` /
  `CONFLICT_VEHICLE_IN_USE`): end it first.
- A driver's data export includes their assignments ([driver-data-protection.md](driver-data-protection.md)).
- In the web app, the vehicle page (S-22) and the driver's panel (S-05) show the current assignment and its history, and
  let `assignment:write` give or end one.

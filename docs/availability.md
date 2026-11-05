# Fleet availability screen (FMS-142)

Card: FMS-142 (SE-186). **S-33 Fleet availability**, `/availability` in the Fleet management menu. It shows how much of a
month vehicles could work, the downtime behind the rest, MTBF and MTTR, for the fleet, each depot and each vehicle,
and each vehicle's downtime periods with the repair or failure behind them. The figures and periods are FMS-131's
([downtime.md](downtime.md)); this card adds the screen and two things to `GET /vehicles/{vehicle_id}/downtime`.

Code: `packages/frontend/src/pages/FleetAvailability/`; in the backend, `DowntimeService.list` (fleet) and
`MaintenanceRepository.downtimeProblems` (maintenance, exported as `maintenanceRefs.downtimeProblems`).

## Who

`analytics:read` and `maintenance:read` open it: admin, fleet manager, compliance officer and fleet owner. Each sees
the depots in their scope. A depot admin holds `maintenance:read` but not `analytics:read`, so has no menu entry, as
with Reports. The periods need `vehicle:read`, which all four hold.

## The screen

- **Month and depot** at the top, kept in the address (`?month=`, `?depot=`). The month defaults to this one so far,
  as the API does, and can step back but never past this month. *Export CSV* is beside them.
- **The band:** availability (time up over time in the fleet), downtime (and how much of it was unplanned), MTBF and
  MTTR, for the fleet or the depot picked. A *Data as of* note says when the reporting copy lags (FMS-94).
- **Why vehicles were down:** the month's downtime by reason, largest first, each reason's hours and share written
  beside its bar. The reasons that count as failures are in the warning colour and say so.
- **By depot**, with every depot shown and more than one of them: each depot's availability, downtime, MTBF and
  MTTR. These are sums over the depot's vehicles, not an average of percentages. A row picks that depot.
- **By vehicle:** every vehicle in the fleet that month, most downtime first. Each row has availability (with a meter),
  downtime and the unplanned part, failures, MTBF, MTTR, and the reason with the most minutes.
  - Sort by any of those or by plate: the first click is the worst first, a second click reverses it. A vehicle with
    no figure (no failure, so no MTBF) is last either way.
  - *With downtime* shows only the vehicles that were down.
  - The sort and the view are in the address.
- **A vehicle** (`?vehicle=`) opens a panel:
  - its four figures;
  - each downtime period overlapping the month, newest first, with:
    - its start and end (or *still out of service*);
    - its whole length, and the part inside the month when it crosses the month's edge;
    - its reason;
    - **the problem behind it:** the work order (its type and description, and its status while open) and the failure
      (component, mode, how it was found). A period with neither says what began it: a status set by hand, a
      breakdown, or registration out of service. A reason a staff member set shows with their note.
  - *Open vehicle history* goes to S-22 for the vehicle's repairs.
- **Empty:** a month with no vehicles says so, and the reasons say none was out of service.
- **A failed read** shows the error with *Try again* and leaves the figures out.

## The CSV

`fleet-availability-<month>-<depot code or all>.csv` has one row per vehicle with:

- plate, depot, status and availability (%);
- time in the fleet, downtime and unplanned downtime;
- failures, MTBF, repairs and MTTR;
- the downtime for each reason.

Times are in hours to two decimals from the API's whole minutes, so they are exact to the minute. A cell a
spreadsheet would run as a formula is defused (`lib/csv.ts`).

## What the API gained

`GET /vehicles/{vehicle_id}/downtime`:

- **`from` and `to`** (ISO 8601 with an offset), both optional: only the periods overlapping that window, still going
  on at `from` and begun before `to`. The screen asks for its month, midnight to midnight in Addis Ababa. A `to` before
  `from` is `400` (`before_from`).
- **`maintenance_record`** (`id`, `maintenance_type`, `status`, `description`) and **`failure`** (`id`, `component`,
  `failure_mode`, `detected_by`, `occurred_at`) on each period. They are the work order and failure that
  `maintenance_record_id` and `failure_event_id` name, in words. Both are `null` for a caller without
  `maintenance:read`: a dispatcher reads a vehicle's periods but not its repairs.

`GET /analytics/downtime` is unchanged: the screen reads the fleet, the depots and the vehicles from one call.

## Checked against FMS-131's month

- **Integration** (`test/integration/availability.test.ts`):
  - FMS-131's hand-computed September, with an extra hour from a period begun in August: the window keeps 4 of the
    vehicle's 6 periods;
  - the month's figures: 88.2% available, MTBF 19,050 min, MTTR 1,080 min;
  - a breakdown's period names its work order and failure, and a dispatcher's has neither;
  - every response is checked against the OpenAPI spec.
- **Component** (`FleetAvailabilityPage.test.tsx`):
  - FMS-131's truck (88.3%, MTBF 13 d 6 h, MTTR 18 h) with two other vehicles;
  - the band, the reasons, the depots and the vehicle order;
  - sorting, the view and picking a depot;
  - the periods with their problems;
  - the CSV;
  - the empty, failed and no-permission states.

## Not done here

- Any period but a calendar month (a quarter, a custom range). The API's figures are per month.
- Setting a period's reason: `PATCH /vehicles/{vehicle_id}/downtime/{period_id}` exists (FMS-131), but this screen
  only reads.
- Targets ("95% availability"): the screen colours no figure as good or bad, because there is no agreed target.

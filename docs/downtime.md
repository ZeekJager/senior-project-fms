# Vehicle downtime: availability, MTBF and MTTR (FMS-131)

Card: FMS-131 (SE-175). Code:

- `packages/backend/src/modules/fleet/`: `domain/downtime.ts`, `application/downtime.service.ts`, `infrastructure/downtime.repository.ts` and `api/downtime.routes.ts`;
- `packages/backend/src/modules/analytics/`: `domain/downtime.ts` and `AnalyticsService.downtime`;
- the repairs and failures behind it in the maintenance module: `MaintenanceRepository.downtimeSources`, exported as `maintenanceRefs.downtimeSources`.

Migration 050. The screen that shows it is FMS-142 (SE-186).

Fleet managers are measured on availability. Before this card the system knew a vehicle's status now and its status history, but not how long it had been out of service in a month, or why. `fleet.downtime_periods` keeps each stretch a vehicle was down, with its reason, and `GET /analytics/downtime` turns them into availability, MTBF and MTTR per vehicle, depot and fleet.

## When a vehicle is down

| From | Until | Opened by |
|---|---|---|
| A move into `maintenance` (the workshop) or `inactive` (out of service) | The move back to `active`, or retirement. Workshop to out of service and back is one stretch | `status_change` |
| A breakdown: an unplanned failure detected as `breakdown` (FMS-125), from when it happened | The completion of the repair it is recorded on, or retirement. A cancelled repair adds nothing | `breakdown` |
| Registration, for a vehicle registered out of service | Its first move back to `active` | `registration` |

Stretches that overlap or touch are one period, opened by whichever began first. A truck that breaks down on the road at 07:00, reaches the workshop at 10:00 and is repaired at 18:00 is one period from 07:00 to 18:00, opened by the breakdown. A vehicle still down has a period with no end; there is at most one per vehicle.

Retired is not downtime: the vehicle has left the fleet, and the KPIs stop counting it there.

## Why: the reason

Each period gets a reason from what its repairs and failures say (`derived_reason`), in this order:

1. any breakdown among its failures: `breakdown`;
2. any other unplanned failure (a fault found in service): `unplanned_repair`;
3. a corrective repair that names no failure (still open, say): `unplanned_repair`;
4. preventive work, an inspection, predictive work, or a corrective repair of faults found at planned work: `planned_service`;
5. anything else, a status set by hand: `other`.

A period's repairs are the work orders of the status changes the workshop made (`source: maintenance`) and of its breakdowns; its failures are those recorded on those repairs. `maintenance_record_id` is the first of them, `failure_event_id` the failure that gave the reason.

`accident` and `awaiting_parts` are never derived: the maintenance module does not read incident types, and a wait for parts is not recorded anywhere. A staff member with `vehicle:write` sets them, or corrects any reason, with `PATCH /vehicles/{vehicle_id}/downtime/{period_id}` (`reason`, optional `note`; `reason: null` goes back to the derived one). The change is audited and shows who set it and when (`reason_set_by`, `reason_set_at`). It wins over the derived reason through every rebuild, because a period is known by what opened it (`opened_by`, unique per vehicle), not by its id. A staff reason is lost only when the period itself disappears, for example when a status change is undone in the history.

**Unplanned**, for MTBF and MTTR, is `unplanned_repair`, `breakdown` or `accident`. `awaiting_parts` and `other` count against availability only: a repair waiting for parts after a breakdown keeps the breakdown's reason unless someone changes it.

## Kept live, rebuilt nightly

The `fleet.downtime` projection re-derives one vehicle's periods from its whole status history and its repairs and failures, on the transaction of any change to them:

| Event | Published by |
|---|---|
| `VehicleStatusChanged` | fleet: a status change by hand, retirement, the workshop following repairs (FMS-76) |
| `FailureRecorded` | maintenance: a failure on a repair (FMS-125) |
| `MaintenanceRecordOpened`, `MaintenanceRecordUpdated`, `MaintenanceRecordCompleted` | maintenance: a repair's type and completion end a breakdown |

The projection takes an advisory lock per vehicle, so two changes to the same vehicle at once do not interleave. It removes the periods no longer derived, then adds or corrects the rest, oldest first, leaving a staff reason alone.

The rebuild (`downtime-sync`, daily at 03:25, and `rebuildReadModels()` after the seed or an import) runs the same code for every vehicle, 200 to a transaction, so the rebuild and the live projection cannot disagree. A period it has to add, correct or remove means a change came without its event, and it logs that as a warning (`vehicles`, `added`, `repaired`, `removed` in the run history).

## The KPIs

`GET /analytics/downtime` (`analytics:read`; `month` as `YYYY-MM` in Addis Ababa, this month up to now by default; `depot_id`, `vehicle_id`). For each vehicle in the caller's scope that was in the fleet that month, each depot and the fleet:

| Field | Meaning |
|---|---|
| `in_fleet_minutes` | The month, from the vehicle's registration (`created_at`) and until its retirement |
| `downtime_minutes`, `uptime_minutes` | Time in a period, and the rest |
| `availability_pct` | Up over in the fleet, to a tenth of a percent |
| `failures`, `mtbf_minutes` | Unplanned periods that began in the month; time up per failure |
| `repairs`, `mttr_minutes` | Unplanned periods that ended in the month; their whole length per repair, from before the month too |
| `unplanned_downtime_minutes`, `downtime_by_reason` | Time in unplanned periods; time in each reason's periods |

A depot's and the fleet's figures are sums over their vehicles, then divided: the depot's availability is its vehicles' time up over their time in the fleet, not an average of percentages. A ratio with nothing to divide by is `null`. Vehicles come worst availability first.

A worked month (the unit and integration tests use it). September has 43,200 minutes. A truck is in the workshop for preventive work for 48 hours, breaks down for 12 hours, and is in for an unplanned repair for 24 hours:

- downtime 84 h = 5,040 min, uptime 38,160 min, availability 38,160 / 43,200 = **88.3%**;
- two failures began in September: MTBF 38,160 / 2 = **19,080 min** (318 h);
- two repairs ended in September, 12 h and 24 h: MTTR 2,160 / 2 = **1,080 min** (18 h).

The answer is computed live from `analytics.downtime_facts` and `analytics.vehicle_service_spans` on the read replica, not from `analytics_cache`, and says how far behind it may be in `meta.data_freshness`. A month is at most a few periods per vehicle, so it is not cached.

## Reading a vehicle's periods

`GET /vehicles/{vehicle_id}/downtime` (`vehicle:read`, depot scope, `404` outside it): every period, newest first, paged, with its length in minutes (to now while it lasts), reason, whether it is unplanned, the derived reason, the staff reason's note and author, what opened it, and its work order and failure.

## Not covered

- The cost of downtime. Repair costs are in the maintenance records a period links; the revenue a day off the road loses is not in the system.
- Downtime a flag alone causes. A vehicle with an open maintenance flag but still `active` is not down unless a breakdown or a status change says so.
- A history from before the status history existed (migration 029): earlier downtime is unknown.

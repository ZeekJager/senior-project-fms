# Driving distance limits (FMS-156)

A driver is never assigned a trip that would take them past a set distance in one day or one week. Heavier jobs count for more of the limit. The aim is fewer accidents from fatigue.

This is a safety rule, like BR-1 (overlap), BR-2 (maintenance flag) and BR-8 (licence class):

- An approval (FMS-151, [assignment-exceptions.md](assignment-exceptions.md)) never overrides it. A request for approval is refused by it before it is made, and an approval checks it again.
- It decides new assignments only. A trip already under way is never stopped by it.
- It does not replace the hours-based fatigue warning (FMS-154). Hours behind the wheel and distance are both kept.

## The rule

A driver's **load-weighted distance** for a period is the sum, over their trips that start in it, of each trip's distance times its job load's weight.

| Job load (FMS-153, [job-load.md](job-load.md)) | Weight (default) |
|---|---|
| Light | 0.80 |
| Standard | 1.00 |
| Heavy | 1.50 |

The trips that count are the driver's `assigned`, `en_route` and `completed` ones. Cancelled, draft and scheduled trips do not count.

The distance of each trip:

- **Completed and measured (FMS-145, [trip-distance.md](trip-distance.md)):** the measured distance.
- **Assigned, under way, or completed but not yet measured:** the planned distance.
- **The trip being assigned:** its planned distance.
- **No distance known:** 0 km.

Each trip's job load is worked out as the trip's own `job_load` is. For the trip being assigned, it uses the payload of the vehicle being assigned.

The periods are in Addis Ababa time (UTC+3 all year):

- **A day** is a calendar day.
- **A week** runs Monday to Sunday.
- A trip counts in the day and the week it is **scheduled to start**. A trip over midnight counts only on its start day.

| Limit | Default | Range |
|---|---|---|
| `daily_distance_km` | 500 | 50-2000 |
| `weekly_distance_km` | 2500 | 100-10000, at least the daily limit |

A weight is 0.50-3.00 with at most two decimals. A heavier load never weighs less than a lighter one (light ≤ standard ≤ heavy).

Sums are rounded to 0.1 km. Reaching a limit exactly is allowed; going past it is refused. At 80% of a limit or more, the console warns but does not block.

> **To confirm with the client:** the defaults are placeholders. Confirm the limits and weights for Ethiopian commercial drivers with the client or the transport authority before they ship. The rule's shape does not depend on them.

## Where it applies

- **`POST /trips/{id}/assign`:** after the overlap rules, the trip is refused when it takes the driver past either limit, with `409 CONFLICT_DRIVER_DISTANCE_LIMIT`. Assigning by the API is refused the same way. The day is named before the week.

  ```json
  {
    "code": "CONFLICT_DRIVER_DISTANCE_LIMIT",
    "message": "Would drive 560 of 500 km today: the driver's daily distance limit.",
    "details": [{ "field": "driver_id", "reason": "distance_limit", "period": "day", "limit_km": 500, "total_km": 560, "without_trip_km": 410 }]
  }
  ```

- **`POST /assignment-exceptions/{id}/approve`:** every rule is checked again, this one included.
- **`PATCH /trips/{id}`:**
  - A change of times or cargo checks the rule again for the changed trip, if it is assigned.
  - It does the same for any trip that `shift_following` moved later. When a moved trip goes over, its id is the detail's `record_id`.
  - The whole change is refused, and nothing moves.
- **`POST /trips/{id}/start`:** not checked. Neither is a change to the end of a trip under way.
- **`GET /dispatch/availability` with `exclude_trip_id`:** each driver has a `distance` showing where they stand with that trip:

  ```json
  {
    "trip_km": 250,
    "day":  { "period": "day",  "limit_km": 500,  "without_km": 280, "with_km": 530, "left_km": -30 },
    "week": { "period": "week", "limit_km": 2500, "without_km": 900, "with_km": 1150, "left_km": 1350 },
    "over": { "period": "day", "limit_km": 500, "without_km": 280, "with_km": 530, "left_km": -30 },
    "near": null
  }
  ```

  How the board shows it:
  - **Over a limit:** the driver's availability gains a block, `distance_limit` (with `period`, `limit_km`, `total_km`), so they are `unavailable` for the trip.
  - **At 80% of a limit:** a warning, `distance_limit_near`.
  - **Without a trip:** `distance` is `null`.

## On the screens

- **S-07, the dispatch console:**
  - A driver past a limit shows as not free for the trip, with *Would drive 560 of 500 km today* in red.
  - Below the limits, the card shows what the trip leaves, for example *180 km left today · 900 this week*. It is amber at 80% of a limit.
  - A refused assignment says the same in the panel, with the total without the trip.
- **S-27, Settings:**
  - *Driving distance limits* sets the two limits and the three weights, for the fleet and for each depot that has its own.
  - The screen checks the ranges and order before sending, and the API checks them again (`400`).
  - Changes are audited, as are the other driving rules.

## Implementation

- **Migration 074:**
  - `tracking.rule_thresholds` gains `daily_distance_km`, `weekly_distance_km` and `distance_weight_light`, `_standard`, `_heavy`.
  - The checks are `chk_rule_distance_limits` and `chk_rule_distance_weights`.
  - `idx_trip_trips_driver_start` indexes the trips the rule reads.
- **`trip/domain/distance-limit.ts`:** the pure rule: the day and the week, the counted km, the standing, and the 409.
- **`trip/application/distance-limit.service.ts`:**
  - Reads the driver's trips of the week and the depot's limits, which come from the integration module through `provideDistanceLimits`.
  - Before checking a driver, it takes a per-driver advisory lock for the transaction, so two trips given to one driver at once are checked one after the other.
- **`fleet/application/dispatch.service.ts`:** adds the standing and its reasons to the board through `tripDistanceLimits.forBoard`, on the board's own transaction.

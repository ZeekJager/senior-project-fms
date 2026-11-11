# Analytics (FMS-50)

The fleet KPIs behind the analytics dashboard (S-18): six read-only endpoints under `/analytics` (api-contract §14), served from a pre-aggregated cache so they stay fast for a 200-vehicle fleet over a year.

## The cache

`analytics.analytics_cache` holds **one row per vehicle and Addis Ababa day** (`period_type = 'day'`), with its raw figures and the day's ratios:

| Column | What |
|---|---|
| `utilisation_pct` | 100 when a completed or running trip of the vehicle overlapped the day, else 0 |
| `distance_m` | Completed trips' `actual_distance_km` (measured as each trip ends, [trip-distance.md](trip-distance.md)), in metres, on the day the trip ended |
| `trips_completed`, `trips_timed`, `trips_on_time` | Completed trips that day; those with a scheduled end; those that ended within 15 minutes of it |
| `fuel_ml`, `fuel_cost_cents` | Fuel logged that day (`recorded_at`) |
| `maintenance_cost_cents` | Maintenance records completed that day (`completed_at`) |
| `cost_per_km_cents`, `driver_on_time_pct` | The day's ratios (0 and null with nothing driven or timed) |
| `computed_at` | When the refresh wrote the row |

A range's KPIs are **sums of its days**, then divided once: utilisation is vehicle-days used over vehicle-days, cost per km is (fuel + repair cost) × 1000 over metres. Every ratio is an integer, rounded half away from zero in BigInt (`roundDiv`), and `null` when there is nothing to divide by. Retired vehicles get no rows.

The analytics module reads only its own schema (CONVENTIONS rule 3): the cache and the views of migration 044, `vehicle_directory`, `trip_facts`, `fuel_facts`, `maintenance_cost_facts` and `alert_facts`, with `maintenance_risk_summary` from migration 011.

## Refresh

| Job | When | Days recomputed |
|---|---|---|
| `analytics-refresh-hourly` | every hour | today and yesterday |
| `analytics-refresh-nightly` | 02:15 | the last 35 days, for fill-ups, trips and repair costs entered late |

Each run aggregates on the read replica (FMS-94), upserts the rows on the primary in batches of 5,000, and then drops every cached analytics answer in Redis. An empty cache is first filled **400 days back**, so a new install or a truncated cache has a year of history after one run. The run's result (rows, vehicles, whether it backfilled, which database it read) is in the job history.

## Answers

- **Redis:** each answer is kept for 5 minutes per endpoint, caller scope (all depots, one depot), `depot_id` and range, and dropped by every refresh. Without Redis every request reads the cache table, which still answers a 200-vehicle month in well under 200 ms.
- **Stale:** `meta.computed_at` is the last refresh; `meta.stale` is `true` when that is more than 25 hours ago (both refreshes have failed for a day) or the cache was never filled. The dashboard shows a banner then.
- **Freshness:** `meta.data_freshness` says which database answered and how far behind it was (read-replica.md).
- **Live parts:** vehicles by status, health scores, open alerts, maintenance risk and alerts raised are read from the views at request time (still through Redis), not from the cache.

## Downtime

`GET /analytics/downtime` (FMS-131) is not from the cache: availability, MTBF and MTTR for a month are computed live from fleet's downtime periods (`analytics.downtime_facts`) and when each vehicle joined the fleet and was retired (`analytics.vehicle_service_spans`), on the read replica. See [downtime.md](downtime.md).

## The driver performance score

Card FMS-146 (SE-190). Closes FR-4 and FR-20 of the Requirement Validation Report. One score from 0 to 100 per driver
per Addis Ababa month, computed live from the analytics views on the read replica (not cached), by the pure function
`domain/driver-score.ts`.

**The parts**, each 0 to 100:

| Part | From | 100 | 0 | Not judged |
|---|---|---|---|---|
| Punctuality | Completed trips ended within 15 minutes of their scheduled end, over those with one | All on time | None | No trip had a scheduled end |
| Safety | Speeding and idling flags raised on the driver's trips, per 100 km | None | 5 per 100 km | Under 10 km driven |
| Incidents | The driver's accidents (incident type `accident`), per 100 km | None | 0.5 per 100 km (one every 200 km) | Under 10 km driven |
| DVIR completion | Completed trips with the driver's pre-trip inspection (`analytics.dvir_facts`, migration 067) | Every trip | None | No completed trip |

Between 100 and 0, a rate falls linearly. A completed trip counts in the month it ended, flags and incidents in the
month they happened, as in the driver performance report. The km are the trips' actual distances (FMS-145,
[trip-distance.md](trip-distance.md)).

**At fault.** An incident does not record who was at fault. Until it does, the score counts accidents only, the type a
driver is answerable for: a breakdown, a flat tyre, theft, vandalism or a road hazard does not lower it.

**The score** is the mean of the parts that can be judged, weighted by the `driver_score_weight_*` settings (defaults
35, 35, 20, 10: [settings.md](settings.md#driver-score-settingssettings)), over the weights of those parts. A part that
cannot be judged is left out, not counted as 0. Rounded to a whole number.

- **Fewer than 3 completed trips:** no score (`not_enough_trips`), not a low one. The parts are still worked out, so a
  driver can see them.
- **No judged part has a weight:** no score (`nothing_to_judge`).

**The ranking.** The highest score ranks first. A tie goes to the higher punctuality (none counts lowest), then by name
for a steady order. Drivers equal in both share a rank, and the next rank skips (1, 2, 2, 4). Drivers with no score are
not ranked.

**Who sees what.** The score is behavioural data, so it is only for the roles allowed `tracking:read`:

| Where | What | Needs |
|---|---|---|
| The driver performance report (S-28, [reports.md](reports.md)) and its CSV and PDF | Rank and score columns, rows in rank order | `analytics:read` and `tracking:read`; without `tracking:read` the columns are left out |
| `GET /analytics/driver-ranking?month=&depot_id=` | Scored drivers in rank order with their parts, and how many had no score | `analytics:read` and `tracking:read` |
| S-18, the analytics dashboard | *Driver ranking*: last whole month, a horizontal bar per driver (all up to 20, else the top and bottom 10), with a link to the full list in the report | `tracking:read` |
| `GET /analytics/my-performance?month=` and *My score* in the driver app, from My day | The driver's own score and its parts, with what each came from: never another driver's, never a rank | `trip:execute`, signed in as a driver (404 for staff) |

**Tests.** The scoring is unit-tested (`domain/driver-score.test.ts`): each part, the weights, the minimum-trips rule,
parts not judged, ties. `test/integration/driver-score.test.ts` covers the report and its CSV, the columns left out for
a finance clerk, the weights changed in Settings, the ranking and who may read it, and a driver's own record.

## Not covered

- Weekly and monthly rows (`period_type` `week`, `month`): a range is summed from days instead.
- Downtime, MTBF and MTTR (FMS-131).

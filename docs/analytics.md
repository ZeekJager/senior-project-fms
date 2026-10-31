# Analytics (FMS-50)

The fleet KPIs behind the analytics dashboard (S-18): six read-only endpoints under `/analytics` (api-contract §14), served from a pre-aggregated cache so they stay fast for a 200-vehicle fleet over a year.

## The cache

`analytics.analytics_cache` holds **one row per vehicle and Addis Ababa day** (`period_type = 'day'`), with its raw figures and the day's ratios:

| Column | What |
|---|---|
| `utilisation_pct` | 100 when a completed or running trip of the vehicle overlapped the day, else 0 |
| `distance_m` | Completed trips' `actual_distance_km`, in metres, on the day the trip ended |
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

## Not covered

- Weekly and monthly rows (`period_type` `week`, `month`): a range is summed from days instead.
- Downtime, MTBF and MTTR (FMS-131).

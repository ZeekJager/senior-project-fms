# Fuel reconciliation (FMS-41)

Card: FMS-41 (SE-77). Code:

- `packages/backend/src/modules/fuel/`: `domain/reconciliation.ts` (the rules and the integer maths), `application/reconciliation.service.ts`, `infrastructure/fuel-anomaly.repository.ts` and `api/reconciliation.routes.ts`;
- the reads in other modules: `fleet/infrastructure/fuel-reconciliation.queries.ts` (vehicles and their rating) and `completedTripMetres` in `trip/infrastructure/trip-usage.queries.ts`;
- migration 041.

Architecture §9.3 (consumption, efficiency, anomaly detection), §33 (`FuelAnomalyDetected`), Scenario A.

Every vehicle has a rated consumption, `fuel_efficiency_ml_per_km`, set when it is registered. The reconciliation compares the fuel logged for a vehicle with what its trips should have used at that rating. A vehicle far off either way is flagged, so fuel fraud shows up without anyone going through spreadsheets.

## The figures

For a vehicle and a period:

| Figure | From |
|---|---|
| Distance | Its completed trips whose `actual_end` is in the period: `actual_distance_km`, summed in whole metres |
| Expected fuel | Distance × rating: metres × ml/km ÷ 1000 |
| Actual fuel | Its fuel logs whose `recorded_at` is in the period (when the fill-up happened, FMS-115), in ml |
| Variance | (actual − expected) ÷ expected, in whole percent |

**Integers only (§17).** Distance is in metres, fuel in ml, money in cents and the variance in whole percent. Each division is rounded half away from zero, in BigInt, so no figure passes through a float. The database sums are read as text for the same reason.

## The judgement

| Variance | Status |
|---|---|
| More than `FUEL_VARIANCE_THRESHOLD_PCT` above (default 20) | `above`: fuel bought that the driving does not explain |
| More than the threshold below | `below`: fill-ups missing, or distance recorded that was not driven |
| Anything else, the threshold itself included | `within` |

Some vehicles are not judged (`not_judged`, with a `reason`):
- `electric`: an electric vehicle;
- `no_efficiency`: a vehicle with no rating;
- `too_little_distance`: one with under 100 km of trips. A single tank filled just before the period outweighs that little driving.

The threshold is read on every call, so tests can change it.

## The monthly run

The job `fuel-reconciliation` runs daily at 04:30 Addis Ababa ([jobs.md](jobs.md)). It always reconciles the calendar month before the run's day.

1. It reads every vehicle, with one query each for the vehicles, their trips and their fuel. A retired vehicle counts only if it had trips or fill-ups that month.
2. For each vehicle `above` or `below`, one transaction:
   - writes a `fuel.fuel_anomalies` row (audited as the system, with the run's correlation id);
   - publishes `FuelAnomalyDetected`.

**Each vehicle is flagged at most once a month.** The first run of the month (on the 1st) does the work. Later runs flag only a vehicle that has since gone over, and never flag one twice. A fill-up can be logged up to 30 days late (FMS-115), and a late trip can complete, so the month is checked again until its data can no longer change.

The guarantees:
- the unique index `ux_fuel_anomalies_period` (vehicle, period);
- a fixed event id per vehicle and month.

**A late trip can bring a flagged vehicle back within the threshold.** The anomaly stays open for someone to review: a flag is never withdrawn on its own.

**The anomaly row:**
- `fuel_log_id`: null;
- `anomaly_type`: `consumption_above_expected` or `consumption_below_expected`;
- `severity`: `high` beyond twice the threshold, otherwise `medium`;
- `status`: `open`;
- `period_start` and `period_end`;
- `distance_km`, `expected_ml` and `actual_ml`;
- `deviation_percentage`;
- `expected_consumption_ml_100km` and `actual_consumption_ml_100km`.

The run's history holds `period` (`YYYY-MM`) and these counts: `vehicles`, `within`, `above`, `below`, `not_judged`, `anomalies`, `already_flagged`, `threshold_pct` and `duration_ms`.

**The alert.** The alert engine raises a `fuel_anomaly` alert for the depot admin and the fleet manager ([alerts.md](alerts.md)). It reads, for example: "Fuel logged in September 2026 was 25% more than its 1,000 km of trips needed. Check its fill-ups against its trips."

**Where it reads.** Every read, the job's and the API's, goes to the read replica when it is up (FMS-94, [read-replica.md](read-replica.md)): one session per request or run. The anomalies are written on the primary. No query takes a lock, which a replica refuses, so the depot filter uses a lookup that does not lock (`fuelDepotInScope`). The run's history adds `read_from` and `replica_lag_seconds`; the endpoints return `meta.data_freshness`.

**Speed.** The card's budget is 200 vehicles over a month in under 60 seconds. The integration test does it in about 0.6 s, with 20 trips and 8 fill-ups per vehicle.

## The API

Both endpoints only read ([api-contract §9.1–9.2](api-contract.md#9-fuel-tracking-and-reconciliation-api), OpenAPI).

**`GET /fuel-reconciliation`** reconciles any period on demand. It defaults to last calendar month and covers at most 366 days.
- **Who:** it needs both `analytics:read` and `fuel:read`. That allows administrators, fleet managers, finance clerks, compliance officers and fleet owners. Drivers (`fuel:read` only) and dispatchers (`analytics:read` only) get `403`.
- **Rows:** the vehicles in the caller's depots, furthest from expected first (either way), with not-judged vehicles last.
- **Filters:** `vehicle_id`, `depot_id` and `status`. A vehicle or depot outside the caller's depots gives an empty page.
- **`anomaly_id`:** set when the monthly run raised an anomaly for exactly this period.
- **`meta.summary`:** totals for every vehicle in the period, whatever the status filter. It is for the dashboard's summary band (FMS-42).

**`GET /vehicles/{vehicle_id}/fuel-summary`** gives one vehicle's fuel over a period. It defaults to the 30 days up to now.
- **What it returns:**
  - the reconciliation figures;
  - actual efficiency (ml per km driven);
  - cost per km and average price per litre (cents);
  - the vehicle's open anomalies.
- **Who:** it needs `fuel:read`, in the depot scope. A driver gets `404` for every vehicle: a vehicle's totals include other drivers' fill-ups, and a driver may read only their own (FMS-39).

## The screen (S-15, FMS-42)

`/fuel-reconciliation`, under Fleet management, for anyone with `fuel-anomaly:read`. Code: `packages/frontend/src/pages/FuelReconciliation/`.

**Vehicles tab.** It needs `analytics:read` and `fuel:read` too, so a depot admin sees the anomalies only.
- **The month:** a month stepper picks it (last month by default, never a month not yet begun). Administrators and fleet managers also get a depot filter.
- **The summary band:**
  - fuel logged (litres, fill-ups);
  - fuel cost (ETB);
  - the judged vehicles against what their trips needed;
  - how many are flagged.
- **The table:** every vehicle with trips or fill-ups that month, furthest from expected first, so a flag always tops the list. Each row shows trips driven, what the trips needed, what was logged, the variance (percent and litres), the cost, and a mark:

| Mark | When (threshold 20%) |
|---|---|
| Flag (red, the row tinted) | More than the threshold off, either way: an anomaly |
| Watch (amber) | More than half the threshold off |
| OK (green) | Within half the threshold |
| Not judged (grey) | Electric, no rated consumption, or under 100 km of trips, with the reason |

- **Filtering:** the marks are views with their counts, worked out on the page from every row of the month, which it fetches in pages of 100.
- **Review anomaly:** a flagged row whose month the job flagged links to its anomaly.
- **Export CSV:** downloads every vehicle of the month from the rows already loaded, so there is no wait. Litres go to the millilitre and birr to the cent, both from the integers.
- **Data freshness:** "Data as of 14:05". When the read replica is 5 s or more behind, it adds how far behind live the data is (FMS-94).

**Anomalies tab.**
- **The list:** "Needs review" (open and reviewed, the default) first, then Resolved, Dismissed and All, with counts. The tab itself shows how many need review.
- **An anomaly** opens in a drawer: what the trips needed against what was logged, the period, the distance and when it was detected.
- **Closing it** needs `fuel-anomaly:write`. Choose Resolved (it was real and dealt with) or Not a problem (dismissed, with a note saying why). Closing records the person and the time, and the drawer then shows "Resolved by …" with the note.
- **Without the permission**, the anomaly can be read but not closed.
- **A fuel-anomaly notification** opens the anomaly itself (`?tab=anomalies&anomaly=<id>`).

## Not covered yet

- **Distance comes from completed trips only.** Driving outside a trip is not counted, so fuel used on it reads as `above`. A vehicle with fill-ups and no trips is `too_little_distance`, so it is not judged at all.
- **Fill-ups are counted when they happen, not by what they fuel.** A tank filled on the last day of a month is that month's, even though it fuels the next month's driving. Over a month of regular driving this evens out. The 100 km floor keeps out the periods where it does not.
- **The per-fill-up anomaly rules** are FMS-82 (SE-126). Their anomalies will show on the same screen, named by type.

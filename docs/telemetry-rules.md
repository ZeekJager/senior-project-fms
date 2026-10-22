# Telemetry rules: speeding and idling (FMS-46)

The telemetry rules watch every vehicle's GPS pings and flag unsafe or wasteful driving, so a dispatcher is told instead of watching 200 markers. A flag becomes an alert through the alert engine ([alerts.md](alerts.md)), shows on the live map ([live-map.md](live-map.md)), and can be listed per vehicle.

Code: `integration/domain/telemetry-rules.ts` (the rules, pure), `integration/application/telemetry-rules.service.ts` (the consumer), `integration/infrastructure/telemetry-flag.repository.ts` and `rule-state.store.ts`. Table changes: migration 035.

## The rules

| Rule | Opens a flag when | Closes it when | Severity |
|---|---|---|---|
| Speeding | 3 pings in a row over 80 km/h | 3 pings in a row at or under 80 km/h | high |
| Idling | 5 minutes at 0 km/h, engine not reported off | the vehicle moves, the engine is reported off, or the signal is lost | medium |

- **Consecutive** means in recorded order, at most 2 minutes apart (the live map's "no ping" limit). After a longer gap the counts start again. An idling flag closes at the last ping before the gap, since the stop can no longer be vouched for.
- **Exactly the limit is not speeding.** 80 km/h counts towards clearing a flag.
- **The engine.** A ping with `ignition_on: false` is parked, not idling. A source that does not report the engine (a driver's phone, `null`) counts as running.
- **One flag of each type per vehicle at a time.** More pings over the limit keep the same flag open. The database enforces it: `ux_telemetry_flags_ongoing` allows one row per vehicle and type with `resolved_at` NULL.
- **When.** `observed_at` is when the condition began: the first ping over the limit, or the first ping of the stop. `resolved_at` is when it ended: the first of the clearing pings, the ping that moved, or the last ping before a gap.

## Thresholds (CFG-3)

`tracking.rule_thresholds` holds them: one row for the whole fleet (`depot_id` NULL), and one per depot that differs.

| Column | Fleet default | Range |
|---|---|---|
| `speed_limit_kmh` | 80 | 20-200 |
| `speeding_pings` | 3 | 1-20 |
| `clear_pings` | 3 | 1-20 |
| `idle_minutes` | 5 | 1-120 |

A depot's row replaces the whole fleet row for its vehicles. Each instance re-reads thresholds at most once a minute per depot, so a change takes effect within a minute. There is no screen or API to change them yet. Use SQL as the admin role:

```sql
-- Adama: 60 km/h, flagged after 2 pings
INSERT INTO tracking.rule_thresholds (depot_id, speed_limit_kmh, speeding_pings)
SELECT id, 60, 2 FROM fleet.depots WHERE code = 'ADM-01'
ON CONFLICT ON CONSTRAINT ux_rule_thresholds_depot
DO UPDATE SET speed_limit_kmh = EXCLUDED.speed_limit_kmh, speeding_pings = EXCLUDED.speeding_pings;
```

The 80 km/h default stands until the Compliance Officer says whether it is national law, operator policy, or per depot (SE-82, CFG-4).

## How it runs

`integration.telemetry-rules` consumes `VehicleLocationUpdated` ([gps-ingestion.md](gps-ingestion.md)):

1. It reads the vehicle's stored pings after the last one it checked, up to the announced one, oldest first. Ingestion announces a vehicle at most once every 5 s, so one event can cover several pings (a batch, a phone's buffer), and each ping still counts. At most 1,000 pings are read per event; the rest wait for the next event.
2. It runs them through the rules, starting from the vehicle's counters and its flags open in the database.
3. It opens and closes flags in `tracking.telemetry_flags`, and publishes `TelemetryFlagRaised` or `TelemetryFlagResolved` for each. Both happen on the event's transaction, so a flag never exists without its event.
4. It saves the counters.

A vehicle with no counters (first seen, or silent for over 24 hours) starts with its pings from the last `idle_minutes` plus 2 minutes.

A ping that arrives after newer ones were checked (a phone's late buffer) is stored, but the rules do not check it: they have moved past its time. SE-168 (buffered phone pings) may revisit this.

## Counters: Redis

The counters per vehicle are small: the last ping checked, the run over the limit, the run clearing it, and when the stop began. They live in Redis at `fms:state:integration:telemetry:<vehicle public id>`, kept 24 hours. A restart or another instance carries on counting where it stopped. The integration test "restarting the app does not reset the counters" checks this.

- **At least once.** The outbox may deliver an event again when its transaction did not commit. The stored value keeps the counters from before the event as well as after it, and an event handled again starts from the "before" ones, so it decides the same. A flag cannot be opened twice anyway: the database refuses a second ongoing one, and closing a closed flag changes nothing.
- **Redis down.** The rules count in process and log `telemetry rule state: Redis failed`. Pings are still checked. When Redis returns, the newer of the two copies wins.

## Flags

A `tracking.telemetry_flags` row: `flag_type`, `severity`, `observed_at`, `resolved_at`, `trip_id` (the trip the pings were stored with), and `details`:

- On opening: `speed_limit_kmh`, `speed_kmh` and `consecutive_pings` (speeding), or `idle_minutes` (idling); and `lat`, `lng` and `flagged_at` (the ping that crossed the threshold).
- On closing, added: `end_reason` (`cleared`, `moving`, `engine_off`, `signal_lost`), `duration_seconds` and, for speeding, `max_speed_kmh` (the top speed between start and end).

`status` (`open`, `reviewed`, `dismissed`, `resolved`) is the review status, someone's to change, and the rules never touch it. Flags are not audited row by row: like the pings, they are derived from telemetry, and their events record each one.

## Events, alerts and sockets

- **`TelemetryFlagRaised`:** `flag_id`, `vehicle_id`, `depot_id`, `trip_id`, `driver_id`, `flag_type`, `severity`, `observed_at`, `details`. `TelemetryFlagResolved` adds `resolved_at`. Aggregate `vehicle` (CONVENTIONS.md, Events).
- **The alert engine** makes `TelemetryFlagRaised` an `unsafe_driving` alert for the dispatcher and depot admin. "Speeding: AA 3-12345" is high; "Idling: ..." is medium. A repeat within 30 minutes adds an occurrence to the same alert. A resolved flag does not resolve the alert: someone acknowledges it.
- **Sockets:** both events reach the `tracking` room of the vehicle's depot as `vehicle.flag.changed` ([realtime.md](realtime.md)), without the driver. The live map re-reads its snapshot on it, and the snapshot's cache is dropped on both events.

## Reading flags

`GET /vehicles/{vehicle_id}/telemetry-flags` (api-contract §11.1) lists a vehicle's flags, newest first.

- **Filters:** `flag_type` (comma-separated), `from`/`to` (an ISO time with offset, on `observed_at`), `ongoing` (`true` or `false`), `limit` (1-200, default 50).
- **Behavioural data (§24.3):** `tracking:read` only (admin, fleet manager, dispatcher, depot admin, compliance officer, fleet owner), never drivers, and in the caller's depot scope: a vehicle in another depot is a 404. The response names the trip, not the driver.

## Trying it

The GPS simulator has speeding vehicles (95-115 km/h) and idling ones (0 km/h, engine on):

```sh
npm run simulate:gps -w fms-backend -- --vehicles 50 --interval 10 --speeding 0.1 --idling 0.1
```

Speeding flags appear after the third ping (30 s), idling ones after 5 minutes. They show on the live map's legend and as alerts.

## Not done here

- A screen or API to change thresholds (SQL for now, above).
- Harsh braking, geofences and route deviation: other flag types of the same table, for later cards.
- Reviewing a flag (`status`): the compliance workflow.

# GPS ingestion and the simulator

Card: FMS-88 (SE-132). Code: `packages/backend/src/modules/integration/` (the integration module owns the `tracking` schema), `scripts/gps-device.ts`, `scripts/simulate-gps.ts`. Architecture §20, Scenario B: device → API → PostgreSQL → Redis → Socket.IO. api-contract §11.1 and §15.

Positions reach the system one way, whoever sends them: tracker devices, drivers' phones, and telematics providers through the integration gateway's webhooks ([integrations.md](integrations.md)). Each becomes a row in `tracking.gps_pings`. The vehicle's row in `tracking.vehicle_current_location` follows (trigger, migration 007), and `VehicleLocationUpdated` goes out to the live map (FMS-45) through the real-time gateway ([realtime.md](realtime.md)).

## Who may report what

| Caller | How it signs in | May report for |
|---|---|---|
| A tracker device | `Authorization: Bearer fmsd_...`, its own token | Its own vehicle only. A ping naming another `vehicle_id` gets the whole batch 403 (`not_your_vehicle`) |
| A driver's phone | Session cookie; `trip:execute` | The vehicle of the driver's trip under way only. With no trip `en_route`, 403 (`no_trip_under_way`); another vehicle, 403 |
| A user with `tracking:ingest` (admin) | Session cookie | Any vehicle in their scope, named by `vehicle_id` on every ping (400 `required` when missing). An unknown one is refused alone (`unknown_vehicle`) |
| A telematics provider | Signed webhook (integrations.md) | Its own devices, by the identifier it gives them. A device of another provider, or none, is `unknown_device` |

**Tokens and audit:**
- **Storage:** a device token is shown once when issued. Only its SHA-256 is stored (`integration.gps_devices.token_hash`) and audited as `[REDACTED]`.
- **Revocation:** a new token for the same device stops the old one. Installing another device in the vehicle takes the first out of service; a vehicle has one active device.
- **Audit:** device requests are audited as machine traffic (`request_source.channel` = `webhook`, no user).

```bash
npm run device:register -- --vehicle "AA 3-12345" --identifier TRK-0042
npm run device:register -- --vehicle <public id> --identifier GT-1001 --provider geotab-et   # a provider's device
```

## POST /api/v1/tracking/gps-pings

```json
{ "pings": [
  { "recorded_at": "2026-10-21T09:00:00+03:00", "lat": 9.0108, "lng": 38.7613, "speed_kmh": 42.6,
    "heading": 90, "accuracy_m": 6, "altitude_m": 2355, "ignition_on": true, "odometer_km": 123456.7 }
] }
```

- **Batch checks (400, nothing stored).**
  - 1 to 500 pings.
  - `recorded_at` an ISO time with offset.
  - `lat` -90 to 90, `lng` -180 to 180, `speed_kmh` 0 to 300, `heading` 0 to 360.
  - Unknown fields are refused.
  - The error names the field (`pings.3.lat`).
- **Ping checks (that ping refused, the rest stored).**
  - `future_timestamp`: more than 2 minutes ahead of the server clock.
  - `too_old`: more than 7 days old.
  - `low_accuracy`: `accuracy_m` above 500.
  - `vehicle_retired`, `unknown_vehicle`, `unknown_device`.

  A phone that was offline sends what it buffered; anything within a week is kept.
- **Speed** is stored as whole km/h, rounded to the nearest (42.6 becomes 43; api-contract §17).
- **Duplicates.** A ping already stored (the same vehicle at the same instant, `uq_gps_ping_vehicle_time`) is skipped by the insert (`ON CONFLICT DO NOTHING`), so **a retried batch stores nothing twice**.
- **Trip.** Each ping gets the vehicle's trip under way; a phone's is always its driver's.
- **Answer.** `202 { data: { accepted, duplicates, rejected: [{ index, reason }] } }`. One statement inserts the batch and one audit entry records it (`tracking.pings_ingested`, with the counts). An audit row per ping would double the telemetry.

## VehicleLocationUpdated

After the insert, each vehicle's newest stored ping is announced if it became the vehicle's current position, and if it is at least `TRACKING_EVENT_INTERVAL_SECONDS` (default 5) newer than the last position announced. The time is measured on the vehicle's own clock.

`vehicle_current_location.event_recorded_at` holds that last time. The UPDATE that checks it also sets it, so two batches or two API instances never announce the same vehicle twice. A late ping, older than the current position, is stored but not announced.

- **Payload:** `vehicle_id`, `depot_id` (who receives it), `trip_id`, `lat`, `lng`, `speed`, `heading`, `recorded_at`. Aggregate `vehicle`.
- **Real-time:** the gateway forwards it as `vehicle.location.updated` (and the legacy `vehicle_position`) to the depot's `tracking` room.

## Telematics webhooks

A telematics provider without an adapter of its own posts the **FMS telematics format** to `POST /api/v1/webhooks/telematics/{code}`, signed as for every webhook:

```json
{ "event_id": "batch-8812",
  "positions": [ { "device_id": "GT-1001", "recorded_at": "...", "lat": 9.01, "lng": 38.76, "speed_kmh": 64.7 } ] }
```

The gateway stores the delivery and answers 202 (integrations.md). The consumer `integration.telematics-pings` then ingests its positions for that provider's devices, at least once; the pings' unique key makes a redelivery a no-op. A provider with its own format gets its own adapter, registered by code, which turns its format into this one.

## The simulator

```bash
npm run simulate:gps                                                  # 200 vehicles, every 10 s, for 60 s
npm run simulate:gps -- --vehicles 50 --interval 5 --duration 0       # until Ctrl+C
npm run simulate:gps -- --speeding 0.2 --idling 0.1 --api http://localhost:3000/api/v1
```

- **Setup:** it takes the first N active vehicles from the API's database (`make seed SIZE=budget` has 200). Each gets a simulated device (`sim-<vehicle id>`) and a fresh token.
- **Movement:** each vehicle drives back and forth along a route of its depot (origin, stops, destination; `scripts/simulator/motion.ts`), or a 1 km loop around its depot when the depot has none.
- **Scenarios:** `--speeding` vehicles drive at 95-115 km/h (the speeding rule, FMS-46), `--idling` ones stand still at 0 km/h with the engine on, and the rest drive at 25-70 km/h.
- **Timing:** each vehicle posts its own position once per interval, spread over the interval like real devices.
- **Report:** latency every interval. At the end: totals, p50, p95 and max latency, and how many vehicles' current location moved. It exits 1 if a request failed or a vehicle did not move.
- **Never production:** it replaces devices installed in the vehicles, so it refuses `NODE_ENV=production`.

**Measured (SE-132):** 200 vehicles every 10 s for 60 s against one local API instance (PostgreSQL and Redis on the same machine).
- 1,200 pings at 20 per second, all accepted;
- latency p50 6 ms, p95 9 ms, max 120 ms;
- the current location moved for 200 of 200 vehicles;
- all 1,200 `VehicleLocationUpdated` events dispatched and published to Redis, with an outbox lag of 0 afterwards;
- a signed-in socket received `vehicle.location.updated` for every simulated vehicle.

## Not yet

- **History:** `GET /vehicles/{id}/tracking` (api-contract §11.1) is not built yet. The current positions are read by the live map ([live-map.md](live-map.md)).
- **Phone timing:** a phone's pings are refused once its trip has ended, even if they were recorded during the trip.
- **Old pings:** `tracking.gps_pings` keeps its default partition; monthly partitions and a retention job come with the data volume.

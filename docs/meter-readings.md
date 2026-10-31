# Meter readings: odometer and engine hours (FMS-126)

Card: FMS-126 (SE-170). Code:

- `packages/backend/src/modules/fleet/`: `domain/meter.ts`, `application/meter.service.ts`, `infrastructure/meter.repository.ts` and `api/meter.routes.ts`;
- the daily ignition time in the integration module: `TrackingRepository.ignitionSeconds`, exported as `ignitionTime`.

Migration 038.

Before this card, a vehicle had one odometer, typed in by hand, and no engine hours at all. `fleet.meter_readings` now keeps every reading of both meters over time, with where each came from. Distance-based service intervals (FMS-129) and the predictive model's nightly scoring (FMS-55) read this history.

## Where readings come from

| Source | Meter | When | `source_ref` |
|---|---|---|---|
| `fuel_log` | odometer | Each fuel log, at the fill-up (`FuelLogged`) | The fuel log's id |
| `maintenance` | odometer | Each completed repair with an odometer, at its completion (`MaintenanceRecordCompleted`) | The repair's id |
| `telematics` | odometer | A vehicle's own GPS device or telematics provider: the newest odometer of a batch, at most one an hour per vehicle | The device's id |
| `manual` | odometer | A person registering a vehicle, or changing its `odometer_km` | `null` |
| `gps_derived` | engine hours | The nightly engine-hours job, one per vehicle and day | The day, `YYYY-MM-DD` |

Fuel-log and repair readings are recorded by the `fleet.meter-readings` consumer when the event is delivered, on its transaction. Device readings are recorded in the GPS batch's own transaction. A fuel log, a repair or a day has at most one reading: a redelivered event or a re-run job finds it and adds nothing.

**Which sources count.** An odometer sent by a driver's phone or a signed-in user is stored on the ping but is not a reading. Phones have no odometer, so the number is typed or made up.

**Sampling.** A device reports every few seconds, and the history needs the trend, not every ping. So a device reading is kept only when the vehicle's newest device reading is at least an hour older (`TELEMATICS_SAMPLE_MINUTES`).

**Missed events.** Data written without events (the seed, a restore), or an event that failed, would leave a fuel log or repair without its reading. The `meter-reading-sync` job (03:10) re-adds those from the last 30 days, oldest first. `rebuildReadModels()` re-adds them all, and the seed calls it.

## Suspect readings

A reading lower than the highest trusted reading recorded at or before it is stored with `suspect = true`. It is kept, not refused: a typo on a repair, or a device that was swapped, should still be visible. Later readings are checked against the trusted ones only.

**The vehicle's odometer** follows the highest trusted reading. A trusted reading above `fleet.vehicles.odometer_km` moves it up in the same transaction, with its own audit row. A suspect reading never moves it. Because `version` changes with the odometer, an edit form open while a device reports may get `409 CONFLICT_CONCURRENT_MODIFICATION` and must reload. That is the same rule as any other concurrent change.

Editing the odometer by hand keeps its rule: lower than the current value is `409 CONFLICT_ODOMETER_REGRESSION` (api-contract §6.2). Migration 038 gave every existing vehicle a first manual reading of its odometer, at its last update, so later readings have a floor to be checked against.

## Engine hours

Phones cannot tell whether the engine runs, and the core has no engine-hour meter. Engine hours are therefore derived from the ignition state that GPS devices and telematics providers send with each ping (`ignition_on`).

The `engine-hours` job runs at 01:00. It reads each local day before today, back 7 days, and skips days a vehicle already has.

- **Which vehicles:** those with at least one device or telematics ping that day carrying `ignition_on`. A vehicle whose engine was off all day gets a reading too, with nothing added. Phone-only vehicles get none.
- **The day's ignition time:** the pings in time order. The time from one ping to the next counts when the first had the ignition on and the next came within 10 minutes (`IGNITION_MAX_GAP_SECONDS`). A longer gap says nothing about the time in between (the device was off, or had no signal), so it counts nothing. Pings without `ignition_on` are skipped.
- **Day edges:** an interval across midnight counts on each day only its own part. The query also reads the pings up to 10 minutes either side of the day, so the interval is complete.
- **The reading:** the vehicle's last engine hours plus the day's time in hours, one decimal, at the end of the local day (00:00 Addis Ababa the next day). The first reading starts from 0, so engine hours count from when the device started reporting, not from the vehicle's dashboard meter.

A day already read is not recomputed. So pings for it that arrive after 01:00 the next day (a device that buffered while offline; ingestion accepts pings up to 7 days old, gps-ingestion.md) do not count.

## API

`GET /vehicles/{vehicle_id}/meter-readings` needs `vehicle:read`, in the depot scope of `GET /vehicles/{id}` (`404` outside it, or for an id that is not a UUID). It filters by:

- `meter`: `odometer` or `engine_hours`;
- `from` and `to`, on `recorded_at`: instants, or dates meaning Addis Ababa days, with `to` inclusive;
- `page` and `page_size`.

Results are newest first. Each `MeterReading` has `id`, `meter`, `value` (km or hours), `source`, `source_ref`, `recorded_at` (when the reading was true), `suspect` and `created_at`.

## The predictive model

The model's inputs (`packages/ai-service/feature_spec.json`, spec version 2) still compute the last 30 days' distance and engine hours from completed trips. Moving `engine_hours`, and perhaps `mileage_km`, onto these readings changes the spec and its hash, and so needs a retrained model (ml-dataset.md). That is decided with the nightly scoring (FMS-55).

## Tests

`test/integration/meter-readings.test.ts` covers:

- a fuel log and a completed repair each adding a reading once delivered, and the vehicle's odometer following the higher;
- a repair without an odometer adding none;
- a lower reading kept as suspect, and the odometer unchanged;
- a redelivered event and the sync adding nothing twice; the sync adding a missed fuel log, and only within 30 days;
- a device's odometer sampled hourly, a lower one suspect, and a signed-in user's odometer not a reading;
- the engine-hours job:
  - summing ignition time;
  - skipping a 3-hour gap;
  - ignoring pings without ignition data and phone pings;
  - a re-run adding nothing;
  - the next day adding up, and a day with the engine off reading 0 more;
- an interval across midnight split between the two days;
- `GET` with its filters, depot scope, 404s and 403.

The vehicle tests check the manual readings on registering and editing a vehicle. The seed test checks a reading for every registered vehicle, fuel log and completed repair with an odometer.

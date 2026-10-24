# Failure records (FMS-125)

A repair record says what was done. A failure record says what broke, how, and whether it was planned. Failure records are the fleet's real failure history: how often each component breaks per vehicle, make and model. They are also the labels the predictive model trains and is judged on (FMS-52/53). Before FMS-125 the model learned from synthetic labels only. Real labels exist only from the day failures are recorded, so this came before the ML cards.

## The record

`maintenance.failure_events` (migration 036). Each row holds:

- **What failed:** `component` and `failure_mode`, from the catalogues below.
- **Where it came from:** `vehicle_id`, and `maintenance_record_id` (the repair that found it) or `incident_report_id` (the incident that reported it).
- **How it happened:** `unplanned`, `detected_by`, `occurred_at` and `odometer_km`.
- **Notes and authorship:** `notes`, and `recorded_by` (the caller).

A failure is a fact, so it is never edited or deleted. Each insert writes one audit row.

| Field | Meaning |
|---|---|
| `component` | The part of the vehicle that failed (catalogue below). |
| `failure_mode` | How it failed (catalogue below). |
| `unplanned` | `true`: a breakdown, or a fault found in service (reported by the driver, a DVIR, telematics). `false`: found at planned work, such as a service or an inspection. The model learns from unplanned failures. |
| `detected_by` | `driver_report`, `dvir`, `technician` (the default), `telematics` or `breakdown`. |
| `occurred_at` | When it failed. Defaults to the repair's opening. It cannot be in the future (5 minutes of clock drift are allowed). |
| `odometer_km` | The reading when it failed. Defaults to the repair's reading. |
| `incident_id` | Optional: the incident that reported it. It must be about the same vehicle, otherwise the API returns `400 incident_other_vehicle`. |

## Catalogues

The catalogues are fixed and stored as PostgreSQL enums (`maintenance.failure_component`, `maintenance.failure_mode` and `maintenance.failure_detection`). Adding a value takes a migration. That keeps labels comparable over time: free text would split one failure across many spellings. Anything outside a catalogue is `400`. If nothing fits, use `other` and describe the failure in `notes`.

| Component | Covers |
|---|---|
| `engine` | Block, head, belts, mounts, lubrication |
| `cooling` | Radiator, hoses, water pump, thermostat, fan |
| `brakes` | Pads, discs, drums, lines, air system |
| `tyres` | Tyres and wheels |
| `transmission` | Clutch, gearbox, driveshaft, differential |
| `electrical` | Battery, alternator, starter, wiring, lights, sensors |
| `suspension` | Springs, shock absorbers, bushes |
| `steering` | Rack, pump, linkages |
| `fuel_system` | Pump, filters, injectors, tank, lines |
| `exhaust` | Exhaust, after-treatment |
| `body` | Body, cab, glass, doors, mirrors |
| `other` | Anything else; say what in `notes` |

| Failure mode | Meaning |
|---|---|
| `wear` | Worn beyond its limit |
| `leak` | Fluid or air lost |
| `overheating` | Ran too hot |
| `electrical_fault` | Open or short circuit, or a failed electrical component |
| `breakage` | Cracked, snapped or torn |
| `puncture` | Pierced (tyres, hoses) |
| `other` | Anything else; say what in `notes` |

## Rules

- **A corrective repair needs a failure record before it can be completed.** Completing one without a failure returns `400 VALIDATION_FAILED` with `{ field: "failures", reason: "failure_required" }`. This applies to `PUT`/`PATCH` with `completed_at` or `status: completed`, and to `POST .../complete`. The repair stays open and the vehicle stays flagged. Preventive, inspection, predictive and other work needs no failure record. Work changed to `corrective` in the same request does.
- **There are three ways to record failures:**
  - `failures` on `POST /maintenance-records`, recorded with the repair;
  - `POST /maintenance-records/{id}/failures`, one at a time;
  - `failures` on `POST /maintenance-records/{id}/complete`, recorded and completed in one transaction. If the completion is refused, the failures are not kept.
- **Repair status:** a failure can be added to open or completed work, so a finished repair can be filled in later. It cannot be added to cancelled work (`409`).
- **Who:** recording needs `maintenance:write`, and listing needs `maintenance:read`. Both are limited to vehicles in the caller's depots: a repair outside them is `404`, and so is an id that is not a UUID.
- **`GET /failure-events`:** lists failures newest first by `occurred_at`. It filters by `vehicle_id`, `component`, `unplanned` and `from`/`to`. A date means that Addis Ababa day, and `to` includes the whole day. A `MaintenanceRecord` also lists its failures, oldest first.
- **Event:** each failure publishes one `FailureRecorded` on the vehicle's aggregate, so a vehicle's failures are delivered in the order they were recorded. The payload carries:
  - `failure_event_id`, `vehicle_id`, `maintenance_record_id`, `incident_id`;
  - `component`, `failure_mode`, `unplanned`, `detected_by`;
  - `occurred_at`, `odometer_km`.

## Part history (FMS-52)

The predictive model also needs to know when each wearing part and fluid was last changed, such as the oil, brake pads or coolant. Nothing new is filled in for this. Each stocked part says which item it renews (`inventory_parts.service_item`, migration 037), so a completed repair that used it is a change of that item.

`GET /vehicles/{vehicle_id}/service-items` lists all 11 items with their last change. [ml-dataset.md](ml-dataset.md#part-history) lists the items and how the model reads them.

## Repair log (S-08)

When the work is a repair (`corrective`), the repair log shows a **What failed** section with the component, failure mode, whether it was unplanned, and how it was found.

- **Save and complete:** needs at least one failure.
- **Save as open work:** failures are optional, and any that are filled in must be complete.
- **Completing open work from the record panel:** asks for the failure there if the repair has none.

## Seed

Every seeded corrective repair that is under way or done gets one failure, matching what the repair says: brake pads → `brakes`/`wear`, sidewall damage → `tyres`/`breakage`, and so on. Each repair kind has its own chance of being unplanned. Unplanned failures are mostly reported by drivers or by breakdowns. Planned ones are found by the technician. A completed repair's failure happened 2 to 72 hours before the repair was finished.

# Incident reports

Card: FMS-38 (SE-74). Code: the backend in `packages/backend/src/modules/alert/` (`domain/incident.ts`, `application/incident.service.ts`, `api/incident.routes.ts`), since incidents are `alert.incident_reports`; the driver form S-13 in `packages/frontend/src/pages/Driver/Incident.tsx`. Architecture §11 (active incidents) and §21 (offline submissions); api-contract §12.2.

An **incident** is something that happened on the road: an accident, a breakdown, a theft, an injury. A driver reports it from wherever they are, online or not. Every incident reaches the command center live. A **critical** one also takes the vehicle off the road and alerts the depot.

## Reporting: `POST /incidents`

`incident:write`: drivers, technicians, depot admins, fleet managers and admins. The body:

| Field | |
|---|---|
| `description` | Required, 1 to 2,000 characters (trimmed). |
| `severity` | Required: `low`, `medium`, `high`, `critical`. |
| `incident_type` | `accident`, `breakdown`, `tyre`, `theft`, `vandalism`, `injury`, `road_hazard`, `other` (the default). |
| `vehicle_id` | Optional: a live vehicle in the caller's depots. A retired one is refused (`vehicle_retired`). |
| `trip_id` | Optional: a trip the caller may see. If it has a vehicle, it must be `vehicle_id`'s (`trip_vehicle_mismatch`). |
| `driver_id` | Staff only, a driver in their depots; by default the trip's driver. A driver is always themselves (`not_writable` for anyone else). |
| `latitude`, `longitude` | Both or neither (`location_incomplete`). |
| `occurred_at` | When it happened; default now. Not in the future (5 minutes of clock drift allowed), not more than 30 days ago. |

`status` (`open`) and the reporter (the caller) are the server's. Any other field is `not_writable`.

- **Depot.** An incident belongs to its vehicle's depot, or, with no vehicle, the reporter's. That decides who sees it and whose sockets receive it.
- **Critical.** In the same transaction, the vehicle's maintenance flag is set (a vehicle already flagged stays so), as an inspection defect does (FMS-36). Then the alert engine raises a critical `incident` alert for the depot's dispatchers and depot admins, which escalates if nobody acknowledges it (docs/alerts.md). An incident below critical is no alert: it is in the incident list and on the command center.
- **Event.** Every incident publishes `IncidentReported` (CONVENTIONS.md, Events). It is consumed by the real-time gateway (`incident.created`), by `alert.engine` (critical only), and by `fleet.vehicle-cache` (the cached vehicle shows the flag). It never carries the description: that is free text.
- **Audit.** The insert and the flag are audited rows of the request.

## Offline submissions

The driver form submits through the offline queue (FMS-81), so a report made in a dead zone waits on the phone and is sent once, in order, when there is signal.

- **Time.** The form sends `occurred_at` as the moment the driver pressed send, so a report delivered hours later keeps when it happened.
- **Once.** Each queued report carries an Idempotency-Key: a retry within 7 days (the longest the queue may hold it) replays the original answer. A report that reached the server, lost its answer and comes back after the key expired is recognised by the reporter, `occurred_at` and the description, and answers `200` with the original and `meta.created: false`. A lock per reporter makes the check safe against a racing original.

## Reading: `GET /incidents`, `GET /incidents/{id}`

`incident:read`: everyone but finance clerks and fleet owners. Newest first (`occurred_at`), paged.

- **Who sees what.** A driver sees only the incidents they reported, never one staff reported about them. Staff see their depot's. An incident no depot owns is seen by those who see every depot. Anyone else's incident by id is `404`, as a missing one is.
- **Filters.** `status`, `severity` and `incident_type` (comma-separated), `vehicle_id`, `from` and `to` (an instant, or an Addis Ababa date: `to` covers that whole day). An unknown vehicle is an empty page.

Updating an incident (`PATCH /incidents/{id}`: investigating, resolved, closed) is not built yet.

## The driver form (S-13)

`/driver/incident`, the Incident tab of the driver portal.

- **About which vehicle.** The vehicle of the trip under way, or the next one today (as the inspection and fuel forms choose it), with the trip. With no trip, the form still works and says the report goes to the depot without a vehicle.
- **What the driver gives.**
  - What happened: eight large choices; none chosen is `other`.
  - How serious, in plain words: Minor, Moderate, Serious, Critical. Critical warns that dispatch is alerted at once, that the vehicle is flagged and must not be driven, and to call emergency services first if someone is hurt.
  - A description.
  - Optionally the phone's location: Add my location asks for it once, and a refusal says to describe the place instead.
- **Sent or saved.** Online it says the report was sent (and, when critical, not to drive the vehicle). Offline it says it is saved on the phone. A refusal shows the server's reason and keeps the form.

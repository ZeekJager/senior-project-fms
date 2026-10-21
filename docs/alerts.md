# Alert engine

Card: FMS-92 (SE-136). Code: `packages/backend/src/modules/alert/` (rules in `domain/rules.ts`). Architecture §9.4 and §34, api-contract §12.1. The inbox that shows the notifications is FMS-48/49, and the command center's alert panel is FMS-89.

An **alert** is a business event that needs someone's attention. It is written to `alert.alerts` before anyone is told. People are then told with in-app **notifications** (`alert.notifications`, channel `in_app`, one row per recipient), in the same transaction. Someone **acknowledges** it ("I'm on it") and **resolves** it ("dealt with"). A critical alert nobody acknowledges **escalates**.

## From event to alert

The engine subscribes to every event type that has a rule (consumer `alert.engine`). It handles each event in the consumer's transaction, so a redelivered event is skipped and never makes a second alert.

| Event | Alert type | Severity | Subject (depot from) | Same source (window) | Told first |
|---|---|---|---|---|---|
| `VehicleFaultDetected` (DVIR, FMS-36) | `vehicle_fault` | `severity` if given, else high | vehicle | the vehicle (60 min) | technician, depot admin |
| `DocumentExpiring` (FMS-26) | `document_expiring` | red: high, amber: medium | the vehicle or driver owning it | the document and expiry date (31 days) | depot admin |
| `LicenceExpiring` (FMS-26) | `licence_expiring` | red: high, amber: medium | driver (`depot_id`) | the driver and expiry date (31 days) | depot admin |
| `FuelAnomalyDetected` (FMS-82) | `fuel_anomaly` | `severity`, else high | vehicle | vehicle and anomaly type (24 h) | depot admin, fleet manager |
| `TelemetryFlagRaised` (FMS-46) | `unsafe_driving`, or `geofence_violation` | `severity`, else high for speeding, medium otherwise | vehicle, or `depot_id` | vehicle and flag type (30 min) | dispatcher, depot admin |
| `MaintenanceRiskDetected` (FMS-55) | `maintenance_risk` | `risk_level`, else medium | vehicle | vehicle (24 h) | technician, depot admin |
| `BatteryThresholdExceeded` (FMS-96) | `battery` | `severity`, else high | vehicle | vehicle and metric (60 min) | dispatcher, depot admin |
| `IncidentReported` (FMS-38) | `incident` | `severity`, else high | vehicle, or `depot_id` | the incident (24 h) | dispatcher, depot admin |

The events from FMS-82, FMS-46, FMS-55, FMS-96 and FMS-38 are not published yet. Their payloads are the contract those cards publish (CONVENTIONS.md, Events), and the engine handles them as soon as they exist.

- **Depot.** An alert belongs to the depot of its vehicle or driver, or the one the event names. Its depot decides who sees it (GET /alerts) and who receives it on the socket. An alert with no depot is seen only by roles that see every depot.
- **Title and message** name the vehicle by its plate and never a person: `AlertCreated` goes out to sockets with them.
- **Priority** follows severity: P1 is critical and P4 is low.

## De-duplication

The rule names the **source** (`dedup_key`: for example `vehicle_fault:<vehicle id>`) and a **window**. An event whose source already has an active alert (open or acknowledged) last seen within the window updates that alert instead of opening another:
- `occurrence_count` goes up by one;
- `last_occurred_at` moves;
- the severity becomes the higher of the two, never lower;
- the title and message are refreshed;
- `AlertUpdated` is published;
- nobody is notified again.

After the window, or once the alert is resolved, a repeat opens a new alert.

Two events of one source arriving at once are serialised: a transaction-scoped advisory lock on the key makes the second wait, then it finds the first's alert.

## Who is told

Tier 0 is the rule's roles; escalation then tells fleet managers (tier 1), then administrators (tier 2). A tier is the active users holding any of its roles who see the alert's depot:
- that depot's staff;
- anyone whose roles see every depot (admin, fleet manager, fleet owner, compliance officer).

Anyone already told about the alert is skipped. A batch of notifications is one statement and one audit entry (`alert.notified`, with the count).

## Acknowledge and resolve

| Call | Permission | From | To |
|---|---|---|---|
| `POST /alerts/{id}/acknowledge` `{comment?}` | `alert:ack` (admin, fleet manager, dispatcher, depot admin) | open | acknowledged |
| `POST /alerts/{id}/resolve` `{comment?}` | `alert:resolve` (admin, fleet manager, dispatcher) | open, acknowledged | resolved |

- **What is recorded.** Each records who and when on the alert (`acknowledged_by` and `_at`, `resolved_by` and `_at`), a history row in `alert.alert_acknowledgements` with the comment, an audited update, and `AlertAcknowledged` or `AlertResolved` (actor: the user).
- **Errors.** Any other starting state is `409 CONFLICT_INVALID_STATE_TRANSITION`, reason `alert_<status>`. An alert outside the caller's depots is `404`.

## Escalation

The job `alert-escalation` runs every minute (an interval job, docs/jobs.md). Each critical alert still **open** `ALERT_ESCALATION_MINUTES` after it was raised (default 15) escalates:
- it goes to the next tier, whose members are notified (`notification_type: alert_escalated`);
- `escalation_level` and `escalated_at` are set;
- `AlertEscalated` is published.

The next tier follows as many minutes after that. With the default, fleet managers are told at 15 minutes and administrators at 30, and nothing happens after the last tier.

Acknowledging stops escalation. High and lower alerts never escalate. Each alert escalates in its own transaction, and alerts locked by an acknowledgement in progress are skipped. An alert counts as due 5 seconds early (`ESCALATION_GRACE_SECONDS`): the job fires a few milliseconds after each minute, and without the grace a tier could slip a whole minute.

## GET /alerts

`alert:read`, depot scope. Filters:
- `status`, `severity`, `type`: one value or several, comma-separated;
- `vehicle_id`, `depot_id`;
- `sort`: `newest` (the default) or `priority` (critical first, then newest);
- `page` and `page_size`.

The response is api-contract §16.3's `Alert`, plus the fields this card adds:
- `priority`, `depot_id`, `driver_id`, `trip_id`;
- `entity_type` and `entity_id`: what the alert is about, by public id;
- `source` (module and event type);
- `occurrence_count` and `last_occurred_at`;
- `escalation_level` and `escalated_at`;
- `acknowledged_by` and `resolved_by` (users' public ids).

## Events and sockets

| Event | When | Socket (`alerts` channel, the alert's depot) |
|---|---|---|
| `AlertCreated` | a new alert | `alert.created` (and the legacy `alert_created`) |
| `AlertUpdated` | a repeat of its source | `alert.updated` |
| `AlertAcknowledged`, `AlertResolved` | a person acted | `alert.updated` |
| `AlertEscalated` | escalated | `alert.updated` |

Payloads: CONVENTIONS.md (Events) and docs/realtime.md.

# Alert engine

Card: FMS-92 (SE-136). Code: `packages/backend/src/modules/alert/` (rules in `domain/rules.ts`). Architecture §9.4 and §34, api-contract §12.1. The inbox API that serves the notifications is FMS-48 (below), its screen FMS-49, and the command center's alert panel is FMS-89.

An **alert** is a business event that needs someone's attention. It is written to `alert.alerts` before anyone is told. People are then told with in-app **notifications** (`alert.notifications`, channel `in_app`, one row per recipient), in the same transaction. Someone **acknowledges** it ("I'm on it") and **resolves** it ("dealt with"). A critical alert nobody acknowledges **escalates**.

## From event to alert

The engine subscribes to every event type that has a rule (consumer `alert.engine`). It handles each event in the consumer's transaction, so a redelivered event is skipped and never makes a second alert.

| Event | Alert type | Severity | Subject (depot from) | Same source (window) | Told first |
|---|---|---|---|---|---|
| `VehicleFaultDetected` (DVIR, FMS-36) | `vehicle_fault` | `severity` if given, else high | vehicle | the vehicle (60 min) | technician, depot admin |
| `DocumentExpiring` (FMS-26) | `document_expiring` | red: high, amber: medium | the vehicle or driver owning it | the document and expiry date (31 days) | depot admin |
| `LicenceExpiring` (FMS-26) | `licence_expiring` | red: high, amber: medium | driver (`depot_id`) | the driver and expiry date (31 days) | depot admin |
| `FuelAnomalyDetected` (the monthly reconciliation, FMS-41, [fuel-reconciliation.md](fuel-reconciliation.md); per fill-up, FMS-82) | `fuel_anomaly` | `severity`, else high | vehicle | vehicle and anomaly type (24 h) | depot admin, fleet manager |
| `TelemetryFlagRaised` (FMS-46, docs/telemetry-rules.md) | `unsafe_driving`, or `geofence_violation` | `severity`: high for speeding, medium for idling | vehicle, or `depot_id` | vehicle and flag type (30 min) | dispatcher, depot admin |
| `MaintenanceRiskDetected` (FMS-55, [ml-scoring.md](ml-scoring.md)): a health score falling below 75 | `maintenance_risk` | `risk_level` (medium or high), else medium | vehicle | vehicle (24 h) | technician, depot admin |
| `MlScoringBlocked` (FMS-127, [ml-model-registry.md](ml-model-registry.md)) | `ml_scoring_blocked` | medium when the model is not active, high otherwise | none: fleet-wide | the model and reason (24 h) | admin |
| `BatteryThresholdExceeded` (FMS-96) | `battery` | `severity`, else high | vehicle | vehicle and metric (60 min) | dispatcher, depot admin |
| `IncidentReported` (FMS-38, docs/incidents.md) | `incident` | critical: only a critical incident is an alert | vehicle, or `depot_id` | the incident (24 h) | dispatcher, depot admin |

The events from FMS-82 and FMS-96 are not published yet. Their payloads are the contract those cards publish (CONVENTIONS.md, Events), and the engine handles them as soon as they exist.

- **Depot.** An alert belongs to the depot of its vehicle or driver, or the one the event names. Its depot decides who sees it (GET /alerts) and who receives it on the socket. An alert with no depot is seen only by roles that see every depot.
- **Title and message** name the vehicle by its plate and never a person: `AlertCreated` goes out to sockets with them.
- **Priority** follows severity: P1 is critical and P4 is low.
- **Not every event.** A rule's `when` can turn an event down: an incident below critical is no alert (it is on the command center's incident list instead).

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

## The inbox (FMS-48)

Code: `modules/alert/` (`api/notification.routes.ts`, `application/inbox.service.ts`, `infrastructure/notification.repository.ts`). Architecture §9.4 (the in-app channel); api-contract §12.1.

The in-app notifications above are a user's **inbox**: `GET /notifications` lists the caller's own, newest first, with read state and the unread count; `PATCH /notifications/{id}/read` and `POST /notifications/read-all` mark them read. All three need `notification:read`, which every role holds, and work on the caller's own rows only (the repository names the recipient in every query): another user's notification, an admin's view included, is `404`, like a missing one. Only `in_app` rows are the inbox; email, SMS and push are delivery history, not shown.

**The unread count stays current.** Every change to it publishes `NotificationUnreadChanged` (`user_id`, `unread_count`, `reason`, `changed_at`) in the same transaction, so it commits with the change it reports and is never announced for a rolled-back one:

| Change | `reason` | By |
|---|---|---|
| The alert engine notifies the user (an alert, an escalation) | `delivered` | `AlertService.notifyTier`, after the batch insert; one event per recipient, carrying that recipient's total |
| The user marks one read | `read` | `PATCH .../read`; marking one already read publishes nothing |
| The user marks all read | `read_all` | `POST /notifications/read-all`; with nothing unread, nothing |

The outbox relay polls every 200 ms and the gateway forwards the event as `notifications.unread` ([realtime.md](realtime.md)) to that user's own room, so a screen shows the new count within a second of the commit. The event carries the count, so a screen needs no request; it reads the inbox (`meta.unread_count`) when it opens and after a reconnect, as for every event (events are hints).

**The last 30 days.** The inbox is the notifications of the last 30 days (`INBOX_WINDOW_DAYS`, FMS-49). The window applies to the list, the unread count and `read-all` alike, so the badge never counts what the panel does not show. Older rows stay in `alert.notifications` and are not anyone's inbox; a count that drops because a notification aged out is not announced, and corrects itself at the next read.

A notification carries what its alert is about (`entity`, `vehicle_id`, `driver_id`), so a screen can link to it.

## The bell (FMS-49)

Code: `packages/frontend/src/components/NotificationInbox/` (in the top bar of both shells, S-17).

- **Badge.** The bell shows the unread count (`99+` from 100) and names it for a screen reader ("Notifications, 3 unread"). It follows `notifications.unread` the moment it arrives: the event carries the count, so the badge is set from the event with no request and the list is re-read for the new rows. With no live socket the inbox is re-read every 60 seconds.
- **Panel.** The latest 20 of the last 30 days, newest first: title, message (two lines), how long ago, unread marked. The footer says "Last 30 days" and, when there are more, "the latest 20 of N". On a phone it is the width of the screen under the top bar (16 px margins), scrolls inside, and its rows are touch-sized.
- **Mark all as read** clears the badge to 0 at once and tells the server; if the server refuses, the badge comes back. Choosing one notification does the same for that one.
- **Choosing a notification** marks it read and opens the screen its alert is about, if the viewer may open that screen; otherwise it is only marked read (no link beats a link to "not allowed"):

| It is about | It opens |
|---|---|
| a vehicle fault (`dvir_report`) | Maintenance, narrowed to the vehicle (`/maintenance?vehicle=<id>`) |
| a maintenance prediction | Maintenance |
| a vehicle (`vehicle`) | Vehicles |
| a document | Vehicles, or Drivers when it is a driver's |
| a driver's licence (`driver`) | Drivers |
| a fuel anomaly | Fuel reconciliation |
| a telemetry flag, an incident | The live map, "needs attention" |

The screens take list filters, not record ids, so the link lands on the right list, narrowed to the vehicle where the screen supports it.

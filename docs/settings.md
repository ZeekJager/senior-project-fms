# Depots and settings (FMS-80)

Card: FMS-80 (SE-124). Code:

- backend: `packages/backend/src/modules/settings/` (the settings, `GET` and `PATCH /settings`), `modules/integration/` (`RuleThresholdService`, `api/rule-threshold.routes.ts`: the telemetry rules' thresholds);
- frontend: `pages/Depots/` (S-26), `pages/Settings/` (S-27), `features/settings.ts` (the values every screen reads).

Migration 052.

Before this card, depots had an API and no screen (FMS-20 left it to "a Settings screen"), and tuning a rule meant a code change, an environment variable or SQL. Now an administrator does both from the Administration menu, and every change is audited.

## Depots (S-26, `/depots`)

For `depot:write`: admin and fleet owner. It uses the depot API as it was (api-contract §6.1).

- The list shows live depots by name, with code, place, capacity and time zone. *Inactive* lists deactivated ones. Search matches name, code, location or city.
- *Add depot* and *Edit* open a panel: name and location are required. The code is stored upper case and must be unique (`409` is shown on the field). Coordinates are typed as a pair (`8.54, 39.27`). An edit sends only what changed, with `If-Match`, so someone else's change in between is refused, not overwritten.
- *Deactivate depot* (`DELETE`, soft) asks first. It is refused while active vehicles, drivers or user accounts belong to the depot; the dialog repeats the server's message, which counts them. An inactive depot opens read-only, with *Restore depot*.
- Every other screen's depot picker is refreshed after a change.

## Settings (S-27, `/settings`)

For `settings:write`, a new permission held by admin only. Reading the values needs only a sign-in: screens draw their lines from them.

### Driving rules: `tracking.rule_thresholds`

The speeding and idling thresholds ([telemetry-rules.md](telemetry-rules.md)) and, since FMS-90, route deviation's ([geofences.md](geofences.md): *Off route beyond* metres, *Off route after* pings) kept their table: one fleet row and one per depot that differs.

| Field | Default | Range |
|---|---|---|
| `speed_limit_kmh` | 80 | 20-200 |
| `speeding_pings` | 3 | 1-20 |
| `clear_pings` | 3 | 1-20 |
| `idle_minutes` | 5 | 1-120 |

- `GET /settings/telemetry-rules`: `{ fleet, depots[] }`, each with the four values and who changed them last, and when.
- `PUT /settings/telemetry-rules/fleet` and `PUT /settings/telemetry-rules/depots/{depot_id}`: all four speeding and idling values, and route deviation's two if they change (one left out keeps the row's); a depot's row is created or replaced. Saving the same values writes nothing.
- `DELETE /settings/telemetry-rules/depots/{depot_id}`: the depot follows the fleet's again (`404` if it had none of its own). The table has no `is_active`, so the row is deleted; the audit row keeps its values.

### Alerts and anomalies: `settings.settings`

| Key | Default | Range | What it changes |
|---|---|---|---|
| `fuel_variance_threshold_pct` | `FUEL_VARIANCE_THRESHOLD_PCT` (20) | 1-100 | The monthly fuel reconciliation's anomaly threshold, and the judgements of `GET /fuel-reconciliation` ([fuel-reconciliation.md](fuel-reconciliation.md)) |
| `health_alert_below` | 75 | 50-84 | The nightly scoring's `MaintenanceRiskDetected` line, the `at_risk` and `watch` bands of `GET /vehicles?health=` and the command center, and the bands every screen colours a score by ([ml-scoring.md](ml-scoring.md), [vehicle-health.md](vehicle-health.md)) |
| `expiry_warning_days` | 30 | 8-180 | How many days ahead the daily checks raise the first (amber) `DocumentExpiring` and `LicenceExpiring`; red stays at 7 |

- `GET /settings`: every setting with `value`, `default_value`, `is_default`, `unit`, `min`, `max` and who changed it last.
- `PATCH /settings`: `{ "<key>": <whole number> | null }`, one or more. `null`, or the default itself, goes back to the default, stored as `NULL` so it follows the code if the default changes. All values are checked before any is written (`400`, `reason: out_of_range` per field), and all are written in one transaction.
- The fuel default is the `FUEL_VARIANCE_THRESHOLD_PCT` environment variable's, so a deployment that set it keeps it until an administrator changes it here.
- The health line's range ends at 84 because *healthy* starts at 85, which stays fixed. Above 75 the ML service still calls the score `low` risk, so the alert for such a vehicle has low severity.
- The expiry setting moves the warnings only. The lists' *expiring soon* marks (licence status, the vehicle list's document filter, the documents panel) stay at 30 days.

## Taking effect within a minute

The acceptance criterion: a changed speeding threshold applies within a minute.

- The telemetry rules cache each depot's thresholds for 30 seconds (`THRESHOLDS_TTL_MS`), and the settings service caches the values for 30 seconds (`SETTINGS_TTL_MS`), per instance.
- The instance that saves a change drops its copy at once, so the next ping or reading there uses it. The other instances follow when their copy expires, within 30 seconds.
- Screens re-read `GET /settings` at most every minute; the settings screen updates its copy on save.

The command center's overview is cached for 5 seconds and follows on its next read.

## Audit

Every change is one audited write: `settings.settings` `INSERT` or `UPDATE` (with the old and new value), `tracking.rule_thresholds` `INSERT`, `UPDATE` or `DELETE`. The row records `updated_by`. The audit log (S-10) shows them with the rest.

## Not covered

- Other CFG-3 defaults are not settings yet: the session's inactivity logout (30 minutes) and the offline queue's size (50).
- The 7-day red expiry warning, the health bands' 85 and 25-hour staleness, and the *expiring soon* marks stay in code.
- There is no end-to-end browser test suite in the repository. The card's E2E requirement is covered by API integration tests (`test/integration/settings.test.ts`: a speeding threshold changed through the API raises a flag on the very next pings) and by component tests of both screens against a mocked API.

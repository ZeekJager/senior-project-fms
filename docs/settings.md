# Depots and settings (FMS-80, FMS-157)

Cards: FMS-80 (SE-124), and FMS-157 (SE-201) for the registry of typed parameters. Code:

- backend: `packages/backend/src/modules/settings/` (the registry, `GET` and `PATCH /settings`, `/settings/definitions`), `modules/integration/` (`RuleThresholdService`, `api/rule-threshold.routes.ts`: the telemetry rules' thresholds; `application/threshold-parameters.ts`: the same as system parameters of the registry);
- shared: `modules/settings/domain/parameter-types.ts`, the types' validator, copied byte for byte to the frontend's `lib/parameterTypes.ts` (a test fails when they differ);
- frontend: `pages/Depots/` (S-26), `pages/Settings/` (S-27), `features/settings.ts` (the values every screen reads).

Migrations 052 and 077. Decided in [ADR-09](adr/ADR-09-settings-registry.md).

Before this card, depots had an API and no screen (FMS-20 left it to "a Settings screen"), and tuning a rule meant a code change, an environment variable or SQL. Now an administrator does both from the Administration menu, and every change is audited.

## Depots (S-26, `/depots`)

For `depot:write`: admin and fleet owner. It uses the depot API as it was (api-contract §6.1).

- The list shows live depots by name, with code, place, capacity and time zone. *Inactive* lists deactivated ones. Search matches name, code, location or city.
- *Add depot* and *Edit* open a panel: name and location are required. The code is stored upper case and must be unique (`409` is shown on the field). Coordinates are typed as a pair (`8.54, 39.27`). An edit sends only what changed, with `If-Match`, so someone else's change in between is refused, not overwritten.
- *Deactivate depot* (`DELETE`, soft) asks first. It is refused while active vehicles, drivers or user accounts belong to the depot; the dialog repeats the server's message, which counts them. An inactive depot opens read-only, with *Restore depot*.
- Every other screen's depot picker is refreshed after a change.

## Settings (S-27, `/settings`)

For `settings:write`, a new permission held by admin only. Reading the values needs only a sign-in: screens draw their lines from them.

### The registry (FMS-157): `settings.definitions`

Every parameter has a row: `key`, `label`, `category`, `description`, `type`, a typed `default_value` and `rules` (jsonb), and whether it `is_enabled`, `is_system` and `is_secret`, with an optional `required_permission`.

| Type | Value | Rules |
|---|---|---|
| `text` | a string (at most 10,000 characters) | `min_length`, `max_length`, `pattern` (the whole value) |
| `number` | a finite number | `min`, `max`, `decimals`, `unit` |
| `integer` | a whole number | `min`, `max`, `unit` |
| `boolean` | `true` or `false` | |
| `dropdown` | one option's value | `options` (2 or more: `value`, `label`) |
| `multi_select` | a list of options' values, each at most once | `options`, `min_items`, `max_items` |
| `duration` | whole seconds (the screen takes `90` minutes, `1h 30m`, `45s`) | `min`, `max` |
| `email` | an email address | |
| `url` | an `https://` or `http://` address | |
| `json` | any JSON value (at most 16 KB) | `schema`: a JSON Schema |

- **One validator:** `checkValue` and `checkDefinition` in `parameter-types.ts`. The API runs them on save, the screen as each value is typed; the reasons are `wrong_type`, `out_of_range`, `not_an_option` and `invalid_format`. A rule a type does not take is refused (`invalid_rules`), and so is a schema with a keyword the json type does not check (`unsupported_schema_keyword`; it checks `type`, `enum`, `const`, the numeric bounds and `multipleOf`, the string lengths and `pattern`, `items`, `minItems`, `maxItems`, `uniqueItems`, `properties`, `required`, `additionalProperties`), so no part of a schema is silently ignored.
- **System parameters** are the 9 settings below and the 15 driving rules' thresholds. The module whose rule each tunes declares it in code, and the API brings its row in step on start (label, category, description, type, rules, default; never whether it is enabled). Migration 077 inserted them, and a test checks the two agree. They are never deleted (`409 CONFLICT_SYSTEM_PARAMETER`), their definition is never edited, and a change of their value needs a reason.
- **Custom parameters** are added on the screen (`POST /settings/definitions`, `settings:define`) and deleted softly (`is_active`); the key can be used again, starting from its default. Code reads any parameter, with no deployment:

  ```ts
  import { settings } from '../settings';
  const detail = (await settings.get<string>('report_detail')) ?? 'standard';
  ```

  `get` answers the stored value, or the default while the parameter is disabled or was never changed, and `undefined` for a key with no live definition.
- **Disabled** parameters answer with their default, for code (`settings.get`, `settings.value`) and for the driving rules (the fleet and every depot), until enabled again. Their own value is kept.
- **Values** stay where they were: `settings.settings.value`, now jsonb (`NULL`: the default), for this module's and custom parameters, with `reason`; a secret's in `secret_value`, which the audit trail never copies (`[REDACTED]`). The driving rules' stay in the fleet's row of `tracking.rule_thresholds` (with `change_reason`), written through the integration module's store, which also keeps the rules between them (`not_above_late`, the distance limits'); each depot's own row still overrides them.
- **Access:** `settings:define` (admin) adds, deletes, enables and disables parameters, and edits a custom one's definition; `settings:write` changes values, plus the definition's `required_permission` if it names one. A secret's value and default are never returned (`null`, `has_value`) and never exported.
- **Concurrency:** `version` is bumped by every change of the definition or the value (a driving rules `PUT` included), and is the ETag. A `PATCH` or `DELETE` with an older `If-Match` is `412 PRECONDITION_FAILED`; the screen always sends it, and offers to reload.
- **History:** `GET /settings/definitions/{key}/history`: each value change (old and new, a secret's `[SECRET]`), definition edit, enable, disable and deletion, with who, when and why, from the audit trail. The screen restores a value from it (sent again as a change, with its own reason) and exports it as CSV.
- **Events:** `SettingDefined`, `SettingChanged` (`value_changed`, `fields`), `SettingEnabled`, `SettingDisabled` and `SettingDeleted`, with `key`, `is_system` and `storage`, never the value. These are the card's `setting.defined` and the rest, named as CONVENTIONS.md has events.

### Driving rules: `tracking.rule_thresholds`

The speeding and idling thresholds ([telemetry-rules.md](telemetry-rules.md)) and, since FMS-90, route deviation's ([geofences.md](geofences.md): *Off route beyond* metres, *Off route after* pings) kept their table: one fleet row and one per depot that differs. Since FMS-147 it also holds the trip delay alert's margins ([eta.md](eta.md#the-trip-delay-alert-fms-147): *Trip late after* and *Trip urgent after*, in minutes past the scheduled end; urgent must be later). Since FMS-151, the assignment exceptions too ([assignment-exceptions.md](assignment-exceptions.md): *Assigning through a warning*, whether *Driver marked absent* and *Previous trip running over* only warn or need a fleet manager's approval; `warn` by default).

| Field | Default | Range |
|---|---|---|
| `speed_limit_kmh` | 80 | 20-200 |
| `speeding_pings` | 3 | 1-20 |
| `clear_pings` | 3 | 1-20 |
| `idle_minutes` | 5 | 1-120 |

- `GET /settings/telemetry-rules`: `{ fleet, depots[] }`, each with the four values and who changed them last, and when.
- `PUT /settings/telemetry-rules/fleet` and `PUT /settings/telemetry-rules/depots/{depot_id}`: all four speeding and idling values, and route deviation's two and the trip delay margins if they change (one left out keeps the row's); a depot's row is created or replaced. Saving the same values writes nothing.
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
### Driver score: `settings.settings`

How much each part counts in the driver performance score (FMS-146, [analytics.md](analytics.md#the-driver-performance-score)).
The score divides by their sum, so they need not add up to 100, and 0 leaves a part out. They cannot all be 0
(`400`, `reason: all_zero` on each sent). The screen has them in a card of their own, *Driver score*.

| Key | Default | Range | The part |
|---|---|---|---|
| `driver_score_weight_punctuality` | 35 | 0-100 | Trips ended on time |
| `driver_score_weight_safety` | 35 | 0-100 | Speeding and idling per 100 km |
| `driver_score_weight_incidents` | 20 | 0-100 | Accidents per 100 km |
| `driver_score_weight_dvir` | 10 | 0-100 | Trips with the driver's pre-trip inspection |

The defaults are the card's and still need the advisor's agreement.

### Score appeals: `settings.settings`

The driver score appeals' rules (FMS-159, [score-appeals.md](score-appeals.md)), in the category *Score appeals*.

| Key | Default | Range | What it is |
|---|---|---|---|
| `appeal_window_days` | 30 | 1-365 | Days after a flag, an incident or the end of a month in which a driver may appeal it |
| `appeal_review_working_days` | 5 | 1-30 | Working days, Monday to Friday, to decide an appeal before it is overdue and goes to the depot admin |

A change applies to appeals sent from then on: an appeal keeps the deadline it was given.

### Monitoring: `settings.settings`

The monitoring thresholds (FMS-163, [observability.md](observability.md#thresholds)), in the category *Monitoring*: a warning and a critical line per metric, which Prometheus' alert rules compare against as the API exports them (`fms_alert_threshold`), so a change applies within a minute. A warning must stay below its critical.

| Keys | Defaults | Range | What they are |
|---|---|---|---|
| `monitor_cpu_warning_pct`, `monitor_cpu_critical_pct` | 75, 90 | 1-100 % | A host's or a service's CPU for 5 minutes |
| `monitor_memory_warning_pct`, `monitor_memory_critical_pct` | 80, 90 | 1-100 % | Memory in use for 5 minutes |
| `monitor_disk_warning_pct`, `monitor_disk_critical_pct` | 75, 90 | 1-100 % | A disk's use for 10 minutes |
| `monitor_db_connections_warning_pct`, `monitor_db_connections_critical_pct` | 70, 85 | 1-100 % | The primary's connections in use, of `max_connections` |
| `monitor_replica_lag_warning_seconds`, `monitor_replica_lag_critical_seconds` | 30, 60 | 1-3600 s | The standby behind the primary for 2 minutes |
| `monitor_error_rate_warning_pct`, `monitor_error_rate_critical_pct` | 2, 5 | 1-100 % | The API's 5xx answers for 5 minutes |
| `monitor_p95_warning_ms`, `monitor_p95_critical_ms` | 500, 1000 | 50-60000 ms | The API's p95 latency for 5 minutes |
| `monitor_gps_silence_minutes` | 2 | 1-60 min | No GPS point stored while trips are under way (critical) |

### Driver feedback: `settings.settings`

Admin-to-driver feedback (FMS-158, [driver-feedback.md](driver-feedback.md)), in the category *Driver feedback*. Read with `settings.get(key)`: they are no whole-number setting of `GET /settings`.

| Key | Type | Default | Rules | What it is |
|---|---|---|---|---|
| `feedback_categories` | multi-select | all six | at least 1 of *Safety*, *Driving behaviour*, *Fuel efficiency*, *Punctuality*, *Vehicle care*, *General comment* | The categories a manager files feedback under; one taken out is refused for new feedback, and old items keep it |
| `feedback_retention_months` | integer | 24 | 1-120 months | How long feedback is kept, retracted items too; the `feedback-retention` job deletes older items each night |

### KPI targets: `settings.settings`

The KPI dashboard's targets (FMS-160, [reports.md](reports.md#kpis)), in the category *KPI targets*. A change shows in
the KPIs' statuses at once.

| Key | Default | Range | What it is |
|---|---|---|---|
| `kpi_cost_per_km_target_cents` | 3500 | 1-1,000,000 | Cost per km, in cents (ETB 35.00) |
| `kpi_fuel_target_l100km_tenths` | 300 | 1-10,000 | Fuel use, in tenths of L/100 km (30.0) |
| `kpi_utilisation_target_pct` | 75 | 1-100 | Utilisation, % |
| `kpi_availability_target_pct` | 90 | 1-100 | Availability, % |
| `kpi_on_time_target_pct` | 90 | 1-100 | Trips on time, % |
| `kpi_pm_compliance_target_pct` | 95 | 1-100 | Programmed services on time, % |
| `kpi_incidents_target_per_100k_km` | 5 | 0-10,000 | Incidents per 100,000 km, whole |
| `kpi_vehicles_at_risk_target` | 5 | 0-10,000 | Vehicles below the health alert line |
| `kpi_amber_band_pct` | 10 | 1-100 | How far past a target, as a share of it, is amber rather than red |

- The expiry setting moves the warnings only. The lists' *expiring soon* marks (licence status, the vehicle list's document filter, the documents panel) stay at 30 days.

## Taking effect within seconds

The acceptance criteria: a changed speeding threshold applies within a minute (FMS-80), and any change reaches every instance within 60 s (FMS-157).

- The telemetry rules cache each depot's thresholds for 30 seconds (`THRESHOLDS_TTL_MS`), and the settings service caches the values for 30 seconds (`SETTINGS_TTL_MS`), per instance.
- The instance that saves a change drops its copy at once (and the thresholds' with it), so the next ping or reading there uses it.
- Every change publishes a `Setting*` event through the outbox, which the relay puts on Redis (`<prefix>:events:SettingChanged` and so on). Each instance listens (`startSettingsSync` in `server.ts`) and drops its copies when one arrives, in about a second, the relay's pace. A driving rules `PUT` publishes `SettingChanged` too.
- Without Redis (one instance), or while it is down, the other instances follow when their copy expires, within 30 seconds.
- Screens re-read `GET /settings` at most every minute; the settings screen updates its copy on save.

The command center's overview is cached for 5 seconds and follows on its next read.

## Audit

Every change is one audited write: `settings.settings` `INSERT` or `UPDATE` (with the old and new value and the reason), `tracking.rule_thresholds` `INSERT`, `UPDATE` or `DELETE` (with `change_reason`), and `settings.definitions` `INSERT`, `UPDATE` (edit, enable, disable) or a soft `DELETE`. The row records `updated_by`. The audit log (S-10) shows them with the rest. Two writes are not audited: a definition's `version` moving on when its value changes (the value's own row records the change), and the start-up sync of the system parameters' code-declared fields.

## Not covered

- Whether a production change to a system parameter should need a second administrator's approval (the card's open question): not built. A reason is required, and every change is in the history.
- A custom parameter's rules and default are changed through the API (`PATCH /settings/definitions/{key}`). The screen changes values, enables, disables and deletes, and adds parameters with their rules.
- Secrets are masked in every answer, export and audit row, but stored in clear in `settings.settings.secret_value` (the backups are encrypted, ADR-07). A secret store for them is later work.
- `analytics.trip_risk_facts` (migration 073) reads `trip_delay_minutes` from `tracking.rule_thresholds` in SQL, so a disabled one does not move the training facts' `late`.
- Other CFG-3 defaults are not settings yet: the session's inactivity logout (30 minutes) and the offline queue's size (50).
- The 7-day red expiry warning, the health bands' 85 and 25-hour staleness, and the *expiring soon* marks stay in code.
- There is no end-to-end browser test suite in the repository. The card's E2E requirement is covered by API integration tests (`test/integration/settings.test.ts`: a speeding threshold changed through the API raises a flag on the very next pings) and by component tests of both screens against a mocked API.

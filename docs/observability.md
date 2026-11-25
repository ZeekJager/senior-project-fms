# Observability (FMS-109, FMS-163)

Cards: FMS-109 (SE-153) and its Wave 6 scope FMS-163. Problems are found by the team, not by users: every host, service, the application and the database are measured against thresholds an administrator sets, alerts reach the people who act, the logs and the errors are searchable, and System health shows it live and back 12 months. The stack is chosen in [ADR-10](adr/ADR-10-observability-stack.md).

## The stack

`docker-compose.observability.yml`, on top of the Compose stack: `make observability` (or `docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d`). Its secrets come from `.env` (`node scripts/init-env.mjs` adds them).

| Part | What it does | Where |
|---|---|---|
| Prometheus | Scrapes every 15 s, evaluates the alert rules, keeps 15 days | `fms_prometheus`, Compose network only |
| VictoriaMetrics | Receives every sample (remote write), keeps 13 months, answers the API's queries and Grafana's | `victoriametrics:8428` |
| Alertmanager | Sends what fires to the API's alert engine; a critical alert holds back the warning of the same metric | `alertmanager:9093` |
| node_exporter, cAdvisor | The host's CPU, memory, disks and network; each container's, named by its Compose service | |
| postgres_exporter (2) | The primary (`db-proxy:5432`) and the standby (`:5433`), whichever server each is: connections, TPS, cache hit, locks, sizes, slow statements | |
| redis_exporter | Redis | |
| Grafana | The dashboard *FMS: budgets, application, database and hosts* (the CFG-3 budgets as lines) and the logs | `http://127.0.0.1:3001`, admin and `GRAFANA_ADMIN_PASSWORD` |
| Loki, Promtail | Every container's log, 30 days, by service. The API logs JSON with its request id: `{service="backend"} \| json \| req_id="<id>"` | |
| GlitchTip | Error tracking for the API, the web app and the AI service (Sentry's protocol) | `http://127.0.0.1:8001` |

**Nothing is published to the network**: Grafana and GlitchTip listen on the host's loopback only, the rest on the Compose network. The browser never calls Prometheus: the Resources tab asks the API (`GET /system/metrics`).

The API's own metrics are in [metrics.md](metrics.md); this adds `gps_points_stored_total`, `gps_last_point_age_seconds`, `trips_under_way`, `backup_findings{severity}` and `fms_alert_threshold{setting}`.

## Thresholds

The warning and critical lines are settings in the category *Monitoring* (Settings, FMS-157; [settings.md](settings.md#monitoring-settingssettings)):

| Metric | Warning | Critical | For |
|---|---|---|---|
| CPU, a host's or a service's | 75% | 90% | 5 min |
| Memory | 80% | 90% | 5 min |
| Disk | 75% | 90% | 10 min; and *full within 7 days* at the last 6 hours' rate, 30 min |
| Database connections (of `max_connections`) | 70% | 85% | 5 min |
| Replica lag | 30 s | 60 s | 2 min |
| API 5xx | 2% | 5% | 5 min |
| API p95 latency | 500 ms | 1 s | 5 min |
| GPS: no point stored during trips | | 2 min | 1 min |

Prometheus compares against them as the API exports them (`fms_alert_threshold{setting="monitor_cpu_critical_pct"}`, read at each scrape), so **a change in Settings applies within a minute, with no deployment**. A warning must stay below its critical (`400`, `warning_not_below_critical`). How long a line must be passed (*For*) is in the rules, not a setting: Prometheus cannot take a rule's `for` from data.

Beside them, fixed: a target not answering (2 min, critical), the outbox lagging (> 60 s) or dead-lettering, a provider's circuit breaker open (2 min), a scheduled job failing, a backup failing or overdue (critical). The rules are `docker/observability/prometheus/rules/fms.rules.yml`; **each fires once in `fms.rules.test.yml`** (`promtool test rules`, the CI job `observability-rules`), and none fires on a quiet fleet or under a raised threshold.

## Alerts

Alertmanager posts to `POST /api/v1/system/alerts/webhook` with `Authorization: Bearer ALERTMANAGER_WEBHOOK_TOKEN` (compared in constant time; unset, every request is refused). Each firing alert is the event `MonitoringAlertFiring`, each resolved one `MonitoringAlertResolved`; their ids come from the alert's fingerprint and start, so Alertmanager repeating itself every group interval is one event.

The alert engine ([alerts.md](alerts.md)) turns them into FMS alerts for the **administrators**, de-duplicated by fingerprint:

- **Critical**: in the app, by email, SMS and push (the critical channels, [notification-channels.md](notification-channels.md)), and to Teams. Escalated like any critical alert.
- **Warning**: in the app (severity medium), and to Teams. A warning that becomes critical is told again.
- **Resolved** by Alertmanager: the alert closes by itself (`resolved_by` null, `AlertResolved` with `by: system`), its unsent messages are dropped, and Teams is told. Alertmanager resolves an alert at its next evaluation once the line is no longer passed, so within about 2 minutes of the load stopping.

**Teams**: a `notification` provider with `configuration.channel = "teams"`; its Workflows webhook URL is the provider's API key (`INTEGRATION_<CODE>_API_KEY`), so it lives in the environment, never in the database, and must be on Microsoft's hosts. Each monitoring alert is posted once when it opens and once when it resolves, as an Adaptive Card with a button to System health (`alert.channel_posts`, the `channel-post-delivery` job every minute, the same retries as the other channels). Without the provider, posts wait.

**Which channels**: the critical and warning channels are the alert engine's (critical: every channel; medium: the app). Email, SMS, push and Teams are each on when their provider is set up (Integrations).

## Maintenance windows

System health, Resources, *Add a window* (`settings:write`; `POST /system/maintenance-windows`): the hosts or services (their `host` or `service` label, or `*`), when it starts and ends (at most 31 days), and why. While it is in force, a firing alert for those hosts is held back (counted, not opened); others are not. Its start and end are written to the audit log when they happen (`system.maintenance_window_started`, `..._ended`, by the `maintenance-window-edges` job every minute, once each), and *End it* cancels it early.

## The Resources tab (S-31)

System health, *Resources* (`system:read`; `?tab=resources`): refreshed every 15 s, so a value is at most about 30 s old, and each tile says how old its value is.

- **A tile per host and per service**: CPU, memory, disk (hosts) and network in and out, each with its line over the range and its status, *OK*, *Warning* or *Critical*, shown with an icon and a label.
- **Application**: requests per minute, 5xx %, p95 latency, GPS points per minute, sockets, job failures in the last hour.
- **Database**: connections %, transactions per second, cache hit %, replica lag, and the 5 slowest statements by mean time (`pg_stat_statements`, constants already replaced by `$n`).
- **Ranges**: 1 hour (1-minute points), 24 hours (5 min), 7 days (30 min), 30 days (2 h), 12 months (a day). A long range is answered from VictoriaMetrics at its step, so the 12-month view is 365 points per line.

## The capacity report

`GET /system/capacity-report` (`?format=pdf` downloads it; *Capacity report (PDF)* on the tab): each host's disk, memory and CPU now, their growth over the last 30 days, **the days until each disk is full**, and anything expected to pass 80% within 90 days, from a least-squares line through the 30 daily points (`daysUntil`, `src/modules/system/domain/monitoring.ts`); and the period's requests, GPS points and database size and growth.

## Error tracking

The API, the web app and the AI service send their errors to GlitchTip (or any Sentry server) when their DSN is set: `SENTRY_DSN_BACKEND`, `VITE_SENTRY_DSN` (at build time; and `CSP_CONNECT_SOURCES` to GlitchTip's origin) and `SENTRY_DSN_AI`. Off without.

- **What is sent**: an error the API answers 500 for, with its **request id**, method and route template; a screen that failed to render, with the API's request id and error code when an API error caused it; an error the AI service answers 500 for, with the request id the API sent. So a user's request id finds the server's error and the screen's together.
- **What is not**: no cookies, headers, bodies, query strings, IP addresses, breadcrumbs, source lines or local variables; a user only by public id. E-mail addresses, phone numbers, bearer and other tokens in messages are masked (`[email]`, `[number]`, `[token]`) before anything leaves (`scrubEvent`, in each).

## Tests

- `docker/observability/prometheus/rules/fms.rules.test.yml`: every alert rule fires once (CPU, memory, disk, disk full soon, services, targets, 5xx, p95 above the budget, GPS silence, outbox, dead letters, circuits, jobs, connections, replica lag, backups), and none on a quiet fleet or a raised line. The CI job `observability-rules` also checks the Prometheus, Alertmanager and Compose configurations.
- `test/integration/monitoring.test.ts`: the webhook's token; a critical alert to the administrators and to Teams, once; resolved by itself; a warning in the app only; a maintenance window holding back its hosts only, with its start and end audited; a threshold change reaching the next scrape; `/system/metrics` needs `system:read`; the Teams card posted on opening and resolving.
- `src/modules/system/application/monitoring.service.test.ts`: the tiles, statuses, freshness, ranges and the capacity figures. `src/modules/system/domain/monitoring.test.ts`: days to full against a hand calculation (within 10%).
- Error tracking: `src/shared/observability/error-tracking.test.ts` (the API: a thrown error with its request id, masked), `packages/ai-service/tests/test_error_tracking.py`, and the web app's scrubbing (`Resources.test.tsx`).

## Not covered

- **Hold times as settings**: the thresholds are settings; how long each must be passed is fixed in the rules.
- **Emailing the capacity report monthly**: it is served and downloadable; FMS-160's report schedules are to send it.
- **Raising the CPU of staging for 5 minutes** (the card's criterion 2) is a drill on staging; the rules' tests and the integration test cover the path from Prometheus to the channels.
- **Down-sampled 5-minute averages**: VictoriaMetrics keeps every sample for 13 months, and long ranges are read at a 5-minute or coarser step; its open-source edition has no down-sampling.

# ADR-10: Prometheus, VictoriaMetrics, Loki and GlitchTip for Observability

- **Status:** Accepted
- **Date:** 2026-11-25
- **Card:** FMS-109 (SE-153), with FMS-163

## Context

FMS-109 asks for centralised logs, metrics dashboards for the CFG-3 budgets, alert rules and error tracking; FMS-163 for host, container, application and database metrics live against thresholds an administrator changes, alerts by email, SMS, Teams and in the app, 12 months of history and a monthly capacity report. It all runs where FMS runs: Docker Compose on one or two hosts, a team of students, no cloud account, no money. Nothing may be published publicly.

## Decision

- **Metrics: Prometheus, with VictoriaMetrics for history.** Prometheus scrapes every 15 s and evaluates the alert rules (with `promtool test rules` to test them); it keeps 15 days. Every sample is remote-written to VictoriaMetrics single-node, which keeps 13 months in a fraction of Prometheus' disk and answers the same query language, so the API's `GET /system/metrics` and Grafana read one store for any range.
- **Exporters**: node_exporter, cAdvisor, postgres_exporter (one for the primary, one for the standby, through the stable endpoint), redis_exporter, and the API's and the AI service's own `/metrics` (FMS-75).
- **Alerting: Alertmanager into the FMS alert engine.** One receiver, the API's webhook: the engine already de-duplicates, notifies by role and severity, escalates and resolves, so monitoring alerts reach the same inbox, email, SMS and push as every other alert, and Teams is one more provider of the integration gateway. Maintenance windows live in FMS (audited, in Settings and System health), not in Alertmanager's silences.
- **Thresholds as settings**: the API exports them as a gauge; each rule compares against it. A change applies at the next scrape.
- **Logs: Loki with Promtail**, reading the Docker logs; the API already logs JSON with its request id.
- **Errors: GlitchTip**, an open-source server for Sentry's protocol, self-hosted; the Sentry SDKs in the API, the web app and the AI service, each scrubbing personal data before sending.
- **Dashboards: Grafana**, provisioned from files in the repository.

## Alternatives

- **Prometheus alone for 13 months**: its local storage grows several times larger, and long ranges are slow; remote storage is the documented answer. Thanos or Mimir do it too, at the cost of object storage and several more services.
- **VictoriaMetrics alone** (vmagent and vmalert instead of Prometheus): fewer containers, but promtool's rule tests and Prometheus' wider documentation are worth a container for a team learning the tools.
- **Elasticsearch or OpenSearch for logs**: much heavier (memory, JVM tuning) than Loki for logs that are read by label and request id, not searched in full text at scale.
- **Sentry, self-hosted**: the reference server, but it needs Kafka, ClickHouse, Snuba and a dozen services; GlitchTip speaks the same protocol with PostgreSQL and a queue. Moving to Sentry later changes the DSN only.
- **Alertmanager sending email and SMS itself**: a second set of channels, recipients and templates, and no in-app alert or escalation; the alert engine has them.

## Consequences

- About 15 more containers, in an overlay that is not started with `make dev`: development stays as light as it was; `make observability` starts them.
- The alert rules are code with tests in CI (`observability-rules`); a new metric needs a rule and a test case.
- Hold times (`for`) stay in the rules: Prometheus cannot take them from data.
- VictoriaMetrics' open-source edition does not down-sample: it keeps every sample for 13 months, and long ranges are read at a coarse step.

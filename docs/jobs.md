# Scheduled jobs and expiry checks

Card: FMS-26 (SE-62). Code: `packages/backend/src/shared/jobs/` (the scheduler) and `packages/backend/src/modules/fleet/application/expiry.service.ts` (the expiry checks).

## Declaring a job

A module lists its jobs on its `AppModule`:

```ts
jobs: [{ name: 'document-expiry-check', at: '07:00', run: (context) => expiryService.checkDocuments(context) }]
```

- `name` is unique across modules: the lock and the run history are keyed on it.
- `at` is the local time (HH:MM, Addis Ababa) from which the day's run is due.
- `run(context)` gets `now`, the run's `correlationId` (a fresh UUID) and its `runKey` (the local day). It returns a small result for the history (counts, never personal data).
- `leaseMs` is optional (default 15 minutes): how long a run may hold the lock before another instance may take it over.
- `every` replaces `at` for a job that runs every few minutes (FMS-92): a divisor of 60, on the clock (every 5: :00, :05 ...). See [Interval jobs](#interval-jobs).

Only the server runs jobs (`src/server.ts`), with the platform's own (`event-outbox-cleanup`). Tests call `job.run(context)` or `runJob(job, deps)` directly. Scripts never run jobs.

## Running once across instances

Every app instance schedules every job, with node-cron at `at`. A sweep also runs every 10 minutes and once at start-up: it triggers jobs that are due but not yet done today. So a server that was down at 07:00 catches up the same day, and a failed run is retried.

Every trigger first claims the run in `jobs.job_runs`, keyed on (job, local day). The claim is a single `INSERT … ON CONFLICT` statement: two instances claiming at once serialise on the unique key, and exactly one gets the row.

- A run that **succeeded** is never taken again that day.
- A **running** one is not taken again while its lease lasts.
- A **failed** run, or one whose lease ran out because its instance died, is taken again, up to 5 attempts a day.

The row is also the run history: status, attempts, instance, correlation id, start and finish times, the result or the error.

With Redis (FMS-72), a lease taken first (`SET NX PX` on `fms:lock:job:<job>:<day>`) decides which instance runs. The losers stop without a PostgreSQL round trip. The winner still claims the `jobs.job_runs` row, which stays the durable once-a-day guarantee: a Redis restart forgets leases, not runs. Without Redis, the PostgreSQL claim alone does both (`RedisJobLock` wraps `PostgresJobLock` behind the `JobLock` interface).

## Interval jobs

A job with `every: N` (minutes) runs on its own cron (`*/N * * * *`). Its run key is the slot, the local time rounded down to N minutes (`2026-10-21T09:15`), so the same lock runs each slot once across instances.

- **No catching up.** A slot missed while the server was down is not caught up: the sweep ignores interval jobs, and the next slot does the work (the escalation job looks at what is due now).
- **Quiet runs.** A run whose result counts nothing (no number above 0) writes no audit entries, so a quiet minute is not two audit rows. A run that did something writes `job.succeeded` with its result, and a failure always writes `job.failed`.
- **Retention.** Their `jobs.job_runs` rows are kept 7 days by `job-runs-cleanup`: a job every minute writes 1,440 a day.

## Audit

Each run writes `job.started`, then `job.succeeded` (with the result and duration) or `job.failed` (with the error, `result: failed`). Both entries go to `audit.audit_logs` with no user (the system), entity `jobs.job_runs`, and the run's UUID as correlation id. The whole run executes with the request source `{channel: "job", actor: "system", job: <name>}`, so every audit row it writes, including any mutation, records the system actor (FMS-27). The events a run publishes carry the same correlation id, with `actor: null`; they go into the outbox with the run's changes (docs/events.md).

## Jobs today

| Job | At | Does |
|---|---|---|
| `document-expiry-check` | 07:00 | `DocumentExpiring` for live documents of active vehicles and drivers |
| `licence-expiry-check` | 07:00 | `LicenceExpiring` for active drivers |
| `driver-account-sync` | 03:00 | Re-copies drivers' account fields into `fleet.driver_accounts` |
| `trip-assignment-sync` | 03:20 | Rebuilds `fleet.trip_assignments` (availability read model, FMS-76) from the trip module. Rows it had to repair or remove mean a trip changed without its event: logged as a warning (`kept`, `repaired`, `removed` in the run history) |
| `downtime-sync` | 03:25 | Re-derives every vehicle's downtime periods (`fleet.downtime_periods`, FMS-131) from its status history and its repairs and failures, 200 vehicles to a transaction. A period added, corrected or removed means a change came without its event: logged as a warning (`vehicles`, `added`, `repaired`, `removed` in the run history). A staff member's reason is kept ([downtime.md](downtime.md)) |
| `engine-hours` | 01:00 | One engine-hours reading per vehicle and local day before today, back 7 days (days already read are skipped), from the ignition-on time in its device and telematics pings; phone-only vehicles get none (FMS-126, [meter-readings.md](meter-readings.md)) |
| `service-due` | 01:30 | Each vehicle in service under each active service program, 250 vehicles per transaction: what its count starts from, when each measure falls due and its status from today's meters; rows that no longer apply removed; `ServiceDue` / `ServiceOverdue` for each move into due or overdue (FMS-129, [service-programs.md](service-programs.md)) |
| `maintenance-scoring` | 02:00 | Scores every vehicle in service with the active model through the ML service, in batches of 100: a prediction and the vehicle's health score each, and `MaintenanceRiskDetected` for a score falling below 75. An ML service that is down, or a model that may not score, skips the vehicles and the run still finishes (FMS-55, [ml-scoring.md](ml-scoring.md)) |
| `meter-reading-sync` | 03:10 | Re-adds the odometer readings of fuel logs and completed repairs of the last 30 days that have none (an event missed, data written without events), oldest first (FMS-126) |
| `fuel-reconciliation` | 04:30 | Last calendar month's fuel logged against what each vehicle's completed trips needed at its rating: a fuel anomaly and `FuelAnomalyDetected` for a vehicle more than `FUEL_VARIANCE_THRESHOLD_PCT` (20) above or below, once per vehicle and month. The first run of a month does the work; later runs flag only vehicles that late fill-ups or trips pushed over (FMS-41, [fuel-reconciliation.md](fuel-reconciliation.md)) |
| `idempotency-key-purge` | 02:00 | Deletes expired `api.idempotency_keys` rows (FMS-87). Platform job (`src/shared/http/idempotency-purge.ts`), added in `src/server.ts` rather than on a module |
| `event-outbox-cleanup` | 03:30 | Deletes domain events delivered more than 7 days ago, and consumers' records of them; dead letters stay (platform job, `src/shared/events`, FMS-73) |
| `job-runs-cleanup` | 03:40 | Deletes interval jobs' runs (run key with a time) finished more than 7 days ago (platform job, `src/shared/jobs`, FMS-92) |
| `route-roads` | every hour | Measures the road of up to 50 active routes that have both ends and none yet (saved while the routing engine was down or before it was set up); a typed distance stays. Stops at the first engine failure (FMS-84, [routing.md](routing.md)) |
| `alert-escalation` | every minute | Escalates critical alerts left unacknowledged for `ALERT_ESCALATION_MINUTES` to the next tier (docs/alerts.md) |
| `analytics-refresh-nightly` | 02:15 | Recomputes `analytics.analytics_cache` for the last 35 days (Addis Ababa), for fill-ups, trips and repair costs entered late; an empty cache is filled 400 days back. Aggregates on the read replica, writes the primary, then drops the cached analytics answers in Redis (FMS-50, [analytics.md](analytics.md)) |
| `analytics-refresh-hourly` | every hour | The same for today and yesterday, so the KPIs are at most an hour behind (FMS-50) |

## Expiry levels

| Days to the expiry date (Addis Ababa calendar days) | Level |
|---|---|
| 31 or more | none |
| 8 to 30 | `amber` |
| 0 to 7 (the expiry day itself is 0) | `red` |
| already past | none: dispatch checks block it; these warnings come before that point |

Each level is raised **once per subject and expiry date**: `fleet.expiry_notices` has one row per (document or licence, expiry date, level). A document first seen at 20 days gets `amber`, then `red` when it reaches 7. One first seen at 5 days gets only `red`. If a day is missed, the next run still raises whatever is due.

Re-running a check publishes nothing new, and neither does the upload check overlapping the daily one. A new expiry date (a renewed licence, a replacement document) starts again. Event ids are also derived from (subject, expiry date, level), so a consumer that sees one twice can drop the duplicate.

A document uploaded with an `expires_on` already inside the window is checked at once on `DocumentUploaded`. The event then carries the upload request's correlation id.

The alert engine (FMS-92) turns `DocumentExpiring` and `LicenceExpiring` into alerts.

## Read models after a direct write

The seed, a bulk import or a restore writes tables without publishing events, so the read models kept from events (`AppModule.readModels`: `fleet.driver_accounts`, `fleet.trip_assignments`, `fleet.downtime_periods`, `fleet.meter_readings`) do not see it. Call `rebuildReadModels()` from `src/modules` afterwards, as `scripts/seed/apply.ts` does: it rebuilds each one from its source and returns what changed. A new read model declares its rebuild in its module's `readModels` and is covered.

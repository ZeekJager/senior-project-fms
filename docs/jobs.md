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

Only the server runs jobs (`src/server.ts`). Tests call `job.run(context)` or `runJob(job, deps)` directly. Scripts never run jobs.

## Running once across instances

Every app instance schedules every job, with node-cron at `at`. A sweep also runs every 10 minutes and once at start-up: it triggers jobs that are due but not yet done today. So a server that was down at 07:00 catches up the same day, and a failed run is retried.

Every trigger first claims the run in `jobs.job_runs`, keyed on (job, local day). The claim is a single `INSERT … ON CONFLICT` statement: two instances claiming at once serialise on the unique key, and exactly one gets the row.

- A run that **succeeded** is never taken again that day.
- A **running** one is not taken again while its lease lasts.
- A **failed** run, or one whose lease ran out because its instance died, is taken again, up to 5 attempts a day.

The row is also the run history: status, attempts, instance, correlation id, start and finish times, the result or the error.

With Redis (FMS-72), a lease taken first (`SET NX PX` on `fms:lock:job:<job>:<day>`) decides which instance runs. The losers stop without a PostgreSQL round trip. The winner still claims the `jobs.job_runs` row, which stays the durable once-a-day guarantee: a Redis restart forgets leases, not runs. Without Redis, the PostgreSQL claim alone does both (`RedisJobLock` wraps `PostgresJobLock` behind the `JobLock` interface).

## Audit

Each run writes `job.started`, then `job.succeeded` (with the result and duration) or `job.failed` (with the error, `result: failed`). Both entries go to `audit.audit_logs` with no user (the system), entity `jobs.job_runs`, and the run's UUID as correlation id. The whole run executes with the request source `{channel: "job", actor: "system", job: <name>}`, so every audit row it writes, including any mutation, records the system actor (FMS-27). The events a run publishes carry the same correlation id, with `actor: null`.

## Jobs today

| Job | At | Does |
|---|---|---|
| `document-expiry-check` | 07:00 | `DocumentExpiring` for live documents of active vehicles and drivers |
| `licence-expiry-check` | 07:00 | `LicenceExpiring` for active drivers |
| `driver-account-sync` | 03:00 | Re-copies drivers' account fields into `fleet.driver_accounts` |
| `idempotency-key-purge` | 02:00 | Deletes expired `api.idempotency_keys` rows (FMS-87). Platform job (`src/shared/http/idempotency-purge.ts`), added in `src/server.ts` rather than on a module |

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

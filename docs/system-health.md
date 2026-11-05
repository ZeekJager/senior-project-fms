# System health (FMS-143)

One admin screen, **S-31 System health** (`/system-health`, `system:read`, admin only), for how FMS itself is
doing: when each part was up or down, what went wrong, the scheduled jobs that failed, and the API's error rate
and latency. Problems are noticed and explained from the app, without server access, and the uptime can be shown
to the client. The API is `GET /system/health` and `GET /system/health/history` (api-contract §3.8).

## What is sampled

Once a minute, a second past the minute, **every API instance** checks each component at once, each within 3
seconds (slower is down), and records one row per component in `system.health_samples`: `ok`, `down` with the
error in our words, or `disabled` (not configured on this server), with the check's latency.

| Component | The check | Down when |
|---|---|---|
| `api` | The instance's own `GET /health/live`, over HTTP | It does not answer; and see *No data* below |
| `database` | `SELECT 1` on the primary | It fails or takes over 3 s |
| `replica` | The read router's lag check (FMS-94) | Unreachable, or more than `READ_REPLICA_MAX_LAG_SECONDS` behind. `disabled` without `DB_READ_HOST` |
| `redis` | `PING` | It fails. `disabled` without `REDIS_HOST` |
| `ai_service` | The AI service's `GET /health` | It fails or answers other than 2xx. `disabled` without `ML_SERVICE_URL` |
| `provider:<code>` | Each active provider's circuit breaker on the instance (FMS-85) | The circuit is open, or half-open (it opened and no call has got through since). Its latency is the mean of the calls in the breaker's window |

The sampler is not a scheduled job: those take their lock in the database, and the sampler must still sample
while the database is down. When the samples cannot be written they wait in memory (up to a day) and are written
once the database answers, so a database outage is recorded too. The instances sample the same minutes; the
first row for a component and minute stands, unless a later instance found it **down**, which wins (down on one
instance is down for the requests it serves). Breakers are per instance, so a provider is down when any
instance's circuit for it is open.

## Uptime, no data and outages

- **Uptime** over 24 hours, 7 days and 30 days is the share of the component's sampled minutes it was up: `ok /
  (ok + down)`, floored to two decimals so a short outage never reads 100%. Minutes it was `disabled` are not
  counted. The windows end at the start of the current minute.
- **No data.** A minute with no sample of a component is *no data*, left out of its uptime and counted on its
  own. The history starts at the first sample: before it there was nothing to sample with.
- **The API itself.** Every instance samples the API every minute, so a minute *between two of its samples* with
  none means no instance was running: for the API that minute is **down** ("No samples: the API was not running").
  The minutes after its last sample are no data (this minute may simply not be written yet).
- **Outages** are runs of down minutes of a component, with when they started and ended, how long they lasted and
  their first error. One whose last minute is the last or the one before goes on (ended is empty). Stopping Redis
  for 3 minutes is a 3-minute Redis outage.
- **Now** is a component's sample of the last minute or the one before; with none it is *no data*, except the API,
  which is answering.

## Requests

A middleware first in the chain (`src/app.ts`) counts every API request when its response is sent: per minute,
how many, how many answered with a 5xx, and their latencies as a histogram (`REQUEST_LATENCY_BUCKETS_MS`, 5 ms
to 10 s, and one bucket for slower). Health checks are left out: a load balancer's probes would drown the traffic.
Each instance writes its minute's counts with the samples, added to the other instances' in
`system.request_rollups`; counts the database refused wait for the next minute. Only counts are stored: **no paths,
bodies, users or ids**.

The p95 latency is read from the summed histogram of a period, interpolated within its bucket (so it is accurate
to the bucket: 150 to 200 ms, say); past 10 s it reads *at least 10 s*.

## Failed jobs

The scheduled job runs that failed in the last 30 days, from `jobs.job_runs` (FMS-26), newest first, with the run
(the day of a daily job, the slot of an interval job), the attempts and the error. A failed daily run is retried
by the sweep up to 5 attempts and listed until a retry succeeds; interval runs are kept a week
(`job-runs-cleanup`). Each run is also in the audit log (`job.failed`).

## The screen

- A line on top: all systems working, the components that are down with their errors, or no samples yet.
- The period (24 hours, 7 days, 30 days) picks the strips, the request figures and charts, and the outages and
  failed jobs listed. The uptime columns always show all three.
- **Components:** each with its status now and last latency, a strip of the period (15-minute cells over 24
  hours, 2 hours over 7 days, 8 hours over 30 days: green up, amber partly down, red down for half the cell or
  more, grey no data, with the minutes in each cell's tooltip) and its uptime. Components not set up on the server
  say so.
- The requests, the 5xx share, the p95 latency and the outages of the period; the error rate and the p95 latency
  over the period, one chart each.
- The outages and failed jobs of the period.

The screen reads every minute. It reads the primary, never the replica it reports on.

## Retention

`system-health-retention` (daily, 03:50) removes samples and request counts older than 30 days. At 11 components
a minute that is about 475,000 sample rows and 43,200 request rows at most.

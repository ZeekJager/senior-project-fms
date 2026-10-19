# Domain events, outbox and Redis pub/sub

Card: FMS-73 (SE-117). Code: `packages/backend/src/shared/events/`. Rules for module authors and the event catalogue: [CONVENTIONS.md, Events](../CONVENTIONS.md#events).

## How an event travels

```text
service, inside the change's transaction
  ├─ the change (+ its audit row)
  └─ eventBus.publish(client, [event])  ──►  events.outbox row
                                              (commits or rolls back with the change)
                         after commit
outbox relay (one per instance; one active at a time)
  1. broadcast  ──►  Redis PUBLISH fms:events:<EventType>  ──►  real-time gateway (Socket.IO, later)
  2. dispatch   ──►  in-process consumers, each in its own transaction
                     with its events.processed_events row
```

- **Rolled back means not published.** The event is a row written by the change's own transaction. A refused or failed change takes its event with it. A committed change cannot lose its event, even if the process dies straight after the commit.
- **Delivery is at least once.** Every step records its progress as soon as it is made: `published_at` and `dispatched_at` on the outbox row, and one `processed_events` row per consumer. A relay that stops (a deploy or a crash) is replaced by the next one, which resumes at the first row that is not finished. It may deliver the row it was working on again. Consumers that already handled that row skip it.

## Tables (migration 026, schema `events`)

| Table | Holds |
|---|---|
| `events.outbox` | One row per event: the envelope and `aggregate_key`. Delivery state: `published_at` (on Redis), `dispatched_at` (consumers done), plus `attempts`, `next_attempt_at`, `last_error` and `dead_lettered_at`. `event_id` is unique. |
| `events.processed_events` | `(consumer, event_id)` for each event a consumer has handled. Written in the consumer's transaction. |

`events` is platform-owned, like `api` and `jobs`. Modules publish through `eventBus` and the lint rule (`fms/no-cross-schema-sql`) refuses module SQL on these tables. The card named `shared.outbox_events`, but `shared` holds the types and functions every module may use. A table there would be open to every module's SQL.

## The relay

`OutboxRelay` (`outbox-relay.ts`), started by `src/server.ts` on every instance.

- **One at a time.** Each pass takes a PostgreSQL session advisory lock (`pg_try_advisory_lock`) on one connection. An instance that does not get it skips the pass. The lock goes with its connection, so an instance that dies never keeps it.
- **Polling.** When idle, a relay checks every 200 ms with one indexed query, so a committed event is on Redis well within a second. While there is a backlog it runs pass after pass. If the database is unreachable it backs off, up to 5 s.
- **Each pass, in this order:**
  1. **Broadcast.** Unpublished rows, oldest first, go onto Redis. The first failure stops this phase, and the next pass starts again at that row, so Redis sees events in outbox order. Broadcasting does not wait for consumers.
  2. **Dispatch.** Due rows go to the consumers of their type (see ordering below). A row is done when every consumer has handled it.
- **Without Redis** (no `REDIS_HOST`), broadcasting is skipped and a row is done once it is dispatched. **While Redis is down**, rows are dispatched as usual and wait for their broadcast. Consumers are never held up by Redis.

### Order per aggregate

An event can name its aggregate: `aggregate: aggregateKey('vehicle', id)`. One aggregate's events reach consumers in the order they were written.

- **A failure holds back only its own aggregate.** When an event fails, the later events of its aggregate wait for it. Other aggregates carry on.
- **Events without an aggregate are independent.** Nothing waits for them, and they wait for nothing.

Outbox order is commit order for one aggregate because services publish at the end of the transaction, after writing (and so locking) the aggregate's row. A second change to the same row waits for the first to commit before it writes its own event.

### Retries and dead letters

Each consumer runs in its own transaction. A consumer that throws rolls back its own work and its `processed_events` row; the consumers that succeeded keep theirs and are not run again. The row is retried after 1 s, 2 s, 4 s and so on, up to 5 minutes. After 10 attempts (about 8.5 minutes) the row is **dead-lettered**:

- `dead_lettered_at` is set, with the last error in `last_error`;
- its aggregate moves on;
- the relay logs `event dead-lettered` at error level;
- `/health/ready` reports `outbox: "degraded"`.

To look at dead letters (as `fms_admin`):

```sql
SELECT id, event_id, event_type, aggregate_key, attempts, last_error, created_at
  FROM events.outbox WHERE dead_lettered_at IS NOT NULL ORDER BY id;
```

Fix the consumer, deploy, then give the event another round. Consumers that had already handled it skip it.

```sql
UPDATE events.outbox
   SET dead_lettered_at = NULL, attempts = 0, next_attempt_at = NULL, last_error = NULL
 WHERE event_id = '<event id>';
```

## Consumers

```ts
eventBus.subscribe(USER_EVENTS.accountChanged, 'fleet.driver-accounts', async (event, tx) => {
  await driverService.onAccountChanged(tx, String(event.payload.user_id));
});
```

- **The consumer name** is `<module>.<purpose>`, unique per event type. Keep it once it is released: `processed_events` is keyed on it.
- **`tx` is the transaction that records the event as handled.** Database work done on it commits with that record, so it happens exactly once. Work done elsewhere (a cache delete, a call to another service) may run again if the process dies before the commit, so it must be safe to repeat.
- **Consumers run one after another**, in subscription order, on the instance that holds the relay lock. Keep them short. Slow work belongs in a job.

Today's consumers:

| Consumer | Reacts to | Does |
|---|---|---|
| `fleet.vehicle-cache` | `MaintenanceRecordOpened`, `MaintenanceRecordUpdated`, `MaintenanceRecordCompleted`, `VehicleFaultDetected`, `TripAssigned`, `TripCancelled` | Drops the cached vehicle (FMS-72), and on `TripAssigned` the one it replaced (`previous_vehicle_id`), so its flag and current trip show at once |
| `fleet.driver-accounts` | `UserAccountChanged` | Refreshes fleet's copy of the driver's account, on `tx` |
| `fleet.document-expiry` | `DocumentUploaded` | Raises `DocumentExpiring` at once for a document already inside the 30-day window, on `tx` |

Today's projections (`eventBus.project`): they run inside `publish`, on the transaction that makes the change, and commit or roll back with it. No outbox delivery, no retries; a rebuild from the source repairs anything written without its events.

| Projection | Reacts to | Does | Rebuilt by |
|---|---|---|---|
| `fleet.trip-assignments` | Every trip event (`TRIP_EVENTS`: `TripCreated`, `TripUpdated`, `TripCancelled`, `TripAssigned`, `TripStarted`, `TripCompleted`) | Re-reads the trip from the trip module and updates `fleet.trip_assignments`, the availability read model (FMS-76). The event says which trip; the trip says what is true | `trip-assignment-sync` (daily, logs drift); `rebuildReadModels()` |

## Redis channels

| Channel | Message |
|---|---|
| `<prefix>:events:<EventType>` (`fms:events:VehicleRetired`) | The JSON envelope `{ id, type, version, occurred_at, actor, correlation_id, payload }` |

`eventChannel(type)` names a channel. A gateway subscribes to the types it forwards, or to `fms:events:*` with `PSUBSCRIBE`. Pub/sub keeps nothing: a gateway that was not connected when an event went out never gets it. So a client that reconnects reloads its state through the API, and events stay hints, not records. After a Redis outage the relay sends the backlog in order. A gateway may drop events whose `occurred_at` is too old to be worth showing.

## Lag and health

`/health/ready` (still 200 either way):

```json
"checks": { "database": "ok", "redis": "ok", "outbox": "ok" },
"metrics": { "outbox": { "undispatched": 0, "unpublished": 0, "oldest_pending_seconds": 0, "dead_lettered": 0 } }
```

- `outbox` turns `degraded` when an event has waited 60 s or more, or when any event is dead-lettered.
- While anything is pending, the relay logs `outbox lag` with these numbers once a minute: at info level, or at warn level when it is degraded.

## Retention

The daily `event-outbox-cleanup` job (03:30, [jobs.md](jobs.md)) deletes events delivered more than 7 days ago, then `processed_events` rows as old whose event is gone. Dead letters, and the records of the consumers that did handle them, stay until someone deals with them. An event is redelivered only while its row is still in the outbox, so a consumer's records last as long as any redelivery can.

## Notes

- **Seeding** (`make seed`) writes its events into the outbox like any other change. The relay delivers them when the server next starts.
- **Tests:** `publishedEvents()` and `deliverEvents()` ([testing.md](testing.md#domain-events)). `test/integration/events.test.ts` covers the acceptance criteria:
  - a rollback publishes nothing;
  - a redelivered event is handled once;
  - order is kept per aggregate;
  - dead letters;
  - resume after a restart;
  - one relay at a time;
  - Redis outages;
  - a committed event reaches Redis within a second (with Redis: CI).

# Read replica and read routing (FMS-94)

Card: FMS-94 (SE-138). Code:

- `packages/backend/src/shared/infrastructure/read-router.ts`: the sessions, the lag check and the fallback;
- `packages/backend/src/db.ts`: `replicaPool` and `reads` (the card's `db.read`);
- `docker/postgres/replica/entrypoint.sh` and `docker/postgres/pg_hba.conf`: the replica in Compose;
- `scripts/ci/check-replica.sh`: the check on a running stack (CI's `docker-stack` job).

Architecture §18 (Database Architecture: read replica), §29 (performance), Scenario D.

Heavy reporting reads go to a copy of the database, so they cannot slow the primary's writes: dispatch, fuel logs and GPS ingestion.

## In Compose

`postgres-replica` is a streaming hot standby of `postgres` (PostgreSQL 16). It is not published to the host.

**Every time it starts, its entrypoint first connects to the primary as `fms_admin`.** It makes sure of two things:
- **the role:** the replication role `fms_replicator` exists, with `DB_REPLICATION_PASSWORD` from `.env`;
- **the slot:** the physical slot `fms_replica` exists, so the primary keeps the WAL the replica still needs.

Both happen on every start, not in `docker/postgres/init`, so a primary volume created before this card works too.

**First start (empty volume):**
- It copies the primary with `pg_basebackup -R`.
- That copy carries `standby.signal` and the connection settings, so the replica is a standby from then on.

**Later starts:** it carries on streaming from where it stopped.

**The primary** now starts with:
- `hba_file=/etc/fms/pg_hba.conf`: the image's default rules plus `host replication fms_replicator all scram-sha-256`;
- `max_slot_wal_keep_size=1GB`: a replica left stopped cannot fill the primary's disk. Past 1 GB it can no longer catch up and must be copied again (below).

**The replica** uses the same client rules.
- It runs with `hot_standby_feedback=on`, so the primary does not clean up rows a long report on the replica is still reading.
- The backend connects to it as `fms_app`. A physical copy has the same roles, passwords and grants, and a standby refuses every write.

**Starting over:** to copy the primary again, remove the replica's container and volume. The next `up` copies it again:

```sh
docker compose rm -sf postgres-replica
docker volume rm <project>_postgres_replica_data
```

### An existing stack

`docker-compose.yml` now needs `DB_REPLICATION_PASSWORD`. If your `.env` was made before this card:
1. Run `node scripts/init-env.mjs` once. It adds the missing key with a generated value and keeps every other value.
2. Then run `docker compose up -d`.

The primary restarts with the new client rules and the replica copies it. The data stays as it is.

## The backend

**Connecting.** `DB_READ_HOST` and `DB_READ_PORT` (Compose sets `postgres-replica:5432`) point the backend at the replica, with the same database, user and password as the primary.
- Without `DB_READ_HOST` (local runs, the tests) there is no replica, and every read is the primary's.
- The replica's pool gives up connecting after 2 s. A replica error is logged; a primary error ends the process.

**One session per request.** A reporting service calls `reads.session()` once per request (or job run) and runs every query of that request on it. The request then sees one point in time, from one database.

| The replica | A new session reads | Readiness `checks.replica` |
|---|---|---|
| Not configured | the primary | `disabled` |
| Up, at most `READ_REPLICA_MAX_LAG_SECONDS` behind (default 30) | the replica | `ok` |
| More than that behind | the primary | `degraded` |
| Down: cannot connect, shutting down, starting | the primary; the replica is not tried again for 30 s | `degraded` |

**Checking the replica.** A session checks the replica's state when the last check is older than 5 s. Sessions arriving at the same moment share one check.
- **The check:** `pg_is_in_recovery()` and how far replay is behind. If the replica has replayed everything it received, it is 0. Otherwise it is the time since the last transaction it replayed.
- **Readiness** checks at once (`GET /health/ready`).
- **Status:** a degraded replica keeps the status `degraded` and the response 200, as Redis does: the API still answers from the primary.

**When the replica fails during a request.** A connection failure, a shutdown, too many connections, or a query cancelled by the standby's replay (40001) moves the rest of that request to the primary. The next requests go to the primary too, until the replica answers again. Any other error, such as a syntax error or a missing table, would fail on the primary as well, so it is returned as it is.

**`metrics.replica` on `/health/ready`:**
- `lag_seconds`: the last lag measured, -1 when unknown;
- `in_use`: 1 when sessions read the replica;
- `max_lag_seconds`;
- `fallbacks`: sessions this instance sent to the primary instead.

## What reads it

| Read | Why |
|---|---|
| `GET /fuel-reconciliation`, `GET /vehicles/{id}/fuel-summary` and the monthly `fuel-reconciliation` job (FMS-41) | A month of trips and fill-ups for every vehicle |
| `GET /audit-logs` (FMS-28) | The largest table, searched by many filters |

**Every response from these reads carries `meta.data_freshness`:**

```json
{ "source": "replica", "lag_seconds": 2, "as_of": "2026-10-29T08:14:03.000Z" }
```

- From the primary it reads `source: "primary"` and `lag_seconds: 0`.
- After a failure in the middle of a request it reads `source: "primary"` but keeps the replica's lag, because part of the data came from the replica.

**What stays on the primary.** Forms, dispatch, the live map, and any read that a write depends on read the primary, inside the write's transaction where there is one. The replica is seconds behind and refuses locks (CONVENTIONS.md, Read replica). The fuel reconciliation job reads the month on the replica, then checks for existing anomalies and writes new ones on the primary, in one transaction.

## Tests

- `read-router.test.ts` (unit) covers:
  - reading the replica, and its lag;
  - one check every 5 s, shared between sessions;
  - too far behind, and catching up;
  - down, the 30 s before retrying, and recovery;
  - a failure in the middle of a request;
  - query errors that are not fallbacks;
  - no replica configured;
  - which errors count as unavailable.
- `test/integration/read-replica.test.ts` covers:
  - a second pool to the test database standing in for a replica that answers, with the lag query running as `fms_app`;
  - a closed port for a replica that is down: reads fall back, and readiness reports `degraded` with status 200;
  - `data_freshness` on all three endpoints.
- `scripts/ci/check-replica.sh` (CI `docker-stack` job) runs on the real Compose stack. It checks that:
  - the replica streams through its slot;
  - a write on the primary reaches it, and it refuses a write;
  - readiness reports it `ok`;
  - with it stopped, readiness is `degraded` and still 200;
  - started again, it is `ok` again.

## On screen

The fuel reconciliation screen (S-15, FMS-42, [fuel-reconciliation.md](fuel-reconciliation.md#the-screen-s-15-fms-42)) shows "Data as of 14:05" beside its tabs. When the replica is 5 s or more behind, it adds how far behind live the data is, for example "12 s behind live".

## Not covered yet

**The audit log screen** (S-10, SE-65) is still on its own branch. It should show the same line from `meta.data_freshness` of `GET /audit-logs`.

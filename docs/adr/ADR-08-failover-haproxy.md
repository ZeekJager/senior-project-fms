# ADR-08: Manual Failover Behind an HAProxy Endpoint

- **Status:** Accepted
- **Date:** 2026-11-24
- **Card:** FMS-162 (SE-205)

## Context

The API connected to the primary by container name, and the read replica (FMS-94) could not take over: it ran a different image (no pgBackRest), the API exited when its primary connection failed, and nothing moved the API to another server. FMS-162 asks for service back within 15 minutes after the primary fails, under 10 s of data lost, no redeploy or configuration change, no lost GPS positions, and a fenced old primary that rejoins as the replica.

## Decision

- **A stable endpoint: HAProxy** (`db-proxy`, `haproxy:3.0.29-alpine`) in TCP mode. `:5432` goes to the server whose role agent says it is the primary, `:5433` to the one that says it is a standby. The role agents are a shell script behind `socat` in each database container (ports 5480 and 5481), asked once a second by HAProxy's agent check. A server leaving the pool has its sessions closed, so pools reconnect at once.
- **Both servers run the same image and settings**, with `wal_log_hints=on` for `pg_rewind`, and `tini` as PID 1 so the helpers beside PostgreSQL are never its children.
- **Manual promotion:** `scripts/dr/promote.sh` fences (a file in the old primary's data directory, which its agent and entrypoint both obey), promotes, waits for the endpoint and the API, and starts a backup; `scripts/dr/rejoin.sh` rewinds the old primary with `pg_rewind` and makes it the standby. One person decides; automatic failover waits until game days have built trust.
- **The API degrades instead of dying:** connection errors and SQLSTATEs of a database going away (class 08, 57P01 to 57P03, 25006) answer `503` with `Retry-After`; the pool's idle-client errors are logged, not fatal.

## Alternatives

- **Patroni** (with etcd): automatic failover and fencing by leader lease. Right for production in time, but it adds a consensus store and a second control plane to learn before the team has rehearsed even a manual failover. Deferred, as the card says.
- **PgBouncer** with its host rewritten on failover: also a stable endpoint, but it needs its own user list and authentication setup and a script to change it, and it has no notion of which server is the primary. HAProxy asks.
- **Moving a DNS name** (a Docker network alias): no extra service, but every client caches resolution differently, and Compose would put the alias back on the wrong server the next time it recreated a container.
- **libpq's multi-host connection strings** (`target_session_attrs=read-write`): no proxy at all, but node-postgres does not support them, and the standby's replication connection could not use them either.

## Consequences

- Measured on the development stack: a failover restores full service in 9 s (the API answered 503 for 4.1 s), 1,000 GPS positions sent across it were all stored, and the old primary rejoined in 15 s. CI runs a failover, the fence, a rejoin and a failback on every push (`scripts/ci/check-failover.sh`).
- One more service in the stack, and a single HAProxy is itself a single point of failure: in production it runs on each API host (or as two with a floating address).
- The service names no longer say which server is the primary; the data directory does. `docker compose up` after a failover keeps the roles, because each server reads its own data directory.
- PostgreSQL runs under `tini`; helpers started beside it must be detached so the postmaster never parents them (it took one exiting for a crashed backend and restarted the whole server, which was how this was found).

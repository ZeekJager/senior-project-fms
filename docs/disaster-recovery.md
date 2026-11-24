# Disaster recovery (FMS-162)

What happens when the database server fails, the data is damaged, or the site is lost: who decides, what to run, and how long it takes. Backups and point-in-time recovery are in [backups.md](backups.md); the standby in [read-replica.md](read-replica.md). Decided in [ADR-08](adr/ADR-08-failover-haproxy.md).

**Status: draft for sign-off.** To be reviewed and signed off by the team and the advisor (bottom of this page), with the client's answers to the open questions.

## Targets

| Scenario | Data lost at most (RPO) | Service back within (RTO) | How |
|---|---|---|---|
| **The database server fails** (disk, crash, the container or VM gone) | What the standby had not received: under 10 s, typically under 1 s | **15 minutes** (measured: 9 s) | [Failover](#failover-runbook): promote the standby |
| **Data deleted or damaged by mistake**, or a bad migration | None: restore to the second before | 2 hours | [Point-in-time restore](backups.md#point-in-time-restore-runbook) |
| **The whole site lost** (both servers and the repository beside them) | Under 1 minute (the off-site copy is at most a minute behind; alerted on at 15) | 4 hours | Restore from the [off-site repository](backups.md#off-site-repository) on a new server: `npm run backup:pitr -- --to <time> --repo 2` |

A failover cannot help with damaged data: the standby replays the damage within a second. That is the point-in-time restore's job.

## How it works

```text
              API (DB_HOST=db-proxy)
                       |
                 db-proxy (HAProxy)
           :5432 primary    :5433 standby
             /                    \
     fms_postgres  ── streams ──>  fms_postgres_replica
        (primary)   (through          (standby)
                     db-proxy)
             \                    /
               pgbackrest_repo  (+ repo2 off site)
```

- **One stable endpoint.** The API, the standby and the scripts connect to `db-proxy`, never to a server by name. Once a second HAProxy asks each server's role agent (`docker/postgres/pgbackrest/role-agent.sh`, ports 5480 and 5481) whether it is the primary or a standby, and sends `:5432` to the primary and `:5433` to the standby. After a failover the same name reaches the new primary within about a second: no redeploy and no configuration change.
- **Both servers are the same.** The same image (`fms-postgres:16`), settings, backup repository and passwords, so either can be the primary. Each data directory says what its server is (`standby.signal`), not the service name: after a failover `postgres-replica` is the primary until a failback.
- **Fencing.** A failover writes `fms.fenced` into the old primary's data directory before stopping it. Its role agent then says `down`, so the endpoint sends it nothing, and it refuses to start until it rejoins as the standby: there is never a second primary taking writes.
- **The API waits instead of failing.** While the database is unavailable, every request answers `503 UPSTREAM_UNAVAILABLE` (`database_unavailable`) with `Retry-After: 5`, rather than a 500, and the API keeps running: its pool drops the broken connections and reconnects (a connection attempt gives up after 5 s). The phone's GPS buffer and offline queue, devices and providers' webhooks send again, so nothing sent during a failover is lost. Every screen shows *Reconnecting…*; on the driver's phone it says that what they do is kept and sent when the server is back.
- **The new primary archives and backs up.** Its backup loops start once it is promoted, and `promote.sh` starts a full base backup of its new timeline at once. pgBackRest keeps the timelines apart, so point-in-time recovery still reaches across the failover.

## Who does what

| Role | Who (to name at sign-off) | What |
|---|---|---|
| **Incident lead** | The on-call administrator | Declares a disaster, chooses failover or restore with the decision tree, runs the runbook, keeps the log |
| **Second administrator** | A second named administrator | Checks each step, holds the second copy of the backup passphrases ([backups.md](backups.md#who-holds-the-keys)) |
| **Fleet manager on duty** | The fleet manager on shift | Tells dispatchers and drivers; confirms trips and GPS look right afterwards |
| **Advisor / client contact** | The client's contact | Told of any disaster; signs off a restore that loses data |

**Who declares a disaster:** the incident lead, when System health shows the database down for more than 2 minutes, an alert says so (archiving failing, a backup repository unreachable), or users report that nothing saves. One person decides; the scripts act. Automatic failover (Patroni) is deferred until game days have been run and the team trusts the procedure.

**Contact list:** names, phone numbers and the order to call them are kept with the client's password manager entry, not in this repository. Fill in at sign-off:

| Role | Name | Phone | Backup person |
|---|---|---|---|
| Incident lead | | | |
| Second administrator | | | |
| Fleet manager on duty | | | |
| Client contact | | | |

## Decision tree

```text
Is the database answering at all?   (System health: Database; docker compose ps)
├─ No, the primary server is down or unreachable
│    Is the standby up and close behind?   (promote.sh prints how far behind it is)
│    ├─ Yes ── FAILOVER (below). Minutes; loses at most what the standby had not received.
│    └─ No  ── RESTORE from the repository onto a new server (backups.md), latest point.
└─ Yes, but the data is wrong (deleted, damaged, a bad migration)
     └─ POINT-IN-TIME RESTORE to the second before (backups.md). Do NOT fail over:
        the standby has the same damage.
Is the site itself lost (both servers, or the repository beside them)?
     └─ RESTORE from the off-site repository on a new server: npm run backup:pitr -- --to <time> --repo 2
```

## Failover runbook

1. **Confirm the primary is down** and not just slow: System health, `docker compose ps`, `docker logs fms_postgres`. Write down the time.
2. **Fail over:**

   ```sh
   sh scripts/dr/promote.sh
   ```

   It names the standby and how far behind it is, asks once, then: fences the old primary, promotes the standby, waits until `db-proxy:5432` reaches it and takes writes, waits until the API's `/health/ready` says its database is ok, and starts a full base backup. It prints the time each step took.
3. **Check:** a dispatcher saves something; the live map moves; System health is green except the read replica (there is no standby yet).
4. **Rejoin the old server** as the standby, once its host is back:

   ```sh
   sh scripts/dr/rejoin.sh            # pg_rewind; --rebuild copies it again instead
   ```

   It rewinds the old primary to the new timeline (or copies the primary again when that fails), makes it a standby streaming through the endpoint, removes the fence and starts it. Reporting reads use it again.
5. **Fail back** (optional, in a quiet hour): `sh scripts/dr/promote.sh` then `sh scripts/dr/rejoin.sh` again.
6. **Write it up:** what happened, the times, what was lost (normally nothing), and any gap found, filed as a card.

If the old primary's host cannot be reached to fence it, `promote.sh` stops and asks you to make sure it cannot come back (power it off, cut its network) before promoting.

## Game day

A failover and a point-in-time restore are rehearsed on staging before go-live, then every quarter.

```sh
sh scripts/dr/gameday.sh --failback      # 1,000 GPS positions through the API across a failover, then fail back
npm run backup:pitr -- --to "<10 minutes ago>" --name gameday   # and a point-in-time restore (backups.md)
```

`gameday.sh` installs a GPS device in a vehicle and sends 1,000 positions through `POST /tracking/gps-pings`, ten a request, retrying each 503 as `Retry-After` says. After 300 it runs `promote.sh`; when the sender is done, every position must be stored once. Then `rejoin.sh`, and with `--failback` the same back. It prints the times to record below. CI rehearses the same thing on every push without the API (`scripts/ci/check-failover.sh`: 1,000 rows written through the endpoint across a failover, the fence, the rejoin and a failback).

### Game day log

| Date | Where | Failover (service back) | API unavailable | Positions sent / stored | Old primary back as standby | Gaps found |
|---|---|---|---|---|---|---|
| 2026-11-24 | Development stack (10 GB database) | 9 s | 4.1 s | 1,000 / 1,000 | 15 s | The post-promotion backup failed until a checkpoint ran first (fixed in promote.sh); a check through the endpoint could hang in the second no server was up (fixed: HAProxy `timeout queue 5s`) |
| | Staging (before go-live) | | | | | |

## Open questions for the client

- How long do the telematics devices buffer positions while the API is unreachable? (The phone keeps up to about 55 hours; FMS answers 503 for seconds during a failover.)
- The RPO and RTO above, for sign-off.
- Who fills each role, and the contact list.

## Sign-off

| | Name | Date |
|---|---|---|
| Team | | |
| Advisor | | |

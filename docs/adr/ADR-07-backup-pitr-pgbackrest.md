# ADR-07: Continuous Archiving and Point-in-Time Recovery with pgBackRest

**Status:** Accepted
**Card:** FMS-108 (SE-152)
**Related:** System Design Draft §28.2 (database recovery) and §37 (backup and recovery), FMS-144 (nightly dumps, docs/backups.md), FMS-94 (read replica), FMS-162 (failover, SE-205)

## Context

The only backup was a nightly `pg_dump` at 02:40 (FMS-144). A disk lost at 02:30 lost almost a day of GPS points, trips and fuel logs, and a mistake could only be undone to last night. The card asks for continuous WAL archiving to encrypted storage, point-in-time restore to 10 minutes ago, and a documented RPO and RTO; the Wave 6 backlog adds an RPO under 1 minute and 14 days of point-in-time recovery.

The spike measured, on the dev stack (50 simulated vehicles, a GPS point every 2 s, 21 to 25 points per second accepted), over 5 minutes each, after the event cleanup below had finished:

| `wal_compression` | WAL written | Per minute | Per GPS point | Full-page images |
|---|---|---|---|---|
| `off` (the default until now) | 90.1 MB | 18.0 MB | 14.1 KB | 15,437 |
| `lz4` (chosen) | 38.0 MB | 7.6 MB | 5.1 KB | 11,904 |

Most of a GPS point's WAL is not the point itself (about 150 bytes): it is the event outbox (an insert and two updates), the consumers' `processed_events` row, the device's `last_seen_at` and the vehicle's current location.

The first runs were dominated by something else: after the stack had been down for two days, the outbox purge deleted gigabytes of old events in one statement and autovacuum then rewrote about 500,000 pages, writing 0.7 to 1.4 GB of WAL a minute for over 20 minutes; its next run deleted 13.25 million `processed_events` rows in one statement and wrote 15.9 GB in 5 minutes. Archiving copies that too. It is a one-off after downtime, but a backup design has to survive it, and the purge is filed to be batched (see Consequences).

## Decision

**pgBackRest** (2.60, from the PostgreSQL apt repository) runs in the database container (`docker/postgres/`):

- **Archiving:** `archive_mode=on`, `archive_command` = `pgbackrest archive-push`, asynchronous (a background process ships; writes never wait on the repository), and `archive_timeout=60`, so a segment is closed and shipped at least every minute. RPO under 1 minute.
- **WAL compression:** `wal_compression=lz4`, which cuts the WAL PostgreSQL writes in the first place (the table above); the archive is compressed again with zstd level 3 and encrypted with AES-256-CBC by pgBackRest.
- **Base backups:** a full one on the first start of a repository with none, then weekly (Sunday 01:00 Addis Ababa) and a differential one the other nights, scheduled in the container (`scheduler.sh`). Three fulls are kept: the oldest is 14 to 21 days old, so point-in-time recovery always reaches at least the 14 days required. Keeping four would double the WAL kept for no requirement.
- **Recording:** each base backup is a row in `backup.base_backups` (migration 075), written by the container's `backup.sh`; the API reads it. Archiving health is `pg_stat_archiver`, readable by SQL. The backup engine lives with the data; the app only watches it.
- **Restore:** `scripts/backup/pitr-restore.sh --to <time>` restores into a new volume and starts it as a separate, unpublished container. It never writes over the live database or the repository.
- **The nightly dump stays** (FMS-144): it restores one database into any PostgreSQL and can be downloaded.

### Alternatives

- **WAL-G:** the same capabilities, but no Debian package (a binary to download and pin), and differential backups and repository verification are less complete. pgBackRest installs from the same repository as PostgreSQL.
- **Plain `archive_command` (cp or aws s3 cp) plus `pg_basebackup`:** no compression, encryption, retention, parallel restore or verification without writing them ourselves.
- **More frequent `pg_dump`:** each dump reads the whole 10 GB database; hourly would still lose up to an hour and load the primary all day.
- **A managed database's point-in-time recovery:** the right choice if FMS moves to one (FMS-107 decides where production runs). This design moves with it: the scripts and runbook describe the same steps.

## Storage

Measured on the dev stack: the first full backup of the 10.1 GB database took 74 s and is 2 GB in the repository (zstd plus encryption, about 5 to 1); a differential one minutes later took 1.3 s and 197 kB. Archived WAL segments closed early by `archive_timeout` on a quiet database are mostly empty and shrink about 50 to 1. Busy WAL compresses less, so the table assumes 4 to 1 for it, from the measured rate:

| Fleet | GPS point every | Points per second | WAL per day (`lz4`) | Archive per day | Kept (21 days at most) |
|---|---|---|---|---|---|
| 50 vehicles | 2 s (the demo) | 25 | 11 GB | 2.7 GB | 57 GB |
| 500 vehicles | 10 s (the load test's rate) | 50 | 22 GB | 5.5 GB | 115 GB |

Plus three full backups of the database (10 GB today, 2 GB each in the repository) and the differentials. The archive per day is 5.1 KB per point times the points per day, divided by four. These are planning figures: night hours are quieter than this steady load, and a purge after long downtime adds a burst.

## Consequences

- The database image is built (`fms-postgres:16`), not pulled; `BACKUP_REPO_CIPHER_PASS` must be in `.env` (init-env adds it) and kept off the machine, or the backups are unreadable.
- RPO under 1 minute and RTO 2 hours for a mistake or a lost disk are documented in docs/backups.md. The restore itself is far inside that: on the dev stack, `pitr-restore.sh` restored the 10 GB database to a chosen second and opened it in about 1 minute; the 2 hours leave time to decide, check and switch over. CI's `docker-stack` job restores to a noted second and checks the rows on either side of it.
- The off-site repository is a second pgBackRest repository (`repo2`, any S3-compatible bucket in another region or provider), configured with pgBackRest's own `PGBACKREST_REPO2_*` settings in a git-ignored `docker/postgres/offsite.env`, so every pgBackRest command in the container, including `docker exec` ones, sees it. Measured with an S3 stand-in on the dev stack: the first full backup there took 2 min 3 s (10 GB to 2 GB); with the network to it cut, archiving failed while repo1 kept every segment, a critical alert was raised (repository unreachable after 3 minutes, archiving failing after 5); 14 s after the network came back, the 13 waiting segments had reached both; a restore from repo2 alone to a chosen second opened in 48 s.
- pgBackRest backs up to one repository per run, so `backup.sh` takes one per repository, and each base backup records the one it went to.
- The API never runs pgBackRest: the container records each repository once a minute (`status.sh`, `backup.pitr_repositories`), and the API reads that, `pg_stat_archiver` and the base backups for the Backups screen, System health's Backups component and the alerts (docs/backups.md#monitoring-and-alerts).
- The monthly drill restores the latest base backup into a scratch instance inside the database container and replays the WAL to a named restore point created in the same snapshot as the key tables' checksums, so the copy must match exactly; measured on the dev stack, it opened after 67 to 80 s with every key table identical. Failover to the replica is FMS-162 (SE-205).
- The outbox purge (`outboxStore.purge`) deletes in one statement. After downtime that is gigabytes in one transaction, a WAL burst the archive and the replica must absorb. It should delete in batches; filed as its own card.

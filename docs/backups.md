# Database backups (FMS-144)

An admin sees every database backup on **Backups** (S-30, `/backups`, Administration menu), starts one with **Back up now**, and downloads one. The app takes one itself every night. Restoring is a command, not a button, because it replaces the live data.

Code: `packages/backend/src/modules/backup/` (migration `056_database_backups.sql`), the screen in `packages/frontend/src/pages/Backups/`, the restore script `packages/backend/scripts/backup-restore.ts`.

## What a backup is

- `pg_dump` of the whole database in its **custom format, compressed** (`--format=custom --compress=6`): every schema, table, row, index, grant and the migration history. Restored with `pg_restore`.
- Taken by the API's runner, **one at a time**: every 4 hours, at 02:40, 06:40, 10:40, 14:40, 18:40 and 22:40 Addis Ababa time (six jobs, `database-backup-0240` to `database-backup-2240`, one per slot so each is locked and caught up on its own), and whenever an admin presses Back up now (`POST /system/backups`, which starts it at once in the background). A Back up now whose server stopped before it ran is picked up by the `backup-runner` job within 5 minutes; a run still marked running after 120 minutes (its server died) is marked failed.
- Written to a temporary file, hashed (SHA-256), then stored in the **backup storage**, the same adapter as uploaded documents (local disk `STORAGE_LOCAL_DIR` in development, the S3 bucket elsewhere), under `backups/<year>/<month>/<backup id>`. Never in PostgreSQL, never in the repository.
- Recorded in `backup.backups`: kind (scheduled or manual), status (`queued`, `running`, `succeeded`, `failed`, `expired`), who started it, when it started and finished, size, SHA-256, and for a failed one pg_dump's own error (any `password=` in it is masked).
- Kept **30 days**. The `backup-retention` job (03:55) removes older files; the row stays as `expired`, so the history is complete.
- Audited: `backup.requested`, `backup.succeeded`, `backup.failed` (result `failed`), `backup.downloaded` (by the admin who downloaded it), `backup.expired`.

A dump every 4 hours alone can lose up to 4 hours of GPS points, trips and fuel logs (a nightly one lost up to a day). Since FMS-108 (SE-152) the database also archives every change continuously and can be restored to any second: [Continuous archiving and point-in-time recovery](#continuous-archiving-and-point-in-time-recovery). The dumps stay: one restores into any PostgreSQL, and it can be downloaded.

## Who

`backup:read` (see the list, download) and `backup:write` (Back up now), both **admin only** (migration 056). Every other role gets `403`, and the menu has no Backups link for them.

## Setting it up

pg_dump has to read every table, and the app's own role (`fms_app`) may not (it cannot read `public.schema_migrations`, for one). So backups connect as:

1. `BACKUP_DB_USER` / `BACKUP_DB_PASSWORD`, when set. In production, create a role for it that can only read:
   ```sql
   CREATE ROLE fms_backup LOGIN;
   GRANT pg_read_all_data TO fms_backup;
   ```
   Then give it a generated password with psql's `\password fms_backup`, so the password is never written in a file or a shell history.
   Restores still need a role that can create databases (the schema owner).
2. Otherwise `DB_ADMIN_USER` / `DB_ADMIN_PASSWORD`, the schema owner. The Docker stack passes these to the backend already, so backups work there with no setup.
3. Neither set: the screen says backups are not set up, Back up now is off, and the nightly job does nothing.

The tools: the backend image installs `postgresql16-client` (`packages/backend/Dockerfile.dev`). Elsewhere pg_dump and pg_restore must be on `PATH`, or in `BACKUP_PG_BIN_DIR`, and be **16 or newer** (the server is PostgreSQL 16). For development on a machine without them, `BACKUP_PG_CONTAINER=<postgres container>` runs them in the database's container with `docker exec` (refused in production).

## Downloading

**Download** asks for a link (`POST /system/backups/{id}/download-link`), signed for that admin with a key derived from `JWT_SECRET` for this one purpose, alive 5 minutes. The browser then fetches the file (`GET /system/backups/{id}/content`), sent as an attachment named like `fms-fms_db-20261102-0240Z.dump`. Each download is audited as that admin. An expired or altered link is `401`. A downloaded backup holds every user's personal data: keep it encrypted and delete it when done.

Check a download against the SHA-256 on the screen:

```bash
sha256sum fms-fms_db-20261102-0240Z.dump        # Linux / Git Bash
Get-FileHash fms-fms_db-20261102-0240Z.dump     # PowerShell
```

## Restoring (runbook)

A restore never writes over the live database. It goes into a **new, empty** database; the app is then switched to it. The old one stays until you drop it, so a bad restore costs nothing.

1. **Pick the backup.** On the Backups screen, the newest *Succeeded* one from before the problem. Copy its id (`GET /system/backups` shows it), or use `latest`.
2. **Restore into a new database** (in the backend container: `docker compose exec backend sh`):
   ```bash
   npm run backup:restore -- --backup <backup id> --database fms_restored
   ```
   The script fetches the file from the backup storage, **checks its SHA-256** against the record (a damaged file stops here), creates the database (or uses an existing empty one; one with tables is refused), runs `pg_restore --exit-on-error`, and says how many tables it restored. It refuses the live database's name.
   To restore a downloaded file instead: `createdb fms_restored`, then `pg_restore --exit-on-error -d fms_restored <file>.dump` as the schema owner.
3. **Check it.** Connect to `fms_restored` and look at what you came back for: recent trips, users, `SELECT max(applied_at) FROM public.schema_migrations`.
4. **Switch the app.** Stop the API, set `DB_NAME=fms_restored` (and the replica, if any, must be rebuilt from the new primary: [read-replica.md](read-replica.md)), start the API. Run `npm run migrate` if the backup predates migrations the code expects.
5. **Rebuild derived data** the restore may have left behind events for: the read models are rebuilt with `rebuildReadModels()` (the seed does this; see `packages/backend/src/modules/index.ts`).
6. Keep the old database until you are sure, then `DROP DATABASE`.

## Restore drills

A backup is only proven once it restores. A drill restores one into a scratch database, records the result in `backup.restore_drills`, and drops the scratch database:

```bash
npm run backup:restore -- --backup latest --database fms_drill --drill --by "Sara (monthly drill)"
```

The Backups screen shows the last drill (when, how many tables, or why it failed), and warns when there has been none. The monthly drill of point-in-time recovery is the database container's ([below](#restore-drills-monthly)).

## Continuous archiving and point-in-time recovery

FMS-108 (SE-152), decided in [ADR-07](adr/ADR-07-backup-pitr-pgbackrest.md). The database container runs [pgBackRest](https://pgbackrest.org) 2.60 beside PostgreSQL (`docker/postgres/`), so at most a minute of changes is ever only on the database's disk, and the database can be restored to any second it still has backups for.

| What | When | Kept |
|---|---|---|
| WAL (every change) | Continuously, compressed (zstd) and encrypted (AES-256). PostgreSQL closes a segment at least every 60 s (`archive_timeout`), so a quiet database still ships its last changes within a minute | With the base backups it belongs to |
| Full base backup | On the first start of a database with none, then Sundays at 01:00 Addis Ababa time (`BACKUP_BASE_HOUR_UTC`, default 22) | The last 3 (`repo1-retention-full`): the oldest is 14 to 21 days old, so a restore always reaches at least 14 days back |
| Differential base backup | Every other day at the same time: what changed since the last full one | Until their full one expires |
| `pg_dump` (above) | Every 4 hours from 02:40 | 30 days (180 files) |

- **Where.** The repository is its own volume, `pgbackrest_repo`, so losing the database volume does not lose the backups. A second repository off site, in another region or provider, takes every segment and base backup too ([below](#off-site-repository)). In production `repo1` is an S3 bucket as well.
- **Recorded.** Each base backup is a row in `backup.base_backups` (migrations 075, 076): full or differential, what started it, the repository it went to (pgBackRest backs up to one at a time, so `backup.sh` takes one per repository), its status, its size in the database and in the repository, the WAL range it needs, and pgBackRest's error when it failed. A backup pgBackRest expired is kept as `expired`. Once a minute the container's `status.sh` records each repository in `backup.pitr_repositories`: reachable or not and since when, the WAL range it holds and when its newest segment arrived, and its base backups. The container's scripts write these rows; the API only reads them.
- **Asynchronous.** `archive-push` hands a segment to a background process and returns, so a slow repository never slows writes. Until a segment is shipped it waits in the spool and in `pg_wal`.

### Targets

| Event | Data lost at most (RPO) | Back in service (RTO) | How |
|---|---|---|---|
| Data deleted or damaged by mistake, or a bad migration | None: restore to the second before | 2 h | Point-in-time restore (below) |
| Database disk or volume lost | Under 1 minute (`archive_timeout`) | 2 h | Point-in-time restore to the latest archived WAL |
| The whole server or site lost | Under 1 minute: the off-site copy is alerted on at 15 minutes behind | 4 h | The same, from the off-site repository on a new server (`--repo 2`) |

Measured on the development stack (10 GB database): a restore to a chosen second opened in about 1 minute from the repository beside it, and in 48 s from the off-site one; the monthly drill opened in 67 to 80 s.

The replica (FMS-94) is seconds behind and can be promoted faster still; that runbook is FMS-162 (SE-205).

### Setting it up

1. **The passphrase.** `BACKUP_REPO_CIPHER_PASS` in `.env` encrypts the repository. `node scripts/init-env.mjs` adds it to an existing `.env` and keeps every other value. Without it the database does not start, so an unencrypted backup is never written. **Keep a copy away from this machine:** every backup is unreadable without it, and changing it makes the earlier ones unreadable.
2. **The image.** `docker compose up -d --build postgres` builds `fms-postgres:16` from `docker/postgres/Dockerfile` (PostgreSQL 16 plus pgBackRest from the PostgreSQL apt repository). On Docker Desktop for Windows, if Compose asks for `--allow=fs.read`, build it directly: `docker build -t fms-postgres:16 docker/postgres`.
3. **An existing database** works as it is. On start, the container creates pgBackRest's stanza (idempotent) and, when the repository is empty, takes a first full backup; WAL waiting in `pg_wal` is archived once the stanza exists.

### Checking it

```sh
docker compose exec -u postgres postgres pgbackrest --stanza=fms info          # backups and the WAL range held
docker compose exec postgres psql -U fms_admin -d fms_db -c "select archived_count, last_archived_wal, last_archived_time, failed_count, last_failed_time from pg_stat_archiver"
docker compose exec postgres psql -U fms_admin -d fms_db -c "select backup_type, status, started_at, finished_at, pg_size_pretty(repo_size_bytes) from backup.base_backups order by started_at desc limit 5"
docker compose exec -u postgres postgres /usr/local/bin/fms-pgbackrest/backup.sh full manual   # a backup now
```

`failed_count` rising, or `last_archived_time` older than a few minutes on a busy database, means archiving is failing: read `/var/log/pgbackrest/` in the container. While it fails, WAL piles up in `pg_wal` on the database's disk.

### Point-in-time restore (runbook)

Like the dump restore, it never writes over the live database.

1. **Pick the moment.** The second before the mistake, with its time zone: `2026-11-24 10:14:59+03`. The audit log (S-10) usually tells when it happened.
2. **Restore into a copy.**
   ```sh
   npm run backup:pitr -- --to "2026-11-24 10:14:59+03" --name before-mistake
   ```
   (the same as `sh scripts/backup/pitr-restore.sh ...`; add `--repo 2` to restore from the off-site repository when this site's is lost.) It restores the latest base backup taken before that moment into a new volume (`fms_pitr_before-mistake_data`), replays the archived WAL up to it, and starts the result as `fms_pitr_before-mistake`, on the stack's network and published nowhere. It prints the last transaction replayed. The repository is mounted read-only, and the copy runs without archiving, so it changes nothing that exists.
3. **Check it.** `docker exec -it fms_pitr_before-mistake psql -U fms_admin -d fms_db`: the rows you came back for are there, and the mistake is not.
4. **Switch over** (a planned outage):
    1. Stop the API, and the old database: `docker compose stop backend postgres`.
    2. Copy the restored data into the database volume, or point `postgres_data` at the restored volume.
    3. Start the database. Archiving resumes on its new timeline, which pgBackRest keeps apart from the old one.
    4. Take a full backup at once (`backup.sh full manual`, above), rebuild the replica ([read-replica.md](read-replica.md#in-compose)), and start the API.
5. **Remove the copy** when you no longer need it: `docker rm -f fms_pitr_before-mistake && docker volume rm fms_pitr_before-mistake_data`.

To copy only some rows back instead of switching, read them from the copy and insert them into the live database.

### Off-site repository

A second pgBackRest repository, `repo2`, in another region or with another provider, so losing the site does not lose the backups. It is configured with pgBackRest's own settings in `docker/postgres/offsite.env`, which git ignores (start from [`offsite.env.example`](../docker/postgres/offsite.env.example)); Compose reads it when it exists. Then recreate the database container (`docker compose up -d postgres`):

- Every WAL segment goes to both repositories as it is archived. If one is unreachable, the other still gets every segment, but archiving reports a failure and PostgreSQL keeps the segment until both have it; once the network is back, the waiting segments go out together (measured: 13 segments within 14 s).
- On its first start with the new repository, the container takes a full base backup to it (measured: the 10 GB database became 2 GB in 2 min 3 s); after that, every night's backup goes to both.
- **The bucket** has S3 Object Lock in compliance mode, 30 days by default, so nothing written can be deleted or changed for 30 days, not even with these credentials. Its **access key may read, list and write, never delete**: retention there (35 days of full backups, `PGBACKREST_REPO2_RETENTION_FULL`) only stops pgBackRest listing old files, and the bucket's lifecycle rule deletes them after the lock.
- **Its passphrase** (`PGBACKREST_REPO2_CIPHER_PASS`) is its own, not repo1's.
- Restore from it with `npm run backup:pitr -- --to "<time>" --repo 2`.

CI adds a stand-in (SeaweedFS's S3 API) to the stack, checks that a segment reaches both repositories within 60 s, cuts the network to it, and checks that archiving fails while repo1 keeps every segment and catches up once the network is back (`scripts/ci/check-offsite.sh`).

### On the Backups screen

The *Point-in-time recovery* section of the Backups screen (S-30) answers whether the database can be restored, and how far back:

- **Recoverable to any second** from the oldest base backup's end to the last segment archived (to the second, Addis Ababa time), across both repositories; per repository too.
- A verdict: *Protected*, *Needs attention*, *At risk* (a critical finding), or *Not set up* (a database that does not archive).
- **What puts recovery at risk**, critical first, each with since when and how administrators are told.
- **Archiving** (last segment archived, or failing since when), **Copies** (each repository, reachable or not, its base backups, whether encrypted; a warning when there is no off-site copy), and the **last restore drill** (when, how long the restore took, how many key tables matched).
- **Base backups**, newest first: when, weekly full or nightly differential, the repository, the status, the database's size and what it added to the repository.

The API: `GET /system/backups` returns this in `meta.pitr`, and `GET /system/base-backups` lists the base backups (backup:read, admin).

### Monitoring and alerts

The API's `backup-monitor` job checks every minute, and System health's **Backups** component is down while any of these holds (it shows the most severe):

| Condition | When | Alert |
|---|---|---|
| Archiving failing | Every attempt has failed for more than 5 minutes, since the last success | Critical |
| Repository unreachable | pgBackRest cannot read a repository for more than 3 minutes (a cut network to the off-site one is alerted on within about 4) | Critical |
| Off-site copy behind | The off-site repository lacks the last segment archived, and its newest one is more than 15 minutes old | Critical |
| Status not reported | The container has not recorded the repositories for 10 minutes (its status loop is not running) | High |
| No recent base backup | None has succeeded for 26 hours (a night's backup missed) | High |
| Restore drill failed | The last drill failed | High |
| Restore drill overdue | None has passed for 35 days (counted from the oldest base backup while none has) | High |

Each raises one `BackupAtRisk` event, so one alert for administrators ([alerts.md](alerts.md)): critical ones by email, SMS and push, high ones by push. A risk that goes on is not raised again; one that clears and comes back is a new alert. Nothing is raised on a database that does not archive (the thresholds are in `src/modules/backup/domain/pitr.ts`, and become settings with FMS-157).

### Restore drills (monthly)

After the night's base backup, when no point-in-time drill has passed in 30 days, the container runs `drill.sh` (`DRILL_SCHEDULE=off` turns it off). Run one by hand with `npm run backup:drill`.

1. On the live database, in one snapshot: a named restore point, and the rows and a checksum of each key table (`DRILL_TABLES`: users, roles, depots, vehicles, drivers, trips, fuel logs, maintenance records). The WAL is switched so the restore point reaches the repository.
2. The latest base backup is restored into a scratch directory in the container, and a second PostgreSQL there replays the archived WAL up to the restore point. It listens only on its own socket, without archiving, and writes nothing to the live database's files or to the repository.
3. Once it opens, every key table must have the same rows and checksum as the live one had at the restore point. The time from the start of the restore to the database opening is the drill's RTO, held to 2 hours.
4. The scratch instance is removed, and the drill recorded in `backup.restore_drills` (`method` `pitr`, migration 076): the base backup, the restore point, the RTO, and each table's rows and whether it matched. A failed drill is an alert and is tried again the next night.

It needs as much free disk as the database takes. Measured on the development stack: the 10 GB database opened after 80 s, all key tables identical. CI runs a drill on every push (`scripts/ci/check-pitr.sh`).

### Who holds the keys

The two passphrases (`BACKUP_REPO_CIPHER_PASS`, and repo2's) are each held by two named people, outside the servers, in the client's password manager; who they are is recorded with the client at handover (FMS-161). The off-site access key cannot delete. pgBackRest connects to the database as `fms_admin`, the schema owner, over the container's own socket (never the network).

### Not covered yet

- The production buckets, their Object Lock and lifecycle rule, and the environments they belong to: FMS-107 (SE-151).
- Keeping one nightly dump a month for 12 months (dumps are kept 30 days).
- A database role for pgBackRest with only what a backup needs (`pg_read_all_settings`, the backup and WAL functions) instead of `fms_admin`.
- The thresholds as settings parameters: FMS-157.

## Tests

Point-in-time recovery: `src/modules/backup/domain/pitr.test.ts` (each alert condition and its threshold, the recoverable range), `test/integration/pitr.test.ts` (the API's `meta.pitr` and base backups, one alert per risk, System health's Backups component), the Backups screen's tests, and in CI `scripts/ci/check-pitr.sh` (a restore to a noted second, and a drill) and `scripts/ci/check-offsite.sh` (the off-site repository).

`packages/backend/test/integration/database-backups.test.ts` takes a real backup through the API, downloads it and checks its SHA-256, restores it into an empty database as a drill, records a failed dump with pg_dump's error, expires one past retention, and checks that only admins get in. It needs pg_dump and pg_restore 16+ on the machine (CI's Ubuntu runner has them), or `BACKUP_PG_CONTAINER=fms-test-postgres` locally. Unit tests: `src/modules/backup/domain/backup.test.ts`. Screen: `src/pages/Backups/BackupsPage.test.tsx`.

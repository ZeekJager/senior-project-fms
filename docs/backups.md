# Database backups (FMS-144)

An admin sees every database backup on **Backups** (S-30, `/backups`, Administration menu), starts one with **Back up now**, and downloads one. The app takes one itself every night. Restoring is a command, not a button, because it replaces the live data.

Code: `packages/backend/src/modules/backup/` (migration `056_database_backups.sql`), the screen in `packages/frontend/src/pages/Backups/`, the restore script `packages/backend/scripts/backup-restore.ts`.

## What a backup is

- `pg_dump` of the whole database in its **custom format, compressed** (`--format=custom --compress=6`): every schema, table, row, index, grant and the migration history. Restored with `pg_restore`.
- Taken by the API's runner, **one at a time**: nightly at 02:40 (job `database-backup`) and whenever an admin presses Back up now (`POST /system/backups`, which starts it at once in the background). A Back up now whose server stopped before it ran is picked up by the `backup-runner` job within 5 minutes; a run still marked running after 120 minutes (its server died) is marked failed.
- Written to a temporary file, hashed (SHA-256), then stored in the **backup storage**, the same adapter as uploaded documents (local disk `STORAGE_LOCAL_DIR` in development, the S3 bucket elsewhere), under `backups/<year>/<month>/<backup id>`. Never in PostgreSQL, never in the repository.
- Recorded in `backup.backups`: kind (scheduled or manual), status (`queued`, `running`, `succeeded`, `failed`, `expired`), who started it, when it started and finished, size, SHA-256, and for a failed one pg_dump's own error (any `password=` in it is masked).
- Kept **30 days**. The `backup-retention` job (03:55) removes older files; the row stays as `expired`, so the history is complete.
- Audited: `backup.requested`, `backup.succeeded`, `backup.failed` (result `failed`), `backup.downloaded` (by the admin who downloaded it), `backup.expired`.

FMS-108 (SE-152) builds on this runner: the off-site copy, WAL archiving for point-in-time recovery, and scheduled restore drills.

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

The Backups screen shows the last drill (when, how many tables, or why it failed), and warns when there has been none. FMS-108 runs them on a schedule.

## Tests

`packages/backend/test/integration/database-backups.test.ts` takes a real backup through the API, downloads it and checks its SHA-256, restores it into an empty database as a drill, records a failed dump with pg_dump's error, expires one past retention, and checks that only admins get in. It needs pg_dump and pg_restore 16+ on the machine (CI's Ubuntu runner has them), or `BACKUP_PG_CONTAINER=fms-test-postgres` locally. Unit tests: `src/modules/backup/domain/backup.test.ts`. Screen: `src/pages/Backups/BackupsPage.test.tsx`.

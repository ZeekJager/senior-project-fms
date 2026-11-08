# Driver data protection (FMS-104)

Architecture §24.3: where a driver was, how they drove and the numbers that identify them are restricted in the
data-access logic, not only in the screens. Four things hold that line.

| What | How | Where |
|---|---|---|
| Who looked at a driver's location | Every page of a vehicle's GPS history is audited; a refused attempt is audited too | `tracking.history_read`, `access.denied` |
| How long location data is kept | A nightly job deletes older GPS pings and telemetry flags | `tracking-retention`, `GPS_PING_RETENTION_DAYS`, `TELEMETRY_FLAG_RETENTION_DAYS` |
| Licence and phone numbers at rest | Encrypted in PostgreSQL with `pgcrypto` | migration 063, `DATA_ENCRYPTION_KEY` |
| A person's own data | A JSON download of everything held about the caller | `GET /auth/me/data-export` |

## Who looked at where a vehicle was

`GET /vehicles/{id}/tracking` needs `tracking:read` and the vehicle in the caller's depot scope (another depot's vehicle is
`404`). Every page read writes `tracking.history_read` on the vehicle: who, when, the period, how many points, and whether it
continued a cursor. A caller without `tracking:read` gets `403` and an `access.denied` entry naming the route and the permission it
needed (`audit.audit_logs`, result `denied`); no read is recorded because nothing was read. The audit log is read at `GET /audit-logs`.

## Retention of location data

A job, `tracking-retention`, runs daily at 03:20 (Addis Ababa) and deletes:

- GPS pings recorded more than `GPS_PING_RETENTION_DAYS` ago (default **180**);
- telemetry flags observed more than `TELEMETRY_FLAG_RETENTION_DAYS` ago (default **365**).

Both settings are whole days, at least 30 (the history screen reads up to 30 days back) and at most 3650. They are environment
settings (`.env.example`), not screen settings: a retention period is a policy, changed with the deployment. Deletes run in
batches of 5,000 rows, up to 1,000,000 a night per table, so one run never holds a long lock; a larger backlog is cleared over
the next nights. The run's audit entry has the counts and the cutoffs, never a position. A vehicle's *current* position
(`tracking.vehicle_current_location`) is not a history and is not touched.

Not covered, by decision: the audit log itself (the open question of CFG-4 is whether it is purged after 5 years or kept), and
trips, fuel logs and attendance, which are business records (see below for how a person gets a copy).

## Licence and phone numbers at rest

Encrypted columns: `fleet.drivers.license_number`, `fleet.drivers.emergency_phone` and `auth.users.phone`.

- **How.** `pgcrypto` (AES-256, OpenPGP symmetric) through three functions in the `privacy` schema: `encrypt_text`, `decrypt_text`
  and `blind_index`. A value is stored as `enc:v1:<base64>`; the same text encrypts differently every time.
- **The key.** `DATA_ENCRYPTION_KEY` (at least 32 characters). The application gives every database connection the key as the
  session setting `fms.data_key` (`src/shared/infrastructure/data-key.ts`); the database never stores it. A copy of the database
  or of a backup (`pg_dump` holds ciphertext) cannot be read without it, and a connection without the key gets error `55000` instead
  of data. The setting is sent as a bind parameter; keep PostgreSQL's `log_statement` below `all` and do not log bind parameters
  in production, or the key reaches the log.
- **Writes need no change.** `BEFORE INSERT OR UPDATE` triggers on `fleet.drivers` and `auth.users` encrypt the columns, so every
  write path (the API, the import, the seed, a script) is covered, and the audit trail records the ciphertext, not the number.
- **Reads decrypt in SQL** (`privacy.decrypt_text(column)`), so searching by part of a licence number and sorting by it work as before.
  A value stored before migration 063 passes through unchanged, so nothing breaks while a row waits to be encrypted.
- **Uniqueness.** Random ciphertext cannot be unique. `license_number_idx` holds an HMAC-SHA256 of the number under the key (a
  blind index), and `ux_drivers_license_number_idx` is unique on it: the same number, however it is stored, is still `409
  CONFLICT_DUPLICATE_LICENSE`. The index leaks only that two numbers are equal, and is useless without the key.
- **Existing data.** Migration 063 encrypts the rows already there, in place. If there are any, the session that runs it needs the
  key: `npm run migrate` takes it from `DATA_ENCRYPTION_KEY`; with `psql`, `SET fms.data_key = '...'` first (the bundle file the same).
  Without it the migration stops with the database's message and changes nothing. Its Down decrypts the data again.

### Operating it

- **Lose the key and the encrypted numbers are gone.** Keep it in the secret store, with a copy held apart from the database backups.
- **Changing the key** makes existing values unreadable until they are re-encrypted. There is no rotation tool yet: to rotate, run
  migration 063's Down with the old key (plain text), set the new key, and run its Up again. Do it in a maintenance window.
- **Restoring a backup** (docs/backups.md) needs no key to restore; reading the restored data needs the same `DATA_ENCRYPTION_KEY`.
- **Not encrypted:** emails and names (needed to sign in and to search), and anything in the audit log written before migration 063,
  which is immutable.

## A person's own data

`GET /auth/me/data-export`, for any signed-in user, returns the caller's own data as a JSON download (`Content-Disposition:
attachment`, `Cache-Control: no-store`). There is no id in the path or the query: nobody can ask for someone else's.

It holds: the account (never the password hash or sessions); and for a driver the licence and phones, vehicle assignments, attendance,
inspections, trips, fuel logs, incident reports (about them or filed by them) and the GPS points recorded on their trips: the newest
50,000, `truncated: true` if there were more, reaching back as far as the retention period (`retention_days`). Vehicles and trips
appear by public id (a vehicle also by its plate). The privacy module owns no schema; it reads the other modules through their
`index.ts`. Every export is audited as `privacy.data_exported` with counts only.

Not in it: other people's data that mentions the person (a colleague's note), and system records about the person's account
(login history, audit entries).

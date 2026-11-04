import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Client } from 'pg';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { DocumentStorage } from '../../../shared/storage/document-storage';
import { dumpError } from '../domain/backup';
import type { BackupRepository } from '../infrastructure/backup.repository';
import type { DbTarget, PgTools } from '../infrastructure/pg-tools';

/** A database name the restore may create: plain lowercase, never quoted into anything odd. */
const DATABASE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export interface RestoreDeps {
  db: Queryable;
  backups: BackupRepository;
  storage: DocumentStorage;
  tools: PgTools;
  /** The live database and the role that dumps it; the restore creates its target database as this role. */
  live: DbTarget;
  now?: () => Date;
}

export interface RestoreOptions {
  /** The backup's public id. */
  backupId: string;
  /** A database that does not exist yet, or exists and is empty. Never the live one. */
  database: string;
  /** A drill: record it in backup.restore_drills, and drop the database afterwards. */
  drill: boolean;
  /** Who ran it, for the drill's record (a person's name, or the job). */
  runBy: string;
}

export interface RestoreResult {
  database: string;
  tables: number;
  checksum: string;
}

/**
 * Restores a backup into a new, empty database (FMS-144, docs/backups.md): never over the live one, which an
 * operator switches to by pointing DB_NAME at the restored database. Checks the file's SHA-256 against the
 * backup's record before pg_restore runs. A drill (FMS-108) is recorded either way and its database dropped.
 */
export async function restoreBackup(deps: RestoreDeps, options: RestoreOptions): Promise<RestoreResult> {
  const now = () => deps.now?.() ?? new Date();
  const { database } = options;
  if (!DATABASE_NAME.test(database)) throw new Error(`'${database}' is not a database name this restore will create: lowercase letters, digits and _.`);
  if (database === deps.live.database) throw new Error(`Refusing to restore over the live database '${database}'. Restore into a new one, then point DB_NAME at it.`);
  const row = await deps.backups.find(deps.db, options.backupId);
  if (!row) throw new Error(`No backup ${options.backupId}.`);
  if (row.status !== 'succeeded') throw new Error(`Backup ${options.backupId} is ${row.status}: it has no file to restore.`);

  const startedAt = now();
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fms-restore-'));
  const file = path.join(dir, 'backup.dump');
  let created = false;
  try {
    await pipeline(await deps.storage.get(row.storageKey!), createWriteStream(file, { flags: 'wx', mode: 0o600 }));
    const hash = createHash('sha256');
    await pipeline(createReadStream(file), hash);
    const checksum = hash.digest('hex');
    if (checksum !== row.checksum) throw new Error(`The file's SHA-256 is ${checksum}, not the ${row.checksum} recorded when it was taken: it is damaged.`);

    created = await createEmptyDatabase(deps.live, database);
    await deps.tools.restore({ ...deps.live, database }, file);
    const tables = await countTables({ ...deps.live, database });
    if (options.drill) {
      await deps.backups.recordDrill(deps.db, {
        backupId: row.id,
        targetDatabase: database,
        status: 'succeeded',
        startedAt,
        finishedAt: now(),
        tablesRestored: tables,
        error: null,
        runBy: options.runBy,
      });
    }
    return { database, tables, checksum };
  } catch (err) {
    if (options.drill) {
      await deps.backups.recordDrill(deps.db, {
        backupId: row.id,
        targetDatabase: database,
        status: 'failed',
        startedAt,
        finishedAt: now(),
        tablesRestored: null,
        error: dumpError(err instanceof Error ? err.message : String(err), 'The restore failed.'),
        runBy: options.runBy,
      });
    }
    throw err;
  } finally {
    await rm(dir, { recursive: true, force: true });
    if (options.drill && created) await dropDatabase(deps.live, database);
  }
}

async function withClient<T>(target: DbTarget, database: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ host: target.host, port: target.port, user: target.user, password: target.password, database });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Creates the database, or accepts an existing empty one; refuses one with tables. True when it created it. */
async function createEmptyDatabase(live: DbTarget, database: string): Promise<boolean> {
  const exists = await withClient(live, 'postgres', async (c) => (await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [database])).rowCount! > 0);
  if (exists) {
    const tables = await countTables({ ...live, database });
    if (tables > 0) throw new Error(`Database '${database}' already has ${tables} tables: restore into an empty one.`);
    return false;
  }
  // The name passed DATABASE_NAME, so quoting it is enough.
  await withClient(live, 'postgres', (c) => c.query(`CREATE DATABASE "${database}"`));
  return true;
}

async function dropDatabase(live: DbTarget, database: string): Promise<void> {
  await withClient(live, 'postgres', (c) => c.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`));
}

/** Tables outside PostgreSQL's own schemas. */
async function countTables(target: DbTarget): Promise<number> {
  return withClient(target, target.database, async (c) => {
    const res = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.tables
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND table_type = 'BASE TABLE'`,
    );
    return res.rows[0].n;
  });
}

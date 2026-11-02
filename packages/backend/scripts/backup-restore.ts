/**
 * Restores a database backup (FMS-144, docs/backups.md) into a new, empty database. Never over the live one:
 * an operator switches the app to the restored database by pointing DB_NAME at it and restarting.
 *
 *   npm run backup:restore -- --backup <backup id> --database fms_restored
 *   npm run backup:restore -- --backup latest --database fms_drill --drill
 *
 * The file's SHA-256 is checked against the backup's record first. With --drill the restore is recorded in
 * backup.restore_drills (the Backups screen shows the last one) and its database dropped afterwards.
 */
import { parseArgs } from 'node:util';
import { pool } from '../src/db';
import { restoreBackup, restoreDeps } from '../src/modules/backup';
import { closeRedis } from '../src/shared/cache';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { backup: { type: 'string' }, database: { type: 'string' }, drill: { type: 'boolean', default: false }, by: { type: 'string' } },
  });
  if (!values.backup || !values.database) throw new Error('Usage: npm run backup:restore -- --backup <id|latest> --database <new database> [--drill]');
  const deps = restoreDeps();
  if (!deps) throw new Error('No credentials for pg_restore: set BACKUP_DB_USER/BACKUP_DB_PASSWORD or DB_ADMIN_USER/DB_ADMIN_PASSWORD.');
  let backupId = values.backup;
  if (backupId === 'latest') {
    const res = await pool.query<{ id: string }>(`SELECT public_id AS id FROM backup.backups WHERE status = 'succeeded' ORDER BY finished_at DESC LIMIT 1`);
    if (!res.rows[0]) throw new Error('No succeeded backup to restore.');
    backupId = res.rows[0].id;
  }
  console.log(`Restoring backup ${backupId} into '${values.database}'${values.drill ? ' (drill)' : ''}…`);
  const result = await restoreBackup(deps, { backupId, database: values.database, drill: values.drill, runBy: values.by ?? 'npm run backup:restore' });
  console.log(`[✅ RESTORED] ${result.tables} tables into '${result.database}' (SHA-256 ${result.checksum} checked).`);
  if (values.drill) console.log('The drill is recorded and its database dropped.');
  else console.log(`To use it: set DB_NAME=${result.database} and restart the API (docs/backups.md).`);
}

main()
  .catch((err: unknown) => {
    console.error(`[❌ FAILED] ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => Promise.all([pool.end(), closeRedis()]));

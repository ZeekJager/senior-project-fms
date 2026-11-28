import { config } from '../../config';
import { pool } from '../../db';
import { eventBus } from '../../shared/events/event-bus';
import { logger } from '../../shared/logging/logger';
import type { JobContext } from '../../shared/jobs/job';
import type { AppModule } from '../../shared/module';
import { createDocumentStorage } from '../../shared/storage/document-storage';
import { userDirectory } from '../auth';
import { backupRouter } from './api/backup.routes';
import { BackupService } from './application/backup.service';
import { PitrService } from './application/pitr.service';
import type { RestoreDeps } from './application/restore';
import { SCHEDULED_BACKUP_TIMES, scheduledBackupJobName } from './domain/backup';
import { BackupLinkSigner } from './domain/backup-link';
import { BackupRepository } from './infrastructure/backup.repository';
import { pgClientTools } from './infrastructure/pg-tools';

// Database backups (FMS-144, docs/backups.md): pg_dump into the backup storage, as the role in config.backup.
const credentials = config.backup.credentials;

export const backupService = new BackupService({
  db: pool,
  backups: new BackupRepository(pool),
  storage: createDocumentStorage(config.storage),
  tools: pgClientTools({ binDir: config.backup.binDir, container: config.backup.container }),
  links: new BackupLinkSigner(config.jwtSecret),
  target: credentials ? { host: config.db.host, port: config.db.port, database: config.db.database, ...credentials } : null,
  users: userDirectory,
  log: logger,
  // Tests run the queue themselves (backupService.drain()), so no dump outlives its test.
  autoStart: config.nodeEnv !== 'test',
});

/** Point-in-time recovery (FMS-108): what the database container records, read for the screen, health and alerts. */
export const pitrService = new PitrService({ db: pool, backups: new BackupRepository(pool), events: eventBus });

export const backupModule: AppModule = {
  name: 'backup',
  router: backupRouter(backupService, pitrService),
  jobs: [
    {
      // FMS-108: an alert for administrators when recovery is at risk (archiving failing, a repository unreachable or
      // behind, no base backup in 26 h, a drill failed or overdue): once per risk, not every minute.
      name: 'backup-monitor',
      every: 1,
      run: (context) => pitrService.monitor(context.correlationId),
    },
    // Every 4 hours from 02:40: one daily job per slot. Point-in-time recovery (FMS-108) is the database
    // container's: base backups, WAL. A slot whose backup finds another running is skipped (one at a time).
    ...SCHEDULED_BACKUP_TIMES.map((at) => ({
      name: scheduledBackupJobName(at),
      at,
      leaseMs: 2 * 60 * 60 * 1000,
      run: (context: JobContext) => backupService.scheduled(context.correlationId),
    })),
    {
      // A Back up now whose instance stopped before it ran, and runs left running by a dead instance.
      name: 'backup-runner',
      every: 5,
      leaseMs: 2 * 60 * 60 * 1000,
      run: () => backupService.runQueue(),
    },
    {
      // Files past BACKUP_RETENTION_DAYS (30) are removed; their rows stay, as expired.
      name: 'backup-retention',
      at: '03:55',
      run: (context) => backupService.expire(context.correlationId),
    },
  ],
};

/** For scripts/backup-restore.ts and the tests: restore a backup into a new database (docs/backups.md). */
export function restoreDeps(): RestoreDeps | null {
  if (!credentials) return null;
  return {
    db: pool,
    backups: new BackupRepository(pool),
    storage: createDocumentStorage(config.storage),
    tools: pgClientTools({ binDir: config.backup.binDir, container: config.backup.container }),
    live: { host: config.db.host, port: config.db.port, database: config.db.database, ...credentials },
  };
}
export { restoreBackup, type RestoreDeps } from './application/restore';

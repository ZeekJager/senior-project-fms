import { config } from '../../config';
import { pool } from '../../db';
import { logger } from '../../shared/logging/logger';
import type { AppModule } from '../../shared/module';
import { createDocumentStorage } from '../../shared/storage/document-storage';
import { userDirectory } from '../auth';
import { backupRouter } from './api/backup.routes';
import { BackupService } from './application/backup.service';
import type { RestoreDeps } from './application/restore';
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

export const backupModule: AppModule = {
  name: 'backup',
  router: backupRouter(backupService),
  jobs: [
    {
      // Nightly, before the day's work (FMS-108 adds the off-site copy and WAL archiving).
      name: 'database-backup',
      at: '02:40',
      leaseMs: 2 * 60 * 60 * 1000,
      run: (context) => backupService.scheduled(context.correlationId),
    },
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

import { reads } from '../../db';
import type { AppModule } from '../../shared/module';
import { userDirectory } from '../auth';
import { auditLogRouter } from './api/audit-log.routes';
import { AuditLogService } from './application/audit-log.service';
import { AuditLogRepository, type RecordChange } from './infrastructure/audit-log.repository';
import type { Queryable } from '../../shared/infrastructure/queryable';

// Writing the trail is platform code (src/shared/infrastructure/audit-log.ts);
// this module reads it (FMS-28), from the read replica when it is up (FMS-94).
const logs = new AuditLogRepository();
const auditLogService = new AuditLogService({ reads, logs, users: userDirectory });

/**
 * The trail of particular records, for a module's own history of them (the settings parameters' history panel,
 * FMS-157): their successful changes, newest first, at most `limit`. Read on the caller's connection.
 */
export const auditTrail = {
  records: (db: Queryable, entityType: string, entityIds: readonly string[], limit = 200): Promise<RecordChange[]> =>
    logs.records(db, entityType, entityIds, limit),
};
export type { RecordChange };

export const auditModule: AppModule = { name: 'audit', router: auditLogRouter(auditLogService) };

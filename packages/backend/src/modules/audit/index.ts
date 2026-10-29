import { reads } from '../../db';
import type { AppModule } from '../../shared/module';
import { userDirectory } from '../auth';
import { auditLogRouter } from './api/audit-log.routes';
import { AuditLogService } from './application/audit-log.service';
import { AuditLogRepository } from './infrastructure/audit-log.repository';

// Writing the trail is platform code (src/shared/infrastructure/audit-log.ts);
// this module reads it (FMS-28), from the read replica when it is up (FMS-94).
const auditLogService = new AuditLogService({ reads, logs: new AuditLogRepository(), users: userDirectory });

export const auditModule: AppModule = { name: 'audit', router: auditLogRouter(auditLogService) };

import { recordAuditEntry } from '../../../shared/infrastructure/audit-log';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { AuthAuditAction } from '../domain/auth-policy';

const USER_AGENT_MAX = 512;

export interface AuthAuditEvent {
  action: AuthAuditAction;
  /** The actor: the signed-in user, or null when the caller is not (yet) authenticated. */
  actorId: string | null;
  /** The account the event is about, when known (e.g. the target of a failed login). */
  subjectId: string | null;
  correlationId: string;
  ip: string | undefined;
  userAgent: string | undefined;
  details?: Record<string, unknown>;
}

/** One audit entry per sign-in, sign-out and token-reuse event, through the platform audit writer. */
export async function writeAuthAudit(db: Queryable, event: AuthAuditEvent): Promise<void> {
  await recordAuditEntry(db, {
    action: event.action,
    userId: event.actorId,
    entityType: 'auth.users',
    entityId: event.subjectId,
    correlationId: event.correlationId,
    ip: event.ip,
    details: { ...event.details, user_agent: event.userAgent?.slice(0, USER_AGENT_MAX) ?? null },
  });
}

import { isIP } from 'node:net';
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

/** One audit.audit_logs row per sign-in, sign-out and token-reuse event. */
export async function writeAuthAudit(db: Queryable, event: AuthAuditEvent): Promise<void> {
  await db.query(
    `INSERT INTO audit.audit_logs
       (user_id, action, entity_type, entity_id, correlation_id, ip_address, details)
     VALUES ($1, $2, 'auth.users', $3, $4, $5, $6)`,
    [
      event.actorId,
      event.action,
      event.subjectId,
      event.correlationId,
      event.ip && isIP(event.ip) ? event.ip : null,
      JSON.stringify({ ...event.details, user_agent: event.userAgent?.slice(0, USER_AGENT_MAX) ?? null }),
    ],
  );
}

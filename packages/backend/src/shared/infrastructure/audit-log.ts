import { isIP } from 'node:net';
import type { Queryable } from './queryable';
import { currentRequestSource, type RequestSource } from './request-source';

/** How the action ended: done, refused by a rule (permission, throttle, token reuse), or attempted and failed. */
export type AuditResult = 'success' | 'denied' | 'failed';

/** One row of audit.audit_logs. Ids are BIGINTs (strings from node-pg). */
export interface AuditEntry {
  action: string;
  /** The actor, or null when the caller is not signed in. */
  userId: string | number | null;
  /** Schema-qualified table the entry is about, e.g. 'auth.users'. */
  entityType: string | null;
  entityId: string | number | null;
  correlationId: string;
  /** Not stored unless it is a valid IPv4/IPv6 address (the column is INET). Defaults to the request's. */
  ip?: string;
  /** Default `success`. */
  result?: AuditResult;
  /** Default: the current request or job (request-source.ts), else a script. */
  source?: RequestSource;
  oldValues?: Record<string, unknown> | null;
  newValues?: Record<string, unknown> | null;
  details?: Record<string, unknown>;
}

/**
 * The only code that writes audit.audit_logs. The audit trail is platform
 * infrastructure: every module records into it, in the caller's transaction
 * when given its client, so a module never writes the audit schema's SQL
 * itself (FMS-12, CONVENTIONS.md Modules rule 3). Reading the trail is the
 * audit module's API.
 */
export async function recordAuditEntry(db: Queryable, entry: AuditEntry): Promise<void> {
  const source = entry.source ?? currentRequestSource();
  const ip = entry.ip ?? source.ip ?? undefined;
  await db.query(
    `INSERT INTO audit.audit_logs
       (user_id, action, entity_type, entity_id, correlation_id, ip_address, old_values, new_values, details, request_source, result)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      entry.userId,
      entry.action,
      entry.entityType,
      entry.entityId,
      entry.correlationId,
      ip && isIP(ip) ? ip : null,
      entry.oldValues ? JSON.stringify(entry.oldValues) : null,
      entry.newValues ? JSON.stringify(entry.newValues) : null,
      JSON.stringify(entry.details ?? {}),
      JSON.stringify(source),
      entry.result ?? 'success',
    ],
  );
}

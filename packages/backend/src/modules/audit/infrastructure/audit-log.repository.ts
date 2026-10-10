import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { AuditCursor } from '../domain/audit-log';

export interface AuditLogRow {
  id: string;
  /** created_at in UTC with microseconds: the cursor needs the full precision a JS Date drops. */
  at: string;
  userId: string | null;
  action: string;
  result: string | null;
  entityType: string | null;
  entityId: string | null;
  /** The entity's public id from its stored values (mutations). */
  entityPublicId: string | null;
  correlationId: string;
  requestSource: Record<string, unknown> | null;
  oldValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  details: Record<string, unknown> | null;
}

export interface AuditLogFilter {
  /** The actor (internal id). */
  userId?: string;
  entityType?: string;
  /** The entity's public id, and its internal id when it is a user account (auth events and role changes store that). */
  entity?: { publicId: string; userId?: string };
  correlationId?: string;
  action?: string;
  result?: string;
  from?: string;
  to?: string;
  /** Rows strictly older than this position. */
  after?: AuditCursor;
  limit: number;
}

/** The public id an audited mutation stored: the same expression as idx_audit_logs_entity_public. */
const ENTITY_PUBLIC_ID = "COALESCE(a.new_values->>'public_id', a.old_values->>'public_id')";

/** Reads audit.audit_logs, newest first on (created_at, id). Never writes: the trail is append-only. */
export class AuditLogRepository {
  async list(db: Queryable, f: AuditLogFilter): Promise<AuditLogRow[]> {
    const params: unknown[] = [];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where: string[] = [];
    if (f.userId) where.push(`a.user_id = ${add(f.userId)}`);
    if (f.entityType) where.push(`a.entity_type = ${add(f.entityType)}`);
    if (f.entity) {
      const byValues = `${ENTITY_PUBLIC_ID} = ${add(f.entity.publicId)}`;
      where.push(
        f.entity.userId
          ? `(${byValues} OR (a.entity_type IN ('auth.users', 'auth.user_roles') AND a.entity_id = ${add(f.entity.userId)}))`
          : byValues,
      );
    }
    if (f.correlationId) where.push(`a.correlation_id = ${add(f.correlationId)}`);
    if (f.action) where.push(`a.action = ${add(f.action)}`);
    if (f.result) where.push(`a.result = ${add(f.result)}`);
    if (f.from) where.push(`a.created_at >= ${add(f.from)}::timestamptz`);
    if (f.to) where.push(`a.created_at < ${add(f.to)}::timestamptz`);
    if (f.after) where.push(`(a.created_at, a.id) < (${add(f.after.at)}::timestamptz, ${add(f.after.id)}::bigint)`);

    const res = await db.query<AuditLogRow>(
      `SELECT a.id, to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
              a.user_id AS "userId", a.action, a.result, a.entity_type AS "entityType", a.entity_id AS "entityId",
              ${ENTITY_PUBLIC_ID} AS "entityPublicId", a.correlation_id AS "correlationId",
              a.request_source AS "requestSource", a.old_values AS "oldValues", a.new_values AS "newValues", a.details
         FROM audit.audit_logs a
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT ${add(f.limit)}`,
      params,
    );
    return res.rows;
  }
}

import type { Pool } from 'pg';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { decodeCursor, encodeCursor, withoutInternalIds, type AuditActor, type AuditLogView } from '../domain/audit-log';
import type { AuditLogRepository, AuditLogRow } from '../infrastructure/audit-log.repository';

export interface AuditLogQuery {
  page_size: number;
  cursor?: string;
  /** Public ids. */
  user_id?: string;
  entity_type?: string;
  entity_id?: string;
  correlation_id?: string;
  action?: string;
  result?: string;
  /** ISO instants (the route turns a date into Addis Ababa midnight). */
  from?: string;
  to?: string;
}

export interface AuditLogServiceDeps {
  db: Pool;
  logs: AuditLogRepository;
  /** User accounts (auth module): the API speaks public ids, the trail stores internal ones. */
  users: {
    findByPublicId(db: Queryable, publicId: string): Promise<{ id: string } | null>;
    findByIds(db: Queryable, ids: readonly string[]): Promise<{ id: string; publicId: string; fullName: string; email: string }[]>;
  };
}

/** Account rows store the account's internal id as entity_id (auth events, role changes). */
const ACCOUNT_ENTITIES = new Set(['auth.users', 'auth.user_roles']);

/**
 * GET /audit-logs (FMS-28): the trail, newest first, filtered, with cursor
 * paging on (created_at, id). Rows written in one transaction share a
 * timestamp; the id breaks the tie, so no row is skipped or repeated.
 */
export class AuditLogService {
  constructor(private readonly deps: AuditLogServiceDeps) {}

  async list(query: AuditLogQuery): Promise<{ items: AuditLogView[]; nextCursor: string | null }> {
    const { db, logs, users } = this.deps;
    const after = query.cursor ? decodeCursor(query.cursor) : undefined;

    let userId: string | undefined;
    if (query.user_id) {
      const user = await users.findByPublicId(db, query.user_id);
      if (!user) return { items: [], nextCursor: null };
      userId = user.id;
    }
    let entity: { publicId: string; userId?: string } | undefined;
    if (query.entity_id) {
      const account = !query.entity_type || ACCOUNT_ENTITIES.has(query.entity_type) ? await users.findByPublicId(db, query.entity_id) : null;
      entity = { publicId: query.entity_id, userId: account?.id };
    }

    // One extra row says whether there is a next page.
    const rows = await logs.list(db, {
      userId,
      entityType: query.entity_type,
      entity,
      correlationId: query.correlation_id,
      action: query.action,
      result: query.result,
      from: query.from,
      to: query.to,
      after,
      limit: query.page_size + 1,
    });
    const page = rows.slice(0, query.page_size);
    const items = await this.views(page);
    const last = page[page.length - 1];
    return { items, nextCursor: rows.length > query.page_size && last ? encodeCursor({ at: last.at, id: last.id }) : null };
  }

  private async views(rows: readonly AuditLogRow[]): Promise<AuditLogView[]> {
    const ids = new Set<string>();
    for (const r of rows) {
      if (r.userId) ids.add(r.userId);
      if (r.entityId && r.entityType && ACCOUNT_ENTITIES.has(r.entityType)) ids.add(r.entityId);
    }
    const accounts = new Map((await this.deps.users.findByIds(this.deps.db, [...ids])).map((a) => [a.id, a]));

    return rows.map((r) => {
      const account = r.userId ? accounts.get(r.userId) : undefined;
      const actor: AuditActor = r.userId
        ? { type: 'user', id: account?.publicId ?? null, full_name: account?.fullName ?? null, email: account?.email ?? null }
        : r.requestSource?.actor === 'system'
          ? { type: 'system' }
          : { type: 'anonymous' };
      const entityAccount = r.entityId && r.entityType && ACCOUNT_ENTITIES.has(r.entityType) ? accounts.get(r.entityId) : undefined;
      return {
        id: encodeCursor({ at: r.at, id: r.id }),
        occurred_at: r.at,
        action: r.action,
        result: r.result,
        actor,
        entity_type: r.entityType,
        entity_id: entityAccount?.publicId ?? r.entityPublicId,
        correlation_id: r.correlationId,
        request_source: r.requestSource,
        old_values: withoutInternalIds(r.oldValues),
        new_values: withoutInternalIds(r.newValues),
        details: r.details ?? {},
      };
    });
  }
}

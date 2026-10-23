import type { Pool, PoolClient } from 'pg';
import { limitOffset } from '../../../shared/http/pagination';
import { recordAuditEntry } from '../../../shared/infrastructure/audit-log';
import type { MutationContext, Row } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { Repository } from '../../../shared/infrastructure/repository';
import { INBOX_WINDOW_DAYS, type InboxStatus } from '../domain/notification';

/** An in-app alert.notifications row (internal ids), with the public id of its alert. */
export interface NotificationRow {
  id: string;
  publicId: string;
  type: string;
  title: string;
  message: string;
  alertPublicId: string | null;
  /** The alert's subject: what it is about, and its vehicle and driver (internal ids, other modules' tables). */
  entityType: string | null;
  entityId: string | null;
  vehicleId: string | null;
  driverId: string | null;
  readAt: Date | null;
  createdAt: Date;
}

export interface InboxFilter {
  /** The recipient: their internal user id. Every query is limited to it. */
  userId: string;
  status: InboxStatus;
  types?: readonly string[];
  page: number;
  page_size: number;
}

/** The inbox window (INBOX_WINDOW_DAYS is a constant, never input, so it is written into the SQL). */
const inWindow = (column: string) => `${column} >= CURRENT_TIMESTAMP - interval '${INBOX_WINDOW_DAYS} days'`;

const ROW_SQL = `
  SELECT n.id, n.public_id AS "publicId", n.notification_type AS type, n.title, n.message,
         a.public_id AS "alertPublicId", a.entity_type AS "entityType", a.entity_id AS "entityId",
         a.vehicle_id AS "vehicleId", a.driver_id AS "driverId", n.read_at AS "readAt", n.queued_at AS "createdAt"
    FROM alert.notifications n
    LEFT JOIN alert.alerts a ON a.id = n.alert_id`;

/**
 * The inbox half of alert.notifications (FMS-48), limited to the last 30 days (FMS-49). Every read and write names the recipient, so one user's rows
 * can never be reached with another's id: an id that is not theirs is simply not found.
 */
export class NotificationRepository extends Repository {
  constructor(db: Pool) {
    super(db);
  }

  inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.transaction(fn);
  }

  /** The caller's in-app notifications, newest first. */
  async list(db: Queryable, f: InboxFilter): Promise<{ rows: NotificationRow[]; total: number }> {
    const params: unknown[] = [f.userId];
    const add = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where = ['n.recipient_user_id = $1', "n.channel = 'in_app'", inWindow('n.queued_at')];
    if (f.status === 'unread') where.push('n.read_at IS NULL');
    if (f.status === 'read') where.push('n.read_at IS NOT NULL');
    if (f.types?.length) where.push(`n.notification_type = ANY(${add(f.types)}::text[])`);
    const condition = where.join(' AND ');
    const { limit, offset } = limitOffset(f);

    const total = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM alert.notifications n WHERE ${condition}`, params);
    const res = await db.query<NotificationRow>(
      `${ROW_SQL} WHERE ${condition} ORDER BY n.queued_at DESC, n.id DESC LIMIT ${add(limit)} OFFSET ${add(offset)}`,
      params,
    );
    return { rows: res.rows, total: total.rows[0].n };
  }

  /** One of the caller's notifications by public id (row-locked with `lock`); someone else's is not found. */
  async findOwn(db: Queryable, publicId: string, userId: string, lock = false): Promise<NotificationRow | null> {
    const res = await db.query<NotificationRow>(
      `${ROW_SQL} WHERE n.public_id = $1 AND n.recipient_user_id = $2 AND n.channel = 'in_app'${lock ? ' FOR UPDATE OF n' : ''}`,
      [publicId, userId],
    );
    return res.rows[0] ?? null;
  }

  async findById(db: Queryable, id: string): Promise<NotificationRow> {
    const res = await db.query<NotificationRow>(`${ROW_SQL} WHERE n.id = $1`, [id]);
    return res.rows[0];
  }

  /** Unread in-app notifications per user: every asked user is in the map, with 0 if they have none. */
  async unreadCounts(db: Queryable, userIds: readonly string[]): Promise<Map<string, number>> {
    const counts = new Map(userIds.map((id) => [id, 0]));
    if (userIds.length === 0) return counts;
    const res = await db.query<{ userId: string; n: number }>(
      `SELECT recipient_user_id AS "userId", count(*)::int AS n
         FROM alert.notifications
        WHERE recipient_user_id = ANY($1::bigint[]) AND channel = 'in_app' AND read_at IS NULL AND ${inWindow('queued_at')}
        GROUP BY recipient_user_id`,
      [userIds],
    );
    for (const r of res.rows) counts.set(r.userId, r.n);
    return counts;
  }

  /** Marks one notification read: one audited change. */
  markRead(ctx: MutationContext, id: string, client: PoolClient): Promise<Row> {
    return this.mutate(ctx, 'alert.notifications', 'UPDATE', id, { read_at: new Date() }, client);
  }

  /**
   * Marks all the caller's unread in-app notifications read: one statement and one audit entry for the batch
   * (`notification.read_all`, with the count), not a row each. Returns how many it changed.
   */
  async markAllRead(client: PoolClient, ctx: MutationContext, userId: string): Promise<number> {
    const res = await client.query(
      `UPDATE alert.notifications SET read_at = CURRENT_TIMESTAMP
        WHERE recipient_user_id = $1 AND channel = 'in_app' AND read_at IS NULL AND ${inWindow('queued_at')}`,
      [userId],
    );
    const updated = res.rowCount ?? 0;
    if (updated > 0) {
      await recordAuditEntry(client, {
        action: 'notification.read_all',
        userId: ctx.userId,
        entityType: 'alert.notifications',
        entityId: userId,
        correlationId: ctx.correlationId,
        details: { channel: 'in_app', count: updated },
      });
    }
    return updated;
  }
}

import type { PoolClient } from 'pg';
import { aggregateKey, createEvent } from '../../../shared/events/domain-event';
import type { EventBus } from '../../../shared/events/event-bus';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { RequestUser } from '../../../types/express';
import { NOTIFICATION_EVENTS, notificationNotFound, type InboxStatus, type NotificationView, type UnreadReason } from '../domain/notification';
import type { NotificationRepository, NotificationRow } from '../infrastructure/notification.repository';

export interface InboxQuery {
  page: number;
  page_size: number;
  status: InboxStatus;
  type?: string[];
}

export interface InboxServiceDeps {
  notifications: Pick<NotificationRepository, 'inTransaction' | 'list' | 'findOwn' | 'findById' | 'unreadCounts' | 'markRead' | 'markAllRead'>;
  users: { publicIds(db: Queryable, ids: readonly string[]): Promise<Map<string, string>> };
  events: EventBus;
}

/** The caller's internal user id, or null for a request with no user behind it (nothing to show). */
const userIdOf = (user: RequestUser): string | null => user.id;

/**
 * The in-app inbox (FMS-48, §9.4): a user's own notifications, with read state, and their unread count kept
 * current on every screen they have open. Everything is limited to the caller: another user's notification is
 * not found, never forbidden, so its existence is not revealed. The alert engine writes the rows (FMS-92) and
 * calls `announce` for the people it notified.
 */
export class InboxService {
  constructor(private readonly deps: InboxServiceDeps) {}

  /** The caller's notifications, newest first, with their unread count. */
  async list(user: RequestUser, query: InboxQuery): Promise<{ items: NotificationView[]; total: number; unread: number }> {
    const userId = userIdOf(user);
    if (userId === null) return { items: [], total: 0, unread: 0 };
    const { notifications } = this.deps;
    return notifications.inTransaction(async (client) => {
      const { rows, total } = await notifications.list(client, { userId, status: query.status, types: query.type, page: query.page, page_size: query.page_size });
      const unread = (await notifications.unreadCounts(client, [userId])).get(userId) ?? 0;
      return { items: rows.map(view), total, unread };
    });
  }

  /**
   * PATCH /notifications/{id}/read. Reading one already read changes nothing (no write, no event), so it is safe
   * to repeat. Publishes the new unread count so the user's other screens follow.
   */
  async markRead(user: RequestUser, correlationId: string, publicId: string): Promise<{ notification: NotificationView; unread: number }> {
    const userId = userIdOf(user);
    if (userId === null) throw notificationNotFound();
    const { notifications } = this.deps;
    return notifications.inTransaction(async (client) => {
      const row = await notifications.findOwn(client, publicId, userId, true);
      if (!row) throw notificationNotFound();
      if (row.readAt) return { notification: view(row), unread: (await notifications.unreadCounts(client, [userId])).get(userId) ?? 0 };

      const ctx: MutationContext = { userId, correlationId };
      await notifications.markRead(ctx, row.id, client);
      const updated = view(await notifications.findById(client, row.id));
      const unread = await this.announce(client, [userId], 'read', ctx, user.publicId).then((counts) => counts.get(userId) ?? 0);
      return { notification: updated, unread };
    });
  }

  /** POST /notifications/read-all: everything of the caller's still unread. How many it changed; zero publishes nothing. */
  async markAllRead(user: RequestUser, correlationId: string): Promise<{ updated: number }> {
    const userId = userIdOf(user);
    if (userId === null) return { updated: 0 };
    const { notifications } = this.deps;
    return notifications.inTransaction(async (client) => {
      const ctx: MutationContext = { userId, correlationId };
      const updated = await notifications.markAllRead(client, ctx, userId);
      if (updated > 0) await this.announce(client, [userId], 'read_all', ctx, user.publicId);
      return { updated };
    });
  }

  /**
   * Tells these users (internal ids) their unread count changed, in the caller's transaction: the event commits
   * with the change it reports. One event per user, ordered per user in the outbox. Returns the counts.
   */
  async announce(tx: PoolClient, userIds: readonly string[], reason: UnreadReason, ctx: MutationContext, actor: string | null = null): Promise<Map<string, number>> {
    const { notifications, users, events } = this.deps;
    const counts = await notifications.unreadCounts(tx, userIds);
    if (userIds.length === 0) return counts;
    const publicIds = await users.publicIds(tx, userIds);
    const changedAt = new Date().toISOString();
    await events.publish(
      tx,
      userIds.flatMap((id) => {
        const publicId = publicIds.get(id);
        if (!publicId) return [];
        return [
          createEvent(
            NOTIFICATION_EVENTS.unreadChanged,
            { user_id: publicId, unread_count: counts.get(id) ?? 0, reason, changed_at: changedAt },
            { actor, correlationId: ctx.correlationId },
            { aggregate: aggregateKey('inbox', publicId) },
          ),
        ];
      }),
    );
    return counts;
  }
}

function view(row: NotificationRow): NotificationView {
  return {
    id: row.publicId,
    type: row.type,
    title: row.title,
    message: row.message,
    alert_id: row.alertPublicId,
    read: row.readAt !== null,
    read_at: row.readAt,
    created_at: row.createdAt,
  };
}

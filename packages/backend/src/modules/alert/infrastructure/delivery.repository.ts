import type { Pool, PoolClient } from 'pg';
import { recordAuditEntry } from '../../../shared/infrastructure/audit-log';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import { Repository } from '../../../shared/infrastructure/repository';
import type { AlertSeverity, AlertStatus } from '../domain/alert';
import type { DeliveryChannel, DeliveryStatus, NotificationChannel } from '../domain/delivery';

/** A queued email, SMS or push, claimed for an attempt, with what its alert is now. */
export interface DueMessage {
  id: string;
  publicId: string;
  recipientId: string;
  channel: DeliveryChannel;
  type: string;
  title: string;
  message: string;
  /** Including the one just claimed. */
  attempts: number;
  queuedAt: Date;
  pushSubscriptionId: string | null;
  alert: { publicId: string; status: AlertStatus; severity: AlertSeverity; entityType: string | null; entityId: string | null; createdAt: Date };
}

/** Every notification of an alert, for its delivery status (internal ids). */
export interface DeliveryRow {
  publicId: string;
  channel: NotificationChannel;
  status: DeliveryStatus;
  type: string;
  recipientId: string;
  attempts: number;
  providerId: string | null;
  providerMessageId: string | null;
  queuedAt: Date;
  sentAt: Date | null;
  failedAt: Date | null;
  nextAttemptAt: Date | null;
  failureReason: string | null;
  readAt: Date | null;
}

export interface PushSubscriptionRow {
  id: string;
  publicId: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** One queued message: who, on which channel, and for push which device. */
export interface QueuedMessage {
  recipientId: string;
  channel: DeliveryChannel;
  pushSubscriptionId: string | null;
}

const SUBSCRIPTION_COLUMNS = `id, public_id AS "publicId", user_id AS "userId", endpoint, p256dh, auth_secret AS auth`;

/**
 * The delivery half of alert.notifications (FMS-93) and alert.push_subscriptions. Queuing is one statement and one
 * audit entry per batch, like the inbox's. Attempts are recorded on the row itself (attempts, provider, provider
 * message id, failure reason), not audited one by one: the row is the delivery log.
 */
export class DeliveryRepository extends Repository {
  constructor(db: Pool) {
    super(db);
  }

  inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.transaction(fn);
  }

  /** For writes outside a transaction (one statement each). */
  pool(): Queryable {
    return this.db;
  }

  /** Emails, SMS and pushes for an alert's recipients, due at once. */
  async queue(client: PoolClient, ctx: MutationContext, alertId: string, messages: readonly QueuedMessage[], content: { type: string; title: string; message: string }): Promise<number> {
    if (messages.length === 0) return 0;
    const res = await client.query(
      `INSERT INTO alert.notifications
              (alert_id, recipient_user_id, notification_type, title, message, channel, status, next_attempt_at, push_subscription_id)
       SELECT $1, m.recipient, $5, $6, $7, m.channel::alert.notification_channel, 'queued', CURRENT_TIMESTAMP, m.subscription
         FROM unnest($2::bigint[], $3::text[], $4::bigint[]) AS m(recipient, channel, subscription)`,
      [alertId, messages.map((m) => m.recipientId), messages.map((m) => m.channel), messages.map((m) => m.pushSubscriptionId), content.type, content.title, content.message],
    );
    const counts: Record<string, number> = {};
    for (const m of messages) counts[m.channel] = (counts[m.channel] ?? 0) + 1;
    await recordAuditEntry(client, {
      action: 'alert.delivery_queued',
      userId: ctx.userId,
      entityType: 'alert.alerts',
      entityId: alertId,
      correlationId: ctx.correlationId,
      details: { channels: counts, notification_type: content.type },
    });
    return res.rowCount ?? messages.length;
  }

  /**
   * Claims up to `limit` messages due by `now`, oldest first, skipping any another instance holds: each counts an
   * attempt and is due again after the lease, so one whose sender dies is picked up later. One statement.
   */
  async claimDue(db: Queryable, now: Date, limit: number, leaseMinutes: number): Promise<DueMessage[]> {
    const claimed = await db.query<{ id: string }>(
      `WITH due AS (
         SELECT id FROM alert.notifications
          WHERE status = 'queued' AND channel <> 'in_app' AND next_attempt_at <= $1
          ORDER BY next_attempt_at, id
          LIMIT $2
          FOR UPDATE SKIP LOCKED)
       UPDATE alert.notifications n
          SET delivery_attempts = n.delivery_attempts + 1, next_attempt_at = $1::timestamptz + make_interval(mins => $3)
         FROM due WHERE n.id = due.id
       RETURNING n.id`,
      [now, limit, leaseMinutes],
    );
    if (claimed.rowCount === 0) return [];
    const res = await db.query<DueMessage & { alertPublicId: string; alertStatus: AlertStatus; severity: AlertSeverity; entityType: string | null; entityId: string | null; alertCreatedAt: Date }>(
      `SELECT n.id, n.public_id AS "publicId", n.recipient_user_id AS "recipientId", n.channel, n.notification_type AS type,
              n.title, n.message, n.delivery_attempts AS attempts, n.queued_at AS "queuedAt", n.push_subscription_id AS "pushSubscriptionId",
              a.public_id AS "alertPublicId", a.status AS "alertStatus", a.severity, a.entity_type AS "entityType", a.entity_id AS "entityId",
              a.created_at AS "alertCreatedAt"
         FROM alert.notifications n
         JOIN alert.alerts a ON a.id = n.alert_id
        WHERE n.id = ANY($1::bigint[])
        ORDER BY n.next_attempt_at, n.id`,
      [claimed.rows.map((r) => r.id)],
    );
    return res.rows.map(({ alertPublicId, alertStatus, severity, entityType, entityId, alertCreatedAt, ...m }) => ({
      ...m,
      alert: { publicId: alertPublicId, status: alertStatus, severity, entityType, entityId, createdAt: alertCreatedAt },
    }));
  }

  async markSent(db: Queryable, id: string, providerId: string, messageId: string | null, at: Date): Promise<void> {
    await db.query(
      `UPDATE alert.notifications
          SET status = 'sent', sent_at = $4, provider_id = $2, provider_message_id = $3, next_attempt_at = NULL, failure_reason = NULL
        WHERE id = $1`,
      [id, providerId, messageId, at],
    );
  }

  /** The attempt failed and another is due at `nextAt`; the reason stays visible meanwhile. */
  async markRetry(db: Queryable, id: string, providerId: string | null, reason: string, nextAt: Date): Promise<void> {
    await db.query(
      `UPDATE alert.notifications SET next_attempt_at = $4, failure_reason = $3, provider_id = coalesce($2, provider_id) WHERE id = $1`,
      [id, providerId, reason, nextAt],
    );
  }

  /** The provider's breaker is open: not an attempt after all, due again at `nextAt`. */
  async release(db: Queryable, id: string, providerId: string | null, reason: string, nextAt: Date): Promise<void> {
    await db.query(
      `UPDATE alert.notifications
          SET delivery_attempts = greatest(delivery_attempts - 1, 0), next_attempt_at = $4, failure_reason = $3,
              provider_id = coalesce($2, provider_id)
        WHERE id = $1`,
      [id, providerId, reason, nextAt],
    );
  }

  async markFailed(db: Queryable, id: string, providerId: string | null, reason: string, at: Date): Promise<void> {
    await db.query(
      `UPDATE alert.notifications
          SET status = 'failed', failed_at = $4, failure_reason = $3, next_attempt_at = NULL, provider_id = coalesce($2, provider_id)
        WHERE id = $1`,
      [id, providerId, reason, at],
    );
  }

  async markCancelled(db: Queryable, id: string, reason: string): Promise<void> {
    // Not an attempt: nothing was sent.
    await db.query(
      `UPDATE alert.notifications
          SET status = 'cancelled', failure_reason = $2, next_attempt_at = NULL, delivery_attempts = greatest(delivery_attempts - 1, 0)
        WHERE id = $1`,
      [id, reason],
    );
  }

  /** Every notification of an alert, in the inbox and outside it: by channel, then recipient. */
  async forAlert(db: Queryable, alertId: string): Promise<DeliveryRow[]> {
    const res = await db.query<DeliveryRow>(
      `SELECT public_id AS "publicId", channel, status, notification_type AS type, recipient_user_id AS "recipientId",
              delivery_attempts AS attempts, provider_id AS "providerId", provider_message_id AS "providerMessageId",
              queued_at AS "queuedAt", sent_at AS "sentAt", failed_at AS "failedAt",
              CASE WHEN status = 'queued' THEN next_attempt_at END AS "nextAttemptAt", failure_reason AS "failureReason", read_at AS "readAt"
         FROM alert.notifications
        WHERE alert_id = $1
        ORDER BY array_position(ARRAY['in_app', 'email', 'sms', 'push']::alert.notification_channel[], channel), recipient_user_id, id`,
      [alertId],
    );
    return res.rows;
  }

  /**
   * Saves a browser's push subscription for `userId`. The endpoint is the browser's: if another account had it
   * (someone else signed in on this browser before), it moves to this one. Audited without the endpoint, which
   * is a credential to push to that browser.
   */
  async saveSubscription(
    client: PoolClient,
    ctx: MutationContext,
    userId: string,
    sub: { endpoint: string; p256dh: string; auth: string; userAgent: string | null },
  ): Promise<{ publicId: string; createdAt: Date; created: boolean }> {
    const res = await client.query<{ publicId: string; createdAt: Date; created: boolean; id: string }>(
      `INSERT INTO alert.push_subscriptions (user_id, endpoint, p256dh, auth_secret, user_agent)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (endpoint) DO UPDATE
          SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth_secret = EXCLUDED.auth_secret, user_agent = EXCLUDED.user_agent
       RETURNING id, public_id AS "publicId", created_at AS "createdAt", (xmax = 0) AS created`,
      [userId, sub.endpoint, sub.p256dh, sub.auth, sub.userAgent],
    );
    const row = res.rows[0];
    await recordAuditEntry(client, {
      action: row.created ? 'push.subscribed' : 'push.resubscribed',
      userId: ctx.userId,
      entityType: 'alert.push_subscriptions',
      entityId: row.id,
      correlationId: ctx.correlationId,
      details: { user_agent: sub.userAgent },
    });
    return { publicId: row.publicId, createdAt: row.createdAt, created: row.created };
  }

  /** Removes the caller's subscription for this endpoint (another user's is left alone). How many it removed. */
  async removeSubscription(client: PoolClient, ctx: MutationContext, userId: string, endpoint: string): Promise<number> {
    const res = await client.query<{ id: string }>('DELETE FROM alert.push_subscriptions WHERE user_id = $1 AND endpoint = $2 RETURNING id', [userId, endpoint]);
    for (const r of res.rows) {
      await recordAuditEntry(client, { action: 'push.unsubscribed', userId: ctx.userId, entityType: 'alert.push_subscriptions', entityId: r.id, correlationId: ctx.correlationId });
    }
    return res.rowCount ?? 0;
  }

  /** The push service says the subscription is gone (404, 410): it is removed, and its queued pushes cancelled. */
  async dropSubscription(db: Queryable, id: string): Promise<void> {
    await db.query('DELETE FROM alert.push_subscriptions WHERE id = $1', [id]);
  }

  async touchSubscription(db: Queryable, id: string, at: Date): Promise<void> {
    await db.query('UPDATE alert.push_subscriptions SET last_success_at = $2 WHERE id = $1', [id, at]);
  }

  async subscription(db: Queryable, id: string): Promise<PushSubscriptionRow | null> {
    return (await db.query<PushSubscriptionRow>(`SELECT ${SUBSCRIPTION_COLUMNS} FROM alert.push_subscriptions WHERE id = $1`, [id])).rows[0] ?? null;
  }

  /** These users' devices, oldest first. */
  async subscriptionsOf(db: Queryable, userIds: readonly string[]): Promise<PushSubscriptionRow[]> {
    if (userIds.length === 0) return [];
    const res = await db.query<PushSubscriptionRow>(`SELECT ${SUBSCRIPTION_COLUMNS} FROM alert.push_subscriptions WHERE user_id = ANY($1::bigint[]) ORDER BY id`, [userIds]);
    return res.rows;
  }
}

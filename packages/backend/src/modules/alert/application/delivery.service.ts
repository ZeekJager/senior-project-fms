import type { PoolClient } from 'pg';
import { depotScope, type Scope } from '../../../shared/authz/scope';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { Queryable } from '../../../shared/infrastructure/queryable';
import type { RequestUser } from '../../../types/express';
import { alertNotFound, SEVERITIES, type AlertSeverity } from '../domain/alert';
import {
  alertPath,
  CANCEL_REASONS,
  CHANNELS_BY_SEVERITY,
  CLAIM_LEASE_MINUTES,
  DELIVERY_BATCH,
  emailContent,
  endpointKey,
  nextAttemptAt,
  PUSH_TTL_SECONDS,
  pushContent,
  pushSubscriptionInvalid,
  pushUnavailable,
  smsText,
  type ChannelsView,
  type DeliveryChannel,
  type DeliveryView,
  type MessageFacts,
} from '../domain/delivery';
import type { AlertRow } from '../infrastructure/alert.repository';
import type { DeliveryRepository, DueMessage, QueuedMessage } from '../infrastructure/delivery.repository';

/** A message as the gateway takes it (integration's OutboundMessage). */
export interface Outbound {
  channel: DeliveryChannel;
  reference: string;
  to: { email?: string; name?: string; phone?: string; push?: { endpoint: string; p256dh: string; auth: string } };
  subject: string;
  text: string;
  data?: Record<string, unknown>;
  urgency: 'normal' | 'high';
  ttlSeconds: number;
}

/** How a send went (integration's SendOutcome). */
export type Outcome =
  | { status: 'sent'; providerId: string; messageId: string | null }
  | { status: 'refused'; providerId: string | null; reason: string; message: string }
  | { status: 'paused'; providerId: string | null; retryInMs: number; message: string }
  | { status: 'failed'; providerId: string | null; retryable: boolean; message: string };

export interface DeliveryServiceDeps {
  repo: DeliveryRepository;
  /** The integration gateway's notification channels (FMS-93). */
  gateway: {
    channels(db?: Queryable): Promise<Set<DeliveryChannel>>;
    pushPublicKey(db?: Queryable): Promise<string | null>;
    destinationProblem(channel: DeliveryChannel, to: Outbound['to'], db?: Queryable): Promise<string | null>;
    send(message: Outbound, correlationId: string): Promise<Outcome>;
    codes(db: Queryable, ids: readonly string[]): Promise<Map<string, string>>;
  };
  /** Accounts, contact details included: only this module reads them, to address a message (§ security, FMS-93). */
  users: {
    accounts(db: Queryable, ids: readonly string[]): Promise<Map<string, { publicId: string; fullName: string; email: string; phone: string | null; active: boolean }>>;
  };
  alerts: { findInScope(db: Queryable, publicId: string, scope: Scope): Promise<AlertRow | null> };
  /** The app's public URL, for an email's link; null leaves the link out. */
  appUrl: string | null;
}

export interface DrainResult {
  sent: number;
  retried: number;
  failed: number;
  cancelled: number;
}

/**
 * Alerts outside the app (FMS-93, §9.4, §34). `queue` adds an alert's emails, SMS and pushes in the alert
 * engine's transaction, by the severity's channels (CHANNELS_BY_SEVERITY) and only on channels that are on;
 * `drain` (the delivery job, every minute) sends what is due through the integration gateway, one message at a
 * time, and records each attempt: sent, retried with backoff, or failed after the last attempt or a refusal.
 * Contact details are read when a message is sent, never stored on it.
 */
export class DeliveryService {
  constructor(private readonly deps: DeliveryServiceDeps) {}

  /** Queues an alert's messages outside the inbox for these recipients (internal ids). How many. */
  async queue(tx: PoolClient, ctx: MutationContext, alert: Pick<AlertRow, 'id' | 'severity'>, recipients: readonly string[], content: { type: string; title: string; message: string }): Promise<number> {
    const { repo, gateway, users } = this.deps;
    const wanted = CHANNELS_BY_SEVERITY[alert.severity];
    if (recipients.length === 0 || wanted.length === 0) return 0;
    const on = await gateway.channels(tx);
    const channels = wanted.filter((c) => on.has(c));
    if (channels.length === 0) return 0;

    const accounts = await users.accounts(tx, recipients);
    const devices = channels.includes('push') ? await repo.subscriptionsOf(tx, recipients) : [];
    const messages: QueuedMessage[] = [];
    for (const recipient of recipients) {
      const account = accounts.get(recipient);
      if (!account?.active) continue;
      if (channels.includes('email')) messages.push({ recipientId: recipient, channel: 'email', pushSubscriptionId: null });
      if (channels.includes('sms') && account.phone) messages.push({ recipientId: recipient, channel: 'sms', pushSubscriptionId: null });
      for (const d of devices) if (d.userId === recipient) messages.push({ recipientId: recipient, channel: 'push', pushSubscriptionId: d.id });
    }
    return repo.queue(tx, ctx, alert.id, messages, content);
  }

  /** Sends every message due by `now`, a batch at a time, until none is left. */
  async drain(run: { now: Date; correlationId: string }): Promise<DrainResult> {
    const { repo } = this.deps;
    const result: DrainResult = { sent: 0, retried: 0, failed: 0, cancelled: 0 };
    for (;;) {
      const due = await repo.claimDue(repo.pool(), run.now, DELIVERY_BATCH, CLAIM_LEASE_MINUTES);
      if (due.length === 0) return result;
      const accounts = await this.deps.users.accounts(repo.pool(), [...new Set(due.map((m) => m.recipientId))]);
      for (const m of due) result[await this.attempt(m, accounts.get(m.recipientId) ?? null, run)] += 1;
    }
  }

  /** One attempt at one message. */
  private async attempt(
    m: DueMessage,
    account: { fullName: string; email: string; phone: string | null; active: boolean } | null,
    run: { now: Date; correlationId: string },
  ): Promise<keyof DrainResult> {
    const { repo, gateway } = this.deps;
    const db = repo.pool();
    const cancel = async (reason: string) => {
      await repo.markCancelled(db, m.id, reason);
      return 'cancelled' as const;
    };
    if (m.alert.status === 'resolved' || m.alert.status === 'dismissed') return cancel(CANCEL_REASONS.alertClosed);
    if (!account?.active) return cancel(CANCEL_REASONS.recipientInactive);

    const to: Outbound['to'] = {};
    if (m.channel === 'email') Object.assign(to, { email: account.email, name: account.fullName });
    if (m.channel === 'sms') {
      if (!account.phone) return cancel(CANCEL_REASONS.noDestination);
      to.phone = account.phone;
    }
    const device = m.channel === 'push' && m.pushSubscriptionId ? await repo.subscription(db, m.pushSubscriptionId) : null;
    if (m.channel === 'push') {
      if (!device) return cancel(CANCEL_REASONS.noDestination);
      to.push = { endpoint: device.endpoint, p256dh: device.p256dh, auth: device.auth };
    }

    const facts: MessageFacts = {
      severity: m.alert.severity,
      title: m.title,
      message: m.message,
      raisedAt: m.alert.createdAt,
      path: alertPath(m.alert.entityType, m.alert.entityId),
      appUrl: this.deps.appUrl,
      alertId: m.alert.publicId,
    };
    const content = m.channel === 'email' ? emailContent(facts) : m.channel === 'sms' ? { subject: m.title, text: smsText(facts) } : pushContent(facts);
    const outcome = await gateway.send(
      {
        channel: m.channel,
        reference: m.publicId,
        to,
        ...content,
        urgency: m.alert.severity === 'critical' ? 'high' : 'normal',
        ttlSeconds: PUSH_TTL_SECONDS[m.alert.severity],
      },
      run.correlationId,
    );

    switch (outcome.status) {
      case 'sent':
        await repo.markSent(db, m.id, outcome.providerId, outcome.messageId, run.now);
        if (device) await repo.touchSubscription(db, device.id, run.now);
        return 'sent';
      case 'refused':
        await repo.markFailed(db, m.id, outcome.providerId, outcome.message, run.now);
        // The browser has gone: no push goes to it again.
        if (device && outcome.reason === 'subscription_expired') await repo.dropSubscription(db, device.id);
        return 'failed';
      case 'paused':
        await repo.release(db, m.id, outcome.providerId, outcome.message, new Date(run.now.getTime() + outcome.retryInMs));
        return 'retried';
      case 'failed': {
        const next = outcome.retryable ? nextAttemptAt(m.attempts, run.now) : null;
        if (next) {
          await repo.markRetry(db, m.id, outcome.providerId, outcome.message, next);
          return 'retried';
        }
        await repo.markFailed(db, m.id, outcome.providerId, outcome.message, run.now);
        return 'failed';
      }
    }
  }

  /** GET /alerts/{id}/deliveries: every notification of an alert in the caller's scope, with its delivery status. */
  async deliveries(user: RequestUser, alertPublicId: string): Promise<DeliveryView[]> {
    const { repo, alerts, users, gateway } = this.deps;
    return repo.inTransaction(async (client) => {
      const alert = await alerts.findInScope(client, alertPublicId, depotScope(user));
      if (!alert) throw alertNotFound();
      const rows = await repo.forAlert(client, alert.id);
      const accounts = await users.accounts(client, [...new Set(rows.map((r) => r.recipientId))]);
      const providers = await gateway.codes(client, [...new Set(rows.flatMap((r) => (r.providerId ? [r.providerId] : [])))]);
      return rows.map((r) => ({
        id: r.publicId,
        channel: r.channel,
        status: r.status,
        type: r.type,
        recipient: { id: accounts.get(r.recipientId)?.publicId ?? null, name: accounts.get(r.recipientId)?.fullName ?? null },
        attempts: r.attempts,
        provider: r.providerId ? (providers.get(r.providerId) ?? null) : null,
        provider_message_id: r.providerMessageId,
        queued_at: r.queuedAt,
        sent_at: r.sentAt,
        failed_at: r.failedAt,
        next_attempt_at: r.nextAttemptAt,
        failure_reason: r.failureReason,
        read_at: r.readAt,
      }));
    });
  }

  /** GET /notifications/channels: the rules, and where the caller is reached. */
  async channelsFor(user: RequestUser): Promise<ChannelsView> {
    const { repo, gateway, users } = this.deps;
    const db = repo.pool();
    const on = await gateway.channels(db);
    const account = user.id ? (await users.accounts(db, [user.id])).get(user.id) : undefined;
    const devices = user.id ? await repo.subscriptionsOf(db, [user.id]) : [];
    return {
      rules: [...SEVERITIES].reverse().map((severity: AlertSeverity) => ({ severity, channels: ['in_app' as const, ...CHANNELS_BY_SEVERITY[severity].filter((c) => on.has(c))] })),
      email: { available: on.has('email'), address: account?.email ?? '' },
      sms: { available: on.has('sms'), phone: account?.phone ?? null },
      push: {
        available: on.has('push'),
        public_key: on.has('push') ? await gateway.pushPublicKey(db) : null,
        devices: devices.length,
        device_keys: devices.map((d) => endpointKey(d.endpoint)),
      },
    };
  }

  /** POST /notifications/push/subscriptions: this browser, for the caller. 201 when new, 200 when it was already known. */
  async subscribe(user: RequestUser, sub: { endpoint: string; p256dh: string; auth: string }, userAgent: string | null, correlationId: string): Promise<{ id: string; created_at: Date; created: boolean }> {
    const { repo, gateway } = this.deps;
    if (!user.id) throw pushUnavailable();
    const problem = await gateway.destinationProblem('push', { push: sub });
    if (problem === 'channel_off') throw pushUnavailable();
    if (problem) throw pushSubscriptionInvalid(problem);
    const ctx: MutationContext = { userId: user.id, correlationId };
    const saved = await repo.inTransaction((client) => repo.saveSubscription(client, ctx, user.id!, { ...sub, userAgent: userAgent ? userAgent.slice(0, 255) : null }));
    return { id: saved.publicId, created_at: saved.createdAt, created: saved.created };
  }

  /** POST /notifications/push/unsubscribe: this browser stops getting the caller's pushes. Safe to repeat. */
  async unsubscribe(user: RequestUser, endpoint: string, correlationId: string): Promise<{ removed: number }> {
    const { repo } = this.deps;
    if (!user.id) return { removed: 0 };
    const ctx: MutationContext = { userId: user.id, correlationId };
    return { removed: await repo.inTransaction((client) => repo.removeSubscription(client, ctx, user.id!, endpoint)) };
  }

  /** POST /notifications/push/test: a push to each of the caller's devices now, to check it arrives. */
  async testPush(user: RequestUser, correlationId: string): Promise<{ devices: number; sent: number; failed: number }> {
    const { repo, gateway } = this.deps;
    const db = repo.pool();
    if (!(await gateway.channels(db)).has('push')) throw pushUnavailable();
    const devices = user.id ? await repo.subscriptionsOf(db, [user.id]) : [];
    let sent = 0;
    for (const d of devices) {
      const outcome = await gateway.send(
        {
          channel: 'push',
          reference: `test-${d.publicId}-${Date.now()}`,
          to: { push: { endpoint: d.endpoint, p256dh: d.p256dh, auth: d.auth } },
          subject: 'Push notifications are on',
          text: 'Critical and high alerts will appear here, even when FMS is closed.',
          data: { url: '/notification-settings', tag: 'fms-test' },
          urgency: 'normal',
          ttlSeconds: 300,
        },
        correlationId,
      );
      if (outcome.status === 'sent') sent += 1;
      if (outcome.status === 'refused' && outcome.reason === 'subscription_expired') await repo.dropSubscription(db, d.id);
    }
    return { devices: devices.length, sent, failed: devices.length - sent };
  }
}

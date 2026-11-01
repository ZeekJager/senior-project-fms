import type { Queryable } from '../../../shared/infrastructure/queryable';
import { DeliveryRefused, NOTIFICATION_CHANNELS, ProviderCallError, type NotificationChannel, type OutboundMessage, type RefusalReason } from '../domain/adapter';
import type { IntegrationRepository, ProviderRow } from '../infrastructure/integration.repository';
import type { ProviderRegistry } from './provider-registry';

export interface NotificationGatewayDeps {
  repo: Pick<IntegrationRepository, 'listProviders' | 'pool'>;
  registry: Pick<ProviderRegistry, 'adapterFor' | 'context'>;
  log: { error(obj: object, msg: string): void };
}

/**
 * How sending one message went, in the caller's terms: sent; refused for good; paused (the provider's breaker is
 * open: not an attempt, try after `retryInMs`); or failed, worth another attempt if `retryable`. `message` is ours
 * (a status, a timeout), safe to store and show.
 */
export type SendOutcome =
  | { status: 'sent'; providerId: string; messageId: string | null }
  | { status: 'refused'; providerId: string | null; reason: RefusalReason; message: string }
  | { status: 'paused'; providerId: string | null; retryInMs: number; message: string }
  | { status: 'failed'; providerId: string | null; retryable: boolean; message: string };

const channelOf = (p: ProviderRow): NotificationChannel | null => {
  const channel = p.configuration.channel;
  return NOTIFICATION_CHANNELS.find((c) => c === channel) ?? null;
};

/**
 * The gateway's notification channels (FMS-93): for each of email, SMS and push, the provider that delivers it
 * (the active `notification` row with that `configuration.channel` and an adapter that can deliver, the oldest
 * if several), and one message at a time through it, behind its breaker. A channel with no such provider is off.
 */
export class NotificationGateway {
  constructor(private readonly deps: NotificationGatewayDeps) {}

  /** Each channel's provider; a channel that is off is missing. */
  async providers(db: Queryable = this.deps.repo.pool()): Promise<Map<NotificationChannel, ProviderRow>> {
    const { repo, registry } = this.deps;
    const rows = (await repo.listProviders(db))
      .filter((p) => p.isActive && p.providerType === 'notification' && channelOf(p) && registry.adapterFor(p)?.deliver)
      .sort((a, b) => Number(a.id) - Number(b.id));
    const byChannel = new Map<NotificationChannel, ProviderRow>();
    for (const p of rows) if (!byChannel.has(channelOf(p)!)) byChannel.set(channelOf(p)!, p);
    return byChannel;
  }

  /** The channels that are on. */
  async channels(db?: Queryable): Promise<Set<NotificationChannel>> {
    return new Set((await this.providers(db)).keys());
  }

  /** The VAPID public key browsers subscribe with, or null while push is off. */
  async pushPublicKey(db?: Queryable): Promise<string | null> {
    const key = (await this.providers(db)).get('push')?.configuration.vapid_public_key;
    return typeof key === 'string' ? key : null;
  }

  /** Why the channel's provider could never deliver to this address (`channel_off` when there is none), or null. */
  async destinationProblem(channel: NotificationChannel, to: OutboundMessage['to'], db?: Queryable): Promise<string | null> {
    const provider = (await this.providers(db)).get(channel);
    if (!provider) return 'channel_off';
    return this.deps.registry.adapterFor(provider)?.destinationProblem?.(provider.configuration, to) ?? null;
  }

  /**
   * Sends one message on its channel through its provider (internal id in the outcome). Never throws: a channel
   * that is off is a failure worth retrying (it may be switched back on), an unexpected error one too (logged).
   */
  async send(message: OutboundMessage, correlationId: string): Promise<SendOutcome> {
    const { registry, log } = this.deps;
    const provider = (await this.providers()).get(message.channel);
    if (!provider) return { status: 'failed', providerId: null, retryable: true, message: `No provider delivers ${message.channel}.` };
    try {
      const receipt = await registry.adapterFor(provider)!.deliver!(registry.context(provider, correlationId), message);
      return { status: 'sent', providerId: provider.id, messageId: receipt.messageId };
    } catch (err) {
      if (err instanceof DeliveryRefused) return { status: 'refused', providerId: provider.id, reason: err.reason, message: err.message };
      if (err instanceof ProviderCallError && err.kind === 'circuit_open') {
        return { status: 'paused', providerId: provider.id, retryInMs: err.retryInMs ?? 30_000, message: err.message };
      }
      if (err instanceof ProviderCallError) return { status: 'failed', providerId: provider.id, retryable: err.retryable, message: err.message };
      log.error({ err, provider: provider.code, channel: message.channel, correlation_id: correlationId }, 'Notification provider failed unexpectedly');
      return { status: 'failed', providerId: provider.id, retryable: true, message: 'The provider failed unexpectedly.' };
    }
  }

  /** Providers' codes by internal id, for showing which one sent a message. */
  async codes(db: Queryable, ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.deps.repo.listProviders(db);
    return new Map(rows.filter((p) => ids.includes(p.id)).map((p) => [p.id, p.code]));
  }
}

import { AppError } from '../../../shared/errors/app-error';
import { aggregateKey, createEvent, deterministicEventId } from '../../../shared/events/domain-event';
import type { EventBus } from '../../../shared/events/event-bus';
import type { MutationContext } from '../../../shared/infrastructure/audited-mutation';
import type { RequestUser } from '../../../types/express';
import { ProviderCallError, WebhookPayloadError, type AdapterContext, type ProviderType } from '../domain/adapter';
import {
  INTEGRATION_EVENTS,
  providerInactive,
  providerNotFound,
  providerUnavailable,
  syncNotSupported,
  webhookProviderNotFound,
  webhookSignatureInvalid,
  webhookStale,
  type ProviderStatus,
  type ProviderView,
  type SyncLogView,
} from '../domain/provider';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyWebhook } from '../domain/webhook-signature';
import { INBOUND_REFERENCE_INDEX, syncLogView, type IntegrationRepository, type ProviderRow, type SyncLogRow } from '../infrastructure/integration.repository';
import type { ProviderRegistry } from './provider-registry';

export interface Caller {
  user: RequestUser;
  correlationId: string;
}

/** Where problems are logged: failures with the provider's code, never secrets or payloads. */
export interface ServiceLog {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface IntegrationServiceDeps {
  repo: IntegrationRepository;
  registry: ProviderRegistry;
  events: EventBus;
  log: ServiceLog;
  now?: () => number;
}

/** A webhook as it reached the server: the raw bytes (what was signed), the parsed body and the signature headers. */
export interface WebhookDelivery {
  providerType: ProviderType;
  code: string;
  rawBody: Buffer;
  body: unknown;
  header(name: string): string | undefined;
  correlationId: string;
}

/** A manual sync started more than this long ago and still `started` is taken as lost (the instance stopped), not running. */
const SYNC_RUNNING_FOR_MS = 15 * 60_000;
/** A health check gets a short timeout of its own, so `?check=true` answers quickly. */
const HEALTH_CHECK_BUDGET_MS = 5_000;

/**
 * The integration gateway's use cases (FMS-85, architecture §15): provider status, manual sync, and
 * signed webhooks. Calls to providers go through the registry's client (timeout, retries, breaker);
 * every exchange is a row in integration.sync_logs.
 */
export class IntegrationService {
  private readonly running = new Set<Promise<void>>();
  private readonly now: () => number;

  constructor(private readonly deps: IntegrationServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** GET /integrations/providers. With `check`, runs each active provider's health check first. */
  async listProviders(check: boolean, correlationId: string): Promise<ProviderView[]> {
    const { repo, registry } = this.deps;
    const providers = await repo.listProviders(repo.pool());
    if (check) await Promise.all(providers.filter((p) => p.isActive).map((p) => this.checkHealth(p, correlationId)));
    const outcomes = await repo.outcomes(repo.pool(), providers.map((p) => p.id));
    return providers.map((p) => {
      const o = outcomes.get(p.id)!;
      const adapter = registry.adapter(p.code);
      const circuit = registry.circuitOf(p);
      const health = registry.healthOf(p);
      return {
        id: p.publicId,
        code: p.code,
        name: p.name,
        provider_type: p.providerType,
        is_active: p.isActive,
        status: statusOf(p, o.lastSuccessAt, o.lastFailureAt, circuit?.state ?? null, health?.healthy ?? null),
        capabilities: { sync: !!adapter?.sync, webhooks: !!adapter?.normalize, health_check: !!adapter?.healthCheck },
        webhook_secret_configured: !!registry.secretsFor(p.code).webhookSecret,
        last_success_at: o.lastSuccessAt,
        last_failure_at: o.lastFailureAt,
        last_error: o.lastError,
        last_sync: o.lastSync ? syncLogView(o.lastSync, p.publicId) : null,
        circuit,
        health,
      };
    });
  }

  /**
   * POST /integrations/providers/{id}/sync: records a `started` sync log and answers at once (202);
   * the sync runs after the response and completes the log. A sync already running is returned
   * instead of starting a second. While the breaker is open the request fails fast (503).
   */
  async sync(caller: Caller, providerPublicId: string): Promise<{ log: SyncLogView; alreadyRunning: boolean }> {
    const { repo, registry } = this.deps;
    const provider = await repo.findProvider(repo.pool(), providerPublicId);
    if (!provider) throw providerNotFound();
    if (!provider.isActive) throw providerInactive();
    const adapter = registry.adapter(provider.code);
    if (!adapter?.sync) throw syncNotSupported();
    const breaker = registry.breakerFor(provider);
    if (breaker.state === 'open') throw providerUnavailable(breaker.retryInMs());

    const ctx: MutationContext = { userId: caller.user.id, correlationId: caller.correlationId };
    const started = await repo.inTransaction(async (client) => {
      const running = await repo.runningSync(client, provider.id, new Date(this.now() - SYNC_RUNNING_FOR_MS));
      if (running) return { row: running, alreadyRunning: true };
      const row = await repo.insertSyncLog(
        ctx,
        {
          provider_id: provider.id,
          integration_name: provider.code,
          direction: 'outbound',
          status: 'started',
          external_reference: null,
          request_id: caller.correlationId,
          completed_at: null,
          error_message: null,
          metadata: { trigger: 'manual' },
        },
        client,
      );
      return { row: await repo.findSyncLog(client, row.id as string), alreadyRunning: false };
    });
    if (!started.alreadyRunning) this.track(this.runSync(provider, started.row, ctx));
    return { log: syncLogView(started.row, provider.publicId), alreadyRunning: started.alreadyRunning };
  }

  /**
   * POST /webhooks/{type}/{provider} (api-contract §15). In order: the provider exists, is active, has
   * an adapter that reads webhooks and a secret (404 otherwise, the same for each); the signature
   * matches (401); the timestamp is within 5 minutes (401, a replay); the adapter can read the body
   * (400). A delivery seen before is a duplicate: 202 again, nothing stored or announced twice.
   * Otherwise the delivery is stored as an inbound sync log and announced with
   * `IntegrationWebhookReceived` in the same transaction, for its consumer to process.
   */
  async receiveWebhook(delivery: WebhookDelivery): Promise<{ id: string; duplicate: boolean }> {
    const { repo, registry, log } = this.deps;
    const provider = await repo.findProviderByCode(repo.pool(), delivery.code);
    const adapter = provider ? registry.adapter(provider.code) : undefined;
    const secret = provider ? registry.secretsFor(provider.code).webhookSecret : undefined;
    if (!provider || provider.providerType !== delivery.providerType || !provider.isActive || !adapter?.normalize || !secret) {
      if (provider && provider.providerType === delivery.providerType && provider.isActive) {
        log.warn({ provider: delivery.code, event: 'integration.webhook_unconfigured', adapter: !!adapter?.normalize, secret: !!secret }, 'Webhook for a provider that cannot receive them');
      }
      throw webhookProviderNotFound();
    }

    const signature = verifyWebhook({
      secret,
      signature: delivery.header(SIGNATURE_HEADER),
      timestamp: delivery.header(TIMESTAMP_HEADER),
      rawBody: delivery.rawBody,
      now: this.now(),
    });
    if (!signature.ok) {
      log.warn({ provider: provider.code, event: 'integration.webhook_rejected', reason: signature.reason }, 'Webhook rejected');
      throw signature.reason === 'stale_timestamp' ? webhookStale() : webhookSignatureInvalid(signature.reason);
    }

    const ctx: MutationContext = { userId: null, correlationId: delivery.correlationId };
    let normalized;
    try {
      normalized = adapter.normalize(delivery.body);
    } catch (err) {
      if (!(err instanceof WebhookPayloadError)) throw err;
      // Signed, so it is the provider's: worth a failed row on its status, unlike a forged delivery.
      await repo.inTransaction((client) =>
        repo.insertSyncLog(ctx, inboundLog(provider, delivery, 'failed', null, err.message, { trigger: 'webhook' }), client),
      );
      throw new AppError(400, 'VALIDATION_FAILED', 'The webhook body is not one this provider sends.', [{ field: err.field, reason: err.reason }]);
    }

    const seen = await repo.findInbound(repo.pool(), provider.id, normalized.eventId);
    if (seen) return { id: seen.publicId, duplicate: true };

    try {
      return await repo.inTransaction(async (client) => {
        const metadata = {
          trigger: 'webhook' as const,
          kind: normalized.kind,
          occurred_at: normalized.occurredAt?.toISOString() ?? null,
          data: normalized.data,
        };
        const row = await repo.insertSyncLog(ctx, inboundLog(provider, delivery, 'succeeded', normalized.eventId, null, metadata), client);
        const stored = await repo.findSyncLog(client, row.id as string);
        await this.deps.events.publish(client, [
          createEvent(
            INTEGRATION_EVENTS.webhookReceived,
            {
              sync_log_id: stored.publicId,
              provider_id: provider.publicId,
              provider_code: provider.code,
              provider_type: provider.providerType,
              event_id: normalized.eventId,
              kind: normalized.kind,
              occurred_at: metadata.occurred_at,
            },
            { actor: null, correlationId: delivery.correlationId },
            // The same delivery always gets the same event id, so even a race past the index publishes it once.
            { id: deterministicEventId(`webhook:${provider.publicId}:${normalized.eventId}`), aggregate: aggregateKey('provider', provider.publicId) },
          ),
        ]);
        return { id: stored.publicId, duplicate: false };
      });
    } catch (err) {
      // Two deliveries of one event at the same moment: the index lets one in; the other is a duplicate.
      if ((err as { constraint?: string }).constraint !== INBOUND_REFERENCE_INDEX) throw err;
      const first = await repo.findInbound(repo.pool(), provider.id, normalized.eventId);
      return { id: first!.publicId, duplicate: true };
    }
  }

  /**
   * For another module calling a provider (the mapping adapter, notifications): the provider's client
   * (timeout, retries, breaker) and API key. The provider must exist and be active.
   */
  async contextFor(code: string, correlationId: string): Promise<AdapterContext> {
    const { repo, registry } = this.deps;
    const provider = await repo.findProviderByCode(repo.pool(), code);
    if (!provider) throw providerNotFound();
    if (!provider.isActive) throw providerInactive();
    return registry.context(provider, correlationId);
  }

  /** Resolves when every sync started so far has finished (tests, a graceful shutdown). */
  async settled(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running]);
  }

  private track(work: Promise<void>): void {
    const done = work.finally(() => this.running.delete(done));
    this.running.add(done);
  }

  private async runSync(provider: ProviderRow, started: SyncLogRow, ctx: MutationContext): Promise<void> {
    const { repo, registry, log } = this.deps;
    const adapter = registry.adapter(provider.code)!;
    let update;
    try {
      const outcome = await adapter.sync!(registry.context(provider, ctx.correlationId));
      update = {
        status: outcome.status,
        error_message: null,
        external_reference: outcome.externalReference ?? null,
        metadata: { ...started.metadata, records: outcome.records },
      };
    } catch (err) {
      const message = failureMessage(err);
      if (!(err instanceof ProviderCallError)) log.error({ err, provider: provider.code, event: 'integration.sync_crashed' }, 'Provider sync failed');
      else log.warn({ provider: provider.code, event: 'integration.sync_failed', kind: err.kind }, message);
      update = { status: 'failed' as const, error_message: message, metadata: started.metadata };
    }
    try {
      await repo.inTransaction((client) => repo.completeSyncLog(ctx, started.id, { ...update, completed_at: new Date(this.now()) }, client));
    } catch (err) {
      log.error({ err, provider: provider.code, event: 'integration.sync_log_failed' }, 'Could not complete the sync log');
    }
  }

  private async checkHealth(provider: ProviderRow, correlationId: string): Promise<void> {
    const { registry } = this.deps;
    const adapter = registry.adapter(provider.code);
    if (!adapter?.healthCheck) return;
    let error: string | null = null;
    try {
      let timer: NodeJS.Timeout | undefined;
      const budget = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ProviderCallError('timeout', `The health check took longer than ${HEALTH_CHECK_BUDGET_MS} ms.`)), HEALTH_CHECK_BUDGET_MS);
      });
      await Promise.race([adapter.healthCheck(registry.context(provider, correlationId)), budget]).finally(() => clearTimeout(timer));
    } catch (err) {
      error = failureMessage(err);
    }
    registry.recordHealth(provider, { checked_at: new Date(this.now()), healthy: error === null, error });
  }
}

function inboundLog(
  provider: ProviderRow,
  delivery: WebhookDelivery,
  status: 'succeeded' | 'failed',
  eventId: string | null,
  error: string | null,
  metadata: Record<string, unknown>,
) {
  return {
    provider_id: provider.id,
    integration_name: provider.code,
    direction: 'inbound' as const,
    status,
    external_reference: eventId,
    request_id: delivery.correlationId,
    completed_at: new Date(),
    error_message: error,
    metadata,
  };
}

/** What is stored and shown about a failure: our own words for it, never a provider's response or a stack. */
function failureMessage(err: unknown): string {
  if (err instanceof ProviderCallError || err instanceof WebhookPayloadError) return err.message;
  return 'The sync failed with an internal error; see the server log.';
}

/** One word for the provider's state on the status screen. */
export function statusOf(
  provider: ProviderRow,
  lastSuccessAt: Date | null,
  lastFailureAt: Date | null,
  circuit: 'closed' | 'open' | 'half_open' | null,
  healthy: boolean | null,
): ProviderStatus {
  if (!provider.isActive) return 'inactive';
  if (circuit === 'open') return 'down';
  if (circuit === 'half_open' || healthy === false) return 'degraded';
  if (lastFailureAt && (!lastSuccessAt || lastFailureAt > lastSuccessAt)) return 'degraded';
  if (lastSuccessAt || healthy) return 'operational';
  return 'unknown';
}

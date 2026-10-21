import { AppError } from '../../../shared/errors/app-error';
import type { ProviderType } from './adapter';

export type CircuitState = 'closed' | 'open' | 'half_open';

/** The breaker of one provider on this API instance (each instance keeps its own). */
export interface CircuitView {
  state: CircuitState;
  /** When it last opened; null while it has not. */
  opened_at: Date | null;
  /** While open: when a trial call will be let through. */
  retry_at: Date | null;
  /** Counts over the rolling window (60 s). */
  window: { calls: number; successes: number; failures: number; timeouts: number; rejected: number };
  latency_mean_ms: number;
}

export type ProviderStatus = 'operational' | 'degraded' | 'down' | 'unknown' | 'inactive';

/**
 * GET /integrations/providers (api-contract §15). The settings in `configuration` and the secrets
 * from the environment are never returned: only whether a webhook secret is set.
 */
export interface ProviderView {
  id: string;
  code: string;
  name: string;
  provider_type: ProviderType;
  is_active: boolean;
  status: ProviderStatus;
  /** What its adapter does; all false for a provider without an adapter in this build. */
  capabilities: { sync: boolean; webhooks: boolean; health_check: boolean };
  webhook_secret_configured: boolean;
  last_success_at: Date | null;
  last_failure_at: Date | null;
  /** The message of the last failure (a status, a timeout), never the provider's response. */
  last_error: string | null;
  last_sync: SyncLogView | null;
  circuit: CircuitView | null;
  /** The result of `?check=true`, or of the last check on this instance. */
  health: { checked_at: Date; healthy: boolean; error: string | null } | null;
}

export type SyncDirection = 'inbound' | 'outbound';
export type SyncStatus = 'started' | 'succeeded' | 'failed' | 'partial';
/** What started a sync: someone pressing sync, or a provider's webhook. */
export type SyncTrigger = 'manual' | 'webhook';

/** One exchange with a provider: integration.sync_logs. */
export interface SyncLogView {
  id: string;
  provider_id: string | null;
  direction: SyncDirection;
  status: SyncStatus;
  trigger: SyncTrigger | null;
  /** For a webhook, what the delivery was about (`position`). */
  kind: string | null;
  records: number | null;
  /** The provider's id for the exchange: a webhook's event id, a sync's batch. */
  external_reference: string | null;
  request_id: string | null;
  started_at: Date;
  completed_at: Date | null;
  error_message: string | null;
}

export const INTEGRATION_EVENTS = {
  /**
   * A signed webhook was accepted and stored (FMS-85). Its consumer, by `provider_type` and `kind`,
   * reads the normalised data with `webhookDeliveries.find` (integration/index.ts).
   */
  webhookReceived: 'IntegrationWebhookReceived',
} as const;

export const providerNotFound = () => new AppError(404, 'NOT_FOUND', 'Provider not found.');

/** The same answer for an unknown provider, one that is switched off and one with no secret: nothing to tell a caller. */
export const webhookProviderNotFound = () => new AppError(404, 'NOT_FOUND', 'No webhook receiver for this provider.');

export const providerInactive = () =>
  new AppError(400, 'VALIDATION_FAILED', 'The provider is switched off.', [{ field: 'provider_id', reason: 'provider_inactive' }]);

export const syncNotSupported = () =>
  new AppError(400, 'VALIDATION_FAILED', 'This provider has no sync.', [{ field: 'provider_id', reason: 'sync_not_supported' }]);

/** The breaker is open: fail fast, and say when to try again. */
export const providerUnavailable = (retryInMs: number) => {
  const seconds = Math.max(1, Math.ceil(retryInMs / 1000));
  return new AppError(503, 'UPSTREAM_UNAVAILABLE', `The provider is failing; calls to it are paused. Try again in ${seconds} s.`, undefined, {
    'Retry-After': String(seconds),
  });
};

export const webhookSignatureInvalid = (reason: string) =>
  new AppError(401, 'AUTH_TOKEN_INVALID', 'The webhook signature is missing or does not match.', [{ field: 'X-FMS-Signature', reason }]);

/** A correctly signed delivery outside the replay window: a replay, or a provider clock far off. */
export const webhookStale = () =>
  new AppError(401, 'AUTH_TOKEN_EXPIRED', 'The webhook timestamp is more than 5 minutes from the server time.', [
    { field: 'X-FMS-Timestamp', reason: 'stale_timestamp' },
  ]);

export const webhookNotJson = () => new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Webhooks are accepted as application/json only.');

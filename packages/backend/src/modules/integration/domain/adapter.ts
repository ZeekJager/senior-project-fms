// The adapter contract (FMS-85, architecture §15): every external provider is reached through one
// adapter, so a provider can be swapped and its failures stay inside the integration module.

/** integration.provider_type. */
export const PROVIDER_TYPES = ['telematics', 'notification', 'mapping', 'traffic', 'weather', 'ev_charging', 'fuel_card', 'other'] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** One request to a provider, relative to its `base_url`. */
export interface ProviderRequest {
  method: HttpMethod;
  /** Path under the provider's base URL: `/vehicles`. */
  path: string;
  query?: Record<string, string | number | boolean>;
  headers?: Record<string, string>;
  /** Sent as JSON. */
  body?: unknown;
  /**
   * Safe to send twice. GET, HEAD, PUT and DELETE are; POST and PATCH only when the provider
   * de-duplicates them (an idempotency key header). Only these are retried.
   */
  idempotent?: boolean;
}

export interface ProviderResponse<T = unknown> {
  status: number;
  headers: Headers;
  /** Parsed JSON, or the text when the provider did not send JSON. */
  body: T;
}

/**
 * The one way to call a provider (FMS-85): a timeout on every attempt, retries with jitter for
 * idempotent calls, and the provider's circuit breaker, which fails calls fast while it is open.
 */
export interface ProviderClient {
  call<T = unknown>(request: ProviderRequest): Promise<ProviderResponse<T>>;
}

/** What an adapter gets for one operation. */
export interface AdapterContext {
  client: ProviderClient;
  /** The provider's `code`, `base_url` and settings (never its secrets). */
  provider: { code: string; type: ProviderType; baseUrl: string | null; configuration: Record<string, unknown> };
  /** From the environment (`INTEGRATION_<CODE>_API_KEY`); send it, never log it. */
  apiKey: string | undefined;
  correlationId: string;
}

/** What a sync brought in. */
export interface SyncOutcome {
  /** `partial` when some records failed and the rest were taken. */
  status: 'succeeded' | 'partial';
  records: number;
  /** The provider's id for this exchange (a batch or cursor), kept on the sync log. */
  externalReference?: string;
}

/** A webhook delivery in the system's terms: what the receiver stores and announces. */
export interface NormalizedWebhook {
  /** The provider's id for the event: the de-duplication key of a redelivery. */
  eventId: string;
  /** What happened, in the adapter's words (`position`, `transaction`, `session_ended`). */
  kind: string;
  /** When it happened at the provider; the receipt time when the provider does not say. */
  occurredAt: Date | null;
  /** The event's data, normalised (units converted, fields renamed). Kept for the consumer that handles `kind`. */
  data: Record<string, unknown>;
}

/**
 * One provider integration. `code` matches `integration.external_providers.code`.
 * - `healthCheck`: a cheap call that proves the provider answers (status endpoint, `?check=true`).
 * - `sync`: pull from (or push to) the provider through `ctx.client` (`POST .../sync`).
 * - `normalize`: turn a verified webhook body into a `NormalizedWebhook`, or throw a
 *   `WebhookPayloadError` saying which field is wrong. Pure: no I/O.
 * An adapter leaves out what its provider does not do.
 */
export interface ProviderAdapter {
  readonly code: string;
  healthCheck?(ctx: AdapterContext): Promise<void>;
  sync?(ctx: AdapterContext): Promise<SyncOutcome>;
  normalize?(body: unknown): NormalizedWebhook;
}

/** A webhook body the adapter cannot read. `field` names what is wrong; the payload is never echoed. */
export class WebhookPayloadError extends Error {
  constructor(
    readonly field: string,
    readonly reason: string,
  ) {
    super(`Webhook payload: ${field} ${reason}`);
    this.name = 'WebhookPayloadError';
  }
}

/**
 * Why a call to a provider failed. Messages are safe to store and show: the method and path,
 * a status code, a time; never the provider's response body, the query string or a credential.
 */
export type ProviderFailure = 'timeout' | 'network' | 'http' | 'circuit_open';

export class ProviderCallError extends Error {
  constructor(
    readonly kind: ProviderFailure,
    message: string,
    /** The HTTP status for `http`. */
    readonly status?: number,
    /** Milliseconds until the breaker lets a call through again, for `circuit_open`. */
    readonly retryInMs?: number,
  ) {
    super(message);
    this.name = 'ProviderCallError';
  }

  /** Worth another attempt: the provider may answer next time. */
  get retryable(): boolean {
    if (this.kind === 'timeout' || this.kind === 'network') return true;
    if (this.kind === 'http') return this.status === 408 || this.status === 429 || (this.status ?? 0) >= 500;
    return false;
  }

  /**
   * Says something about the provider's health, so the breaker counts it. A 4xx other than 408 and 429
   * is the request's fault (a bad id, an expired key): the provider is up, and the breaker stays closed.
   */
  get countsAgainstProvider(): boolean {
    return this.kind !== 'http' || this.retryable;
  }
}

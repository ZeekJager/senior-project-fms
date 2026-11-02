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
  /** Sent as they are, instead of `body` (an encrypted Web Push message); give their content-type in `headers`. */
  bytes?: Uint8Array;
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
  /** The per-attempt timeout from the provider's settings, for a call that does not go through `client` (SMTP). */
  timeoutMs: number;
  /**
   * Runs a call that is not HTTP (SMTP) through the provider's breaker: it fails fast with
   * `ProviderCallError('circuit_open')` while the breaker is open, and its failures count.
   */
  guard<T>(action: () => Promise<T>): Promise<T>;
  /**
   * A client for another base URL behind the same breaker and settings: for a provider whose address comes
   * with each message (a Web Push endpoint). It sends no credential of its own; the adapter checks the host.
   */
  clientFor(baseUrl: string): ProviderClient;
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

/** The channels a notification provider delivers on (FMS-93): its row's `configuration.channel`. */
export const NOTIFICATION_CHANNELS = ['email', 'sms', 'push'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** A browser's Web Push subscription: its endpoint, P-256 key and auth secret (base64url). */
export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** One message to one recipient on one channel (FMS-93). */
export interface OutboundMessage {
  channel: NotificationChannel;
  /** Our id for the message (the notification's public id): sent as the provider's idempotency key, so a retry is not sent twice. */
  reference: string;
  /** The address for the channel: an email address, a phone number, or a push subscription. */
  to: { email?: string; name?: string; phone?: string; push?: PushTarget };
  /** The email's subject and the push notification's title. */
  subject: string;
  /** Plain text: the email's body, the SMS, the push notification's body. */
  text: string;
  /** For push: what the notification opens (`url`) and groups by (`tag`). */
  data?: Record<string, unknown>;
  /** `high` wakes a phone at once (push), for critical alerts. */
  urgency: 'normal' | 'high';
  /** How long a push service may hold the message for an offline device. */
  ttlSeconds: number;
}

export interface DeliveryReceipt {
  /** The provider's id for the message (an SMTP Message-ID, an SMS id, a push message's location), if it gave one. */
  messageId: string | null;
}

/** Why a message can never be delivered as it is: not worth another attempt. */
export type RefusalReason = 'invalid_destination' | 'subscription_expired' | 'payload_too_large' | 'recipient_rejected';

/** The provider refused this message for good (a bad address, a push subscription that has expired). */
export class DeliveryRefused extends Error {
  constructor(
    readonly reason: RefusalReason,
    message: string,
  ) {
    super(message);
    this.name = 'DeliveryRefused';
  }
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
  /**
   * Sends one message (FMS-93): resolves with the provider's receipt, or throws a `ProviderCallError` (worth a
   * retry if `retryable`) or a `DeliveryRefused` (never worth one).
   */
  deliver?(ctx: AdapterContext, message: OutboundMessage): Promise<DeliveryReceipt>;
  /** Why this provider could never deliver to an address (a push endpoint on a host it does not trust), or null. Pure. */
  destinationProblem?(configuration: Record<string, unknown>, to: OutboundMessage['to']): string | null;
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

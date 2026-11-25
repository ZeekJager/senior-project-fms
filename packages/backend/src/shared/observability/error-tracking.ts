import * as Sentry from '@sentry/node';

// Error tracking (FMS-109, docs/observability.md): every error the API answers 5xx for goes to Sentry's protocol (the
// self-hosted GlitchTip of docker-compose.observability.yml, or Sentry), tagged with its request id, so the error a
// user reports by its request id is found. Off without SENTRY_DSN. Nothing personal leaves: no cookies, headers,
// bodies, query strings, IP addresses or users' details, and e-mail addresses, phone numbers, tokens and long
// numbers in messages are masked first (scrubEvent).

type SentryEvent = Sentry.ErrorEvent;

let enabled = false;

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// +251 9xx xxx xxx, 09xxxxxxxx and the like: 9 or more digits, with spaces, dots or dashes between.
const PHONE = /\+?\d(?:[\s.-]?\d){8,}/g;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
// JWTs, API keys and other long opaque strings.
const TOKEN = /\b(?:eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|[A-Za-z0-9_-]{32,})\b/g;
const SECRET_KEYS = /pass(word)?|secret|token|authorization|cookie|api[-_]?key|license|licence|phone|email/i;

/** Masks what may identify a person or open an account in a string. */
export function scrubText(text: string): string {
  return text.replace(BEARER, '$1 [Filtered]').replace(EMAIL, '[email]').replace(TOKEN, '[token]').replace(PHONE, '[number]');
}

function scrubValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[Filtered]';
  if (typeof value === 'string') return scrubText(value);
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SECRET_KEYS.test(k) ? '[Filtered]' : scrubValue(v, depth + 1)]));
  }
  return value;
}

/** What may leave for the error tracker (beforeSend): the request's method and route only; no user but an id. */
export function scrubEvent(event: SentryEvent): SentryEvent {
  const out: SentryEvent = { ...event };
  if (out.request) out.request = { method: out.request.method, url: out.request.url ? scrubText(out.request.url.split('?')[0]) : undefined };
  if (out.user) out.user = out.user.id ? { id: String(out.user.id) } : undefined;
  if (out.message) out.message = scrubText(out.message);
  if (out.exception?.values) {
    out.exception = {
      ...out.exception,
      values: out.exception.values.map((v) => ({ ...v, value: v.value ? scrubText(v.value) : v.value })),
    };
  }
  if (out.extra) out.extra = scrubValue(out.extra) as Record<string, unknown>;
  if (out.contexts) out.contexts = scrubValue(out.contexts) as SentryEvent['contexts'];
  if (out.breadcrumbs) out.breadcrumbs = out.breadcrumbs.map((b) => ({ ...b, message: b.message ? scrubText(b.message) : b.message, data: b.data ? (scrubValue(b.data) as Record<string, unknown>) : b.data }));
  delete out.server_name;
  return out;
}

export interface ErrorTrackingOptions {
  dsn: string;
  environment: string;
  release?: string;
  /** Tests: where events go instead of the network. */
  transport?: Parameters<typeof Sentry.init>[0] extends infer O ? (O extends { transport?: infer T } ? T : never) : never;
}

/** Starts error tracking once (src/server.ts, src/app.ts for tests); a second call changes nothing. */
export function initErrorTracking(options: ErrorTrackingOptions | null): void {
  if (!options || enabled) return;
  Sentry.init({
    dsn: options.dsn,
    environment: options.environment,
    release: options.release,
    // Errors only: tracing stays with Prometheus.
    tracesSampleRate: 0,
    defaultIntegrations: false,
    integrations: [Sentry.linkedErrorsIntegration(), Sentry.dedupeIntegration()],
    beforeSend: (event) => scrubEvent(event),
    beforeBreadcrumb: () => null,
    ...(options.transport ? { transport: options.transport } : {}),
  });
  enabled = true;
}

/** An error the API answered 5xx for, with what finds it again: the request id, the route template and the method. */
export function captureServerError(err: unknown, context: { requestId: string; method: string; route: string | null; userPublicId: string | null }): void {
  if (!enabled) return;
  Sentry.withScope((scope) => {
    scope.setTag('request_id', context.requestId);
    scope.setTag('method', context.method);
    if (context.route) scope.setTag('route', context.route);
    if (context.userPublicId) scope.setUser({ id: context.userPublicId });
    scope.setContext('request', { request_id: context.requestId, method: context.method, route: context.route });
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)));
  });
}

/** Sends what is queued, for a clean shutdown (and tests). */
export async function flushErrorTracking(timeoutMs = 2000): Promise<boolean> {
  return enabled ? Sentry.flush(timeoutMs) : true;
}

/** For tests: whether it is on. */
export const errorTrackingEnabled = () => enabled;

import * as Sentry from '@sentry/react'
import { ApiError } from '@/lib/api/errors'

// Error tracking in the web app (FMS-109, docs/observability.md): a screen that fails to render, and an unexpected
// API failure behind it, go to Sentry's protocol (the self-hosted GlitchTip), with the API's request id when there is
// one, so the server's error and the screen's are found together. Off without VITE_SENTRY_DSN. Nothing personal
// leaves: no user but an id, no URLs' queries, no form contents, and addresses, phone numbers and tokens are masked.

type SentryEvent = Sentry.ErrorEvent

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
const PHONE = /\+?\d(?:[\s.-]?\d){8,}/g
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi
const TOKEN = /\b(?:eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|[A-Za-z0-9_-]{32,})\b/g

let enabled = false

export function scrubText(text: string): string {
  return text.replace(BEARER, '$1 [Filtered]').replace(EMAIL, '[email]').replace(TOKEN, '[token]').replace(PHONE, '[number]')
}

/** What may leave: the page's path (no query), masked messages, the user's id only, no breadcrumbs. */
export function scrubEvent(event: SentryEvent): SentryEvent {
  const out: SentryEvent = { ...event, breadcrumbs: undefined }
  if (out.request) out.request = { url: out.request.url ? out.request.url.split('?')[0].split('#')[0] : undefined }
  if (out.user) out.user = out.user.id ? { id: String(out.user.id) } : undefined
  if (out.message) out.message = scrubText(out.message)
  if (out.exception?.values) out.exception = { ...out.exception, values: out.exception.values.map((v) => ({ ...v, value: v.value ? scrubText(v.value) : v.value })) }
  return out
}

/** Starts it once (main.tsx), when the build names a DSN. */
export function initErrorTracking(dsn: string | undefined = import.meta.env.VITE_SENTRY_DSN as string | undefined, options: { transport?: Parameters<typeof Sentry.init>[0] extends infer O ? (O extends { transport?: infer T } ? T : never) : never } = {}): void {
  if (!dsn || enabled) return
  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,
    // Errors only, and none of the integrations that read the page (breadcrumbs of clicks and inputs, replays).
    defaultIntegrations: false,
    integrations: [Sentry.globalHandlersIntegration(), Sentry.linkedErrorsIntegration(), Sentry.dedupeIntegration()],
    tracesSampleRate: 0,
    beforeSend: (event) => scrubEvent(event),
    beforeBreadcrumb: () => null,
    ...(options.transport ? { transport: options.transport } : {}),
  })
  enabled = true
}

/** A screen that failed (the error boundary): with the API's request id and error code when the cause was an API error. */
export function captureScreenError(error: unknown, where: { path: string }): void {
  if (!enabled) return
  Sentry.withScope((scope) => {
    scope.setTag('path', where.path.split('?')[0])
    if (error instanceof ApiError) {
      scope.setTag('error_code', error.code)
      if (error.requestId) scope.setTag('request_id', error.requestId)
    }
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)))
  })
}

export function flushErrorTracking(timeoutMs = 2000): Promise<boolean> {
  return enabled ? Sentry.flush(timeoutMs) : Promise.resolve(true)
}

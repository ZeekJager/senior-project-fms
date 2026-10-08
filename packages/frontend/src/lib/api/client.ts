import { ApiError, toApiError } from './errors'

const API_BASE = '/api/v1'

/** Auth endpoints answer 401 for their own reasons; they never trigger a refresh-and-retry. */
const AUTH_PATHS = ['/auth/login', '/auth/refresh', '/auth/logout']

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  /** Serialised as JSON. */
  json?: unknown
}

export interface ApiClient {
  /** Calls the API and returns `body.data`. Throws ApiError for any non-2xx response. */
  request<T = unknown>(path: string, options?: RequestOptions): Promise<T>
  /**
   * Rotates the session cookies. Concurrent callers share one request:
   * the server treats a refresh cookie presented twice as theft and revokes
   * the whole session (docs/auth.md).
   */
  refresh<T = unknown>(): Promise<T>
  /** Called when the session can no longer be recovered. Returns an unsubscribe function. */
  onSessionEnded(handler: () => void): () => void
}

/**
 * The API client. The access and refresh tokens live in HttpOnly cookies
 * that page scripts cannot read, so the client holds no token: it sends
 * cookies with each request and, on `401 AUTH_TOKEN_EXPIRED`, refreshes once
 * and retries the original request once. A second 401 ends the session.
 */
export function createApiClient(fetchImpl: typeof fetch = (...args) => fetch(...args)): ApiClient {
  const sessionEndedHandlers = new Set<() => void>()
  let inflightRefresh: Promise<unknown> | undefined

  const endSession = () => sessionEndedHandlers.forEach((handler) => handler())

  async function send<T>(path: string, options: RequestOptions): Promise<T> {
    const { json, headers, ...init } = options
    const res = await fetchImpl(`${API_BASE}${path}`, {
      credentials: 'same-origin',
      ...init,
      headers: { Accept: 'application/json', ...(json === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: json === undefined ? undefined : JSON.stringify(json),
    })
    if (!res.ok) throw await toApiError(res)
    if (res.status === 204) return undefined as T
    return ((await res.json()) as { data: T }).data
  }

  function refresh<T>(): Promise<T> {
    inflightRefresh ??= send('/auth/refresh', { method: 'POST' }).finally(() => {
      inflightRefresh = undefined
    })
    return inflightRefresh as Promise<T>
  }

  async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    try {
      return await send<T>(path, options)
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 401 || AUTH_PATHS.includes(path)) throw err

      // Only an expired access token is recoverable. Invalid or revoked
      // tokens mean the session is gone.
      if (err.code !== 'AUTH_TOKEN_EXPIRED') {
        endSession()
        throw err
      }
      try {
        await refresh()
      } catch (refreshErr) {
        // Only a rejection ends the session; a network or server failure
        // leaves the cookies valid so the user can retry.
        if (refreshErr instanceof ApiError && refreshErr.status < 500) endSession()
        throw refreshErr
      }
      try {
        return await send<T>(path, options)
      } catch (retryErr) {
        if (retryErr instanceof ApiError && retryErr.status === 401) endSession()
        throw retryErr
      }
    }
  }

  return {
    request,
    refresh,
    onSessionEnded(handler) {
      sessionEndedHandlers.add(handler)
      return () => sessionEndedHandlers.delete(handler)
    },
  }
}

/** The app-wide client. */
export const api = createApiClient()

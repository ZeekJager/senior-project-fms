// What the driver app's service worker does with each request (FMS-34). Pure,
// so it is unit-tested here and shared with src/service-worker.ts.
//
// Only the driver screens work offline. Their pages are served from the
// cached app shell; every other page goes to the network, and offline gets
// the fallback page, so the staff screens are never served from the cache.

/** /driver and /driver/... (S-11 to S-14). Not /drivers, the staff screen. */
const DRIVER_PATH = /^\/driver(\/|$)/

export const isDriverPath = (pathname: string) => DRIVER_PATH.test(pathname)

/** The cached app shell the driver pages are served from offline. */
export const APP_SHELL = '/index.html'
/** Shown for any other page while offline. */
export const OFFLINE_PAGE = '/offline.html'
/** Where the driver's last session is kept in the session cache (never a token: the body of /auth/refresh). */
export const SESSION_KEY = '/__fms/offline-session'
/** The refresh token lives 7 days (docs/auth.md): an older saved session would not survive going online. */
export const OFFLINE_SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
/** A driver page waits this long for the network before the cached shell is used. */
export const NAVIGATION_TIMEOUT_MS = 4000

const SESSION_PATHS = ['/api/v1/auth/refresh', '/api/v1/auth/login']
const SESSION_END = '/api/v1/auth/logout'

export type Route =
  /** POST /auth/refresh or /auth/login: kept for offline use when it is a driver's; refresh answered from it when offline. */
  | 'session'
  /** POST /auth/logout: the saved session is dropped, whatever the network says. */
  | 'session-end'
  /** A /driver page: network first, then the cached shell. */
  | 'driver-page'
  /** Any other page: network only, then the offline page. */
  | 'other-page'
  /** A file in the precache: cache first. */
  | 'precached'
  /** Everything else (API reads and writes, other origins): untouched. */
  | 'pass'

export function routeFor(request: { method: string; mode: string; url: string }, origin: string, precached: ReadonlySet<string>): Route {
  const url = new URL(request.url)
  if (url.origin !== origin) return 'pass'
  if (request.method === 'POST' && SESSION_PATHS.includes(url.pathname)) return 'session'
  if (request.method === 'POST' && url.pathname === SESSION_END) return 'session-end'
  if (request.method !== 'GET') return 'pass'
  if (request.mode === 'navigate') return isDriverPath(url.pathname) ? 'driver-page' : 'other-page'
  return precached.has(url.pathname) ? 'precached' : 'pass'
}

/** Only a driver's session is kept: a staff account on the same phone never works offline. */
export function isDriverSession(body: unknown): boolean {
  const roles = (body as { data?: { roles?: unknown } } | null)?.data?.roles
  return Array.isArray(roles) && roles.includes('driver')
}

/** The message the driver portal posts once the worker is ready: the session it already holds, to keep for offline use. */
export const SESSION_MESSAGE = 'fms-driver-session'

/** A saved session is offered while the refresh token it came with could still be valid. */
export const sessionUsable = (savedAt: number, now: number) => now - savedAt >= 0 && now - savedAt < OFFLINE_SESSION_MAX_AGE_MS

/** The cache names for a build: a new build gets a new shell cache, the old one is deleted. */
export function cacheNames(buildId: string) {
  return { shell: `fms-driver-shell-${buildId}`, session: 'fms-driver-session' }
}

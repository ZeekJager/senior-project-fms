/// <reference lib="webworker" />
// The driver app's service worker (FMS-34). Built by build/pwa.ts into /sw.js,
// with the files to precache and the build id injected. Registered only from
// the driver portal (src/pwa/useDriverPwa.ts), never for staff accounts.
//
// - The app shell (index.html, scripts, styles, fonts, icons, the offline
//   page) is cached at install, per build.
// - /driver pages: network first, then the cached shell, so the Driver Home
//   opens with no connection. Every other page: network only, then the
//   offline page. Nothing the staff screens show is ever cached.
// - The driver's last session (the body of /auth/refresh or /auth/login, never
//   a token) is kept, so a refresh that cannot reach the server is answered
//   from it and the driver stays signed in offline. Sign-out drops it.

import { APP_SHELL, NAVIGATION_TIMEOUT_MS, OFFLINE_PAGE, SESSION_KEY, SESSION_MESSAGE, cacheNames, isDriverSession, routeFor, sessionUsable } from './pwa/routing'

declare const self: ServiceWorkerGlobalScope
declare const __PRECACHE_MANIFEST__: { url: string; revision: string }[]
declare const __BUILD_ID__: string

// Named once, so the build inlines the list once.
const MANIFEST = __PRECACHE_MANIFEST__
const CACHES = cacheNames(__BUILD_ID__)
const PRECACHED = new Set(MANIFEST.map((entry) => entry.url))

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHES.shell)
      // `reload`: the files of this build, never an HTTP-cached older copy.
      await Promise.all(MANIFEST.map(({ url }) => cache.add(new Request(url, { cache: 'reload' }))))
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(names.filter((name) => name.startsWith('fms-driver-shell-') && name !== CACHES.shell).map((name) => caches.delete(name)))
      // The first install takes the open page too, so it works offline at once.
      await self.clients.claim()
    })(),
  )
})

// The first visit signs in before this worker exists, so no session has passed
// through it yet: the driver portal sends the one it holds once the worker is ready.
self.addEventListener('message', (event) => {
  const message = event.data as { type?: unknown; session?: unknown } | null
  if (message?.type !== SESSION_MESSAGE) return
  const body = { data: message.session, meta: {} }
  if (isDriverSession(body)) event.waitUntil(adoptSession(body))
})

self.addEventListener('fetch', (event) => {
  switch (routeFor(event.request, self.location.origin, PRECACHED)) {
    case 'session':
      return event.respondWith(session(event.request))
    case 'session-end':
      return event.respondWith(sessionEnd(event.request))
    case 'driver-page':
      return event.respondWith(driverPage(event.request))
    case 'other-page':
      return event.respondWith(fetch(event.request).catch(() => fromShell(OFFLINE_PAGE)))
    case 'precached':
      return event.respondWith(fromShell(new URL(event.request.url).pathname).then((hit) => hit ?? fetch(event.request)))
    case 'pass':
      return
  }
})

async function fromShell(path: string): Promise<Response> {
  const hit = await (await caches.open(CACHES.shell)).match(path)
  return hit ?? Response.error()
}

/** Network first with a timeout; the cached shell when the network is slow or gone. */
async function driverPage(request: Request): Promise<Response> {
  const network = fetch(request)
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), NAVIGATION_TIMEOUT_MS))
  try {
    const answer = await Promise.race([network, timeout])
    if (answer) return answer
  } catch {
    // Offline: the shell below.
  }
  const shell = await (await caches.open(CACHES.shell)).match(APP_SHELL)
  return shell ?? network
}

async function session(request: Request): Promise<Response> {
  const isRefresh = new URL(request.url).pathname.endsWith('/refresh')
  const store = await caches.open(CACHES.session)
  let response: Response
  try {
    response = await fetch(request)
  } catch (err) {
    // Offline: a refresh is answered from the driver's saved session, marked as such.
    const saved = isRefresh ? await store.match(SESSION_KEY) : undefined
    const savedAt = Number(saved?.headers.get('x-fms-saved-at'))
    if (saved && sessionUsable(savedAt, Date.now())) {
      return new Response(await saved.text(), { status: 200, headers: { 'content-type': 'application/json', 'x-fms-offline': 'true' } })
    }
    throw err
  }
  if (response.ok) {
    const body: unknown = await response
      .clone()
      .json()
      .catch(() => null)
    if (isDriverSession(body)) {
      await saveSession(body)
    } else {
      await store.delete(SESSION_KEY)
    }
  } else if (response.status === 401) {
    // The server ended the session: nothing to keep.
    await store.delete(SESSION_KEY)
  }
  return response
}

async function saveSession(body: unknown): Promise<void> {
  const store = await caches.open(CACHES.session)
  await store.put(SESSION_KEY, new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', 'x-fms-saved-at': String(Date.now()) } }))
}

/**
 * A session the page sent: kept only when none is saved for that user. It
 * never renews a saved one, so offline starts (which send it again) cannot
 * stretch the 7 days; only a session from the server does.
 */
async function adoptSession(body: { data: unknown }): Promise<void> {
  const saved = await (await caches.open(CACHES.session)).match(SESSION_KEY)
  const savedUser = saved ? ((await saved.json().catch(() => null)) as { data?: { user?: { id?: unknown } } } | null)?.data?.user?.id : undefined
  const user = (body.data as { user?: { id?: unknown } } | null)?.user?.id
  if (saved && savedUser === user) return
  await saveSession(body)
}

async function sessionEnd(request: Request): Promise<Response> {
  await (await caches.open(CACHES.session)).delete(SESSION_KEY)
  return fetch(request)
}

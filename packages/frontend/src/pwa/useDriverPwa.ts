import { useCallback, useEffect, useState } from 'react'
import type { CurrentUser } from '@/context/AuthContext'
import type { ApiClient } from '@/lib/api/client'
import { SESSION_MESSAGE } from './routing'
import { useConnectivity } from './useConnectivity'

/**
 * The driver app (FMS-34): installable, and its pages open without a
 * connection. Used by the driver portal only, so staff never get a service
 * worker or an install offer:
 *
 * - links the web app manifest (and the theme colour and touch icon) while
 *   the driver portal is on screen;
 * - registers /sw.js in production builds (the dev server has none), and
 *   hands it the driver's session for offline use;
 * - tracks whether the phone is online, and Chrome's install offer
 *   (`beforeinstallprompt`), which it leaves showing: the card wants Chrome's
 *   own "Add to Home Screen" prompt, and the app offers a button as well.
 */

/** Chrome's install offer (not in the DOM typings). */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const HEAD_TAGS: { tag: 'link' | 'meta'; attrs: Record<string, string> }[] = [
  { tag: 'link', attrs: { rel: 'manifest', href: '/manifest.json' } },
  { tag: 'meta', attrs: { name: 'theme-color', content: '#4F46E5' } },
  { tag: 'link', attrs: { rel: 'apple-touch-icon', href: '/icons/apple-touch-icon.png' } },
]

/** Adds the driver app's head tags; returns a function that takes them out again. */
export function linkDriverManifest(doc: Document = document): () => void {
  const added = HEAD_TAGS.map(({ tag, attrs }) => {
    const el = doc.createElement(tag)
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
    el.dataset.driverApp = ''
    doc.head.appendChild(el)
    return el
  })
  return () => added.forEach((el) => el.remove())
}

/** Registers the driver app's service worker, in production builds only. */
export function registerDriverServiceWorker(production: boolean = import.meta.env.PROD, nav: Navigator = navigator): Promise<ServiceWorkerRegistration | null> {
  if (!production || !('serviceWorker' in nav)) return Promise.resolve(null)
  return nav.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => null)
}

/**
 * Hands the worker the session the page holds, once it is ready (and again if
 * a new worker takes over), so a driver who goes offline right after the
 * first visit stays signed in. Returns a function that stops listening.
 */
export function shareSessionWithWorker(session: CurrentUser, nav: Navigator = navigator): () => void {
  if (!('serviceWorker' in nav)) return () => {}
  const send = () => void nav.serviceWorker.ready.then((reg) => (nav.serviceWorker.controller ?? reg.active)?.postMessage({ type: SESSION_MESSAGE, session }))
  send()
  nav.serviceWorker.addEventListener('controllerchange', send)
  return () => nav.serviceWorker.removeEventListener('controllerchange', send)
}

/** Already opened from the home screen: no install offer. */
const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches === true

/**
 * `online` is false in airplane mode (`navigator.onLine`), and also when the
 * phone has a network but the server's answers come from the saved copy.
 */
export function useDriverPwa(session: CurrentUser | null, api: Pick<ApiClient, 'servedOffline' | 'onServedOfflineChange'>): { online: boolean; installable: boolean; install: () => Promise<void> } {
  const online = useConnectivity(api)
  const [offer, setOffer] = useState<InstallPromptEvent | null>(null)

  useEffect(() => {
    const unlink = linkDriverManifest()
    void registerDriverServiceWorker()
    const offered = (event: Event) => setOffer(event as InstallPromptEvent)
    const installed = () => setOffer(null)
    window.addEventListener('beforeinstallprompt', offered)
    window.addEventListener('appinstalled', installed)
    return () => {
      unlink()
      window.removeEventListener('beforeinstallprompt', offered)
      window.removeEventListener('appinstalled', installed)
    }
  }, [])

  useEffect(() => (session && import.meta.env.PROD ? shareSessionWithWorker(session) : undefined), [session])

  const install = useCallback(async () => {
    if (!offer) return
    await offer.prompt()
    await offer.userChoice.catch(() => null)
    // Chrome offers it once: accepted or not, the button goes.
    setOffer(null)
  }, [offer])

  return { online, installable: offer !== null && !standalone(), install }
}

import type { ApiClient } from '@/lib/api/client'

// Push notifications in this browser (FMS-93): the service worker (/sw.js, src/service-worker.ts) receives them
// and shows them even with FMS closed. Turning push on registers the worker if it is not yet, asks the browser's
// permission, subscribes with the server's VAPID key and saves the subscription for the signed-in user.
//
// Push stays on after signing out, so on-call staff hear about critical alerts when they are not signed in. On a
// shared computer it is turned off here; whoever turns it on next in this browser takes it over.

/** What this browser can do about push. */
export type PushSupport = 'supported' | 'unsupported' | 'no-worker'

/** The service worker is built into production builds only; the dev server has none. */
const WORKER_BUILT = import.meta.env.PROD

export function pushSupport(win: Window & typeof globalThis = window, built = WORKER_BUILT): PushSupport {
  if (!('serviceWorker' in win.navigator) || !('PushManager' in win) || !('Notification' in win)) return 'unsupported'
  return built ? 'supported' : 'no-worker'
}

/** The browser's answer to the permission prompt so far. */
export const pushPermission = (): NotificationPermission => (typeof Notification === 'undefined' ? 'denied' : Notification.permission)

/** The VAPID public key, base64url, as the bytes `applicationServerKey` takes. */
export function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(base64url.length / 4) * 4, '=')
  const raw = atob(base64)
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

async function registration(register: boolean): Promise<ServiceWorkerRegistration | null> {
  const existing = await navigator.serviceWorker.getRegistration('/')
  if (existing || !register) return existing ?? null
  await navigator.serviceWorker.register('/sw.js', { scope: '/' })
  return navigator.serviceWorker.ready
}

/** This browser's push subscription, if push is on here. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== 'supported') return null
  const reg = await registration(false)
  return (await reg?.pushManager.getSubscription()) ?? null
}

/** Why turning push on did not work: the user said no (or did before), or the browser refused. */
export class PushRefused extends Error {
  constructor(readonly reason: 'denied' | 'failed') {
    super(reason === 'denied' ? 'Notifications are blocked for this site.' : 'This browser could not turn push on.')
  }
}

/**
 * Turns push on in this browser for the signed-in user. A subscription made with another key (the server's
 * key changed) is replaced.
 */
export async function enablePush(api: Pick<ApiClient, 'request'>, publicKey: string): Promise<void> {
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new PushRefused('denied')
  let subscription: PushSubscription
  try {
    const reg = await registration(true)
    if (!reg) throw new Error('no registration')
    const key = keyBytes(publicKey)
    const existing = await reg.pushManager.getSubscription()
    const sameKey = existing?.options.applicationServerKey && new Uint8Array(existing.options.applicationServerKey).every((b, i) => b === key[i])
    if (existing && !sameKey) await existing.unsubscribe()
    subscription = existing && sameKey ? existing : await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
  } catch {
    throw new PushRefused('failed')
  }
  await api.request('/notifications/push/subscriptions', { method: 'POST', json: subscription.toJSON() })
}

/** Turns push off in this browser: the server forgets it, then the browser does. */
export async function disablePush(api: Pick<ApiClient, 'request'>): Promise<void> {
  const subscription = await currentSubscription()
  if (!subscription) return
  await api.request('/notifications/push/unsubscribe', { method: 'POST', json: { endpoint: subscription.endpoint } })
  await subscription.unsubscribe()
}

/** The server's fingerprint of an endpoint (backend alert/domain/delivery.ts endpointKey): SHA-256, base64url, 22 characters. */
export async function endpointKey(endpoint: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint)))
  let binary = ''
  for (const b of digest) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 22)
}

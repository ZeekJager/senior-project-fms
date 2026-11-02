import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { endpointKey, keyBytes, pushSupport } from './push'

// FMS-93: the browser side of push.

describe('push', () => {
  it('reads the server’s VAPID key into the bytes the browser subscribes with', () => {
    const bytes = Uint8Array.from({ length: 65 }, (_, i) => (i * 37) % 256)
    const b64url = Buffer.from(bytes).toString('base64url')
    expect(Array.from(keyBytes(b64url))).toEqual(Array.from(bytes))
  })

  it('fingerprints an endpoint as the server does', async () => {
    const endpoint = 'https://fcm.googleapis.com/fcm/send/abc:DEF-123'
    expect(await endpointKey(endpoint)).toBe(createHash('sha256').update(endpoint).digest('base64url').slice(0, 22))
  })

  it('needs a service worker, the Push API and notifications, and the built app', () => {
    const win = { navigator: { serviceWorker: {} }, PushManager: class {}, Notification: class {} } as unknown as Window & typeof globalThis
    expect(pushSupport(win, true)).toBe('supported')
    expect(pushSupport(win, false)).toBe('no-worker')
    expect(pushSupport({ navigator: {} } as unknown as Window & typeof globalThis, true)).toBe('unsupported')
  })
})

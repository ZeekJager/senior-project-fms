import { describe, expect, it } from 'vitest'
import { OFFLINE_SESSION_MAX_AGE_MS, cacheNames, isDriverPath, isDriverSession, routeFor, sessionUsable } from './routing'

const ORIGIN = 'https://fms.example'
const precached = new Set(['/index.html', '/assets/index-abc123.js', '/offline.html', '/manifest.json'])
const req = (method: string, path: string, mode = 'cors') => ({ method, mode, url: `${ORIGIN}${path}` })

describe('driver app service worker routing (FMS-34)', () => {
  it('only /driver and /driver/... are driver pages, never the staff /drivers screen', () => {
    expect(['/driver', '/driver/', '/driver/dvir', '/driver/fuel?x=1'].map((p) => isDriverPath(new URL(p, ORIGIN).pathname))).toEqual([true, true, true, true])
    expect(['/drivers', '/drivers/me', '/dispatch', '/', '/driverx'].map(isDriverPath)).toEqual([false, false, false, false, false])
  })

  it('driver pages come from the network, then the cached shell; other pages never come from the cache', () => {
    expect(routeFor(req('GET', '/driver', 'navigate'), ORIGIN, precached)).toBe('driver-page')
    expect(routeFor(req('GET', '/driver/dvir', 'navigate'), ORIGIN, precached)).toBe('driver-page')
    for (const staff of ['/', '/vehicles', '/dispatch', '/drivers', '/login']) expect(routeFor(req('GET', staff, 'navigate'), ORIGIN, precached)).toBe('other-page')
  })

  it('built files are served from the precache; API reads, writes and other origins pass through', () => {
    expect(routeFor(req('GET', '/assets/index-abc123.js'), ORIGIN, precached)).toBe('precached')
    expect(routeFor(req('GET', '/api/v1/trips'), ORIGIN, precached)).toBe('pass')
    expect(routeFor(req('POST', '/api/v1/fuel-logs'), ORIGIN, precached)).toBe('pass')
    expect(routeFor({ method: 'GET', mode: 'cors', url: 'https://fonts.example/a.woff2' }, ORIGIN, precached)).toBe('pass')
  })

  it('sign-in and refresh are the session route; sign-out drops the saved session', () => {
    expect(routeFor(req('POST', '/api/v1/auth/refresh'), ORIGIN, precached)).toBe('session')
    expect(routeFor(req('POST', '/api/v1/auth/login'), ORIGIN, precached)).toBe('session')
    expect(routeFor(req('POST', '/api/v1/auth/logout'), ORIGIN, precached)).toBe('session-end')
    expect(routeFor(req('GET', '/api/v1/auth/me'), ORIGIN, precached)).toBe('pass')
  })

  it("only a driver's session is kept for offline use", () => {
    expect(isDriverSession({ data: { roles: ['driver'], permissions: [] } })).toBe(true)
    expect(isDriverSession({ data: { roles: ['dispatcher'] } })).toBe(false)
    expect(isDriverSession({ data: {} })).toBe(false)
    expect(isDriverSession(null)).toBe(false)
  })

  it('a saved session is offered for as long as its refresh token could live (7 days)', () => {
    const saved = Date.parse('2026-10-20T08:00:00Z')
    expect(sessionUsable(saved, saved + 60_000)).toBe(true)
    expect(sessionUsable(saved, saved + OFFLINE_SESSION_MAX_AGE_MS - 1)).toBe(true)
    expect(sessionUsable(saved, saved + OFFLINE_SESSION_MAX_AGE_MS)).toBe(false)
    // A clock set back is not trusted.
    expect(sessionUsable(saved, saved - 1)).toBe(false)
  })

  it('each build has its own shell cache', () => {
    expect(cacheNames('b1').shell).not.toBe(cacheNames('b2').shell)
    expect(cacheNames('b1').session).toBe(cacheNames('b2').session)
  })
})

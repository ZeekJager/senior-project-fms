import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { server } from '@/test/msw/server'
import { envelope, errorEnvelope, testApi } from '@/test/auth'
import { ApiError } from './errors'

const ok = () => envelope({ ok: true })

describe('api client', () => {
  it('returns body.data and sends JSON', async () => {
    let received: unknown
    server.use(
      http.post('/api/v1/echo', async ({ request }) => {
        received = await request.json()
        return envelope({ id: 7 })
      }),
    )

    await expect(testApi().request('/echo', { method: 'POST', json: { a: 1 } })).resolves.toEqual({ id: 7 })
    expect(received).toEqual({ a: 1 })
  })

  it('maps an error response to ApiError with the envelope fields', async () => {
    server.use(
      http.get('/api/v1/vehicles', () =>
        HttpResponse.json(
          {
            error: { code: 'VALIDATION_FAILED', message: 'Bad input.', details: [{ field: 'page', reason: 'min' }] },
            meta: { request_id: 'req-9' },
          },
          { status: 400 },
        ),
      ),
    )

    const err = await testApi().request('/vehicles').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({
      status: 400,
      code: 'VALIDATION_FAILED',
      message: 'Bad input.',
      details: [{ field: 'page', reason: 'min' }],
      requestId: 'req-9',
    })
  })

  it('maps a body that is not the envelope to INTERNAL_SERVER_ERROR', async () => {
    server.use(http.get('/api/v1/vehicles', () => new HttpResponse('<html>Bad gateway</html>', { status: 502 })))

    await expect(testApi().request('/vehicles')).rejects.toMatchObject({ status: 502, code: 'INTERNAL_SERVER_ERROR' })
  })

  describe('AUTH_TOKEN_EXPIRED', () => {
    it('refreshes once and retries the original request once', async () => {
      let calls = 0
      let refreshes = 0
      server.use(
        http.get('/api/v1/vehicles', () => (++calls === 1 ? errorEnvelope(401, 'AUTH_TOKEN_EXPIRED') : envelope([{ id: 1 }]))),
        http.post('/api/v1/auth/refresh', () => {
          refreshes += 1
          return ok()
        }),
      )

      await expect(testApi().request('/vehicles')).resolves.toEqual([{ id: 1 }])
      expect(calls).toBe(2)
      expect(refreshes).toBe(1)
    })

    it('logs out on a second consecutive 401 after the refresh', async () => {
      let calls = 0
      server.use(
        http.get('/api/v1/vehicles', () => {
          calls += 1
          return errorEnvelope(401, 'AUTH_TOKEN_EXPIRED')
        }),
        http.post('/api/v1/auth/refresh', ok),
      )
      const api = testApi()
      const ended = vi.fn()
      api.onSessionEnded(ended)

      await expect(api.request('/vehicles')).rejects.toMatchObject({ status: 401 })
      expect(calls).toBe(2) // one retry, never a loop
      expect(ended).toHaveBeenCalledTimes(1)
    })

    it('ends the session when the refresh is rejected', async () => {
      server.use(
        http.get('/api/v1/vehicles', () => errorEnvelope(401, 'AUTH_TOKEN_EXPIRED')),
        http.post('/api/v1/auth/refresh', () => errorEnvelope(401, 'AUTH_TOKEN_REVOKED')),
      )
      const api = testApi()
      const ended = vi.fn()
      api.onSessionEnded(ended)

      await expect(api.request('/vehicles')).rejects.toMatchObject({ code: 'AUTH_TOKEN_REVOKED' })
      expect(ended).toHaveBeenCalledTimes(1)
    })

    it('keeps the session when the refresh fails with a server error', async () => {
      server.use(
        http.get('/api/v1/vehicles', () => errorEnvelope(401, 'AUTH_TOKEN_EXPIRED')),
        http.post('/api/v1/auth/refresh', () => errorEnvelope(503, 'UPSTREAM_UNAVAILABLE')),
      )
      const api = testApi()
      const ended = vi.fn()
      api.onSessionEnded(ended)

      await expect(api.request('/vehicles')).rejects.toMatchObject({ status: 503 })
      expect(ended).not.toHaveBeenCalled()
    })

    it('sends one refresh for many requests that expire together', async () => {
      const calledAfterRefresh = new Set<string>()
      let refreshes = 0
      let refreshed = false
      const guarded = (name: string) =>
        http.get(`/api/v1/${name}`, () => {
          if (refreshed) {
            calledAfterRefresh.add(name)
            return envelope(name)
          }
          return errorEnvelope(401, 'AUTH_TOKEN_EXPIRED')
        })
      server.use(
        guarded('a'),
        guarded('b'),
        guarded('c'),
        http.post('/api/v1/auth/refresh', async () => {
          refreshes += 1
          await new Promise((resolve) => setTimeout(resolve, 20))
          refreshed = true
          return ok()
        }),
      )
      const api = testApi()

      await expect(Promise.all([api.request('/a'), api.request('/b'), api.request('/c')])).resolves.toEqual(['a', 'b', 'c'])
      // A refresh cookie presented twice reads as theft to the server.
      expect(refreshes).toBe(1)
    })
  })

  it('ends the session on AUTH_TOKEN_REVOKED without refreshing', async () => {
    let refreshes = 0
    server.use(
      http.get('/api/v1/vehicles', () => errorEnvelope(401, 'AUTH_TOKEN_REVOKED')),
      http.post('/api/v1/auth/refresh', () => {
        refreshes += 1
        return ok()
      }),
    )
    const api = testApi()
    const ended = vi.fn()
    api.onSessionEnded(ended)

    await expect(api.request('/vehicles')).rejects.toMatchObject({ code: 'AUTH_TOKEN_REVOKED' })
    expect(refreshes).toBe(0)
    expect(ended).toHaveBeenCalledTimes(1)
  })

  // The browser deletes the access cookie when its 15 minutes are up, so the
  // server sees no cookie and answers AUTH_TOKEN_INVALID. Found by the Sprint 1
  // browser run: without this the user is signed out every 15 minutes.
  describe('AUTH_TOKEN_INVALID (the access cookie expired and the browser dropped it)', () => {
    it('refreshes once and retries, like an expired token', async () => {
      let calls = 0
      server.use(
        http.get('/api/v1/vehicles', () => (++calls === 1 ? errorEnvelope(401, 'AUTH_TOKEN_INVALID') : envelope([{ id: 1 }]))),
        http.post('/api/v1/auth/refresh', ok),
      )
      const api = testApi()
      const ended = vi.fn()
      api.onSessionEnded(ended)

      await expect(api.request('/vehicles')).resolves.toEqual([{ id: 1 }])
      expect(calls).toBe(2)
      expect(ended).not.toHaveBeenCalled()
    })

    it('ends the session when there is no refresh cookie either', async () => {
      server.use(
        http.get('/api/v1/vehicles', () => errorEnvelope(401, 'AUTH_TOKEN_INVALID')),
        http.post('/api/v1/auth/refresh', () => errorEnvelope(401, 'AUTH_TOKEN_INVALID')),
      )
      const api = testApi()
      const ended = vi.fn()
      api.onSessionEnded(ended)

      await expect(api.request('/vehicles')).rejects.toMatchObject({ status: 401 })
      expect(ended).toHaveBeenCalledTimes(1)
    })

    it('does not loop: a second INVALID after the refresh ends the session', async () => {
      let calls = 0
      server.use(
        http.get('/api/v1/vehicles', () => {
          calls += 1
          return errorEnvelope(401, 'AUTH_TOKEN_INVALID')
        }),
        http.post('/api/v1/auth/refresh', ok),
      )
      const api = testApi()
      const ended = vi.fn()
      api.onSessionEnded(ended)

      await expect(api.request('/vehicles')).rejects.toMatchObject({ code: 'AUTH_TOKEN_INVALID' })
      expect(calls).toBe(2)
      expect(ended).toHaveBeenCalledTimes(1)
    })
  })

  it('leaves login failures to the caller: no refresh, no session end', async () => {
    server.use(http.post('/api/v1/auth/login', () => errorEnvelope(401, 'AUTH_INVALID_CREDENTIALS')))
    const api = testApi()
    const ended = vi.fn()
    api.onSessionEnded(ended)

    await expect(api.request('/auth/login', { method: 'POST', json: {} })).rejects.toMatchObject({
      code: 'AUTH_INVALID_CREDENTIALS',
    })
    expect(ended).not.toHaveBeenCalled()
  })

  it('does not treat 403 as a lost session', async () => {
    server.use(http.get('/api/v1/vehicles', () => errorEnvelope(403, 'FORBIDDEN_INSUFFICIENT_ROLE')))
    const api = testApi()
    const ended = vi.fn()
    api.onSessionEnded(ended)

    await expect(api.request('/vehicles')).rejects.toMatchObject({ status: 403 })
    expect(ended).not.toHaveBeenCalled()
  })

  it('stores no token: nothing is written to web storage', async () => {
    server.use(http.post('/api/v1/auth/refresh', () => envelope({ user: {} })))
    await testApi().refresh()

    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
})

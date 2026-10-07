// How to mock the API in a test: add a handler with server.use(); it is
// removed again after the test by src/test/setup.ts.
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { server } from './server'

const api = (path: string) => new URL(`/api/v1${path}`, window.location.origin)

describe('MSW API mocks', () => {
  it('returns the mocked response in the contract envelope', async () => {
    server.use(
      http.get('/api/v1/vehicles', () =>
        HttpResponse.json({ data: [{ id: 'v-1', registration_number: 'AA-12345' }], meta: { request_id: 'r-1' } }),
      ),
    )

    const res = await fetch(api('/vehicles'))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data[0].registration_number).toBe('AA-12345')
  })

  it('can simulate an API error', async () => {
    server.use(
      http.get('/api/v1/vehicles', () =>
        HttpResponse.json({ error: { code: 'FORBIDDEN_INSUFFICIENT_ROLE', message: 'Forbidden.' } }, { status: 403 }),
      ),
    )

    const res = await fetch(api('/vehicles'))
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('FORBIDDEN_INSUFFICIENT_ROLE')
  })

  it('fails on a request no handler covers', async () => {
    await expect(fetch(api('/not-mocked'))).rejects.toThrow()
  })
})

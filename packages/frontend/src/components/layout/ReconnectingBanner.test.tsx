import { act, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { currentUser, envelope, renderApp, signedInAs, testApi } from '@/test/auth'
import { server } from '@/test/msw/server'

// FMS-162: while the database fails over, the API answers every request 503 with Retry-After, and every screen says so.

const unavailable = () =>
  HttpResponse.json(
    { error: { code: 'UPSTREAM_UNAVAILABLE', message: 'The database is unavailable for a moment.', details: [{ reason: 'database_unavailable' }] }, meta: { request_id: 'r' } },
    { status: 503, headers: { 'Retry-After': '5' } },
  )

/** The outage: while `down`, every API request answers 503; otherwise the other handlers answer. */
function outage() {
  const state = { down: false }
  server.use(http.all('/api/v1/*', () => (state.down ? unavailable() : undefined)))
  return state
}

describe('Reconnecting banner (FMS-162)', () => {
  it('appears on a staff screen while the database is unavailable, and goes once the server answers again', async () => {
    const api = testApi()
    signedInAs(currentUser(['admin'], ['audit:read']))
    renderApp('/dashboard', { api })
    await screen.findByRole('navigation', { name: 'Main' })
    expect(screen.queryByText('Reconnecting…')).not.toBeInTheDocument()

    const db = outage()
    db.down = true
    await act(() => api.request('/ping').catch(() => undefined))
    expect(await screen.findByText('Reconnecting…')).toBeInTheDocument()
    expect(screen.getByText(/Saving does not work until then: try again shortly\. Nothing is lost\./)).toBeInTheDocument()

    db.down = false
    server.use(http.get('/api/v1/ping', () => envelope({ ok: true })))
    await act(() => api.request('/ping'))
    await waitFor(() => expect(screen.queryByText('Reconnecting…')).not.toBeInTheDocument())
  })

  it('tells a driver that what they do is kept on the phone', async () => {
    const api = testApi()
    signedInAs(currentUser(['driver'], ['trip:execute']))
    renderApp('/driver', { api })
    await screen.findByRole('button', { name: 'Account' })
    const db = outage()
    db.down = true
    await act(() => api.request('/ping').catch(() => undefined))
    expect(await screen.findByText(/kept on this phone and sent when it is back/)).toBeInTheDocument()
  })

  it('says the server is not answering while the API is restarting, on a staff screen (FMS-111)', async () => {
    const api = testApi()
    signedInAs(currentUser(['admin'], ['audit:read']))
    renderApp('/dashboard', { api })
    await screen.findByRole('navigation', { name: 'Main' })

    server.use(http.get('/api/v1/ping', () => new HttpResponse('Bad Gateway', { status: 502, headers: { 'Content-Type': 'text/plain' } })))
    await act(() => api.request('/ping').catch(() => undefined))
    expect(await screen.findByText('Reconnecting…')).toBeInTheDocument()
    expect(screen.getByText(/The server is not answering: it may be restarting/)).toBeInTheDocument()

    server.use(http.get('/api/v1/ping', () => envelope({ ok: true })))
    await act(() => api.request('/ping'))
    await waitFor(() => expect(screen.queryByText('Reconnecting…')).not.toBeInTheDocument())
  })

  it('tells a driver the phone keeps what they do while the server is not answering', async () => {
    const api = testApi()
    signedInAs(currentUser(['driver'], ['trip:execute']))
    renderApp('/driver', { api })
    await screen.findByRole('button', { name: 'Account' })
    server.use(http.get('/api/v1/ping', () => HttpResponse.error()))
    await act(() => api.request('/ping').catch(() => undefined))
    expect(await screen.findByText(/The server is not answering\. Your location and anything you submit are kept on this phone/)).toBeInTheDocument()
  })
})

import { QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import { http } from 'msw'
import { MemoryRouter } from 'react-router-dom'
import type { Socket } from 'socket.io-client'
import { describe, expect, it, vi } from 'vitest'
import { AuthProvider } from '@/context/AuthContext'
import { createQueryClient } from '@/lib/query'
import { currentUser, envelope, errorEnvelope, signedInAs, signedOut, testApi } from '@/test/auth'
import { server } from '@/test/msw/server'
import { useRealtimeEvent, useRealtimeStatus } from './context'
import { RealtimeProvider } from './RealtimeProvider'

import { FakeSocket } from '@/test/fakeSocket'

const dispatcher = currentUser(['dispatcher'], ['trip:read', 'trip:assign'])

function Probe({ seen }: { seen: unknown[] }) {
  useRealtimeEvent('trip.updated', (payload) => seen.push(payload))
  return <p data-testid="status">{useRealtimeStatus()}</p>
}

function renderProvider(fake: FakeSocket, seen: unknown[] = []) {
  const queryClient = createQueryClient()
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AuthProvider api={testApi()}>
          <RealtimeProvider connect={() => fake as unknown as Socket}>
            <Probe seen={seen} />
          </RealtimeProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { invalidate }
}

const status = () => screen.getByTestId('status')

describe('RealtimeProvider (FMS-43)', () => {
  it('opens the socket once signed in, and marks the screens an event is about as stale', async () => {
    signedInAs(dispatcher)
    const fake = new FakeSocket()
    const seen: unknown[] = []
    const { invalidate } = renderProvider(fake, seen)
    await waitFor(() => expect(fake.connects).toBe(1))
    expect(status()).toHaveTextContent('connecting')
    fake.fire('connect')
    expect(status()).toHaveTextContent('live')

    fake.serverEvent('trip.updated', { trip_id: 't1', status: 'assigned' })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['dispatch'] })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['driver', 'today'] })
    expect(seen).toEqual([{ trip_id: 't1', status: 'assigned' }])

    fake.serverEvent('vehicle.status.changed', { vehicle_id: 'v1' })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['vehicles'] })
    // A speeding or idling flag (FMS-46) refreshes the live map.
    invalidate.mockClear()
    fake.serverEvent('vehicle.flag.changed', { flag_id: 'f1', vehicle_id: 'v1', change: 'raised' })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['tracking'] })
    // An event it does not know changes nothing.
    invalidate.mockClear()
    fake.serverEvent('something.else', {})
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('signed out: no socket at all', async () => {
    signedOut()
    const fake = new FakeSocket()
    renderProvider(fake)
    await new Promise((r) => setTimeout(r, 50))
    expect(fake.connects).toBe(0)
    expect(status()).toHaveTextContent('off')
  })

  it('the server closed it (the token ran out, the account changed): renew the session, then reconnect', async () => {
    let refreshes = 0
    server.use(http.post('/api/v1/auth/refresh', () => (++refreshes, envelope(dispatcher))))
    const fake = new FakeSocket()
    renderProvider(fake)
    await waitFor(() => expect(fake.connects).toBe(1))
    fake.fire('connect')
    fake.fire('disconnect', 'io server disconnect')
    expect(status()).toHaveTextContent('down')
    await waitFor(() => expect(fake.connects).toBe(2))
    expect(refreshes).toBe(2) // the load's refresh, then the renewal

    // A dropped network is not the server's doing: socket.io reconnects by itself.
    fake.fire('disconnect', 'transport close')
    await new Promise((r) => setTimeout(r, 50))
    expect(fake.connects).toBe(2)
  })

  it('a handshake refused for an expired token renews the session; after 3 tries in a row it stops', async () => {
    let refreshes = 0
    server.use(http.post('/api/v1/auth/refresh', () => (++refreshes, envelope(dispatcher))))
    const fake = new FakeSocket()
    renderProvider(fake)
    await waitFor(() => expect(fake.connects).toBe(1))
    for (let i = 2; i <= 4; i++) {
      fake.fire('connect_error', new Error('AUTH_TOKEN_EXPIRED'))
      await waitFor(() => expect(fake.connects).toBe(i))
    }
    fake.fire('connect_error', new Error('AUTH_TOKEN_EXPIRED'))
    await new Promise((r) => setTimeout(r, 50))
    expect(fake.connects).toBe(4)
    // The load's refresh and three renewals.
    expect(refreshes).toBe(4)
  })

  it('a renewal the server refuses does not reconnect', async () => {
    let refreshes = 0
    server.use(http.post('/api/v1/auth/refresh', () => (++refreshes === 1 ? envelope(dispatcher) : errorEnvelope(401, 'AUTH_TOKEN_REVOKED'))))
    const fake = new FakeSocket()
    renderProvider(fake)
    await waitFor(() => expect(fake.connects).toBe(1))
    fake.fire('disconnect', 'io server disconnect')
    await waitFor(() => expect(refreshes).toBe(2))
    await new Promise((r) => setTimeout(r, 50))
    expect(fake.connects).toBe(1)
  })

  it('closing the tab says goodbye to the server; a page restored from the back/forward cache reconnects', async () => {
    signedInAs(dispatcher)
    const fake = new FakeSocket()
    renderProvider(fake)
    await waitFor(() => expect(fake.connects).toBe(1))
    fake.fire('connect')
    act(() => void window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })))
    expect(fake.disconnects).toBe(1)
    act(() => void window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
    expect(fake.connects).toBe(2)
    // A fresh load (not from the cache) is the provider's first connect, not this.
    act(() => void window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false })))
    expect(fake.connects).toBe(2)
  })

  it('outside the provider the hooks do nothing', () => {
    const seen: unknown[] = []
    render(<Probe seen={seen} />)
    expect(status()).toHaveTextContent('off')
  })
})

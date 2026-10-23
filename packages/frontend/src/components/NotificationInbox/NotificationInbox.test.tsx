import { QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { MemoryRouter } from 'react-router-dom'
import type { Socket } from 'socket.io-client'
import { describe, expect, it } from 'vitest'
import { AuthProvider } from '@/context/AuthContext'
import { RealtimeProvider } from '@/lib/realtime/RealtimeProvider'
import { createQueryClient } from '@/lib/query'
import { AppRouter } from '@/router/AppRouter'
import { currentUser, envelope, LocationProbe, renderApp, signedInAs, testApi } from '@/test/auth'
import { FakeSocket } from '@/test/fakeSocket'
import { server } from '@/test/msw/server'
import type { InboxNotification } from './api'

const VEHICLE = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

// A technician: works faults in maintenance. A "clerk" holds no screen a notification could lead to.
const technician = currentUser(['technician'], ['maintenance:read', 'vehicle:read', 'depot:read', 'alert:read', 'notification:read'])
const clerk = currentUser(['finance_clerk'], ['notification:read'])
const driver = currentUser(['driver'], ['trip:execute', 'trip:read', 'vehicle:read', 'notification:read'])

let seq = 0
function note(overrides: Partial<InboxNotification> = {}): InboxNotification {
  seq += 1
  return {
    id: `n-${seq}`,
    type: 'alert',
    title: `Defects reported on AA ${seq}`,
    message: `${seq} defects on the pre-trip inspection.`,
    alert_id: null,
    entity: null,
    vehicle_id: null,
    driver_id: null,
    read: false,
    read_at: null,
    created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    ...overrides,
  }
}

const fault = (overrides: Partial<InboxNotification> = {}) => note({ entity: { type: 'dvir_report', id: 'r-1' }, vehicle_id: VEHICLE, ...overrides })

/**
 * A fake inbox API with state: GET lists, PATCH marks one read, POST marks all. `delayMs` slows the answers, so a
 * test can look at the screen while a request is still out. Requests are recorded.
 */
function serveInbox(initial: InboxNotification[], options: { delayMs?: number; total?: number; fail?: 'patch' | 'post' | 'get' } = {}) {
  const state = { items: initial, total: options.total, requests: [] as string[], failGet: options.fail === 'get' }
  const wait = () => (options.delayMs ? new Promise((r) => setTimeout(r, options.delayMs)) : undefined)
  server.use(
    http.get('/api/v1/notifications', async ({ request }) => {
      state.requests.push(`GET ${new URL(request.url).search}`)
      await wait()
      if (state.failGet) return HttpResponse.json({ error: { code: 'INTERNAL_SERVER_ERROR', message: 'boom' }, meta: { request_id: 'r' } }, { status: 500 })
      const unread = state.items.filter((n) => !n.read).length
      return HttpResponse.json({
        data: state.items,
        meta: { request_id: 'r', page: 1, page_size: 20, total_items: state.total ?? state.items.length, total_pages: 1, unread_count: unread },
      })
    }),
    http.patch('/api/v1/notifications/:id/read', async ({ params }) => {
      state.requests.push(`PATCH ${params.id}`)
      await wait()
      if (options.fail === 'patch') return HttpResponse.json({ error: { code: 'INTERNAL_SERVER_ERROR', message: 'boom' }, meta: { request_id: 'r' } }, { status: 500 })
      state.items = state.items.map((n) => (n.id === params.id ? { ...n, read: true, read_at: new Date().toISOString() } : n))
      return envelope(state.items.find((n) => n.id === params.id))
    }),
    http.post('/api/v1/notifications/read-all', async () => {
      state.requests.push('POST read-all')
      await wait()
      if (options.fail === 'post') return HttpResponse.json({ error: { code: 'INTERNAL_SERVER_ERROR', message: 'boom' }, meta: { request_id: 'r' } }, { status: 500 })
      const updated = state.items.filter((n) => !n.read).length
      state.items = state.items.map((n) => ({ ...n, read: true }))
      return envelope({ updated })
    }),
    // Whatever page a click leads to asks for its own data; these tests are about the bell.
    http.get('/api/v1/*', () => envelope([])),
  )
  return state
}

const bell = () => screen.getByRole('button', { name: /^Notifications/ })
const badge = () => screen.queryByTestId('notification-badge')
const location = () => screen.getByTestId('location').textContent

async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /^Notifications/ }))
  return screen.getByRole('region', { name: /Notifications/ })
}

describe('the bell and its badge', () => {
  it('shows the unread count from the server, names it for a screen reader, and shows nothing at zero', async () => {
    serveInbox([note(), note(), note({ read: true })])
    signedInAs(technician)
    renderApp('/dashboard')
    await waitFor(() => expect(badge()).toHaveTextContent('2'))
    expect(bell()).toHaveAccessibleName('Notifications, 2 unread')
  })

  it('has no badge and the plain name when everything is read', async () => {
    serveInbox([note({ read: true })])
    signedInAs(technician)
    renderApp('/dashboard')
    await screen.findByRole('button', { name: 'Notifications' })
    expect(badge()).not.toBeInTheDocument()
  })

  it('caps a large count at 99+', async () => {
    serveInbox(Array.from({ length: 120 }, () => note()), { total: 120 })
    signedInAs(technician)
    renderApp('/dashboard')
    await waitFor(() => expect(badge()).toHaveTextContent('99+'))
    expect(bell()).toHaveAccessibleName('Notifications, 120 unread')
  })

  it('is in the driver portal too, where the phone layout has the same bell', async () => {
    serveInbox([note()])
    signedInAs(driver)
    renderApp('/driver')
    await waitFor(() => expect(badge()).toHaveTextContent('1'))
  })
})

describe('the panel', () => {
  it('lists the notifications, newest first as the server sends them: title, message, how long ago, unread marked', async () => {
    serveInbox([note({ title: 'Defects reported on AA 1', message: '2 defects.', created_at: new Date(Date.now() - 3 * 3_600_000).toISOString() }), note({ title: 'Licence expires in 7 days', read: true })])
    signedInAs(technician)
    renderApp('/dashboard')
    const user = userEvent.setup()
    const panel = await open(user)

    const rows = await within(panel).findAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('Defects reported on AA 1')
    expect(rows[0]).toHaveTextContent('2 defects.')
    expect(rows[0]).toHaveTextContent('3 h ago')
    expect(within(rows[0]).getByText('(unread)')).toBeInTheDocument()
    expect(within(rows[1]).queryByText('(unread)')).not.toBeInTheDocument()
    expect(within(panel).getByText('2 unread'.replace('2', '1'))).toBeInTheDocument()
    expect(within(panel).getByText('Last 30 days')).toBeInTheDocument()
  })

  it('says how many are not shown when there are more than the panel lists', async () => {
    serveInbox([note(), note()], { total: 57 })
    signedInAs(technician)
    renderApp('/dashboard')
    const panel = await open(userEvent.setup())
    expect(await within(panel).findByText(/the latest 2 of 57/)).toBeInTheDocument()
  })

  it('asks only for the panel-sized page', async () => {
    const state = serveInbox([note()])
    signedInAs(technician)
    renderApp('/dashboard')
    await screen.findByRole('button', { name: /^Notifications/ })
    await waitFor(() => expect(state.requests).toContain('GET ?page_size=20'))
  })

  it('an empty inbox says you are all caught up', async () => {
    serveInbox([])
    signedInAs(technician)
    renderApp('/dashboard')
    const panel = await open(userEvent.setup())
    expect(await within(panel).findByText("You're all caught up")).toBeInTheDocument()
    expect(within(panel).getByRole('button', { name: 'Mark all as read' })).toBeDisabled()
  })

  it('shows placeholders while it loads, and an error with Try again that recovers', { timeout: 15_000 }, async () => {
    const state = serveInbox([note({ title: 'Back again' })], { delayMs: 150 })
    state.failGet = true
    signedInAs(technician)
    renderApp('/dashboard')
    const user = userEvent.setup()
    const panel = await open(user)
    expect(within(panel).getByLabelText('Loading notifications')).toBeInTheDocument()

    // A 5xx is retried twice with backoff before the error shows (lib/query.ts).
    expect(await within(panel).findByText('Could not load notifications', {}, { timeout: 8000 })).toBeInTheDocument()
    state.failGet = false
    await user.click(within(panel).getByRole('button', { name: 'Try again' }))
    expect(await within(panel).findByText('Back again')).toBeInTheDocument()
  })

  it('closes on Escape and returns focus to the bell', async () => {
    serveInbox([note()])
    signedInAs(technician)
    renderApp('/dashboard')
    const user = userEvent.setup()
    await open(user)
    expect(bell()).toHaveAttribute('aria-expanded', 'true')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('region', { name: /Notifications/ })).not.toBeInTheDocument()
    expect(bell()).toHaveFocus()
  })

  it('fits a 375 px phone: the width of the screen under the top bar, scrolling inside, with touch-sized rows', async () => {
    serveInbox(Array.from({ length: 12 }, () => note({ title: 'A fairly long title that has to wrap on a narrow phone screen without overflowing it' })))
    signedInAs(technician)
    renderApp('/dashboard')
    const panel = await open(userEvent.setup())
    await within(panel).findAllByRole('listitem')

    // jsdom applies no stylesheet, so this checks the classes that do the work (verified in a real browser at 375 px).
    expect(panel).toHaveClass('fixed', 'inset-x-4', 'max-h-[calc(100dvh-84px)]', 'overflow-hidden')
    expect(panel.querySelector('.overflow-y-auto')).not.toBeNull()
    for (const row of within(panel).getAllByRole('listitem')) {
      expect(within(row).getByRole('button')).toHaveClass('min-h-14', 'w-full')
      expect(within(row).getByText(/A fairly long title/)).toHaveClass('break-words')
    }
  })
})

describe('choosing a notification', () => {
  it('marks it read, drops the badge at once (before the server answers), and opens the screen it is about', async () => {
    const state = serveInbox([fault({ title: 'Defects reported on AA 7' }), note()], { delayMs: 300 })
    signedInAs(technician)
    renderApp('/dashboard')
    const user = userEvent.setup()
    await waitFor(() => expect(badge()).toHaveTextContent('2'))
    const panel = await open(user)

    await user.click(await within(panel).findByRole('button', { name: /Defects reported on AA 7/ }))

    // The request is still out; the screen already shows the result.
    expect(badge()).toHaveTextContent('1')
    expect(location()).toBe(`/maintenance?vehicle=${VEHICLE}`)
    expect(screen.queryByRole('region', { name: /Notifications/ })).not.toBeInTheDocument()
    await waitFor(() => expect(state.requests).toContain(`PATCH ${state.items[0].id}`))
    await waitFor(() => expect(state.items[0].read).toBe(true))
  })

  it("one the viewer cannot open a screen for is only marked read: they stay where they are", async () => {
    const state = serveInbox([fault()])
    signedInAs(clerk)
    renderApp('/dashboard')
    const user = userEvent.setup()
    const panel = await open(user)
    const row = await within(panel).findByRole('button', { name: /Defects reported/ })
    expect(row.querySelector('svg.lucide-chevron-right')).toBeNull()

    await user.click(row)
    await waitFor(() => expect(state.requests).toContain(`PATCH ${state.items[0].id}`))
    expect(location()).toBe('/dashboard')
  })

  it('one about nothing in particular is only marked read', async () => {
    const state = serveInbox([note({ entity: null })])
    signedInAs(technician)
    renderApp('/dashboard')
    const user = userEvent.setup()
    const panel = await open(user)
    await user.click(await within(panel).findByRole('button', { name: /Defects reported/ }))
    await waitFor(() => expect(state.requests.some((r) => r.startsWith('PATCH'))).toBe(true))
    expect(location()).toBe('/dashboard')
  })

  it('one already read opens its screen without another request to mark it', async () => {
    const state = serveInbox([fault({ read: true })])
    signedInAs(technician)
    renderApp('/dashboard')
    const user = userEvent.setup()
    const panel = await open(user)
    await user.click(await within(panel).findByRole('button', { name: /Defects reported/ }))
    expect(location()).toBe(`/maintenance?vehicle=${VEHICLE}`)
    expect(state.requests.filter((r) => r.startsWith('PATCH'))).toEqual([])
  })

  it('if marking it read fails, the badge comes back to what the server says', async () => {
    serveInbox([note(), note()], { fail: 'patch' })
    signedInAs(technician)
    renderApp('/dashboard')
    const user = userEvent.setup()
    await waitFor(() => expect(badge()).toHaveTextContent('2'))
    const panel = await open(user)
    await user.click((await within(panel).findAllByRole('button', { name: /Defects reported/ }))[0])
    await waitFor(() => expect(badge()).toHaveTextContent('2'))
  })
})

describe('Mark all as read', () => {
  it('clears the badge to nothing at once, and the server is told once', async () => {
    const state = serveInbox([note(), note(), note({ read: true })], { delayMs: 300 })
    signedInAs(technician)
    renderApp('/dashboard')
    const user = userEvent.setup()
    await waitFor(() => expect(badge()).toHaveTextContent('2'))
    const panel = await open(user)

    await user.click(within(panel).getByRole('button', { name: 'Mark all as read' }))

    expect(badge()).not.toBeInTheDocument()
    expect(bell()).toHaveAccessibleName('Notifications')
    await waitFor(() => expect(state.items.every((n) => n.read)).toBe(true))
    expect(state.requests.filter((r) => r === 'POST read-all')).toHaveLength(1)
    // And once the server has answered, it is still nothing, and there is nothing left to mark.
    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Mark all as read' })).toBeDisabled())
    expect(badge()).not.toBeInTheDocument()
  })

  it('is disabled when nothing is unread', async () => {
    serveInbox([note({ read: true })])
    signedInAs(technician)
    renderApp('/dashboard')
    const panel = await open(userEvent.setup())
    expect(await within(panel).findByRole('button', { name: 'Mark all as read' })).toBeDisabled()
  })

  it('if it fails, the badge comes back', async () => {
    serveInbox([note(), note()], { fail: 'post' })
    signedInAs(technician)
    renderApp('/dashboard')
    const user = userEvent.setup()
    await waitFor(() => expect(badge()).toHaveTextContent('2'))
    const panel = await open(user)
    await user.click(within(panel).getByRole('button', { name: 'Mark all as read' }))
    await waitFor(() => expect(badge()).toHaveTextContent('2'))
  })
})

describe('live updates (FMS-48 notifications.unread)', () => {
  function renderLive(path: string, socket: FakeSocket) {
    return render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={[path]}>
          <AuthProvider api={testApi()}>
            <RealtimeProvider connect={() => socket as unknown as Socket}>
              <LocationProbe />
              <AppRouter />
            </RealtimeProvider>
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    )
  }

  it('a new notification raises the badge the moment the event arrives, without waiting for the list or a refresh', async () => {
    const socket = new FakeSocket()
    const state = serveInbox([note()])
    signedInAs(technician)
    renderLive('/dashboard', socket)
    await waitFor(() => expect(badge()).toHaveTextContent('1'))
    socket.fire('connect')

    // Two new ones land on the server, and the list is slow to answer.
    state.items = [note(), note(), ...state.items]
    server.use(
      http.get('/api/v1/notifications', async () => {
        await new Promise((r) => setTimeout(r, 1500))
        return HttpResponse.json({ data: state.items, meta: { request_id: 'r', page: 1, page_size: 20, total_items: 3, total_pages: 1, unread_count: 3 } })
      }),
    )
    const sent = Date.now()
    socket.serverEvent('notifications.unread', { unread_count: 3, reason: 'delivered', changed_at: new Date().toISOString() })

    // The list answers after 1.5 s; the badge must not wait for it.
    await waitFor(() => expect(badge()).toHaveTextContent('3'), { timeout: 800 })
    expect(Date.now() - sent).toBeLessThan(1000)
  })

  it('then the list follows with the new rows', async () => {
    const socket = new FakeSocket()
    const state = serveInbox([note({ title: 'Old one' })])
    signedInAs(technician)
    renderLive('/dashboard', socket)
    const user = userEvent.setup()
    await waitFor(() => expect(badge()).toHaveTextContent('1'))
    socket.fire('connect')
    const panel = await open(user)
    await within(panel).findByText('Old one')

    state.items = [note({ title: 'Brand new' }), ...state.items]
    socket.serverEvent('notifications.unread', { unread_count: 2, reason: 'delivered', changed_at: new Date().toISOString() })
    expect(await within(panel).findByText('Brand new')).toBeInTheDocument()
    expect(badge()).toHaveTextContent('2')
  })

  it('reading in another tab lowers it here; read-all there clears it here', async () => {
    const socket = new FakeSocket()
    const state = serveInbox([note(), note(), note()])
    signedInAs(technician)
    renderLive('/dashboard', socket)
    await waitFor(() => expect(badge()).toHaveTextContent('3'))
    socket.fire('connect')

    // The server has changed by the time it tells us (the event follows the commit), so the re-read agrees.
    state.items = state.items.map((n, i) => (i === 0 ? { ...n, read: true } : n))
    socket.serverEvent('notifications.unread', { unread_count: 2, reason: 'read' })
    await waitFor(() => expect(badge()).toHaveTextContent('2'))
    state.items = state.items.map((n) => ({ ...n, read: true }))
    socket.serverEvent('notifications.unread', { unread_count: 0, reason: 'read_all' })
    await waitFor(() => expect(badge()).not.toBeInTheDocument())
  })

  it('an event without a usable count does not break the badge: it only re-reads the list', async () => {
    const socket = new FakeSocket()
    const state = serveInbox([note(), note()])
    signedInAs(technician)
    renderLive('/dashboard', socket)
    await waitFor(() => expect(badge()).toHaveTextContent('2'))
    socket.fire('connect')

    for (const payload of [null, {}, { unread_count: 'many' }, { unread_count: -3 }, { unread_count: 1.5 }]) {
      socket.serverEvent('notifications.unread', payload)
    }
    await waitFor(() => expect(state.requests.filter((r) => r.startsWith('GET')).length).toBeGreaterThan(1))
    expect(badge()).toHaveTextContent('2')
  })

  it('other events (a trip changing) leave the badge alone', async () => {
    const socket = new FakeSocket()
    serveInbox([note()])
    signedInAs(technician)
    renderLive('/dashboard', socket)
    await waitFor(() => expect(badge()).toHaveTextContent('1'))
    act(() => socket.serverEvent('trip.updated', { trip_id: 't-1' }))
    expect(badge()).toHaveTextContent('1')
  })
})

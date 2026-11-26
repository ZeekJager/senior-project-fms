import { QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { AuthProvider } from '@/context/AuthContext'
import { createQueryClient } from '@/lib/query'
import { RealtimeContext, type RealtimeHandler, type RealtimeValue } from '@/lib/realtime/context'
import { AppRouter } from '@/router/AppRouter'
import { currentUser, envelope, LocationProbe, signedInAs, testApi } from '@/test/auth'
import { DEFAULT_SETTINGS } from '@/test/msw/handlers'
import { server } from '@/test/msw/server'
import type { ChargingSession, EvFleetVehicle } from './api'
import { ago, chargeLevel, duration, fleetFigures, lowestFirst, socSpan } from './describe'

// S-40 EV fleet (FMS-99): the acceptance criteria. Low charge first; the sessions charging now follow the socket;
// every synthetic record carries the Synthetic data badge.

const DEPOT = '11111111-1111-4111-8111-111111111111'
const manager = currentUser(['fleet_manager'], ['ev:read', 'depot:read', 'vehicle:read'])
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()

function ev(plate: string, soc: number | null, extra: Partial<EvFleetVehicle> = {}): EvFleetVehicle {
  return {
    vehicle_id: `v-${plate}`,
    registration_number: plate,
    make: 'BYD',
    model: 'T3',
    depot: { id: DEPOT, name: 'Bole' },
    latest: soc === null ? null : { state_of_charge: soc, battery_health: 94, estimated_range_km: null, recorded_at: minutesAgo(30), source: 'manual' },
    charging: null,
    ...extra,
  }
}

function session(extra: Partial<ChargingSession> = {}): ChargingSession {
  return {
    id: 's-1',
    vehicle_id: 'v-AA 3-20002',
    registration_number: 'AA 3-20002',
    station: { id: 'st-1', name: 'Bole charging hub' },
    status: 'completed',
    started_at: minutesAgo(300),
    ended_at: minutesAgo(200),
    energy_kwh: 42.5,
    cost_cents: 212_500,
    start_soc: 18,
    end_soc: 86,
    source: 'manual',
    ...extra,
  }
}

function fakeSocket(): RealtimeValue & { emit(event: string, payload: unknown): void } {
  const handlers = new Map<string, Set<RealtimeHandler>>()
  return {
    status: 'live',
    subscribe(event, handler) {
      const set = handlers.get(event) ?? new Set()
      set.add(handler)
      handlers.set(event, set)
      return () => void set.delete(handler)
    },
    emit(event, payload) {
      act(() => handlers.get(event)?.forEach((h) => h(payload)))
    },
  }
}

/** The API as the dashboard reads it; `fleet` and `sessions` are read on each request, so a test can change them. */
function serve(state: { fleet: EvFleetVehicle[]; sessions: ChargingSession[] }) {
  server.use(
    http.get('/api/v1/ev/fleet', () => envelope(state.fleet)),
    http.get('/api/v1/ev/charging-sessions', () =>
      HttpResponse.json({ data: state.sessions, meta: { request_id: 'r', page: 1, page_size: 25, total_items: state.sessions.length, total_pages: 1 } }),
    ),
    http.get('/api/v1/ev/charging-stations', () =>
      envelope([{ id: 'st-1', name: 'Bole charging hub', external_station_id: 'x', latitude: 9.0, longitude: 38.76, connector_type: 'CCS2', power_kw: 60, status: 'available', source: 'synthetic' }]),
    ),
    http.get('/api/v1/depots', () => envelope([{ id: DEPOT, name: 'Bole', code: 'BOL', location: 'Addis Ababa' }])),
  )
}

function open(path = '/ev') {
  const socket = fakeSocket()
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <AuthProvider api={testApi()}>
          <RealtimeContext.Provider value={socket}>
            <LocationProbe />
            <AppRouter />
          </RealtimeContext.Provider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return socket
}

const table = (caption: string) => screen.getByRole('table', { name: new RegExp(caption) })
const plates = (t: HTMLElement) => within(t).getAllByRole('row').slice(1).map((r) => within(r).queryByText(/^AA /)?.textContent)

describe('S-40 EV fleet (FMS-99)', () => {
  it('lists the low-charge EVs first, as the API orders them, with how low each is', async () => {
    // The API's order: lowest first, no reading last.
    serve({ fleet: [ev('AA 3-20003', 6), ev('AA 3-20001', 17), ev('AA 3-20002', 82), ev('AA 3-20004', null)], sessions: [] })
    signedInAs(manager)
    open()
    const list = await screen.findByRole('table', { name: /lowest charge first/ })
    await waitFor(() => expect(plates(list)).toEqual(['AA 3-20003', 'AA 3-20001', 'AA 3-20002', 'AA 3-20004']))
    const rows = within(list).getAllByRole('row').slice(1)
    expect(within(rows[0]).getByText('Critical')).toBeInTheDocument()
    expect(within(rows[1]).getByText('Low')).toBeInTheDocument()
    expect(within(rows[2]).getByText('Ready')).toBeInTheDocument()
    expect(within(rows[3]).getByText('No reading')).toBeInTheDocument()
    const figures = screen.getByText('Low charge').closest('div')!
    expect(within(figures).getByText('2')).toBeInTheDocument()
  })

  it('the low line is the battery alert’s setting: at 30%, an EV at 25% is low', async () => {
    serve({ fleet: [ev('AA 3-20001', 25), ev('AA 3-20002', 40)], sessions: [] })
    server.use(http.get('/api/v1/settings', () => envelope(DEFAULT_SETTINGS.map((s) => (s.key === 'ev_low_soc_pct' ? { ...s, value: 30, is_default: false } : s)))))
    signedInAs(manager)
    open()
    const list = await screen.findByRole('table', { name: /lowest charge first/ })
    await waitFor(() => expect(within(within(list).getAllByRole('row')[1]).getByText('Low')).toBeInTheDocument())
    expect(screen.getByText('below 30% at the last reading')).toBeInTheDocument()
  })

  it('the sessions charging now update live when the socket says a session started', async () => {
    const state = { fleet: [ev('AA 3-20001', 17), ev('AA 3-20002', 82)], sessions: [session()] }
    serve(state)
    signedInAs(manager)
    const socket = open()
    const panel = (await screen.findByRole('heading', { name: 'Charging now' })).closest('section')!
    await waitFor(() => expect(within(panel).getByText('No EV is charging now.')).toBeInTheDocument())

    // A session starts at the hub: the server's list now has it, and the socket says so.
    const started = { id: 's-2', station: { id: 'st-1', name: 'Bole charging hub' }, started_at: minutesAgo(5), start_soc: 17, source: 'provider' as const }
    state.fleet = [ev('AA 3-20001', 17, { charging: started }), ev('AA 3-20002', 82)]
    state.sessions = [session({ id: 's-2', vehicle_id: 'v-AA 3-20001', registration_number: 'AA 3-20001', status: 'in_progress', ended_at: null, end_soc: null, energy_kwh: null, cost_cents: null, start_soc: 17 }), session()]
    socket.emit('ev.charging-session.updated', { charging_session_id: 's-2', vehicle_id: 'v-AA 3-20001', status: 'in_progress', change: 'ChargingSessionStarted' })

    await waitFor(() => expect(within(panel).getByText('AA 3-20001')).toBeInTheDocument())
    expect(within(panel).getByText('Bole charging hub')).toBeInTheDocument()
    expect(within(panel).getByText('5 min')).toBeInTheDocument()
    const history = table('Charging sessions')
    await waitFor(() => expect(within(history).getAllByText('Charging').length).toBeGreaterThan(0))
    expect(screen.getByText('Live')).toBeInTheDocument()
  })

  it('every synthetic record carries a visible Synthetic data badge; real ones do not', async () => {
    serve({
      fleet: [ev('AA 3-20001', 40, { latest: { state_of_charge: 40, battery_health: 90, estimated_range_km: null, recorded_at: minutesAgo(10), source: 'synthetic' } }), ev('AA 3-20002', 70)],
      sessions: [session({ id: 's-9', source: 'synthetic', registration_number: 'AA 3-20001' }), session()],
    })
    signedInAs(manager)
    open()
    const list = await screen.findByRole('table', { name: /lowest charge first/ })
    await waitFor(() => expect(plates(list)).toEqual(['AA 3-20001', 'AA 3-20002']))
    const [synthetic, real] = within(list).getAllByRole('row').slice(1)
    expect(within(synthetic).getByText('Synthetic data')).toBeVisible()
    expect(within(real).queryByText('Synthetic data')).not.toBeInTheDocument()
    const history = table('Charging sessions')
    await waitFor(() => expect(within(history).getAllByText('Synthetic data')).toHaveLength(1))
    // The screen says so once in its title, too.
    expect(within(screen.getByRole('heading', { level: 1 })).getByText('Synthetic data')).toBeInTheDocument()
  })

  it('the session history filters by status', async () => {
    const requests: URL[] = []
    serve({ fleet: [ev('AA 3-20001', 50)], sessions: [session()] })
    server.use(
      http.get('/api/v1/ev/charging-sessions', ({ request }) => {
        requests.push(new URL(request.url))
        return HttpResponse.json({ data: [session()], meta: { request_id: 'r', page: 1, page_size: 25, total_items: 1, total_pages: 1 } })
      }),
    )
    signedInAs(manager)
    open()
    await screen.findByRole('table', { name: /Charging sessions/ })
    await userEvent.click(screen.getByRole('button', { name: /^Failed/ }))
    await waitFor(() => expect(requests.at(-1)?.searchParams.get('status')).toBe('failed'))
  })

  it('needs ev:read: a dispatcher has no EV fleet', async () => {
    serve({ fleet: [], sessions: [] })
    signedInAs(currentUser(['dispatcher'], ['trip:read', 'vehicle:read']))
    open()
    await waitFor(() => expect(screen.queryByRole('heading', { name: /EV fleet/ })).not.toBeInTheDocument())
  })
})

describe('what the EV dashboard says (FMS-99)', () => {
  it('a charge level: critical below half the line, low below it', () => {
    expect(chargeLevel(ev('a', 9))).toBe('critical')
    expect(chargeLevel(ev('a', 10))).toBe('low')
    expect(chargeLevel(ev('a', 19.9))).toBe('low')
    expect(chargeLevel(ev('a', 20))).toBe('ok')
    expect(chargeLevel(ev('a', null))).toBe('unknown')
  })

  it('the figures, the order, the times', () => {
    const list = [ev('b', 50, { charging: { id: 's', station: null, started_at: null, start_soc: null, source: 'manual' } }), ev('a', 5), ev('c', null)]
    expect(fleetFigures(list)).toEqual({ total: 3, charging: 1, low: 1, unknown: 1 })
    expect([...list].sort(lowestFirst).map((v) => v.registration_number)).toEqual(['a', 'b', 'c'])
    const now = Date.parse('2026-11-26T12:00:00Z')
    expect(ago('2026-11-26T11:57:00Z', now)).toBe('3 min ago')
    expect(ago('2026-11-24T11:00:00Z', now)).toBe('2 days ago')
    expect(duration('2026-11-26T10:35:00Z', now)).toBe('1 h 25 min')
    expect(socSpan({ start_soc: 18, end_soc: 86 })).toBe('18% → 86%')
    expect(socSpan({ start_soc: 4.5, end_soc: null })).toBe('4.5% →')
  })
})

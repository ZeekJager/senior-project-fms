import { QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http } from 'msw'
import { StrictMode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider } from '@/context/AuthContext'
import { createQueryClient } from '@/lib/query'
import { RealtimeContext, type RealtimeHandler, type RealtimeValue } from '@/lib/realtime/context'
import { AppRouter } from '@/router/AppRouter'
import { currentUser, envelope, LocationProbe, signedInAs, testApi } from '@/test/auth'
import { server } from '@/test/msw/server'
import type { LocationUpdate, VehicleLocation } from './types'

// FMS-45: the Fleet Command Center. Leaflet runs in jsdom with a size for every element (it lays
// nothing out); the socket is a stand-in the test plays events through.

const DEPOT = '11111111-1111-4111-8111-111111111111'
const dispatcher = currentUser(['dispatcher'], ['command:read', 'tracking:read', 'depot:read', 'trip:read', 'vehicle:read', 'driver:read'])
const driverUser = currentUser(['driver'], ['trip:execute', 'trip:read', 'vehicle:read'])

const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString()

function located(id: string, plate: string, lat: number, lng: number, overrides: Partial<VehicleLocation> = {}): VehicleLocation {
  return {
    vehicle_id: id,
    registration_number: plate,
    vehicle_type: 'truck',
    vehicle_status: 'active',
    maintenance_flag: false,
    depot_id: DEPOT,
    position: { lat, lng, speed_kmh: 42, heading: 90, accuracy_m: 5, ignition_on: true, recorded_at: ago(5), stopped_since: null },
    trip: null,
    flags: [],
    ...overrides,
  }
}

const onTrip = located('v-1', 'AA 3-10001', 9.0, 38.75, {
  trip: { trip_id: 't-1', route_name: 'Bole - Adama', origin: null, destination: null, started_at: ago(1800), scheduled_end: null, driver: { driver_id: 'dr-1', full_name: 'Abebe Kebede' } },
})
const speeding = located('v-2', 'AA 3-10002', 9.02, 38.77, {
  flags: [{ flag_type: 'speeding', severity: 'high', observed_at: ago(10) }],
  trip: { trip_id: 't-2', route_name: null, origin: 'Piassa', destination: 'Kality', started_at: ago(600), scheduled_end: null, driver: { driver_id: 'dr-2', full_name: 'Sara Haile' } },
})
const quiet = located('v-3', 'AA 3-10003', 9.04, 38.79, { position: { ...onTrip.position!, recorded_at: ago(110) } })

/** A socket stand-in: what the page subscribes to, and a way to play server events. */
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

function serve(vehicles: VehicleLocation[]) {
  const requests: URL[] = []
  server.use(
    http.get('/api/v1/depots', () => envelope([{ id: DEPOT, name: 'Addis Ababa Central', code: 'ADD', location: 'Addis Ababa' }])),
    http.get('/api/v1/tracking/vehicles/current', ({ request }) => {
      requests.push(new URL(request.url))
      return envelope(vehicles)
    }),
  )
  return requests
}

function open(path = '/command-center') {
  const socket = fakeSocket()
  // StrictMode, as in main.tsx: it remounts effects, which once closed the chosen vehicle's popup.
  render(
    <StrictMode>
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={[path]}>
          <AuthProvider api={testApi()}>
            <RealtimeContext.Provider value={socket}>
              <LocationProbe />
              <AppRouter />
            </RealtimeContext.Provider>
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </StrictMode>,
  )
  return socket
}

const marker = (plate: string) => document.querySelector<HTMLElement>(`.fleet-marker-icon[aria-label^="${plate}:"]`)
/** Where Leaflet put a marker: a transform where the browser has 3D, left and top in jsdom. */
const placed = (el: HTMLElement) => el.style.transform || `${el.style.left},${el.style.top}`
const markerState = (plate: string) => marker(plate)?.querySelector('.fleet-marker')?.getAttribute('data-state')
const card = (plate: string) => within(screen.getByRole('list', { name: 'Vehicles' })).getByText(plate, { selector: '.plate' }).closest('button')!

const sizes = ['clientWidth', 'clientHeight'] as const
const sizeProperties = sizes.map((name) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, name))
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 600 })
})
afterAll(() => {
  sizes.forEach((name, i) => (sizeProperties[i] ? Object.defineProperty(HTMLElement.prototype, name, sizeProperties[i]!) : delete (HTMLElement.prototype as never)[name]))
})
beforeEach(() => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Fleet Command Center (FMS-45)', () => {
  it('draws every reporting vehicle and lists the trips under way with driver, route, speed and last seen', async () => {
    serve([onTrip, speeding, quiet])
    signedInAs(dispatcher)
    open()
    expect(await screen.findByRole('heading', { name: 'Live map', level: 1 })).toBeInTheDocument()
    await waitFor(() => expect(document.querySelectorAll('.fleet-marker')).toHaveLength(3))

    const list = screen.getByRole('list', { name: 'Vehicles' })
    // "On trip" by default: the two with a trip, by plate.
    expect(within(list).getAllByRole('button').map((b) => within(b).getByText(/^AA /).textContent)).toEqual(['AA 3-10001', 'AA 3-10002'])
    const first = card('AA 3-10001')
    expect(first).toHaveTextContent('Abebe Kebede')
    expect(first).toHaveTextContent('Bole - Adama')
    expect(first).toHaveTextContent('42 km/h')
    expect(first).toHaveTextContent('Last seen just now')
    expect(card('AA 3-10002')).toHaveTextContent('Piassa → Kality')
  })

  it('a speeding flag pulses the marker red and badges the card SPEEDING', async () => {
    serve([onTrip, speeding])
    signedInAs(dispatcher)
    open()
    await waitFor(() => expect(markerState('AA 3-10002')).toBe('speeding'))
    expect(within(card('AA 3-10002')).getByText('Speeding')).toBeInTheDocument()
    expect(markerState('AA 3-10001')).toBe('moving')
  })

  it('a socket position moves the marker and updates the card within 500 ms', async () => {
    serve([onTrip, speeding])
    signedInAs(dispatcher)
    const socket = open()
    await waitFor(() => expect(marker('AA 3-10001')).not.toBeNull())
    const before = placed(marker('AA 3-10001')!)

    const sent = Date.now()
    const update: LocationUpdate = { vehicle_id: 'v-1', depot_id: DEPOT, trip_id: 't-1', lat: 9.01, lng: 38.76, speed: 63, heading: 45, recorded_at: new Date().toISOString() }
    socket.emit('vehicle.location.updated', update)
    // Both within the budget. The card renders the update at once; react-leaflet moves the marker in an effect
    // after it, so checking the marker as soon as the card changed raced it (CI, 31 Oct 2026).
    await waitFor(
      () => {
        expect(card('AA 3-10001')).toHaveTextContent('63 km/h')
        expect(placed(marker('AA 3-10001')!)).not.toBe(before)
      },
      { timeout: 500 },
    )
    expect(Date.now() - sent).toBeLessThan(500)
  })

  it('a vehicle with no ping for 2 minutes turns grey and its card says OFFLINE, without a reload', async () => {
    const requests = serve([onTrip, quiet])
    signedInAs(dispatcher)
    open('/command-center?view=all')
    await waitFor(() => expect(markerState('AA 3-10003')).toBe('moving'))
    expect(within(card('AA 3-10003')).queryByText('Offline')).not.toBeInTheDocument()
    const loads = requests.length

    // 15 seconds later its last ping is 125 s old. Only the clock moves; the page's timers do the rest.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 15_000)
    await waitFor(() => expect(within(card('AA 3-10003')).getByText('Offline')).toBeInTheDocument(), { timeout: 2000 })
    await waitFor(() => expect(markerState('AA 3-10003')).toBe('offline'), { timeout: 11_000 })
    expect(requests.length).toBe(loads)
  }, 15_000)

  it('choosing a card opens the vehicle’s popup on the map; choosing a marker selects its card', async () => {
    serve([onTrip, speeding, quiet])
    signedInAs(dispatcher)
    open('/command-center?view=all')
    await waitFor(() => expect(marker('AA 3-10002')).not.toBeNull())

    await userEvent.click(card('AA 3-10002'))
    expect(card('AA 3-10002')).toHaveAttribute('aria-pressed', 'true')
    const popup = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('.fleet-map-popup')
      expect(el).not.toBeNull()
      return el!
    })
    expect(popup).toHaveTextContent('AA 3-10002')
    expect(popup).toHaveTextContent('Sara Haile')

    // Still open a moment later: nothing closes it but the user.
    await new Promise((r) => setTimeout(r, 300))
    expect(card('AA 3-10002')).toHaveAttribute('aria-pressed', 'true')
    expect(document.querySelectorAll('.fleet-marker--selected')).toHaveLength(1)

    fireEvent.click(marker('AA 3-10001')!)
    await waitFor(() => expect(card('AA 3-10001')).toHaveAttribute('aria-pressed', 'true'))
    expect(card('AA 3-10002')).toHaveAttribute('aria-pressed', 'false')
    await waitFor(() => expect(document.querySelector('.fleet-map-popup')).toHaveTextContent('AA 3-10001'))

    // Its close button ends the choice.
    await userEvent.click(within(document.querySelector<HTMLElement>('.fleet-map-popup')!).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(card('AA 3-10001')).toHaveAttribute('aria-pressed', 'false'))
    expect(document.querySelectorAll('.fleet-marker--selected')).toHaveLength(0)
  })

  it('a position from a vehicle it does not know asks for a fresh snapshot', async () => {
    const requests = serve([onTrip])
    signedInAs(dispatcher)
    const socket = open()
    await waitFor(() => expect(requests).toHaveLength(1))
    socket.emit('vehicle.location.updated', { vehicle_id: 'v-new', depot_id: DEPOT, trip_id: null, lat: 9, lng: 38.7, speed: 10, heading: null, recorded_at: new Date().toISOString() })
    await waitFor(() => expect(requests).toHaveLength(2))
  })

  it('search finds a vehicle by plate, driver or route', async () => {
    serve([onTrip, speeding])
    signedInAs(dispatcher)
    open()
    await screen.findByText('AA 3-10001', { selector: '.plate' })
    await userEvent.type(screen.getByRole('searchbox', { name: 'Find a vehicle, driver or route' }), 'kality')
    const list = screen.getByRole('list', { name: 'Vehicles' })
    expect(within(list).getAllByRole('button')).toHaveLength(1)
    expect(card('AA 3-10002')).toBeInTheDocument()
  })

  it('a driver opening the route sees nothing of it', async () => {
    serve([onTrip])
    signedInAs(driverUser)
    open()
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Live map', level: 1 })).not.toBeInTheDocument())
    expect(screen.queryByRole('region', { name: 'Live fleet map' })).not.toBeInTheDocument()
  })
})

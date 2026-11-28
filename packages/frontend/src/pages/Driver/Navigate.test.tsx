import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { currentUser, envelope, renderApp, signedInAs } from '@/test/auth'
import { server } from '@/test/msw/server'
import type { DriverTrip } from './api'
import type { TripNavigation } from './navigation'

// FMS-166: the driver's live navigation screen.

const driver = currentUser(['driver'], ['trip:execute', 'trip:read', 'vehicle:read'])
const TRIP = 't0000000-0000-4000-8000-000000000001'
const trip = (overrides: Partial<DriverTrip> = {}): DriverTrip => ({
  id: TRIP,
  route_name: 'Addis Ababa - Adama',
  origin: 'Addis Ababa',
  destination: 'Adama depot',
  vehicle_id: 'v1',
  status: 'en_route',
  scheduled_start: '2026-11-02T05:30:00Z',
  scheduled_end: '2026-11-02T08:45:00Z',
  actual_start: '2026-11-02T05:34:00Z',
  planned_distance_km: 99,
  stops: [],
  version: 3,
  ...overrides,
})

/** A road due east along 9° N, about 3.3 km, with two turns and the arrival. */
const step = (type: string, lng: number, instruction: string) => ({ instruction, type, modifier: type === 'turn' ? 'left' : null, road: null, distance_m: 1100, duration_s: 100, lat: 9, lng })
const navigation = (overrides: Partial<TripNavigation> = {}): TripNavigation => ({
  trip_id: TRIP,
  status: 'en_route',
  origin: { lat: 9, lng: 38.7, source: 'phone' },
  waypoints: [
    { kind: 'stop', stop_id: 's2', sequence_number: 2, name: 'Bishoftu', lat: 9, lng: 38.72 },
    { kind: 'destination', stop_id: null, sequence_number: null, name: 'Adama depot', lat: 9, lng: 38.73 },
  ],
  destination: { kind: 'destination', stop_id: null, sequence_number: null, name: 'Adama depot', lat: 9, lng: 38.73 },
  road: {
    distance_km: 3.3,
    duration_seconds: 600,
    arrival_at: '2026-11-02T06:00:00Z',
    geometry: { type: 'LineString', coordinates: [[38.7, 9], [38.71, 9], [38.72, 9], [38.73, 9]] },
    steps: [step('depart', 38.7, 'Head off'), step('turn', 38.71, 'Turn left onto Ring Road'), step('arrive', 38.72, 'Arrive at Bishoftu'), step('arrive', 38.73, 'Arrive at Adama depot')],
  },
  no_road: null,
  straight_line: { distance_km: 2.2, bearing_deg: 90 },
  as_of: '2026-11-02T05:50:00Z',
  ...overrides,
})

function phoneGps() {
  const watchers = new Map<number, { ok: PositionCallback; fail: PositionErrorCallback }>()
  let next = 0
  const geolocation = {
    watchPosition: vi.fn((ok: PositionCallback, fail: PositionErrorCallback) => {
      watchers.set(++next, { ok, fail })
      return next
    }),
    clearWatch: vi.fn((id: number) => watchers.delete(id)),
    getCurrentPosition: vi.fn(),
  }
  Object.defineProperty(navigator, 'geolocation', { value: geolocation, configurable: true })
  return {
    at: (latitude: number, longitude: number) =>
      act(() => {
        for (const w of watchers.values()) {
          w.ok({ timestamp: Date.now(), coords: { latitude, longitude, accuracy: 8, altitude: null, altitudeAccuracy: null, heading: null, speed: 12 } } as GeolocationPosition)
        }
      }),
    deny: () =>
      act(() => {
        for (const w of watchers.values()) w.fail({ code: 1, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3, message: 'denied' } as GeolocationPositionError)
      }),
  }
}

function serve(answer: () => TripNavigation) {
  const asked: (string | null)[] = []
  server.use(
    http.get('/api/v1/trips', ({ request }) => envelope(new URL(request.url).searchParams.get('status') === 'en_route' ? [trip()] : [])),
    http.get('/api/v1/vehicles/v1', () => envelope({ registration_number: 'AA 3-10001', make: 'Isuzu', model: 'NPR' })),
    http.post('/api/v1/tracking/gps-pings', () => HttpResponse.json({ data: { accepted: 1, duplicates: 0, rejected: [] }, meta: { request_id: 'r' } }, { status: 202 })),
    http.get(`/api/v1/trips/${TRIP}/navigation`, ({ request }) => {
      asked.push(new URL(request.url).searchParams.get('from'))
      return envelope(answer())
    }),
  )
  return asked
}

afterEach(() => localStorage.clear())

describe('Driver navigation (FMS-166)', () => {
  it('asks for the road from the phone, then shows the next turn, the next stop, the time and distance left and the arrival', async () => {
    const gps = phoneGps()
    const asked = serve(() => navigation())
    signedInAs(driver)
    renderApp(`/driver/navigate?trip=${TRIP}`)
    await screen.findByRole('region', { name: 'Trip progress' })
    await gps.at(9, 38.7)

    const turn = await screen.findByRole('region', { name: 'Next turn' })
    expect(await within(turn).findByText('Turn left onto Ring Road')).toBeInTheDocument()
    expect(within(turn).getByText('1.1 km')).toBeInTheDocument()
    expect(asked).toEqual(['9.000000,38.700000'])

    const sheet = screen.getByRole('region', { name: 'Trip progress' })
    expect(within(sheet).getByRole('heading', { name: 'Bishoftu' })).toBeInTheDocument()
    expect(within(sheet).getByText('Next stop · 2')).toBeInTheDocument()
    expect(within(sheet).getByText('Then Adama depot')).toBeInTheDocument()
    expect(within(sheet).getByText('10 min')).toBeInTheDocument()
    expect(within(sheet).getByText('3.3 km')).toBeInTheDocument()
    expect(within(sheet).getByText('Arrive')).toBeInTheDocument()
    const maps = within(sheet).getByRole('link', { name: /Open in Google Maps/ })
    expect(maps.getAttribute('href')).toContain('destination=9%2C38.73')
  })

  it('moving along the road updates the next turn on the phone without asking the server again', async () => {
    const gps = phoneGps()
    const asked = serve(() => navigation())
    signedInAs(driver)
    renderApp('/driver/navigate')
    await screen.findByRole('region', { name: 'Trip progress' })
    await gps.at(9, 38.7)
    await screen.findByText('Turn left onto Ring Road')
    await gps.at(9, 38.7105)
    expect(await screen.findByText('Arrive at Bishoftu')).toBeInTheDocument()
    expect(asked).toHaveLength(1)
  })

  it('leaving the road says so; without a road the arrow points the way with the distance as the crow flies', async () => {
    const gps = phoneGps()
    serve(() => navigation({ road: null, no_road: 'routing_unavailable' }))
    signedInAs(driver)
    renderApp('/driver/navigate')
    await screen.findByRole('region', { name: 'Trip progress' })
    await gps.at(9, 38.7)
    const turn = await screen.findByRole('region', { name: 'Next turn' })
    expect(await within(turn).findByText('Head east, as the crow flies')).toBeInTheDocument()
    expect(within(turn).getByText('2.2 km')).toBeInTheDocument()
    expect(screen.getByText(/Road directions are not reachable right now/)).toBeInTheDocument()
  })

  it('a blocked location is explained once', async () => {
    const gps = phoneGps()
    serve(() => navigation({ origin: null, road: null, no_road: 'no_origin', straight_line: null }))
    signedInAs(driver)
    renderApp('/driver/navigate')
    await screen.findByRole('region', { name: 'Trip progress' })
    await gps.deny()
    // Said once: the driver portal's banner, as the trip is under way.
    expect(await screen.findByText(/Location is blocked/)).toBeInTheDocument()
  })

  it('with no trip today there is nothing to navigate', async () => {
    phoneGps()
    serve(() => navigation())
    server.use(http.get('/api/v1/trips', () => envelope([])))
    signedInAs(driver)
    renderApp('/driver/navigate')
    expect(await screen.findByText('No trip to navigate')).toBeInTheDocument()
  })

  it('My day has a Navigate button on the trip under way', async () => {
    phoneGps()
    serve(() => navigation())
    signedInAs(driver)
    renderApp('/driver')
    const card = await screen.findByRole('article', { name: 'Your trip' })
    const link = within(card).getByRole('link', { name: 'Navigate' })
    expect(link).toHaveAttribute('href', `/driver/navigate?trip=${TRIP}`)
    await userEvent.setup().click(link)
    expect(await screen.findByRole('region', { name: 'Next turn' })).toBeInTheDocument()
  })
})

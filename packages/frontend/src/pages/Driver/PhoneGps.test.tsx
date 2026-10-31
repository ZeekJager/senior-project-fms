import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bufferPing, countPings, MAX_BUFFERED, oldestPings, removePings, type PhonePing } from '@/features/phoneGps/buffer'
import { currentUser, envelope, renderApp, signedInAs } from '@/test/auth'
import { server } from '@/test/msw/server'
import type { DriverTrip } from './api'

const driver = currentUser(['driver'], ['trip:execute', 'trip:read', 'vehicle:read', 'dvir:write'])
const VEHICLE = 'v0000000-0000-4000-8000-000000000001'

const trip = (overrides: Partial<DriverTrip> = {}): DriverTrip => ({
  id: 't0000000-0000-4000-8000-000000000001',
  route_name: 'Addis Ababa - Adama',
  origin: 'Addis Ababa',
  destination: 'Adama',
  vehicle_id: VEHICLE,
  status: 'en_route',
  scheduled_start: '2026-11-02T05:30:00Z',
  scheduled_end: '2026-11-02T08:45:00Z',
  actual_start: '2026-11-02T05:34:00Z',
  planned_distance_km: 99,
  stops: [],
  version: 3,
  ...overrides,
})

/** The phone's GPS: who watches, and a way to give them a reading or an error. */
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
    geolocation,
    watching: () => watchers.size,
    reading: (latitude: number, accuracy = 6) => {
      for (const w of watchers.values()) {
        w.ok({ timestamp: Date.now(), coords: { latitude, longitude: 38.76, accuracy, altitude: null, altitudeAccuracy: null, heading: null, speed: 11 } } as GeolocationPosition)
      }
    },
    deny: () => {
      for (const w of watchers.values()) w.fail({ code: 1, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3, message: 'denied' } as GeolocationPositionError)
    },
  }
}

/** Today's trips, ending a trip, and the pings the phone posts. */
function serve(state: { underWay: DriverTrip[] }) {
  const posted: PhonePing[][] = []
  server.use(
    http.get('/api/v1/trips', ({ request }) => envelope(new URL(request.url).searchParams.get('status') === 'en_route' ? state.underWay : [])),
    http.get(`/api/v1/vehicles/${VEHICLE}`, () => envelope({ registration_number: 'AA 3-10001', make: 'Isuzu', model: 'NPR' })),
    http.post('/api/v1/tracking/gps-pings', async ({ request }) => {
      const { pings } = (await request.json()) as { pings: PhonePing[] }
      posted.push(pings)
      return HttpResponse.json({ data: { accepted: pings.length, duplicates: 0, rejected: [] }, meta: { request_id: 'r' } }, { status: 202 })
    }),
    http.post(`/api/v1/trips/${trip().id}/end`, () => {
      state.underWay = []
      return HttpResponse.json({ data: trip(), meta: { warnings: [], request_id: 'r' } })
    }),
  )
  return posted
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'geolocation')
  // The day saved on the phone (FMS-34) would otherwise carry a trip into the next test.
  localStorage.clear()
})

describe('the phone as the vehicle GPS (FMS-57)', () => {
  it('during the trip a reading goes to the server at once, an imprecise one never; ending the trip stops the watch', async () => {
    const gps = phoneGps()
    const posted = serve({ underWay: [trip()] })
    signedInAs(driver)
    renderApp('/driver')
    const card = await screen.findByRole('article', { name: 'Your trip' })
    await waitFor(() => expect(gps.watching()).toBe(1))
    expect(gps.geolocation.watchPosition).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), expect.objectContaining({ enableHighAccuracy: true }))
    expect(within(card).getByText('Finding your position…')).toBeInTheDocument()

    gps.reading(9.0108, 250)
    expect(await within(card).findByText(/GPS signal is weak/)).toBeInTheDocument()
    gps.reading(9.0108)
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toEqual([expect.objectContaining({ lat: 9.0108, lng: 38.76, speed_kmh: 39.6, accuracy_m: 6 })])
    expect(posted[0][0]).not.toHaveProperty('vehicle_id')
    expect(await within(card).findByText('Sharing your location with dispatch')).toBeInTheDocument()

    await userEvent.setup().click(within(card).getByRole('button', { name: 'End trip' }))
    await waitFor(() => expect(gps.watching()).toBe(0))
    expect(gps.geolocation.clearWatch).toHaveBeenCalled()
  })

  it('blocked location: a banner on every tab says dispatch cannot see the vehicle, and Try again asks again', async () => {
    const gps = phoneGps()
    serve({ underWay: [trip()] })
    signedInAs(driver)
    renderApp('/driver')
    await waitFor(() => expect(gps.watching()).toBe(1))
    gps.deny()

    expect(await screen.findByText('Location is blocked')).toBeInTheDocument()
    expect(screen.getByText(/Dispatch cannot see your vehicle on the map/)).toBeInTheDocument()
    expect(gps.watching()).toBe(0)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(gps.watching()).toBe(1))
    await waitFor(() => expect(screen.queryByText('Location is blocked')).not.toBeInTheDocument())
  })

  it('nothing is watched without a trip under way', async () => {
    const gps = phoneGps()
    serve({ underWay: [] })
    signedInAs(driver)
    renderApp('/driver')
    await screen.findByText('No trip assigned for today')
    expect(gps.geolocation.watchPosition).not.toHaveBeenCalled()
  })
})

describe('the positions waiting on the phone', () => {
  const ping = (n: number): PhonePing => ({ recorded_at: new Date(Date.UTC(2026, 9, 31, 6, 0, n)).toISOString(), lat: 9, lng: 38, speed_kmh: 0, heading: null, accuracy_m: 5, altitude_m: null })

  it("are kept per driver, oldest first, and removed once sent; another driver's are never in a batch", async () => {
    await bufferPing('u-1', ping(1))
    await bufferPing('u-2', ping(2))
    await bufferPing('u-1', ping(3))
    const mine = await oldestPings('u-1', 10)
    expect(mine.map((b) => b.ping.recorded_at)).toEqual([ping(1).recorded_at, ping(3).recorded_at])
    expect(await oldestPings('u-1', 1)).toHaveLength(1)
    await removePings([mine[0].seq])
    expect(await countPings('u-1')).toBe(1)
    expect(await countPings('u-2')).toBe(1)
    expect(MAX_BUFFERED).toBe(20_000)
  })
})

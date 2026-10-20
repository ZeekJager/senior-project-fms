import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import { currentUser, envelope, errorEnvelope, renderApp, signedInAs } from '@/test/auth'
import { server } from '@/test/msw/server'
import { operatingToday, type DriverTrip } from './api'

const driver = currentUser(['driver'], ['trip:execute', 'trip:read', 'vehicle:read', 'dvir:write'])
const VEHICLE = 'v0000000-0000-4000-8000-000000000001'

function trip(overrides: Partial<DriverTrip> = {}): DriverTrip {
  return {
    id: 't0000000-0000-4000-8000-000000000001',
    route_name: 'Addis Ababa - Adama',
    origin: 'Addis Ababa',
    destination: 'Adama',
    vehicle_id: VEHICLE,
    status: 'assigned',
    scheduled_start: '2026-11-02T05:30:00Z',
    scheduled_end: '2026-11-02T08:45:00Z',
    actual_start: null,
    planned_distance_km: 99,
    stops: [
      { id: 's2', sequence_number: 2, name: 'Bishoftu', status: 'planned' },
      { id: 's1', sequence_number: 1, name: 'Dukem', status: 'planned' },
    ],
    version: 3,
    ...overrides,
  }
}

/** The driver's trips: what is under way, and what is assigned today. Records the queries. */
function serveDay(state: { underWay: DriverTrip[]; assigned: DriverTrip[] }) {
  const queries: URLSearchParams[] = []
  server.use(
    http.get('/api/v1/trips', ({ request }) => {
      const q = new URL(request.url).searchParams
      queries.push(q)
      return envelope(q.get('status') === 'en_route' ? state.underWay : state.assigned)
    }),
    http.get(`/api/v1/vehicles/${VEHICLE}`, () => envelope({ registration_number: 'AA 3-10001', make: 'Isuzu', model: 'NPR' })),
  )
  return queries
}

async function openHome() {
  signedInAs(driver)
  renderApp('/driver')
  await screen.findByRole('heading', { name: 'My day', level: 1 })
}

const card = () => screen.findByRole('article', { name: 'Your trip' })

afterEach(() => {
  localStorage.clear()
  // An 'offline' event also pauses TanStack Query's global online manager: put it back.
  act(() => void window.dispatchEvent(new Event('online')))
})

describe('Driver Home (S-11)', () => {
  it("a driver with a trip assigned today sees its route, times, vehicle and stops; today's trips only", async () => {
    const queries = serveDay({ underWay: [], assigned: [trip()] })
    await openHome()
    const c = await card()
    expect(within(c).getByText('Addis Ababa - Adama')).toBeInTheDocument()
    // Addis Ababa time (UTC+3), large.
    expect(c).toHaveTextContent('08:30–11:45')
    expect(within(c).getByText('Addis Ababa')).toBeInTheDocument()
    expect(within(c).getByText('Adama')).toBeInTheDocument()
    expect(await within(c).findByText('AA 3-10001')).toBeInTheDocument()
    expect(within(c).getByText('2 stops on the way')).toBeInTheDocument()
    expect(within(c).getAllByRole('listitem').map((li) => li.textContent)).toEqual(expect.arrayContaining(['1Dukem', '2Bishoftu']))

    const today = operatingToday()
    const assigned = queries.find((q) => q.get('status') === 'assigned')!
    expect([assigned.get('from'), assigned.get('to')]).toEqual([today, today])
    // Never past trips or history: only what is under way, and today's assigned.
    expect(queries.every((q) => ['assigned', 'en_route'].includes(q.get('status') ?? ''))).toBe(true)
  })

  it("'START TRIP' calls start with the version on screen, and the button becomes 'END TRIP'", async () => {
    const state = { underWay: [] as DriverTrip[], assigned: [trip()] }
    serveDay(state)
    let sent: { ifMatch: string | null; key: string | null } | null = null
    server.use(
      http.post(`/api/v1/trips/${trip().id}/start`, ({ request }) => {
        sent = { ifMatch: request.headers.get('If-Match'), key: request.headers.get('Idempotency-Key') }
        const started = trip({ status: 'en_route', actual_start: '2026-11-02T05:34:00Z', version: 4 })
        state.underWay = [started]
        state.assigned = []
        return HttpResponse.json({ data: started, meta: { warnings: [], request_id: 'r' } })
      }),
    )
    await openHome()
    const user = userEvent.setup()
    await user.click(within(await card()).getByRole('button', { name: 'Start trip' }))
    await waitFor(() => expect(sent).not.toBeNull())
    expect(sent!.ifMatch).toBe('"3"')
    expect(sent!.key).toMatch(/^[0-9a-f-]{36}$/)
    expect(await within(await card()).findByRole('button', { name: 'End trip' })).toBeInTheDocument()
    expect(await card()).toHaveTextContent('On the road')
    expect(await card()).toHaveTextContent('Started at 08:34')
  })

  it("'END TRIP' ends the trip and leads to the post-trip inspection (FMS-37)", async () => {
    const state = { underWay: [trip({ status: 'en_route', actual_start: '2026-11-02T05:34:00Z' })], assigned: [] as DriverTrip[] }
    serveDay(state)
    server.use(
      http.post(`/api/v1/trips/${trip().id}/end`, () => {
        state.underWay = []
        return HttpResponse.json({ data: trip({ status: 'en_route' }), meta: { warnings: [], request_id: 'r' } })
      }),
    )
    await openHome()
    const user = userEvent.setup()
    await user.click(within(await card()).getByRole('button', { name: 'End trip' }))

    const prompt = await screen.findByRole('region', { name: 'Post-trip inspection' })
    expect(within(prompt).getByRole('link', { name: 'Start post-trip inspection' })).toHaveAttribute('href', `/driver/dvir?trip=${trip().id}&type=post_trip`)
    // The trip is over: no trip card, and no "no trip today" message competing with the prompt.
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Your trip' })).not.toBeInTheDocument())
    expect(screen.queryByText('No trip assigned for today')).not.toBeInTheDocument()

    await user.click(within(prompt).getByRole('link', { name: 'Start post-trip inspection' }))
    expect(await screen.findByRole('heading', { name: 'Vehicle inspection' })).toBeInTheDocument()
  })

  it('the post-trip prompt stays until the driver puts it off', async () => {
    localStorage.setItem('fms-driver-post-trip', trip().id)
    serveDay({ underWay: [], assigned: [] })
    await openHome()
    const prompt = await screen.findByRole('region', { name: 'Post-trip inspection' })
    await userEvent.setup().click(within(prompt).getByRole('button', { name: 'Later' }))
    expect(screen.queryByRole('region', { name: 'Post-trip inspection' })).not.toBeInTheDocument()
    expect(localStorage.getItem('fms-driver-post-trip')).toBeNull()
  })

  it('a refused start says why, under the button', async () => {
    serveDay({ underWay: [], assigned: [trip()] })
    server.use(http.post(`/api/v1/trips/${trip().id}/start`, () => errorEnvelope(409, 'CONFLICT_DRIVER_NOT_ELIGIBLE', 'x', [{ field: 'driver_id', reason: 'license_expired' }])))
    await openHome()
    await userEvent.setup().click(within(await card()).getByRole('button', { name: 'Start trip' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('You cannot drive this trip: your licence has expired. Call dispatch.')
  })

  it('no trip today: says so, without showing anything else', async () => {
    serveDay({ underWay: [], assigned: [] })
    await openHome()
    expect(await screen.findByRole('heading', { name: 'No trip assigned for today' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /trip/i })).not.toBeInTheDocument()
  })

  it('later trips today are listed under the next one', async () => {
    serveDay({ underWay: [], assigned: [trip(), trip({ id: 't2', route_name: 'Adama - Awash', origin: 'Adama', destination: 'Awash', scheduled_start: '2026-11-02T11:00:00Z' })] })
    await openHome()
    const later = await screen.findByRole('region', { name: 'Later today' })
    expect(later).toHaveTextContent('Adama - Awash')
    expect(later).toHaveTextContent('14:00')
  })

  it("with no signal, shows the day saved on this phone, and START needs signal", async () => {
    signedInAs(driver)
    localStorage.setItem('fms-driver-today', JSON.stringify({ userId: driver.user.id, day: operatingToday(), savedAt: Date.parse('2026-11-02T04:12:00Z'), trips: [trip()] }))
    server.use(
      http.get('/api/v1/trips', () => HttpResponse.error()),
      http.get(`/api/v1/vehicles/${VEHICLE}`, () => HttpResponse.error()),
    )
    renderApp('/driver')
    await screen.findByRole('heading', { name: 'My day', level: 1 })
    act(() => void window.dispatchEvent(new Event('offline')))
    const c = await card()
    expect(c).toHaveTextContent('Addis Ababa - Adama')
    expect(await screen.findByText(/Saved on this phone at 07:12/)).toBeInTheDocument()
    expect(within(c).getByRole('button', { name: 'Start trip' })).toBeDisabled()
    expect(c).toHaveTextContent('Needs signal')
  })

  it("another driver's or another day's saved copy is never shown", async () => {
    localStorage.setItem('fms-driver-today', JSON.stringify({ userId: 'someone-else', day: operatingToday(), savedAt: Date.now(), trips: [trip()] }))
    serveDay({ underWay: [], assigned: [] })
    await openHome()
    expect(await screen.findByRole('heading', { name: 'No trip assigned for today' })).toBeInTheDocument()
  })

  it('with no signal and nothing saved yet, says so instead of loading forever', async () => {
    signedInAs(driver)
    renderApp('/driver')
    await screen.findByRole('heading', { name: 'My day', level: 1 })
    act(() => void window.dispatchEvent(new Event('offline')))
    expect(await screen.findByRole('heading', { name: 'No signal' })).toBeInTheDocument()
  })
})

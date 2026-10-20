import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import { enqueue, MAX_PENDING, submissionsOf } from '@/lib/offlineQueue'
import { currentUser, envelope, errorEnvelope, renderApp, signedInAs } from '@/test/auth'
import { server } from '@/test/msw/server'
import type { DriverTrip } from './api'
import { CHECKLISTS } from './checklist'

const driver = currentUser(['driver'], ['trip:execute', 'trip:read', 'vehicle:read', 'dvir:write'])
const VEHICLE = 'v0000000-0000-4000-8000-000000000001'
const TRIP = 't0000000-0000-4000-8000-000000000001'

function trip(overrides: Partial<DriverTrip> = {}): DriverTrip {
  return {
    id: TRIP,
    route_name: 'Addis Ababa - Adama',
    origin: 'Addis Ababa',
    destination: 'Adama',
    vehicle_id: VEHICLE,
    status: 'assigned',
    scheduled_start: '2026-11-02T05:30:00Z',
    scheduled_end: '2026-11-02T08:45:00Z',
    actual_start: null,
    planned_distance_km: 99,
    stops: [],
    version: 3,
    ...overrides,
  }
}

/** Today's trips, the vehicle, and POST /dvir-reports (recorded; `up: false` is airplane mode). */
function serve(state: { trips: DriverTrip[]; up?: boolean }) {
  const posts: { body: Record<string, unknown>; key: string | null }[] = []
  server.use(
    http.get('/api/v1/trips', ({ request }) => {
      const status = new URL(request.url).searchParams.get('status')
      return envelope(state.trips.filter((t) => t.status === status))
    }),
    http.get(`/api/v1/vehicles/${VEHICLE}`, () => envelope({ registration_number: 'AA 3-10001', make: 'Isuzu', model: 'NPR' })),
    http.post('/api/v1/dvir-reports', async ({ request }) => {
      if (state.up === false) return HttpResponse.error()
      const body = (await request.json()) as Record<string, unknown>
      posts.push({ body, key: request.headers.get('Idempotency-Key') })
      return HttpResponse.json({ data: { id: 'dvir-1', ...body }, meta: { created: true } }, { status: 201 })
    }),
  )
  return posts
}

async function open(path: string) {
  signedInAs(driver)
  renderApp(path)
  await screen.findByRole('heading', { name: 'Vehicle inspection', level: 1 })
}

/** Answers every item OK, except those named, which get a problem and these notes. */
async function answerAll(user: ReturnType<typeof userEvent.setup>, problems: Record<string, string> = {}) {
  for (const item of await screen.findAllByRole('radiogroup')) {
    const name = item.getAttribute('aria-label')!
    if (name in problems) {
      await user.click(within(item).getByRole('radio', { name: 'Problem' }))
      if (problems[name]) await user.type(screen.getAllByLabelText(/What is wrong\?/).at(-1)!, problems[name])
    } else {
      await user.click(within(item).getByRole('radio', { name: 'OK' }))
    }
  }
}

const submitButton = () => screen.getByRole('button', { name: /Submit inspection|Save inspection/ })

afterEach(() => {
  localStorage.clear()
  // An 'offline' event also pauses TanStack Query's global online manager: put it back.
  act(() => void window.dispatchEvent(new Event('online')))
})

describe('Driver vehicle inspection (FMS-37, S-12)', () => {
  it('the post-trip inspection of the trip just ended: every item answered, a problem described, sent once with an Idempotency-Key', async () => {
    const posts = serve({ trips: [] })
    localStorage.setItem('fms-driver-post-trip', JSON.stringify({ userId: driver.user.id, tripId: TRIP, vehicleId: VEHICLE, routeName: 'Addis Ababa - Adama' }))
    await open(`/driver/dvir?trip=${TRIP}&type=post_trip`)
    expect(await screen.findByText('AA 3-10001')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Post-trip' })).toBeChecked()
    expect(screen.getAllByRole('radiogroup').map((g) => g.getAttribute('aria-label'))).toEqual([...CHECKLISTS.post_trip])

    const user = userEvent.setup()
    expect(submitButton()).toBeDisabled()
    expect(screen.getByText('8 of 8 to check')).toBeInTheDocument()
    await answerAll(user, { Tyres: 'Front left worn' })
    expect(screen.getByText('All checked')).toBeInTheDocument()
    expect(screen.getByText(/1 problem reported: the vehicle will be flagged for maintenance/)).toBeInTheDocument()
    await user.click(submitButton())

    expect(await screen.findByRole('heading', { name: 'Inspection sent' })).toBeInTheDocument()
    expect(screen.getByText('Maintenance has the problem you reported, and the vehicle is flagged.')).toBeInTheDocument()
    expect(posts).toHaveLength(1)
    const { body, key } = posts[0]
    expect(key).toMatch(/^[0-9a-f-]{36}$/)
    expect(body).toMatchObject({ vehicle_id: VEHICLE, trip_id: TRIP, type: 'post_trip' })
    expect(body.items).toEqual(CHECKLISTS.post_trip.map((name) => (name === 'Tyres' ? { name, passed: false, notes: 'Front left worn' } : { name, passed: true, notes: null })))
    expect(Date.parse(body.submitted_at as string)).toBeGreaterThan(Date.now() - 60_000)
    // My day's reminder is done with.
    expect(localStorage.getItem('fms-driver-post-trip')).toBeNull()
    expect(await submissionsOf(driver.user.id)).toEqual([])
  })

  it('in airplane mode the report is kept on the phone with the pending badge, and reaches the server after reconnecting', async () => {
    const state = { trips: [trip({ status: 'en_route', actual_start: '2026-11-02T05:34:00Z' })], up: false }
    const posts = serve(state)
    await open(`/driver/dvir?trip=${TRIP}&type=pre_trip`)
    await screen.findByText('AA 3-10001')
    act(() => void window.dispatchEvent(new Event('offline')))
    const user = userEvent.setup()
    await answerAll(user)
    expect(submitButton()).toHaveTextContent('Save inspection')
    await user.click(submitButton())

    expect(await screen.findByRole('heading', { name: 'Saved on this phone' })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: '1 waiting to send' })).toBeInTheDocument()
    expect(posts).toEqual([])
    const [queued] = await submissionsOf(driver.user.id)
    expect(queued).toMatchObject({ kind: 'dvir', label: 'Pre-trip inspection, AA 3-10001', path: '/dvir-reports' })

    state.up = true
    act(() => void window.dispatchEvent(new Event('online')))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].body).toMatchObject({ vehicle_id: VEHICLE, trip_id: TRIP, type: 'pre_trip' })
    expect(posts[0].key).toBe(queued.key)
    await waitFor(() => expect(screen.queryByRole('button', { name: /waiting to send/ })).not.toBeInTheDocument())
  })

  it("opens offline for the trip just ended: its vehicle comes from My day's reminder, not the server", async () => {
    localStorage.setItem('fms-driver-post-trip', JSON.stringify({ userId: driver.user.id, tripId: TRIP, vehicleId: VEHICLE, routeName: 'Addis Ababa - Adama' }))
    server.use(
      http.get('/api/v1/trips', () => HttpResponse.error()),
      http.get('/api/v1/trips/:id', () => HttpResponse.error()),
      http.get(`/api/v1/vehicles/${VEHICLE}`, () => HttpResponse.error()),
    )
    await open(`/driver/dvir?trip=${TRIP}&type=post_trip`)
    expect(await screen.findByText('Your vehicle')).toBeInTheDocument()
    expect(screen.getByText('Addis Ababa - Adama')).toBeInTheDocument()
    expect(screen.getAllByRole('radiogroup')).toHaveLength(CHECKLISTS.post_trip.length)
  })

  it('from the menu: the vehicle of the next trip today, pre-trip, with the full pre-trip checklist', async () => {
    serve({ trips: [trip()] })
    await open('/driver/dvir')
    expect(await screen.findByText('AA 3-10001')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Pre-trip' })).toBeChecked()
    expect(screen.getAllByRole('radiogroup').map((g) => g.getAttribute('aria-label'))).toEqual([
      'Tyres',
      'Brakes',
      'Lights and indicators',
      'Windscreen and mirrors',
      'Horn',
      'Fuel level',
      'Engine oil',
      'Coolant',
      'Fire extinguisher',
      'First aid kit',
    ])
  })

  it('switching between pre- and post-trip starts the checklist again', async () => {
    serve({ trips: [trip()] })
    await open('/driver/dvir')
    const user = userEvent.setup()
    await user.click(within((await screen.findAllByRole('radiogroup'))[0]).getByRole('radio', { name: 'OK' }))
    expect(screen.getByText('9 of 10 to check')).toBeInTheDocument()
    await user.click(screen.getByRole('radio', { name: 'Post-trip' }))
    expect(screen.getByText('8 of 8 to check')).toBeInTheDocument()
  })

  it('a report the server refuses says why and keeps the form as filled in', async () => {
    serve({ trips: [trip()] })
    server.use(
      http.post('/api/v1/dvir-reports', () =>
        errorEnvelope(400, 'VALIDATION_FAILED', 'The trip is assigned to a different vehicle.', [{ field: 'trip_id', reason: 'trip_vehicle_mismatch' }]),
      ),
    )
    await open('/driver/dvir')
    const user = userEvent.setup()
    await answerAll(user)
    await user.click(submitButton())
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('It was not accepted: The trip is assigned to a different vehicle.'))
    expect(screen.getByText('All checked')).toBeInTheDocument()
    expect(await submissionsOf(driver.user.id)).toEqual([])
  })

  it(`with ${MAX_PENDING} reports waiting, submitting is disabled with the documented message`, async () => {
    for (let n = 0; n < MAX_PENDING; n++) await enqueue({ ownerId: driver.user.id, kind: 'dvir', label: `Inspection ${n}`, path: '/dvir-reports', body: {} })
    serve({ trips: [trip()], up: false })
    await open('/driver/dvir')
    const user = userEvent.setup()
    await answerAll(user)
    expect(await screen.findByText('50 submissions are already waiting to send. Get signal to send them before adding another.')).toBeInTheDocument()
    expect(submitButton()).toBeDisabled()
  })

  it('no trip today: nothing to inspect (a driver inspects only the vehicle of their trip)', async () => {
    serve({ trips: [] })
    await open('/driver/dvir')
    expect(await screen.findByRole('heading', { name: 'No vehicle to inspect' })).toBeInTheDocument()
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
  })

  it("a trip that is not the driver's: refused before any checklist", async () => {
    serve({ trips: [] })
    server.use(http.get(`/api/v1/trips/${TRIP}`, () => errorEnvelope(404, 'RESOURCE_NOT_FOUND')))
    await open(`/driver/dvir?trip=${TRIP}&type=post_trip`)
    expect(await screen.findByText('This trip is not one of yours, or it no longer exists.')).toBeInTheDocument()
  })

  it("My day: the next trip offers its pre-trip inspection; ending a trip remembers its vehicle for the post-trip one", async () => {
    const state = { trips: [trip()] }
    serve(state)
    signedInAs(driver)
    const first = renderApp('/driver')
    const card = await screen.findByRole('article', { name: 'Your trip' })
    expect(within(card).getByRole('link', { name: 'Pre-trip inspection' })).toHaveAttribute('href', `/driver/dvir?trip=${TRIP}&type=pre_trip`)
    first.unmount()

    state.trips = [trip({ status: 'en_route', actual_start: '2026-11-02T05:34:00Z' })]
    server.use(http.post(`/api/v1/trips/${TRIP}/end`, () => HttpResponse.json({ data: trip({ status: 'en_route' }), meta: {} })))
    signedInAs(driver)
    renderApp('/driver')
    // My day opens from its saved copy first, then the server's answer: the trip is under way.
    const endTrip = await within(await screen.findByRole('article', { name: 'Your trip' })).findByRole('button', { name: 'End trip' })
    expect(within(screen.getByRole('article', { name: 'Your trip' })).queryByRole('link', { name: 'Pre-trip inspection' })).not.toBeInTheDocument()
    await userEvent.setup().click(endTrip)
    await screen.findByRole('region', { name: 'Post-trip inspection' })
    expect(JSON.parse(localStorage.getItem('fms-driver-post-trip')!)).toEqual({ userId: driver.user.id, tripId: TRIP, vehicleId: VEHICLE, routeName: 'Addis Ababa - Adama' })
  })
})

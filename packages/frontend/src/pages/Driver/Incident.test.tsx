import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { submissionsOf } from '@/lib/offlineQueue'
import { currentUser, envelope, errorEnvelope, renderApp, signedInAs } from '@/test/auth'
import { server } from '@/test/msw/server'
import type { DriverTrip } from './api'
import { checkIncident, EMPTY_INCIDENT, incidentBody } from './incidentReport'

const driver = currentUser(['driver'], ['trip:execute', 'trip:read', 'vehicle:read', 'incident:write', 'incident:read'])
const VEHICLE = 'v0000000-0000-4000-8000-000000000001'
const TRIP = 't0000000-0000-4000-8000-000000000001'
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

const trip = (overrides: Partial<DriverTrip> = {}): DriverTrip => ({
  id: TRIP,
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
  version: 4,
  ...overrides,
})

/** Today's trips, the vehicle, and POST /incidents as the network sees it (`up: false` is airplane mode). */
function serve(state: { trips: DriverTrip[]; up?: boolean }) {
  const posts: { body: Record<string, unknown>; key: string | null }[] = []
  server.use(
    http.get('/api/v1/trips', ({ request }) => envelope(state.trips.filter((t) => t.status === new URL(request.url).searchParams.get('status')))),
    http.get(`/api/v1/vehicles/${VEHICLE}`, () => envelope({ registration_number: 'AA 3-10001', make: 'Isuzu', model: 'NPR' })),
    http.post('/api/v1/incidents', async ({ request }) => {
      if (state.up === false) return HttpResponse.error()
      const body = (await request.json()) as Record<string, unknown>
      posts.push({ body, key: request.headers.get('Idempotency-Key') })
      return HttpResponse.json({ data: { id: 'incident-1', status: 'open', ...body }, meta: { created: true } }, { status: 201 })
    }),
  )
  return posts
}

/** The phone's location service: answers with this position (or this error) when asked, or waits for `answer()`. */
function geolocation(result: { latitude: number; longitude: number; accuracy: number } | { code: 1 | 2 | 3 } | 'wait') {
  let pending: (() => void) | null = null
  const getCurrentPosition = vi.fn((ok: PositionCallback, fail?: PositionErrorCallback | null) => {
    const reply = () => {
      if (result === 'wait' || !('code' in result)) {
        const coords = result === 'wait' ? { latitude: 9.0302, longitude: 38.7469, accuracy: 12 } : result
        ok({ coords, timestamp: Date.now() } as unknown as GeolocationPosition)
      } else fail?.({ code: result.code, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3, message: '' } as GeolocationPositionError)
    }
    if (result === 'wait') pending = reply
    else reply()
  })
  Object.defineProperty(navigator, 'geolocation', { value: { getCurrentPosition }, configurable: true })
  return { getCurrentPosition, answer: () => act(() => pending?.()) }
}

async function open(path = '/driver/incident', withVehicle = true) {
  signedInAs(driver)
  renderApp(path)
  await screen.findByRole('heading', { name: 'Report an incident', level: 1 })
  if (withVehicle) await screen.findByText('AA 3-10001')
}

const describeIt = () => screen.getByRole('textbox', { name: 'What happened' })
const submitButton = () => screen.getByRole('button', { name: /Send report|Save report/ })

afterEach(() => {
  // An 'offline' event also pauses TanStack Query's global online manager: put it back.
  act(() => void window.dispatchEvent(new Event('online')))
})

describe('Driver incident report (FMS-38, S-13)', () => {
  it('a critical accident on the trip, with the location: sent with the vehicle, the trip, when it was reported and an Idempotency-Key', async () => {
    const posts = serve({ trips: [trip()] })
    geolocation({ latitude: 9.030215678, longitude: 38.746912345, accuracy: 18.4 })
    await open()
    const user = userEvent.setup()

    await user.click(screen.getByRole('radio', { name: 'Accident' }))
    await user.click(screen.getByRole('radio', { name: /^Critical/ }))
    expect(screen.getByText(/the vehicle is flagged for a maintenance check\. Do not drive it until dispatch says so\./)).toBeInTheDocument()
    await user.type(describeIt(), '  Hit a minibus at Megenagna, nobody hurt.  ')
    await user.click(screen.getByRole('button', { name: /Add my location/ }))
    expect(screen.getByText('Within about 18 m')).toBeInTheDocument()
    const before = Date.now()
    await user.click(submitButton())

    expect(await screen.findByRole('heading', { name: 'Report sent' })).toBeInTheDocument()
    expect(screen.getByText('Dispatch has been alerted.')).toBeInTheDocument()
    expect(screen.getByText('Do not drive the vehicle until dispatch says so.')).toBeInTheDocument()
    expect(posts).toHaveLength(1)
    expect(posts[0].body).toEqual({
      description: 'Hit a minibus at Megenagna, nobody hurt.',
      severity: 'critical',
      incident_type: 'accident',
      vehicle_id: VEHICLE,
      trip_id: TRIP,
      latitude: 9.030216,
      longitude: 38.746912,
      occurred_at: expect.stringMatching(ISO),
    })
    expect(Date.parse(posts[0].body.occurred_at as string)).toBeGreaterThanOrEqual(before - 1000)
    expect(posts[0].key).toMatch(/^[0-9a-f-]{36}$/)
    expect(await submissionsOf(driver.user.id)).toEqual([])
  })

  it('offline: the report waits on the phone and reaches the server later, still stamped with when it was reported', async () => {
    const state = { trips: [trip()], up: false }
    const posts = serve(state)
    await open()
    act(() => void window.dispatchEvent(new Event('offline')))
    const user = userEvent.setup()
    await user.click(screen.getByRole('radio', { name: /^Serious/ }))
    await user.type(describeIt(), 'Rocks on the road after Mojo.')
    expect(submitButton()).toHaveTextContent('Save report')
    await user.click(submitButton())

    expect(await screen.findByRole('heading', { name: 'Saved on this phone' })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: '1 waiting to send' })).toBeInTheDocument()
    const [queued] = await submissionsOf(driver.user.id)
    expect(queued).toMatchObject({ kind: 'incident', label: 'Incident, Serious, AA 3-10001', path: '/incidents' })
    const reportedAt = (queued.body as { occurred_at: string }).occurred_at

    state.up = true
    act(() => void window.dispatchEvent(new Event('online')))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].body).toMatchObject({ severity: 'high', incident_type: 'other', description: 'Rocks on the road after Mojo.', occurred_at: reportedAt })
    expect(posts[0].key).toBe(queued.key)
    await waitFor(() => expect(screen.queryByRole('button', { name: /waiting to send/ })).not.toBeInTheDocument())
  })

  it('no trip under way: the form still works, and the report goes without a vehicle', async () => {
    const posts = serve({ trips: [] })
    await open('/driver/incident', false)
    expect(await screen.findByText(/No trip under way: the report goes to your depot without a vehicle\./)).toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(screen.getByRole('radio', { name: /^Minor/ }))
    await user.type(describeIt(), 'Someone scratched the depot gate.')
    await user.click(submitButton())

    expect(await screen.findByRole('heading', { name: 'Report sent' })).toBeInTheDocument()
    expect(posts[0].body).not.toHaveProperty('vehicle_id')
    expect(posts[0].body).not.toHaveProperty('trip_id')
    expect(screen.queryByText('Do not drive the vehicle until dispatch says so.')).not.toBeInTheDocument()
  })

  it('says what is missing before anything is queued, and the messages follow what is done next', async () => {
    const posts = serve({ trips: [trip()] })
    await open()
    const user = userEvent.setup()
    await user.type(describeIt(), '   ')
    await user.click(submitButton())
    expect(screen.getByText('Choose how serious it is.')).toBeInTheDocument()
    expect(screen.getByText('Say what happened.')).toBeInTheDocument()
    expect(describeIt()).toHaveAttribute('aria-invalid', 'true')
    expect(posts).toEqual([])
    expect(await submissionsOf(driver.user.id)).toEqual([])

    await user.click(screen.getByRole('radio', { name: /^Moderate/ }))
    expect(screen.queryByText('Choose how serious it is.')).not.toBeInTheDocument()
    expect(screen.getByText('Say what happened.')).toBeInTheDocument()
  })

  it('a location that arrives while the driver types keeps what they typed', async () => {
    serve({ trips: [trip()] })
    const gps = geolocation('wait')
    await open()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Add my location/ }))
    expect(screen.getByRole('button', { name: /Finding your location/ })).toBeDisabled()
    await user.type(describeIt(), 'Flat tyre near Dukem.')
    await gps.answer()
    expect(screen.getByText('Location added')).toBeInTheDocument()
    expect(describeIt()).toHaveValue('Flat tyre near Dukem.')

    await user.click(screen.getByRole('button', { name: 'Remove location' }))
    expect(screen.getByRole('button', { name: /Add my location/ })).toBeEnabled()
  })

  it('location blocked: says so, and the report goes without it', async () => {
    const posts = serve({ trips: [trip()] })
    geolocation({ code: 1 })
    await open()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Add my location/ }))
    expect(screen.getByText('Location is blocked for this app. Say where it happened instead.')).toBeInTheDocument()
    await user.click(screen.getByRole('radio', { name: /^Minor/ }))
    await user.type(describeIt(), 'Mirror knocked at the market.')
    await user.click(submitButton())
    await screen.findByRole('heading', { name: 'Report sent' })
    expect(posts[0].body).not.toHaveProperty('latitude')
  })

  it('a refused report says why and keeps the form as typed', async () => {
    serve({ trips: [trip()] })
    server.use(
      http.post('/api/v1/incidents', () =>
        errorEnvelope(400, 'VALIDATION_FAILED', 'The vehicle has been retired: report the incident without it, or name the vehicle in use.', [
          { field: 'vehicle_id', reason: 'vehicle_retired' },
        ]),
      ),
    )
    await open()
    const user = userEvent.setup()
    await user.click(screen.getByRole('radio', { name: /^Serious/ }))
    await user.type(describeIt(), 'Engine smoke.')
    await user.click(submitButton())
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('It was not accepted: The vehicle has been retired'))
    expect(describeIt()).toHaveValue('Engine smoke.')
    expect(await submissionsOf(driver.user.id)).toEqual([])
  })
})

describe('incident body', () => {
  const draft = { ...EMPTY_INCIDENT, severity: 'medium' as const, description: ' Dent ' }

  it('trims the text, sends other when no type is chosen, the vehicle only with a trip, coordinates to six decimals', () => {
    const now = new Date('2026-10-22T07:15:00.123Z')
    expect(incidentBody(draft, null, now)).toEqual({ description: 'Dent', severity: 'medium', incident_type: 'other', occurred_at: '2026-10-22T07:15:00.123Z' })
    expect(incidentBody({ ...draft, type: 'tyre', location: { latitude: 8.9999996, longitude: 38.7500004, accuracy: 3 } }, { tripId: TRIP, vehicleId: VEHICLE }, now)).toEqual({
      description: 'Dent',
      severity: 'medium',
      incident_type: 'tyre',
      vehicle_id: VEHICLE,
      trip_id: TRIP,
      latitude: 9,
      longitude: 38.75,
      occurred_at: '2026-10-22T07:15:00.123Z',
    })
  })

  it('needs a severity and 1 to 2,000 characters', () => {
    expect(checkIncident(draft)).toEqual({})
    expect(checkIncident(EMPTY_INCIDENT)).toEqual({ severity: 'Choose how serious it is.', description: 'Say what happened.' })
    expect(checkIncident({ ...draft, description: 'x'.repeat(2001) }).description).toBe('Use at most 2,000 characters.')
  })
})

import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { currentUser, envelope, errorEnvelope, renderApp, signedInAs } from '@/test/auth'
import { server } from '@/test/msw/server'
import { POLL_MS } from './api'
import type { BoardDriver, BoardVehicle, DispatchBoard, Trip } from './types'

const DEPOT = '11111111-1111-4111-8111-111111111111'
const dispatcher = currentUser(['dispatcher'], ['trip:assign', 'trip:read', 'trip:write', 'depot:read', 'vehicle:read', 'driver:read'])

function trip(overrides: Partial<Trip> = {}): Trip {
  return {
    id: 'a0000000-0000-4000-8000-000000000001',
    route_id: 'r-1',
    route_name: 'Addis Ababa - Adama',
    depot_id: DEPOT,
    vehicle_id: null,
    driver_id: null,
    status: 'scheduled',
    origin: 'Addis Ababa',
    destination: 'Adama',
    planned_distance_km: 99,
    scheduled_start: '2026-11-02T06:00:00Z',
    scheduled_end: '2026-11-02T09:00:00Z',
    actual_start: null,
    version: 0,
    ...overrides,
  }
}

const free = { availability: 'available' as const, reasons: [] }

function driver(overrides: Partial<BoardDriver> = {}): BoardDriver {
  return { driver_id: 'd-1', full_name: 'Abebe Kebede', license_categories: ['C'], vehicle_types: ['truck', 'van'], state: 'idle', attendance: 'present', availability: free, current_trip: null, ...overrides }
}

function vehicle(overrides: Partial<BoardVehicle> = {}): BoardVehicle {
  return { vehicle_id: 'v-1', registration_number: 'AA 3-10001', make: 'Isuzu', model: 'FSR', vehicle_type: 'truck', status: 'active', state: 'idle', availability: free, open_work: null, current_trip: null, ...overrides }
}

const absent = driver({ driver_id: 'd-2', full_name: 'Sara Haile', state: 'absent', attendance: 'absent', availability: { availability: 'available_with_warning', reasons: [{ code: 'driver_absent', severity: 'warning' }] } })
const flagged = vehicle({
  vehicle_id: 'v-2',
  registration_number: 'AA 3-10002',
  state: 'flagged',
  availability: { availability: 'unavailable', reasons: [{ code: 'maintenance_flag', severity: 'block' }] },
  open_work: { id: '9b000000-0000-4000-8000-000000000001', description: 'Brake pads worn', status: 'open', priority: 'high', opened_at: '2026-11-01T08:00:00Z' },
})

/** A fake API: the depot, its trips, its board; records board queries and assignments. */
function serve(trips: Trip[], board: Partial<DispatchBoard> = {}) {
  const boardQueries: URLSearchParams[] = []
  const assignments: { url: string; body: unknown }[] = []
  server.use(
    http.get('/api/v1/depots', () => envelope([{ id: DEPOT, name: 'Addis Ababa Central', code: 'ADD', location: 'Addis Ababa' }])),
    // The console asks twice: scheduled and assigned from today, and under way whenever they started.
    http.get('/api/v1/trips', ({ request }) => {
      const statuses = new URL(request.url).searchParams.get('status')?.split(',') ?? []
      return envelope(trips.filter((t) => statuses.includes(t.status)))
    }),
    http.get('/api/v1/dispatch/availability', ({ request }) => {
      boardQueries.push(new URL(request.url).searchParams)
      return envelope({ depot_id: DEPOT, window: { start: '', end: '' }, drivers: [driver(), absent], vehicles: [vehicle(), flagged], ...board })
    }),
  )
  return { boardQueries, assignments }
}

async function openConsole() {
  signedInAs(dispatcher)
  renderApp('/dispatch')
  await screen.findByRole('heading', { name: 'Dispatch', level: 1 })
}

const trips = () => screen.findByRole('list', { name: 'Trips' })
const drivers = () => screen.getByRole('list', { name: 'Drivers' })
const vehicles = () => screen.getByRole('list', { name: 'Vehicles' })

async function chooseTrip(user: ReturnType<typeof userEvent.setup>, name = /Addis Ababa - Adama/) {
  await user.click(await within(await screen.findByRole('list', { name: 'Trips' })).findByRole('button', { name }))
}

afterEach(() => vi.useRealTimers())

describe('Dispatcher trip console (S-07)', () => {
  it("lists unassigned trips; choosing one asks who is free for its window and shows the card's colours", async () => {
    const t = trip()
    const api = serve([t, trip({ id: 'a0000000-0000-4000-8000-000000000002', route_name: 'Hawassa run', status: 'assigned', driver_id: 'd-1', vehicle_id: 'v-1' })])
    const user = userEvent.setup()
    await openConsole()

    // Unassigned by default: the assigned trip is under its own tab.
    expect(await within(await trips()).findByText('Addis Ababa - Adama')).toBeInTheDocument()
    expect(within(await trips()).queryByText('Hawassa run')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Choose a trip' })).toBeInTheDocument()

    await chooseTrip(user)
    await waitFor(() => expect(api.boardQueries.some((q) => q.get('exclude_trip_id') === t.id)).toBe(true))
    const q = api.boardQueries.find((x) => x.get('exclude_trip_id') === t.id)!
    expect([q.get('depot_id'), q.get('from'), q.get('to')]).toEqual([DEPOT, t.scheduled_start, t.scheduled_end])

    expect(within(drivers()).getByRole('button', { name: 'Abebe Kebede, Available' })).toBeInTheDocument()
    expect(within(vehicles()).getByRole('button', { name: 'AA 3-10002, Flagged' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /^Assigned/ }))
    expect(await within(await trips()).findByText('Hawassa run')).toBeInTheDocument()
    // Names from the board, not ids.
    expect(within(await trips()).getByText('Abebe Kebede')).toBeInTheDocument()
    expect(within(await trips()).getByText('AA 3-10001')).toBeInTheDocument()
  })

  it("an absent driver shows grey with 'Absent today'; clicking still allows assignment, and the warning shows inline", async () => {
    const t = trip()
    serve([t])
    let sent: unknown = null
    server.use(
      http.post(`/api/v1/trips/${t.id}/assign`, async ({ request }) => {
        sent = await request.json()
        return HttpResponse.json({
          data: { ...t, status: 'assigned', driver_id: 'd-2', vehicle_id: 'v-1', version: 1 },
          meta: { request_id: 'r-1', warnings: [{ warning: 'DRIVER_ATTENDANCE', field: 'driver_id', attendance: 'absent' }] },
        })
      }),
    )
    const user = userEvent.setup()
    await openConsole()
    await chooseTrip(user)

    const row = await within(drivers()).findByRole('button', { name: 'Sara Haile, Absent today' })
    expect(within(row).getByTitle('Absent today')).toBeInTheDocument()
    expect(within(row).getByText('Absent today').closest('[class*="neutral"]')).not.toBeNull()

    await user.click(row)
    await user.click(within(vehicles()).getByRole('button', { name: 'AA 3-10001, Available' }))
    expect(screen.getByText('Sara Haile is marked absent today. You can still assign them.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Assign' }))

    await waitFor(() => expect(sent).toEqual({ driver_id: 'd-2', vehicle_id: 'v-1', version: 0 }))
    expect(await screen.findByText('Sara Haile is marked absent that day.')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Addis Ababa - Adama assigned')
  })

  it('selecting a flagged vehicle shows its open maintenance record in the panel', async () => {
    serve([trip()])
    const user = userEvent.setup()
    await openConsole()
    await chooseTrip(user)
    await user.click(await within(vehicles()).findByRole('button', { name: 'AA 3-10002, Flagged' }))

    const panel = screen.getByRole('region', { name: 'Assignment panel' })
    expect(within(panel).getByText('Open maintenance work')).toBeInTheDocument()
    expect(within(panel).getByText('Brake pads worn')).toBeInTheDocument()
    expect(within(panel).getByText('Open maintenance work').parentElement).toHaveTextContent('high priority · open · opened Sun 1 Nov · work order 9b000000')
  })

  it('409 CONFLICT_DRIVER_OVERLAP shows the conflicting trip inline, not as a toast', async () => {
    const t = trip()
    serve([t])
    const other = trip({ id: 'c0000000-0000-4000-8000-000000000009', route_name: 'Dire Dawa express', origin: 'Dire Dawa', destination: 'Harar', scheduled_start: '2026-11-02T07:00:00Z', scheduled_end: '2026-11-02T10:00:00Z', status: 'assigned' })
    server.use(
      http.post(`/api/v1/trips/${t.id}/assign`, () =>
        errorEnvelope(409, 'CONFLICT_DRIVER_OVERLAP', 'The driver is already on a trip at that time.', [{ field: 'driver_id', reason: 'overlapping_trip', record_id: other.id }]),
      ),
      http.get(`/api/v1/trips/${other.id}`, () => envelope(other)),
    )
    const user = userEvent.setup()
    await openConsole()
    await chooseTrip(user)
    await user.click(await within(drivers()).findByRole('button', { name: 'Abebe Kebede, Available' }))
    await user.click(within(vehicles()).getByRole('button', { name: 'AA 3-10001, Available' }))
    await user.click(screen.getByRole('button', { name: 'Assign' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('The driver is already on another trip at that time.')
    expect(await within(alert).findByText('Dire Dawa express')).toBeInTheDocument()
    expect(alert).toHaveTextContent('Dire Dawa → Harar · Mon 2 Nov · 10:00–13:00')
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('finds a driver or vehicle by name, plate or model', async () => {
    serve([trip()])
    const user = userEvent.setup()
    await openConsole()
    await within(await screen.findByRole('list', { name: 'Drivers' })).findByText('Sara Haile')
    await user.type(screen.getByRole('searchbox', { name: 'Find a driver or vehicle' }), 'sara')
    expect(within(drivers()).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Sara Haile, Absent today'])
    expect(within(vehicles()).queryAllByRole('button')).toEqual([])
    await user.clear(screen.getByRole('searchbox', { name: 'Find a driver or vehicle' }))
    await user.type(screen.getByRole('searchbox', { name: 'Find a driver or vehicle' }), '10002')
    expect(within(vehicles()).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['AA 3-10002, Flagged'])
  })

  it('refreshes the trips and the board every 30 seconds while open', async () => {
    expect(POLL_MS).toBe(30_000)
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let tripCalls = 0
    serve([trip()])
    server.use(
      http.get('/api/v1/trips', ({ request }) => {
        if (new URL(request.url).searchParams.get('status') !== 'scheduled,assigned') return envelope([])
        tripCalls += 1
        return envelope([trip()])
      }),
    )
    await openConsole()
    await waitFor(() => expect(tripCalls).toBe(1))
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS))
    await waitFor(() => expect(tripCalls).toBe(2))
  })

  it('a dispatcher without trip:write sees no New trip and no Change times', async () => {
    serve([trip()])
    signedInAs(currentUser(['dispatcher'], ['trip:assign', 'trip:read', 'depot:read', 'vehicle:read', 'driver:read']))
    renderApp('/dispatch')
    const user = userEvent.setup()
    await chooseTrip(user)
    expect(await screen.findByRole('region', { name: 'Assignment panel' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New trip' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Change times' })).not.toBeInTheDocument()
  })

  it('a driver opening /dispatch sees nothing: the RoleGate renders no data and no access-denied message', async () => {
    signedInAs(currentUser(['driver'], ['trip:execute', 'trip:read', 'vehicle:read']))
    renderApp('/dispatch')
    await screen.findByRole('button', { name: 'Notifications' })
    expect(screen.getByRole('main')).toBeEmptyDOMElement()
    expect(screen.queryByText(/denied|forbidden|not allowed/i)).not.toBeInTheDocument()
  })
})

describe('Flexible dispatch (FMS-139)', () => {
  const route = {
    id: 'b0000000-0000-4000-8000-000000000001',
    name: 'Addis Ababa - Bishoftu',
    depot_id: DEPOT,
    origin_name: 'Addis Ababa',
    origin: null,
    destination_name: 'Bishoftu',
    destination: null,
    stops: [],
    distance_km: 47,
    estimated_duration_seconds: 5400,
    is_active: true,
    version: 0,
    updated_at: '2026-10-01T00:00:00Z',
  }

  /** Records what POST /trips was sent; answers with `created`. */
  function acceptTrips(created: Trip) {
    const sent: unknown[] = []
    server.use(
      http.get('/api/v1/routes', () => envelope([route])),
      http.post('/api/v1/trips', async ({ request }) => {
        sent.push(await request.json())
        return envelope(created)
      }),
    )
    return sent
  }

  it('creates a trip from a saved route; a blank end takes the route’s estimated time', async () => {
    serve([trip()])
    const sent = acceptTrips(trip({ id: 'a0000000-0000-4000-8000-000000000003', route_name: route.name, destination: 'Bishoftu' }))
    const user = userEvent.setup()
    await openConsole()

    await user.click(await screen.findByRole('button', { name: 'New trip' }))
    const drawer = await screen.findByRole('dialog', { name: 'New trip' })
    expect(drawer).toHaveTextContent('Leaves from Addis Ababa Central.')
    await within(drawer).findByRole('option', { name: route.name })
    await user.selectOptions(within(drawer).getByRole('combobox', { name: 'Route' }), route.id)
    expect(drawer).toHaveTextContent('Addis Ababa → Bishoftu · 47 km · 1 h 30 min')
    // Typed in Addis Ababa time (UTC+3), whatever the browser's zone.
    fireEvent.change(within(drawer).getByLabelText('Leaves'), { target: { value: '2026-11-03T10:00' } })
    expect(drawer).toHaveTextContent('Blank: 11:30, after the route’s estimated 1 h 30 min.')
    await user.click(within(drawer).getByRole('button', { name: 'Create trip' }))

    await waitFor(() => expect(sent).toEqual([{ route_id: route.id, scheduled_start: '2026-11-03T07:00:00.000Z' }]))
    expect(screen.getByRole('status')).toHaveTextContent('Trip created')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New trip' })).not.toBeInTheDocument())
  })

  it('a one-off trip needs an end, and is sent as a route of its own from the console’s depot', async () => {
    serve([trip()])
    const sent = acceptTrips(trip({ id: 'a0000000-0000-4000-8000-000000000004', route_name: null, origin: 'Bole warehouse', destination: 'Mojo dry port' }))
    const user = userEvent.setup()
    await openConsole()

    await user.click(await screen.findByRole('button', { name: 'New trip' }))
    const drawer = await screen.findByRole('dialog', { name: 'New trip' })
    await user.click(within(drawer).getByRole('radio', { name: 'One-off trip' }))
    await user.type(within(drawer).getByLabelText('From'), 'Bole warehouse')
    await user.type(within(drawer).getByLabelText('To'), 'Mojo dry port')
    await user.type(within(drawer).getByLabelText('To coordinates (optional)'), '8.5868, 39.1213')
    fireEvent.change(within(drawer).getByLabelText('Leaves'), { target: { value: '2026-11-03T10:00' } })
    await user.click(within(drawer).getByRole('button', { name: 'Create trip' }))
    expect(await within(drawer).findByText('Give an end time: a one-off trip has no estimate.')).toBeInTheDocument()
    expect(sent).toEqual([])

    fireEvent.change(within(drawer).getByLabelText('Back by'), { target: { value: '2026-11-03T14:30' } })
    await user.click(within(drawer).getByRole('button', { name: 'Create trip' }))
    await waitFor(() =>
      expect(sent).toEqual([
        {
          route: { origin_name: 'Bole warehouse', origin: null, destination_name: 'Mojo dry port', destination: { latitude: 8.5868, longitude: 39.1213 } },
          depot_id: DEPOT,
          scheduled_start: '2026-11-03T07:00:00.000Z',
          scheduled_end: '2026-11-03T11:30:00.000Z',
        },
      ]),
    )
    expect(screen.getByRole('status')).toHaveTextContent('Bole warehouse → Mojo dry port is ready to assign.')
  })

  it('moving an assigned trip needs a reason; running into the next trip offers to move it later', async () => {
    const t = trip({ status: 'assigned', driver_id: 'd-1', vehicle_id: 'v-1', version: 3 })
    const next = trip({ id: 'a0000000-0000-4000-8000-000000000002', route_name: 'Hawassa run', origin: 'Addis Ababa', destination: 'Hawassa', status: 'assigned', driver_id: 'd-1', vehicle_id: 'v-1', scheduled_start: '2026-11-02T09:30:00Z', scheduled_end: '2026-11-02T11:00:00Z' })
    serve([t, next])
    const patches: { body: Record<string, unknown>; ifMatch: string | null }[] = []
    server.use(
      http.patch(`/api/v1/trips/${t.id}`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>
        patches.push({ body, ifMatch: request.headers.get('If-Match') })
        if (!body.shift_following) {
          return errorEnvelope(409, 'CONFLICT_DRIVER_OVERLAP', 'The driver is already on a trip at that time.', [{ field: 'driver_id', reason: 'overlapping_trip', record_id: next.id, shiftable: true, shift_minutes: 31 }])
        }
        return HttpResponse.json({
          data: { ...t, scheduled_end: '2026-11-02T10:00:00Z', version: 4 },
          meta: { request_id: 'r-1', shifted: [{ trip_id: next.id, scheduled_start: '2026-11-02T10:01:00Z', scheduled_end: '2026-11-02T11:31:00Z' }] },
        })
      }),
      http.get(`/api/v1/trips/${next.id}`, () => envelope(next)),
    )
    const user = userEvent.setup()
    await openConsole()
    await user.click(screen.getByRole('button', { name: /^Assigned/ }))
    await chooseTrip(user)
    await user.click(await screen.findByRole('button', { name: 'Change times' }))

    const drawer = await screen.findByRole('dialog', { name: 'Change times' })
    expect(within(drawer).getByLabelText('Back by')).toHaveValue('2026-11-02T12:00')
    fireEvent.change(within(drawer).getByLabelText('Back by'), { target: { value: '2026-11-02T13:00' } })
    await user.click(within(drawer).getByRole('button', { name: 'Save times' }))
    expect(await within(drawer).findByText('Say why the times change: it is kept with the change.')).toBeInTheDocument()
    expect(patches).toEqual([])

    await user.type(within(drawer).getByLabelText('Reason'), 'Customer moved the delivery')
    await user.click(within(drawer).getByRole('button', { name: 'Save times' }))
    const offer = await within(drawer).findByText('The driver has another trip then')
    expect(await within(drawer).findByText('Hawassa run')).toBeInTheDocument()
    expect(offer.parentElement).toHaveTextContent('Move it 31 min later to make room?')
    // Not a toast: the answer stays in the panel until the dispatcher chooses.
    expect(screen.getByRole('status')).toBeEmptyDOMElement()

    await user.click(within(drawer).getByRole('button', { name: 'Move it 31 min later and save' }))
    await waitFor(() => expect(patches).toHaveLength(2))
    expect(patches.map((p) => p.ifMatch)).toEqual(['"3"', '"3"'])
    expect(patches[1].body).toEqual({ scheduled_end: '2026-11-02T10:00:00.000Z', reason: 'Customer moved the delivery', shift_following: true })
    expect(await screen.findByRole('status')).toHaveTextContent('Moved later: Hawassa run now Mon 2 Nov 13:01.')
  })

  it('a trip under way is listed under Under way: only its end moves, and a clash it cannot shift is refused inline', async () => {
    const t = trip({ status: 'en_route', driver_id: 'd-1', vehicle_id: 'v-1', actual_start: '2026-11-02T06:05:00Z', version: 2 })
    serve([t])
    const other = trip({ id: 'c0000000-0000-4000-8000-000000000009', route_name: 'Dire Dawa express', status: 'en_route' })
    let sent: unknown = null
    server.use(
      http.patch(`/api/v1/trips/${t.id}`, async ({ request }) => {
        sent = await request.json()
        return errorEnvelope(409, 'CONFLICT_VEHICLE_OVERLAP', 'The vehicle is already on a trip at that time.', [{ field: 'vehicle_id', reason: 'overlapping_trip', record_id: other.id, shiftable: false }])
      }),
      http.get(`/api/v1/trips/${other.id}`, () => envelope(other)),
    )
    const user = userEvent.setup()
    await openConsole()
    await user.click(screen.getByRole('button', { name: /^Under way/ }))
    await chooseTrip(user)

    const panel = await screen.findByRole('region', { name: 'Trip under way' })
    expect(within(panel).getByText('Started Mon 2 Nov at 09:05')).toBeInTheDocument()
    expect(await within(panel).findByText('Abebe Kebede')).toBeInTheDocument()
    await user.click(within(panel).getByRole('button', { name: 'Change end' }))

    const drawer = await screen.findByRole('dialog', { name: 'Change end time' })
    expect(within(drawer).queryByLabelText('Leaves')).not.toBeInTheDocument()
    fireEvent.change(within(drawer).getByLabelText('Expected end'), { target: { value: '2026-11-02T09:03' } })
    await user.type(within(drawer).getByLabelText('Reason'), 'Road closed at Mojo')
    await user.click(within(drawer).getByRole('button', { name: 'Save times' }))
    expect(await within(drawer).findByText('It started at 09:05: the end must be after that.')).toBeInTheDocument()

    fireEvent.change(within(drawer).getByLabelText('Expected end'), { target: { value: '2026-11-02T14:00' } })
    await user.click(within(drawer).getByRole('button', { name: 'Save times' }))
    expect(await within(drawer).findByText('The vehicle has another trip then')).toBeInTheDocument()
    expect(within(drawer).getByText(/cannot be moved for you/)).toBeInTheDocument()
    expect(within(drawer).queryByRole('button', { name: /min later and save/ })).not.toBeInTheDocument()
    expect(sent).toEqual({ scheduled_end: '2026-11-02T11:00:00.000Z', reason: 'Road closed at Mojo' })
  })
})

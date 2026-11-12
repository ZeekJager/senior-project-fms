import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RealtimeHandler, RealtimeValue } from '@/lib/realtime/context'
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
  return { driver_id: 'd-1', full_name: 'Abebe Kebede', license_categories: ['dry_cargo_2'], vehicle_types: ['truck', 'van'], state: 'idle', attendance: 'present', availability: free, current_trip: null, ...overrides }
}

function vehicle(overrides: Partial<BoardVehicle> = {}): BoardVehicle {
  return { vehicle_id: 'v-1', registration_number: 'AA 3-10001', make: 'Isuzu', model: 'FSR', vehicle_type: 'truck', status: 'active', state: 'idle', availability: free, open_work: null, service_due: null, current_trip: null, ...overrides }
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

/** A socket stand-in: what the console subscribes to, and a way to play server events. */
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

  it('a vehicle overdue for service says so on its card and in the panel, and can still be assigned (FMS-129)', async () => {
    const overdue = vehicle({ service_due: { status: 'overdue', programs: [{ program_id: 'sp-1', name: 'A-service', status: 'overdue', due_by: ['km'] }] } })
    serve([trip()], { vehicles: [overdue, flagged] })
    const user = userEvent.setup()
    await openConsole()
    await chooseTrip(user)

    const card = await within(vehicles()).findByRole('button', { name: 'AA 3-10001, Available' })
    expect(within(card).getByText('Service overdue: A-service')).toHaveClass('text-danger')
    await user.click(card)
    const panel = screen.getByRole('region', { name: 'Assignment panel' })
    expect(within(panel).getByText('Service overdue')).toBeInTheDocument()
    expect(within(panel).getByText('A-service (overdue)')).toBeInTheDocument()
    expect(within(panel).getByText(/AA 3-10001 is past its scheduled service\. You can still assign it/)).toBeInTheDocument()
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

describe('Arrival times (FMS-86)', () => {
  const now = () => new Date().toISOString()
  // Addis Ababa: 10:05 reached Mojo, 10:40 at Bishoftu, 11:15 at Adama.
  const underWay = () =>
    trip({
      status: 'en_route',
      driver_id: 'd-1',
      vehicle_id: 'v-1',
      actual_start: '2026-11-02T06:05:00Z',
      stops: [
        { id: 's-1', sequence_number: 1, name: 'Mojo', latitude: 8.6, longitude: 39.12, status: 'arrived', actual_arrival: '2026-11-02T07:05:00Z', eta: null },
        { id: 's-2', sequence_number: 2, name: 'Bishoftu', latitude: 8.75, longitude: 38.98, status: 'planned', actual_arrival: null, eta: '2026-11-02T07:40:00Z' },
        { id: 's-3', sequence_number: 3, name: 'Unmapped yard', latitude: null, longitude: null, status: 'planned', actual_arrival: null, eta: null },
      ],
      eta: {
        arrival_at: '2026-11-02T08:15:00Z',
        remaining_km: 61.2,
        remaining_seconds: 4500,
        next_stop: { stop_id: 's-2', name: 'Bishoftu', eta: '2026-11-02T07:40:00Z' },
        position_at: now(),
        updated_at: now(),
      },
    })

  it('a trip under way says when it arrives on its card, and each stop in the panel', async () => {
    serve([underWay()])
    const user = userEvent.setup()
    await openConsole()
    await user.click(screen.getByRole('button', { name: /^Under way/ }))
    expect(await within(await trips()).findByText('Arrives 11:15 · 61.2 km to go')).toBeInTheDocument()
    await chooseTrip(user)

    const panel = await screen.findByRole('region', { name: 'Trip under way' })
    const arrival = within(panel).getByRole('region', { name: 'Arrival' })
    expect(arrival).toHaveTextContent(/11:15\s*at Adama · (in .+|due now) · 61\.2 km left/)
    const stops = within(within(arrival).getByRole('list', { name: 'Stops' })).getAllByRole('listitem')
    expect(stops.map((li) => li.textContent)).toEqual(['MojoReached 10:05', 'Bishoftu10:40', 'Unmapped yardNo coordinates', 'Adama11:15'])
    expect(within(arrival).queryByText(/may have lost signal/)).not.toBeInTheDocument()
  })

  it('a late trip’s notification opens it under way, in its own depot (FMS-147)', async () => {
    const late = { ...underWay(), depot_id: DEPOT }
    serve([late])
    server.use(http.get('/api/v1/trips/:id', ({ params }) => (params.id === late.id ? envelope(late) : errorEnvelope(404, 'NOT_FOUND', 'Trip not found.'))))
    signedInAs(dispatcher)
    renderApp(`/dispatch?view=under-way&trip=${late.id}`)
    expect(await screen.findByRole('region', { name: 'Trip under way' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(`/dispatch?view=under-way&depot=${DEPOT}`))
  })

  it('a new estimate on the socket moves the time at once, without re-reading the trips; an old position says so', async () => {
    let reads = 0
    serve([underWay()])
    server.use(
      http.get('/api/v1/trips', ({ request }) => {
        reads += 1
        const statuses = new URL(request.url).searchParams.get('status')?.split(',') ?? []
        return envelope([underWay()].filter((t) => statuses.includes(t.status)))
      }),
    )
    const socket = fakeSocket()
    const user = userEvent.setup()
    signedInAs(dispatcher)
    renderApp('/dispatch?view=under-way', { realtime: socket })
    await within(await trips()).findByText('Arrives 11:15 · 61.2 km to go')
    await chooseTrip(user)
    const before = reads

    const old = new Date(Date.now() - 5 * 60_000).toISOString()
    socket.emit('trip.updated', {
      trip_id: underWay().id,
      depot_id: DEPOT,
      status: 'en_route',
      change: 'TripEtaUpdated',
      eta: { arrival_at: '2026-11-02T08:30:00Z', remaining_km: 58.4, remaining_seconds: 5400, next_stop: null, position_at: old, updated_at: old },
    })
    expect(await within(await trips()).findByText('Arrives 11:30 · 58.4 km to go')).toBeInTheDocument()
    const arrival = within(screen.getByRole('region', { name: 'Trip under way' })).getByRole('region', { name: 'Arrival' })
    expect(arrival).toHaveTextContent('11:30')
    expect(within(arrival).getByText(/may have lost signal/)).toBeInTheDocument()
    expect(reads).toBe(before)
  })

  describe('approved exceptions to the assignment rules (FMS-151)', () => {
    const request = (overrides: Partial<NonNullable<Trip['exception']>> = {}): NonNullable<Trip['exception']> => ({
      id: 'e0000000-0000-4000-8000-000000000001',
      trip_id: 'a0000000-0000-4000-8000-000000000001',
      status: 'pending',
      driver_id: 'd-2',
      vehicle_id: 'v-1',
      warnings: [{ warning: 'DRIVER_ATTENDANCE', field: 'driver_id', attendance: 'absent' }],
      reason: 'Only licensed driver free today.',
      requested_by: 'u-9',
      requested_by_name: 'Hana Dispatcher',
      requested_at: '2026-11-01T07:00:00Z',
      decided_by: null,
      decided_by_name: null,
      decided_at: null,
      decision_reason: null,
      ...overrides,
    })

    it('an assignment the depot holds asks for a reason, and is sent to a fleet manager with it', async () => {
      const t = trip()
      serve([t])
      const sent: unknown[] = []
      server.use(
        http.post(`/api/v1/trips/${t.id}/assign`, async ({ request: req }) => {
          const body = (await req.json()) as Record<string, unknown>
          sent.push(body)
          if (!body.exception_reason) {
            return errorEnvelope(409, 'CONFLICT_APPROVAL_REQUIRED', 'This assignment needs a fleet manager’s approval.', [{ field: 'driver_id', reason: 'driver_absent' }])
          }
          return HttpResponse.json({ data: request({ reason: String(body.exception_reason) }), meta: { request_id: 'r-1' } }, { status: 202 })
        }),
      )
      const user = userEvent.setup()
      await openConsole()
      await chooseTrip(user)
      await user.click(await within(drivers()).findByRole('button', { name: 'Sara Haile, Absent today' }))
      await user.click(within(vehicles()).getByRole('button', { name: 'AA 3-10001, Available' }))
      await user.click(screen.getByRole('button', { name: 'Assign' }))

      const panel = screen.getByRole('region', { name: 'Assignment panel' })
      expect(await within(panel).findByText('Needs a fleet manager’s approval')).toBeInTheDocument()
      expect(within(panel).getByText('Sara Haile is marked absent that day.')).toBeInTheDocument()
      // Not a refusal, and Assign waits: the way on is the request.
      expect(screen.getByRole('button', { name: 'Assign' })).toBeDisabled()
      await user.click(within(panel).getByRole('button', { name: 'Ask for approval' }))
      expect(within(panel).getByText('Say why, for the fleet manager.')).toBeInTheDocument()
      expect(sent).toHaveLength(1)

      await user.type(within(panel).getByLabelText('Why this assignment'), 'Absence logged by mistake.')
      await user.click(within(panel).getByRole('button', { name: 'Ask for approval' }))
      await waitFor(() => expect(sent.at(-1)).toEqual({ driver_id: 'd-2', vehicle_id: 'v-1', version: 0, exception_reason: 'Absence logged by mistake.' }))
      expect(await screen.findByRole('status')).toHaveTextContent('Sent for approval')
    })

    it('a trip awaiting approval says so; a fleet manager approves it, or refuses it only with a reason', async () => {
      const t = trip({ exception: request() })
      serve([t])
      const decisions: { url: string; body: unknown }[] = []
      server.use(
        http.post('/api/v1/assignment-exceptions/:id/:decision', async ({ request: req }) => {
          decisions.push({ url: new URL(req.url).pathname, body: await req.json() })
          return HttpResponse.json({ data: request({ status: 'approved' }), meta: { request_id: 'r-1', trip: { ...t, status: 'assigned', exception: null }, warnings: [] } })
        }),
      )
      signedInAs(currentUser(['fleet_manager'], ['trip:assign', 'trip:read', 'trip:write', 'depot:read', 'assignment-exception:approve']))
      renderApp('/dispatch')
      const user = userEvent.setup()
      expect(await within(await trips()).findByText('Awaiting approval')).toBeInTheDocument()
      await chooseTrip(user)

      const panel = screen.getByRole('region', { name: 'Assignment panel' })
      expect(within(panel).getByText('Awaiting a fleet manager’s approval')).toBeInTheDocument()
      expect(await within(panel).findByText(/Sara Haile with AA 3-10001, asked by Hana Dispatcher/)).toBeInTheDocument()
      expect(within(panel).getByText('Only licensed driver free today.')).toBeInTheDocument()

      await user.click(within(panel).getByRole('button', { name: 'Refuse' }))
      expect(within(panel).getByText('Say why you refuse it: the dispatcher is told.')).toBeInTheDocument()
      expect(decisions).toEqual([])

      await user.click(within(panel).getByRole('button', { name: 'Approve and assign' }))
      await waitFor(() => expect(decisions).toEqual([{ url: '/api/v1/assignment-exceptions/e0000000-0000-4000-8000-000000000001/approve', body: {} }]))
    })

    it('the one who asked waits for someone else; a refusal shows why', async () => {
      signedInAs(currentUser(['fleet_manager'], ['trip:assign', 'trip:read', 'depot:read', 'assignment-exception:approve']))
      serve([trip({ exception: request({ requested_by: 'u-1' }) }), trip({ id: 'a0000000-0000-4000-8000-000000000002', route_name: 'Hawassa run', exception: request({ status: 'refused', decided_by_name: 'Meron Manager', decided_at: '2026-11-01T08:00:00Z', decision_reason: 'Call the reserve driver.' }) })])
      renderApp('/dispatch')
      const user = userEvent.setup()
      await chooseTrip(user)
      const panel = screen.getByRole('region', { name: 'Assignment panel' })
      expect(within(panel).getByText('Another fleet manager decides on a request you made.')).toBeInTheDocument()
      expect(within(panel).queryByRole('button', { name: 'Approve and assign' })).not.toBeInTheDocument()

      expect(within(await trips()).getByText('Approval refused')).toBeInTheDocument()
      await chooseTrip(user, /Hawassa run/)
      expect(within(screen.getByRole('region', { name: 'Assignment panel' })).getByText(/Meron Manager refused it .*: Call the reserve driver\./)).toBeInTheDocument()
    })
  })
})

describe('The load of a job on each trip (FMS-153)', () => {
  const heavy = trip({
    id: 'a0000000-0000-4000-8000-000000000009',
    route_name: 'Addis Ababa - Dire Dawa',
    cargo_weight_kg: 7600,
    cargo_kind: 'refrigerated',
    job_load: 'heavy',
    job_load_reasons: ['long_haul', 'near_payload', 'night'],
  })

  it('each trip shows its job load; the panel says why, and what it carries', async () => {
    serve([trip({ job_load: 'light', job_load_reasons: [], cargo_kind: 'general', cargo_weight_kg: null }), heavy])
    const user = userEvent.setup()
    await openConsole()

    const list = await trips()
    expect(within(list).getByRole('button', { name: /Addis Ababa - Adama/ })).toHaveTextContent('Light job')
    expect(within(list).getByRole('button', { name: /Addis Ababa - Dire Dawa/ })).toHaveTextContent('Heavy job')

    await chooseTrip(user, /Addis Ababa - Dire Dawa/)
    const load = within(screen.getByRole('region', { name: 'Assignment panel' })).getByRole('group', { name: 'Job load' })
    expect(load).toHaveTextContent('Heavy job')
    expect(load).toHaveTextContent('Long haul, 300 km or more · Near the vehicle’s payload · Night driving')
    expect(load).toHaveTextContent('Cargo: 7,600 kg · Refrigerated')

    await chooseTrip(user)
    expect(within(screen.getByRole('region', { name: 'Assignment panel' })).getByRole('group', { name: 'Job load' })).toHaveTextContent('No cargo recorded')
  })

  it('a new trip records its cargo; a weight that is not kg is caught before sending', async () => {
    serve([trip()])
    const sent: unknown[] = []
    server.use(
      http.get('/api/v1/routes', () =>
        envelope([{ id: 'b0000000-0000-4000-8000-000000000001', name: 'Addis Ababa - Bishoftu', depot_id: DEPOT, origin_name: 'Addis Ababa', origin: null, destination_name: 'Bishoftu', destination: null, stops: [], distance_km: 47, estimated_duration_seconds: 5400, is_active: true, version: 0, updated_at: '2026-10-01T00:00:00Z' }]),
      ),
      http.post('/api/v1/trips', async ({ request }) => {
        sent.push(await request.json())
        return envelope(trip({ id: 'a0000000-0000-4000-8000-000000000005' }))
      }),
    )
    const user = userEvent.setup()
    await openConsole()
    await user.click(await screen.findByRole('button', { name: 'New trip' }))
    const drawer = await screen.findByRole('dialog', { name: 'New trip' })
    await within(drawer).findByRole('option', { name: 'Addis Ababa - Bishoftu' })
    await user.selectOptions(within(drawer).getByRole('combobox', { name: 'Route' }), 'b0000000-0000-4000-8000-000000000001')
    fireEvent.change(within(drawer).getByLabelText('Leaves'), { target: { value: '2026-11-03T10:00' } })
    await user.selectOptions(within(drawer).getByRole('combobox', { name: 'Cargo' }), 'fragile')
    await user.type(within(drawer).getByLabelText('Weight (optional)'), 'two tonnes')
    await user.click(within(drawer).getByRole('button', { name: 'Create trip' }))
    expect(await within(drawer).findByText('A weight in kg, e.g. 1200 or 1200.5.')).toBeInTheDocument()
    expect(sent).toEqual([])

    await user.clear(within(drawer).getByLabelText('Weight (optional)'))
    await user.type(within(drawer).getByLabelText('Weight (optional)'), '1,850.5')
    await user.click(within(drawer).getByRole('button', { name: 'Create trip' }))
    await waitFor(() =>
      expect(sent).toEqual([{ route_id: 'b0000000-0000-4000-8000-000000000001', scheduled_start: '2026-11-03T07:00:00.000Z', cargo_kind: 'fragile', cargo_weight_kg: 1850.5 }]),
    )
  })

  it('Change cargo sends only what changed with the version on screen; more than the vehicle carries is shown on the weight', async () => {
    const assigned = trip({ ...heavy, status: 'assigned', driver_id: 'd-1', vehicle_id: 'v-1', version: 4 })
    serve([assigned])
    const patches: { body: unknown; ifMatch: string | null }[] = []
    server.use(
      http.patch(`/api/v1/trips/${assigned.id}`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>
        patches.push({ body, ifMatch: request.headers.get('If-Match') })
        if (body.cargo_weight_kg === 9000) {
          return errorEnvelope(400, 'VALIDATION_FAILED', 'The cargo is more than the trip’s vehicle carries (8000 kg).', [{ field: 'cargo_weight_kg', reason: 'over_payload' }])
        }
        return envelope({ ...assigned, ...body, version: 5 })
      }),
    )
    const user = userEvent.setup()
    await openConsole()
    await user.click(await screen.findByRole('button', { name: /^Assigned/ }))
    await chooseTrip(user, /Addis Ababa - Dire Dawa/)
    await user.click(screen.getByRole('button', { name: 'Change cargo' }))
    const drawer = await screen.findByRole('dialog', { name: 'Change cargo' })
    expect(within(drawer).getByLabelText('Weight (optional)')).toHaveValue('7600')

    await user.clear(within(drawer).getByLabelText('Weight (optional)'))
    await user.type(within(drawer).getByLabelText('Weight (optional)'), '9000')
    await user.click(within(drawer).getByRole('button', { name: 'Save cargo' }))
    expect(await within(drawer).findByText('The cargo is more than the trip’s vehicle carries (8000 kg).')).toBeInTheDocument()

    await user.clear(within(drawer).getByLabelText('Weight (optional)'))
    await user.type(within(drawer).getByLabelText('Weight (optional)'), '7000')
    await user.selectOptions(within(drawer).getByRole('combobox', { name: 'Cargo' }), 'general')
    await user.click(within(drawer).getByRole('button', { name: 'Save cargo' }))
    await waitFor(() => expect(patches.at(-1)).toEqual({ body: { cargo_kind: 'general', cargo_weight_kg: 7000 }, ifMatch: '"4"' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Cargo changed')
  })

  it('a dispatcher without trip:write sees the load but cannot change the cargo', async () => {
    serve([heavy])
    signedInAs(currentUser(['dispatcher'], ['trip:assign', 'trip:read', 'depot:read']))
    renderApp('/dispatch')
    const user = userEvent.setup()
    await chooseTrip(user, /Addis Ababa - Dire Dawa/)
    expect(within(screen.getByRole('region', { name: 'Assignment panel' })).getByRole('group', { name: 'Job load' })).toHaveTextContent('Heavy job')
    expect(screen.queryByRole('button', { name: 'Change cargo' })).not.toBeInTheDocument()
  })
})

describe('Predicted trip risk (FMS-155)', () => {
  const minimum = { trips: 2000, drivers: 20 }

  it('each free driver shows their chances on the chosen trip with what raises them; a demonstration says so', async () => {
    serve([trip()], {
      trip_risk: { status: 'ok', reason: null, model_version: 'tr-2026.11', demonstration: true, trips: 0, drivers: 0, minimum },
      drivers: [
        driver({
          trip_risk: {
            late_probability: 0.184,
            safety_event_probability: 0.004,
            factors: { late: [{ feature: 'hours_driven_24h', value: 10.5 }, { feature: 'night_hours', value: 6 }], safety_event: [] },
          },
        }),
        absent,
      ],
    })
    const user = userEvent.setup()
    await openConsole()
    await chooseTrip(user)

    const abebe = await within(drivers()).findByRole('button', { name: 'Abebe Kebede, Available' })
    expect(within(abebe).getByTestId('trip-risk')).toHaveTextContent('18% chance of running late: 10.5 h driven in the last day, 6 h at night')
    expect(within(abebe).getByTestId('trip-risk')).toHaveTextContent('under 1% chance of a safety event')
    expect(within(within(drivers()).getByRole('button', { name: /Sara Haile/ })).queryByTestId('trip-risk')).not.toBeInTheDocument()
    expect(screen.getByText(/Trip risk is a demonstration: the model learnt from generated trips/)).toBeInTheDocument()
  })

  it('too few trips to learn from says how far there is to go; the order of the drivers is unchanged', async () => {
    serve([trip()], { trip_risk: { status: 'not_enough_trips', reason: 'no_model', model_version: null, demonstration: false, trips: 412, drivers: 9, minimum } })
    const user = userEvent.setup()
    await openConsole()
    await chooseTrip(user)
    expect(await screen.findByText('Not enough trips yet for a trip risk prediction: 412 of 2,000 completed trips, 9 of 20 drivers.')).toBeInTheDocument()
    expect(within(drivers()).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Abebe Kebede, Available', 'Sara Haile, Absent today'])
    expect(within(drivers()).queryByTestId('trip-risk')).not.toBeInTheDocument()
  })
})

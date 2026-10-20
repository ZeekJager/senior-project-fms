import { act, screen, waitFor, within } from '@testing-library/react'
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
    http.get('/api/v1/trips', () => envelope(trips)),
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
      http.get('/api/v1/trips', () => {
        tripCalls += 1
        return envelope([trip()])
      }),
    )
    await openConsole()
    await waitFor(() => expect(tripCalls).toBe(1))
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS))
    await waitFor(() => expect(tripCalls).toBe(2))
  })

  it('a driver opening /dispatch sees nothing: the RoleGate renders no data and no access-denied message', async () => {
    signedInAs(currentUser(['driver'], ['trip:execute', 'trip:read', 'vehicle:read']))
    renderApp('/dispatch')
    await screen.findByRole('button', { name: 'Notifications' })
    expect(screen.getByRole('main')).toBeEmptyDOMElement()
    expect(screen.queryByText(/denied|forbidden|not allowed/i)).not.toBeInTheDocument()
  })
})

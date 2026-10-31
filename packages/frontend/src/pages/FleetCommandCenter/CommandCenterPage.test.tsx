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
import type { Overview, OverviewAlert, OverviewIncident } from './overview'
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

/** An overview with the vehicles counted and, unless given, no alerts or incidents section (the caller may not read them). */
function overviewOf(extra: Partial<Overview> = {}): Overview {
  return {
    depot_id: null,
    generated_at: new Date().toISOString(),
    vehicles: {
      total: 12,
      on_trip: 2,
      available: 7,
      in_maintenance: 1,
      inactive: 0,
      flagged: 2,
      health: { at_risk: 1, watch: 1, healthy: 8, stale: 0, unscored: 2 },
      health_watch: [{ vehicle_id: 'v-1', registration_number: 'AA 3-10001', health_score: 62, band: 'at_risk' }],
    },
    drivers: { total: 10, on_trip: 2, available: 6, absent: 1, licence_expired: 1 },
    trips: { today: { draft: 0, scheduled: 3, assigned: 1, en_route: 2, completed: 4, cancelled: 0 }, under_way: 2, overdue: 1 },
    alerts: null,
    incidents: null,
    ...extra,
  }
}

function serve(vehicles: VehicleLocation[], overview: Overview = overviewOf()) {
  const requests: URL[] = []
  server.use(
    http.get('/api/v1/command-center/overview', () => envelope(overview)),
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

describe('Command center overview: alerts, incidents and counters (FMS-89)', () => {
  const handler = currentUser(
    ['dispatcher'],
    ['command:read', 'tracking:read', 'depot:read', 'trip:read', 'vehicle:read', 'driver:read', 'alert:read', 'alert:ack', 'alert:resolve', 'incident:read', 'incident:manage'],
  )
  const brakes: OverviewAlert = {
    id: 'a-1',
    type: 'vehicle_fault',
    severity: 'critical',
    priority: 1,
    status: 'open',
    title: 'Brakes failed inspection',
    message: 'Pre-trip inspection: brakes',
    vehicle_id: 'v-1',
    registration_number: 'AA 3-10001',
    driver_id: null,
    entity_type: 'dvir_report',
    entity_id: 'd-1',
    occurrence_count: 1,
    escalation_level: 0,
    created_at: ago(120),
    last_occurred_at: ago(120),
    acknowledged_at: null,
  }
  const flat: OverviewIncident = {
    id: 'i-1',
    incident_type: 'tyre',
    severity: 'high',
    status: 'open',
    description: 'Flat tyre on the ring road near Megenagna',
    vehicle_id: 'v-1',
    registration_number: 'AA 3-10001',
    driver_id: 'dr-1',
    driver_name: 'Abebe Kebede',
    assigned_to: null,
    notes: null,
    latitude: 9.02,
    longitude: 38.8,
    occurred_at: ago(600),
    updated_at: ago(600),
  }
  const sections = (alerts: OverviewAlert[], incidents: OverviewIncident[]): Partial<Overview> => ({
    alerts: { active: alerts.length, unacknowledged: alerts.filter((a) => a.status === 'open').length, by_severity: { critical: alerts.filter((a) => a.severity === 'critical').length, high: 0, medium: 0, low: 0 }, items: alerts },
    incidents: { active: incidents.length, by_status: { open: incidents.length, investigating: 0 }, by_severity: { critical: 0, high: incidents.length, medium: 0, low: 0 }, items: incidents },
  })
  const panelTab = (name: RegExp) => within(screen.getByRole('group', { name: 'Panel' })).getByRole('button', { name })

  it('counts the fleet, drivers and trips above the map, and badges a vehicle whose health is at risk', async () => {
    serve([onTrip, speeding], overviewOf())
    signedInAs(dispatcher)
    open()
    const vehicles = await screen.findByRole('region', { name: 'Vehicles' })
    expect(within(vehicles).getByText('Available').previousSibling).toHaveTextContent('7')
    const trips = screen.getByRole('region', { name: 'Trips today' })
    expect(within(trips).getByText('Overdue').previousSibling).toHaveTextContent('1')
    expect(within(trips).getByText('Still to start').previousSibling).toHaveTextContent('4')
    expect(screen.getByRole('region', { name: 'Drivers' })).toHaveTextContent('Licence expired')
    // No alerts or incidents to read: no panel tabs.
    expect(screen.queryByRole('group', { name: 'Panel' })).not.toBeInTheDocument()
    await waitFor(() => expect(card('AA 3-10001')).toHaveTextContent('Health at risk: 62'))
  })

  it('acknowledges an alert from the map: the alert says so at once, and the counters follow', async () => {
    serve([onTrip], overviewOf(sections([brakes], [])))
    const acks: string[] = []
    server.use(
      http.post('/api/v1/alerts/:id/acknowledge', ({ params }) => {
        acks.push(params.id as string)
        return envelope({ id: params.id, status: 'acknowledged', acknowledged_at: new Date().toISOString() })
      }),
    )
    signedInAs(handler)
    open()
    await userEvent.click(await screen.findByRole('button', { name: /^Alerts/ }))
    const list = await screen.findByRole('list', { name: 'Active alerts' })
    expect(within(list).getByText('Brakes failed inspection')).toBeInTheDocument()
    expect(within(list).getByText('AA 3-10001')).toBeInTheDocument()

    await userEvent.click(within(list).getByRole('button', { name: 'Acknowledge: Brakes failed inspection' }))
    await waitFor(() => expect(acks).toEqual(['a-1']))
    expect(await within(list).findByText('Acknowledged')).toBeInTheDocument()
    expect(within(list).queryByRole('button', { name: /^Acknowledge:/ })).not.toBeInTheDocument()
    // Still active (acknowledged is not resolved), so still counted.
    expect(panelTab(/^Alerts/)).toHaveTextContent('1')
  })

  it('a new critical alert appears at once from the socket, said out loud; another console acknowledging it shows here', async () => {
    serve([onTrip], overviewOf(sections([], [])))
    signedInAs(handler)
    const socket = open('/command-center?panel=alerts')
    expect(await screen.findByText('No active alerts')).toBeInTheDocument()

    socket.emit('alert.created', {
      alert_id: 'a-9',
      depot_id: DEPOT,
      alert_type: 'incident',
      severity: 'critical',
      priority: 1,
      status: 'open',
      entity_type: 'incident',
      entity_id: 'i-9',
      vehicle_id: 'v-1',
      title: 'Critical incident: accident',
      message: 'Reported by the driver',
      created_at: new Date().toISOString(),
    })
    const list = await screen.findByRole('list', { name: 'Active alerts' })
    expect(within(list).getByText('Critical incident: accident')).toBeInTheDocument()
    expect(within(list).getByText('AA 3-10001')).toBeInTheDocument()
    expect(screen.getByText('Critical alert: Critical incident: accident')).toBeInTheDocument()

    socket.emit('alert.updated', { alert_id: 'a-9', depot_id: DEPOT, status: 'acknowledged', acknowledged_at: new Date().toISOString() })
    expect(await within(list).findByText('Acknowledged')).toBeInTheDocument()
    socket.emit('alert.updated', { alert_id: 'a-9', depot_id: DEPOT, status: 'resolved' })
    expect(await screen.findByText('No active alerts')).toBeInTheDocument()
  })

  it('an incident is taken on, then resolved only with notes saying what was done', async () => {
    serve([onTrip], overviewOf(sections([], [flat])))
    const patches: Record<string, unknown>[] = []
    server.use(
      http.patch('/api/v1/incidents/:id', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>
        patches.push(body)
        const assigned = 'assigned_to' in body ? (body.assigned_to ? { id: 'u-1', full_name: 'Sam Tester' } : null) : null
        return envelope({ ...flat, ...body, assigned_to: assigned, status: body.status ?? 'open', notes: body.notes ?? null, depot_id: DEPOT, trip_id: null, reported_by: 'u-9', resolved_at: null, resolved_by: null, created_at: flat.occurred_at })
      }),
    )
    signedInAs(handler)
    open('/command-center?panel=incidents')
    const list = await screen.findByRole('list', { name: 'Active incidents' })
    expect(within(list).getByText('Nobody has taken it on')).toBeInTheDocument()
    await userEvent.click(within(list).getByRole('button', { name: /Tyre/ }))

    const drawer = await screen.findByRole('dialog', { name: 'Tyre: AA 3-10001' })
    expect(within(drawer).getByText('Flat tyre on the ring road near Megenagna')).toBeInTheDocument()
    expect(within(drawer).getByText('Abebe Kebede')).toBeInTheDocument()
    await userEvent.click(within(drawer).getByRole('button', { name: 'Take it on' }))
    await waitFor(() => expect(patches).toEqual([{ assigned_to: 'u-1' }]))
    expect(await within(drawer).findByText('Sam Tester (you)')).toBeInTheDocument()

    await userEvent.selectOptions(within(drawer).getByLabelText('Status'), 'resolved')
    await userEvent.click(within(drawer).getByRole('button', { name: 'Save' }))
    expect(await within(drawer).findByText('Say what was found and done before resolving it.')).toBeInTheDocument()
    expect(patches).toHaveLength(1)

    await userEvent.type(within(drawer).getByLabelText(/What was found and done/), 'Spare fitted, tyre to the workshop.')
    await userEvent.click(within(drawer).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(patches[1]).toEqual({ status: 'resolved', notes: 'Spare fitted, tyre to the workshop.' }))
    // Resolved: off the active list, the drawer closed.
    expect(await screen.findByText('No active incidents')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

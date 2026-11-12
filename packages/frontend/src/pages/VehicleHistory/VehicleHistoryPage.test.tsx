import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { tripMapBounds, type TripMapProps } from '@/components/TripMap'
import { currentUser, envelope, renderApp, signedInAs } from '@/test/auth'
import { server } from '@/test/msw/server'
import type { Vehicle } from '@/pages/Vehicles/types'

// Leaflet draws lines with SVG or canvas, neither of which jsdom has: the page's tests check what it hands the map.
vi.mock('@/components/TripMap', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/TripMap')>()),
  TripMap: ({ planned, road, track, label }: TripMapProps) => (
    <div
      role="region"
      aria-label={label}
      data-origin={planned.origin?.join(',') ?? ''}
      data-destination={planned.destination?.join(',') ?? ''}
      data-road={road?.map((p) => p.join(',')).join(' ') ?? ''}
      data-points={track.length}
    />
  ),
}))

const DEPOT = '11111111-1111-4111-8111-111111111111'
const VEHICLE_ID = '00000000-0000-4000-8000-000000000001'
const DRIVER = '22222222-2222-4222-8222-222222222222'
const ROUTE = '33333333-3333-4333-8333-333333333333'

const manager = currentUser(['fleet_manager'], [
  'vehicle:read', 'depot:read', 'maintenance:read', 'trip:read', 'route:read', 'tracking:read', 'driver:read', 'fuel:read', 'document:read', 'prediction:read',
])
const technician = currentUser(['technician'], ['vehicle:read', 'depot:read', 'maintenance:read', 'maintenance:write', 'maintenance:execute'])
const dispatcher = currentUser(['dispatcher'], ['vehicle:read', 'depot:read', 'trip:read', 'route:read', 'tracking:read', 'driver:read'])

const vehicle: Vehicle = {
  id: VEHICLE_ID,
  registration_number: 'AA 3-20001',
  vin: 'JALFSR90000012345',
  make: 'Isuzu',
  model: 'FSR',
  year: 2018,
  vehicle_type: 'truck',
  fuel_type: 'diesel',
  fuel_efficiency_ml_per_km: 325,
  status: 'active',
  maintenance_flag: false,
  health_score: 82,
  health_score_updated_at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  depot_id: DEPOT,
  odometer_km: 87_000,
  current_trip: null,
  version: 0,
  created_at: '2021-03-04T09:00:00Z',
  updated_at: '2026-10-25T23:00:00Z',
}

const page = (data: unknown[], extra: Record<string, unknown> = {}) =>
  HttpResponse.json({ data, meta: { page: 1, page_size: 25, total_items: data.length, total_pages: 1, request_id: 'r-1', ...extra } })

function record(id: string, date: string, overrides: Record<string, unknown> = {}) {
  return {
    id, vehicle_id: VEHICLE_ID, registration_number: vehicle.registration_number, maintenance_type: 'preventive', description: 'Oil and filters',
    status: 'completed', priority: 'normal', scheduled_at: null, started_at: null, completed_at: date, odometer_km: 84_210, labour_hours: 2,
    total_cost_cents: 845_000, parts_cost_cents: 545_000, workshop: null, notes: null, completed_by: null, service_program: null, warranty_claim: null,
    parts: [{ part_id: 'p-1', part_number: 'OIL-15W40-5L', name: 'Engine oil 15W-40, 5 L', quantity: 3, unit_cost_cents: 150_000, line_cost_cents: 450_000 }],
    failures: [], version: 0, created_at: date, updated_at: date, ...overrides,
  }
}

const trip = {
  id: 'trip-1', route_id: ROUTE, route_name: 'Addis Ababa – Adama', vehicle_id: VEHICLE_ID, driver_id: DRIVER, status: 'completed',
  origin: 'Addis Ababa', destination: 'Adama', planned_distance_km: 99, planned_duration_seconds: 6480,
  scheduled_start: '2026-10-20T03:00:00Z', scheduled_end: '2026-10-20T04:48:00Z',
  actual_start: '2026-10-20T03:10:00Z', actual_end: '2026-10-20T05:05:00Z', actual_distance_km: 104.3,
}

/** Its A-service is overdue by distance (FMS-129); no service on record. */
const overdueService = {
  vehicle_id: VEHICLE_ID,
  registration_number: 'AA 3-20001',
  depot_id: DEPOT,
  program: { id: 'p-1', name: 'A-service', tasks: ['Engine oil', 'Oil filter'] },
  status: 'overdue',
  due_by: ['km'],
  last_service: null,
  since: { at: '2026-01-05T08:00:00Z', odometer_km: 75_000, engine_hours: null },
  next_due: { odometer_km: 85_000, at: null, engine_hours: null },
  readings: { odometer_km: 87_200, engine_hours: null },
  remaining: { km: -2200, days: null, engine_hours: null },
  open_record: null,
  status_changed_at: '2026-10-20T22:30:00Z',
  computed_at: '2026-10-30T22:30:00Z',
}

/** A recall it is under, not yet done (FMS-133). */
const openRecall = {
  recall_id: 'rc-1', campaign_code: 'ISZ-24-017', description: 'Front brake hose may chafe against the frame.', remedy: 'Replace both front brake hoses.',
  vehicle_id: VEHICLE_ID, registration_number: vehicle.registration_number, status: 'open', maintenance_record_id: null, completed_at: null, notes: null,
  matched_at: '2026-10-01T06:00:00Z', updated_at: '2026-10-01T06:00:00Z',
}

/** Its brake warranty, ending in 20 days, with the brake repair claimable under it. */
const brakeWarranty = {
  id: 'w-1', vehicle_id: VEHICLE_ID, registration_number: vehicle.registration_number, component: 'brakes', provider: 'Moenco', coverage: 'Pads, discs and callipers',
  starts_on: '2025-11-28', ends_on: '2026-11-28', ends_km: 100_000, terms: null, is_active: true, status: 'expiring', days_left: 20, km_left: 13_000,
  claims: { claimable: 1, submitted: 0, approved: 0, rejected: 0, recovered_cents: 0 }, version: 2, created_at: '2025-11-28T09:00:00Z', updated_at: '2025-11-28T09:00:00Z',
}

const claimable = { warranty_id: 'w-1', provider: 'Moenco', component: 'brakes', status: 'claimable', amount_cents: null, reference: null, ends_km: null, km_checked: true, updated_at: null, updated_by: null }

/** The vehicle and every section's list; records each tracking query, and what the warranty screens send. */
function serveVehicle() {
  const trackQueries: URLSearchParams[] = []
  const sent: { path: string; body: unknown }[] = []
  const keep = async (request: Request) => {
    const body = (await request.json()) as Record<string, unknown>
    sent.push({ path: new URL(request.url).pathname, body })
    return body
  }
  server.use(
    http.get(`/api/v1/vehicles/${VEHICLE_ID}/recalls`, () => envelope([openRecall])),
    http.get('/api/v1/warranties', () => page([brakeWarranty])),
    http.post('/api/v1/warranties', async ({ request }) => envelope({ ...brakeWarranty, ...(await keep(request)), id: 'w-2', status: 'active', claims: { ...brakeWarranty.claims, claimable: 2 } })),
    http.patch('/api/v1/recalls/rc-1/vehicles/:vehicleId', async ({ request }) => envelope({ ...openRecall, ...(await keep(request)), completed_at: '2026-11-08T09:00:00Z' })),
    http.patch('/api/v1/maintenance-records/r-2/warranty-claim', async ({ request }) => envelope({ ...claimable, ...(await keep(request)), updated_at: '2026-11-08T09:00:00Z', updated_by: 'u-1' })),
    http.get(`/api/v1/vehicles/${VEHICLE_ID}`, () => envelope(vehicle)),
    http.get(`/api/v1/vehicles/${VEHICLE_ID}/service-due`, () => envelope([overdueService])),
    http.get('/api/v1/depots', () => envelope([{ id: DEPOT, name: 'Addis Ababa Central', code: 'ADD', location: 'Addis Ababa' }])),
    http.get('/api/v1/maintenance', () =>
      page([
        record('r-2', '2026-10-12T08:00:00Z', { maintenance_type: 'corrective', description: 'Replaced the front brake pads', warranty_claim: claimable }),
        record('r-1', '2026-06-02T08:00:00Z'),
      ]),
    ),
    http.get('/api/v1/trips', () => page([trip], { next_cursor: null })),
    http.get('/api/v1/drivers', () => page([{ id: DRIVER, full_name: 'Tigist Haile' }])),
    http.get(`/api/v1/routes/${ROUTE}`, () =>
      envelope({ id: ROUTE, name: trip.route_name, origin: { latitude: 9.0108, longitude: 38.7613 }, destination: { latitude: 8.54, longitude: 39.27 }, stops: [], measured_at: '2026-10-30T09:00:00Z' }),
    ),
    // The road it follows (FMS-84): GeoJSON, longitude first.
    http.get(`/api/v1/routes/${ROUTE}/geometry`, () => envelope({ type: 'LineString', coordinates: [[38.7613, 9.0108], [39.0, 8.75], [39.27, 8.54]] })),
    http.get(`/api/v1/vehicles/${VEHICLE_ID}/tracking`, ({ request }) => {
      trackQueries.push(new URL(request.url).searchParams)
      return HttpResponse.json({
        data: [0, 1, 2].map((i) => ({ recorded_at: `2026-10-20T03:${10 + 2 * i}:00.000Z`, lat: 9 - i * 0.1, lng: 38.8 + i * 0.1, speed_kmh: 60, trip_id: 'trip-1' })),
        meta: { page_size: 1000, next_cursor: null, request_id: 'r-1' },
      })
    }),
    http.get('/api/v1/fuel-logs', () =>
      page([{ id: 'f-1', driver_id: DRIVER, trip_id: 'trip-1', fuel_type: 'diesel', quantity_ml: 33_900, unit_price_cents: 11_000, total_cost_cents: 372_900, odometer_km: 87_000, station_name: 'Total Adama', source: 'pump', recorded_at: '2026-10-20T04:40:00Z' }]),
    ),
    http.get(`/api/v1/vehicles/${VEHICLE_ID}/meter-readings`, () =>
      page([
        { id: 'm-2', meter: 'odometer', value: 87_000, source: 'fuel_log', recorded_at: '2026-10-20T04:40:00Z', suspect: false },
        { id: 'm-1', meter: 'odometer', value: 86_500, source: 'manual', recorded_at: '2026-10-19T08:00:00Z', suspect: true },
      ]),
    ),
    http.get('/api/v1/documents', () => envelope([])),
    http.get(`/api/v1/vehicles/${VEHICLE_ID}/maintenance-risk`, () =>
      envelope({ vehicle_id: VEHICLE_ID, prediction_id: 'p-1', health_score: 82, risk_level: 'low', failure_probability: 0.18, prediction_horizon_days: 30, factors: [], model_name: 'predictive-maintenance', model_version: 'pm-2026.10', as_of: '2026-10-25T21:00:00Z', scored_at: vehicle.health_score_updated_at, stale: false }),
    ),
  )
  return { trackQueries, sent }
}

const sections = () => screen.getByRole('group', { name: 'Vehicle history sections' })

describe('Vehicle history (S-22)', () => {
  it('shows the vehicle and its full repair history, newest first, with parts and cost', async () => {
    serveVehicle()
    signedInAs(manager)
    renderApp(`/vehicles/${VEHICLE_ID}`)

    expect(await screen.findByRole('heading', { level: 1, name: /AA 3-20001/ })).toBeInTheDocument()
    expect(await screen.findByText('Addis Ababa Central')).toBeInTheDocument()
    expect(screen.getByText('87,000 km')).toBeInTheDocument()
    expect(screen.getByText(/32\.5 L\/100 km/)).toBeInTheDocument()
    expect(within(sections()).getAllByRole('button').map((b) => b.textContent?.trim())).toEqual(['Repairs', 'Trips and routes', 'Fuel and odometer', 'Documents', 'Health', 'Service due', 'Warranty and recalls'])

    const table = await screen.findByRole('table', { name: /Repair history of AA 3-20001/ })
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(3))
    const [, newest, older] = within(table).getAllByRole('row')
    expect(newest).toHaveTextContent('Repair')
    expect(newest).toHaveTextContent('Replaced the front brake pads')
    expect(newest).toHaveTextContent('Engine oil 15W-40, 5 L × 3')
    expect(newest).toHaveTextContent('ETB 8,450.00')
    expect(older).toHaveTextContent('Preventive service')
    expect(screen.getByRole('heading', { name: 'Repair and service history' }).nextElementSibling).toHaveTextContent('2 records, newest first')
  })

  it('lists the trips with their driver, and a trip opens its planned route and the GPS track it drove', async () => {
    const api = serveVehicle()
    const user = userEvent.setup()
    signedInAs(manager)
    renderApp(`/vehicles/${VEHICLE_ID}?section=trips`)

    const table = await screen.findByRole('table', { name: /Trips of AA 3-20001/ })
    const row = (await within(table).findByText('Addis Ababa – Adama')).closest('tr')!
    await waitFor(() => expect(row).toHaveTextContent('Tigist Haile'))
    expect(row).toHaveTextContent('104.3 km')
    await user.click(row)

    const panel = await screen.findByRole('dialog', { name: 'Addis Ababa – Adama' })
    expect(within(panel).getByText('Tigist Haile')).toBeInTheDocument()
    const map = await within(panel).findByRole('region', { name: 'Map of Addis Ababa – Adama' })
    await waitFor(() => expect(map).toHaveAttribute('data-points', '3'))
    expect(map).toHaveAttribute('data-origin', '9.0108,38.7613')
    // The planned route along its road, [latitude, longitude] for the map.
    expect(map).toHaveAttribute('data-road', '9.0108,38.7613 8.75,39 8.54,39.27')
    expect(map).toHaveAttribute('data-destination', '8.54,39.27')
    expect(api.trackQueries[0].get('from')).toBe(trip.actual_start)
    expect(api.trackQueries[0].get('to')).toBe(trip.actual_end)
    expect(within(panel).getByText(/3 GPS points/)).toBeInTheDocument()
  })

  it('shows fill-ups and odometer readings, a suspect reading marked', async () => {
    serveVehicle()
    signedInAs(manager)
    renderApp(`/vehicles/${VEHICLE_ID}?section=fuel`)

    const fills = await screen.findByRole('table', { name: /Fill-ups of AA 3-20001/ })
    await waitFor(() => expect(within(fills).getByText('33.90 L')).toBeInTheDocument())
    expect(within(fills).getByText('ETB 3,729.00')).toBeInTheDocument()
    const readings = screen.getByRole('table', { name: /Odometer readings of AA 3-20001/ })
    await waitFor(() => expect(within(readings).getByText('Suspect')).toBeInTheDocument())
    expect(within(readings).getByText('Fuel log')).toBeInTheDocument()
  })

  it('shows each section only with its permission: a dispatcher sees trips and the odometer, not repairs, fuel, documents or health', async () => {
    serveVehicle()
    signedInAs(dispatcher)
    renderApp(`/vehicles/${VEHICLE_ID}?section=repairs`)

    await screen.findByRole('heading', { level: 1, name: /AA 3-20001/ })
    expect(within(sections()).getAllByRole('button').map((b) => b.textContent?.trim())).toEqual(['Trips and routes', 'Odometer', 'Service due'])
    // A section the user may not see falls back to the first one they may.
    expect(await screen.findByRole('table', { name: /Trips of AA 3-20001/ })).toBeInTheDocument()
    await userEvent.setup().click(within(sections()).getByRole('button', { name: 'Odometer' }))
    expect(await screen.findByRole('table', { name: /Odometer readings/ })).toBeInTheDocument()
    expect(screen.queryByRole('table', { name: /Fill-ups/ })).not.toBeInTheDocument()
  })

  it('says a service is overdue in the header, which opens Service due: the program, by how much and its checklist (FMS-129)', async () => {
    serveVehicle()
    signedInAs(manager)
    renderApp(`/vehicles/${VEHICLE_ID}`)

    await screen.findByRole('heading', { level: 1, name: /AA 3-20001/ })
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Service overdue: A-service. Open Service due.' }))
    const section = await screen.findByRole('region', { name: 'Service due' })
    expect(within(section).getByText('A-service')).toBeInTheDocument()
    expect(within(section).getByText('Overdue')).toBeInTheDocument()
    expect(within(section).getByText('2,200 km over')).toBeInTheDocument()
    expect(within(section).getByText('Checklist: Engine oil, Oil filter')).toBeInTheDocument()
    expect(section).toHaveTextContent('None on record')
  })

  it('says an open recall in the header, which opens Warranty and recalls: the recall, marked done by hand, and the warranty ending (FMS-133)', async () => {
    const api = serveVehicle()
    const user = userEvent.setup()
    signedInAs(technician)
    renderApp(`/vehicles/${VEHICLE_ID}`)

    await user.click(await screen.findByRole('button', { name: '1 open recall. Open Warranty and recalls.' }))
    const recalls = await screen.findByRole('region', { name: 'Recalls' })
    const card = (await within(recalls).findByText('ISZ-24-017')).closest('li')!
    expect(card).toHaveTextContent('Open')
    expect(card).toHaveTextContent('Front brake hose may chafe against the frame.')
    expect(card).toHaveTextContent('Replace both front brake hoses.')

    const warranties = screen.getByRole('region', { name: 'Warranties' })
    const warranty = (await within(warranties).findByText('Moenco')).closest('li')!
    expect(warranty).toHaveTextContent('Brakes')
    expect(warranty).toHaveTextContent('Expiring')
    expect(warranty).toHaveTextContent('Ends in 20 days · 13,000 km left')
    expect(warranty).toHaveTextContent('28 Nov 2026 or 100,000 km, whichever comes first')
    expect(warranty).toHaveTextContent('1 to claim')

    await user.click(within(card).getByRole('button', { name: 'Mark recall ISZ-24-017 done' }))
    await user.click(within(await screen.findByRole('dialog', { name: 'Mark ISZ-24-017 done?' })).getByRole('button', { name: 'Mark done' }))
    await waitFor(() => expect(api.sent).toEqual([{ path: `/api/v1/recalls/rc-1/vehicles/${VEHICLE_ID}`, body: { status: 'completed' } }]))
  })

  it('adds a warranty: an end is needed, by date or odometer; what is sent', async () => {
    const api = serveVehicle()
    const user = userEvent.setup()
    signedInAs(technician)
    renderApp(`/vehicles/${VEHICLE_ID}?section=warranty`)

    await user.click(await screen.findByRole('button', { name: 'Add warranty' }))
    const drawer = await screen.findByRole('dialog', { name: 'Add warranty' })
    await user.selectOptions(within(drawer).getByLabelText('Covers'), 'transmission')
    await user.type(within(drawer).getByLabelText('Provider'), 'Gearbox Ltd')
    await user.type(within(drawer).getByLabelText('Starts'), '2026-11-01')
    await user.click(within(drawer).getByRole('button', { name: 'Add warranty' }))
    expect(await within(drawer).findByText('Give an end date, an odometer reading, or both.')).toBeInTheDocument()
    expect(api.sent).toEqual([])

    await user.type(within(drawer).getByLabelText(/End odometer/), '150,000')
    await user.click(within(drawer).getByRole('button', { name: 'Add warranty' }))
    await waitFor(() =>
      expect(api.sent).toEqual([
        {
          path: '/api/v1/warranties',
          body: { vehicle_id: VEHICLE_ID, component: 'transmission', provider: 'Gearbox Ltd', coverage: null, starts_on: '2026-11-01', ends_on: null, ends_km: 150_000, terms: null },
        },
      ]),
    )
    expect(await screen.findByText('2 earlier repairs are claimable under it.')).toBeInTheDocument()
  })

  it('marks a repair claimable under warranty; its record submits the claim, then approves it with the amount recovered (FMS-133)', async () => {
    const api = serveVehicle()
    const user = userEvent.setup()
    signedInAs(technician)
    renderApp(`/vehicles/${VEHICLE_ID}`)

    const table = await screen.findByRole('table', { name: /Repair history of AA 3-20001/ })
    const row = (await within(table).findByText('Replaced the front brake pads')).closest('tr')!
    expect(row).toHaveTextContent('Under warranty: claimable')
    await user.click(row)
    const drawer = await screen.findByRole('dialog', { name: /AA 3-20001/ })
    expect(drawer).toHaveTextContent('Covered by the brakes warranty from Moenco.')
    await user.type(within(drawer).getByLabelText(/claim reference/), 'MOE-CLM-881')
    await user.click(within(drawer).getByRole('button', { name: 'Submit claim' }))
    expect(await within(drawer).findByText('Claim submitted')).toBeInTheDocument()

    await user.click(within(drawer).getByRole('button', { name: 'Approved' }))
    await user.click(within(drawer).getByRole('button', { name: 'Save approval' }))
    expect(within(drawer).getByText('Enter the amount the provider pays back.')).toBeInTheDocument()
    await user.type(within(drawer).getByLabelText(/Amount recovered/), '3800')
    await user.click(within(drawer).getByRole('button', { name: 'Save approval' }))
    await waitFor(() =>
      expect(api.sent.map((s) => s.body)).toEqual([
        { status: 'submitted', reference: 'MOE-CLM-881' },
        { status: 'approved', amount_cents: 380_000 },
      ]),
    )
    expect(await within(drawer).findByText('Claim approved')).toBeInTheDocument()
    expect(drawer).toHaveTextContent('Recovered ETB 3,800.00')
  })

  it('a repair with no odometer under a warranty with a km limit is submitted with the reading (FMS-133)', async () => {
    serveVehicle()
    const unchecked = { ...claimable, ends_km: 100_000, km_checked: false }
    const sent: unknown[] = []
    server.use(
      http.get('/api/v1/maintenance', () =>
        page([record('r-2', '2026-10-12T08:00:00Z', { maintenance_type: 'corrective', description: 'Replaced the front brake pads', odometer_km: null, warranty_claim: unchecked })]),
      ),
      http.patch('/api/v1/maintenance-records/r-2/warranty-claim', async ({ request }) => {
        const body = (await request.json()) as { odometer_km?: number }
        sent.push(body)
        if ((body.odometer_km ?? 0) > 100_000) {
          return HttpResponse.json(
            { error: { code: 'CONFLICT_INVALID_STATE_TRANSITION', message: 'Past the limit.', details: [{ field: 'odometer_km', reason: 'over_km_limit', allowed_transitions: [] }] } },
            { status: 409 },
          )
        }
        return envelope({ ...unchecked, status: 'submitted', km_checked: true, updated_at: '2026-11-08T09:00:00Z', updated_by: 'u-1' })
      }),
    )
    const user = userEvent.setup()
    signedInAs(technician)
    renderApp(`/vehicles/${VEHICLE_ID}`)

    const table = await screen.findByRole('table', { name: /Repair history of AA 3-20001/ })
    const row = (await within(table).findByText('Replaced the front brake pads')).closest('tr')!
    expect(row).toHaveTextContent('Under warranty: odometer needed')
    await user.click(row)
    const drawer = await screen.findByRole('dialog', { name: /AA 3-20001/ })
    expect(drawer).toHaveTextContent('It ends at 100,000 km and this repair has no odometer reading: the distance is not checked yet.')

    // Not sent without the reading.
    await user.click(within(drawer).getByRole('button', { name: 'Submit claim' }))
    expect(within(drawer).getByText('Enter the odometer at the repair: the provider pays only within the limit.')).toBeInTheDocument()
    expect(sent).toEqual([])

    // Past the limit: the server keeps the reading and says there is nothing to claim.
    await user.type(within(drawer).getByLabelText(/Odometer at the repair/), '104000')
    await user.click(within(drawer).getByRole('button', { name: 'Submit claim' }))
    expect(await within(drawer).findByText("At 104,000 km the repair is past the warranty's 100,000 km limit: there is nothing to claim.")).toBeInTheDocument()

    const odometer = within(drawer).getByLabelText(/Odometer at the repair/)
    await user.clear(odometer)
    await user.type(odometer, '95,000')
    await user.click(within(drawer).getByRole('button', { name: 'Submit claim' }))
    expect(await within(drawer).findByText('Claim submitted')).toBeInTheDocument()
    expect(sent).toEqual([
      { status: 'submitted', reference: null, odometer_km: 104_000 },
      { status: 'submitted', reference: null, odometer_km: 95_000 },
    ])
  })

  it('a reader sees the warranty and recalls without the buttons that change them', async () => {
    serveVehicle()
    signedInAs(manager)
    renderApp(`/vehicles/${VEHICLE_ID}?section=warranty`)
    expect(await screen.findByText('ISZ-24-017')).toBeInTheDocument()
    expect(await screen.findByText('Moenco')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Mark recall/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add warranty' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Void the/ })).not.toBeInTheDocument()
  })

  it('lists its incidents with their driver, by vehicle_id; one opens read-only without incident:manage (FMS-148)', async () => {
    serveVehicle()
    const asked: URLSearchParams[] = []
    const incident = (id: string, overrides: Record<string, unknown>) => ({
      id, incident_type: 'accident', severity: 'high', status: 'open', description: 'Clipped a minibus at Megenagna', vehicle_id: VEHICLE_ID, driver_id: DRIVER,
      trip_id: null, depot_id: DEPOT, reported_by: 'u-9', latitude: null, longitude: null, occurred_at: '2026-10-22T07:30:00Z', created_at: '2026-10-22T07:31:00Z',
      assigned_to: null, notes: null, resolved_at: null, resolved_by: null, updated_at: '2026-10-22T07:31:00Z', ...overrides,
    })
    server.use(
      http.get('/api/v1/incidents', ({ request }) => {
        asked.push(new URL(request.url).searchParams)
        return page([
          incident('i-2', {}),
          incident('i-1', { incident_type: 'breakdown', severity: 'medium', status: 'resolved', description: 'Gearbox would not engage', driver_id: null, occurred_at: '2026-09-02T05:00:00Z', notes: 'Clutch cable replaced.' }),
        ])
      }),
    )
    signedInAs(currentUser(['fleet_manager'], ['vehicle:read', 'depot:read', 'driver:read', 'incident:read']))
    const user = userEvent.setup()
    renderApp(`/vehicles/${VEHICLE_ID}?section=incidents`)

    const table = await screen.findByRole('table', { name: 'Incidents of AA 3-20001' })
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(3))
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows[0]).toHaveTextContent(/Accident.*Clipped a minibus at Megenagna.*High.*Tigist Haile.*Open/)
    expect(rows[1]).toHaveTextContent(/Breakdown.*Medium.*No driver recorded.*Resolved/)
    expect(asked[0].get('vehicle_id')).toBe(VEHICLE_ID)
    expect(screen.getByRole('heading', { name: 'Incidents' }).nextElementSibling).toHaveTextContent('2 incidents, newest first')

    await user.click(within(rows[1]).getByText('Gearbox would not engage'))
    const drawer = await screen.findByRole('dialog', { name: 'Breakdown: AA 3-20001' })
    expect(within(drawer).getByText('Clutch cable replaced.')).toBeInTheDocument()
    expect(within(drawer).queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
  })

  it('says when the vehicle is not found', async () => {
    server.use(
      http.get(`/api/v1/vehicles/${VEHICLE_ID}`, () => HttpResponse.json({ error: { code: 'NOT_FOUND', message: 'Vehicle not found.' } }, { status: 404 })),
      http.get('/api/v1/depots', () => envelope([])),
    )
    signedInAs(manager)
    renderApp(`/vehicles/${VEHICLE_ID}`)
    expect(await screen.findByRole('heading', { name: 'Vehicle not found' })).toBeInTheDocument()
    expect(within(screen.getByRole('main')).getByRole('link', { name: 'Vehicles' })).toHaveAttribute('href', '/vehicles')
  })
})

describe('tripMapBounds', () => {
  it('frames the track and the route ends; nothing to frame is null', () => {
    expect(tripMapBounds({ origin: [9, 38.7], destination: [8.5, 39.3] }, [[8.9, 38.9]])).toEqual([[8.5, 38.7], [9, 39.3]])
    expect(tripMapBounds({ origin: null, destination: null }, [])).toBeNull()
  })
})

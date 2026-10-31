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
    total_cost_cents: 845_000, parts_cost_cents: 545_000, workshop: null, notes: null, completed_by: null,
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

/** The vehicle and every section's list; records each tracking query. */
function serveVehicle() {
  const trackQueries: URLSearchParams[] = []
  server.use(
    http.get(`/api/v1/vehicles/${VEHICLE_ID}`, () => envelope(vehicle)),
    http.get('/api/v1/depots', () => envelope([{ id: DEPOT, name: 'Addis Ababa Central', code: 'ADD', location: 'Addis Ababa' }])),
    http.get('/api/v1/maintenance', () => page([record('r-2', '2026-10-12T08:00:00Z', { maintenance_type: 'corrective', description: 'Replaced the front brake pads' }), record('r-1', '2026-06-02T08:00:00Z')])),
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
  return { trackQueries }
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
    expect(within(sections()).getAllByRole('button').map((b) => b.textContent?.trim())).toEqual(['Repairs', 'Trips and routes', 'Fuel and odometer', 'Documents', 'Health'])

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
    expect(within(sections()).getAllByRole('button').map((b) => b.textContent?.trim())).toEqual(['Trips and routes', 'Odometer'])
    // A section the user may not see falls back to the first one they may.
    expect(await screen.findByRole('table', { name: /Trips of AA 3-20001/ })).toBeInTheDocument()
    await userEvent.setup().click(within(sections()).getByRole('button', { name: 'Odometer' }))
    expect(await screen.findByRole('table', { name: /Odometer readings/ })).toBeInTheDocument()
    expect(screen.queryByRole('table', { name: /Fill-ups/ })).not.toBeInTheDocument()
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

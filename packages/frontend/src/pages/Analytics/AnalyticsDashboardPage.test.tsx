import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { currentUser, renderApp, signedInAs } from '@/test/auth'
import { server } from '@/test/msw/server'
import { currentMonth, monthLabel, shiftMonth } from '@/lib/month'
import { rangeDays, type FleetSummary, type MaintenanceRisk, type RankedDriver, type VehicleUtilisation } from './api'
import { ago, birr, birrPerKm, litres } from './describe'

// jsdom has no canvas: the charts stand in as lists of what they were given.
vi.mock('@/pages/Analytics/charts', () => ({
  UtilisationByDayChart: ({ daily }: { daily: FleetSummary['daily'] }) => <p>Utilisation chart: {daily.length} days</p>,
  CostByDayChart: ({ daily }: { daily: FleetSummary['daily'] }) => <p>Cost chart: {daily.length} days</p>,
  UtilisationByVehicleChart: ({ vehicles }: { vehicles: VehicleUtilisation[] }) => <p>Vehicle chart: {vehicles.length} bars</p>,
  DriverRankingChart: ({ drivers, label }: { drivers: RankedDriver[]; label: string }) => (
    <p>
      {label}: {drivers.map((d) => `${d.rank}. ${d.name} ${d.score}`).join(', ')}
    </p>
  ),
}))

const manager = currentUser(['fleet_manager'], ['analytics:read', 'vehicle:read', 'depot:read'])
const trackingManager = currentUser(['fleet_manager'], ['analytics:read', 'vehicle:read', 'depot:read', 'tracking:read'])

const ranked = (n: number): RankedDriver[] =>
  Array.from({ length: n }, (_, i) => ({
    driver_id: `d-${i}`,
    name: `Driver ${i + 1}`,
    depot: 'Bole',
    rank: i + 1,
    score: 100 - i,
    components: { punctuality: 90, safety: 80, incidents: 100, dvir: 50 },
    trips_completed: 12,
  }))

/** GET /analytics/driver-ranking, with the months asked for. */
function serveRanking(drivers: RankedDriver[], unscored = 0) {
  const months: string[] = []
  server.use(
    http.get('/api/v1/analytics/driver-ranking', ({ request }) => {
      months.push(new URL(request.url).searchParams.get('month') ?? '')
      return HttpResponse.json({ data: { month: '2026-10', weights: { punctuality: 35, safety: 35, incidents: 20, dvir: 10 }, drivers, unscored, min_trips: 3 }, meta: meta() })
    }),
  )
  return months
}
const dispatcherNoAnalytics = currentUser(['technician'], ['maintenance:read'])

const day = (date: string) => ({
  date,
  vehicles_used: 3,
  utilisation_pct: 42,
  distance_km: 400,
  trips_completed: 4,
  on_time_pct: 50,
  fuel_ml: 120_000,
  fuel_cost_cents: 1_000_000,
  maintenance_cost_cents: 234_550,
  total_cost_cents: 1_234_550,
  cost_per_km_cents: 100,
})

const summary: FleetSummary = {
  vehicles: { total: 7, by_status: { active: 5, inactive: 0, maintenance: 1, retired: 1 }, maintenance_flagged: 1, average_health_score: 81 },
  ...day('x'),
  open_alerts: { low: 0, medium: 2, high: 1, critical: 3, total: 6 },
  daily: [day('2026-10-28'), day('2026-10-29')],
}

const risks: MaintenanceRisk[] = [
  { vehicle_id: 'v-1', registration_number: 'AA 3-12345', depot_name: 'Bole', status: 'active', health_score: 41, maintenance_flag: true, risk_pct: 87, predicted_failure_type: 'brake_wear' },
  { vehicle_id: 'v-2', registration_number: 'AA 3-22222', depot_name: 'Bole', status: 'active', health_score: 95, maintenance_flag: false, risk_pct: null, predicted_failure_type: null },
]

const vehicles = (n: number): VehicleUtilisation[] =>
  Array.from({ length: n }, (_, i) => ({ vehicle_id: `v-${i}`, registration_number: `AA 3-${10000 + i}`, depot_name: 'Bole', status: 'active', days_used: 10, days: 30, utilisation_pct: 33, distance_km: 900, trips_completed: 9 }))

const meta = (overrides: Record<string, unknown> = {}) => ({
  from: '2026-09-30',
  to: '2026-10-29',
  days: 30,
  computed_at: new Date(Date.now() - 20 * 60_000).toISOString(),
  stale: false,
  data_freshness: { source: 'replica', lag_seconds: 0, as_of: new Date().toISOString() },
  request_id: 'r-1',
  ...overrides,
})

function serve({ fleet = summary, fleetMeta = meta(), fleetVehicles = vehicles(7) }: { fleet?: FleetSummary; fleetMeta?: Record<string, unknown>; fleetVehicles?: VehicleUtilisation[] } = {}) {
  const queries: URLSearchParams[] = []
  server.use(
    http.get('/api/v1/analytics/fleet-summary', ({ request }) => {
      queries.push(new URL(request.url).searchParams)
      return HttpResponse.json({ data: fleet, meta: fleetMeta })
    }),
    http.get('/api/v1/analytics/utilisation', () =>
      HttpResponse.json({ data: { utilisation_pct: 33, vehicle_days: 210, days_used: 70, vehicles: fleetVehicles }, meta: meta() }),
    ),
    http.get('/api/v1/analytics/maintenance-risk', () => HttpResponse.json({ data: risks, meta: meta() })),
    http.get('/api/v1/depots', () => HttpResponse.json({ data: [], meta: { page: 1, page_size: 100, total_items: 0, total_pages: 0 } })),
  )
  return { last: () => queries[queries.length - 1] }
}

const kpi = (label: string) => screen.getByText(label, { selector: 'dt' }).parentElement as HTMLElement

describe('Analytics dashboard (S-18, FMS-51)', () => {
  it('is the dashboard for analytics:read: KPIs from the API, the charts, and what needs attention', async () => {
    const api = serve()
    signedInAs(manager)
    renderApp('/dashboard')

    expect(await screen.findByText('Utilisation chart: 2 days')).toBeInTheDocument()
    expect(within(kpi('Utilisation')).getByText('42%')).toBeInTheDocument()
    expect(within(kpi('Cost per km')).getByText('ETB 1.00')).toBeInTheDocument()
    expect(within(kpi('Fleet cost')).getByText('ETB 12,346')).toBeInTheDocument()
    expect(within(kpi('Fleet cost')).getByText('ETB 10,000 fuel (120 L) · ETB 2,346 repairs')).toBeInTheDocument()
    expect(within(kpi('Trips on time')).getByText('50%')).toBeInTheDocument()
    expect(screen.getByText('Cost chart: 2 days')).toBeInTheDocument()
    expect(await screen.findByText('Vehicle chart: 7 bars')).toBeInTheDocument()

    const alerts = screen.getByRole('list', { name: 'Open alerts by severity' })
    expect(within(within(alerts).getByText('Critical').closest('li')!).getByText('3')).toBeInTheDocument()
    expect(await screen.findByRole('link', { name: 'AA 3-12345' })).toHaveAttribute('href', '/vehicles/v-1?section=health')
    expect(screen.getByText('87%')).toBeInTheDocument()
    // A healthy vehicle with no prediction is not "at risk".
    expect(screen.queryByText('AA 3-22222')).not.toBeInTheDocument()

    expect(screen.getByText(/Figures as of \d\d:\d\d, refreshed hourly/)).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toHaveTextContent(/out of date/)
    expect(Object.fromEntries(api.last())).toEqual(rangeDays('30d'))
  })

  it('says when the figures are stale: no refresh for more than 25 hours', async () => {
    serve({ fleetMeta: meta({ stale: true, computed_at: new Date(Date.now() - 26 * 3_600_000).toISOString() }) })
    signedInAs(manager)
    renderApp('/dashboard')

    expect(await screen.findByText('These figures may be out of date.')).toBeInTheDocument()
    expect(screen.getByText(/last refreshed 26 hours ago/)).toBeInTheDocument()
  })

  it('filters by range, kept in the address', async () => {
    const api = serve()
    signedInAs(manager)
    renderApp('/dashboard')
    const user = userEvent.setup()
    await screen.findByText('Utilisation chart: 2 days')

    await user.click(screen.getByRole('button', { name: /Range/ }))
    await user.click(await screen.findByRole('option', { name: 'Last 7 days' }))

    await waitFor(() => expect(Object.fromEntries(api.last())).toEqual(rangeDays('7d')))
    expect(screen.getByTestId('location').textContent).toBe('/dashboard?range=7d')
  })

  it('renders the whole fleet in the vehicle chart: 200 vehicles', async () => {
    serve({ fleetVehicles: vehicles(200) })
    signedInAs(manager)
    renderApp('/dashboard')

    expect(await screen.findByText('Vehicle chart: 200 bars')).toBeInTheDocument()
    expect(screen.getByText('Days on the road, 200 vehicles, highest first')).toBeInTheDocument()
  })

  it('ranks the drivers by their score for the last whole month, with the way to the full list (FMS-146)', async () => {
    serve()
    const months = serveRanking(ranked(3), 2)
    signedInAs(trackingManager)
    renderApp('/dashboard')
    const last = shiftMonth(currentMonth(), -1)

    expect(await screen.findByText(`Driver ranking, ${monthLabel(last)}: 1. Driver 1 100, 2. Driver 2 99, 3. Driver 3 98`)).toBeInTheDocument()
    expect(months).toEqual([last])
    expect(screen.getByRole('link', { name: 'Full list' })).toHaveAttribute('href', `/reports?report=drivers&month=${last}`)
    expect(screen.getByText(/3 drivers scored · 2 with fewer than 3 trips not scored/)).toBeInTheDocument()
  })

  it('past 20 drivers, shows the top 10 and the bottom 10', async () => {
    serve()
    serveRanking(ranked(25))
    signedInAs(trackingManager)
    renderApp('/dashboard')

    const top = await screen.findByText(/^Top 10 drivers/)
    expect(top.textContent).toMatch(/1\. Driver 1 100.*10\. Driver 10 91$/)
    expect(screen.getByText(/^Bottom 10 drivers/).textContent).toMatch(/16\. Driver 16 85.*25\. Driver 25 76$/)
    expect(screen.getByText(/25 drivers scored, 5 between them in the full list/)).toBeInTheDocument()
  })

  it('says when no driver was scored', async () => {
    serve()
    serveRanking([], 4)
    signedInAs(trackingManager)
    renderApp('/dashboard')

    expect(await screen.findByText(`No driver scored in ${monthLabel(shiftMonth(currentMonth(), -1))}`)).toBeInTheDocument()
    expect(screen.getByText('A driver is scored with at least 3 completed trips in the month.')).toBeInTheDocument()
  })

  it('shows no ranking, and asks for none, without tracking:read: it is behavioural data', async () => {
    serve()
    const months = serveRanking(ranked(3))
    signedInAs(manager)
    renderApp('/dashboard')

    await screen.findByText('Vehicle chart: 7 bars')
    expect(screen.queryByRole('heading', { name: 'Driver ranking' })).not.toBeInTheDocument()
    expect(months).toEqual([])
  })

  it('keeps the menu home for a user without analytics:read, and asks for nothing', async () => {
    const api = serve()
    signedInAs(dispatcherNoAnalytics)
    renderApp('/analytics')

    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeInTheDocument()
    expect(screen.getByText('Use the menu to open your screens.')).toBeInTheDocument()
    expect(api.last()).toBeUndefined()
  })
})

describe('how the dashboard says its figures', () => {
  it('birr whole and per km from cents, litres from ml, and how old a refresh is', () => {
    expect(birr(1_234_550)).toBe('ETB 12,346')
    expect(birrPerKm(100)).toBe('ETB 1.00')
    expect(birrPerKm(null)).toBe('—')
    expect(litres(120_499)).toBe('120 L')
    const now = new Date('2026-10-29T12:00:00Z')
    expect(ago('2026-10-29T11:59:00Z', now)).toBe('1 minute ago')
    expect(ago('2026-10-28T10:00:00Z', now)).toBe('26 hours ago')
    expect(ago('2026-10-25T12:00:00Z', now)).toBe('4 days ago')
  })
})

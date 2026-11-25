import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { currentMonth, shiftMonth } from '@/lib/month'
import { currentUser, envelope, renderApp, signedInAs } from '@/test/auth'
import { server } from '@/test/msw/server'
import { formatChange, formatKpi, formatTarget, type Kpi, type KpiDashboard, type KpiTrend } from './api'

// FMS-160: S-39 KPIs. The API is faked; jsdom has no canvas, so the charts stand in as what they were given.

vi.mock('@/pages/Kpis/charts', () => ({
  Sparkline: ({ points, label }: { points: unknown[]; label: string }) => <p role="img" aria-label={`${label}, last 12 months`}>{points.length} months</p>,
  TrendChart: ({ trend }: { trend: KpiTrend }) => <p role="img" aria-label={`${trend.label} by month, this period and a year before`}>{trend.series.length} months</p>,
  BreakdownChart: ({ trend }: { trend: KpiTrend }) => <p>Breakdown: {trend.breakdown.map((b) => b.name).join(', ')}</p>,
}))

const BOLE = '11111111-1111-4111-8111-111111111111'
const manager = currentUser(['fleet_manager'], ['analytics:read', 'depot:read', 'appeal:read', 'prediction:read'])
const LAST_MONTH = shiftMonth(currentMonth(), -1)
const spark = (v: number | null): [string, number | null][] => Array.from({ length: 12 }, (_, i) => [shiftMonth(LAST_MONTH, i - 11), v])

const kpi = (key: Kpi['key'], k: Partial<Kpi> & Pick<Kpi, 'label' | 'unit'>): Kpi => ({ key, value: null, previous: null, change: null, target: null, status: 'none', sparkline: spark(null), report: null, ...k })

const DASHBOARD: KpiDashboard = {
  period: { key: LAST_MONTH, label: 'Last month', from: `${LAST_MONTH}-01`, to: `${LAST_MONTH}-28` },
  kpis: [
    kpi('cost_per_km', { label: 'Cost per km', unit: 'cents_per_km', value: 3612, previous: 3500, change: 112, target: 3500, status: 'amber', sparkline: spark(3500), report: 'cost' }),
    kpi('fuel_l_per_100km', { label: 'Fuel use', unit: 'tenths_l_per_100km', value: 284, previous: 300, change: -16, target: 300, status: 'green', sparkline: spark(290), report: 'fuel' }),
    kpi('utilisation_pct', { label: 'Utilisation', unit: 'pct', value: 52, previous: 60, change: -8, target: 75, status: 'red', sparkline: spark(55), report: 'utilisation' }),
    kpi('availability_pct', { label: 'Availability', unit: 'pct', value: 93, target: 90, status: 'green', report: 'utilisation' }),
    kpi('on_time_pct', { label: 'On time', unit: 'pct', value: 88, target: 90, status: 'amber', report: 'trips' }),
    kpi('pm_compliance_pct', { label: 'PM compliance', unit: 'pct', value: 97, target: 95, status: 'green', report: 'compliance' }),
    kpi('incidents_per_100k_km', { label: 'Incidents per 100,000 km', unit: 'tenths_per_100k_km', value: 42, target: 5, status: 'green', report: 'safety' }),
    kpi('vehicles_at_risk', { label: 'Vehicles at risk', unit: 'count', value: 3, target: 5, status: 'green' }),
    kpi('appeals', { label: 'Score appeals', unit: 'count', value: 4 }),
    kpi('feedback', { label: 'Driver feedback', unit: 'count', value: 11 }),
  ],
}

const trend = (key: string, group: string | null): KpiTrend => ({
  kpi: key as KpiTrend['kpi'],
  label: DASHBOARD.kpis.find((k) => k.key === key)!.label,
  unit: DASHBOARD.kpis.find((k) => k.key === key)!.unit,
  period: { key: LAST_MONTH, label: 'Last month' },
  series: Array.from({ length: 12 }, (_, i) => ({ month: shiftMonth(LAST_MONTH, i - 11), value: 3000 + i * 10, last_year: 3200 })),
  group: group as KpiTrend['group'],
  breakdown: group === 'vehicle' ? [{ name: 'AA 3-10001', value: 3700 }] : [{ name: 'Bole', value: 3612 }, { name: 'Adama', value: 3300 }],
})

function serve() {
  const asked: URL[] = []
  server.use(
    http.get('/api/v1/depots', () => envelope([{ id: BOLE, name: 'Bole', code: 'BOL' }, { id: '22222222-2222-4222-8222-222222222222', name: 'Adama', code: 'ADM' }])),
    http.get('/api/v1/analytics/kpis', ({ request }) => {
      asked.push(new URL(request.url))
      return envelope(DASHBOARD)
    }),
    http.get('/api/v1/analytics/kpis/:kpi/trend', ({ request, params }) => {
      const url = new URL(request.url)
      asked.push(url)
      return envelope(trend(String(params.kpi), url.searchParams.get('group')))
    }),
  )
  return asked
}

async function open(path = '/analytics/kpis') {
  signedInAs(manager)
  renderApp(path)
  return screen.findByRole('list', { name: 'KPIs' })
}

describe('S-39 KPIs (FMS-160)', () => {
  it('each KPI with its value, change, target and status (an icon and a label), and a link to its report', async () => {
    const asked = serve()
    const tiles = await open()
    expect(within(tiles).getAllByRole('listitem')).toHaveLength(10)
    const cost = within(tiles).getByRole('heading', { name: 'Cost per km' }).closest('li')!
    expect(within(cost).getByText('ETB 36.12')).toBeInTheDocument()
    expect(within(cost).getByText('Near target')).toBeInTheDocument()
    expect(within(cost).getByText('Target ETB 35.00')).toBeInTheDocument()
    // Cost went up: worse.
    expect(within(cost).getByText(/\+ETB 1\.12/).parentElement).toHaveTextContent('vs the period before, worse')
    expect(within(cost).getByRole('img', { name: /Cost per km, last 12 months/ })).toBeInTheDocument()
    expect(within(cost).getByRole('link', { name: 'Open the report behind Cost per km' })).toHaveAttribute('href', '/reports?report=cost')

    const fuel = within(tiles).getByRole('heading', { name: 'Fuel use' }).closest('li')!
    expect(within(fuel).getByText('On target')).toBeInTheDocument()
    expect(within(fuel).getByText(/−1\.6/).parentElement).toHaveTextContent('better')
    const util = within(tiles).getByRole('heading', { name: 'Utilisation' }).closest('li')!
    expect(within(util).getByText('Off target')).toBeInTheDocument()
    expect(within(tiles).getByRole('heading', { name: 'Score appeals' }).closest('li')).toHaveTextContent('No target')
    expect(within(tiles).getByRole('link', { name: 'Open score appeals' })).toHaveAttribute('href', '/appeals')

    expect(asked[0].searchParams.get('month')).toBe(LAST_MONTH)
  })

  it('the period and depots narrow every KPI, and the report links keep them', async () => {
    const asked = serve()
    const user = userEvent.setup()
    const tiles = await open()
    await user.click(await screen.findByRole('button', { name: /^Depots/ }))
    await user.click(within(await screen.findByRole('list', { name: 'Depots' })).getByLabelText('Bole'))
    await waitFor(() => expect(asked.filter((u) => u.pathname === '/api/v1/analytics/kpis').at(-1)!.searchParams.get('depot_ids')).toBe(BOLE))
    expect(within(tiles).getByRole('link', { name: 'Open the report behind Cost per km' })).toHaveAttribute('href', `/reports?report=cost&depot=${BOLE}`)

    await user.click(screen.getByRole('button', { name: /^Period/ }))
    await user.click(await screen.findByRole('option', { name: 'Year' }))
    await waitFor(() => expect(asked.filter((u) => u.pathname === '/api/v1/analytics/kpis').at(-1)!.searchParams.get('year')).toMatch(/^\d{4}$/))
  })

  it('a KPI’s trend over 12 or 24 months beside last year, drilled down from depots to a depot’s vehicles', async () => {
    const asked = serve()
    const user = userEvent.setup()
    await open()
    const panel = await screen.findByRole('region', { name: 'Cost per km, month by month' })
    expect(await within(panel).findByRole('img', { name: /Cost per km by month, this period and a year before/ })).toBeInTheDocument()
    const trends = () => asked.filter((u) => u.pathname.endsWith('/trend'))
    expect(trends()[0].searchParams.get('months')).toBe('12')
    expect(trends()[0].searchParams.get('group')).toBe('depot')

    await user.click(within(panel).getByRole('button', { name: /^Months/ }))
    await user.click(await screen.findByRole('option', { name: '24 months' }))
    await waitFor(() => expect(trends().at(-1)!.searchParams.get('months')).toBe('24'))

    // Picking a depot narrows to it and shows its vehicles.
    await user.click(await within(panel).findByRole('button', { name: 'Bole' }))
    await waitFor(() => expect([trends().at(-1)!.searchParams.get('group'), trends().at(-1)!.searchParams.get('depot_ids')]).toEqual(['vehicle', BOLE]))
    expect(await within(panel).findByText('AA 3-10001')).toBeInTheDocument()

    const fuel = screen.getByRole('heading', { name: 'Fuel use' }).closest('li')!
    await user.click(within(fuel).getByRole('button', { name: 'Show trend' }))
    expect(await screen.findByRole('region', { name: 'Fuel use, month by month' })).toBeInTheDocument()
    expect(screen.getByTestId('location')).toHaveTextContent('kpi=fuel_l_per_100km')
  })

  it('values, changes and targets read in their units', () => {
    expect(formatKpi('cents_per_km', 3612)).toBe('ETB 36.12')
    expect(formatKpi('tenths_l_per_100km', 284)).toBe('28.4')
    expect(formatKpi('pct', 52)).toBe('52%')
    expect(formatKpi('count', null)).toBe('—')
    expect(formatChange('pct', -8)).toBe('−8 pts')
    expect(formatChange('cents_per_km', 112)).toBe('+ETB 1.12')
    expect(formatTarget({ unit: 'tenths_per_100k_km', target: 5 })).toBe('5')
  })
})

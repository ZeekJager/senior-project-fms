import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { currentMonth, shiftMonth } from '@/lib/month'
import { currentUser, envelope, renderApp, signedInAs } from '@/test/auth'
import { server } from '@/test/msw/server'
import type { Report, ReportKind } from './api'
import { displayValue } from './format'

// FMS-91: S-28 Reports. The API is faked; a download is caught where the browser would follow its link.

const DEPOT = '11111111-1111-4111-8111-111111111111'
const manager = currentUser(['fleet_manager'], ['analytics:read', 'depot:read', 'vehicle:read'])
const LAST_MONTH = shiftMonth(currentMonth(), -1)

const FUEL: Report = {
  report: 'fuel',
  title: 'Fuel report',
  month: LAST_MONTH,
  depot: null,
  columns: [
    { key: 'registration_number', label: 'Vehicle', kind: 'text' },
    { key: 'depot', label: 'Depot', kind: 'text' },
    { key: 'fuel_ml', label: 'Fuel (L)', kind: 'litres' },
    { key: 'fuel_cost_cents', label: 'Cost (ETB)', kind: 'etb' },
    { key: 'consumption_ml_per_km', label: 'Used (L/100 km)', kind: 'l_per_100km' },
  ],
  rows: [
    { registration_number: 'AA 3-10001', depot: 'Bole', fuel_ml: 1_234_500, fuel_cost_cents: 30_862_500, consumption_ml_per_km: 318 },
    { registration_number: 'AA 3-10002', depot: 'Bole', fuel_ml: 10_000, fuel_cost_cents: 250_000, consumption_ml_per_km: null },
  ],
  totals: { registration_number: 'Total', depot: '2 vehicles', fuel_ml: 1_244_500, fuel_cost_cents: 31_112_500, consumption_ml_per_km: 320 },
  generated_at: new Date().toISOString(),
}

const TRIPS: Report = {
  ...FUEL,
  report: 'trips',
  title: 'Trip history',
  columns: [
    { key: 'scheduled_start', label: 'Scheduled', kind: 'datetime' },
    { key: 'route', label: 'Route', kind: 'text' },
    { key: 'on_time', label: 'On time', kind: 'text' },
  ],
  rows: [{ scheduled_start: '2026-10-03T05:15:00Z', route: 'Bole – Adama', on_time: 'Yes' }],
  totals: { scheduled_start: null, route: 'Total: 1 trip', on_time: '100%' },
}

/** The fake API: each report as asked; every request recorded. */
function serve(reports: Partial<Record<ReportKind, Report>> = { fuel: FUEL, trips: TRIPS }) {
  const asked: URL[] = []
  server.use(
    http.get('/api/v1/depots', () => envelope([{ id: DEPOT, name: 'Bole', code: 'BOL' }, { id: '22222222-2222-4222-8222-222222222222', name: 'Adama', code: 'ADM' }])),
    http.get('/api/v1/reports/:report', ({ request, params }) => {
      const url = new URL(request.url)
      asked.push(url)
      const report = reports[params.report as ReportKind]
      return HttpResponse.json({ data: report ?? { ...FUEL, report: params.report, rows: [], totals: null }, meta: { data_freshness: { source: 'replica', lag_seconds: 12, as_of: new Date().toISOString() } } })
    }),
  )
  return asked
}

/** The download links followed: where they point, and that they download. */
const followed: { url: URL; download: boolean }[] = []
beforeEach(() => {
  followed.length = 0
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    followed.push({ url: new URL(this.href), download: this.hasAttribute('download') })
  })
})
afterEach(() => vi.restoreAllMocks())

async function open(path = '/reports') {
  signedInAs(manager)
  renderApp(path)
  return screen.findByRole('table', { name: /report/ })
}

describe('S-28 Reports (FMS-91)', () => {
  it('opens on last month’s fuel report: the rows in litres and birr, a totals row, and how current the data is', async () => {
    const asked = serve()
    const table = await open()
    await within(table).findByText('AA 3-10001')
    expect(screen.getByRole('heading', { name: /^Fuel report, / })).toBeInTheDocument()
    const rows = within(table).getAllByRole('row')
    expect(rows[1]).toHaveTextContent('AA 3-10001Bole1,234.5308,625.0031.8')
    // Not judged: a dash, not a zero.
    expect(rows[2]).toHaveTextContent('AA 3-10002Bole10.02,500.00—')
    expect(rows.at(-1)).toHaveTextContent('Total2 vehicles1,244.5311,125.0032.0')
    expect(screen.getByText('2 rows · All your depots')).toBeInTheDocument()
    expect(screen.getByText(/^Data as of/)).toHaveTextContent(/Data as of \d\d:\d\d · 12 s behind live/)
    expect(asked[0].pathname).toBe('/api/v1/reports/fuel')
    expect(asked[0].searchParams.get('month')).toBe(LAST_MONTH)
  })

  it('another report, month or depot is read and kept in the address', async () => {
    const asked = serve()
    const user = userEvent.setup()
    await open()
    await user.click(screen.getByRole('button', { name: 'Trip history' }))
    expect(await screen.findByRole('heading', { name: /^Trip history, / })).toBeInTheDocument()
    expect(await screen.findByText('Bole – Adama')).toBeInTheDocument()
    expect(screen.getByTestId('location')).toHaveTextContent('/reports?report=trips')

    await user.click(screen.getByRole('button', { name: 'Previous month' }))
    await waitFor(() => expect(asked.at(-1)!.searchParams.get('month')).toBe(shiftMonth(LAST_MONTH, -1)))
    expect(screen.getByRole('button', { name: 'Next month' })).toBeEnabled()
    expect(screen.getByTestId('location')).toHaveTextContent(`month=${shiftMonth(LAST_MONTH, -1)}`)
  })

  it('downloads the CSV and PDF the server builds by following a link, once the session is checked', async () => {
    serve()
    let checks = 0
    server.use(
      http.get('/api/v1/auth/me', () => {
        checks += 1
        return envelope({ id: 'u-1' })
      }),
    )
    const user = userEvent.setup()
    await open(`/reports?report=drivers&depot=${DEPOT}`)
    await user.click(screen.getByRole('button', { name: 'Download CSV' }))
    expect(await screen.findByText('Driver performance report downloading')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Download PDF' }))
    await waitFor(() => expect(followed).toHaveLength(2))
    expect(checks).toBe(2)
    expect(followed.map(({ url, download }) => [url.pathname, url.searchParams.get('format'), url.searchParams.get('depot_id'), url.searchParams.get('month'), download])).toEqual([
      ['/api/v1/reports/drivers', 'csv', DEPOT, LAST_MONTH, true],
      ['/api/v1/reports/drivers', 'pdf', DEPOT, LAST_MONTH, true],
    ])
  })

  it('a session that cannot be checked downloads nothing and says so; an empty month says what there was none of', async () => {
    serve({ fuel: FUEL })
    server.use(http.get('/api/v1/auth/me', () => HttpResponse.error()))
    const user = userEvent.setup()
    await open()
    await user.click(screen.getByRole('button', { name: 'Download PDF' }))
    expect(await screen.findByText('The report could not be downloaded')).toBeInTheDocument()
    expect(followed).toEqual([])

    await user.click(screen.getByRole('button', { name: 'Maintenance' }))
    expect(await screen.findByText(/^No repair was completed or left open in /)).toBeInTheDocument()
  })

  it('values read as in a spreadsheet: separators, fixed decimals, Addis Ababa times', () => {
    expect(displayValue('litres', 1_234_500)).toBe('1,234.5')
    expect(displayValue('etb', 5)).toBe('0.05')
    expect(displayValue('hours', 95)).toBe('1.6')
    expect(displayValue('count', 12_000)).toBe('12,000')
    expect(displayValue('datetime', '2026-10-03T05:15:00Z')).toBe('3 Oct, 08:15')
    expect(displayValue('km', null)).toBe('—')
  })
})

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { currentMonth, shiftMonth } from '@/lib/month'
import { currentUser, envelope, renderApp, signedInAs } from '@/test/auth'
import { server } from '@/test/msw/server'
import type { Report, ReportExport, ReportKind, Schedule, ScheduleRun } from './api'
import { readState } from './api'
import { displayValue } from './format'
import { rangeProblem } from './ReportControls'
import { cadence } from './SchedulesDrawer'

// FMS-91, FMS-160: S-28 Reports. The API is faked; a download is caught where the browser would follow its link.

const DEPOT = '11111111-1111-4111-8111-111111111111'
const ADAMA = '22222222-2222-4222-8222-222222222222'
const manager = currentUser(['fleet_manager'], ['analytics:read', 'depot:read', 'vehicle:read', 'driver:read', 'route:read'])
const LAST_MONTH = shiftMonth(currentMonth(), -1)
const NO_NAMES = { depots: [], vehicle: null, driver: null, route: null }

const FUEL: Report = {
  report: 'fuel',
  title: 'Fuel report',
  month: LAST_MONTH,
  period: { from: '', to: '', kind: 'month', key: LAST_MONTH, label: 'Last month', first_day: `${LAST_MONTH}-01`, last_day: `${LAST_MONTH}-28` },
  filter_names: NO_NAMES,
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

const COMPLIANCE: Report = {
  ...FUEL,
  report: 'compliance',
  title: 'Maintenance compliance',
  columns: [
    { key: 'registration_number', label: 'Vehicle', kind: 'text' },
    { key: 'pm_compliance_pct', label: 'PM compliance (%)', kind: 'pct' },
  ],
  rows: [{ registration_number: 'AA 3-10001', pm_compliance_pct: 50 }],
  totals: { registration_number: 'Total', pm_compliance_pct: 50 },
  sections: [
    {
      title: 'Repair cost by system',
      columns: [
        { key: 'name', label: 'System (failed component)', kind: 'text' },
        { key: 'cost_cents', label: 'Cost (ETB)', kind: 'etb' },
      ],
      rows: [{ name: 'brakes', cost_cents: 120_000 }],
    },
  ],
}

/** The fake API: each report as asked; every request recorded. */
function serve(reports: Partial<Record<ReportKind, Report>> = { fuel: FUEL, trips: TRIPS }) {
  const asked: URL[] = []
  server.use(
    http.get('/api/v1/depots', () => envelope([{ id: DEPOT, name: 'Bole', code: 'BOL' }, { id: ADAMA, name: 'Adama', code: 'ADM' }])),
    http.get('/api/v1/reports/filters', () => envelope([])),
    http.get('/api/v1/reports/schedules', () => envelope([])),
    http.get('/api/v1/reports/:report', ({ request, params }) => {
      const url = new URL(request.url)
      asked.push(url)
      const report = reports[params.report as ReportKind]
      const names = url.searchParams.get('depot_ids') ? { ...NO_NAMES, depots: url.searchParams.get('depot_ids')!.split(',').map((id) => (id === DEPOT ? 'Bole' : 'Adama')) } : NO_NAMES
      return HttpResponse.json({
        data: { ...(report ?? { ...FUEL, report: params.report, rows: [], totals: null }), filter_names: names },
        meta: { data_freshness: { source: 'replica', lag_seconds: 12, as_of: new Date().toISOString() } },
      })
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

  it('another report or month is read and kept in the address; an FMS-91 depot link still opens its depot', async () => {
    const asked = serve()
    const user = userEvent.setup()
    await open()
    await user.click(screen.getByRole('button', { name: 'Trip history' }))
    expect(await screen.findByRole('heading', { name: /^Trip history, / })).toBeInTheDocument()
    expect(await screen.findByText('Bole – Adama')).toBeInTheDocument()
    expect(screen.getByTestId('location')).toHaveTextContent('/reports?report=trips')

    await user.click(screen.getByRole('button', { name: 'Previous month' }))
    await waitFor(() => expect(asked.at(-1)!.searchParams.get('month')).toBe(shiftMonth(LAST_MONTH, -1)))
    expect(screen.getByTestId('location')).toHaveTextContent(`month=${shiftMonth(LAST_MONTH, -1)}`)

    expect(readState(new URLSearchParams(`depot=${DEPOT}&month=${LAST_MONTH}`)).depotIds).toEqual([DEPOT])
  })

  it('downloads the CSV, Excel and PDF the server builds by following a link, once the session is checked', async () => {
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
    await user.click(screen.getByRole('button', { name: 'Download Excel' }))
    await user.click(screen.getByRole('button', { name: 'Download PDF' }))
    await waitFor(() => expect(followed).toHaveLength(3))
    expect(checks).toBe(3)
    expect(followed.map(({ url, download }) => [url.pathname, url.searchParams.get('format'), url.searchParams.get('depot_ids'), url.searchParams.get('month'), download])).toEqual([
      ['/api/v1/reports/drivers', 'csv', DEPOT, LAST_MONTH, true],
      ['/api/v1/reports/drivers', 'xlsx', DEPOT, LAST_MONTH, true],
      ['/api/v1/reports/drivers', 'pdf', DEPOT, LAST_MONTH, true],
    ])
  })

  it('a session that cannot be checked downloads nothing and says so; an empty period says what there was none of', async () => {
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
    expect(displayValue('rate', 667)).toBe('66.7')
    expect(displayValue('datetime', '2026-10-03T05:15:00Z')).toBe('3 Oct, 08:15')
    expect(displayValue('km', null)).toBe('—')
  })
})

describe('periods, filters and saved filters (FMS-160)', () => {
  it('a quarter, a year or a custom range of up to 366 days', async () => {
    const asked = serve()
    const user = userEvent.setup()
    await open()
    await user.click(screen.getByRole('button', { name: /^Period/ }))
    await user.click(await screen.findByRole('option', { name: 'Quarter' }))
    await waitFor(() => expect(asked.at(-1)!.searchParams.get('quarter')).toMatch(/^\d{4}-Q[1-4]$/))
    expect(asked.at(-1)!.searchParams.get('month')).toBeNull()
    expect(screen.getByTestId('location')).toHaveTextContent('period=quarter')

    expect(rangeProblem('2025-01-01', '2026-01-02')).toBe('A range is at most 366 days.')
    expect(rangeProblem('2025-02-01', '2025-01-01')).toBe('The last day is before the first.')
    expect(rangeProblem('2025-01-01', '2026-01-01')).toBeNull()

    await user.click(screen.getByRole('button', { name: /^Period/ }))
    await user.click(await screen.findByRole('option', { name: 'Custom range' }))
    const first = await screen.findByLabelText('First day')
    const last = screen.getByLabelText('Last day')
    await user.clear(first)
    await user.type(first, '2025-01-01')
    await user.clear(last)
    await user.type(last, '2026-03-01')
    expect(screen.getByText('A range is at most 366 days.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
    await user.clear(last)
    await user.type(last, '2025-03-31')
    await user.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect([asked.at(-1)!.searchParams.get('from'), asked.at(-1)!.searchParams.get('to')]).toEqual(['2025-01-01', '2025-03-31']))
  })

  it('several depots at once, shown as removable chips named by the server', async () => {
    const asked = serve()
    const user = userEvent.setup()
    await open()
    await user.click(await screen.findByRole('button', { name: /^Depots/ }))
    const list = await screen.findByRole('list', { name: 'Depots' })
    await user.click(within(list).getByLabelText('Bole'))
    await user.click(within(list).getByLabelText('Adama'))
    await waitFor(() => expect(asked.at(-1)!.searchParams.get('depot_ids')).toBe(`${DEPOT},${ADAMA}`))
    const chips = await screen.findByRole('list', { name: 'Filters in force' })
    expect(within(chips).getByText('Bole, Adama')).toBeInTheDocument()
    expect(screen.getByText('2 rows · Bole, Adama')).toBeInTheDocument()
    await user.click(within(chips).getByRole('button', { name: 'Remove Bole, Adama' }))
    // Back to every depot (the report is cached, so the address says it).
    await waitFor(() => expect(screen.getByTestId('location')).not.toHaveTextContent('depots='))
    expect(screen.getByText('2 rows · All your depots')).toBeInTheDocument()
  })

  it('saves the period and filters by name, and brings saved ones back; a name used twice is refused', async () => {
    const asked = serve()
    const saved: { name: string; filters: Record<string, unknown> }[] = []
    server.use(
      http.get('/api/v1/reports/filters', () => envelope([{ id: '33333333-3333-4333-8333-333333333333', name: 'Bole Q1', filters: { quarter: '2026-Q1', depot_ids: DEPOT }, created_at: '' }])),
      http.post('/api/v1/reports/filters', async ({ request }) => {
        const body = (await request.json()) as { name: string; filters: Record<string, unknown> }
        if (body.name === 'Taken') return HttpResponse.json({ error: { code: 'CONFLICT_DUPLICATE', message: 'Taken', details: [] }, meta: {} }, { status: 409 })
        saved.push(body)
        return HttpResponse.json({ data: { id: 'x', ...body, created_at: '' }, meta: {} }, { status: 201 })
      }),
    )
    const user = userEvent.setup()
    await open(`/reports?depot=${DEPOT}&type=truck`)
    await user.click(screen.getByRole('button', { name: /^Saved filters/ }))
    await user.type(screen.getByLabelText('Name'), 'Bole trucks')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(saved).toEqual([{ name: 'Bole trucks', filters: { month: LAST_MONTH, depot_ids: [DEPOT], vehicle_type: 'truck' } }]))
    await user.type(screen.getByLabelText('Name'), 'Taken')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('You already have filters by that name.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Bole Q1' }))
    await waitFor(() => expect([asked.at(-1)!.searchParams.get('quarter'), asked.at(-1)!.searchParams.get('depot_ids'), asked.at(-1)!.searchParams.get('vehicle_type')]).toEqual(['2026-Q1', DEPOT, null]))
  })

  it('compliance shows its cost by system below the table', async () => {
    serve({ compliance: COMPLIANCE })
    await open('/reports?report=compliance')
    const section = await screen.findByRole('region', { name: 'Repair cost by system' })
    expect(within(section).getByText('brakes')).toBeInTheDocument()
    expect(within(section).getByText('1,200.00')).toBeInTheDocument()
  })
})

describe('background exports (FMS-160)', () => {
  it('over 20,000 rows the file is made in the background, then downloaded from its link', async () => {
    const big: Report = { ...FUEL, rows: Array.from({ length: 20_001 }, (_, i) => ({ ...FUEL.rows[0], registration_number: `AA ${i}` })) }
    serve({ fuel: big })
    const queued: ReportExport = { id: '44444444-4444-4444-8444-444444444444', report: 'fuel', format: 'xlsx', status: 'queued', rows: null, size_bytes: null, error: null, created_at: '', expires_at: null, url: null }
    let polls = 0
    const askedFiles: URL[] = []
    server.use(
      http.get('/api/v1/reports/fuel', ({ request }) => {
        const url = new URL(request.url)
        if (url.searchParams.get('format')) {
          askedFiles.push(url)
          return HttpResponse.json({ data: queued, meta: {} }, { status: 202 })
        }
        return HttpResponse.json({ data: big, meta: {} })
      }),
      http.get('/api/v1/reports/exports/:id', () => {
        polls += 1
        return envelope(polls < 2 ? queued : { ...queued, status: 'ready', rows: 20_001, expires_at: new Date(Date.now() + 86_400_000).toISOString(), url: `/api/v1/report-files/${queued.id}/content?expires=1&signature=ab` })
      }),
    )
    const user = userEvent.setup()
    await open()
    expect(await screen.findByText(/downloads are made in the background/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Download Excel' }))
    expect(await screen.findByText(/being made in the background/)).toBeInTheDocument()
    expect(askedFiles[0].searchParams.get('format')).toBe('xlsx')
    expect(followed).toEqual([])
    await user.click(await screen.findByRole('button', { name: 'Download' }, { timeout: 8000 }))
    expect(followed.map((f) => f.url.pathname)).toEqual([`/api/v1/report-files/${queued.id}/content`])
  }, 15_000)
})

describe('report schedules (FMS-160)', () => {
  const RUN: ScheduleRun = {
    id: '55555555-5555-4555-8555-555555555555',
    due_at: '2026-11-23T04:00:00Z',
    period: { from: '2026-11-15T21:00:00Z', to: '2026-11-22T21:00:00Z' },
    status: 'retrying',
    attempts: 1,
    next_attempt_at: '2026-11-23T04:15:00Z',
    rows: 12,
    size_bytes: 2048,
    error: null,
    recipients: [
      { user: { id: 'a', name: 'Almaz Bekele' }, outcome: 'skipped', reason: 'no_access', delivered: null },
      { user: { id: 'b', name: 'Dawit Haile' }, outcome: 'failed', reason: '451 Try again later', delivered: null },
      { user: { id: 'c', name: 'Hanna Tesfaye' }, outcome: 'sent', reason: null, delivered: 'attached' },
    ],
    started_at: '',
    finished_at: null,
  }

  it('schedules the report on screen for chosen people, and shows each run with who got it', async () => {
    serve()
    const created: unknown[] = []
    const schedule: Schedule = {
      id: '66666666-6666-4666-8666-666666666666',
      name: 'Fuel report',
      report: 'fuel',
      filters: {},
      format: 'xlsx',
      frequency: 'weekly',
      day: 1,
      hour: 7,
      recipients: [{ id: 'c', name: 'Hanna Tesfaye' }],
      owner: { id: 'o', name: 'Me' },
      next_run_at: '2026-11-30T04:00:00Z',
      version: 1,
      created_at: '',
    }
    let list: Schedule[] = []
    server.use(
      http.get('/api/v1/reports/schedules', () => envelope(list)),
      http.get('/api/v1/reports/recipients', () => envelope([{ id: 'c', name: 'Hanna Tesfaye', roles: ['finance_clerk'] }])),
      http.post('/api/v1/reports/schedules', async ({ request }) => {
        created.push(await request.json())
        list = [schedule]
        return HttpResponse.json({ data: schedule, meta: {} }, { status: 201 })
      }),
      http.get('/api/v1/reports/schedules/:id/runs', () => envelope([RUN])),
    )
    const user = userEvent.setup()
    await open(`/reports?depot=${DEPOT}`)
    await user.click(screen.getByRole('button', { name: 'Schedules' }))
    const drawer = await screen.findByRole('dialog', { name: 'Scheduled reports' })
    expect(await within(drawer).findByText('No reports are scheduled')).toBeInTheDocument()
    await user.click(within(drawer).getByRole('button', { name: 'New schedule' }))

    const form = await screen.findByRole('dialog', { name: 'New schedule' })
    await user.click(within(form).getByRole('button', { name: 'Schedule report' }))
    expect(await within(form).findByText('Choose at least one person to send it to.')).toBeInTheDocument()
    await user.type(within(form).getByRole('combobox', { name: 'Send to' }), 'Han')
    await user.click(await within(form).findByRole('option', { name: /Hanna Tesfaye/ }))
    expect(within(within(form).getByRole('list', { name: 'Recipients' })).getByText('Hanna Tesfaye')).toBeInTheDocument()
    await user.click(within(form).getByRole('button', { name: 'Schedule report' }))
    await waitFor(() => expect(created).toEqual([{ name: 'Fuel report', report: 'fuel', format: 'xlsx', frequency: 'weekly', day: 1, hour: 7, recipients: ['c'], filters: { depot_ids: [DEPOT] } }]))

    const back = await screen.findByRole('dialog', { name: 'Scheduled reports' })
    expect(await within(back).findByText(/Every Monday at 07:00/)).toBeInTheDocument()
    await user.click(within(back).getByRole('button', { name: 'History of Fuel report' }))
    const runs = await screen.findByRole('list', { name: 'Runs' })
    expect(within(runs).getByText('Retrying')).toBeInTheDocument()
    expect(within(runs).getByText(/skipped: No longer has access to reports/)).toBeInTheDocument()
    expect(within(runs).getByText(/not sent: 451 Try again later/)).toBeInTheDocument()
    expect(within(runs).getByText(/sent, attached/)).toBeInTheDocument()
    expect(within(runs).getByText(/Trying again/)).toBeInTheDocument()
  })

  it('reads its cadence in Addis Ababa time', () => {
    expect(cadence({ frequency: 'daily', day: null, hour: 6 })).toBe('Daily at 06:00')
    expect(cadence({ frequency: 'weekly', day: 3, hour: 7 })).toBe('Every Wednesday at 07:00')
    expect(cadence({ frequency: 'monthly', day: 1, hour: 18 })).toBe('Monthly on the 1st at 18:00')
  })
})

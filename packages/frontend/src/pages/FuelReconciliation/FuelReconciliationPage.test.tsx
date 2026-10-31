import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { currentUser, renderApp, signedInAs } from '@/test/auth'
import { server } from '@/test/msw/server'
import { currentMonth, shiftMonth, type DataFreshness, type FuelAnomaly, type ReconciliationRow } from './api'

const downloads: { filename: string; csv: string }[] = []
vi.mock('@/lib/csv', async (original) => ({
  ...(await original<typeof import('@/lib/csv')>()),
  downloadCsv: (filename: string, csv: string) => downloads.push({ filename, csv }),
}))

const DEPOT = '11111111-1111-4111-8111-111111111111'
const clerk = currentUser(['finance_clerk'], ['analytics:read', 'fuel:read', 'fuel:write', 'fuel-anomaly:read', 'fuel-anomaly:write'])
const depotAdmin = currentUser(['depot_admin'], ['vehicle:read', 'depot:read', 'fuel:read', 'fuel-anomaly:read'])

let seq = 0
function vehicleRow(variancePct: number | null, overrides: Partial<ReconciliationRow> = {}): ReconciliationRow {
  seq += 1
  const expected = variancePct === null ? null : 320_000
  const actual = variancePct === null ? 50_000 : 320_000 + variancePct * 3_200
  return {
    vehicle_id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    registration_number: `AA 3-${30000 + seq}`,
    depot_id: DEPOT,
    depot_name: 'Bole',
    fuel_type: 'diesel',
    fuel_efficiency_ml_per_km: 320,
    distance_km: variancePct === null ? 40 : 1000,
    trips: 2,
    fuel_logs: 3,
    expected_ml: expected,
    actual_ml: actual,
    variance_ml: expected === null ? null : actual - expected,
    variance_pct: variancePct,
    total_cost_cents: actual / 10,
    status: variancePct === null ? 'not_judged' : variancePct > 20 ? 'above' : variancePct < -20 ? 'below' : 'within',
    reason: variancePct === null ? 'too_little_distance' : null,
    anomaly_id: null,
    ...overrides,
  }
}

function anomaly(overrides: Partial<FuelAnomaly> = {}): FuelAnomaly {
  return {
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    vehicle_id: 'v-1',
    registration_number: 'AA 3-30001',
    depot_id: DEPOT,
    depot_name: 'Bole',
    fuel_log_id: null,
    anomaly_type: 'consumption_above_expected',
    severity: 'medium',
    status: 'open',
    period_from: '2026-08-31T21:00:00.000Z',
    period_to: '2026-09-30T21:00:00.000Z',
    distance_km: 1000,
    expected_ml: 320_000,
    actual_ml: 400_000,
    deviation_pct: 25,
    detected_at: '2026-10-01T01:30:00.000Z',
    reviewed_by: null,
    reviewed_by_name: null,
    reviewed_at: null,
    notes: null,
    ...overrides,
  }
}

const PRIMARY: DataFreshness = { source: 'primary', lag_seconds: 0, as_of: '2026-10-29T08:00:00.000Z' }

/** A fake GET /fuel-reconciliation (worst first, paged), /fuel-anomalies (status filter), one anomaly and its close. */
function serve(rows: ReconciliationRow[], anomalies: FuelAnomaly[] = [], freshness: DataFreshness = PRIMARY) {
  const reconciliations: URLSearchParams[] = []
  const closes: { id: string; body: Record<string, unknown> }[] = []
  const store = new Map(anomalies.map((a) => [a.id, a]))
  server.use(
    http.get('/api/v1/fuel-reconciliation', ({ request }) => {
      const q = new URL(request.url).searchParams
      reconciliations.push(q)
      const sorted = [...rows].sort((a, b) => (b.variance_pct === null ? -1 : Math.abs(b.variance_pct)) - (a.variance_pct === null ? -1 : Math.abs(a.variance_pct)))
      const size = Number(q.get('page_size'))
      const page = Number(q.get('page'))
      const judged = rows.filter((r) => r.expected_ml !== null)
      const expected = judged.reduce((s, r) => s + r.expected_ml!, 0)
      const actual = judged.reduce((s, r) => s + r.actual_ml, 0)
      return HttpResponse.json({
        data: sorted.slice((page - 1) * size, page * size),
        meta: {
          page,
          page_size: size,
          total_items: rows.length,
          total_pages: Math.ceil(rows.length / size),
          from: '2026-08-31T21:00:00.000Z',
          to: '2026-09-30T21:00:00.000Z',
          threshold_pct: 20,
          summary: {
            vehicles: rows.length,
            judged: judged.length,
            above: rows.filter((r) => r.status === 'above').length,
            below: rows.filter((r) => r.status === 'below').length,
            expected_ml: expected,
            actual_ml: actual,
            variance_pct: expected ? Math.round(((actual - expected) * 100) / expected) : null,
            total_cost_cents: rows.reduce((s, r) => s + r.total_cost_cents, 0),
          },
          data_freshness: freshness,
          request_id: 'r-1',
        },
      })
    }),
    http.get('/api/v1/fuel-anomalies', ({ request }) => {
      const q = new URL(request.url).searchParams
      const statuses = q.get('status')?.split(',')
      const list = [...store.values()].filter((a) => !statuses || statuses.includes(a.status))
      const size = Number(q.get('page_size') ?? 25)
      return HttpResponse.json({ data: list.slice(0, size), meta: { page: 1, page_size: size, total_items: list.length, total_pages: 1, request_id: 'r-1' } })
    }),
    http.get('/api/v1/fuel-anomalies/:id', ({ params }) => {
      const found = store.get(String(params.id))
      return found ? HttpResponse.json({ data: found, meta: { request_id: 'r-1' } }) : HttpResponse.json({ error: { code: 'NOT_FOUND', message: 'Fuel anomaly not found.' } }, { status: 404 })
    }),
    http.post('/api/v1/fuel-anomalies/:id/resolve', async ({ params, request }) => {
      const body = (await request.json()) as Record<string, unknown>
      closes.push({ id: String(params.id), body })
      const closed: FuelAnomaly = {
        ...store.get(String(params.id))!,
        status: body.outcome as FuelAnomaly['status'],
        reviewed_by: 'u-1',
        reviewed_by_name: 'Hanna Tesfaye',
        reviewed_at: '2026-10-29T08:05:00.000Z',
        notes: (body.notes as string | undefined) ?? null,
      }
      store.set(closed.id, closed)
      return HttpResponse.json({ data: closed, meta: { request_id: 'r-1' } })
    }),
    http.get('/api/v1/depots', () => HttpResponse.json({ data: [{ id: DEPOT, name: 'Bole', code: 'BOL', location: 'Addis Ababa' }], meta: { request_id: 'r-1' } })),
  )
  return { reconciliations, closes }
}

const table = (name: RegExp) => screen.getByRole('table', { name })
const plates = (name: RegExp) =>
  within(table(name))
    .getAllByRole('row')
    .map((r) => r.querySelector('.plate')?.textContent)
    .filter(Boolean)
const rowFor = (name: RegExp, plate: string) => within(table(name)).getByText(plate).closest('tr') as HTMLElement

beforeEach(() => {
  downloads.length = 0
})

describe('Fuel reconciliation (S-15)', () => {
  it("shows last month's vehicles furthest off first, a flag in red, a watch, OK and not judged with its reason", async () => {
    const [watch, ok, flag, under, unjudged] = [vehicleRow(15), vehicleRow(3), vehicleRow(25), vehicleRow(-30), vehicleRow(null)]
    const api = serve([watch, ok, flag, under, unjudged])
    signedInAs(clerk)
    renderApp('/fuel-reconciliation')

    await screen.findByRole('heading', { name: 'Fuel reconciliation' })
    const lastMonth = shiftMonth(currentMonth(), -1)
    await waitFor(() => expect(plates(/Fuel by vehicle/)).toEqual([under, flag, watch, ok, unjudged].map((r) => r.registration_number)))
    expect(api.reconciliations[0].get('from')).toBe(`${lastMonth}-01`)

    // The mark shows twice in the DOM: in its column, and beside the plate for phones (CSS picks one).
    const flagged = rowFor(/Fuel by vehicle/, flag.registration_number)
    expect(flagged).toHaveClass('bg-danger-soft/25')
    expect(within(flagged).getAllByText('Flag').length).toBeGreaterThan(0)
    expect(within(flagged).getByText('+25%')).toHaveClass('text-danger')
    expect(within(flagged).getByText('400.00 L')).toBeInTheDocument()
    expect(within(rowFor(/Fuel by vehicle/, under.registration_number)).getByText('−30%')).toHaveClass('text-danger')
    expect(within(rowFor(/Fuel by vehicle/, watch.registration_number)).getAllByText('Watch').length).toBeGreaterThan(0)
    expect(within(rowFor(/Fuel by vehicle/, ok.registration_number)).getAllByText('OK').length).toBeGreaterThan(0)
    const notJudged = rowFor(/Fuel by vehicle/, unjudged.registration_number)
    expect(within(notJudged).getAllByText('Not judged').length).toBeGreaterThan(0)
    expect(within(notJudged).getByText('Under 100 km of trips')).toBeInTheDocument()

    // The summary: everything logged, its cost, the judged vehicles against what their trips needed, how many flagged.
    const summary = screen.getByText('Flagged').closest('dl') as HTMLElement
    expect(within(summary).getByText('1,371.60 L')).toBeInTheDocument()
    expect(within(summary).getByText('2')).toBeInTheDocument()
    expect(within(summary).getByText(/of 4 judged/)).toBeInTheDocument()
  })

  it('a mark view shows only its vehicles; months step back and never past this one', async () => {
    const flag = vehicleRow(25)
    const api = serve([vehicleRow(2), flag, vehicleRow(12)])
    signedInAs(clerk)
    renderApp('/fuel-reconciliation')
    const user = userEvent.setup()

    await waitFor(() => expect(plates(/Fuel by vehicle/)).toHaveLength(3))
    await user.click(screen.getByRole('button', { name: /^Flag/ }))
    await waitFor(() => expect(plates(/Fuel by vehicle/)).toEqual([flag.registration_number]))

    expect(screen.getByRole('button', { name: 'Next month' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'Previous month' }))
    await waitFor(() => expect(api.reconciliations.at(-1)!.get('from')).toBe(`${shiftMonth(currentMonth(), -2)}-01`))
    await user.click(screen.getByRole('button', { name: 'Next month' }))
    await user.click(screen.getByRole('button', { name: 'Next month' }))
    expect(screen.getByRole('button', { name: 'Next month' })).toBeDisabled()
  })

  it('exports every vehicle of the month as CSV, in litres and birr', async () => {
    const rows = [vehicleRow(25), vehicleRow(3)]
    serve(rows)
    signedInAs(clerk)
    renderApp('/fuel-reconciliation')
    const user = userEvent.setup()

    await waitFor(() => expect(plates(/Fuel by vehicle/)).toHaveLength(2))
    const started = performance.now()
    await user.click(screen.getByRole('button', { name: 'Export CSV' }))
    expect(performance.now() - started).toBeLessThan(2000)

    expect(downloads).toHaveLength(1)
    expect(downloads[0].filename).toBe(`fuel-reconciliation-${shiftMonth(currentMonth(), -1)}-all.csv`)
    const lines = downloads[0].csv.split('\r\n')
    expect(lines[0]).toBe('Plate,Depot,Fuel type,Rated (ml/km),Distance (km),Trips,Fill-ups,Expected (L),Actual (L),Variance (L),Variance (%),Cost (ETB),Mark,Not judged because')
    expect(lines[1]).toBe(`${rows[0].registration_number},Bole,diesel,320,1000,2,3,320.000,400.000,80.000,25,400.00,Flag,`)
    expect(await screen.findByText('CSV downloaded')).toBeInTheDocument()
  })

  it('says how far behind live the data is when the reporting copy lags', async () => {
    serve([vehicleRow(3)], [], { source: 'replica', lag_seconds: 12, as_of: '2026-10-29T07:59:48.000Z' })
    signedInAs(clerk)
    renderApp('/fuel-reconciliation')
    expect(await screen.findByText(/12 s behind live/)).toBeInTheDocument()
    expect(screen.getByText(/Data as of 10:59:48/)).toBeInTheDocument()
  })

  it('resolving an anomaly records who resolved it', async () => {
    const found = anomaly()
    const api = serve([vehicleRow(25, { anomaly_id: found.id, registration_number: found.registration_number })], [found])
    signedInAs(clerk)
    renderApp('/fuel-reconciliation')
    const user = userEvent.setup()

    await waitFor(() => expect(screen.getByRole('button', { name: /^Anomalies/ })).toHaveTextContent('1'))
    await user.click(screen.getByRole('button', { name: /^Anomalies/ }))
    const row = await waitFor(() => rowFor(/Fuel anomalies/, found.registration_number))
    expect(within(row).getByText('Fuel 25% over expected')).toBeInTheDocument()
    await user.click(within(row).getByRole('button', { name: /Review AA 3-30001 anomaly/ }))

    const drawer = await screen.findByRole('dialog', { name: /AA 3-30001: Fuel 25% over expected/ })
    await user.type(within(drawer).getByLabelText(/Note/), 'Two receipts were for another truck.')
    await user.click(within(drawer).getByRole('button', { name: 'Mark resolved' }))

    await waitFor(() => expect(api.closes).toEqual([{ id: found.id, body: { outcome: 'resolved', notes: 'Two receipts were for another truck.' } }]))
    expect(await screen.findByText('Anomaly resolved')).toBeInTheDocument()
    expect(screen.getByText(/Recorded as Hanna Tesfaye/)).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: /^Resolved/ }))
    const closed = await waitFor(() => rowFor(/Fuel anomalies/, found.registration_number))
    expect(within(closed).getByText(/Hanna Tesfaye/)).toBeInTheDocument()
  })

  it('dismissing needs a note; nothing is sent without one', async () => {
    const found = anomaly()
    const api = serve([], [found])
    signedInAs(clerk)
    renderApp(`/fuel-reconciliation?tab=anomalies&anomaly=${found.id}`)
    const user = userEvent.setup()

    const drawer = await screen.findByRole('dialog', { name: /AA 3-30001/ })
    await user.click(within(drawer).getByRole('radio', { name: /Not a problem/ }))
    await user.click(within(drawer).getByRole('button', { name: 'Dismiss' }))
    expect(within(drawer).getByText(/Say why it is not a problem/)).toBeInTheDocument()
    expect(api.closes).toEqual([])

    await user.type(within(drawer).getByLabelText(/Note/), 'Generator test fill.')
    await user.click(within(drawer).getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(api.closes).toEqual([{ id: found.id, body: { outcome: 'dismissed', notes: 'Generator test fill.' } }]))
  })

  it('a depot admin sees the anomalies only, and cannot close one', async () => {
    const found = anomaly()
    const api = serve([vehicleRow(25)], [found])
    signedInAs(depotAdmin)
    renderApp('/fuel-reconciliation')
    const user = userEvent.setup()

    const row = await waitFor(() => rowFor(/Fuel anomalies/, found.registration_number))
    expect(screen.queryByRole('table', { name: /Fuel by vehicle/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Export CSV' })).not.toBeInTheDocument()
    expect(api.reconciliations).toEqual([])

    await user.click(row)
    const drawer = await screen.findByRole('dialog', { name: /AA 3-30001/ })
    expect(within(drawer).queryByRole('button', { name: 'Mark resolved' })).not.toBeInTheDocument()
    expect(within(drawer).getByText(/You can read them/)).toBeInTheDocument()
  })

  it('a closed anomaly shows who closed it, when, and their note', async () => {
    const found = anomaly({ status: 'dismissed', reviewed_by: 'u-2', reviewed_by_name: 'Abebe Kebede', reviewed_at: '2026-10-03T09:15:00.000Z', notes: 'Fuel for a generator test.' })
    serve([], [found])
    signedInAs(clerk)
    renderApp(`/fuel-reconciliation?tab=anomalies&anomaly=${found.id}`)

    const drawer = await screen.findByRole('dialog', { name: /AA 3-30001/ })
    expect(within(drawer).getByText('Dismissed by')).toBeInTheDocument()
    expect(within(drawer).getByText('Abebe Kebede')).toBeInTheDocument()
    expect(within(drawer).getByText('Fuel for a generator test.')).toBeInTheDocument()
    expect(within(drawer).queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument()
  })
})

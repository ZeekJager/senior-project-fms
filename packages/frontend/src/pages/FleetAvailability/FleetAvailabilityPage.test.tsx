import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { currentUser, errorEnvelope, renderApp, signedInAs } from '@/test/auth'
import { server } from '@/test/msw/server'
import type { Availability, DowntimeKpis, DowntimePeriod, VehicleAvailability } from './api'

const downloads: { filename: string; csv: string }[] = []
vi.mock('@/lib/csv', async (original) => ({
  ...(await original<typeof import('@/lib/csv')>()),
  downloadCsv: (filename: string, csv: string) => downloads.push({ filename, csv }),
}))

// S-33 Fleet availability (FMS-142), on September 2026: FMS-131's hand-computed truck (48 h in the workshop, 12 h after
// a breakdown, 24 h for an unplanned repair: 88.3%, MTBF 19,080 min, MTTR 1,080 min), a van serviced for 2 hours,
// and a car never down.

const BOLE = '11111111-1111-4111-8111-111111111111'
const ADAMA = '22222222-2222-4222-8222-222222222222'
const manager = currentUser(['fleet_manager'], ['analytics:read', 'maintenance:read', 'vehicle:read', 'depot:read'])
const depotAdmin = currentUser(['depot_admin'], ['maintenance:read', 'vehicle:read', 'depot:read'])

const none = { planned_service: 0, unplanned_repair: 0, breakdown: 0, accident: 0, awaiting_parts: 0, other: 0 }
const kpis = (k: Partial<DowntimeKpis>): DowntimeKpis => ({
  in_fleet_minutes: 43_200,
  uptime_minutes: 43_200,
  downtime_minutes: 0,
  unplanned_downtime_minutes: 0,
  availability_pct: 100,
  failures: 0,
  mtbf_minutes: null,
  repairs: 0,
  mttr_minutes: null,
  downtime_by_reason: none,
  ...k,
})

const vehicle = (id: string, plate: string, depot: [string, string], k: Partial<DowntimeKpis>): VehicleAvailability => ({
  vehicle_id: id,
  registration_number: plate,
  depot_id: depot[0],
  depot_name: depot[1],
  status: 'active',
  ...kpis(k),
})

const TRUCK = vehicle('aaaaaaaa-0000-4000-8000-000000000001', 'AA 3-10001', [BOLE, 'Bole'], {
  uptime_minutes: 38_160,
  downtime_minutes: 5_040,
  unplanned_downtime_minutes: 2_160,
  availability_pct: 88.3,
  failures: 2,
  mtbf_minutes: 19_080,
  repairs: 2,
  mttr_minutes: 1_080,
  downtime_by_reason: { ...none, planned_service: 2_880, unplanned_repair: 1_440, breakdown: 720 },
})
const VAN = vehicle('aaaaaaaa-0000-4000-8000-000000000002', 'AA 3-10002', [ADAMA, 'Adama'], {
  uptime_minutes: 43_080,
  downtime_minutes: 120,
  availability_pct: 99.7,
  downtime_by_reason: { ...none, planned_service: 120 },
})
const CAR = vehicle('aaaaaaaa-0000-4000-8000-000000000003', 'AA 3-10003', [BOLE, 'Bole'], {})

function report(vehicles: VehicleAvailability[]): Availability {
  const sum = (k: 'in_fleet_minutes' | 'uptime_minutes' | 'downtime_minutes' | 'unplanned_downtime_minutes' | 'failures' | 'repairs') => vehicles.reduce((s, v) => s + v[k], 0)
  const byReason = Object.fromEntries(Object.keys(none).map((r) => [r, vehicles.reduce((s, v) => s + v.downtime_by_reason[r as keyof typeof none], 0)])) as DowntimeKpis['downtime_by_reason']
  const fleet = kpis({
    in_fleet_minutes: sum('in_fleet_minutes'),
    uptime_minutes: sum('uptime_minutes'),
    downtime_minutes: sum('downtime_minutes'),
    unplanned_downtime_minutes: sum('unplanned_downtime_minutes'),
    availability_pct: vehicles.length ? Math.round((sum('uptime_minutes') * 1000) / sum('in_fleet_minutes')) / 10 : null,
    failures: sum('failures'),
    mtbf_minutes: sum('failures') ? Math.round(sum('uptime_minutes') / sum('failures')) : null,
    repairs: sum('repairs'),
    mttr_minutes: sum('repairs') ? 1_080 : null,
    downtime_by_reason: byReason,
  })
  const depots = [...new Set(vehicles.map((v) => v.depot_id))].map((id) => {
    const mine = vehicles.filter((v) => v.depot_id === id)
    return { depot_id: id, depot_name: mine[0].depot_name, vehicles: mine.length, ...report.kpisOf(mine) }
  })
  return { month: '2026-09', fleet: { vehicles: vehicles.length, ...fleet }, depots, vehicles }
}
report.kpisOf = (vs: VehicleAvailability[]): DowntimeKpis => {
  const up = vs.reduce((s, v) => s + v.uptime_minutes, 0)
  const all = vs.reduce((s, v) => s + v.in_fleet_minutes, 0)
  return kpis({ uptime_minutes: up, in_fleet_minutes: all, downtime_minutes: all - up, availability_pct: Math.round((up * 1000) / all) / 10 })
}

const period = (p: Partial<DowntimePeriod>): DowntimePeriod => ({
  id: 'p-1',
  vehicle_id: TRUCK.vehicle_id,
  started_at: '2026-09-20T00:00:00+03:00',
  ended_at: '2026-09-21T00:00:00+03:00',
  duration_minutes: 1_440,
  reason: 'unplanned_repair',
  unplanned: true,
  derived_reason: 'unplanned_repair',
  reason_note: null,
  reason_set_by: null,
  reason_set_at: null,
  opened_by: 'status_change',
  maintenance_record_id: null,
  failure_event_id: null,
  maintenance_record: null,
  failure: null,
  ...p,
})

const TRUCK_PERIODS: DowntimePeriod[] = [
  period({
    id: 'p-3',
    maintenance_record_id: 'r-3',
    maintenance_record: { id: 'r-3', maintenance_type: 'corrective', status: 'completed', description: 'Gearbox oil seal' },
  }),
  period({
    id: 'p-2',
    started_at: '2026-09-10T06:00:00+03:00',
    ended_at: '2026-09-10T18:00:00+03:00',
    duration_minutes: 720,
    reason: 'breakdown',
    derived_reason: 'breakdown',
    opened_by: 'breakdown',
    maintenance_record_id: 'r-2',
    failure_event_id: 'f-2',
    maintenance_record: { id: 'r-2', maintenance_type: 'corrective', status: 'completed', description: 'Radiator leak on the Adama road' },
    failure: { id: 'f-2', component: 'cooling', failure_mode: 'leak', detected_by: 'breakdown', occurred_at: '2026-09-10T06:00:00+03:00' },
  }),
  // Begun in August: 1 h of it is September's.
  period({ id: 'p-1', started_at: '2026-08-31T20:00:00+03:00', ended_at: '2026-09-01T01:00:00+03:00', duration_minutes: 300, reason: 'other', derived_reason: 'other', unplanned: false }),
]

/** A fake GET /analytics/downtime (depot filter) and /vehicles/{id}/downtime, recording what was asked. */
function serve(vehicles: VehicleAvailability[], periods: Record<string, DowntimePeriod[]> = {}) {
  const asked = { availability: [] as URLSearchParams[], periods: [] as { vehicle: string; q: URLSearchParams }[] }
  server.use(
    http.get('/api/v1/analytics/downtime', ({ request }) => {
      const q = new URL(request.url).searchParams
      asked.availability.push(q)
      const depot = q.get('depot_id')
      const data = report(vehicles.filter((v) => !depot || v.depot_id === depot))
      return HttpResponse.json({ data, meta: { month: '2026-09', data_freshness: { source: 'replica', lag_seconds: 12, as_of: '2026-11-05T08:00:00.000Z' }, request_id: 'r-1' } })
    }),
    http.get('/api/v1/vehicles/:id/downtime', ({ params, request }) => {
      const q = new URL(request.url).searchParams
      asked.periods.push({ vehicle: String(params.id), q })
      const list = periods[String(params.id)] ?? []
      return HttpResponse.json({ data: list, meta: { page: 1, page_size: 100, total_items: list.length, total_pages: 1, request_id: 'r-1' } })
    }),
    http.get('/api/v1/depots', () =>
      HttpResponse.json({
        data: [
          { id: BOLE, name: 'Bole', code: 'BOL', location: 'Addis Ababa' },
          { id: ADAMA, name: 'Adama', code: 'ADM', location: 'Adama' },
        ],
        meta: { request_id: 'r-1' },
      }),
    ),
  )
  return asked
}

const vehicleTable = () => screen.getByRole('table', { name: /Availability by vehicle/ })
const plates = () =>
  within(vehicleTable())
    .getAllByRole('row')
    .map((r) => r.querySelector('.plate')?.textContent)
    .filter(Boolean)
const rowFor = (plate: string) => within(vehicleTable()).getByText(plate).closest('tr') as HTMLElement

async function open(at = '/availability?month=2026-09') {
  signedInAs(manager)
  renderApp(at)
  await screen.findByRole('heading', { name: 'Fleet availability', level: 1 })
  await waitFor(() => expect(plates().length).toBeGreaterThan(0))
  return userEvent.setup()
}

beforeEach(() => {
  downloads.length = 0
})

describe('S-33 Fleet availability (FMS-142)', () => {
  it('shows the month’s availability, downtime, MTBF and MTTR, why vehicles were down, the depots, and the vehicles most down first', async () => {
    const asked = serve([CAR, VAN, TRUCK])
    await open()
    expect(asked.availability[0].get('month')).toBe('2026-09')

    // The fleet: 3 vehicles' 129,600 minutes, 5,160 down (96.0%); FMS-131's truck gives the failures.
    const band = screen.getByText('Availability', { selector: 'dt' }).closest('dl') as HTMLElement
    expect(within(band).getByText('96.0%')).toBeInTheDocument()
    expect(within(band).getByText('86 h')).toBeInTheDocument()
    expect(within(band).getByText('36 h unplanned')).toBeInTheDocument()
    expect(within(band).getByText('43 d 5 h')).toBeInTheDocument()
    expect(within(band).getByText('18 h')).toBeInTheDocument()
    expect(within(band).getByText(/2 failures/)).toBeInTheDocument()
    expect(screen.getByText(/12 s behind live/)).toBeInTheDocument()

    // Why: largest first, each with its hours and share.
    const reasons = within(screen.getByRole('list', { name: 'Downtime by reason' })).getAllByRole('listitem')
    expect(reasons[0]).toHaveTextContent('Planned service50 h58%')
    expect(reasons[1]).toHaveTextContent('Unplanned repair (counts as a failure)24 h28%')
    expect(reasons[2]).toHaveTextContent('Breakdown (counts as a failure)12 h14%')

    // Two depots side by side, then the vehicles: most downtime first.
    expect(within(screen.getByRole('table', { name: 'Availability by depot' })).getByText('Adama')).toBeInTheDocument()
    expect(plates()).toEqual(['AA 3-10001', 'AA 3-10002', 'AA 3-10003'])
    const truck = rowFor('AA 3-10001')
    expect(truck).toHaveTextContent('88.3%')
    expect(truck).toHaveTextContent('84 h36 h unplanned')
    expect(truck).toHaveTextContent('13 d 6 h')
    expect(within(truck).getByText('Planned service')).toBeInTheDocument()
    expect(within(rowFor('AA 3-10003')).getByText('Not down')).toBeInTheDocument()
  })

  it('sorts by any figure, shows only the vehicles that were down, and a depot narrows it', async () => {
    const asked = serve([CAR, VAN, TRUCK])
    const user = await open()

    await user.click(within(vehicleTable()).getByRole('button', { name: /Available/ }))
    await waitFor(() => expect(plates()).toEqual(['AA 3-10001', 'AA 3-10002', 'AA 3-10003']))
    await user.click(within(vehicleTable()).getByRole('button', { name: /Available/ }))
    await waitFor(() => expect(plates()).toEqual(['AA 3-10003', 'AA 3-10002', 'AA 3-10001']))
    // MTBF: soonest first, a vehicle without a failure last.
    await user.click(within(vehicleTable()).getByRole('button', { name: /MTBF/ }))
    await waitFor(() => expect(plates()[0]).toBe('AA 3-10001'))

    await user.click(screen.getByRole('button', { name: /With downtime/ }))
    await waitFor(() => expect(plates()).toHaveLength(2))
    expect(plates()).not.toContain('AA 3-10003')

    // A depot's row picks the depot.
    await user.click(within(screen.getByRole('table', { name: 'Availability by depot' })).getByText('Adama'))
    await waitFor(() => expect(asked.availability.at(-1)?.get('depot_id')).toBe(ADAMA))
    await waitFor(() => expect(plates()).toEqual(['AA 3-10002']))
  })

  it('a vehicle opens its month’s periods, each with the work order or failure behind it, and its history', async () => {
    const asked = serve([CAR, VAN, TRUCK], { [TRUCK.vehicle_id]: TRUCK_PERIODS })
    const user = await open()
    await user.click(within(rowFor('AA 3-10001')).getByText('AA 3-10001'))

    const drawer = await screen.findByRole('dialog', { name: 'AA 3-10001' })
    expect(asked.periods[0]).toMatchObject({ vehicle: TRUCK.vehicle_id })
    expect(asked.periods[0].q.get('from')).toBe('2026-09-01T00:00:00+03:00')
    expect(asked.periods[0].q.get('to')).toBe('2026-10-01T00:00:00+03:00')

    const periods = within(await within(drawer).findByRole('list')).getAllByRole('listitem')
    expect(periods).toHaveLength(3)
    expect(periods[0]).toHaveTextContent('Repair: Gearbox oil seal')
    expect(periods[1]).toHaveTextContent('Repair: Radiator leak on the Adama road')
    expect(periods[1]).toHaveTextContent('Cooling: Leak')
    expect(within(periods[1]).getByText('Breakdown')).toBeInTheDocument()
    expect(periods[1]).toHaveTextContent('12 h')
    // Begun in August: its whole length, and September's hour of it; no work order, so what began it.
    expect(periods[2]).toHaveTextContent('5 h · 1 h in September 2026')
    expect(periods[2]).toHaveTextContent('Status set by hand')

    expect(within(drawer).getByRole('link', { name: /Open vehicle history/ })).toHaveAttribute('href', `/vehicles/${TRUCK.vehicle_id}`)
    expect(within(drawer).getByText('88.3%')).toBeInTheDocument()
  })

  it('exports every vehicle as CSV, in hours to the minute', async () => {
    serve([CAR, VAN, TRUCK])
    const user = await open()
    await user.click(screen.getByRole('button', { name: 'Export CSV' }))
    expect(downloads).toHaveLength(1)
    expect(downloads[0].filename).toBe('fleet-availability-2026-09-all.csv')
    const [header, ...lines] = downloads[0].csv.split('\r\n')
    expect(header).toBe(
      'Plate,Depot,Status,Availability (%),In fleet (h),Downtime (h),Unplanned downtime (h),Failures,MTBF (h),Repairs,MTTR (h),Planned service (h),Unplanned repair (h),Breakdown (h),Accident (h),Awaiting parts (h),Other (h)',
    )
    expect(lines).toContain('AA 3-10001,Bole,active,88.3,720.00,84.00,36.00,2,318.00,2,18.00,48.00,24.00,12.00,0.00,0.00,0.00')
    expect(lines).toHaveLength(3)
    expect(await screen.findByText('CSV downloaded')).toBeInTheDocument()
  })

  it('empty: a month with no vehicles says so, and nothing to export', async () => {
    serve([])
    signedInAs(manager)
    renderApp('/availability?month=2026-09')
    expect(await screen.findByText('No vehicles in September 2026')).toBeInTheDocument()
    expect(screen.getByText('No vehicle was out of service this month.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeDisabled()
  })

  it('a failed read offers to try again', async () => {
    serve([TRUCK])
    let fail = true
    server.use(http.get('/api/v1/analytics/downtime', () => (fail ? errorEnvelope(500, 'INTERNAL_SERVER_ERROR') : undefined)))
    signedInAs(manager)
    renderApp('/availability?month=2026-09')
    const retry = await screen.findByRole('button', { name: 'Try again' }, { timeout: 8000 })
    expect(screen.queryByText('Why vehicles were down')).not.toBeInTheDocument()
    fail = false
    await userEvent.setup().click(retry)
    await waitFor(() => expect(plates()).toEqual(['AA 3-10001']))
  }, 15_000)

  it('without analytics:read it is neither in the menu nor shown', async () => {
    const asked = serve([TRUCK])
    signedInAs(depotAdmin)
    renderApp('/availability')
    await screen.findAllByRole('navigation')
    expect(screen.queryByRole('link', { name: 'Availability' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Fleet availability' })).not.toBeInTheDocument()
    expect(asked.availability).toHaveLength(0)
  })
})

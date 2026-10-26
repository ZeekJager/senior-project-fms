import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { currentUser, envelope, renderApp, signedInAs } from '@/test/auth'
import { server } from '@/test/msw/server'
import type { MaintenanceRisk } from '@/features/health/health'
import type { Vehicle } from '@/pages/Vehicles/types'

const DEPOT = '11111111-1111-4111-8111-111111111111'
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()

const technician = currentUser(['technician'], ['vehicle:read', 'depot:read', 'prediction:read', 'maintenance:read', 'maintenance:write', 'inventory:read'])
const dispatcher = currentUser(['dispatcher'], ['vehicle:read', 'depot:read', 'trip:assign'])

let seq = 0
function vehicle(score: number | null, updatedAt: string | null = score === null ? null : hoursAgo(3), overrides: Partial<Vehicle> = {}): Vehicle {
  seq += 1
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    registration_number: `AA 3-${20000 + seq}`,
    vin: null,
    make: 'Isuzu',
    model: 'FSR',
    year: 2018,
    vehicle_type: 'truck',
    fuel_type: 'diesel',
    fuel_efficiency_ml_per_km: 320,
    status: 'active',
    maintenance_flag: false,
    health_score: score,
    health_score_updated_at: updatedAt,
    depot_id: DEPOT,
    odometer_km: 87_000,
    current_trip: null,
    version: 0,
    created_at: '2022-01-01T00:00:00Z',
    updated_at: '2026-10-25T23:00:00Z',
    ...overrides,
  }
}

function risk(v: Vehicle, overrides: Partial<MaintenanceRisk> = {}): MaintenanceRisk {
  return {
    vehicle_id: v.id,
    prediction_id: 'p-1',
    health_score: v.health_score,
    risk_level: 'medium',
    failure_probability: 0.4,
    prediction_horizon_days: 30,
    factors: [
      { feature: 'days_since_last_service', value: 100, unit: 'd' },
      { feature: 'km_since_oil_change', value: 17380, unit: 'km' },
      { feature: 'num_fault_reports', value: 5, unit: 'count' },
    ],
    model_name: 'predictive-maintenance',
    model_version: 'pm-2026.10',
    as_of: '2026-10-25T21:00:00Z',
    scored_at: v.health_score_updated_at,
    stale: false,
    ...overrides,
  }
}

const VIEWS: Record<string, (v: Vehicle) => boolean> = {
  at_risk: (v) => v.health_score !== null && v.health_score < 75 && Date.now() - Date.parse(v.health_score_updated_at!) <= 25 * 3_600_000,
  stale: (v) => v.health_score !== null && Date.now() - Date.parse(v.health_score_updated_at!) > 25 * 3_600_000,
  unscored: (v) => v.health_score === null,
}

/** A fake GET /vehicles (health filter, score sort), the breakdown per vehicle, the active model; records list queries. */
function serveHealth(fleet: Vehicle[], risks: Record<string, MaintenanceRisk> = {}) {
  const queries: URLSearchParams[] = []
  server.use(
    http.get('/api/v1/vehicles', ({ request }) => {
      const q = new URL(request.url).searchParams
      queries.push(q)
      const view = q.get('health')
      let rows = view ? fleet.filter(VIEWS[view] ?? (() => false)) : fleet
      if (q.get('sort_by') === 'health_score') rows = [...rows].sort((a, b) => (a.health_score ?? 999) - (b.health_score ?? 999))
      const size = Number(q.get('page_size') ?? 25)
      return HttpResponse.json({ data: rows.slice(0, size), meta: { page: 1, page_size: size, total_items: rows.length, total_pages: 1, request_id: 'r-1' } })
    }),
    http.get('/api/v1/depots', () => envelope([{ id: DEPOT, name: 'Addis Ababa Central', code: 'ADD', location: 'Addis Ababa' }])),
    http.get('/api/v1/ml-models', () => envelope([{ version: 'pm-2026.10', activated_at: '2026-10-20T08:00:00Z' }])),
    http.get('/api/v1/vehicles/:id/maintenance-risk', ({ params }) => envelope(risks[String(params.id)] ?? risk(fleet.find((v) => v.id === params.id)!))),
    http.get('/api/v1/maintenance', () => HttpResponse.json({ data: [], meta: { page: 1, page_size: 25, total_items: 0, total_pages: 0 } })),
    http.get('/api/v1/inventory', () => HttpResponse.json({ data: [], meta: { page: 1, page_size: 25, total_items: 0, total_pages: 0 } })),
  )
  return { listQueries: () => queries.filter((q) => q.get('page_size') !== '1') }
}

const table = () => screen.getByRole('table', { name: 'Vehicle health' })
const rowFor = (plate: string) => within(table()).getByText(plate).closest('tr') as HTMLElement

describe('Vehicle health (S-19)', () => {
  it('lists the fleet riskiest first, with each score coloured by its band, stale and unscored ones said in words', async () => {
    const [risky, watch, healthy, stale, unscored] = [vehicle(60), vehicle(80), vehicle(92), vehicle(40, hoursAgo(30)), vehicle(null)]
    const api = serveHealth([healthy, unscored, risky, stale, watch])
    signedInAs(technician)
    renderApp('/predictive-maintenance')

    await screen.findByRole('heading', { name: 'Vehicle health' })
    await waitFor(() => expect(within(table()).getAllByRole('row').length).toBeGreaterThan(5))
    expect(api.listQueries().at(-1)!.get('sort_by')).toBe('health_score')
    expect(api.listQueries().at(-1)!.get('sort_order')).toBe('asc')
    const plates = within(table())
      .getAllByRole('row')
      .map((r) => r.querySelector('.plate')?.textContent)
      .filter(Boolean)
    expect(plates).toEqual([stale, risky, watch, healthy, unscored].map((v) => v.registration_number))

    expect(within(rowFor(risky.registration_number)).getByRole('button', { name: /Health score 60, at risk/ })).toHaveClass('bg-danger-soft')
    expect(within(rowFor(watch.registration_number)).getByRole('button', { name: /Health score 80, watch/ })).toHaveClass('bg-warning-soft')
    expect(within(rowFor(healthy.registration_number)).getByRole('button', { name: /Health score 92, healthy/ })).toHaveClass('bg-success-soft')
    // Stale: grey, STALE, never red although 40 is a high risk.
    const staleBadge = within(rowFor(stale.registration_number)).getByRole('button', { name: /Health score 40, stale/ })
    expect(staleBadge).toHaveClass('bg-neutral-soft')
    expect(staleBadge).toHaveTextContent('Stale')
    expect(within(rowFor(unscored.registration_number)).getByText('Not scored yet')).toBeInTheDocument()
    expect(screen.getByText(/model pm-2026\.10/)).toBeInTheDocument()
  })

  it('filters by view, with each view counted', async () => {
    const api = serveHealth([vehicle(60), vehicle(70), vehicle(90), vehicle(null)])
    const user = userEvent.setup()
    signedInAs(technician)
    renderApp('/predictive-maintenance')

    const views = await screen.findByRole('group', { name: 'Health views' })
    await waitFor(() => expect(within(views).getByRole('button', { name: /At risk/ })).toHaveTextContent('2'))
    await user.click(within(views).getByRole('button', { name: /At risk/ }))
    await waitFor(() => expect(api.listQueries().at(-1)!.get('health')).toBe('at_risk'))
  })

  it('opens the breakdown: gauge, risk level, chance, when scored, and the three inputs that drive it with their values', async () => {
    const risky = vehicle(60)
    serveHealth([risky])
    const user = userEvent.setup()
    signedInAs(technician)
    renderApp('/predictive-maintenance')

    await user.click(await screen.findByText(risky.registration_number))
    const panel = await screen.findByRole('dialog', { name: `${risky.registration_number} health` })
    expect(await within(panel).findByRole('img', { name: 'Health score 60 out of 100, at risk' })).toBeInTheDocument()
    expect(within(panel).getByText('Medium risk')).toBeInTheDocument()
    expect(within(panel).getByText('40%')).toBeInTheDocument()
    expect(within(panel).getByText('pm-2026.10')).toBeInTheDocument()
    const factors = within(within(panel).getByRole('list')).getAllByRole('listitem')
    expect(factors.map((f) => f.textContent)).toEqual([
      expect.stringMatching(/Time since last service.*100 days/),
      expect.stringMatching(/Distance since oil change.*17,380 km/),
      expect.stringMatching(/Faults reported, last 90 days.*5/),
    ])
    expect(within(panel).getByRole('link', { name: /View maintenance history/ })).toHaveAttribute('href', `/maintenance?vehicle=${risky.id}`)
  })

  it('a stale score says so; a vehicle never scored says it is not scored yet', async () => {
    const [stale, never] = [vehicle(88, hoursAgo(30)), vehicle(null)]
    serveHealth([stale, never], {
      [stale.id]: risk(stale, { factors: [], risk_level: 'low', failure_probability: 0.12, stale: true }),
      [never.id]: risk(never, { prediction_id: null, health_score: null, risk_level: null, failure_probability: null, prediction_horizon_days: null, factors: [], model_name: null, model_version: null, as_of: null, scored_at: null }),
    })
    const user = userEvent.setup()
    signedInAs(technician)
    renderApp('/predictive-maintenance')

    await user.click(await screen.findByText(stale.registration_number))
    let panel = await screen.findByRole('dialog')
    expect(await within(panel).findByText(/the last nightly scoring did not reach this vehicle/)).toBeInTheDocument()
    expect(within(panel).getByRole('img', { name: /stale/ })).toBeInTheDocument()
    expect(within(panel).getByText(/Nothing stands out/)).toBeInTheDocument()
    await user.keyboard('{Escape}')

    await user.click(screen.getByText(never.registration_number))
    panel = await screen.findByRole('dialog')
    expect(await within(panel).findByRole('heading', { name: 'Not scored yet' })).toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: 'Schedule inspection' })).not.toBeInTheDocument()
  })

  it('schedules an inspection: the repair form opens on the vehicle as an inspection saying why', async () => {
    const risky = vehicle(60)
    serveHealth([risky])
    const user = userEvent.setup()
    signedInAs(technician)
    renderApp('/predictive-maintenance')

    await user.click(await screen.findByText(risky.registration_number))
    await user.click(await within(await screen.findByRole('dialog')).findByRole('button', { name: 'Schedule inspection' }))
    const form = await screen.findByRole('dialog', { name: 'Schedule an inspection' })
    expect(within(form).getByDisplayValue(risky.registration_number)).toBeInTheDocument()
    expect(within(form).getByRole('textbox', { name: 'Work done' })).toHaveValue(
      'Inspection: health score 60 (at risk), mostly time since last service, distance since oil change, faults reported, last 90 days.',
    )
  })

  it('is in the menu for those with prediction:read, not for a dispatcher', async () => {
    serveHealth([vehicle(60)])
    signedInAs(dispatcher)
    renderApp('/vehicles')
    await screen.findByRole('heading', { name: 'Vehicles' })
    expect(screen.queryByRole('link', { name: 'Vehicle health' })).not.toBeInTheDocument()
  })
})

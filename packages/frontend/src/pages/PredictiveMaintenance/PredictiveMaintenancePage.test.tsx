import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { currentUser, envelope, errorEnvelope, renderApp, signedInAs } from '@/test/auth'
import { server } from '@/test/msw/server'
import type { MaintenanceRisk, PredictionFeedback } from '@/features/health/health'
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
    feedback: null,
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
    // Wait for the plates, not a row count: while loading, the table holds skeleton rows without plates.
    const plates = () =>
      within(table())
        .getAllByRole('row')
        .map((r) => r.querySelector('.plate')?.textContent)
        .filter(Boolean)
    await waitFor(() => expect(plates()).toEqual([stale, risky, watch, healthy, unscored].map((v) => v.registration_number)))
    expect(api.listQueries().at(-1)!.get('sort_by')).toBe('health_score')
    expect(api.listQueries().at(-1)!.get('sort_order')).toBe('asc')

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

  describe('what the inspection found (FMS-128)', () => {
    const reader = currentUser(['fleet_owner'], ['vehicle:read', 'depot:read', 'prediction:read', 'maintenance:read'])
    const FAILURES = [
      { id: 'fe-1', component: 'brakes', failure_mode: 'wear', occurred_at: '2026-10-20T08:00:00Z' },
      { id: 'fe-2', component: 'cooling', failure_mode: 'leak', occurred_at: '2026-10-10T08:00:00Z' },
    ]
    const given = (overrides: Partial<PredictionFeedback> = {}): PredictionFeedback => ({
      id: 'f-1',
      prediction_id: 'p-1',
      outcome: 'no_issue_found',
      component: null,
      failure_event_id: null,
      comment: null,
      recorded_by: 'u-1',
      created_at: '2026-10-25T08:00:00Z',
      updated_at: '2026-10-25T08:00:00Z',
      editable_until: '2026-11-01T08:00:00Z',
      can_edit: true,
      ...overrides,
    })

    /** The fleet, the breakdown with the server's current feedback, and POST/PATCH /maintenance-predictions/{id}/feedback; records the calls. */
    function serveFeedback(v: Vehicle, initial: PredictionFeedback | null = null, riskOverrides: Partial<MaintenanceRisk> = {}, refuse?: ReturnType<typeof errorEnvelope>) {
      let feedback = initial
      const calls: { method: string; id: string; body: Record<string, unknown> }[] = []
      serveHealth([v])
      const save = (method: 'POST' | 'PATCH') => async ({ request, params }: { request: Request; params: Record<string, unknown> }) => {
        const body = (await request.json()) as Record<string, unknown>
        calls.push({ method, id: String(params.id), body })
        if (refuse) return refuse
        feedback = given({ ...(feedback ?? {}), ...body } as Partial<PredictionFeedback>)
        return HttpResponse.json({ data: feedback, meta: { request_id: 'r-1' } }, { status: method === 'POST' ? 201 : 200 })
      }
      server.use(
        http.get('/api/v1/vehicles/:id/maintenance-risk', () => envelope(risk(v, { risk_level: 'high', feedback, ...riskOverrides }))),
        http.get('/api/v1/failure-events', () => envelope(FAILURES)),
        http.post('/api/v1/maintenance-predictions/:id/feedback', save('POST')),
        http.patch('/api/v1/maintenance-predictions/:id/feedback', save('PATCH')),
      )
      return { calls, setFeedback: (f: PredictionFeedback | null) => (feedback = f) }
    }

    async function openBreakdown(v: Vehicle, who = technician) {
      const user = userEvent.setup()
      signedInAs(who)
      renderApp('/predictive-maintenance')
      await user.click(await screen.findByText(v.registration_number))
      const panel = await screen.findByRole('dialog', { name: `${v.registration_number} health` })
      return { user, panel }
    }

    it('a technician says a high-risk vehicle had a problem, in which part, and what they saw: one POST, then it reads back', async () => {
      const v = vehicle(35)
      const { calls } = serveFeedback(v)
      const { user, panel } = await openBreakdown(v)

      expect(await within(panel).findByRole('heading', { name: 'What the inspection found' })).toBeInTheDocument()
      await user.click(within(panel).getByRole('radio', { name: /Found a problem/ }))
      await user.selectOptions(within(panel).getByRole('combobox', { name: /Part of the vehicle/ }), 'brakes')
      await user.type(within(panel).getByRole('textbox', { name: /Notes/ }), 'Pads worn to the metal')
      await user.click(within(panel).getByRole('button', { name: 'Save' }))

      await waitFor(() => expect(calls).toHaveLength(1))
      expect(calls[0]).toEqual({ method: 'POST', id: 'p-1', body: { outcome: 'confirmed_issue', component: 'brakes', failure_event_id: null, comment: 'Pads worn to the metal' } })
      // The breakdown is read again: what was found is shown, with the way to change it.
      expect(await within(panel).findByText('Found a problem')).toBeInTheDocument()
      expect(within(panel).getByText('Brakes')).toBeInTheDocument()
      expect(within(panel).getByText('Pads worn to the metal')).toBeInTheDocument()
      expect(within(panel).getByRole('button', { name: 'Change' })).toBeInTheDocument()
      expect(within(panel).queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
    })

    it('a confirmed issue can name the failure record it led to; the part follows the record', async () => {
      const v = vehicle(35)
      const { calls } = serveFeedback(v)
      const { user, panel } = await openBreakdown(v)

      await user.click(await within(panel).findByRole('radio', { name: /Found a problem/ }))
      const records = await within(panel).findByRole('combobox', { name: /Failure record it led to/ })
      expect(within(records).getAllByRole('option').map((o) => o.textContent)).toEqual([
        'None yet',
        expect.stringMatching(/^Brakes · Worn out · 20 Oct/),
        expect.stringMatching(/^Cooling · Leak · 10 Oct/),
      ])
      await user.selectOptions(records, 'fe-1')
      const part = within(panel).getByRole('combobox', { name: /Part of the vehicle/ })
      expect(part).toHaveValue('brakes')
      expect(part).toBeDisabled()
      await user.click(within(panel).getByRole('button', { name: 'Save' }))

      await waitFor(() => expect(calls).toHaveLength(1))
      expect(calls[0].body).toMatchObject({ outcome: 'confirmed_issue', failure_event_id: 'fe-1' })
    })

    it('says an outcome is needed and sends nothing until one is chosen; the other outcomes take no part and no record', async () => {
      const v = vehicle(35)
      const { calls } = serveFeedback(v)
      const { user, panel } = await openBreakdown(v)

      await user.click(await within(panel).findByRole('button', { name: 'Save' }))
      expect(await within(panel).findByText('Choose what the inspection found.')).toBeInTheDocument()
      expect(calls).toEqual([])

      await user.click(within(panel).getByRole('radio', { name: /Found a problem/ }))
      await user.selectOptions(within(panel).getByRole('combobox', { name: /Part of the vehicle/ }), 'engine')
      await user.click(within(panel).getByRole('radio', { name: /Nothing wrong/ }))
      expect(within(panel).queryByRole('combobox', { name: /Part of the vehicle/ })).not.toBeInTheDocument()
      await user.click(within(panel).getByRole('button', { name: 'Save' }))
      await waitFor(() => expect(calls).toHaveLength(1))
      expect(calls[0].body).toEqual({ outcome: 'no_issue_found', component: null, failure_event_id: null, comment: null })
    })

    it('only a high-risk prediction is asked about', async () => {
      const [medium, low] = [vehicle(60), vehicle(90)]
      serveHealth([medium, low], { [medium.id]: risk(medium, { risk_level: 'medium' }), [low.id]: risk(low, { risk_level: 'low', factors: [] }) })
      const user = userEvent.setup()
      signedInAs(technician)
      renderApp('/predictive-maintenance')

      await user.click(await screen.findByText(medium.registration_number))
      let panel = await screen.findByRole('dialog')
      await within(panel).findByText('Medium risk')
      expect(within(panel).queryByRole('heading', { name: 'What the inspection found' })).not.toBeInTheDocument()
      await user.keyboard('{Escape}')
      await user.click(screen.getByText(low.registration_number))
      panel = await screen.findByRole('dialog')
      await within(panel).findByText('Low risk')
      expect(within(panel).queryByRole('heading', { name: 'What the inspection found' })).not.toBeInTheDocument()
    })

    it('someone who may not record sees nothing to fill in, but reads what was found', async () => {
      const v = vehicle(35)
      serveFeedback(v)
      let { panel } = await openBreakdown(v, reader)
      await within(panel).findByText('High risk')
      expect(within(panel).queryByRole('heading', { name: 'What the inspection found' })).not.toBeInTheDocument()
      expect(within(panel).queryByRole('radio')).not.toBeInTheDocument()
      cleanup()

      const w = vehicle(30)
      serveFeedback(w, given({ outcome: 'confirmed_issue', component: 'brakes', comment: 'Pads gone', can_edit: false }))
      ;({ panel } = await openBreakdown(w, reader))
      expect(await within(panel).findByText('Found a problem')).toBeInTheDocument()
      expect(within(panel).getByText('Pads gone')).toBeInTheDocument()
      expect(within(panel).queryByRole('button', { name: 'Change' })).not.toBeInTheDocument()
    })

    it('the author changes it within the week: the form comes back filled in, and the change is a PATCH', async () => {
      const v = vehicle(35)
      const { calls } = serveFeedback(v, given({ outcome: 'confirmed_issue', component: 'brakes', comment: 'Pads gone' }))
      const { user, panel } = await openBreakdown(v)

      expect(await within(panel).findByText(/You can change it until/)).toBeInTheDocument()
      await user.click(within(panel).getByRole('button', { name: 'Change' }))
      expect(within(panel).getByRole('radio', { name: /Found a problem/ })).toBeChecked()
      expect(within(panel).getByRole('combobox', { name: /Part of the vehicle/ })).toHaveValue('brakes')
      expect(within(panel).getByRole('textbox', { name: /Notes/ })).toHaveValue('Pads gone')
      await user.click(within(panel).getByRole('radio', { name: /Already fixed/ }))
      await user.click(within(panel).getByRole('button', { name: 'Save changes' }))

      await waitFor(() => expect(calls).toHaveLength(1))
      expect(calls[0]).toEqual({ method: 'PATCH', id: 'p-1', body: { outcome: 'already_fixed', component: null, failure_event_id: null, comment: 'Pads gone' } })
      expect(await within(panel).findByText('Already fixed')).toBeInTheDocument()
    })

    it('Cancel leaves what was recorded as it was', async () => {
      const v = vehicle(35)
      const { calls } = serveFeedback(v, given({ comment: 'Checked twice' }))
      const { user, panel } = await openBreakdown(v)
      await user.click(await within(panel).findByRole('button', { name: 'Change' }))
      await user.click(within(panel).getByRole('button', { name: 'Cancel' }))
      expect(within(panel).getByText('Checked twice')).toBeInTheDocument()
      expect(calls).toEqual([])
    })

    it("a second technician's answer already there is said, and shown instead of the form", async () => {
      const v = vehicle(35)
      const refused = errorEnvelope(409, 'CONFLICT_DUPLICATE', 'This prediction already has feedback.', [{ reason: 'already_recorded', record_id: 'f-9' }])
      const { setFeedback } = serveFeedback(v, null, {}, refused)
      const { user, panel } = await openBreakdown(v)

      await user.click(await within(panel).findByRole('radio', { name: /Nothing wrong/ }))
      setFeedback(given({ id: 'f-9', outcome: 'confirmed_issue', component: 'engine', can_edit: false }))
      await user.click(within(panel).getByRole('button', { name: 'Save' }))

      expect(await screen.findByText('Already recorded')).toBeInTheDocument()
      expect(await within(panel).findByText('Found a problem')).toBeInTheDocument()
      expect(within(panel).queryByRole('button', { name: 'Save' })).not.toBeInTheDocument()
    })

    it('any other refusal is said in the form and keeps what was typed', async () => {
      const v = vehicle(35)
      serveFeedback(v, null, {}, errorEnvelope(500, 'INTERNAL_ERROR'))
      const { user, panel } = await openBreakdown(v)
      await user.click(await within(panel).findByRole('radio', { name: /Not inspected/ }))
      await user.type(within(panel).getByRole('textbox', { name: /Notes/ }), 'Awaiting a slot')
      await user.click(within(panel).getByRole('button', { name: 'Save' }))

      expect(await within(panel).findByText(/could not be saved/, undefined, { timeout: 8000 })).toBeInTheDocument()
      expect(within(panel).getByRole('textbox', { name: /Notes/ })).toHaveValue('Awaiting a slot')
    }, 15000)
  })

  it('is in the menu for those with prediction:read, not for a dispatcher', async () => {
    serveHealth([vehicle(60)])
    signedInAs(dispatcher)
    renderApp('/vehicles')
    await screen.findByRole('heading', { name: 'Vehicles' })
    expect(screen.queryByRole('link', { name: 'Vehicle health' })).not.toBeInTheDocument()
  })
})

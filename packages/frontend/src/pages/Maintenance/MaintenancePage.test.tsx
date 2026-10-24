import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { currentUser, envelope, renderApp, signedInAs } from '@/test/auth'
import { server } from '@/test/msw/server'
import type { Vehicle } from '@/pages/Vehicles/types'
import type { InventoryPart, MaintenanceRecord } from './api'
import type { FailureEvent } from './failures'

const technician = currentUser(['technician'], ['maintenance:read', 'maintenance:write', 'maintenance:execute', 'inventory:read', 'vehicle:read', 'depot:read'])
const auditor = currentUser(['compliance_officer'], ['maintenance:read', 'vehicle:read', 'depot:read'])
const driver = currentUser(['driver'], ['vehicle:read', 'trip:execute'])

const flagged = { id: 'v-1', registration_number: 'AA 3-41207', make: 'Isuzu', model: 'FSR', year: 2019, maintenance_flag: true, status: 'maintenance' } as Vehicle
const outOfStock: InventoryPart = {
  id: 'p-1', part_number: 'BRK-PAD-01', name: 'Brake pad set', depot_id: null, unit_cost_cents: 4500,
  stock_quantity: 0, reorder_threshold: 2, below_reorder: true, stock_status: 'out',
}
const filter: InventoryPart = { ...outOfStock, id: 'p-2', part_number: 'OIL-FLT-01', name: 'Oil filter', unit_cost_cents: 1200, stock_quantity: 3, stock_status: 'ok', below_reorder: false }

const wornPads: FailureEvent = {
  id: 'f-1', vehicle_id: 'v-1', registration_number: 'AA 3-41207', maintenance_record_id: 'r-1', incident_id: null, component: 'brakes',
  failure_mode: 'wear', unplanned: false, detected_by: 'technician', occurred_at: '2026-10-10T07:00:00Z', odometer_km: null, notes: null,
  recorded_by: 'u-1', created_at: '2026-10-10T07:00:00Z',
}

function record(overrides: Partial<MaintenanceRecord> = {}): MaintenanceRecord {
  return {
    id: 'r-1', vehicle_id: 'v-1', registration_number: 'AA 3-41207', maintenance_type: 'corrective', description: 'Replace front brake pads',
    status: 'open', priority: 'normal', scheduled_at: null, started_at: null, completed_at: null, odometer_km: null, labour_hours: 2.5,
    total_cost_cents: 250_000, parts_cost_cents: 18_000, workshop: null, notes: null, completed_by: null,
    parts: [{ part_id: 'p-1', part_number: 'BRK-PAD-01', name: 'Brake pad set', quantity: 4, unit_cost_cents: 4500, line_cost_cents: 18_000 }],
    failures: [wornPads], version: 0, created_at: '2026-10-10T07:00:00Z', updated_at: '2026-10-10T07:00:00Z', ...overrides,
  }
}

const page = (data: unknown[]) => HttpResponse.json({ data, meta: { page: 1, page_size: 25, total_items: data.length, total_pages: 1 } })

/** The workshop's API: records, flagged vehicles, part search; returns what was written. */
function serveWorkshop(records: MaintenanceRecord[] = [record()]) {
  const writes: { method: string; path: string; body: unknown }[] = []
  server.use(
    http.get('/api/v1/maintenance', ({ request }) => {
      const q = new URL(request.url).searchParams
      let rows = records
      if (q.get('open') === 'true') rows = rows.filter((r) => ['scheduled', 'open', 'in_progress'].includes(r.status))
      if (q.get('status')) rows = rows.filter((r) => r.status === q.get('status'))
      if (q.get('vehicle_id')) rows = rows.filter((r) => r.vehicle_id === q.get('vehicle_id'))
      return page(rows)
    }),
    http.get('/api/v1/vehicles', () => page([flagged])),
    http.get('/api/v1/inventory', ({ request }) => {
      const search = (new URL(request.url).searchParams.get('search') ?? '').toLowerCase()
      return page([outOfStock, filter].filter((p) => p.name.toLowerCase().includes(search)))
    }),
    http.post('/api/v1/maintenance', async ({ request }) => {
      const body = await request.json()
      writes.push({ method: 'POST', path: '/maintenance', body })
      return HttpResponse.json({ data: record({ id: 'r-new', version: 0 }), meta: { warnings: [{ warning: 'LOW_STOCK', part_id: 'p-1', part_number: 'BRK-PAD-01', stock_quantity: 0, shortfall: 1 }] } }, { status: 201 })
    }),
    http.put('/api/v1/maintenance/:id', async ({ params, request }) => {
      writes.push({ method: 'PUT', path: `/maintenance/${String(params.id)}`, body: await request.json() })
      return envelope(record({ id: String(params.id), status: 'completed', completed_at: new Date().toISOString() }))
    }),
    http.post('/api/v1/maintenance-records/:id/failures', async ({ params, request }) => {
      writes.push({ method: 'POST', path: `/maintenance-records/${String(params.id)}/failures`, body: await request.json() })
      return HttpResponse.json({ data: wornPads, meta: {} }, { status: 201 })
    }),
  )
  return writes
}

async function openLog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Log a repair' }))
  return screen.findByRole('dialog', { name: 'Log a repair' })
}

async function fillBasics(user: ReturnType<typeof userEvent.setup>, drawer: HTMLElement) {
  await user.click(within(drawer).getByRole('combobox', { name: 'Vehicle' }))
  await user.click(await within(drawer).findByRole('option', { name: /AA 3-41207/ }))
  await user.type(within(drawer).getByLabelText('Labour'), '2.5')
  await user.type(within(drawer).getByLabelText('Work done'), 'Replaced front brake pads')
}

describe('Technician repair log (S-08)', () => {
  it('lists open work and opens a record', async () => {
    serveWorkshop()
    signedInAs(technician)
    renderApp('/maintenance')
    const table = await screen.findByRole('table', { name: 'Repairs' })
    await within(table).findByText('AA 3-41207')
    expect(within(table).getByText('Open')).toHaveAttribute('data-status', 'open')
    // The part count is plural-aware: four pads are "4 items".
    expect(within(table).getByText('4 items')).toBeInTheDocument()
  })

  it('a cost with more than two decimals is refused in the form, before any API call', async () => {
    const writes = serveWorkshop()
    signedInAs(technician)
    renderApp('/maintenance')
    const user = userEvent.setup()
    const drawer = await openLog(user)
    await fillBasics(user, drawer)
    await user.type(within(drawer).getByLabelText('Total cost'), '1500.505')

    expect(within(drawer).getByText('Use at most 2 decimal places.')).toBeInTheDocument()
    expect(within(drawer).getByLabelText('Total cost')).toHaveAttribute('aria-invalid', 'true')
    await user.click(within(drawer).getByRole('button', { name: 'Save as open work' }))
    expect(writes).toEqual([])
  })

  it('a part out of stock shows an inline warning but does not block saving; money is sent as whole cents', async () => {
    const writes = serveWorkshop()
    signedInAs(technician)
    renderApp('/maintenance')
    const user = userEvent.setup()
    const drawer = await openLog(user)
    await fillBasics(user, drawer)

    await user.click(within(drawer).getByRole('button', { name: 'Add part' }))
    await user.click(within(drawer).getByRole('combobox', { name: 'Part 1' }))
    await user.click(await within(drawer).findByRole('option', { name: /Brake pad set/ }))
    expect(await within(drawer).findByText(/Out of stock on record\. It will still be logged/)).toBeInTheDocument()
    expect(within(drawer).getByLabelText('Unit cost of part 1')).toHaveValue('45.00')

    await user.clear(within(drawer).getByLabelText('Quantity of part 1'))
    await user.type(within(drawer).getByLabelText('Quantity of part 1'), '2')
    // The line total and the running parts total both read ETB 90.00.
    expect(within(drawer).getAllByText('ETB 90.00')).toHaveLength(2)
    await user.click(within(drawer).getByRole('button', { name: 'Use as total cost' }))
    expect(within(drawer).getByLabelText('Total cost')).toHaveValue('90.00')
    await user.click(within(drawer).getByRole('button', { name: 'Save as open work' }))

    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0].body).toEqual({
      vehicle_id: 'v-1',
      maintenance_type: 'corrective',
      description: 'Replaced front brake pads',
      labour_hours: 2.5,
      total_cost_cents: 9000,
      notes: null,
      parts: [{ part_id: 'p-1', quantity: 2, unit_cost_cents: 4500 }],
    })
    expect(await screen.findByText(/Stock record short: BRK-PAD-01/)).toBeInTheDocument()
  })

  it('"Mark as complete" asks first, and only completes after confirmation', async () => {
    const writes = serveWorkshop()
    signedInAs(technician)
    renderApp('/maintenance')
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /View AA 3-41207/ }))
    const details = await screen.findByRole('dialog', { name: /AA 3-41207/ })

    await user.click(within(details).getByRole('button', { name: 'Mark as complete' }))
    let confirm = await screen.findByRole('dialog', { name: 'Mark this repair as complete?' })
    expect(confirm).toHaveTextContent("clears AA 3-41207's maintenance flag")
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }))
    expect(writes).toEqual([])

    await user.click(within(await screen.findByRole('dialog', { name: /AA 3-41207/ })).getByRole('button', { name: 'Mark as complete' }))
    confirm = await screen.findByRole('dialog', { name: 'Mark this repair as complete?' })
    await user.click(within(confirm).getByRole('button', { name: 'Mark as complete' }))
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]).toMatchObject({ method: 'PUT', path: '/maintenance/r-1', body: { completed_at: expect.any(String) } })
  })

  it('"Save and complete" on a repair needs what failed; the failure is sent with the record (FMS-125)', async () => {
    const writes = serveWorkshop()
    signedInAs(technician)
    renderApp('/maintenance')
    const user = userEvent.setup()
    const drawer = await openLog(user)
    await fillBasics(user, drawer)
    await user.type(within(drawer).getByLabelText('Total cost'), '150')

    await user.click(within(drawer).getByRole('button', { name: 'Save and complete…' }))
    expect(await within(drawer).findByText(/a repair can be completed only with at least one failure/)).toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: 'Complete this repair?' })).not.toBeInTheDocument()

    // Started but not finished: each missing answer is named.
    await user.selectOptions(within(drawer).getByLabelText('Component'), 'brakes')
    await user.click(within(drawer).getByRole('button', { name: 'Save and complete…' }))
    expect(within(drawer).getByLabelText('Failure mode')).toHaveAccessibleDescription('Choose how it failed.')
    expect(within(drawer).getByText('Say whether it was a breakdown or found at planned work.')).toBeInTheDocument()

    await user.selectOptions(within(drawer).getByLabelText('Failure mode'), 'wear')
    await user.click(within(drawer).getByRole('radio', { name: 'Found at planned work' }))
    await user.selectOptions(within(drawer).getByLabelText('How it was found'), 'dvir')
    await user.click(within(drawer).getByRole('button', { name: 'Save and complete…' }))
    const confirm = await screen.findByRole('dialog', { name: 'Complete this repair?' })
    await user.click(within(confirm).getByRole('button', { name: 'Save and complete' }))

    await waitFor(() => expect(writes).toHaveLength(2))
    expect(writes[0].body).toMatchObject({ failures: [{ component: 'brakes', failure_mode: 'wear', unplanned: false, detected_by: 'dvir' }] })
    expect(writes[1]).toMatchObject({ method: 'PUT', path: '/maintenance/r-new' })
  })

  it('other work has no failure step, and an untouched failure is not sent with open work', async () => {
    const writes = serveWorkshop()
    signedInAs(technician)
    renderApp('/maintenance')
    const user = userEvent.setup()
    const drawer = await openLog(user)
    expect(within(drawer).getByRole('group', { name: 'Failure 1' })).toBeInTheDocument()
    await user.selectOptions(within(drawer).getByLabelText('Type of work'), 'preventive')
    expect(within(drawer).queryByRole('group', { name: 'Failure 1' })).not.toBeInTheDocument()

    await user.selectOptions(within(drawer).getByLabelText('Type of work'), 'corrective')
    await fillBasics(user, drawer)
    await user.type(within(drawer).getByLabelText('Total cost'), '150')
    await user.click(within(drawer).getByRole('button', { name: 'Save as open work' }))
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0].body).not.toHaveProperty('failures')
  })

  it('completing an open repair that does not say what failed asks for it, records it, then completes', async () => {
    const writes = serveWorkshop([record({ failures: [] })])
    signedInAs(technician)
    renderApp('/maintenance')
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /View AA 3-41207/ }))
    const details = await screen.findByRole('dialog', { name: /AA 3-41207/ })

    await user.click(within(details).getByRole('button', { name: 'Mark as complete' }))
    expect(await within(details).findByText(/a repair can be completed only with at least one failure/)).toBeInTheDocument()
    expect(writes).toEqual([])

    await user.selectOptions(within(details).getByLabelText('Component'), 'cooling')
    await user.selectOptions(within(details).getByLabelText('Failure mode'), 'leak')
    await user.click(within(details).getByRole('radio', { name: 'Breakdown or found in service' }))
    await user.click(within(details).getByRole('button', { name: 'Mark as complete' }))
    const confirm = await screen.findByRole('dialog', { name: 'Mark this repair as complete?' })
    await user.click(within(confirm).getByRole('button', { name: 'Mark as complete' }))

    await waitFor(() => expect(writes).toHaveLength(2))
    expect(writes[0]).toEqual({
      method: 'POST',
      path: '/maintenance-records/r-1/failures',
      body: { component: 'cooling', failure_mode: 'leak', unplanned: true, detected_by: 'technician' },
    })
    expect(writes[1]).toMatchObject({ method: 'PUT', path: '/maintenance/r-1' })
  })

  it('a record lists what failed', async () => {
    serveWorkshop([record({ status: 'completed', completed_at: '2026-10-09T12:00:00Z' })])
    signedInAs(auditor)
    renderApp('/maintenance?view=completed')
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /View AA 3-41207/ }))
    const details = await screen.findByRole('dialog', { name: /AA 3-41207/ })
    expect(within(details).getByText('Brakes · Worn out')).toBeInTheDocument()
    expect(within(details).getByText('Planned work')).toBeInTheDocument()
  })

  it('completed records are read-only; a correction is a new record', async () => {
    serveWorkshop([record({ status: 'completed', completed_at: '2026-10-09T12:00:00Z' })])
    signedInAs(technician)
    renderApp('/maintenance?view=completed')
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /View AA 3-41207/ }))
    const details = await screen.findByRole('dialog', { name: /AA 3-41207/ })
    expect(within(details).queryByRole('button', { name: 'Mark as complete' })).not.toBeInTheDocument()
    expect(within(details).getByText(/Completed records cannot be changed/)).toBeInTheDocument()

    await user.click(within(details).getByRole('button', { name: 'Log a correction' }))
    const form = await screen.findByRole('dialog', { name: 'Log a correction' })
    expect(within(form).getByRole('combobox', { name: 'Vehicle' })).toHaveValue('AA 3-41207')
    expect(within(form).getByLabelText(/Notes/)).toHaveValue('Correction of record r-1: ')
  })

  it('every form input has a label and errors are announced through live regions', async () => {
    serveWorkshop()
    signedInAs(technician)
    renderApp('/maintenance')
    const user = userEvent.setup()
    const drawer = await openLog(user)
    await user.click(within(drawer).getByRole('button', { name: 'Add part' }))

    for (const field of within(drawer).getAllByRole('textbox').concat(within(drawer).getAllByRole('combobox'))) {
      expect(field).toHaveAccessibleName()
    }
    await user.click(within(drawer).getByRole('button', { name: 'Save as open work' }))
    const vehicle = within(drawer).getByRole('combobox', { name: 'Vehicle' })
    expect(vehicle).toHaveAttribute('aria-invalid', 'true')
    expect(vehicle).toHaveAccessibleDescription('Choose the vehicle that was worked on.')
    const region = document.getElementById(vehicle.getAttribute('aria-describedby')!)!
    expect(region).toHaveAttribute('aria-live', 'polite')
    expect(within(drawer).getByLabelText('Work done')).toHaveAccessibleDescription('Describe the work done.')
  })

  it('a read-only role sees the log but cannot log or complete', async () => {
    serveWorkshop()
    signedInAs(auditor)
    renderApp('/maintenance')
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: /View AA 3-41207/ }))
    const details = await screen.findByRole('dialog', { name: /AA 3-41207/ })
    expect(within(details).queryByRole('button', { name: 'Mark as complete' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Log a repair' })).not.toBeInTheDocument()
  })

  it('renders nothing for a driver', async () => {
    signedInAs(driver)
    renderApp('/maintenance')
    await screen.findByRole('button', { name: 'Notifications' })
    expect(screen.getByRole('main')).toBeEmptyDOMElement()
  })
})

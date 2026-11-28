import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { currentUser, envelope, renderApp, signedInAs } from '@/test/auth'
import { server } from '@/test/msw/server'
import type { MaintenanceRecord, WorkOrder } from './api'

// FMS-130 (docs/work-orders.md): the record drawer's work order: approval, tasks, labour and the outside vendor.

const base = ['maintenance:read', 'maintenance:write', 'maintenance:execute', 'vehicle:read', 'depot:read']
const technician = currentUser(['technician'], base)
const depotAdmin = currentUser(['depot_admin'], [...base, 'maintenance:approve', 'vendor:write'])
const finance = currentUser(['finance_clerk'], ['maintenance:read', 'labour-rate:read', 'vehicle:read'])

function workOrder(overrides: Partial<WorkOrder> = {}): WorkOrder {
  return {
    itemised: false, approval_required: false, approved_by: null, approved_at: null, vendor: null, vendor_invoice_ref: null,
    vendor_cost_cents: 0, labour_cost_cents: null, tasks: [], labour: [], ...overrides,
  }
}

function record(overrides: Partial<MaintenanceRecord> = {}): MaintenanceRecord {
  return {
    id: 'r-1', vehicle_id: 'v-1', registration_number: 'AA 3-41207', maintenance_type: 'preventive', description: 'Gearbox overhaul',
    status: 'open', priority: 'normal', scheduled_at: null, started_at: null, completed_at: null, odometer_km: null, labour_hours: 0,
    total_cost_cents: 2_500_000, parts_cost_cents: 0, workshop: null, notes: null, completed_by: null, service_program: null, warranty_claim: null,
    parts: [], failures: [], work_order: workOrder(), version: 3, created_at: '2026-11-20T07:00:00Z', updated_at: '2026-11-20T07:00:00Z', ...overrides,
  }
}

const page = (data: unknown[]) => HttpResponse.json({ data, meta: { page: 1, page_size: 25, total_items: data.length, total_pages: 1 } })

/** One record behind the repair log; each work order write is recorded and answered with `next`. */
function serve(current: MaintenanceRecord, next: MaintenanceRecord = current) {
  const writes: { method: string; path: string; body: unknown; ifMatch: string | null }[] = []
  const reply = async (request: Request, path: string, status = 200) => {
    const text = await request.text()
    writes.push({ method: request.method, path, body: text ? JSON.parse(text) : null, ifMatch: request.headers.get('If-Match') })
    return HttpResponse.json({ data: next, meta: { request_id: 'r' } }, { status })
  }
  server.use(
    http.get('/api/v1/maintenance', () => page([current])),
    http.get('/api/v1/vehicles', () => page([])),
    http.get('/api/v1/service-due', () => page([])),
    http.get('/api/v1/inventory', () => page([])),
    http.get('/api/v1/maintenance-records/r-1/technicians', () => envelope([{ id: 'u-7', full_name: 'Rahel Tadesse' }])),
    http.get('/api/v1/vendors', () => page([{ id: 've-1', name: 'Gearbox Masters', vendor_type: 'workshop', depot_id: 'd-1', contact_name: null, phone: null, email: null, notes: null, is_active: true, version: 0 }])),
    http.post('/api/v1/maintenance-records/r-1/approve', ({ request }) => reply(request, '/approve')),
    http.patch('/api/v1/maintenance-records/r-1', ({ request }) => reply(request, '')),
    http.post('/api/v1/maintenance-records/r-1/tasks', ({ request }) => reply(request, '/tasks', 201)),
    http.patch('/api/v1/maintenance-records/r-1/tasks/:task', ({ request, params }) => reply(request, `/tasks/${String(params.task)}`)),
    http.post('/api/v1/maintenance-records/r-1/labour', ({ request }) => reply(request, '/labour', 201)),
    http.delete('/api/v1/maintenance-records/r-1/labour/:entry', ({ request, params }) => reply(request, `/labour/${String(params.entry)}`)),
    http.put('/api/v1/maintenance-records/r-1/vendor', ({ request }) => reply(request, '/vendor')),
  )
  return writes
}

async function openRecord(path = '/maintenance') {
  renderApp(path)
  await userEvent.setup().click(await screen.findByRole('button', { name: /View AA 3-41207/ }))
  return screen.findByRole('dialog', { name: /AA 3-41207/ })
}

describe('Work order in the repair log (FMS-130)', () => {
  it('a request above the threshold says it waits for approval, and an approver approves it', async () => {
    const requested = record({ status: 'requested', work_order: workOrder({ approval_required: true }) })
    const writes = serve(requested, record({ status: 'open', work_order: workOrder({ approved_by: 'u-1', approved_at: '2026-11-27T08:00:00Z' }) }))
    signedInAs(depotAdmin)
    const drawer = await openRecord('/maintenance?view=requested')
    expect(within(drawer).getByText('Waiting for approval')).toBeInTheDocument()
    expect(within(drawer).queryByRole('button', { name: 'Start work' })).not.toBeInTheDocument()
    expect(within(drawer).queryByRole('button', { name: 'Mark as complete' })).not.toBeInTheDocument()
    await userEvent.setup().click(within(drawer).getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(writes).toEqual([{ method: 'POST', path: '/approve', body: null, ifMatch: null }]))
  })

  it('a technician cannot approve; a request within the threshold can be started', async () => {
    const writes = serve(record({ status: 'requested', work_order: workOrder({ approval_required: false }) }))
    signedInAs(technician)
    const drawer = await openRecord('/maintenance?view=requested')
    expect(within(drawer).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
    await userEvent.setup().click(within(drawer).getByRole('button', { name: 'Start work' }))
    await waitFor(() => expect(writes).toEqual([{ method: 'PATCH', path: '', body: { status: 'open' }, ifMatch: '"3"' }]))
  })

  it('adds a task, changes its status, and books a technician’s hours on it at the workshop rate', async () => {
    const task = { id: 't-1', description: 'Drain gearbox oil', component: 'transmission', status: 'pending' as const, estimated_hours: 1.5, actual_hours: 0, position: 0, version: 0 }
    const writes = serve(record({ work_order: workOrder({ tasks: [task] }) }))
    signedInAs(technician)
    const drawer = await openRecord()
    const user = userEvent.setup()
    expect(within(drawer).getByText('Drain gearbox oil', { selector: 'span' })).toBeInTheDocument()
    expect(within(drawer).getByText('Transmission and clutch · 1.5 h planned · 0 h booked')).toBeInTheDocument()

    await user.type(within(drawer).getByLabelText('New task'), 'Replace clutch plate')
    await user.type(within(drawer).getByLabelText(/Planned h/), '3')
    await user.click(within(drawer).getByRole('button', { name: 'Add' }))
    await user.selectOptions(within(drawer).getByLabelText('Status of Drain gearbox oil'), 'done')

    await user.selectOptions(await within(drawer).findByLabelText('Technician'), 'u-7')
    await user.type(within(drawer).getByLabelText('Hours'), '2.5')
    await user.selectOptions(within(drawer).getByLabelText(/^Task/), 't-1')
    // Only finance roles set a rate.
    expect(within(drawer).queryByLabelText(/Rate/)).not.toBeInTheDocument()
    await user.click(within(drawer).getByRole('button', { name: 'Book hours' }))

    await waitFor(() => expect(writes).toHaveLength(3))
    expect(writes[0]).toMatchObject({ method: 'POST', path: '/tasks', body: { description: 'Replace clutch plate', estimated_hours: 3 } })
    expect(writes[1]).toMatchObject({ method: 'PATCH', path: '/tasks/t-1', body: { status: 'done' }, ifMatch: '"0"' })
    expect(writes[2].body).toMatchObject({ technician_id: 'u-7', task_id: 't-1', hours: 2.5 })
    expect(writes[2].body).not.toHaveProperty('rate_cents')
  })

  it('sets the outside vendor with its invoice and cost', async () => {
    const writes = serve(record())
    signedInAs(technician)
    const drawer = await openRecord()
    const user = userEvent.setup()
    expect(within(drawer).getByText(/Done in-house/)).toBeInTheDocument()
    await user.click(within(drawer).getByRole('button', { name: 'Add vendor' }))
    await user.selectOptions(await within(drawer).findByLabelText('Vendor'), 've-1')
    await user.type(within(drawer).getByLabelText(/Invoice reference/), 'INV-2207')
    await user.type(within(drawer).getByLabelText('Cost (ETB)'), '8000')
    await user.click(within(drawer).getByRole('button', { name: 'Save vendor' }))
    await waitFor(() => expect(writes).toEqual([{ method: 'PUT', path: '/vendor', body: { vendor_id: 've-1', vendor_invoice_ref: 'INV-2207', vendor_cost_cents: 800_000 }, ifMatch: null }]))
  })

  it('a finance clerk sees rates and labour costs, read-only', async () => {
    serve(
      record({
        total_cost_cents: 1_235_000,
        labour_hours: 5.5,
        work_order: workOrder({
          itemised: true,
          labour_cost_cents: 195_000,
          labour: [{ id: 'l-1', task_id: null, technician_id: 'u-7', technician_name: 'Rahel Tadesse', work_date: '2026-11-24', hours: 3.5, rate_cents: 30_000, cost_cents: 105_000, notes: null }],
        }),
      }),
    )
    signedInAs(finance)
    const drawer = await openRecord()
    expect(within(drawer).getByText('Rahel Tadesse', { selector: 'span' })).toBeInTheDocument()
    expect(within(drawer).getByRole('columnheader', { name: 'Cost' })).toBeInTheDocument()
    expect(within(drawer).getByText('Parts + labour + vendor')).toBeInTheDocument()
    expect(within(drawer).queryByRole('button', { name: 'Book hours' })).not.toBeInTheDocument()
    expect(within(drawer).queryByRole('button', { name: /Remove/ })).not.toBeInTheDocument()
  })

  it('a technician sees the hours but no rates', async () => {
    serve(
      record({
        work_order: workOrder({
          itemised: true,
          labour: [{ id: 'l-1', task_id: null, technician_id: 'u-7', technician_name: 'Rahel Tadesse', work_date: '2026-11-24', hours: 3.5, rate_cents: null, cost_cents: null, notes: null }],
        }),
      }),
    )
    signedInAs(technician)
    const drawer = await openRecord()
    expect(within(drawer).getByText('Rahel Tadesse', { selector: 'span' })).toBeInTheDocument()
    expect(within(drawer).queryByRole('columnheader', { name: 'Cost' })).not.toBeInTheDocument()
  })
})

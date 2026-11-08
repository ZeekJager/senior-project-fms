import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import type { Recall, RecallVehicle } from '@/features/warranty'
import { currentUser, envelope, renderApp, signedInAs } from '@/test/auth'
import { server } from '@/test/msw/server'

const manager = currentUser(['fleet_manager'], ['maintenance:read', 'maintenance:write', 'vehicle:read', 'depot:read'])
const technician = currentUser(['technician'], ['maintenance:read', 'maintenance:write', 'vehicle:read', 'depot:read'])
const reader = currentUser(['fleet_owner'], ['maintenance:read', 'vehicle:read', 'depot:read'])

function recall(overrides: Partial<Recall> = {}): Recall {
  return {
    id: 'r-1',
    campaign_code: '24V-123',
    make: 'Toyota',
    model: 'Hilux',
    year_from: 2018,
    year_to: 2021,
    description: 'Brake master cylinder may leak.',
    remedy: 'Replace the master cylinder.',
    issued_on: '2026-10-20',
    vehicles: { total: 3, open: 2, scheduled: 0, completed: 1 },
    version: 1,
    created_at: '2026-10-21T08:00:00Z',
    updated_at: '2026-10-21T08:00:00Z',
    ...overrides,
  }
}

function underRecall(overrides: Partial<RecallVehicle> = {}): RecallVehicle {
  return {
    recall_id: 'r-1',
    campaign_code: '24V-123',
    description: 'Brake master cylinder may leak.',
    remedy: 'Replace the master cylinder.',
    vehicle_id: 'v-1',
    registration_number: 'AA-3-12345',
    status: 'open',
    maintenance_record_id: null,
    completed_at: null,
    notes: null,
    matched_at: '2026-10-21T08:00:00Z',
    updated_at: '2026-10-21T08:00:00Z',
    ...overrides,
  }
}

/** A fake recalls API, recording the writes. */
function serveRecalls(recalls: Recall[], vehicles: RecallVehicle[] = []) {
  const writes: { method: string; path: string; body: Record<string, unknown>; ifMatch: string | null }[] = []
  server.use(
    http.get('/api/v1/recalls', () => HttpResponse.json({ data: recalls, meta: { page: 1, page_size: 50, total_items: recalls.length, total_pages: 1 } })),
    http.get('/api/v1/recalls/:id/vehicles', () => HttpResponse.json({ data: vehicles, meta: { page: 1, page_size: 100, total_items: vehicles.length, total_pages: 1 } })),
    http.post('/api/v1/recalls', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>
      writes.push({ method: 'POST', path: '/recalls', body, ifMatch: null })
      if (body.campaign_code === 'TAKEN') {
        return HttpResponse.json({ error: { code: 'CONFLICT_DUPLICATE', message: 'Taken.', details: [{ field: 'campaign_code', reason: 'duplicate' }] } }, { status: 409 })
      }
      return envelope(recall({ ...(body as Partial<Recall>), id: 'r-2', vehicles: { total: 4, open: 4, scheduled: 0, completed: 0 } }))
    }),
    http.patch('/api/v1/recalls/:id', async ({ request, params }) => {
      const body = (await request.json()) as Record<string, unknown>
      writes.push({ method: 'PATCH', path: `/recalls/${params.id}`, body, ifMatch: request.headers.get('If-Match') })
      return envelope({ ...recalls[0], ...body, version: 2 })
    }),
    http.patch('/api/v1/recalls/:id/vehicles/:vehicleId', async ({ request, params }) => {
      const body = (await request.json()) as Record<string, unknown>
      writes.push({ method: 'PATCH', path: `/recalls/${params.id}/vehicles/${params.vehicleId}`, body, ifMatch: null })
      return envelope(underRecall({ status: 'completed', completed_at: '2026-11-08T09:00:00Z' }))
    }),
  )
  return { writes }
}

async function openRecalls(user = manager) {
  signedInAs(user)
  renderApp('/recalls')
  return screen.findByRole('heading', { name: 'Recalls', level: 1 }).then(() => screen.findByRole('table', { name: 'Recalls' }))
}

describe('Recalls (S-35, FMS-133)', () => {
  it('lists each recall with what it applies to and where its vehicles stand, and opens its vehicles', async () => {
    serveRecalls([recall()], [underRecall(), underRecall({ vehicle_id: 'v-2', registration_number: 'AA-3-99999', status: 'completed', completed_at: '2026-11-01T09:00:00Z' })])
    const table = await openRecalls()
    const row = (await within(table).findByText('24V-123')).closest('tr') as HTMLElement
    expect(row).toHaveTextContent('Toyota Hilux, 2018 to 2021')
    expect(row).toHaveTextContent('Brake master cylinder may leak.')
    expect(within(row).getByText('2 open')).toBeInTheDocument()
    expect(within(row).getByText('1 done')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(within(row).getByRole('button', { name: 'View 24V-123' }))
    const drawer = await screen.findByRole('dialog', { name: '24V-123' })
    expect(within(drawer).getByText('Replace the master cylinder.')).toBeInTheDocument()
    expect(await within(drawer).findByRole('link', { name: 'AA-3-12345' })).toHaveAttribute('href', '/vehicles/v-1?section=warranty')
    // Only the open one can be marked done.
    expect(within(drawer).getAllByRole('button', { name: /^Mark 24V-123 done/ })).toHaveLength(1)
  })

  it('marks a vehicle done from the recall', async () => {
    const { writes } = serveRecalls([recall()], [underRecall()])
    await openRecalls(technician)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'View 24V-123' }))
    await user.click(await screen.findByRole('button', { name: 'Mark 24V-123 done on AA-3-12345' }))
    await user.click(within(await screen.findByRole('dialog', { name: 'Mark 24V-123 done?' })).getByRole('button', { name: 'Mark done' }))
    await waitFor(() => expect(writes).toEqual([{ method: 'PATCH', path: '/recalls/r-1/vehicles/v-1', body: { status: 'completed' }, ifMatch: null }]))
  })

  it('issues a recall: checks first, sends one year range, says a taken code under its field', async () => {
    const { writes } = serveRecalls([])
    await openRecalls()
    const user = userEvent.setup()
    await user.click((await screen.findAllByRole('button', { name: 'Issue recall' }))[0])
    const drawer = await screen.findByRole('dialog', { name: 'Issue recall' })
    await user.click(within(drawer).getByRole('button', { name: 'Issue recall' }))
    expect(within(drawer).getByText('A model year, e.g. 2018.')).toBeInTheDocument()
    expect(writes).toHaveLength(0)

    await user.type(within(drawer).getByLabelText('Campaign code'), 'TAKEN')
    await user.type(within(drawer).getByLabelText('Make'), 'Isuzu')
    await user.type(within(drawer).getByLabelText('Model'), 'NPR')
    await user.type(within(drawer).getByLabelText('First model year'), '2019')
    await user.type(within(drawer).getByLabelText('Defect'), 'Steering may lock.')
    await user.click(within(drawer).getByRole('button', { name: 'Issue recall' }))
    expect(await within(drawer).findByText('A recall with this campaign code is already on record.')).toBeInTheDocument()

    await user.clear(within(drawer).getByLabelText('Campaign code'))
    await user.type(within(drawer).getByLabelText('Campaign code'), '25V-001')
    await user.click(within(drawer).getByRole('button', { name: 'Issue recall' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Issue recall' })).not.toBeInTheDocument())
    expect(writes[1]).toEqual({
      method: 'POST',
      path: '/recalls',
      body: { campaign_code: '25V-001', make: 'Isuzu', model: 'NPR', year_from: 2019, year_to: 2019, description: 'Steering may lock.', remedy: null, issued_on: null },
      ifMatch: null,
    })
    expect(await screen.findByText('25V-001: 4 vehicles listed as open.')).toBeInTheDocument()
  })

  it('edits only what changed, with If-Match', async () => {
    const { writes } = serveRecalls([recall()], [])
    await openRecalls()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'View 24V-123' }))
    await user.click(await screen.findByRole('button', { name: 'Edit recall' }))
    const drawer = await screen.findByRole('dialog', { name: 'Edit 24V-123' })
    const last = within(drawer).getByLabelText(/^Last model year/)
    await user.clear(last)
    await user.type(last, '2022')
    await user.click(within(drawer).getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(writes).toEqual([{ method: 'PATCH', path: '/recalls/r-1', body: { year_to: 2022 }, ifMatch: '"1"' }]))
  })

  it('a depot technician cannot issue or edit one; a reader cannot mark work done', async () => {
    serveRecalls([recall()], [underRecall()])
    await openRecalls(technician)
    expect(screen.queryByRole('button', { name: 'Issue recall' })).not.toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'View 24V-123' }))
    await screen.findByRole('link', { name: 'AA-3-12345' })
    expect(screen.queryByRole('button', { name: 'Edit recall' })).not.toBeInTheDocument()
  })

  it('a reader sees the recalls without any write button', async () => {
    serveRecalls([recall()], [underRecall()])
    await openRecalls(reader)
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'View 24V-123' }))
    await screen.findByRole('link', { name: 'AA-3-12345' })
    expect(screen.queryByRole('button', { name: /Mark 24V-123 done/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Issue recall' })).not.toBeInTheDocument()
  })

  it('says when there are none', async () => {
    serveRecalls([])
    signedInAs(technician)
    renderApp('/recalls')
    expect(await screen.findByText('No recalls on record')).toBeInTheDocument()
  })
})

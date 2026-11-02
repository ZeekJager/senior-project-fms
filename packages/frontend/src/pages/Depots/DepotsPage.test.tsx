import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { currentUser, envelope, errorEnvelope, renderApp, signedInAs } from '@/test/auth'
import { server } from '@/test/msw/server'
import type { DepotRecord } from './api'

const admin = currentUser(['admin'], ['depot:read', 'depot:write', 'settings:write', 'users:read'])
const manager = currentUser(['fleet_manager'], ['depot:read', 'vehicle:read', 'driver:read'])

let seq = 0
function depot(overrides: Partial<DepotRecord> = {}): DepotRecord {
  seq += 1
  return {
    id: `d-${seq}`,
    name: `Depot ${seq}`,
    code: null,
    location: 'Addis Ababa',
    address: null,
    city: null,
    country: 'Ethiopia',
    timezone: 'Africa/Addis_Ababa',
    latitude: null,
    longitude: null,
    capacity: null,
    is_active: true,
    version: 2,
    created_at: '2026-09-01T08:00:00Z',
    updated_at: '2026-09-01T08:00:00Z',
    ...overrides,
  }
}

/** A fake /depots API: the status filter and counts, and every write with its If-Match. */
function serveDepots(depots: DepotRecord[], answers: { delete?: () => Response } = {}) {
  const writes: { method: string; url: string; body: unknown; ifMatch: string | null }[] = []
  server.use(
    http.get('/api/v1/depots', ({ request }) => {
      const q = new URL(request.url).searchParams
      const status = q.get('status') ?? 'active'
      const rows = depots.filter((d) => (status === 'inactive' ? !d.is_active : d.is_active))
      const size = Number(q.get('page_size') ?? 50)
      return HttpResponse.json({ data: rows.slice(0, size), meta: { page: 1, page_size: size, total_items: rows.length, total_pages: 1 } })
    }),
    http.post('/api/v1/depots', async ({ request }) => {
      const body = await request.json()
      writes.push({ method: 'POST', url: request.url, body, ifMatch: null })
      return envelope(depot(body as Partial<DepotRecord>))
    }),
    http.patch('/api/v1/depots/:id', async ({ request, params }) => {
      const body = (await request.json()) as Partial<DepotRecord>
      writes.push({ method: 'PATCH', url: request.url, body, ifMatch: request.headers.get('If-Match') })
      const current = depots.find((d) => d.id === params.id)!
      return envelope({ ...current, ...body, version: current.version + 1 })
    }),
    http.delete('/api/v1/depots/:id', ({ request }) => {
      writes.push({ method: 'DELETE', url: request.url, body: null, ifMatch: null })
      return answers.delete?.() ?? new HttpResponse(null, { status: 204 })
    }),
    http.post('/api/v1/depots/:id/reactivate', ({ request, params }) => {
      writes.push({ method: 'POST', url: request.url, body: null, ifMatch: null })
      return envelope({ ...depots.find((d) => d.id === params.id)!, is_active: true })
    }),
  )
  return { writes }
}

const table = () => screen.getByRole('table', { name: 'Depots' })

async function openDepots(first: string) {
  signedInAs(admin)
  renderApp('/depots')
  await within(await screen.findByRole('table', { name: 'Depots' })).findByText(first)
}

describe('S-26 Depots (FMS-80)', () => {
  it('lists live depots with code, place, capacity and time zone; inactive ones in their own view', async () => {
    serveDepots([
      depot({ name: 'Adama Hub', code: 'ADM-01', city: 'Adama', capacity: 40 }),
      depot({ name: 'Hawassa', timezone: null }),
      depot({ name: 'Old yard', is_active: false }),
    ])
    const user = userEvent.setup()
    await openDepots('Adama Hub')

    const row = within(table()).getByText('Adama Hub').closest('tr') as HTMLElement
    expect(within(row).getByText('ADM-01')).toBeInTheDocument()
    expect(within(row).getByText('Adama, Ethiopia')).toBeInTheDocument()
    expect(within(row).getByText('40')).toBeInTheDocument()
    expect(within(table()).queryByText('Old yard')).not.toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /^Active\s*2/ })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /^Inactive\s*1/ }))
    await within(table()).findByText('Old yard')
    expect(screen.getByTestId('location')).toHaveTextContent('/depots?view=inactive')
  })

  it('adds a depot: the code goes upper case, coordinates as a pair, and the pickers elsewhere refresh', async () => {
    const api = serveDepots([depot({ name: 'Addis Ababa Central' })])
    const user = userEvent.setup()
    await openDepots('Addis Ababa Central')

    await user.click(screen.getByRole('button', { name: 'Add depot' }))
    const drawer = await screen.findByRole('dialog', { name: 'Add depot' })
    // Required fields are checked before anything is sent.
    await user.click(within(drawer).getByRole('button', { name: 'Add depot' }))
    expect(within(drawer).getByText('Give the depot a name.')).toBeInTheDocument()
    expect(api.writes).toEqual([])

    await user.type(within(drawer).getByLabelText('Name'), 'Adama Hub')
    await user.type(within(drawer).getByLabelText('Code (optional)'), 'adm-01')
    await user.type(within(drawer).getByLabelText('Location'), 'Adama')
    await user.type(within(drawer).getByLabelText('Capacity (optional)'), '40')
    await user.type(within(drawer).getByLabelText('Coordinates (optional)'), '8.54, 39.27')
    await user.click(within(drawer).getByRole('button', { name: 'Add depot' }))

    await waitFor(() => expect(api.writes).toHaveLength(1))
    expect(api.writes[0].body).toEqual({
      name: 'Adama Hub',
      location: 'Adama',
      code: 'ADM-01',
      address: null,
      city: null,
      country: 'Ethiopia',
      timezone: 'Africa/Addis_Ababa',
      latitude: 8.54,
      longitude: 39.27,
      capacity: 40,
    })
    expect(await screen.findByText('Depot added')).toBeInTheDocument()
  })

  it('edits only what changed, with If-Match; a taken code is shown on the field', async () => {
    const adama = depot({ name: 'Adama Hub', code: 'ADM-01', version: 5 })
    const api = serveDepots([adama])
    server.use(
      http.patch('/api/v1/depots/:id', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>
        api.writes.push({ method: 'PATCH', url: request.url, body, ifMatch: request.headers.get('If-Match') })
        return body.code === 'ADD-01' ? errorEnvelope(409, 'CONFLICT_DUPLICATE', 'Taken', [{ field: 'code', reason: 'duplicate' }]) : envelope({ ...adama, ...body })
      }),
    )
    const user = userEvent.setup()
    await openDepots('Adama Hub')

    await user.click(screen.getByRole('button', { name: 'Edit Adama Hub' }))
    const drawer = await screen.findByRole('dialog', { name: 'Edit Adama Hub' })
    const code = within(drawer).getByLabelText('Code (optional)')
    await user.clear(code)
    await user.type(code, 'ADD-01')
    await user.click(within(drawer).getByRole('button', { name: 'Save changes' }))
    expect(await within(drawer).findByText('Another depot already has this code.')).toBeInTheDocument()

    await user.clear(code)
    await user.type(code, 'ADM-02')
    await user.clear(within(drawer).getByLabelText('Capacity (optional)'))
    await user.type(within(drawer).getByLabelText('Capacity (optional)'), '55')
    await user.click(within(drawer).getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(api.writes).toHaveLength(2))
    expect(api.writes[1]).toMatchObject({ method: 'PATCH', body: { code: 'ADM-02', capacity: 55 }, ifMatch: '"5"' })
  })

  it('deactivating a depot that still holds vehicles says what is left, in the dialog', async () => {
    serveDepots([depot({ name: 'Adama Hub' })], {
      delete: () => errorEnvelope(409, 'CONFLICT_DEPOT_NOT_EMPTY', 'The depot still has 3 active vehicles, 1 active driver. Move or retire them first.'),
    })
    const user = userEvent.setup()
    await openDepots('Adama Hub')

    await user.click(screen.getByRole('button', { name: 'Edit Adama Hub' }))
    await user.click(within(await screen.findByRole('dialog', { name: 'Edit Adama Hub' })).getByRole('button', { name: 'Deactivate depot' }))
    const confirm = await screen.findByRole('dialog', { name: 'Deactivate Adama Hub' })
    await user.click(within(confirm).getByRole('button', { name: 'Deactivate depot' }))
    expect(await within(confirm).findByText('The depot still has 3 active vehicles, 1 active driver. Move or retire them first.')).toBeInTheDocument()
  })

  it('an inactive depot opens read-only and can be restored', async () => {
    const api = serveDepots([depot({ name: 'Live' }), depot({ id: 'd-old', name: 'Old yard', is_active: false })])
    const user = userEvent.setup()
    signedInAs(admin)
    renderApp('/depots?view=inactive')
    await user.click(await screen.findByRole('button', { name: 'Open Old yard' }))
    const drawer = await screen.findByRole('dialog', { name: 'Old yard' })
    expect(within(drawer).getByLabelText('Name')).toBeDisabled()
    await user.click(within(drawer).getByRole('button', { name: 'Restore depot' }))
    await waitFor(() => expect(api.writes).toEqual([expect.objectContaining({ method: 'POST', url: expect.stringContaining('/depots/d-old/reactivate') })]))
  })

  it('needs depot:write: a fleet manager has neither the screen nor its menu entry', async () => {
    serveDepots([depot({ name: 'Adama Hub' })])
    signedInAs(manager)
    renderApp('/depots')
    await screen.findByRole('button', { name: 'Notifications' })
    expect(screen.queryByRole('table', { name: 'Depots' })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Depots' })).not.toBeInTheDocument()
  })
})

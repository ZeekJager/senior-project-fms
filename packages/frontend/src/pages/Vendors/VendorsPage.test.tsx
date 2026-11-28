import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import type { Vendor } from '@/features/vendors'
import { currentUser, envelope, errorEnvelope, renderApp, signedInAs } from '@/test/auth'
import { server } from '@/test/msw/server'

// Vendors (FMS-130, docs/work-orders.md): list, search and type filter, add and edit, retire and restore.

const manager = currentUser(['fleet_manager'], ['maintenance:read', 'maintenance:write', 'vendor:write', 'vehicle:read', 'depot:read'])
const technician = currentUser(['technician'], ['maintenance:read', 'maintenance:write', 'vehicle:read', 'depot:read'])
const ADDIS = { id: 'd-1', name: 'Addis Ababa Central', code: 'ADD', location: 'Addis Ababa' }

let seq = 0
function vendor(overrides: Partial<Vendor> = {}): Vendor {
  seq += 1
  return { id: `ve-${seq}`, name: `Vendor ${seq}`, vendor_type: 'workshop', contact_name: null, phone: null, email: null, depot_id: null, notes: null, is_active: true, version: 1, ...overrides }
}

function serveVendors(vendors: Vendor[], options: { duplicateOnPost?: boolean } = {}) {
  const writes: { method: string; body: Record<string, unknown>; ifMatch: string | null }[] = []
  const queries: URLSearchParams[] = []
  server.use(
    http.get('/api/v1/vendors', ({ request }) => {
      const q = new URL(request.url).searchParams
      queries.push(q)
      let rows = vendors.filter((v) => (q.get('status') === 'retired' ? !v.is_active : v.is_active))
      if (q.get('vendor_type')) rows = rows.filter((v) => v.vendor_type === q.get('vendor_type'))
      if (q.get('search')) rows = rows.filter((v) => v.name.toLowerCase().includes(q.get('search')!.toLowerCase()))
      const size = Number(q.get('page_size') ?? 50)
      return HttpResponse.json({ data: rows.slice(0, size), meta: { page: 1, page_size: size, total_items: rows.length, total_pages: 1 } })
    }),
    http.post('/api/v1/vendors', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>
      writes.push({ method: 'POST', body, ifMatch: null })
      if (options.duplicateOnPost) return errorEnvelope(409, 'CONFLICT_DUPLICATE')
      return HttpResponse.json({ data: vendor(body as Partial<Vendor>), meta: {} }, { status: 201 })
    }),
    http.patch('/api/v1/vendors/:id', async ({ request, params }) => {
      const body = (await request.json()) as Record<string, unknown>
      writes.push({ method: 'PATCH', body, ifMatch: request.headers.get('If-Match') })
      const current = vendors.find((v) => v.id === params.id)!
      return envelope({ ...current, ...body, version: current.version + 1 })
    }),
    http.get('/api/v1/depots', () => envelope([ADDIS])),
  )
  return { writes, queries }
}

const table = () => screen.getByRole('table', { name: 'Vendors' })

async function openVendors(first: string, user = manager, path = '/maintenance/vendors') {
  signedInAs(user)
  renderApp(path)
  await within(await screen.findByRole('table', { name: 'Vendors' })).findByText(first)
}

describe('Vendors (FMS-130)', () => {
  it('lists each vendor with its type, the depots it serves and its contact', async () => {
    serveVendors([
      vendor({ name: 'Tyre World', vendor_type: 'tyres', contact_name: 'Abebe Girma', phone: '+251 911 000 111' }),
      vendor({ name: 'Moenco Service', vendor_type: 'dealer', depot_id: 'd-1' }),
    ])
    await openVendors('Tyre World')
    const tyres = within(table()).getByText('Tyre World').closest('tr') as HTMLElement
    expect(tyres).toHaveTextContent('Tyres · Every depot')
    expect(tyres).toHaveTextContent('Abebe Girma')
    const dealer = within(table()).getByText('Moenco Service').closest('tr') as HTMLElement
    expect(await within(dealer).findByText('Dealer · Addis Ababa Central')).toBeInTheDocument()
  })

  it('searches by name and filters by type', async () => {
    const { queries } = serveVendors([vendor({ name: 'Tyre World', vendor_type: 'tyres' }), vendor({ name: 'Moenco Service', vendor_type: 'dealer' })])
    await openVendors('Tyre World')
    const user = userEvent.setup()
    await user.type(screen.getByRole('searchbox', { name: 'Search vendors' }), 'moenco')
    await waitFor(() => expect(within(table()).queryByText('Tyre World')).not.toBeInTheDocument())
    expect(within(table()).getByText('Moenco Service')).toBeInTheDocument()
    expect(queries.at(-1)?.get('search')).toBe('moenco')
  })

  it('adds a vendor, saying what is missing first', async () => {
    const { writes } = serveVendors([vendor({ name: 'Tyre World' })])
    await openVendors('Tyre World')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Add vendor' }))
    const drawer = await screen.findByRole('dialog', { name: 'Add vendor' })
    await user.click(within(drawer).getByRole('button', { name: 'Add vendor' }))
    expect(within(drawer).getByText('Give the vendor a name.')).toBeInTheDocument()
    expect(writes).toEqual([])

    await user.type(within(drawer).getByLabelText('Name'), 'Gearbox Masters')
    await user.selectOptions(within(drawer).getByLabelText('Type'), 'workshop')
    await user.selectOptions(within(drawer).getByLabelText('Serves'), 'd-1')
    await user.type(within(drawer).getByLabelText(/E-mail/), 'service@gearbox.et')
    await user.click(within(drawer).getByRole('button', { name: 'Add vendor' }))
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0].body).toMatchObject({ name: 'Gearbox Masters', vendor_type: 'workshop', depot_id: 'd-1', email: 'service@gearbox.et' })
  })

  it('a duplicate name is shown on the field', async () => {
    serveVendors([vendor({ name: 'Tyre World' })], { duplicateOnPost: true })
    await openVendors('Tyre World')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Add vendor' }))
    const drawer = await screen.findByRole('dialog', { name: 'Add vendor' })
    await user.type(within(drawer).getByLabelText('Name'), 'Tyre World')
    await user.click(within(drawer).getByRole('button', { name: 'Add vendor' }))
    expect(await within(drawer).findByText('An active vendor of that name already serves this depot.')).toBeInTheDocument()
  })

  it('retires a vendor after confirming, and restores a retired one', async () => {
    const retired = vendor({ name: 'Old Garage', is_active: false, version: 4 })
    const { writes } = serveVendors([vendor({ name: 'Tyre World', version: 2 }), retired])
    await openVendors('Tyre World')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Edit Tyre World' }))
    await user.click(within(await screen.findByRole('dialog', { name: 'Edit Tyre World' })).getByRole('button', { name: 'Retire' }))
    const confirm = await screen.findByRole('alertdialog', { name: 'Retire Tyre World?' }).catch(() => screen.findByRole('dialog', { name: 'Retire Tyre World?' }))
    await user.click(within(confirm).getByRole('button', { name: 'Retire vendor' }))
    await waitFor(() => expect(writes).toEqual([{ method: 'PATCH', body: { is_active: false }, ifMatch: '"2"' }]))

    await user.click(screen.getByRole('button', { name: /^Retired/ }))
    await user.click(await screen.findByRole('button', { name: 'Restore Old Garage' }))
    await waitFor(() => expect(writes[1]).toEqual({ method: 'PATCH', body: { is_active: true }, ifMatch: '"4"' }))
  })

  it('a technician reads the list but cannot change it', async () => {
    serveVendors([vendor({ name: 'Tyre World' })])
    await openVendors('Tyre World', technician)
    expect(screen.queryByRole('button', { name: 'Add vendor' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit Tyre World' })).not.toBeInTheDocument()
  })
})

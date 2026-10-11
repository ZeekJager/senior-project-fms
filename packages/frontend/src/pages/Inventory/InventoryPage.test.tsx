import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { currentUser, envelope, errorEnvelope, renderApp, signedInAs } from '@/test/auth'
import { server } from '@/test/msw/server'
import type { Part } from './api'

const depotAdmin = currentUser(['depot_admin'], ['inventory:read', 'inventory:write', 'depot:read'])
const reader = currentUser(['fleet_owner'], ['inventory:read', 'depot:read'])
const driver = currentUser(['driver'], ['vehicle:read', 'trip:execute'])

let seq = 0
function part(overrides: Partial<Part> = {}): Part {
  seq += 1
  const stock = overrides.stock_quantity ?? 20
  const threshold = overrides.reorder_threshold ?? 5
  return {
    id: `p-${seq}`,
    part_number: `PN-${seq}`,
    name: `Part ${seq}`,
    description: null,
    depot_id: null,
    stock_quantity: stock,
    reorder_threshold: threshold,
    below_reorder: stock <= threshold,
    stock_status: stock <= 0 ? 'out' : stock <= threshold ? 'low' : 'ok',
    is_active: true,
    version: 0,
    updated_at: '2026-10-10T08:00:00Z',
    ...overrides,
  }
}

/** A fake GET /inventory with the low/status filters and counts; records list queries. */
function serveParts(parts: Part[]) {
  const queries: URLSearchParams[] = []
  server.use(
    http.get('/api/v1/inventory', ({ request }) => {
      const q = new URL(request.url).searchParams
      if (q.get('page_size') !== '1') queries.push(q)
      let rows = parts
      if (q.get('below_reorder') === 'true') rows = rows.filter((p) => p.below_reorder)
      if (q.get('stock_status')) rows = rows.filter((p) => p.stock_status === q.get('stock_status'))
      const size = Number(q.get('page_size') ?? 50)
      return HttpResponse.json({ data: rows.slice(0, size), meta: { page: 1, page_size: size, total_items: rows.length, total_pages: 1 } })
    }),
    http.get('/api/v1/depots', () => envelope([{ id: 'd-1', name: 'Addis Ababa Central', code: 'ADD', location: 'Addis Ababa' }])),
  )
  return { queries }
}

const table = () => screen.getByRole('table', { name: 'Spare parts' })
const rowOf = (name: string) => within(table()).getByText(name).closest('tr') as HTMLElement

async function openInventory(firstName: string, user = depotAdmin) {
  signedInAs(user)
  renderApp('/inventory')
  await within(await screen.findByRole('table', { name: 'Spare parts' })).findByText(firstName)
}

describe('Spare parts console (S-09)', () => {
  it('shows a red OUT OF STOCK badge at 0 and an amber LOW badge from 1 to the reorder level', async () => {
    const out = part({ name: 'Brake pad set', stock_quantity: 0 })
    const low = part({ name: 'Oil filter', stock_quantity: 5, reorder_threshold: 5 })
    const lowest = part({ name: 'Air filter', stock_quantity: 1, reorder_threshold: 5 })
    const ok = part({ name: 'Wiper blade', stock_quantity: 6, reorder_threshold: 5 })
    serveParts([out, low, lowest, ok])
    await openInventory('Brake pad set')

    // [0]: the status column (the copy under the name is for phones).
    const badge = (name: string) => within(rowOf(name)).getAllByText(/OUT OF STOCK|LOW|OK/)[0]
    expect(badge('Brake pad set')).toHaveTextContent('OUT OF STOCK')
    expect(badge('Brake pad set').closest('span.rounded-full')).toHaveClass('bg-danger-soft')
    for (const name of ['Oil filter', 'Air filter']) {
      expect(badge(name)).toHaveTextContent(/^LOW$/)
      expect(badge(name).closest('span.rounded-full')).toHaveClass('bg-warning-soft')
    }
    expect(badge('Wiper blade')).toHaveTextContent(/^OK$/)
  })

  it('"Show low stock only" filters the table without a page reload', async () => {
    const api = serveParts([part({ name: 'Brake pad set', stock_quantity: 0 }), part({ name: 'Wiper blade', stock_quantity: 40 })])
    const user = userEvent.setup()
    await openInventory('Wiper blade')

    await user.click(screen.getByRole('switch', { name: 'Show low stock only' }))
    await waitFor(() => expect(within(table()).queryByText('Wiper blade')).not.toBeInTheDocument())
    expect(within(table()).getByText('Brake pad set')).toBeInTheDocument()
    expect(screen.getByTestId('location')).toHaveTextContent('/inventory?low=1')
    expect(api.queries.at(-1)?.get('below_reorder')).toBe('true')
    expect(screen.getByRole('heading', { name: 'Spare parts' })).toBeInTheDocument()
  })

  it('a negative adjustment asks for confirmation, and a 409 from the API is shown inline', async () => {
    const pads = part({ name: 'Brake pad set', stock_quantity: 50 })
    serveParts([pads])
    let sent: unknown
    server.use(
      http.post(`/api/v1/inventory/${pads.id}/adjust`, async ({ request }) => {
        sent = await request.json()
        return errorEnvelope(409, 'CONFLICT_INSUFFICIENT_STOCK', 'Only 50 in stock: cannot take out 100.', [{ field: 'quantity', reason: 'insufficient_stock' }])
      }),
    )
    const user = userEvent.setup()
    await openInventory('Brake pad set')

    await user.click(within(rowOf('Brake pad set')).getByRole('button', { name: 'Adjust stock of Brake pad set' }))
    let dialog = await screen.findByRole('dialog', { name: 'Adjust stock · Brake pad set' })
    await user.click(within(dialog).getByRole('radio', { name: 'Remove stock' }))
    await user.type(within(dialog).getByLabelText('Quantity to remove'), '100')
    await user.click(within(dialog).getByRole('button', { name: 'Stock take correction' }))
    expect(within(dialog).getByText(/more than the stock on record/)).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Remove from stock…' }))

    const confirm = await screen.findByRole('dialog', { name: 'Remove 100 × Brake pad set?' })
    expect(sent).toBeUndefined()
    await user.click(within(confirm).getByRole('button', { name: 'Remove from stock' }))

    dialog = await screen.findByRole('dialog', { name: 'Adjust stock · Brake pad set' })
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Only 50 in stock: cannot take out 100.')
    expect(sent).toEqual({ quantity: -100, reason: 'Stock take correction' })
  })

  it('adding stock needs no confirmation and needs a reason', async () => {
    const pads = part({ name: 'Brake pad set', stock_quantity: 2 })
    serveParts([pads])
    let sent: unknown
    server.use(
      http.post(`/api/v1/inventory/${pads.id}/adjust`, async ({ request }) => {
        sent = await request.json()
        return envelope({ ...pads, stock_quantity: 22 })
      }),
    )
    const user = userEvent.setup()
    await openInventory('Brake pad set')
    await user.click(within(rowOf('Brake pad set')).getByRole('button', { name: 'Adjust stock of Brake pad set' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText('Quantity to add'), '20')
    await user.click(within(dialog).getByRole('button', { name: 'Add to stock' }))
    expect(within(dialog).getByText(/Say why/)).toBeInTheDocument()
    expect(sent).toBeUndefined()

    await user.click(within(dialog).getByRole('button', { name: 'Delivery received' }))
    await user.click(within(dialog).getByRole('button', { name: 'Add to stock' }))
    await waitFor(() => expect(sent).toEqual({ quantity: 20, reason: 'Delivery received' }))
    expect(await screen.findByText('Stock added')).toBeInTheDocument()
  })

  it('shows no prices, and a read-only role cannot adjust', async () => {
    serveParts([part({ name: 'Brake pad set' })])
    await openInventory('Brake pad set', reader)
    expect(screen.queryByText(/ETB|price|cost/i)).not.toBeInTheDocument()
    expect(within(rowOf('Brake pad set')).queryByRole('button', { name: /Adjust/ })).not.toBeInTheDocument()
    expect(within(rowOf('Brake pad set')).getByRole('button', { name: 'Stock history of Brake pad set' })).toBeInTheDocument()
  })

  it('renders nothing for a driver', async () => {
    signedInAs(driver)
    renderApp('/inventory')
    await screen.findByRole('button', { name: 'Notifications' })
    expect(screen.getByRole('main')).toBeEmptyDOMElement()
  })

  it('says so when nothing is low', async () => {
    serveParts([part({ name: 'Wiper blade', stock_quantity: 40 })])
    const user = userEvent.setup()
    await openInventory('Wiper blade')
    await user.click(screen.getByRole('switch', { name: 'Show low stock only' }))
    expect(await screen.findByText('Nothing low on stock here')).toBeInTheDocument()
  })
})

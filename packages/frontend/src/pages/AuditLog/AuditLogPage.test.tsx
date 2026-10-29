import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { currentUser, renderApp, signedInAs } from '@/test/auth'
import { server } from '@/test/msw/server'
import type { AuditEntry } from './describe'

const compliance = currentUser(['compliance_officer'], ['audit:read', 'users:read', 'vehicle:read', 'depot:read'])
const fleetManager = currentUser(['fleet_manager'], ['vehicle:read', 'depot:read', 'users:read'])

const HANNA = { type: 'user' as const, id: '7b0e2d0a-1111-4111-8111-111111111111', full_name: 'Hanna Tesfaye', email: 'hanna@fleet.demo' }
const FUEL_LOG = '5c1f7d2e-2222-4222-8222-222222222222'
const REQUEST = '9d3a8b4c-3333-4333-8333-333333333333'

function entry(overrides: Partial<AuditEntry>): AuditEntry {
  return {
    id: overrides.id ?? String(Math.random()),
    occurred_at: '2026-10-28T11:05:09.000000Z',
    action: 'UPDATE',
    result: 'success',
    actor: HANNA,
    entity_type: 'fuel.fuel_logs',
    entity_id: FUEL_LOG,
    correlation_id: REQUEST,
    request_source: { channel: 'web', ip: '10.0.0.7', user_agent: 'Mozilla/5.0' },
    old_values: null,
    new_values: null,
    details: {},
    ...overrides,
  }
}

const fuelCorrection = entry({
  id: 'fuel',
  old_values: { public_id: FUEL_LOG, quantity_ml: 40_000, total_cost_cents: 380_050, station_name: 'Total Bole', odometer_km: 87_000, updated_at: '2026-10-27T08:00:00Z' },
  new_values: { public_id: FUEL_LOG, quantity_ml: 42_500, total_cost_cents: 403_800, station_name: 'Total Bole', odometer_km: 87_000, updated_at: '2026-10-28T11:05:09Z' },
})
const denied = entry({ id: 'denied', action: 'access.denied', result: 'denied', entity_type: null, entity_id: null, details: { permission: 'users:write' } })

/** Serves GET /audit-logs, recording each query; `pages` answers by cursor (none: the first page). */
function serve(pages: Record<string, { entries: AuditEntry[]; next: string | null }>) {
  const queries: URLSearchParams[] = []
  server.use(
    http.get('/api/v1/audit-logs', ({ request }) => {
      const q = new URL(request.url).searchParams
      queries.push(q)
      const page = pages[q.get('cursor') ?? ''] ?? { entries: [], next: null }
      return HttpResponse.json({ data: page.entries, meta: { page_size: 50, next_cursor: page.next, request_id: 'r-1' } })
    }),
  )
  return { last: () => queries[queries.length - 1] }
}

const table = () => screen.getByRole('table', { name: 'Audit entries, newest first' })

describe('Audit log (S-10)', () => {
  it('lists data changes newest first by default: when, what, who, and the fields changed', async () => {
    const api = serve({ '': { entries: [fuelCorrection], next: null } })
    signedInAs(compliance)
    renderApp('/audit')

    expect(await within(await screen.findByRole('table', { name: 'Audit entries, newest first' })).findByText('Updated fuel log')).toBeInTheDocument()
    expect(api.last().get('action')).toBe('INSERT,UPDATE,DELETE,ROLE_CHANGE')
    const row = within(table()).getByText('Updated fuel log').closest('tr') as HTMLElement
    expect(within(row).getByText('28 Oct 2026')).toBeInTheDocument()
    expect(within(row).getByText('14:05:09')).toBeInTheDocument()
    expect(within(row).getByText('quantity, total cost, updated at')).toBeInTheDocument()
    expect(within(row).getAllByText('Hanna Tesfaye').length).toBeGreaterThan(0)
  })

  it('opens an entry: only the changed fields, fuel in litres and money in ETB, before and after', async () => {
    serve({ '': { entries: [fuelCorrection], next: null } })
    signedInAs(compliance)
    renderApp('/audit')
    await userEvent.click(await within(await screen.findByRole('table', { name: 'Audit entries, newest first' })).findByText('Updated fuel log'))

    const drawer = await screen.findByRole('dialog', { name: 'Updated fuel log' })
    const diff = within(drawer).getByRole('table', { name: 'Fields changed' })
    const rows = within(diff).getAllByRole('row').slice(1)
    expect(rows.map((r) => within(r).getByRole('rowheader').textContent)).toEqual(['Quantity', 'Total cost', 'Updated at'])
    expect(within(rows[0]).getByText('40.00 L')).toBeInTheDocument()
    expect(within(rows[0]).getByText('42.50 L')).toBeInTheDocument()
    expect(within(rows[1]).getByText('ETB 3,800.50')).toBeInTheDocument()
    expect(within(rows[1]).getByText('ETB 4,038.00')).toBeInTheDocument()
    // Unchanged fields stay out.
    expect(within(diff).queryByText('Station name')).not.toBeInTheDocument()
    expect(within(diff).queryByText('Odometer')).not.toBeInTheDocument()
    expect(within(drawer).getByText('10.0.0.7')).toBeInTheDocument()
  })

  it('each view asks for its own entries; a denied request is marked', async () => {
    const api = serve({ '': { entries: [denied], next: null } })
    signedInAs(compliance)
    renderApp('/audit')
    await screen.findByRole('table', { name: 'Audit entries, newest first' })

    await userEvent.click(screen.getByRole('button', { name: /^Sign-ins/ }))
    await waitFor(() => expect(api.last().get('action')).toBe('auth.*'))
    await userEvent.click(screen.getByRole('button', { name: /^Denied/ }))
    await waitFor(() => expect(api.last().get('result')).toBe('denied'))
    expect(api.last().get('action')).toBeNull()
    const row = (await within(table()).findByText('Access denied')).closest('tr') as HTMLElement
    expect(within(row).getByText('Denied')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /^Scheduled jobs/ }))
    await waitFor(() => expect(api.last().get('action')).toBe('job.*'))
  })

  it('follows a lead from an entry: everything that person did, and a record’s full history', async () => {
    const api = serve({ '': { entries: [fuelCorrection], next: null } })
    signedInAs(compliance)
    renderApp('/audit')
    await userEvent.click(await within(await screen.findByRole('table', { name: 'Audit entries, newest first' })).findByText('Updated fuel log'))

    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Everything they did' }))
    await waitFor(() => expect(api.last().get('user_id')).toBe(HANNA.id))
    expect(screen.getByText('By Hanna Tesfaye')).toBeInTheDocument()

    await userEvent.click(await within(table()).findByText('Updated fuel log'))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Its full history' }))
    await waitFor(() => expect(api.last().get('entity_id')).toBe(FUEL_LOG))
    // A record's history shows every kind of entry, not only data changes.
    expect(api.last().get('action')).toBeNull()
    expect(screen.getByText('Fuel log')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Show everyone' }))
    await waitFor(() => expect(api.last().get('user_id')).toBeNull())
  })

  it('finds a record by its ID; anything else is explained, not sent', async () => {
    const api = serve({ '': { entries: [fuelCorrection], next: null } })
    signedInAs(compliance)
    renderApp('/audit')
    await screen.findByRole('table', { name: 'Audit entries, newest first' })
    const search = screen.getByRole('searchbox', { name: 'Find a record by its ID' })

    await userEvent.type(search, 'AA 3-12345')
    expect(await screen.findByText(/A record ID is 36 characters/)).toBeInTheDocument()
    expect(api.last().get('entity_id')).toBeNull()

    await userEvent.clear(search)
    await userEvent.type(search, FUEL_LOG)
    await waitFor(() => expect(api.last().get('entity_id')).toBe(FUEL_LOG))
    expect(screen.queryByText(/A record ID is 36 characters/)).not.toBeInTheDocument()
  })

  it('filters by kind of record and period, and pages on by cursor', async () => {
    const api = serve({
      '': { entries: [fuelCorrection], next: 'page-2' },
      'page-2': { entries: [entry({ id: 'older', action: 'INSERT', new_values: { name: 'Bole' }, entity_type: 'fleet.depots' })], next: null },
    })
    signedInAs(compliance)
    renderApp('/audit')
    await within(await screen.findByRole('table', { name: 'Audit entries, newest first' })).findByText('Updated fuel log')

    await userEvent.click(await screen.findByRole('button', { name: 'Next page' }))
    expect(await within(table()).findByText('Created depot Bole')).toBeInTheDocument()
    expect(api.last().get('cursor')).toBe('page-2')

    await userEvent.click(screen.getByRole('button', { name: /Records/ }))
    await userEvent.click(screen.getByRole('option', { name: 'Fuel logs' }))
    await waitFor(() => expect(api.last().get('entity_type')).toBe('fuel.fuel_logs'))
    // A new filter starts again from the first page.
    expect(api.last().get('cursor')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: /When/ }))
    await userEvent.click(screen.getByRole('option', { name: 'Last 7 days' }))
    await waitFor(() => expect(api.last().get('from')).toMatch(/^\d{4}-\d{2}-\d{2}$/))
    expect(api.last().get('to')).toBeNull()
  })

  it('is in the menu for those with audit:read only: a fleet manager does not see it', async () => {
    serve({ '': { entries: [], next: null } })
    signedInAs(fleetManager)
    renderApp('/vehicles')
    await screen.findByRole('heading', { name: 'Vehicles' })
    expect(screen.queryByRole('link', { name: 'Audit log' })).not.toBeInTheDocument()

    signedInAs(compliance)
    renderApp('/audit')
    expect(await screen.findByRole('link', { name: 'Audit log' })).toBeInTheDocument()
  })
})

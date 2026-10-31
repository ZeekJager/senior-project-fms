import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import type { ServiceProgram } from '@/features/service-due'
import { currentUser, envelope, renderApp, signedInAs } from '@/test/auth'
import { server } from '@/test/msw/server'

const manager = currentUser(['fleet_manager'], ['maintenance:read', 'maintenance:write', 'service-program:write', 'vehicle:read', 'depot:read'])
const depotAdmin = currentUser(['depot_admin'], ['maintenance:read', 'maintenance:write', 'service-program:write', 'vehicle:read', 'depot:read'])
const technician = currentUser(['technician'], ['maintenance:read', 'maintenance:write', 'vehicle:read', 'depot:read'])

const ADDIS = { id: 'd-1', name: 'Addis Ababa Central', code: 'ADD', location: 'Addis Ababa' }

let seq = 0
function program(overrides: Partial<ServiceProgram> = {}): ServiceProgram {
  seq += 1
  return {
    id: `p-${seq}`,
    name: `Program ${seq}`,
    description: null,
    depot_id: null,
    vehicle_type: null,
    fuel_type: null,
    make: null,
    model: null,
    interval_km: 10_000,
    lead_km: 1000,
    interval_days: null,
    lead_days: null,
    interval_engine_hours: null,
    lead_engine_hours: null,
    tasks: [],
    is_active: true,
    vehicles: { total: 0, upcoming: 0, due: 0, overdue: 0 },
    version: 2,
    created_at: '2026-10-01T08:00:00Z',
    updated_at: '2026-10-01T08:00:00Z',
    ...overrides,
  }
}

/** A fake /service-programs API: the status filter, and every write recorded with its If-Match. */
function servePrograms(programs: ServiceProgram[]) {
  const writes: { method: string; body: Record<string, unknown>; ifMatch: string | null }[] = []
  server.use(
    http.get('/api/v1/service-programs', ({ request }) => {
      const q = new URL(request.url).searchParams
      const rows = programs.filter((p) => (q.get('status') === 'retired' ? !p.is_active : p.is_active))
      const size = Number(q.get('page_size') ?? 50)
      return HttpResponse.json({ data: rows.slice(0, size), meta: { page: 1, page_size: size, total_items: rows.length, total_pages: 1 } })
    }),
    http.post('/api/v1/service-programs', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>
      writes.push({ method: 'POST', body, ifMatch: null })
      return envelope(program(body as Partial<ServiceProgram>))
    }),
    http.patch('/api/v1/service-programs/:id', async ({ request, params }) => {
      const body = (await request.json()) as Record<string, unknown>
      writes.push({ method: 'PATCH', body, ifMatch: request.headers.get('If-Match') })
      const current = programs.find((p) => p.id === params.id)!
      return envelope({ ...current, ...body, version: current.version + 1 })
    }),
    http.get('/api/v1/service-due', () => HttpResponse.json({ data: [], meta: { page: 1, page_size: 1, total_items: 3, total_pages: 3 } })),
    http.get('/api/v1/depots', () => envelope([ADDIS])),
  )
  return { writes }
}

const table = () => screen.getByRole('table', { name: 'Service programs' })
const rowOf = (name: string) => within(table()).getByText(name).closest('tr') as HTMLElement

async function openPrograms(first: string, user = manager) {
  signedInAs(user)
  renderApp('/service-programs')
  await within(await screen.findByRole('table', { name: 'Service programs' })).findByText(first)
}

describe('Service programs (S-23, FMS-129)', () => {
  it('lists each program with when it falls due, what it covers and its vehicles due and overdue', async () => {
    servePrograms([
      program({ name: 'A-service', vehicle_type: 'truck', fuel_type: 'diesel', interval_days: 180, lead_days: 14, tasks: ['Engine oil'], vehicles: { total: 12, upcoming: 9, due: 2, overdue: 1 } }),
    ])
    await openPrograms('A-service')
    const row = rowOf('A-service')
    expect(row).toHaveTextContent('Fleet-wide · Diesel trucks')
    expect(row).toHaveTextContent('Every 10,000 km or 180 days, whichever comes first')
    expect(row).toHaveTextContent('Due within 1,000 km or 14 days · 1 task')
    expect(within(row).getByText('1 overdue')).toBeInTheDocument()
    expect(within(row).getByText('2 due')).toBeInTheDocument()
    expect(row).toHaveTextContent('12 vehicles')
    // The header leads to the vehicles due, with how many.
    expect(await screen.findByRole('button', { name: 'Service due · 3' })).toBeInTheDocument()
  })

  it('the editor says what is missing before anything is sent, then adds the program with its checklist', async () => {
    const { writes } = servePrograms([program({ name: 'A-service' })])
    await openPrograms('A-service')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Add program' }))
    const drawer = await screen.findByRole('dialog', { name: 'Add service program' })
    await user.click(within(drawer).getByRole('button', { name: 'Add program' }))
    expect(within(drawer).getByText('Give the program a name.')).toBeInTheDocument()
    expect(within(drawer).getByText('Give at least one interval: kilometres, days or engine hours.')).toBeInTheDocument()

    await user.type(within(drawer).getByLabelText('Name'), 'B-service')
    await user.type(within(drawer).getByLabelText(/^Every \(km\)/), '20000')
    await user.type(within(drawer).getByLabelText(/Due within \(km\)/), '20000')
    await user.click(within(drawer).getByRole('button', { name: 'Add program' }))
    expect(within(drawer).getByText('Less than the interval (20,000 km).')).toBeInTheDocument()
    expect(writes).toEqual([])

    await user.clear(within(drawer).getByLabelText(/Due within \(km\)/))
    await user.type(within(drawer).getByLabelText('Task 1'), 'Gearbox oil')
    await user.selectOptions(within(drawer).getByLabelText('Vehicle type'), 'truck')
    await user.click(within(drawer).getByRole('button', { name: 'Add program' }))
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0].body).toMatchObject({ name: 'B-service', depot_id: null, vehicle_type: 'truck', interval_km: 20_000, lead_km: null, tasks: ['Gearbox oil'] })
  })

  it('a depot admin sees fleet-wide programs but changes only their depot’s; a new one is their depot’s', async () => {
    const { writes } = servePrograms([program({ name: 'Fleet A' }), program({ name: 'Depot A', depot_id: 'd-1' })])
    await openPrograms('Fleet A', depotAdmin)
    const user = userEvent.setup()
    expect(within(rowOf('Fleet A')).getByRole('button', { name: 'View Fleet A' })).toBeInTheDocument()
    expect(within(rowOf('Depot A')).getByRole('button', { name: 'Edit Depot A' })).toBeInTheDocument()

    await user.click(within(rowOf('Fleet A')).getByRole('button', { name: 'View Fleet A' }))
    const view = await screen.findByRole('dialog', { name: 'Fleet A' })
    expect(within(view).getByText('A fleet-wide program: set by those who see every depot.')).toBeInTheDocument()
    expect(within(view).queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument()
    // The footer's Close (the header has its own).
    await user.click(within(view).getAllByRole('button', { name: 'Close' }).at(-1)!)

    await user.click(screen.getByRole('button', { name: 'Add program' }))
    const drawer = await screen.findByRole('dialog', { name: 'Add service program' })
    expect(within(within(drawer).getByLabelText('Depot')).queryByRole('option', { name: /fleet-wide/ })).not.toBeInTheDocument()
    await user.type(within(drawer).getByLabelText('Name'), 'Depot B')
    await user.type(within(drawer).getByLabelText(/^Every \(days\)/), '90')
    await user.click(within(drawer).getByRole('button', { name: 'Add program' }))
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0].body).toMatchObject({ name: 'Depot B', depot_id: 'd-1', interval_days: 90 })
  })

  it('retires a program with the version it was read at', async () => {
    const { writes } = servePrograms([program({ name: 'A-service', vehicles: { total: 4, upcoming: 4, due: 0, overdue: 0 } })])
    await openPrograms('A-service')
    const user = userEvent.setup()
    await user.click(within(rowOf('A-service')).getByRole('button', { name: 'Edit A-service' }))
    await user.click(within(await screen.findByRole('dialog', { name: 'Edit A-service' })).getByRole('button', { name: 'Retire program' }))
    const confirm = await screen.findByRole('dialog', { name: 'Retire A-service' })
    expect(confirm).toHaveTextContent('Its 4 vehicles are no longer due under it')
    await user.click(within(confirm).getByRole('button', { name: 'Retire program' }))
    await waitFor(() => expect(writes).toEqual([{ method: 'PATCH', body: { is_active: false }, ifMatch: '"2"' }]))
  })

  it('a technician reads the programs but defines none', async () => {
    servePrograms([program({ name: 'A-service' })])
    await openPrograms('A-service', technician)
    expect(screen.queryByRole('button', { name: 'Add program' })).not.toBeInTheDocument()
    expect(within(rowOf('A-service')).getByRole('button', { name: 'View A-service' })).toBeInTheDocument()
  })
})

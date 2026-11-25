import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { currentUser, envelope, errorEnvelope, renderApp, signedInAs } from '@/test/auth'
import { server } from '@/test/msw/server'
import type { Vehicle } from '@/pages/Vehicles/types'
import type { Assignment } from './api'

// FMS-77: a vehicle's regular drivers on its page (S-22), and the same panel for a driver.

const DEPOT = '11111111-1111-4111-8111-111111111111'
const VEHICLE_ID = '00000000-0000-4000-8000-000000000001'
const ABEBE = '22222222-2222-4222-8222-222222222222'
const SARA = '44444444-4444-4444-8444-444444444444'

const vehicle = {
  id: VEHICLE_ID,
  registration_number: 'AA 3-20001',
  vin: null,
  make: 'Isuzu',
  model: 'FSR',
  year: 2018,
  vehicle_type: 'truck',
  fuel_type: 'diesel',
  fuel_efficiency_ml_per_km: 325,
  status: 'active',
  maintenance_flag: false,
  health_score: null,
  health_score_updated_at: null,
  depot_id: DEPOT,
  odometer_km: 87_000,
  current_trip: null,
  version: 0,
  created_at: '2021-03-04T09:00:00Z',
  updated_at: '2026-10-25T23:00:00Z',
} as unknown as Vehicle

const assignment = (over: Partial<Assignment>): Assignment => ({
  id: '55555555-5555-4555-8555-555555555555',
  driver: { id: ABEBE, full_name: 'Abebe Kebede' },
  vehicle: { id: VEHICLE_ID, registration_number: 'AA 3-20001' },
  depot_id: DEPOT,
  assignment_type: 'primary',
  start_at: '2026-07-01T03:00:00Z',
  end_at: null,
  status: 'active',
  current: true,
  notes: null,
  created_at: '2026-07-01T03:00:00Z',
  ...over,
})

const page = (data: unknown[]) => HttpResponse.json({ data, meta: { page: 1, page_size: 10, total_items: data.length, total_pages: 1, request_id: 'r-1' } })

function setup(permissions: string[], history: Assignment[]) {
  signedInAs(currentUser(['fleet_manager'], ['vehicle:read', 'depot:read', 'driver:read', ...permissions]))
  server.use(
    http.get(`/api/v1/vehicles/${VEHICLE_ID}`, () => envelope(vehicle)),
    http.get(`/api/v1/vehicles/${VEHICLE_ID}/assignments`, () => page(history)),
    http.get('/api/v1/drivers', () => page([{ id: ABEBE, full_name: 'Abebe Kebede' }, { id: SARA, full_name: 'Sara Tesfaye' }])),
  )
}

describe('Regular drivers (FMS-77)', () => {
  it('shows the current driver first and the history, and only with assignment:read', async () => {
    setup(['assignment:read'], [
      assignment({}),
      assignment({ id: '66666666-6666-4666-8666-666666666666', driver: { id: SARA, full_name: 'Sara Tesfaye' }, start_at: '2026-01-05T03:00:00Z', end_at: '2026-06-30T15:00:00Z', status: 'ended', current: false }),
    ])
    renderApp(`/vehicles/${VEHICLE_ID}?section=drivers`)
    const list = await screen.findByRole('list', { name: 'Assignments' })
    const rows = within(list).getAllByRole('listitem')
    expect(rows[0]).toHaveTextContent('Abebe Kebede')
    expect(rows[0]).toHaveTextContent('Current')
    expect(rows[1]).toHaveTextContent('Sara Tesfaye')
    expect(rows[1]).toHaveTextContent('Ended')
    expect(rows[1]).toHaveTextContent('5 Jan 2026 – 30 Jun 2026')
    // Read only: no way to assign or end.
    expect(screen.queryByRole('button', { name: /Assign driver/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^End:/ })).not.toBeInTheDocument()
  })

  it('assigns a driver, and says why when the driver already has a regular vehicle', async () => {
    setup(['assignment:read', 'assignment:write'], [])
    const sent: unknown[] = []
    let refuse = true
    server.use(
      http.post('/api/v1/driver-vehicle-assignments', async ({ request }) => {
        sent.push(await request.json())
        if (refuse) return errorEnvelope(409, 'CONFLICT_DRIVER_IN_USE', 'In use', [{ field: 'driver_id', reason: 'driver_has_primary_vehicle', record_id: 'x' }])
        return HttpResponse.json({ data: assignment({ driver: { id: SARA, full_name: 'Sara Tesfaye' } }), meta: { request_id: 'r-1' } }, { status: 201 })
      }),
    )
    const user = userEvent.setup()
    renderApp(`/vehicles/${VEHICLE_ID}?section=drivers`)
    expect(await screen.findByRole('heading', { name: 'No regular driver' })).toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: 'Assign driver' })[0])
    const drawer = await screen.findByRole('dialog', { name: 'Assign a driver' })
    await waitFor(() => expect(within(drawer).getByRole('option', { name: 'Sara Tesfaye' })).toBeInTheDocument())
    await user.click(within(drawer).getByRole('button', { name: 'Assign' }))
    expect(within(drawer).getByText('Choose a driver.')).toBeInTheDocument()

    await user.selectOptions(within(drawer).getByLabelText('Driver'), SARA)
    await user.click(within(drawer).getByRole('button', { name: 'Assign' }))
    expect(await within(drawer).findByText(/already has a regular vehicle for that time/)).toBeInTheDocument()
    expect(sent[0]).toEqual({ driver_id: SARA, vehicle_id: VEHICLE_ID, assignment_type: 'primary' })

    refuse = false
    await user.click(within(drawer).getByRole('button', { name: 'Assign' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Assign a driver' })).not.toBeInTheDocument())
  })

  it('a temporary assignment needs an end before it is sent', async () => {
    setup(['assignment:read', 'assignment:write'], [])
    const user = userEvent.setup()
    renderApp(`/vehicles/${VEHICLE_ID}?section=drivers`)
    await user.click((await screen.findAllByRole('button', { name: 'Assign driver' }))[0])
    const drawer = await screen.findByRole('dialog', { name: 'Assign a driver' })
    await waitFor(() => expect(within(drawer).getByRole('option', { name: 'Abebe Kebede' })).toBeInTheDocument())
    await user.selectOptions(within(drawer).getByLabelText('Driver'), ABEBE)
    await user.selectOptions(within(drawer).getByLabelText('Kind'), 'temporary')
    await user.click(within(drawer).getByRole('button', { name: 'Assign' }))
    expect(within(drawer).getByText('A temporary assignment needs an end.')).toBeInTheDocument()
  })

  it('ends the current assignment after confirming', async () => {
    setup(['assignment:read', 'assignment:write'], [assignment({})])
    let ended = false
    server.use(
      http.post('/api/v1/driver-vehicle-assignments/:id/end', () => {
        ended = true
        return envelope(assignment({ status: 'ended', current: false, end_at: new Date().toISOString() }))
      }),
    )
    const user = userEvent.setup()
    renderApp(`/vehicles/${VEHICLE_ID}?section=drivers`)
    await user.click(await screen.findByRole('button', { name: 'End: Abebe Kebede' }))
    const dialog = await screen.findByRole('dialog', { name: 'End this assignment?' })
    await user.click(within(dialog).getByRole('button', { name: 'End assignment' }))
    await waitFor(() => expect(ended).toBe(true))
  })

  it('a failed load says so, with a way to try again', async () => {
    setup(['assignment:read'], [])
    server.use(http.get(`/api/v1/vehicles/${VEHICLE_ID}/assignments`, () => errorEnvelope(403, 'FORBIDDEN_INSUFFICIENT_ROLE')))
    renderApp(`/vehicles/${VEHICLE_ID}?section=drivers`)
    expect(await screen.findByText('The assignments could not be loaded')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument()
  })
})

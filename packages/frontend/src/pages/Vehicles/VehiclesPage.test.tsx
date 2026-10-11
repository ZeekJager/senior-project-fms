import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { createApiClient, type ApiClient } from '@/lib/api/client'
import { currentUser, envelope, errorEnvelope, renderApp, signedInAs } from '@/test/auth'
import { server } from '@/test/msw/server'
import { today } from '@/features/documents/expiry'
import type { OwnedDocument } from '@/features/documents/types'
import type { Vehicle } from './types'

const DEPOT_A = '11111111-1111-4111-8111-111111111111'
const DEPOT_B = '22222222-2222-4222-8222-222222222222'

const manager = currentUser(
  ['fleet_manager'],
  ['vehicle:read', 'vehicle:write', 'vehicle:delete', 'depot:read', 'document:read', 'document:write', 'document:delete'],
)
const driver = currentUser(['driver'], ['vehicle:read', 'trip:execute', 'document:read', 'document:write'])

let seq = 0
function vehicle(overrides: Partial<Vehicle> = {}): Vehicle {
  seq += 1
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    registration_number: `AA 3-${10000 + seq}`,
    vin: null,
    make: 'Isuzu',
    model: 'FSR',
    year: 2020,
    vehicle_type: 'truck',
    fuel_type: 'diesel',
    fuel_efficiency_ml_per_km: 320,
    status: 'active',
    maintenance_flag: false,
    health_score: null,
    depot_id: DEPOT_A,
    odometer_km: 1000,
    current_trip: null,
    version: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function plusDays(days: number): string {
  const d = new Date(`${today()}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function doc(ownerId: string, expiresOn: string | null, overrides: Partial<OwnedDocument> = {}): OwnedDocument {
  seq += 1
  return {
    id: `d0000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    owner_type: 'vehicle',
    owner_id: ownerId,
    document_type: 'insurance',
    original_filename: 'insurance.pdf',
    content_type: 'application/pdf',
    size_bytes: 2048,
    sha256: 'a'.repeat(64),
    expires_on: expiresOn,
    retain_until: null,
    uploaded_by: 'u-1',
    uploaded_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

/** A fake API over `fleet`: filters, paging and counts like GET /vehicles; records every list query. */
function serveFleet(fleet: Vehicle[], documents: OwnedDocument[] = []) {
  const queries: URLSearchParams[] = []
  server.use(
    http.get('/api/v1/vehicles', ({ request }) => {
      const q = new URL(request.url).searchParams
      queries.push(q)
      let rows = fleet.filter((v) => (q.get('status') ? v.status === q.get('status') : v.status !== 'retired'))
      if (q.get('maintenance_flag')) rows = rows.filter((v) => v.maintenance_flag === (q.get('maintenance_flag') === 'true'))
      if (q.get('depot_id')) rows = rows.filter((v) => v.depot_id === q.get('depot_id'))
      if (q.get('search')) rows = rows.filter((v) => v.registration_number.includes(q.get('search')!.toUpperCase()))
      const page = Number(q.get('page') ?? 1)
      const size = Number(q.get('page_size') ?? 25)
      return HttpResponse.json({
        data: rows.slice((page - 1) * size, page * size),
        meta: { page, page_size: size, total_items: rows.length, total_pages: Math.ceil(rows.length / size), request_id: 'r-1' },
      })
    }),
    http.get('/api/v1/depots', () =>
      envelope([
        { id: DEPOT_A, name: 'Addis Ababa Central', code: 'ADD', location: 'Addis Ababa' },
        { id: DEPOT_B, name: 'Adama Hub', code: 'ADM', location: 'Adama' },
      ]),
    ),
    http.get('/api/v1/documents', ({ request }) => {
      const ids = new URL(request.url).searchParams.get('owner_id')!.split(',')
      return envelope(documents.filter((d) => ids.includes(d.owner_id)))
    }),
  )
  /** The page's list requests (not the page_size=1 count requests). */
  const listQueries = () => queries.filter((q) => q.get('page_size') !== '1')
  return { listQueries }
}

const table = () => screen.getByRole('table', { name: 'Vehicles' })
const rowFor = (plate: string) => within(table()).getByText(plate).closest('tr') as HTMLElement

async function openVehicles(path = '/vehicles', api?: ApiClient) {
  signedInAs(manager)
  renderApp(path, { api })
  await screen.findByRole('heading', { name: 'Vehicles' })
}

describe('Vehicle Management (S-04)', () => {
  it('lists vehicles with depot, status, current trip and document health', async () => {
    const onTrip = vehicle({
      current_trip: { id: 't-1', status: 'en_route', origin: 'Addis Ababa', destination: 'Adama', scheduled_start: null },
    })
    const idle = vehicle({ status: 'maintenance', maintenance_flag: true, depot_id: DEPOT_B })
    serveFleet([onTrip, idle], [doc(onTrip.id, plusDays(200))])
    await openVehicles()

    await within(table()).findByText(onTrip.registration_number)
    const tripRow = rowFor(onTrip.registration_number)
    expect(within(tripRow).getByRole('link', { name: /Addis Ababa.*Adama/ })).toHaveAttribute('href', '/dispatch?trip=t-1')
    expect(within(tripRow).getByText('Addis Ababa Central')).toBeInTheDocument()
    expect(within(tripRow).getAllByText('Active')[0]).toHaveAttribute('data-status', 'active')
    expect(await within(tripRow).findByText('1 on file')).toBeInTheDocument()

    const idleRow = rowFor(idle.registration_number)
    expect(within(idleRow).getByText('No active trip')).toBeInTheDocument()
    expect(within(idleRow).getByText('Flagged for maintenance')).toBeInTheDocument()
    expect(within(idleRow).getByText('Adama Hub')).toBeInTheDocument()
  })

  it('filters by maintenance flag without a page reload, keeping the filter in the URL', async () => {
    const flagged = vehicle({ maintenance_flag: true })
    const fine = vehicle()
    const api = serveFleet([flagged, fine])
    const user = userEvent.setup()
    await openVehicles()
    await within(table()).findByText(fine.registration_number)

    await user.click(screen.getByRole('switch', { name: 'Maintenance flagged' }))

    await waitFor(() => expect(within(table()).queryByText(fine.registration_number)).not.toBeInTheDocument())
    expect(within(table()).getByText(flagged.registration_number)).toBeInTheDocument()
    expect(screen.getByTestId('location')).toHaveTextContent('/vehicles?flagged=1')
    expect(api.listQueries().at(-1)?.get('maintenance_flag')).toBe('true')
    // Same app instance throughout: the heading never unmounted.
    expect(screen.getByRole('heading', { name: 'Vehicles' })).toBeInTheDocument()
  })

  it('shows skeleton rows while a new filter loads, then the rows', async () => {
    const v = vehicle({ status: 'maintenance' })
    serveFleet([v])
    const user = userEvent.setup()
    await openVehicles()
    await within(table()).findByText(v.registration_number)

    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    server.use(
      http.get('/api/v1/vehicles', async ({ request }) => {
        if (new URL(request.url).searchParams.get('page_size') !== '1') await gate
        return HttpResponse.json({ data: [v], meta: { page: 1, page_size: 25, total_items: 1, total_pages: 1 } })
      }),
    )
    await user.click(screen.getByRole('button', { name: /^Status:/ }))
    await user.click(screen.getByRole('option', { name: 'Maintenance' }))

    expect((await screen.findAllByTestId('skeleton-row')).length).toBeGreaterThan(0)
    release()
    await within(table()).findByText(v.registration_number)
    expect(screen.queryByTestId('skeleton-row')).not.toBeInTheDocument()
  })

  it('needs the exact plate typed before decommissioning, and shows 409 CONFLICT_VEHICLE_IN_USE in the dialog', async () => {
    const busy = vehicle()
    serveFleet([busy])
    server.use(http.delete(`/api/v1/vehicles/${busy.id}`, () => errorEnvelope(409, 'CONFLICT_VEHICLE_IN_USE')))
    const user = userEvent.setup()
    await openVehicles()
    await within(table()).findByText(busy.registration_number)

    await user.click(within(rowFor(busy.registration_number)).getByRole('button', { name: `Decommission ${busy.registration_number}` }))
    const dialog = await screen.findByRole('dialog', { name: `Decommission ${busy.registration_number}` })
    const confirm = within(dialog).getByRole('button', { name: 'Decommission vehicle' })
    const input = within(dialog).getByLabelText(`Type ${busy.registration_number} to confirm`)

    expect(confirm).toBeDisabled()
    await user.type(input, busy.registration_number.toLowerCase())
    expect(confirm).toBeDisabled()
    await user.clear(input)
    await user.type(input, busy.registration_number)
    expect(confirm).toBeEnabled()

    await user.click(confirm)
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('on an active trip or assigned to a driver')
    // Inline, not a toast: the dialog stays open and the toast region stays empty.
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('decommissions an idle vehicle and confirms with a toast', async () => {
    const idle = vehicle()
    serveFleet([idle])
    server.use(http.delete(`/api/v1/vehicles/${idle.id}`, () => new HttpResponse(null, { status: 204 })))
    const user = userEvent.setup()
    await openVehicles()
    await within(table()).findByText(idle.registration_number)

    await user.click(within(rowFor(idle.registration_number)).getByRole('button', { name: `Decommission ${idle.registration_number}` }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText(/to confirm$/), idle.registration_number)
    await user.click(within(dialog).getByRole('button', { name: 'Decommission vehicle' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByRole('status')).toHaveTextContent('Vehicle decommissioned')
  })

  it('marks expired documents red and those expiring within 30 days amber', async () => {
    const expired = vehicle()
    const expiring = vehicle()
    const valid = vehicle()
    serveFleet(
      [expired, expiring, valid],
      [doc(expired.id, plusDays(-1)), doc(expiring.id, plusDays(30)), doc(valid.id, plusDays(31)), doc(valid.id, null)],
    )
    const user = userEvent.setup()
    await openVehicles()

    await within(table()).findByText(expired.registration_number)
    const expiredBadge = await within(rowFor(expired.registration_number)).findByText('1 expired')
    expect(expiredBadge).toHaveClass('bg-danger-soft')
    expect(within(rowFor(expiring.registration_number)).getByText('1 expiring')).toHaveClass('bg-warning-soft')
    expect(within(rowFor(valid.registration_number)).getByText('2 on file')).toHaveClass('bg-success-soft')

    await user.click(screen.getByRole('button', { name: `Documents for ${expired.registration_number}` }))
    const drawer = await screen.findByRole('dialog', { name: `Documents · ${expired.registration_number}` })
    expect(within(drawer).getByText('Expired')).toHaveAttribute('data-expiry', 'expired')
    expect(within(drawer).getByText('Expired').closest('span.rounded-full')).toHaveClass('bg-danger-soft')
    await user.keyboard('{Escape}')

    await user.click(screen.getByRole('button', { name: `Documents for ${expiring.registration_number}` }))
    const drawer2 = await screen.findByRole('dialog')
    expect(within(drawer2).getByText('Expires in 30 days')).toHaveAttribute('data-expiry', 'expiring')
    expect(within(drawer2).getByText('Expires in 30 days').closest('span.rounded-full')).toHaveClass('bg-warning-soft')
  })

  it('uploads a document picked with the row + button', async () => {
    const v = vehicle()
    serveFleet([v])
    // jsdom's File cannot be streamed by Node's fetch, so the multipart body
    // is captured where the app hands it to fetch.
    let sent: FormData | undefined
    const api = createApiClient((input, init) => {
      const url = new URL(String(input), window.location.origin)
      if (url.pathname === '/api/v1/documents' && init?.method === 'POST') {
        sent = init.body as FormData
        return Promise.resolve(Response.json({ data: doc(v.id, '2027-01-31'), meta: {} }, { status: 201 }))
      }
      return fetch(url, init)
    })
    const user = userEvent.setup()
    await openVehicles('/vehicles', api)
    await within(table()).findByText(v.registration_number)

    await user.click(screen.getByRole('button', { name: `Upload a document for ${v.registration_number}` }))
    const file = new File(['%PDF-1.4'], 'insurance.pdf', { type: 'application/pdf' })
    await user.upload(screen.getByTestId('row-file-picker'), file)
    const drawer = await screen.findByRole('dialog', { name: `Documents · ${v.registration_number}` })
    expect(within(drawer).getByText('insurance.pdf')).toBeInTheDocument()
    await user.selectOptions(within(drawer).getByLabelText('Document type'), 'insurance')
    await user.type(within(drawer).getByLabelText(/Expires on/), '2027-01-31')
    await user.click(within(drawer).getByRole('button', { name: 'Upload document' }))

    await waitFor(() => expect(sent).toBeInstanceOf(FormData))
    expect(sent!.get('owner_type')).toBe('vehicle')
    expect(sent!.get('owner_id')).toBe(v.id)
    expect(sent!.get('document_type')).toBe('insurance')
    expect(sent!.get('expires_on')).toBe('2027-01-31')
    expect((sent!.get('file') as File).name).toBe('insurance.pdf')
    expect(await screen.findByText('Document uploaded')).toBeInTheDocument()
  })

  it('refuses a file over 10 MB before uploading it', async () => {
    const v = vehicle()
    serveFleet([v])
    const user = userEvent.setup()
    await openVehicles()
    await within(table()).findByText(v.registration_number)

    await user.click(await screen.findByRole('button', { name: `Documents for ${v.registration_number}` }))
    const drawer = await screen.findByRole('dialog')
    const big = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'scan.pdf', { type: 'application/pdf' })
    await user.upload(within(drawer).getByLabelText(/Choose a file/), big)
    expect(within(drawer).getByRole('alert')).toHaveTextContent('scan.pdf is larger than 10 MB.')
  })

  // These type a whole form; under a full parallel run they can pass 5s.
  describe('add vehicle', { timeout: 15_000 }, () => {
    it('flags a plate that is already registered while typing', async () => {
      const existing = vehicle({ registration_number: 'AA 3-12345' })
      serveFleet([existing])
      const user = userEvent.setup()
      await openVehicles()
      await within(table()).findByText('AA 3-12345')

      await user.click(screen.getAllByRole('button', { name: 'Add vehicle' })[0])
      const drawer = await screen.findByRole('dialog', { name: 'Add vehicle' })
      await user.type(within(drawer).getByLabelText('Registration number'), 'aa  3-12345')

      expect(await within(drawer).findByText('AA 3-12345 is already registered.', {}, { timeout: 3000 })).toBeInTheDocument()
      expect(within(drawer).getByLabelText('Registration number')).toHaveAttribute('aria-invalid', 'true')
    })

    it('registers a vehicle, sending fuel use as whole ml/km', async () => {
      serveFleet([vehicle()])
      let body: Record<string, unknown> | undefined
      server.use(
        http.post('/api/v1/vehicles', async ({ request }) => {
          body = (await request.json()) as Record<string, unknown>
          return envelope(vehicle({ registration_number: 'OR 2-55555' }))
        }),
      )
      const user = userEvent.setup()
      await openVehicles()
      await user.click(screen.getAllByRole('button', { name: 'Add vehicle' })[0])
      const drawer = await screen.findByRole('dialog', { name: 'Add vehicle' })
      const field = (label: string | RegExp) => within(drawer).getByLabelText(label)

      await user.type(field('Registration number'), 'or 2-55555')
      await user.type(field('Make'), 'Toyota')
      await user.type(field('Model'), 'Hilux')
      await user.selectOptions(field('Type'), 'car')
      await user.selectOptions(field('Depot'), DEPOT_B)
      await user.selectOptions(field('Fuel'), 'diesel')
      await user.type(field('Consumption'), '10.5')
      await user.click(within(drawer).getByRole('button', { name: 'Add vehicle' }))

      await waitFor(() => expect(body).toBeDefined())
      expect(body).toMatchObject({
        registration_number: 'OR 2-55555',
        make: 'Toyota',
        model: 'Hilux',
        vehicle_type: 'car',
        fuel_type: 'diesel',
        fuel_efficiency_ml_per_km: 105,
        depot_id: DEPOT_B,
        vin: null,
        year: null,
      })
      expect(await screen.findByText('Vehicle registered')).toBeInTheDocument()
    })
  })

  it('says so when a depot has no vehicles, with a way to add one', async () => {
    serveFleet([])
    await openVehicles()
    expect(await screen.findByText('No vehicles registered for this depot')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Add vehicle' })).toHaveLength(2)
  })

  it('shows the error with its correlation id when the list fails', async () => {
    serveFleet([])
    server.use(
      http.get('/api/v1/vehicles', () =>
        HttpResponse.json({ error: { code: 'INTERNAL_SERVER_ERROR', message: 'boom' }, meta: { request_id: 'req-42' } }, { status: 500 }),
      ),
    )
    await openVehicles()
    expect(await screen.findByText("We couldn't load this list", {}, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.getByText('req-42')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('renders nothing for a driver: no data, no access-denied message', async () => {
    let listed = false
    server.use(
      http.get('/api/v1/vehicles', () => {
        listed = true
        return envelope([])
      }),
    )
    signedInAs(driver)
    renderApp('/vehicles')

    await screen.findByText('Sam Tester')
    expect(screen.getByRole('main')).toBeEmptyDOMElement()
    expect(screen.queryByText(/denied|forbidden|not allowed/i)).not.toBeInTheDocument()
    expect(listed).toBe(false)
  })

  it('hides write actions from a read-only role', async () => {
    const v = vehicle()
    serveFleet([v])
    signedInAs(currentUser(['compliance_officer'], ['vehicle:read', 'depot:read', 'document:read']))
    renderApp('/vehicles')
    await within(await screen.findByRole('table', { name: 'Vehicles' })).findByText(v.registration_number)

    expect(screen.queryByRole('button', { name: 'Add vehicle' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Edit / })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Decommission / })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Upload a document/ })).not.toBeInTheDocument()
  })
})

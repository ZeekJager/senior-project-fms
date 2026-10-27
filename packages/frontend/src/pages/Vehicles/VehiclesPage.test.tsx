import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { createApiClient, type ApiClient } from '@/lib/api/client'
import { currentUser, envelope, errorEnvelope, renderApp, signedInAs } from '@/test/auth'
import { server } from '@/test/msw/server'
import { today } from '@/features/documents/expiry'
import type { OwnedDocument } from '@/features/documents/types'
import type { Vehicle, VehicleStatusView } from './types'

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
    health_score_updated_at: null,
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
      if (q.get('ready_to_dispatch')) {
        const want = q.get('ready_to_dispatch') === 'true'
        rows = rows.filter((v) => (v.status === 'active' && !v.maintenance_flag && !v.current_trip) === want)
      }
      if (q.get('documents') === 'due') {
        rows = rows.filter((v) => documents.some((d) => d.owner_id === v.id && d.expires_on !== null && d.expires_on <= plusDays(30)))
      }
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
    // The depot shows in its column and, on narrower screens, under the plate.
    expect(within(tripRow).getAllByText(/Addis Ababa Central/).length).toBeGreaterThan(0)
    expect(within(tripRow).getAllByText('Active')[0]).toHaveAttribute('data-status', 'active')
    expect(await within(tripRow).findByTitle('1 document on file')).toBeInTheDocument()

    const idleRow = rowFor(idle.registration_number)
    expect(within(idleRow).getByText('No active trip')).toBeInTheDocument()
    expect(within(idleRow).getByText('Flagged for maintenance')).toBeInTheDocument()
    expect(within(idleRow).getAllByText(/Adama Hub/).length).toBeGreaterThan(0)
  })

  it('filters by maintenance flag without a page reload, keeping the filter in the URL', async () => {
    const flagged = vehicle({ maintenance_flag: true })
    const fine = vehicle()
    const api = serveFleet([flagged, fine])
    const user = userEvent.setup()
    await openVehicles()
    await within(table()).findByText(fine.registration_number)

    await user.click(screen.getByRole('button', { name: /^Flagged/ }))

    await waitFor(() => expect(within(table()).queryByText(fine.registration_number)).not.toBeInTheDocument())
    expect(within(table()).getByText(flagged.registration_number)).toBeInTheDocument()
    expect(screen.getByTestId('location')).toHaveTextContent('/vehicles?flagged=1')
    expect(api.listQueries().at(-1)?.get('maintenance_flag')).toBe('true')
    // Same app instance throughout: the heading never unmounted.
    expect(screen.getByRole('heading', { name: 'Vehicles' })).toBeInTheDocument()
  })

  describe('views', () => {
    it('offers one control for which vehicles: no status dropdown and no flag switch', async () => {
      serveFleet([vehicle()])
      await openVehicles()
      const views = screen.getByRole('group', { name: 'Vehicle views' })
      expect(within(views).getAllByRole('button').map((b) => b.textContent?.replace(/\s*\d*$/, ''))).toEqual(['All', 'Ready to dispatch', 'Flagged', 'Workshop', 'Documents due', 'Inactive', 'Retired'])
      expect(screen.queryByRole('switch')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /^Status:/ })).not.toBeInTheDocument()
    })

    it('shows the count of each view and marks the one that applies', async () => {
      serveFleet([vehicle({ maintenance_flag: true }), vehicle(), vehicle({ status: 'maintenance' })])
      await openVehicles()
      const views = screen.getByRole('group', { name: 'Vehicle views' })
      expect(await within(views).findByRole('button', { name: 'All 3' })).toHaveAttribute('aria-pressed', 'true')
      expect(within(views).getByRole('button', { name: 'Flagged 1' })).toHaveAttribute('aria-pressed', 'false')
      expect(within(views).getByRole('button', { name: 'Workshop 1' })).toBeInTheDocument()
    })

    it('counts the retired vehicles too, so no view looks like a bug', async () => {
      serveFleet([vehicle(), vehicle({ status: 'retired' }), vehicle({ status: 'retired' })])
      await openVehicles()
      const views = screen.getByRole('group', { name: 'Vehicle views' })
      expect(await within(views).findByRole('button', { name: 'Retired 2' })).toBeInTheDocument()
    })

    it('a view filters the table, is kept in the URL and clears back to All', async () => {
      const idle = vehicle({ status: 'active' })
      const away = vehicle({ status: 'maintenance' })
      const api = serveFleet([idle, away])
      const user = userEvent.setup()
      await openVehicles()
      await within(table()).findByText(idle.registration_number)

      await user.click(screen.getByRole('button', { name: /^Workshop/ }))
      await waitFor(() => expect(within(table()).queryByText(idle.registration_number)).not.toBeInTheDocument())
      expect(screen.getByTestId('location')).toHaveTextContent('/vehicles?status=maintenance')
      expect(api.listQueries().at(-1)?.get('status')).toBe('maintenance')
      expect(screen.getByRole('button', { name: /^Workshop/ })).toHaveAttribute('aria-pressed', 'true')

      await user.click(screen.getByRole('button', { name: /^All/ }))
      await within(table()).findByText(idle.registration_number)
      expect(screen.getByTestId('location')).toHaveTextContent(/^\/vehicles$/)
    })

    it('shows inactive and retired as views after a divider, and applies them', async () => {
      const gone = vehicle({ status: 'retired' })
      serveFleet([vehicle(), gone])
      const user = userEvent.setup()
      await openVehicles()
      const views = screen.getByRole('group', { name: 'Vehicle views' })
      expect(within(views).getByRole('separator')).toBeInTheDocument()
      await user.click(within(views).getByRole('button', { name: /^Retired/ }))
      await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/vehicles?status=retired'))
      await within(table()).findByText(gone.registration_number)
    })

    it('marks no view when the link combines a status with the flag, and "All" resets both', async () => {
      serveFleet([vehicle()])
      const user = userEvent.setup()
      await openVehicles('/vehicles?status=active&flagged=1')
      const views = screen.getByRole('group', { name: 'Vehicle views' })
      for (const button of within(views).getAllByRole('button')) expect(button).toHaveAttribute('aria-pressed', 'false')
      await user.click(within(views).getByRole('button', { name: /^All/ }))
      await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/vehicles$/))
    })
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
    await user.click(screen.getByRole('button', { name: /^Workshop/ }))

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

    await user.click(within(rowFor(busy.registration_number)).getByRole('button', { name: `Edit ${busy.registration_number}` }))
    await user.click(await screen.findByRole('button', { name: 'Decommission vehicle' }))
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

    await user.click(within(rowFor(idle.registration_number)).getByRole('button', { name: `Edit ${idle.registration_number}` }))
    await user.click(await screen.findByRole('button', { name: 'Decommission vehicle' }))
    const dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByLabelText(/to confirm$/), idle.registration_number)
    await user.click(within(dialog).getByRole('button', { name: 'Decommission vehicle' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(screen.getByRole('status')).toHaveTextContent('Vehicle decommissioned')
  })

  it('marks expired documents red and those expiring within 30 days amber; healthy ones stay quiet', async () => {
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
    // Healthy documents are plain text, so the colored badges that remain are the exceptions.
    const healthy = within(rowFor(valid.registration_number)).getByTitle('2 documents on file')
    expect(healthy).not.toHaveClass('bg-success-soft')
    expect(healthy).toHaveClass('text-ink-muted')

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

  it('uploads a document from the documents drawer, which the row opens', async () => {
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

    expect(screen.queryByRole('button', { name: /^Upload a document for/ })).not.toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: `Documents for ${v.registration_number}` }))
    const drawer = await screen.findByRole('dialog', { name: `Documents · ${v.registration_number}` })
    const file = new File(['%PDF-1.4'], 'insurance.pdf', { type: 'application/pdf' })
    await user.upload(within(drawer).getByLabelText(/Choose a file/), file)
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
    // Two depots and none chosen: there is no single depot to name.
    expect(await screen.findByText('No vehicles registered yet')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Add vehicle' })).toHaveLength(2)
  })

  it('says "across your depots" when there are several and none is chosen', async () => {
    serveFleet([])
    await openVehicles()
    expect(await screen.findByText(/across your depots/)).toBeInTheDocument()
  })

  it('names the chosen depot in the subtitle', async () => {
    serveFleet([])
    await openVehicles(`/vehicles?depot=${DEPOT_A}`)
    expect(await screen.findByText(/for every vehicle in Addis Ababa Central/)).toBeInTheDocument()
    expect(screen.queryByText(/across your depots/)).not.toBeInTheDocument()
  })

  describe('dispatch and document views', () => {
    it('Ready to dispatch asks the API for ready vehicles, shows its count and keeps the filter in the URL', async () => {
      const ready = vehicle()
      const flagged = vehicle({ maintenance_flag: true })
      const api = serveFleet([ready, flagged])
      const user = userEvent.setup()
      await openVehicles()
      const views = screen.getByRole('group', { name: 'Vehicle views' })
      const tab = await within(views).findByRole('button', { name: 'Ready to dispatch 1' })

      await user.click(tab)
      await waitFor(() => expect(within(table()).queryByText(flagged.registration_number)).not.toBeInTheDocument())
      expect(within(table()).getByText(ready.registration_number)).toBeInTheDocument()
      expect(screen.getByTestId('location')).toHaveTextContent('/vehicles?ready=1')
      expect(api.listQueries().at(-1)?.get('ready_to_dispatch')).toBe('true')
      expect(screen.getByRole('button', { name: /^Ready to dispatch/ })).toHaveAttribute('aria-pressed', 'true')
      // Every row says the same status, so the column goes.
      expect(within(table()).queryByRole('columnheader', { name: 'Status' })).not.toBeInTheDocument()
    })

    it('Documents due asks for vehicles with an expired or expiring document, with a count', async () => {
      const due = vehicle()
      const fine = vehicle()
      const api = serveFleet([due, fine], [doc(due.id, plusDays(10)), doc(fine.id, plusDays(200))])
      const user = userEvent.setup()
      await openVehicles()
      const views = screen.getByRole('group', { name: 'Vehicle views' })

      await user.click(await within(views).findByRole('button', { name: 'Documents due 1' }))
      await waitFor(() => expect(within(table()).queryByText(fine.registration_number)).not.toBeInTheDocument())
      expect(within(table()).getByText(due.registration_number)).toBeInTheDocument()
      expect(screen.getByTestId('location')).toHaveTextContent('/vehicles?docs=due')
      expect(api.listQueries().at(-1)?.get('documents')).toBe('due')
    })

    it('Clear empties the search and depot but keeps the view you are in', async () => {
      serveFleet([vehicle()])
      const user = userEvent.setup()
      await openVehicles('/vehicles?ready=1&q=AA')
      await user.click(await screen.findByRole('button', { name: 'Clear' }))
      await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/vehicles\?ready=1$/))
      expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument()
    })

    it('"All" leaves every dispatch and document view', async () => {
      serveFleet([vehicle()])
      const user = userEvent.setup()
      await openVehicles('/vehicles?ready=1')
      await user.click(within(screen.getByRole('group', { name: 'Vehicle views' })).getByRole('button', { name: /^All/ }))
      await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/vehicles$/))
    })
  })

  describe('the whole row, selection and export', () => {
    it('clicking a row opens the vehicle for editing; the plate itself is plain text', async () => {
      const v = vehicle()
      serveFleet([v])
      const user = userEvent.setup()
      await openVehicles()
      const plate = await within(table()).findByText(v.registration_number)
      expect(plate.closest('button')).toBeNull()
      await user.click(plate)
      expect(await screen.findByRole('dialog', { name: `Edit ${v.registration_number}` })).toBeInTheDocument()
    })

    it('J, K and Enter open a vehicle from the keyboard', async () => {
      const v = vehicle()
      serveFleet([v])
      const user = userEvent.setup()
      await openVehicles()
      await within(table()).findByText(v.registration_number)
      await user.keyboard('j')
      expect(await screen.findByText(new RegExp(`Row 1 of 1: ${v.registration_number}`))).toBeInTheDocument()
      await user.keyboard('{Enter}')
      expect(await screen.findByRole('dialog', { name: `Edit ${v.registration_number}` })).toBeInTheDocument()
    })

    it('ticks vehicles and exports them as CSV', async () => {
      const a = vehicle({ make: 'Isuzu, Ltd' })
      const b = vehicle()
      serveFleet([a, b])
      const blobs: Blob[] = []
      Object.assign(URL, { createObjectURL: (blob: Blob) => (blobs.push(blob), 'blob:x'), revokeObjectURL: () => {} })
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
      const user = userEvent.setup()
      await openVehicles()
      await within(table()).findByText(a.registration_number)

      await user.click(screen.getByRole('checkbox', { name: `Select ${a.registration_number}` }))
      expect(screen.getByText('1 selected')).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Export CSV' }))
      const csv = await blobs[0].text()
      expect(csv).toContain('Plate,Make,Model')
      expect(csv).toContain(a.registration_number)
      expect(csv).toContain('"Isuzu, Ltd"')
      expect(csv).not.toContain(b.registration_number)
      expect(await screen.findByText('1 vehicle exported')).toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: 'Clear selection' }))
      expect(screen.queryByText('1 selected')).not.toBeInTheDocument()
    })

    it('selecting every row on the page ticks them all', async () => {
      serveFleet([vehicle(), vehicle(), vehicle()])
      const user = userEvent.setup()
      await openVehicles()
      await within(table()).findAllByText(/AA 3-/)
      await user.click(screen.getByRole('checkbox', { name: 'Select every row on this page' }))
      expect(screen.getByText('3 selected')).toBeInTheDocument()
    })

    it('a second sort in the URL goes to the API as then_by', async () => {
      const api = serveFleet([vehicle(), vehicle()])
      const user = userEvent.setup()
      await openVehicles()
      await within(table()).findAllByText(/AA 3-/)
      await user.keyboard('{Shift>}')
      await user.click(within(table()).getByRole('button', { name: /^Depot/ }))
      await user.keyboard('{/Shift}')
      await waitFor(() => expect(api.listQueries().at(-1)?.get('then_by')).toBe('depot'))
      expect(api.listQueries().at(-1)?.get('then_order')).toBe('asc')
      expect(screen.getByTestId('location')).toHaveTextContent('then=depot')
    })
  })

  it('a search with no result names what is filtering, and says how to widen it', async () => {
    serveFleet([vehicle()])
    await openVehicles('/vehicles?q=ZZZZ&ready=1')
    expect(await screen.findByText(/Filtered by search “ZZZZ” · view Ready to dispatch\./)).toBeInTheDocument()
  })

  it('saves the current views and filters under a name, and brings them back', async () => {
    localStorage.clear()
    serveFleet([vehicle()])
    const user = userEvent.setup()
    await openVehicles('/vehicles?ready=1&sort=depot')
    await within(table()).findAllByText(/AA 3-/)
    await user.click(screen.getByRole('button', { name: 'Saved views' }))
    await user.type(screen.getByLabelText('Name for the current view'), 'Ready by depot')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    // Elsewhere, then back with one click.
    await user.click(within(screen.getByRole('group', { name: 'Vehicle views' })).getByRole('button', { name: /^All/ }))
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/vehicles/))
    await user.click(screen.getByRole('button', { name: 'Saved views' }))
    await user.click(screen.getByRole('button', { name: 'Ready by depot' }))
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('ready=1'))
    expect(screen.getByTestId('location')).toHaveTextContent('sort=depot')
    // And it can be removed.
    await user.click(screen.getByRole('button', { name: 'Saved views' }))
    await user.click(screen.getByRole('button', { name: 'Delete saved view Ready by depot' }))
    expect(screen.queryByRole('button', { name: 'Ready by depot' })).not.toBeInTheDocument()
  })

  describe('sorting', () => {
    it('sorts by depot, status and type, flipping the order on a second click', async () => {
      const api = serveFleet([vehicle(), vehicle()])
      const user = userEvent.setup()
      await openVehicles()
      await within(table()).findAllByText(/AA 3-/)

      await user.click(within(table()).getByRole('button', { name: /^Depot/ }))
      await waitFor(() => expect(api.listQueries().at(-1)?.get('sort_by')).toBe('depot'))
      expect(api.listQueries().at(-1)?.get('sort_order')).toBe('asc')
      await user.click(within(table()).getByRole('button', { name: /^Depot/ }))
      await waitFor(() => expect(api.listQueries().at(-1)?.get('sort_order')).toBe('desc'))
      expect(screen.getByTestId('location')).toHaveTextContent('sort=depot')
      expect(screen.getByTestId('location')).toHaveTextContent('order=desc')

      await user.click(within(table()).getByRole('button', { name: /^Status/ }))
      await waitFor(() => expect(api.listQueries().at(-1)?.get('sort_by')).toBe('status'))
      expect(api.listQueries().at(-1)?.get('sort_order')).toBe('asc')
    })
  })

  describe('row actions and exceptions', () => {
    it('has one text "Edit" per row; Decommission lives in the edit drawer, apart from Save', async () => {
      const v = vehicle()
      serveFleet([v])
      const user = userEvent.setup()
      await openVehicles()
      await within(table()).findByText(v.registration_number)
      const row = rowFor(v.registration_number)
      expect(within(row).getByRole('button', { name: `Edit ${v.registration_number}` })).toHaveTextContent('Edit')
      expect(within(row).queryByRole('button', { name: /^Decommission / })).not.toBeInTheDocument()
      await user.click(within(row).getByRole('button', { name: `Edit ${v.registration_number}` }))
      expect(await screen.findByRole('button', { name: 'Decommission vehicle' })).toBeInTheDocument()
    })

    it('says "Flagged" in words on a flagged vehicle', async () => {
      const v = vehicle({ maintenance_flag: true })
      serveFleet([v])
      await openVehicles()
      await within(table()).findByText(v.registration_number)
      expect(within(rowFor(v.registration_number)).getByText('Flagged')).toBeInTheDocument()
    })

    it('drops the Status column when the chosen view is one status, since every row would say the same', async () => {
      serveFleet([vehicle()])
      await openVehicles('/vehicles?status=active')
      await within(table()).findByText(/AA 3-/)
      expect(within(table()).queryByRole('columnheader', { name: 'Status' })).not.toBeInTheDocument()
    })

    it('keeps the Status column in the All view', async () => {
      serveFleet([vehicle()])
      await openVehicles()
      await within(table()).findByText(/AA 3-/)
      expect(within(table()).getByRole('columnheader', { name: 'Status' })).toBeInTheDocument()
    })
  })

  describe('the "/" shortcut', () => {
    it('jumps to the search box from anywhere on the page', async () => {
      serveFleet([vehicle()])
      const user = userEvent.setup()
      await openVehicles()
      await within(table()).findByText(/AA 3-/)
      await user.keyboard('/')
      expect(screen.getByRole('searchbox', { name: 'Search vehicles' })).toHaveFocus()
    })

    it('types a slash like any other key once you are in a field', async () => {
      serveFleet([vehicle()])
      const user = userEvent.setup()
      await openVehicles()
      const search = screen.getByRole('searchbox', { name: 'Search vehicles' })
      await user.click(search)
      await user.keyboard('AA/3')
      expect(search).toHaveValue('AA/3')
    })
  })

  it('explains what the Flagged and Workshop views mean', async () => {
    serveFleet([vehicle()])
    await openVehicles()
    const views = screen.getByRole('group', { name: 'Vehicle views' })
    expect(within(views).getByRole('button', { name: /^Flagged/ })).toHaveAttribute('title', 'Vehicles flagged as needing maintenance')
    expect(within(views).getByRole('button', { name: /^Workshop/ })).toHaveAttribute('title', 'Vehicles currently in maintenance')
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
    signedInAs(driver)
    renderApp('/vehicles')

    await screen.findByRole('button', { name: 'Notifications' })
    expect(screen.getByRole('main')).toBeEmptyDOMElement()
    expect(screen.queryByText(/denied|forbidden|not allowed/i)).not.toBeInTheDocument()
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

describe('Vehicle status panel (FMS-76)', () => {
  function statusView(v: Vehicle, overrides: Partial<VehicleStatusView> = {}): VehicleStatusView {
    return {
      vehicle_id: v.id,
      registration_number: v.registration_number,
      depot_id: v.depot_id,
      status: v.status,
      maintenance: { flagged: false, in_workshop: false, open_record_id: null },
      availability: { availability: 'available', reasons: [], window: { start: '2026-11-02T06:00:00Z', end: '2026-11-02T06:00:00Z' } },
      current_assignment: null,
      next_assignment: null,
      last_status_change: null,
      version: v.version,
      updated_at: v.updated_at,
      ...overrides,
    }
  }

  const TRIP = '7a000000-0000-4000-8000-000000000001'

  async function openStatus(v: Vehicle) {
    const user = userEvent.setup()
    await within(table()).findByText(v.registration_number)
    await user.click(within(rowFor(v.registration_number)).getByRole('button', { name: `Availability of ${v.registration_number}` }))
    return { user, panel: await screen.findByRole('dialog', { name: `${v.registration_number} status` }) }
  }

  it('shows availability with every reason, the next trip and the last change', async () => {
    const v = vehicle({ maintenance_flag: true })
    serveFleet([v])
    server.use(
      http.get(`/api/v1/vehicles/${v.id}/status`, () =>
        envelope(
          statusView(v, {
            maintenance: { flagged: true, in_workshop: false, open_record_id: '9b000000-0000-4000-8000-000000000001' },
            availability: {
              availability: 'unavailable',
              reasons: [
                { code: 'maintenance_flag', severity: 'block' },
                { code: 'assigned_to_overlapping_trip', severity: 'block', trip_id: TRIP },
              ],
              window: { start: '2026-11-02T06:00:00Z', end: '2026-11-02T06:00:00Z' },
            },
            next_assignment: { trip_id: TRIP, status: 'assigned', start: '2026-11-03T05:00:00Z', end: '2026-11-03T08:00:00Z' },
            last_status_change: {
              from_status: 'maintenance',
              to_status: 'active',
              reason: 'Brakes replaced',
              source: 'maintenance',
              maintenance_record_id: '9b000000-0000-4000-8000-000000000002',
              changed_at: '2026-11-01T09:30:00Z',
              changed_by: null,
            },
          }),
        ),
      ),
    )
    await openVehicles()
    const { panel } = await openStatus(v)

    expect(await within(panel).findByText('Not available now')).toBeInTheDocument()
    expect(within(panel).getByText('Flagged for maintenance: work on it is still open')).toBeInTheDocument()
    expect(within(panel).getByText('On another trip at that time')).toBeInTheDocument()
    // Times in Addis Ababa (UTC+3).
    expect(within(panel).getByText('3 Nov, 08:00 – 3 Nov, 11:00')).toBeInTheDocument()
    expect(within(panel).getByText('“Brakes replaced”')).toBeInTheDocument()
    expect(within(panel).getByText(/by maintenance work/)).toBeInTheDocument()
  })

  it('changes the status with a reason and If-Match, and lists the assigned trips that need another vehicle', async () => {
    const v = vehicle({ version: 3 })
    serveFleet([v])
    let sent: { body: unknown; ifMatch: string | null } | null = null
    server.use(
      http.get(`/api/v1/vehicles/${v.id}/status`, () => envelope(statusView(v))),
      http.post(`/api/v1/vehicles/${v.id}/status`, async ({ request }) => {
        sent = { body: await request.json(), ifMatch: request.headers.get('If-Match') }
        return HttpResponse.json({
          data: statusView({ ...v, status: 'inactive', version: 4 }),
          meta: { request_id: 'r-1', warnings: [{ warning: 'ASSIGNED_TRIP_AFFECTED', trip_id: TRIP, start: '2026-11-03T05:00:00Z' }] },
        })
      }),
    )
    await openVehicles()
    const { user, panel } = await openStatus(v)

    const change = await within(panel).findByRole('button', { name: 'Change status' })
    expect(change).toBeDisabled()
    // The current status is shown, not offered.
    expect(within(panel).getByRole('radio', { name: /^Active/ })).toBeDisabled()
    await user.click(within(panel).getByRole('radio', { name: /^Out of service/ }))
    await user.click(change)
    expect(await within(panel).findByText('Say why, in a few words: it is kept with the change.')).toBeInTheDocument()
    expect(sent).toBeNull()

    await user.type(within(panel).getByLabelText('Reason'), 'Accident damage, awaiting assessment')
    await user.click(change)
    await waitFor(() => expect(sent).not.toBeNull())
    expect(sent).toEqual({ body: { status: 'inactive', reason: 'Accident damage, awaiting assessment' }, ifMatch: '"3"' })
    expect(await within(panel).findByText('Assigned trips need another vehicle')).toBeInTheDocument()
    expect(within(panel).getByText(/starting 3 Nov, 08:00/)).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(`${v.registration_number} is now out of service`)
  })

  it('shows a refusal inside the panel: a vehicle under way cannot be taken off the road', async () => {
    const v = vehicle()
    serveFleet([v])
    server.use(
      http.get(`/api/v1/vehicles/${v.id}/status`, () => envelope(statusView(v))),
      http.post(`/api/v1/vehicles/${v.id}/status`, () => errorEnvelope(409, 'CONFLICT_VEHICLE_IN_USE')),
    )
    await openVehicles()
    const { user, panel } = await openStatus(v)
    await user.click(await within(panel).findByRole('radio', { name: /^In the workshop/ }))
    await user.type(within(panel).getByLabelText('Reason'), 'Service due')
    await user.click(within(panel).getByRole('button', { name: 'Change status' }))
    expect(await within(panel).findByRole('alert')).toHaveTextContent('on a trip under way')
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('is read-only without vehicle:write', async () => {
    const v = vehicle()
    serveFleet([v])
    server.use(http.get(`/api/v1/vehicles/${v.id}/status`, () => envelope(statusView(v))))
    signedInAs(currentUser(['compliance_officer'], ['vehicle:read', 'depot:read', 'document:read']))
    renderApp('/vehicles')
    await screen.findByRole('table', { name: 'Vehicles' })
    const { panel } = await openStatus(v)
    expect(await within(panel).findByText('Available now')).toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: 'Change status' })).not.toBeInTheDocument()
    expect(within(panel).queryByRole('radio')).not.toBeInTheDocument()
  })
})

describe('Health column (FMS-56)', () => {
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()

  it('shows every vehicle reader the score in its band colour, and a stale one as STALE', async () => {
    const [risky, watch, stale] = [vehicle({ health_score: 60, health_score_updated_at: hoursAgo(3) }), vehicle({ health_score: 80, health_score_updated_at: hoursAgo(3) }), vehicle({ health_score: 91, health_score_updated_at: hoursAgo(26) })]
    serveFleet([risky, watch, stale])
    signedInAs(currentUser(['dispatcher'], ['vehicle:read', 'depot:read', 'trip:assign']))
    renderApp('/vehicles')
    await screen.findByText(risky.registration_number)

    // A dispatcher has no prediction:read: the badge is not a button, and there is no breakdown to open.
    const red = within(rowFor(risky.registration_number)).getByTitle(/Health score 60, at risk/)
    expect(red).toHaveClass('bg-danger-soft')
    expect(within(rowFor(risky.registration_number)).queryByRole('button', { name: /Health score/ })).not.toBeInTheDocument()
    expect(within(rowFor(watch.registration_number)).getByTitle(/Health score 80, watch/)).toHaveClass('bg-warning-soft')
    const grey = within(rowFor(stale.registration_number)).getByTitle(/Health score 91, stale/)
    expect(grey).toHaveClass('bg-neutral-soft')
    expect(grey).toHaveTextContent('Stale')
  })

  it('opens the breakdown from the badge for those with prediction:read', async () => {
    const risky = vehicle({ health_score: 60, health_score_updated_at: hoursAgo(3) })
    serveFleet([risky])
    server.use(
      http.get('/api/v1/vehicles/:id/maintenance-risk', () =>
        envelope({
          vehicle_id: risky.id, prediction_id: 'p-1', health_score: 60, risk_level: 'medium', failure_probability: 0.4, prediction_horizon_days: 30,
          factors: [{ feature: 'days_since_last_service', value: 100, unit: 'd' }], model_name: 'predictive-maintenance', model_version: 'pm-2026.10',
          as_of: hoursAgo(5), scored_at: hoursAgo(3), stale: false,
        }),
      ),
    )
    const user = userEvent.setup()
    signedInAs(currentUser(['technician'], ['vehicle:read', 'depot:read', 'prediction:read']))
    renderApp('/vehicles')

    await user.click(await within(await waitFor(() => rowFor(risky.registration_number))).findByRole('button', { name: /Health score 60, at risk/ }))
    const panel = await screen.findByRole('dialog', { name: `${risky.registration_number} health` })
    expect(await within(panel).findByText('Time since last service')).toBeInTheDocument()
    // No maintenance:write: nothing to schedule from here.
    expect(within(panel).queryByRole('button', { name: 'Schedule inspection' })).not.toBeInTheDocument()
  })
})

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { today } from '@/features/documents/expiry'
import type { OwnedDocument } from '@/features/documents/types'
import { currentUser, envelope, errorEnvelope, renderApp, signedInAs } from '@/test/auth'
import { server } from '@/test/msw/server'
import type { Driver } from './types'

const DEPOT_A = '11111111-1111-4111-8111-111111111111'
const DEPOT_B = '22222222-2222-4222-8222-222222222222'

const depotAdmin = currentUser(
  ['depot_admin'],
  ['driver:read', 'driver:write', 'driver:delete', 'depot:read', 'document:read', 'document:write'],
)
const dispatcher = currentUser(['dispatcher'], ['driver:read', 'depot:read', 'document:read', 'vehicle:read'])
const driverRole = currentUser(['driver'], ['vehicle:read', 'trip:execute', 'document:read', 'document:write'])

function plusDays(days: number): string {
  const d = new Date(`${today()}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

let seq = 0
function driver(overrides: Partial<Driver> = {}): Driver {
  seq += 1
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    user_id: `10000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    full_name: `Driver ${seq}`,
    email: `driver${seq}@fleet.test`,
    phone: null,
    depot_id: DEPOT_A,
    license_number: `DL-${1000 + seq}`,
    license_categories: ['B', 'CE'],
    license_expiry: plusDays(400),
    license_status: 'valid',
    hire_date: null,
    emergency_phone: null,
    status: 'active',
    current_trip: null,
    version: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

/** A fake GET /drivers over `all`, with the licence and status filters and counts; plus depots and documents. */
function serveDrivers(all: Driver[], documents: OwnedDocument[] = []) {
  server.use(
    http.get('/api/v1/drivers', ({ request }) => {
      const q = new URL(request.url).searchParams
      let rows = all.filter((d) => d.status === (q.get('status') ?? 'active'))
      if (q.get('license_status')) rows = rows.filter((d) => d.license_status === q.get('license_status'))
      if (q.get('depot_id')) rows = rows.filter((d) => d.depot_id === q.get('depot_id'))
      const size = Number(q.get('page_size') ?? 25)
      return HttpResponse.json({
        data: rows.slice(0, size),
        meta: { page: 1, page_size: size, total_items: rows.length, total_pages: Math.ceil(rows.length / size) },
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
}

const table = () => screen.getByRole('table', { name: 'Drivers' })
const rowFor = (name: string) => within(table()).getByText(name).closest('tr') as HTMLElement

async function openDrivers(user = depotAdmin) {
  signedInAs(user)
  renderApp('/drivers')
  await screen.findByRole('heading', { name: 'Drivers' })
}

describe('Driver Management (S-05)', () => {
  it('shows a red EXPIRED badge for an expired licence, with no user action', async () => {
    const expired = driver({ license_expiry: plusDays(-3), license_status: 'expired' })
    serveDrivers([expired])
    await openDrivers()

    const [badge] = await within(await screen.findByRole('table', { name: 'Drivers' })).findAllByText('EXPIRED')
    expect(badge).toHaveAttribute('data-licence', 'expired')
    expect(badge.closest('span.rounded-full')).toHaveClass('bg-danger-soft')
    expect(rowFor(expired.full_name)).toContainElement(badge)
  })

  it('shows an amber EXPIRING SOON badge for a licence expiring in 15 days', async () => {
    const soon = driver({ license_expiry: plusDays(15), license_status: 'expiring_soon' })
    const fine = driver()
    serveDrivers([soon, fine])
    await openDrivers()

    const [badge] = await within(await screen.findByRole('table', { name: 'Drivers' })).findAllByText('EXPIRING SOON')
    expect(badge.closest('span.rounded-full')).toHaveClass('bg-warning-soft')
    expect(badge).toHaveAttribute('title', 'In 15 days')
    expect(rowFor(soon.full_name)).toContainElement(badge)
    expect(within(rowFor(fine.full_name)).getAllByText('Valid')[0]).toHaveAttribute('data-licence', 'valid')
  })

  it('a dispatcher sees the list, but not the Add driver button or write actions', async () => {
    const d = driver()
    serveDrivers([d])
    await openDrivers(dispatcher)

    await within(await screen.findByRole('table', { name: 'Drivers' })).findByText(d.full_name)
    expect(screen.queryByRole('button', { name: 'Add driver' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Edit / })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Retire / })).not.toBeInTheDocument()
  })

  it('renders nothing for a driver: no data, no access-denied message', async () => {
    let listed = false
    server.use(
      http.get('/api/v1/drivers', () => {
        listed = true
        return envelope([])
      }),
    )
    signedInAs(driverRole)
    renderApp('/drivers')
    await screen.findByText('Sam Tester')
    expect(screen.getByRole('main')).toBeEmptyDOMElement()
    expect(listed).toBe(false)
  })

  describe('add driver', () => {
    async function fillForm(user: ReturnType<typeof userEvent.setup>, licence: string) {
      await user.click(screen.getAllByRole('button', { name: 'Add driver' })[0])
      const drawer = await screen.findByRole('dialog', { name: 'Add driver' })
      const field = (label: string | RegExp) => within(drawer).getByLabelText(label)
      await user.type(field('Full name'), 'Tigist Haile')
      await user.type(field('Email'), 'Tigist@Fleet.test')
      await user.type(field('Licence number'), licence)
      await user.type(field('Expires on'), '2031-01-31')
      await user.click(within(drawer).getByRole('button', { name: 'CE' }))
      await user.click(within(drawer).getByRole('button', { name: 'B' }))
      await user.selectOptions(field('Home depot'), DEPOT_B)
      await user.click(within(drawer).getByRole('button', { name: 'Add driver' }))
      return drawer
    }

    it('shows a licence number already in use as an inline 409 on the field', async () => {
      serveDrivers([driver()])
      server.use(http.post('/api/v1/drivers', () => errorEnvelope(409, 'CONFLICT_DUPLICATE_LICENSE', 'taken', [{ field: 'license_number', reason: 'already_exists' }])))
      const user = userEvent.setup()
      await openDrivers()
      const drawer = await fillForm(user, 'dl-1001')

      expect(await within(drawer).findByText('Another driver already has this licence number.')).toBeInTheDocument()
      expect(within(drawer).getByLabelText('Licence number')).toHaveAttribute('aria-invalid', 'true')
      // Still open, nothing announced as done.
      expect(screen.getByRole('dialog', { name: 'Add driver' })).toBeInTheDocument()
      expect(screen.getByRole('status')).toBeEmptyDOMElement()
    })

    it('shows an email already in use on the email field', async () => {
      serveDrivers([driver()])
      server.use(http.post('/api/v1/drivers', () => errorEnvelope(409, 'CONFLICT_DUPLICATE', 'taken', [{ field: 'account.email', reason: 'already_exists' }])))
      const user = userEvent.setup()
      await openDrivers()
      const drawer = await fillForm(user, 'DL-9')
      expect(await within(drawer).findByText('An account with this email already exists.')).toBeInTheDocument()
    })

    it('creates the account and licence in one request', async () => {
      serveDrivers([driver()])
      let body: Record<string, unknown> | undefined
      server.use(
        http.post('/api/v1/drivers', async ({ request }) => {
          body = (await request.json()) as Record<string, unknown>
          return envelope(driver({ full_name: 'Tigist Haile' }))
        }),
      )
      const user = userEvent.setup()
      await openDrivers()
      await fillForm(user, ' dl  77/2026 ')

      await waitFor(() => expect(body).toBeDefined())
      expect(body).toEqual({
        account: { full_name: 'Tigist Haile', email: 'tigist@fleet.test', phone: null },
        license_number: 'DL 77/2026',
        license_categories: ['B', 'CE'],
        license_expiry: '2031-01-31',
        hire_date: null,
        emergency_phone: null,
        depot_id: DEPOT_B,
      })
      expect(await screen.findByText('Driver added')).toBeInTheDocument()
    })

    it('checks required fields before sending', async () => {
      serveDrivers([driver()])
      const user = userEvent.setup()
      await openDrivers()
      await user.click(screen.getAllByRole('button', { name: 'Add driver' })[0])
      const drawer = await screen.findByRole('dialog', { name: 'Add driver' })
      await user.type(within(drawer).getByLabelText('Email'), 'not-an-email')
      await user.click(within(drawer).getByRole('button', { name: 'Add driver' }))

      expect(within(drawer).getByText('Enter the driver’s full name.')).toBeInTheDocument()
      expect(within(drawer).getByText('Enter a valid email address, like name@example.com.')).toBeInTheDocument()
      expect(within(drawer).getByText('Enter the licence number.')).toBeInTheDocument()
      expect(within(drawer).getByText('Enter the expiry date on the licence.')).toBeInTheDocument()
    })
  })

  it('edits the licence through the panel with If-Match, sending only what changed', async () => {
    const d = driver({ version: 4 })
    serveDrivers([d])
    let sent: { body: unknown; ifMatch: string | null } | undefined
    server.use(
      http.patch(`/api/v1/drivers/${d.id}`, async ({ request }) => {
        sent = { body: await request.json(), ifMatch: request.headers.get('if-match') }
        return envelope({ ...d, license_expiry: '2032-02-29' })
      }),
    )
    const user = userEvent.setup()
    await openDrivers()
    await within(await screen.findByRole('table', { name: 'Drivers' })).findByText(d.full_name)

    await user.click(screen.getByRole('button', { name: `Edit ${d.full_name}` }))
    const drawer = await screen.findByRole('dialog', { name: `Edit ${d.full_name}` })
    expect(within(drawer).queryByLabelText('Email')).not.toBeInTheDocument()
    const expiry = within(drawer).getByLabelText('Expires on')
    await user.clear(expiry)
    await user.type(expiry, '2032-02-29')
    await user.click(within(drawer).getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(sent).toBeDefined())
    expect(sent).toEqual({ body: { license_expiry: '2032-02-29' }, ifMatch: '"4"' })
  })

  it('needs the licence number typed to retire, and shows 409 CONFLICT_DRIVER_IN_USE in the dialog', async () => {
    const d = driver()
    serveDrivers([d])
    server.use(http.delete(`/api/v1/drivers/${d.id}`, () => errorEnvelope(409, 'CONFLICT_DRIVER_IN_USE')))
    const user = userEvent.setup()
    await openDrivers()
    await within(await screen.findByRole('table', { name: 'Drivers' })).findByText(d.full_name)

    await user.click(screen.getByRole('button', { name: `Retire ${d.full_name}` }))
    const dialog = await screen.findByRole('dialog', { name: `Retire ${d.full_name}` })
    const confirm = within(dialog).getByRole('button', { name: 'Retire driver' })
    expect(confirm).toBeDisabled()
    await user.type(within(dialog).getByLabelText(`Type ${d.license_number} to confirm`), d.license_number)
    await user.click(confirm)
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('on an active trip or assigned to a vehicle')
  })

  it('filters by licence status from the stat cards, keeping it in the URL', async () => {
    const expired = driver({ license_status: 'expired', license_expiry: plusDays(-1) })
    const fine = driver()
    serveDrivers([expired, fine])
    const user = userEvent.setup()
    await openDrivers()
    await within(await screen.findByRole('table', { name: 'Drivers' })).findByText(fine.full_name)

    await user.click(screen.getByRole('button', { name: /^Expired/ }))
    await waitFor(() => expect(within(table()).queryByText(fine.full_name)).not.toBeInTheDocument())
    expect(within(table()).getByText(expired.full_name)).toBeInTheDocument()
    expect(screen.getByTestId('location')).toHaveTextContent('/drivers?licence=expired')
  })

  it('shows the active trip and document health', async () => {
    const d = driver({ current_trip: { id: 't-9', status: 'en_route', origin: 'Adama', destination: 'Dire Dawa', scheduled_start: null } })
    const doc: OwnedDocument = {
      id: 'd-1',
      owner_type: 'driver',
      owner_id: d.id,
      document_type: 'licence',
      original_filename: 'licence.pdf',
      content_type: 'application/pdf',
      size_bytes: 1000,
      sha256: 'a'.repeat(64),
      expires_on: plusDays(-2),
      retain_until: null,
      uploaded_by: 'u-1',
      uploaded_at: '2026-01-01T00:00:00Z',
    }
    serveDrivers([d], [doc])
    await openDrivers()
    await within(await screen.findByRole('table', { name: 'Drivers' })).findByText(d.full_name)

    expect(within(rowFor(d.full_name)).getByRole('link', { name: /Adama.*Dire Dawa/ })).toHaveAttribute('href', '/dispatch?trip=t-9')
    expect(await within(rowFor(d.full_name)).findByText('1 expired')).toHaveClass('bg-danger-soft')
  })

  it('says so when a depot has no drivers', async () => {
    serveDrivers([])
    await openDrivers()
    expect(await screen.findByText('No drivers registered for this depot')).toBeInTheDocument()
  })
})

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { currentUser, envelope, errorEnvelope, renderApp, signedInAs } from '@/test/auth'
import { server } from '@/test/msw/server'
import type { GpsDevice, Provider, UnknownDevice } from './api'

// S-34 Telematics (FMS-138): the providers' status, the device registry, and linking the devices a provider sends.

const admin = currentUser(['admin'], ['integration:read', 'integration:execute', 'vehicle:read'])
const reader = currentUser(['admin'], ['integration:read'])

const MIN = 60_000
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

const provider = (over: Partial<Provider> = {}): Provider => ({
  id: 'p-sim',
  code: 'fms-simulator',
  name: 'FMS GPS simulator',
  provider_type: 'telematics',
  is_active: true,
  status: 'operational',
  webhook_secret_configured: true,
  last_error: null,
  last_delivery_at: ago(4 * MIN),
  today: { deliveries: 120, deliveries_rejected: 0, positions_accepted: 2400, positions_rejected: 3 },
  devices: { linked: 2, unknown: 1 },
  circuit: null,
  ...over,
})

const device = (over: Partial<GpsDevice> = {}): GpsDevice => ({
  id: 'dev-1',
  device_identifier: 'IMEI-356307042441013',
  device_model: 'Teltonika FMB920',
  provider: { id: 'p-sim', code: 'fms-simulator', name: 'FMS GPS simulator' },
  credential: 'provider',
  vehicle: { id: 'v-1', registration_number: 'AA 3-41207' },
  status: 'active',
  installed_at: '2026-11-01T08:00:00Z',
  removed_at: null,
  last_seen_at: ago(2 * MIN),
  last_error: null,
  ...over,
})

const unknownDevice: UnknownDevice = {
  provider: { id: 'p-sim', code: 'fms-simulator', name: 'FMS GPS simulator' },
  device_identifier: 'GT-NEW-77',
  first_seen_at: ago(60 * MIN),
  last_seen_at: ago(3 * MIN),
  positions: 42,
}

const vehicle = { id: 'v-9', registration_number: 'AA 3-50110', make: 'Isuzu', model: 'NPR', year: 2021, status: 'available' }

/** The integration API: providers (the mapping provider is filtered out by the screen), devices, unknown ids; writes recorded. */
function serve(options: { providers?: Provider[]; devices?: GpsDevice[]; unknown?: UnknownDevice[] } = {}) {
  const writes: { method: string; path: string; body: unknown }[] = []
  server.use(
    http.get('/api/v1/integrations/providers', () =>
      envelope([...(options.providers ?? [provider()]), { ...provider({ id: 'p-map', code: 'osrm', name: 'Road routing' }), provider_type: 'mapping', devices: null }]),
    ),
    http.get('/api/v1/integrations/devices', () => envelope(options.devices ?? [device()])),
    http.get('/api/v1/integrations/devices/unknown', () => envelope(options.unknown ?? [])),
    http.get('/api/v1/vehicles', () => HttpResponse.json({ data: [vehicle], meta: { page: 1, page_size: 20, total_items: 1, total_pages: 1 } })),
    http.delete('/api/v1/integrations/devices/:id', ({ params }) => {
      writes.push({ method: 'DELETE', path: `/integrations/devices/${params.id}`, body: null })
      return new HttpResponse(null, { status: 204 })
    }),
  )
  return writes
}

async function open(user = admin, at = '/telematics') {
  signedInAs(user)
  renderApp(at)
  await screen.findByRole('heading', { name: 'Telematics', level: 1 })
  return userEvent.setup()
}

async function chooseVehicle(user: ReturnType<typeof userEvent.setup>, panel: HTMLElement) {
  await user.type(within(panel).getByRole('combobox', { name: 'Vehicle' }), 'AA')
  await user.click(await within(panel).findByRole('option', { name: /AA 3-50110/ }))
}

describe('S-34 Telematics (FMS-138)', () => {
  it('shows each telematics provider with its last delivery, today’s traffic and circuit, and the devices with their last error', async () => {
    serve({
      providers: [provider(), provider({ id: 'p-geo', code: 'geotab-et', name: 'Geotab', status: 'unknown', webhook_secret_configured: false, last_delivery_at: null, today: { deliveries: 0, deliveries_rejected: 0, positions_accepted: 0, positions_rejected: 0 }, devices: { linked: 0, unknown: 0 } })],
      devices: [
        device(),
        device({ id: 'dev-2', device_identifier: 'sim-tok-1', device_model: null, provider: null, credential: 'token', vehicle: { id: 'v-2', registration_number: 'AA 3-77001' }, last_seen_at: null, last_error: { reason: 'too_old', at: ago(10 * MIN) } }),
      ],
    })
    await open()
    const providers = await screen.findByRole('list', { name: 'Telematics providers' })
    const [sim, geotab] = within(providers).getAllByRole('listitem')
    expect(within(providers).queryByText('Road routing')).not.toBeInTheDocument()
    expect(sim).toHaveTextContent('FMS GPS simulator')
    expect(sim).toHaveTextContent('/webhooks/telematics/fms-simulator')
    expect(sim).toHaveTextContent('Receiving')
    expect(sim).toHaveTextContent('4 min ago')
    expect(sim).toHaveTextContent('120 deliveries, 2,400 positions')
    expect(sim).toHaveTextContent('3 positions')
    expect(sim).toHaveTextContent('2 linked · 1 unlinked')
    expect(sim).toHaveTextContent('Not called: this provider only sends webhooks')
    expect(geotab).toHaveTextContent('Nothing yet')
    expect(geotab).toHaveTextContent('Never')
    expect(within(geotab).getByRole('note')).toHaveTextContent('No webhook secret: set INTEGRATION_GEOTAB_ET_WEBHOOK_SECRET on the server.')

    const table = await screen.findByRole('table', { name: 'Devices' })
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows[0]).toHaveTextContent('IMEI-356307042441013')
    expect(rows[0]).toHaveTextContent('Teltonika FMB920')
    expect(rows[0]).toHaveTextContent('AA 3-41207')
    expect(rows[0]).toHaveTextContent('2 min ago')
    expect(rows[1]).toHaveTextContent('Own token')
    expect(rows[1]).toHaveTextContent('Never')
    expect(rows[1]).toHaveTextContent('Older than 7 days')
  })

  it('links a device a provider is sending: the form starts with its provider and id, and the vehicle chosen is sent', async () => {
    serve({ unknown: [unknownDevice] })
    let body: unknown = null
    server.use(
      http.post('/api/v1/integrations/devices', async ({ request }) => {
        body = await request.json()
        return HttpResponse.json({ data: device({ id: 'dev-new', device_identifier: 'GT-NEW-77' }), meta: { request_id: 'r' } }, { status: 201 })
      }),
    )
    const user = await open()
    const list = await screen.findByRole('list', { name: 'Unlinked devices' })
    expect(list).toHaveTextContent('GT-NEW-77')
    expect(list).toHaveTextContent('FMS GPS simulator · 42 positions refused · last 3 min ago')
    await user.click(within(list).getByRole('button', { name: 'Link GT-NEW-77' }))
    const panel = await screen.findByRole('dialog', { name: 'Link device' })
    expect(within(panel).getByLabelText('Provider')).toHaveValue('p-sim')
    expect(within(panel).getByLabelText('Device id')).toHaveValue('GT-NEW-77')
    await chooseVehicle(user, panel)
    await user.click(screen.getAllByRole('button', { name: 'Link device' }).at(-1)!)

    await waitFor(() => expect(body).toEqual({ provider_id: 'p-sim', device_identifier: 'GT-NEW-77', vehicle_id: 'v-9', device_model: null, replace: false }))
    expect(await screen.findByText('Device linked')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Link device' })).not.toBeInTheDocument())
  })

  it('a vehicle with a device asks before replacing it, then sends replace; a bad id never leaves the form', async () => {
    serve()
    const bodies: Record<string, unknown>[] = []
    server.use(
      http.post('/api/v1/integrations/devices', async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>
        bodies.push(body)
        if (!body.replace) {
          return errorEnvelope(409, 'CONFLICT_DUPLICATE', 'The vehicle already has device TRK-0042. Link with replace to take it out of service.', [{ field: 'vehicle_id', reason: 'vehicle_has_device', record_id: 'dev-old' }])
        }
        return HttpResponse.json({ data: device({ id: 'dev-new' }), meta: { request_id: 'r' } }, { status: 201 })
      }),
    )
    const user = await open()
    await user.click(await screen.findByRole('button', { name: 'Link device' }))
    const panel = await screen.findByRole('dialog', { name: 'Link device' })

    await user.type(within(panel).getByLabelText('Device id'), 'IMEI 1')
    await user.click(screen.getAllByRole('button', { name: 'Link device' }).at(-1)!)
    expect(within(panel).getByText('Letters, digits and punctuation only, without spaces.')).toBeInTheDocument()
    expect(within(panel).getByText('Choose the vehicle the device is installed in.')).toBeInTheDocument()
    expect(bodies).toEqual([])

    await user.clear(within(panel).getByLabelText('Device id'))
    await user.type(within(panel).getByLabelText('Device id'), 'IMEI-2')
    await chooseVehicle(user, panel)
    await user.click(screen.getAllByRole('button', { name: 'Link device' }).at(-1)!)
    const warning = await within(panel).findByRole('alert')
    expect(warning).toHaveTextContent('AA 3-50110 already has device TRK-0042. Replacing it takes TRK-0042 out of service')
    await user.click(within(warning).getByRole('button', { name: 'Replace TRK-0042' }))
    await waitFor(() => expect(bodies.map((b) => b.replace)).toEqual([false, true]))
    expect(await screen.findByText('Device linked')).toBeInTheDocument()
  })

  it('another provider’s id is said on its field', async () => {
    serve()
    server.use(http.post('/api/v1/integrations/devices', () => errorEnvelope(409, 'CONFLICT_DUPLICATE', 'taken', [{ field: 'device_identifier', reason: 'already_exists' }])))
    const user = await open()
    await user.click(await screen.findByRole('button', { name: 'Link device' }))
    const panel = await screen.findByRole('dialog', { name: 'Link device' })
    await user.type(within(panel).getByLabelText('Device id'), 'IMEI-3')
    await chooseVehicle(user, panel)
    await user.click(screen.getAllByRole('button', { name: 'Link device' }).at(-1)!)
    expect(await within(panel).findByText('This id is already another provider’s device, or a device with its own token.')).toBeInTheDocument()
  })

  it('unlinks a device after confirming, and lists unlinked ones under their own view', async () => {
    const writes = serve({ devices: [device(), device({ id: 'dev-3', device_identifier: 'OLD-9', status: 'removed', removed_at: ago(2 * 24 * 60 * MIN) })] })
    const user = await open()
    const table = await screen.findByRole('table', { name: 'Devices' })
    expect(within(table).queryByText('OLD-9')).not.toBeInTheDocument()
    await user.click(within(table).getByRole('button', { name: 'Unlink IMEI-356307042441013' }))
    const dialog = await screen.findByRole('dialog', { name: 'Unlink IMEI-356307042441013?' })
    expect(dialog).toHaveTextContent('Its positions stop counting for AA 3-41207')
    await user.click(within(dialog).getByRole('button', { name: 'Unlink device' }))
    await waitFor(() => expect(writes).toEqual([{ method: 'DELETE', path: '/integrations/devices/dev-1', body: null }]))
    expect(await screen.findByText('Device unlinked')).toBeInTheDocument()

    await user.click(within(screen.getByRole('group', { name: 'Device views' })).getByRole('button', { name: /Unlinked/ }))
    const removed = await screen.findByRole('table', { name: 'Devices' })
    expect(within(removed).getByText('OLD-9')).toBeInTheDocument()
    expect(within(removed).queryByRole('button', { name: /Unlink/ })).not.toBeInTheDocument()
  })

  it('without integration:execute it is read-only', async () => {
    serve({ unknown: [unknownDevice] })
    await open(reader)
    await screen.findByRole('table', { name: 'Devices' })
    expect(await screen.findByRole('list', { name: 'Unlinked devices' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Link device' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Link / })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Unlink / })).not.toBeInTheDocument()
  })

  it('says when there is no provider and no device yet', async () => {
    serve({ providers: [], devices: [] })
    await open()
    expect(await screen.findByText('No telematics provider yet')).toBeInTheDocument()
    expect(await screen.findByText('No devices linked yet')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Link device' })).toBeDisabled()
  })

  it('a failed read of the providers says so and tries again', async () => {
    serve()
    server.use(http.get('/api/v1/integrations/providers', () => errorEnvelope(500, 'INTERNAL_SERVER_ERROR')))
    const user = await open()
    expect(await screen.findByText('Providers could not be loaded', {}, { timeout: 8000 })).toBeInTheDocument()
    server.use(http.get('/api/v1/integrations/providers', () => envelope([provider()])))
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('list', { name: 'Telematics providers' })).toHaveTextContent('FMS GPS simulator')
  }, 15_000)
})

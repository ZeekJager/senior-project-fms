import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Geofence } from '@/features/geofences'
import { currentUser, envelope, errorEnvelope, renderApp, signedInAs } from '@/test/auth'
import { server } from '@/test/msw/server'

// S-32 Geofences (FMS-90). Leaflet cannot be clicked in jsdom: the map frame is a stand-in that places the
// corners a click would, in order around a square, and the fence layer lists what it would draw.

const SQUARE: [number, number][] = [
  [9.0098, 38.7603],
  [9.0098, 38.7623],
  [9.0118, 38.7623],
  [9.0118, 38.7603],
]

const clicks = vi.hoisted(() => ({ placed: 0 }))
beforeEach(() => {
  clicks.placed = 0
})

vi.mock('./GeofenceMap', () => ({
  GeofenceMap: ({ label, onMapClick, children, note }: { label: string; onMapClick?: (c: [number, number]) => void; children?: ReactNode; note?: ReactNode }) => {
    return (
      <div role="region" aria-label={label}>
        {note && <p>{note}</p>}
        {onMapClick && (
          <button type="button" onClick={() => onMapClick(SQUARE[clicks.placed++ % SQUARE.length])}>
            Place corner
          </button>
        )}
        {children}
      </div>
    )
  },
}))
vi.mock('@/components/GeofenceLayer', () => ({
  GeofenceLayer: ({ geofences }: { geofences: { geofence_id: string; name: string }[] }) => (
    <ul aria-label="Drawn fences">
      {geofences.map((g) => (
        <li key={g.geofence_id}>{g.name}</li>
      ))}
    </ul>
  ),
}))
vi.mock('react-leaflet', () => ({ Marker: () => null, Polygon: () => null, Polyline: () => null }))

const admin = currentUser(['admin'], ['tracking:read', 'geofence:write', 'depot:read'])
const dispatcher = currentUser(['dispatcher'], ['tracking:read', 'depot:read'])

const BOLE = { id: 'd-1', name: 'Bole Depot', code: 'BOL', location: 'Addis Ababa' }
const ADAMA = { id: 'd-2', name: 'Adama Hub', code: 'ADM', location: 'Adama' }

const fence = (over: Partial<Geofence> = {}): Geofence => ({
  geofence_id: 'g-1',
  depot_id: 'd-1',
  name: 'Bole yard',
  description: null,
  kind: 'keep_in',
  applies: 'off_trip',
  polygon: { type: 'Polygon', coordinates: [[...SQUARE.map(([lat, lng]): [number, number] => [lng, lat]), [38.7603, 9.0098]]] },
  area_m2: 48_000,
  is_active: true,
  version: 2,
  created_at: '2026-11-01T08:00:00Z',
  updated_at: '2026-11-02T08:00:00Z',
  updated_by: 'u-9',
  updated_by_name: 'Hana Admin',
  ...over,
})

/** A fake geofence API: the lists, and every write recorded with its If-Match. */
function serve(fences: Geofence[], removed: Geofence[] = []) {
  const writes: { method: string; path: string; body: unknown; ifMatch: string | null }[] = []
  const path = (url: string) => new URL(url).pathname.replace('/api/v1', '')
  server.use(
    http.get('/api/v1/depots', () => envelope([BOLE, ADAMA])),
    http.get('/api/v1/geofences', ({ request }) => envelope(new URL(request.url).searchParams.get('status') === 'inactive' ? removed : fences)),
    http.post('/api/v1/geofences', async ({ request }) => {
      writes.push({ method: 'POST', path: '/geofences', body: await request.json(), ifMatch: null })
      return HttpResponse.json({ data: fence({ geofence_id: 'g-new' }), meta: { request_id: 'r' } }, { status: 201 })
    }),
    http.patch('/api/v1/geofences/:id', async ({ request }) => {
      writes.push({ method: 'PATCH', path: path(request.url), body: await request.json(), ifMatch: request.headers.get('If-Match') })
      return envelope(fence())
    }),
    http.delete('/api/v1/geofences/:id', ({ request }) => {
      writes.push({ method: 'DELETE', path: path(request.url), body: null, ifMatch: null })
      return new HttpResponse(null, { status: 204 })
    }),
  )
  return writes
}

async function open(user = admin, at = '/geofences') {
  signedInAs(user)
  renderApp(at)
  await screen.findByRole('heading', { name: 'Geofences', level: 1 })
  return userEvent.setup()
}

describe('S-32 Geofences (FMS-90)', () => {
  it('lists the fences with their kind, depot, when they apply and size, and draws them on the map', async () => {
    serve([fence(), fence({ geofence_id: 'g-2', name: 'Merkato', kind: 'keep_out', applies: 'always', depot_id: 'd-2', area_m2: 2_400_000 })])
    await open()
    const list = await screen.findByRole('list', { name: 'Geofences' })
    const [bole, merkato] = within(list).getAllByRole('button')
    expect(bole).toHaveTextContent('Bole yard')
    expect(bole).toHaveTextContent('Stay inside')
    expect(bole).toHaveTextContent('Bole Depot · Only when not on a trip · 4.8 ha')
    expect(merkato).toHaveTextContent('Keep out')
    expect(merkato).toHaveTextContent('Adama Hub · 2.4 km²')
    const map = screen.getByRole('region', { name: 'Geofences map' })
    expect(within(map).getByRole('list', { name: 'Drawn fences' })).toHaveTextContent('Bole yardMerkato')
  })

  it('an admin draws one: 4 corners, a name, keep out; it is sent closed, with the depot of the filter', async () => {
    const writes = serve([])
    const user = await open(admin, '/geofences?depot=d-1')
    expect(await screen.findByText('No geofences yet')).toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: 'Draw geofence' })[0])
    const panel = await screen.findByRole('dialog', { name: 'Draw geofence' })

    // Too few corners first: refused before any request.
    await user.type(within(panel).getByLabelText('Name'), 'Merkato market')
    await user.click(within(panel).getByRole('button', { name: 'Save geofence' }))
    expect(within(panel).getByText('Click the map to place at least 3 corners.')).toBeInTheDocument()
    expect(writes).toEqual([])

    for (let i = 0; i < 4; i++) await user.click(within(panel).getByRole('button', { name: 'Place corner' }))
    expect(within(panel).getByText(/^4 corners · /)).toBeInTheDocument()
    await user.click(within(panel).getByRole('radio', { name: /Keep out/ }))
    await user.click(within(panel).getByRole('button', { name: 'Save geofence' }))

    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]).toEqual({
      method: 'POST',
      path: '/geofences',
      ifMatch: null,
      body: {
        depot_id: 'd-1',
        name: 'Merkato market',
        description: null,
        kind: 'keep_out',
        applies: 'always',
        polygon: { type: 'Polygon', coordinates: [[[38.7603, 9.0098], [38.7623, 9.0098], [38.7623, 9.0118], [38.7603, 9.0118], [38.7603, 9.0098]]] },
      },
    })
    expect(await screen.findByText('Geofence drawn')).toBeInTheDocument()
  })

  it('the server’s word on the outline and the name shows where it belongs', async () => {
    serve([])
    server.use(http.post('/api/v1/geofences', () => errorEnvelope(400, 'VALIDATION_FAILED', 'bad', [{ field: 'polygon', reason: 'self_intersecting' }])))
    const user = await open(admin, '/geofences?depot=d-1')
    await user.click((await screen.findAllByRole('button', { name: 'Draw geofence' }))[0])
    const panel = await screen.findByRole('dialog', { name: 'Draw geofence' })
    await user.type(within(panel).getByLabelText('Name'), 'Yard')
    for (let i = 0; i < 3; i++) await user.click(within(panel).getByRole('button', { name: 'Place corner' }))
    await user.click(within(panel).getByRole('button', { name: 'Save geofence' }))
    expect(await within(panel).findByText(/The edges cross/)).toBeInTheDocument()

    server.use(http.post('/api/v1/geofences', () => errorEnvelope(409, 'CONFLICT_DUPLICATE', 'taken', [{ field: 'name', reason: 'already_exists' }])))
    await user.click(within(panel).getByRole('button', { name: 'Save geofence' }))
    expect(await within(panel).findByText('The depot already has a geofence with this name.')).toBeInTheDocument()
  })

  it('editing sends only what changed, with If-Match; removing asks first', async () => {
    const writes = serve([fence()])
    const user = await open()
    await user.click(await screen.findByRole('button', { name: /Bole yard/ }))
    const panel = await screen.findByRole('dialog', { name: 'Edit Bole yard' })
    expect(within(panel).getByText(/Last changed by Hana Admin/)).toBeInTheDocument()
    const name = within(panel).getByLabelText('Name')
    await user.clear(name)
    await user.type(name, 'Bole night yard')
    await user.selectOptions(within(panel).getByLabelText('Applies'), 'always')
    await user.click(within(panel).getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(writes).toEqual([{ method: 'PATCH', path: '/geofences/g-1', ifMatch: '"2"', body: { name: 'Bole night yard', applies: 'always' } }]))

    await user.click(await screen.findByRole('button', { name: /Bole yard/ }))
    await user.click(within(await screen.findByRole('dialog', { name: 'Edit Bole yard' })).getByRole('button', { name: 'Remove geofence' }))
    const confirm = await screen.findByRole('dialog', { name: 'Remove Bole yard?' })
    await user.click(within(confirm).getByRole('button', { name: 'Remove geofence' }))
    await waitFor(() => expect(writes.at(-1)).toEqual({ method: 'DELETE', path: '/geofences/g-1', body: null, ifMatch: null }))
    expect(await screen.findByText('Geofence removed')).toBeInTheDocument()
  })

  it('a dispatcher sees them but cannot draw or change one', async () => {
    serve([fence()])
    const user = await open(dispatcher)
    expect(screen.queryByRole('button', { name: 'Draw geofence' })).not.toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: /Bole yard/ }))
    const panel = await screen.findByRole('dialog', { name: 'Bole yard' })
    expect(within(panel).queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: 'Place corner' })).not.toBeInTheDocument()
    expect(within(panel).getByLabelText('Name')).toBeDisabled()
  })

  it('empty for a reader says who draws them; a failed load offers to try again', async () => {
    serve([])
    await open(dispatcher)
    expect(await screen.findByText('An administrator draws them. Until then no vehicle is judged against one.')).toBeInTheDocument()

    let calls = 0
    server.use(
      http.get('/api/v1/geofences', () => {
        calls++
        return errorEnvelope(500, 'INTERNAL_SERVER_ERROR')
      }),
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Removed/ }))
    expect(await screen.findByText('Geofences could not be loaded', {}, { timeout: 8000 })).toBeInTheDocument()
    server.use(http.get('/api/v1/geofences', () => envelope([fence({ is_active: false })])))
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('button', { name: /Bole yard/ })).toBeInTheDocument()
    expect(calls).toBeGreaterThan(0)
  }, 15_000)
})

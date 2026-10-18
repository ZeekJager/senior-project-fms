import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { currentUser, envelope, errorEnvelope, renderApp, signedInAs } from '@/test/auth'
import { server } from '@/test/msw/server'
import type { Route } from './api'

const dispatcher = currentUser(['dispatcher'], ['route:read', 'route:write', 'depot:read', 'trip:assign'])
const owner = currentUser(['fleet_owner'], ['route:read', 'depot:read'])
const driver = currentUser(['driver'], ['route:read', 'trip:execute'])

const ADDIS = { id: 'd-1', name: 'Addis Ababa Central', code: 'ADD', location: 'Addis Ababa' }
const ADAMA = { id: 'd-2', name: 'Adama Depot', code: 'ADM', location: 'Adama' }

let seq = 0
function route(overrides: Partial<Route> = {}): Route {
  seq += 1
  return {
    id: `r-${seq}`,
    name: `Route ${seq}`,
    depot_id: 'd-1',
    origin_name: 'Addis Ababa',
    origin: { latitude: 9.0054, longitude: 38.7636 },
    destination_name: 'Adama',
    destination: { latitude: 8.54, longitude: 39.27 },
    stops: [],
    distance_km: 99.5,
    estimated_duration_seconds: 9000,
    is_active: true,
    version: 3,
    updated_at: '2026-10-10T08:00:00Z',
    ...overrides,
  }
}

/** A fake /routes API: the status filter, counts, and every write recorded with its If-Match. */
function serveRoutes(routes: Route[], depots = [ADDIS]) {
  const writes: { method: string; url: string; body: Record<string, unknown>; ifMatch: string | null }[] = []
  server.use(
    http.get('/api/v1/routes', ({ request }) => {
      const q = new URL(request.url).searchParams
      const status = q.get('status') ?? 'active'
      const rows = routes.filter((r) => (status === 'retired' ? !r.is_active : r.is_active))
      const size = Number(q.get('page_size') ?? 50)
      return HttpResponse.json({ data: rows.slice(0, size), meta: { page: 1, page_size: size, total_items: rows.length, total_pages: 1 } })
    }),
    http.post('/api/v1/routes', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>
      writes.push({ method: 'POST', url: request.url, body, ifMatch: null })
      return envelope(route(body as Partial<Route>))
    }),
    http.patch('/api/v1/routes/:id', async ({ request, params }) => {
      const body = (await request.json()) as Record<string, unknown>
      writes.push({ method: 'PATCH', url: request.url, body, ifMatch: request.headers.get('If-Match') })
      const current = routes.find((r) => r.id === params.id)!
      return envelope({ ...current, ...body, version: current.version + 1 })
    }),
    http.get('/api/v1/depots', () => envelope(depots)),
  )
  return { writes }
}

const table = () => screen.getByRole('table', { name: 'Routes' })
const rowOf = (name: string) => within(table()).getByText(name).closest('tr') as HTMLElement

async function openRoutes(firstName: string, user = dispatcher) {
  signedInAs(user)
  renderApp('/routes')
  await within(await screen.findByRole('table', { name: 'Routes' })).findByText(firstName)
}

describe('Routes (FMS-83)', () => {
  it('lists active routes with origin → destination, stops, distance and time', async () => {
    serveRoutes([
      route({ name: 'Addis Ababa - Adama', stops: [{ name: 'Bishoftu', latitude: null, longitude: null }, { name: 'Mojo', latitude: null, longitude: null }] }),
      route({ name: 'Unplanned', origin_name: null, destination_name: null, distance_km: null, estimated_duration_seconds: null }),
      route({ name: 'Old road', is_active: false }),
    ])
    await openRoutes('Addis Ababa - Adama')

    const row = rowOf('Addis Ababa - Adama')
    expect(within(row).getByText('Addis Ababa → Adama · 2 stops')).toBeInTheDocument()
    expect(within(row).getByText('99.5 km')).toBeInTheDocument()
    expect(within(row).getByText('2 h 30 min')).toBeInTheDocument()
    expect(within(rowOf('Unplanned')).getByText('No origin or destination yet')).toBeInTheDocument()
    expect(within(table()).queryByText('Old road')).not.toBeInTheDocument()

    expect(await screen.findByRole('button', { name: /^Active\s*2/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Retired\s*1/ })).toBeInTheDocument()
  })

  it('the Retired view lists retired routes, kept in the URL', async () => {
    serveRoutes([route({ name: 'Current' }), route({ name: 'Old road', is_active: false })])
    const user = userEvent.setup()
    await openRoutes('Current')

    await user.click(screen.getByRole('button', { name: /^Retired/ }))
    await within(table()).findByText('Old road')
    expect(within(table()).queryByText('Current')).not.toBeInTheDocument()
    expect(within(rowOf('Old road')).getByText('Retired')).toBeInTheDocument()
    expect(screen.getByTestId('location')).toHaveTextContent('/routes?view=retired')
  })

  it('adds a route with its stops, distance and time; the only depot is preselected', async () => {
    const api = serveRoutes([route({ name: 'Existing' })])
    const user = userEvent.setup()
    await openRoutes('Existing')

    await user.click(screen.getByRole('button', { name: 'Add route' }))
    const drawer = await screen.findByRole('dialog', { name: 'Add route' })
    await user.type(within(drawer).getByLabelText('Name'), 'Addis Ababa - Hawassa')
    expect(within(drawer).getByLabelText('Depot')).toHaveValue('d-1')
    await user.type(within(drawer).getByLabelText('Origin (optional)'), 'Addis Ababa depot')
    await user.type(within(drawer).getByLabelText('Origin coordinates (optional)'), '9.0054, 38.7636')
    await user.click(within(drawer).getByRole('button', { name: 'Add stop' }))
    await user.type(within(drawer).getByLabelText('Stop 1 name'), 'Ziway')
    await user.type(within(drawer).getByLabelText('Destination (optional)'), 'Hawassa')
    await user.type(within(drawer).getByLabelText('Expected distance (optional)'), '275')
    await user.type(within(drawer).getByLabelText('Estimated time (optional)'), '4')
    await user.type(within(drawer).getByLabelText('Minutes (optional)'), '30')
    await user.click(within(drawer).getByRole('button', { name: 'Add route' }))

    await waitFor(() => expect(api.writes).toHaveLength(1))
    expect(api.writes[0]).toMatchObject({
      method: 'POST',
      body: {
        name: 'Addis Ababa - Hawassa',
        depot_id: 'd-1',
        origin_name: 'Addis Ababa depot',
        origin: { latitude: 9.0054, longitude: 38.7636 },
        destination_name: 'Hawassa',
        destination: null,
        stops: [{ name: 'Ziway', latitude: null, longitude: null }],
        distance_km: 275,
        estimated_duration_seconds: 16200,
      },
    })
    expect(await screen.findByText('Route added')).toBeInTheDocument()
  })

  it('checks the form before sending: a depot is required and coordinates must read as a point', async () => {
    const api = serveRoutes([route({ name: 'Existing' })], [ADDIS, ADAMA])
    const user = userEvent.setup()
    await openRoutes('Existing')

    await user.click(screen.getByRole('button', { name: 'Add route' }))
    const drawer = await screen.findByRole('dialog', { name: 'Add route' })
    await user.type(within(drawer).getByLabelText('Name'), 'No depot')
    await user.type(within(drawer).getByLabelText('Destination coordinates (optional)'), '95, 38')
    await user.click(within(drawer).getByRole('button', { name: 'Add route' }))

    expect(await within(drawer).findByText('Choose the depot this route belongs to.')).toBeInTheDocument()
    expect(within(drawer).getByText('Latitude is between -90 and 90.')).toBeInTheDocument()
    expect(api.writes).toEqual([])
  })

  it('saves only what changed, with If-Match, and shows a duplicate name next to the field', async () => {
    const existing = route({ name: 'Addis Ababa - Adama', version: 3 })
    const api = serveRoutes([existing])
    const user = userEvent.setup()
    await openRoutes('Addis Ababa - Adama')

    await user.click(within(rowOf('Addis Ababa - Adama')).getByRole('button', { name: 'Edit Addis Ababa - Adama' }))
    const drawer = await screen.findByRole('dialog', { name: 'Edit Addis Ababa - Adama' })
    const distance = within(drawer).getByLabelText('Expected distance (optional)')
    await user.clear(distance)
    await user.type(distance, '101.2')
    await user.click(within(drawer).getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(api.writes).toHaveLength(1))
    expect(api.writes[0]).toMatchObject({ method: 'PATCH', body: { distance_km: 101.2 }, ifMatch: '"3"' })
    expect(await screen.findByText('Changes saved')).toBeInTheDocument()

    server.use(http.patch('/api/v1/routes/:id', () => errorEnvelope(409, 'CONFLICT_DUPLICATE', 'Duplicate', [{ field: 'name', reason: 'already_exists' }])))
    await user.click(within(rowOf('Addis Ababa - Adama')).getByRole('button', { name: 'Edit Addis Ababa - Adama' }))
    const again = await screen.findByRole('dialog', { name: 'Edit Addis Ababa - Adama' })
    const name = within(again).getByLabelText('Name')
    await user.clear(name)
    await user.type(name, 'Taken name')
    await user.click(within(again).getByRole('button', { name: 'Save changes' }))
    expect(await within(again).findByText('This depot already has an active route with this name.')).toBeInTheDocument()
  })

  it('retires a route from its panel after confirming, with a toast', async () => {
    const api = serveRoutes([route({ name: 'Old road', version: 7 })])
    const user = userEvent.setup()
    await openRoutes('Old road')

    await user.click(rowOf('Old road'))
    const drawer = await screen.findByRole('dialog', { name: 'Edit Old road' })
    await user.click(within(drawer).getByRole('button', { name: 'Retire route' }))
    const confirm = await screen.findByRole('dialog', { name: 'Retire Old road' })
    expect(confirm).toHaveTextContent('Trips that already used it keep it')
    await user.click(within(confirm).getByRole('button', { name: 'Retire route' }))

    await waitFor(() => expect(api.writes).toEqual([expect.objectContaining({ method: 'PATCH', body: { is_active: false }, ifMatch: '"7"' })]))
    expect(await screen.findByText('Route retired')).toBeInTheDocument()
  })

  it('restores a retired route from the Retired view', async () => {
    const api = serveRoutes([route({ name: 'Current' }), route({ name: 'Old road', is_active: false, version: 2 })])
    const user = userEvent.setup()
    signedInAs(dispatcher)
    renderApp('/routes?view=retired')
    await within(await screen.findByRole('table', { name: 'Routes' })).findByText('Old road')

    await user.click(rowOf('Old road'))
    const drawer = await screen.findByRole('dialog', { name: 'Edit Old road' })
    expect(within(drawer).queryByRole('button', { name: 'Retire route' })).not.toBeInTheDocument()
    await user.click(within(drawer).getByRole('button', { name: 'Restore route' }))
    await waitFor(() => expect(api.writes).toEqual([expect.objectContaining({ body: { is_active: true }, ifMatch: '"2"' })]))
    expect(await screen.findByText('Route restored')).toBeInTheDocument()
  })

  it('a reader without route:write sees the list but no add or edit', async () => {
    serveRoutes([route({ name: 'Addis Ababa - Adama' })])
    await openRoutes('Addis Ababa - Adama', owner)
    expect(screen.queryByRole('button', { name: 'Add route' })).not.toBeInTheDocument()
    expect(within(table()).queryByRole('button', { name: /^Edit/ })).not.toBeInTheDocument()
  })

  // Which roles get the menu link is pinned per seeded role in router/navigation.test.ts.
  it('a driver (route:read for their trips, no depot:read) cannot open the planning screen', async () => {
    serveRoutes([route({ name: 'Addis Ababa - Adama' })])
    signedInAs(driver)
    renderApp('/routes')
    await screen.findByRole('button', { name: 'Notifications' })
    expect(screen.getByRole('main')).toBeEmptyDOMElement()
  })
})

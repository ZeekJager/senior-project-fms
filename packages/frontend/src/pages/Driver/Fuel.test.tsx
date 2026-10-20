import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'
import { submissionsOf } from '@/lib/offlineQueue'
import { currentUser, envelope, errorEnvelope, renderApp, signedInAs } from '@/test/auth'
import { server } from '@/test/msw/server'
import type { DriverTrip } from './api'
import { checkFillUp, fuelLogBody } from './fuelLog'

const driver = currentUser(['driver'], ['trip:execute', 'trip:read', 'vehicle:read', 'fuel:write', 'fuel:read'])
const VEHICLE = 'v0000000-0000-4000-8000-000000000001'
const TRIP = 't0000000-0000-4000-8000-000000000001'

const trip = (overrides: Partial<DriverTrip> = {}): DriverTrip => ({
  id: TRIP,
  route_name: 'Addis Ababa - Adama',
  origin: 'Addis Ababa',
  destination: 'Adama',
  vehicle_id: VEHICLE,
  status: 'en_route',
  scheduled_start: '2026-11-02T05:30:00Z',
  scheduled_end: '2026-11-02T08:45:00Z',
  actual_start: '2026-11-02T05:34:00Z',
  planned_distance_km: 99,
  stops: [],
  version: 4,
  ...overrides,
})

/** Today's trips, the vehicle, and POST /fuel-logs as the network sees it (`up: false` is airplane mode). */
function serve(state: { trips: DriverTrip[]; up?: boolean }) {
  const posts: { raw: string; key: string | null }[] = []
  server.use(
    http.get('/api/v1/trips', ({ request }) => envelope(state.trips.filter((t) => t.status === new URL(request.url).searchParams.get('status')))),
    http.get(`/api/v1/vehicles/${VEHICLE}`, () => envelope({ registration_number: 'AA 3-10001', make: 'Isuzu', model: 'NPR' })),
    http.post('/api/v1/fuel-logs', async ({ request }) => {
      if (state.up === false) return HttpResponse.error()
      const raw = await request.text()
      posts.push({ raw, key: request.headers.get('Idempotency-Key') })
      return HttpResponse.json({ data: { id: 'fuel-1', ...JSON.parse(raw) }, meta: {} }, { status: 201 })
    }),
  )
  return posts
}

async function open(path = '/driver/fuel') {
  signedInAs(driver)
  renderApp(path)
  await screen.findByRole('heading', { name: 'Log fuel', level: 1 })
  await screen.findByText('AA 3-10001')
}

async function fill(user: ReturnType<typeof userEvent.setup>, values: { litres?: string; total?: string; odometer?: string; station?: string }) {
  if (values.litres !== undefined) await user.type(screen.getByLabelText('Litres'), values.litres)
  if (values.total !== undefined) await user.type(screen.getByLabelText('Total paid'), values.total)
  if (values.odometer !== undefined) await user.type(screen.getByLabelText('Odometer'), values.odometer)
  if (values.station !== undefined) await user.type(screen.getByLabelText(/Station/), values.station)
}

const submitButton = () => screen.getByRole('button', { name: /Log fuel|Save fuel log/ })

afterEach(() => {
  // An 'offline' event also pauses TanStack Query's global online manager: put it back.
  act(() => void window.dispatchEvent(new Event('online')))
})

describe('Driver fuel entry (FMS-40, S-14)', () => {
  it('23.5 litres goes over the network as quantity_ml: 23500, money in cents, with an Idempotency-Key', async () => {
    const posts = serve({ trips: [trip()] })
    await open()
    const user = userEvent.setup()
    await fill(user, { litres: '23.5', total: '2890.50', odometer: '123456.7', station: '  Total Adama ' })
    expect(screen.getByText(/ETB 123\.00 per litre/)).toBeInTheDocument()
    await user.click(submitButton())

    expect(await screen.findByRole('heading', { name: 'Fuel logged' })).toBeInTheDocument()
    expect(screen.getByText(/23\.50 L for ETB 2,890\.50 at 123,456\.7 km\./)).toBeInTheDocument()
    expect(posts).toHaveLength(1)
    // The raw request: whole numbers where the contract wants them, no float anywhere.
    expect(posts[0].raw).toContain('"quantity_ml":23500')
    expect(posts[0].raw).toContain('"total_cost_cents":289050')
    expect(JSON.parse(posts[0].raw)).toEqual({
      vehicle_id: VEHICLE,
      trip_id: TRIP,
      quantity_ml: 23500,
      total_cost_cents: 289050,
      odometer_km: 123456.7,
      station_name: 'Total Adama',
    })
    expect(posts[0].key).toMatch(/^[0-9a-f-]{36}$/)
    expect(await submissionsOf(driver.user.id)).toEqual([])
  })

  it('a negative amount is blocked in the form: its own message, and nothing is sent or kept', async () => {
    const posts = serve({ trips: [trip()] })
    await open()
    const user = userEvent.setup()
    await fill(user, { litres: '-23.5', total: '-100', odometer: '123456' })
    expect(screen.getByText('A volume cannot be negative.')).toBeInTheDocument()
    expect(screen.getByText('An amount cannot be negative.')).toBeInTheDocument()
    expect(screen.getByLabelText('Litres')).toHaveAttribute('aria-invalid', 'true')
    await user.click(submitButton())
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(posts).toEqual([])
    expect(await submissionsOf(driver.user.id)).toEqual([])
  })

  it('offline: the fill-up waits on the phone with the pending badge, and reaches the server after reconnecting', async () => {
    const state = { trips: [trip()], up: false }
    const posts = serve(state)
    await open()
    act(() => void window.dispatchEvent(new Event('offline')))
    const user = userEvent.setup()
    await fill(user, { litres: '40', total: '4920', odometer: '123500' })
    expect(submitButton()).toHaveTextContent('Save fuel log')
    await user.click(submitButton())

    expect(await screen.findByRole('heading', { name: 'Saved on this phone' })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: '1 waiting to send' })).toBeInTheDocument()
    const [queued] = await submissionsOf(driver.user.id)
    expect(queued).toMatchObject({ kind: 'fuel', label: 'Fuel, 40.00 L, AA 3-10001', path: '/fuel-logs' })

    state.up = true
    act(() => void window.dispatchEvent(new Event('online')))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(JSON.parse(posts[0].raw)).toMatchObject({ quantity_ml: 40000, total_cost_cents: 492000, odometer_km: 123500 })
    expect(posts[0].key).toBe(queued.key)
    await waitFor(() => expect(screen.queryByRole('button', { name: /waiting to send/ })).not.toBeInTheDocument())
  })

  it('says what is missing before anything is queued', async () => {
    const posts = serve({ trips: [trip()] })
    await open()
    const user = userEvent.setup()
    await fill(user, { litres: '0' })
    await user.click(submitButton())
    expect(screen.getByText('Enter more than 0 litres.')).toBeInTheDocument()
    expect(screen.getByText('Enter what you paid, from the receipt.')).toBeInTheDocument()
    expect(screen.getByText('Enter the odometer reading.')).toBeInTheDocument()
    expect(posts).toEqual([])
    // The messages follow what is typed next.
    await fill(user, { odometer: '123456' })
    expect(screen.queryByText('Enter the odometer reading.')).not.toBeInTheDocument()
  })

  it('a refused fill-up (odometer lower than the last one) says why and keeps the form as typed', async () => {
    serve({ trips: [trip()] })
    server.use(
      http.post('/api/v1/fuel-logs', () =>
        errorEnvelope(409, 'CONFLICT_ODOMETER_REGRESSION', 'The odometer reading is lower than the last recorded one (123500 km).', [
          { field: 'odometer_km', reason: 'below_last_reading' },
        ]),
      ),
    )
    await open()
    const user = userEvent.setup()
    await fill(user, { litres: '23.5', total: '2890.5', odometer: '1000' })
    await user.click(submitButton())
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('It was not accepted: The odometer reading is lower than the last recorded one (123500 km).'))
    expect(screen.getByLabelText('Litres')).toHaveValue('23.500')
    expect(await submissionsOf(driver.user.id)).toEqual([])
  })

  it('no trip today: nothing to fuel (a driver logs fuel only for the vehicle of their trip)', async () => {
    serve({ trips: [] })
    signedInAs(driver)
    renderApp('/driver/fuel')
    expect(await screen.findByRole('heading', { name: 'No vehicle to fuel' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Litres')).not.toBeInTheDocument()
  })
})

describe('fuel log body', () => {
  const fillUp = { quantityMl: 23500, totalCents: 289050, odometerTenths: 1234567, station: '' }

  it('whole millilitres and cents as given; the odometer keeps its one decimal; no empty station', () => {
    const body = fuelLogBody(fillUp, VEHICLE, TRIP)
    expect(body).toEqual({ vehicle_id: VEHICLE, trip_id: TRIP, quantity_ml: 23500, total_cost_cents: 289050, odometer_km: 123456.7 })
    expect(Number.isInteger(body.quantity_ml) && Number.isInteger(body.total_cost_cents)).toBe(true)
    expect(String(fuelLogBody({ ...fillUp, odometerTenths: 1234560 }, VEHICLE, TRIP).odometer_km)).toBe('123456')
  })

  it("checks the contract's bounds", () => {
    expect(checkFillUp(fillUp)).toEqual({})
    expect(checkFillUp({ ...fillUp, quantityMl: 2_000_001 }).quantity).toMatch(/2,000 L at most/)
    expect(checkFillUp({ ...fillUp, totalCents: 100_000_001 }).total).toBe('That amount is too large.')
    expect(checkFillUp({ ...fillUp, totalCents: 0 })).toEqual({})
    expect(checkFillUp({ ...fillUp, station: 'x'.repeat(256) }).station).toBe('Use at most 255 characters.')
  })
})

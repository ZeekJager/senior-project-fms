import { expect, test, type Page } from '@playwright/test'
import { Actor, eventually, setStep, StepFailure } from '../lib/api'

// The golden path (FMS-63, docs/e2e.md, architecture §41 scenarios A to E): a defect found at inspection flags the
// vehicle, which then cannot be dispatched; a technician repairs it; the dispatcher assigns the trip; the driver starts
// it; the phone's GPS puts the vehicle on the live map; driving too fast raises an alert the dispatcher acknowledges on
// the map; the driver ends the trip and logs the fuel; an electric vehicle takes no fuel log. Each person signs in as
// themselves, each run makes its own depot, people and vehicles, and a failure names its step and request id.

const WEB = process.env.E2E_WEB_URL ?? 'http://localhost:5173'
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD
const RUN = Date.now().toString(36).slice(-6).toUpperCase()
const PASSWORD = `E2e-${RUN}-${Math.random().toString(36).slice(2, 10)}`
// Addis Ababa, on the road to Adama.
const AT = { lat: 9.0108, lng: 38.7613 }

interface Ids {
  depot: string
  truck: string
  plate: string
  ev: string
  driver: string
  trip: string
  tripVersion: number
  startedAt: number
}

/** A test.step whose failures carry its name, and whose API calls know which step they belong to. */
async function step<T>(name: string, body: () => Promise<T>): Promise<T> {
  return test.step(name, async () => {
    setStep(name)
    try {
      return await body()
    } catch (err) {
      if (err instanceof StepFailure) throw err
      throw new StepFailure(name, null, (err as Error).message)
    }
  })
}

/** A staff account in the depot that can sign in: invited by the admin, its password set from the invitation. */
async function staff(admin: Actor, role: string, depot: string, name: string): Promise<{ email: string }> {
  const email = `e2e.${role}.${RUN.toLowerCase()}@fleet.test`
  const { meta } = await admin.post('/users', { email, full_name: `${name} ${RUN}`, depot_id: depot, roles: [role] }, 201)
  await admin.post('/auth/password', { token: (meta.password_setup as { token: string }).token, password: PASSWORD }, [200, 204])
  return { email }
}

async function signInOnTheWeb(page: Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).not.toHaveURL(/\/login/)
}

test('the golden path: inspection, repair, dispatch, GPS on the map, an alert acknowledged, the trip ended and its fuel logged', async ({ page }) => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD (an admin of the stack under test).')
  const started = Date.now()
  const ids = {} as Ids

  const admin = await step('the administrator signs in', () => Actor.signIn('admin', WEB, ADMIN_EMAIL!, ADMIN_PASSWORD!))

  const people = await step('a depot, its staff, a driver, a truck, an electric van and a route are set up', async () => {
    const depot = await admin.post<{ id: string }>('/depots', {
      name: `E2E depot ${RUN}`,
      code: `E2E${RUN}`.slice(0, 10),
      location: 'Addis Ababa',
      city: 'Addis Ababa',
      country: 'Ethiopia',
      timezone: 'Africa/Addis_Ababa',
      latitude: AT.lat,
      longitude: AT.lng,
      capacity: 20,
    }, 201)
    ids.depot = depot.data.id
    const dispatcher = await staff(admin, 'dispatcher', ids.depot, 'E2E Dispatcher')
    const technician = await staff(admin, 'technician', ids.depot, 'E2E Technician')

    ids.plate = `E2E-${RUN}`
    const truck = await admin.post<{ id: string }>('/vehicles', {
      registration_number: ids.plate,
      make: 'Isuzu',
      model: 'FSR',
      year: 2022,
      vehicle_type: 'truck',
      fuel_type: 'diesel',
      fuel_efficiency_ml_per_km: 300,
      depot_id: ids.depot,
      odometer_km: 10_000,
    }, 201)
    ids.truck = truck.data.id
    const ev = await admin.post<{ id: string }>('/vehicles', { registration_number: `E2E-EV-${RUN}`, make: 'BYD', model: 'T3', year: 2024, vehicle_type: 'van', fuel_type: 'electric', depot_id: ids.depot, odometer_km: 500 }, 201)
    ids.ev = ev.data.id

    const driverEmail = `e2e.driver.${RUN.toLowerCase()}@fleet.test`
    const driver = await admin.post<{ id: string; user_id: string }>('/drivers', {
      account: { full_name: `E2E Driver ${RUN}`, email: driverEmail, phone: null },
      depot_id: ids.depot,
      license_number: `E2E-${RUN}-${Math.floor(Math.random() * 1e6)}`,
      license_categories: ['automobile', 'dry_cargo_2'],
      license_expiry: `${new Date().getFullYear() + 3}-12-31`,
      hire_date: '2024-01-15',
    }, 201)
    ids.driver = driver.data.id
    const link = await admin.post<{ token: string }>(`/users/${driver.data.user_id}/password-reset`, {}, [200, 201])
    await admin.post('/auth/password', { token: link.data.token, password: PASSWORD }, [200, 204])

    const route = await admin.post<{ id: string }>('/routes', { name: `E2E Bole - Adama ${RUN}`, depot_id: ids.depot, origin_name: 'Bole', destination_name: 'Adama' }, 201)
    return {
      dispatcher: await Actor.signIn('dispatcher', WEB, dispatcher.email, PASSWORD),
      technician: await Actor.signIn('technician', WEB, technician.email, PASSWORD),
      driver: await Actor.signIn('driver', WEB, driverEmail, PASSWORD),
      dispatcherEmail: dispatcher.email,
      route: route.data.id,
    }
  })
  const { dispatcher, technician, driver } = people

  await step('the driver finds a defect at the pre-trip inspection, and the truck is flagged', async () => {
    const dvir = await driver.post<{ issues_found: boolean; defects: { name: string }[] }>('/dvir-reports', {
      vehicle_id: ids.truck,
      type: 'pre_trip',
      items: [
        { name: 'Brakes', passed: true },
        { name: 'Left tail light', passed: false, notes: 'Cracked lens' },
      ],
    }, 201)
    expect(dvir.data.issues_found).toBe(true)
    await eventually('the truck flagged for maintenance', async () => ((await dispatcher.get<{ maintenance_flag: boolean }>(`/vehicles/${ids.truck}`)).data.maintenance_flag ? true : undefined))
  })

  await step('a trip is planned, and the flagged truck cannot be assigned to it', async () => {
    const start = new Date(Date.now() + 15 * 60_000)
    const trip = await dispatcher.post<{ id: string; version: number }>('/trips', { route_id: people.route, scheduled_start: start.toISOString(), scheduled_end: new Date(start.getTime() + 2 * 3_600_000).toISOString() }, 201)
    ids.trip = trip.data.id
    ids.tripVersion = trip.data.version
    const refused = await dispatcher.post(`/trips/${ids.trip}/assign`, { driver_id: ids.driver, vehicle_id: ids.truck, version: ids.tripVersion }, 409)
    expect(refused.error?.code).toBe('CONFLICT_VEHICLE_FLAGGED')
  })

  await step('the technician repairs the truck, and the flag is cleared', async () => {
    const repair = await technician.post<{ id: string }>('/maintenance', { vehicle_id: ids.truck, maintenance_type: 'corrective', description: 'Replace the left tail light lens', labour_hours: 0.5, total_cost_cents: 45_000 }, 201)
    const done = await technician.post<{ status: string }>(`/maintenance/${repair.data.id}/complete`, {
      completed_at: new Date().toISOString(),
      // A corrective repair says what failed (FMS-125).
      failures: [{ component: 'electrical', failure_mode: 'breakage', unplanned: true, detected_by: 'dvir' }],
    })
    expect(done.data.status).toBe('completed')
    await eventually('the flag cleared', async () => ((await dispatcher.get<{ maintenance_flag: boolean }>(`/vehicles/${ids.truck}`)).data.maintenance_flag ? undefined : true))
  })

  await step('the dispatcher assigns the driver and the truck', async () => {
    const assigned = await dispatcher.post<{ status: string }>(`/trips/${ids.trip}/assign`, { driver_id: ids.driver, vehicle_id: ids.truck, version: ids.tripVersion }, 200)
    expect(assigned.data.status).toBe('assigned')
  })

  await step('the driver starts the trip', async () => {
    const started = await driver.post<{ status: string }>(`/trips/${ids.trip}/start`, {}, 200)
    expect(started.data.status).toBe('en_route')
    ids.startedAt = Date.now()
  })

  await step('the phone sends its GPS, and the truck is on the dispatcher’s live map', async () => {
    // After the trip began (a ping before it is refused alone) and within the 2 minutes ahead a phone's clock may be.
    // Over 80 km/h for three pings: the speeding rule (FMS-46) flags it.
    const pings = [1_000, 2_000, 3_000].map((offset, i) => ({ recorded_at: new Date(ids.startedAt + offset).toISOString(), lat: AT.lat + i * 0.0002, lng: AT.lng + i * 0.0002, speed_kmh: 96, heading: 45, accuracy_m: 6 }))
    const res = await driver.post<{ accepted: number }>('/tracking/gps-pings', { pings }, 202)
    expect(res.data.accepted).toBe(3)

    await signInOnTheWeb(page, people.dispatcherEmail)
    await page.goto('/command-center')
    const vehicles = page.getByRole('list', { name: 'Vehicles' })
    await expect(vehicles.locator('.plate', { hasText: ids.plate })).toBeVisible({ timeout: 30_000 })
    await expect(page.locator(`.fleet-marker-icon[aria-label^="${ids.plate}:"]`)).toBeAttached()
  })

  await step('driving too fast raises an alert, and the dispatcher acknowledges it on the map', async () => {
    await eventually('the speeding alert', async () => {
      const open = await dispatcher.get<{ id: string; type: string }[]>(`/alerts?vehicle_id=${ids.truck}&type=unsafe_driving&status=open`)
      return open.data[0]
    }, 60_000, 2_000)
    await page.reload()
    await page.getByRole('button', { name: /^Alerts/ }).click()
    const list = page.getByRole('list', { name: 'Active alerts' })
    await list.getByRole('button', { name: `Acknowledge: Speeding: ${ids.plate}` }).click()
    await expect(list.getByText('Acknowledged').first()).toBeVisible()
    const acked = await dispatcher.get<{ status: string }[]>(`/alerts?vehicle_id=${ids.truck}&type=unsafe_driving&status=acknowledged`)
    expect(acked.data).toHaveLength(1)
  })

  await step('the driver ends the trip', async () => {
    const ended = await driver.post<{ status: string }>(`/trips/${ids.trip}/end`, {}, 200)
    expect(ended.data.status).toBe('completed')
  })

  await step('the driver logs the fuel', async () => {
    const fuel = await driver.post<{ id: string; quantity_ml: number }>('/fuel-logs', { vehicle_id: ids.truck, quantity_ml: 60_000, total_cost_cents: 501_000, odometer_km: 10_120, station_name: 'Total Bole' }, 201)
    expect(fuel.data.quantity_ml).toBe(60_000)
  })

  await step('an electric vehicle takes no fuel log', async () => {
    const refused = await driver.post('/fuel-logs', { vehicle_id: ids.ev, quantity_ml: 10_000, total_cost_cents: 50_000, odometer_km: 520 }, 400)
    expect(refused.error?.details).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'fuel_type', reason: 'not_a_liquid_fuel' })]))
  })

  await step('it all took under 5 minutes', async () => {
    expect(Date.now() - started).toBeLessThan(5 * 60_000)
  })

  for (const a of [admin, dispatcher, technician, driver]) await a.dispose()
})

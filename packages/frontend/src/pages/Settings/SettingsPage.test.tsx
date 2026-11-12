import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import type { Setting } from '@/features/settings'
import { currentUser, envelope, errorEnvelope, renderApp, signedInAs } from '@/test/auth'
import { DEFAULT_SETTINGS } from '@/test/msw/handlers'
import { server } from '@/test/msw/server'
import type { RuleThresholds } from './api'

const admin = currentUser(['admin'], ['depot:read', 'depot:write', 'settings:write'])
const owner = currentUser(['fleet_owner'], ['depot:read', 'depot:write', 'audit:read'])

const ADDIS = { id: 'd-1', name: 'Addis Ababa Central', code: 'ADD', location: 'Addis Ababa' }
const ADAMA = { id: 'd-2', name: 'Adama Hub', code: 'ADM', location: 'Adama' }
const FLEET = { speed_limit_kmh: 80, speeding_pings: 3, clear_pings: 3, idle_minutes: 5, route_deviation_m: 500, route_deviation_pings: 3, trip_delay_minutes: 15, trip_delay_urgent_minutes: 60, driver_attendance_exception: 'warn' as const, trip_overrun_exception: 'warn' as const, daily_distance_km: 500, weekly_distance_km: 2500, distance_weight_light: 0.8, distance_weight_standard: 1, distance_weight_heavy: 1.5 }
const never = { updated_by: null, updated_by_name: null, updated_at: null }

/** A fake settings API: thresholds and settings, every write recorded. */
function serve(rules: RuleThresholds, settings: Setting[] = DEFAULT_SETTINGS) {
  const writes: { method: string; path: string; body: unknown }[] = []
  const path = (url: string) => new URL(url).pathname.replace('/api/v1', '')
  server.use(
    http.get('/api/v1/depots', () => envelope([ADDIS, ADAMA])),
    http.get('/api/v1/settings/telemetry-rules', () => envelope(rules)),
    http.put('/api/v1/settings/telemetry-rules/*', async ({ request }) => {
      const body = await request.json()
      writes.push({ method: 'PUT', path: path(request.url), body })
      return envelope(rules)
    }),
    http.delete('/api/v1/settings/telemetry-rules/depots/:id', ({ request }) => {
      writes.push({ method: 'DELETE', path: path(request.url), body: null })
      return new HttpResponse(null, { status: 204 })
    }),
    http.get('/api/v1/settings', () => envelope(settings)),
    http.patch('/api/v1/settings', async ({ request }) => {
      const body = (await request.json()) as Record<string, number | null>
      writes.push({ method: 'PATCH', path: '/settings', body })
      return envelope(settings.map((s) => (s.key in body ? { ...s, value: body[s.key] ?? s.default_value, is_default: body[s.key] === s.default_value } : s)))
    }),
  )
  return writes
}

async function open() {
  signedInAs(admin)
  renderApp('/settings')
  return { user: userEvent.setup(), rules: await screen.findByRole('form', { name: "The fleet's driving rules" }) }
}

describe('S-27 Settings (FMS-80)', () => {
  it("saves the fleet's driving rules, all four, once one changed and within range", async () => {
    const writes = serve({ fleet: { ...FLEET, ...never }, depots: [] })
    const { user, rules } = await open()
    const save = within(rules).getByRole('button', { name: 'Save driving rules' })
    expect(save).toBeDisabled()
    expect(within(rules).getByText('The fleet’s starting thresholds.')).toBeInTheDocument()

    const limit = within(rules).getByLabelText('Speed limit')
    await user.clear(limit)
    await user.type(limit, '250')
    await user.click(save)
    expect(within(rules).getByText('From 20 to 200.')).toBeInTheDocument()
    expect(writes).toEqual([])

    await user.clear(limit)
    await user.type(limit, '70')
    await user.click(save)
    await waitFor(() => expect(writes).toEqual([{ method: 'PUT', path: '/settings/telemetry-rules/fleet', body: { ...FLEET, speed_limit_kmh: 70 } }]))
    expect(await screen.findByText('Driving rules saved')).toBeInTheDocument()
  })

  it('off route (FMS-90): beyond 500 m for 3 pings at first; under 100 m is refused, 800 m saved with the rest', async () => {
    const writes = serve({ fleet: { ...FLEET, ...never }, depots: [] })
    const { user, rules } = await open()
    const beyond = within(rules).getByLabelText('Off route beyond')
    expect(beyond).toHaveValue('500')
    expect(within(rules).getByLabelText('Off route after')).toHaveValue('3')

    await user.clear(beyond)
    await user.type(beyond, '50')
    await user.click(within(rules).getByRole('button', { name: 'Save driving rules' }))
    expect(within(rules).getByText('From 100 to 5000.')).toBeInTheDocument()
    expect(writes).toEqual([])

    await user.clear(beyond)
    await user.type(beyond, '800')
    await user.click(within(rules).getByRole('button', { name: 'Save driving rules' }))
    await waitFor(() => expect(writes).toEqual([{ method: 'PUT', path: '/settings/telemetry-rules/fleet', body: { ...FLEET, route_deviation_m: 800 } }]))
  })

  it('trip delay (FMS-147): late after 15 min and urgent after 60 at first; urgent must be later than late', async () => {
    const writes = serve({ fleet: { ...FLEET, ...never }, depots: [] })
    const { user, rules } = await open()
    const late = within(rules).getByLabelText('Trip late after')
    const urgent = within(rules).getByLabelText('Trip urgent after')
    expect(late).toHaveValue('15')
    expect(urgent).toHaveValue('60')

    await user.clear(late)
    await user.type(late, '60')
    await user.click(within(rules).getByRole('button', { name: 'Save driving rules' }))
    expect(within(rules).getByText('Enter more than the 60 min a trip is late after.')).toBeInTheDocument()
    expect(writes).toEqual([])

    await user.clear(late)
    await user.type(late, '20')
    await user.clear(urgent)
    await user.type(urgent, '90')
    await user.click(within(rules).getByRole('button', { name: 'Save driving rules' }))
    await waitFor(() =>
      expect(writes).toEqual([{ method: 'PUT', path: '/settings/telemetry-rules/fleet', body: { ...FLEET, trip_delay_minutes: 20, trip_delay_urgent_minutes: 90 } }]),
    )
  })

  it('assignment exceptions (FMS-151): each warning warns at first; one set to need approval is saved with the rest', async () => {
    const writes = serve({ fleet: { ...FLEET, ...never }, depots: [] })
    const { user } = await open()
    const form = await screen.findByRole('form', { name: "The fleet's driving rules" })
    expect(within(form).getByLabelText('Driver marked absent')).toHaveValue('warn')
    await user.selectOptions(within(form).getByLabelText('Previous trip running over'), 'approve')
    await user.click(within(form).getByRole('button', { name: 'Save driving rules' }))
    await waitFor(() =>
      expect(writes).toEqual([{ method: 'PUT', path: '/settings/telemetry-rules/fleet', body: { ...FLEET, trip_overrun_exception: 'approve' } }]),
    )
  })

  it("a depot's own thresholds: listed, given to another depot, and removed to follow the fleet's again", async () => {
    const writes = serve({ fleet: { ...FLEET, ...never }, depots: [{ depot_id: 'd-2', speed_limit_kmh: 60, speeding_pings: 2, clear_pings: 3, idle_minutes: 10, route_deviation_m: 1000, route_deviation_pings: 2, trip_delay_minutes: 20, trip_delay_urgent_minutes: 45, driver_attendance_exception: 'approve', trip_overrun_exception: 'warn', daily_distance_km: 400, weekly_distance_km: 2000, distance_weight_light: 0.8, distance_weight_standard: 1, distance_weight_heavy: 1.75, ...never }] })
    const { user } = await open()
    expect(await screen.findByText('Adama Hub')).toBeInTheDocument()
    expect(screen.getByText('60 km/h')).toBeInTheDocument()
    expect(screen.getByText('1,000 m')).toBeInTheDocument()
    expect(screen.getByText('20 min')).toBeInTheDocument()
    expect(screen.getByText('45 min')).toBeInTheDocument()
    // FMS-151: the depot holds an absent driver for a fleet manager.
    expect(screen.getByText(/approval for absent driver/)).toBeInTheDocument()
    // FMS-156: its own driving distance limits.
    expect(screen.getByText('400 km')).toBeInTheDocument()
    expect(screen.getByText('2,000 km')).toBeInTheDocument()

    // Only a depot without its own can be chosen; it starts from the fleet's.
    await user.click(screen.getByRole('button', { name: 'Thresholds for a depot' }))
    let drawer = await screen.findByRole('dialog', { name: 'Thresholds for a depot' })
    expect(within(within(drawer).getByLabelText('Depot')).getAllByRole('option').map((o) => o.textContent)).toEqual(['Choose a depot…', 'Addis Ababa Central'])
    await user.click(within(drawer).getByRole('button', { name: 'Save thresholds' }))
    expect(within(drawer).getByText('Choose a depot.')).toBeInTheDocument()
    await user.selectOptions(within(drawer).getByLabelText('Depot'), 'd-1')
    await user.clear(within(drawer).getByLabelText('Idling after'))
    await user.type(within(drawer).getByLabelText('Idling after'), '8')
    await user.click(within(drawer).getByRole('button', { name: 'Save thresholds' }))
    await waitFor(() => expect(writes).toEqual([{ method: 'PUT', path: '/settings/telemetry-rules/depots/d-1', body: { ...FLEET, idle_minutes: 8 } }]))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: "Edit Adama Hub's thresholds" }))
    drawer = await screen.findByRole('dialog', { name: 'Adama Hub thresholds' })
    expect(within(drawer).getByLabelText('Speed limit')).toHaveValue('60')
    expect(within(drawer).getByLabelText('Driver marked absent')).toHaveValue('approve')
    expect(within(drawer).getByLabelText('Previous trip running over')).toHaveValue('warn')
    expect(within(drawer).getByLabelText('Daily limit')).toHaveValue('400')
    expect(within(drawer).getByLabelText('Heavy job')).toHaveValue('1.75')

    // A week below a day, and a light job above a standard one, are refused before anything is sent.
    await user.clear(within(drawer).getByLabelText('Weekly limit'))
    await user.type(within(drawer).getByLabelText('Weekly limit'), '300')
    await user.clear(within(drawer).getByLabelText('Light job'))
    await user.type(within(drawer).getByLabelText('Light job'), '1.2')
    const sent = writes.length
    await user.click(within(drawer).getByRole('button', { name: 'Save thresholds' }))
    expect(await within(drawer).findByText('Enter at least the daily 400 km.')).toBeInTheDocument()
    expect(within(drawer).getByText("No more than a standard job's 1.")).toBeInTheDocument()
    expect(writes.length).toBe(sent)

    // Fixed, they are sent with the rest.
    await user.clear(within(drawer).getByLabelText('Weekly limit'))
    await user.type(within(drawer).getByLabelText('Weekly limit'), '2200')
    await user.clear(within(drawer).getByLabelText('Light job'))
    await user.type(within(drawer).getByLabelText('Light job'), '0,75')
    await user.click(within(drawer).getByRole('button', { name: 'Save thresholds' }))
    await waitFor(() =>
      expect(writes.at(-1)).toMatchObject({
        method: 'PUT',
        path: '/settings/telemetry-rules/depots/d-2',
        body: { daily_distance_km: 400, weekly_distance_km: 2200, distance_weight_light: 0.75, distance_weight_heavy: 1.75 },
      }),
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: "Edit Adama Hub's thresholds" }))
    drawer = await screen.findByRole('dialog', { name: 'Adama Hub thresholds' })
    await user.click(within(drawer).getByRole('button', { name: 'Use the fleet’s' }))
    await waitFor(() => expect(writes.at(-1)).toEqual({ method: 'DELETE', path: '/settings/telemetry-rules/depots/d-2', body: null }))
  })

  it('changes the alert settings: only what changed is sent, and the default can be put back', async () => {
    const settings = DEFAULT_SETTINGS.map((s) =>
      s.key === 'fuel_variance_threshold_pct' ? { ...s, value: 25, is_default: false, updated_by: 'u-1', updated_by_name: 'Abebe Kebede', updated_at: '2026-10-02T06:40:00Z' } : s,
    )
    const writes = serve({ fleet: { ...FLEET, ...never }, depots: [] }, settings)
    const { user } = await open()
    const form = await screen.findByRole('form', { name: 'Alert settings' })
    expect(within(form).getByLabelText('Fuel variance')).toHaveValue('25')
    expect(within(form).getByText('Changed by Abebe Kebede, 2 Oct 2026, 09:40')).toBeInTheDocument()
    expect(within(form).getByText(/Below this a technician is alerted and the vehicle shows At risk\. 50 to 84; default 75\./)).toBeInTheDocument()

    const line = within(form).getByLabelText('Health score alert line')
    await user.clear(line)
    await user.type(line, '90')
    await user.click(within(form).getByRole('button', { name: 'Save settings' }))
    expect(within(form).getByText('From 50 to 84.')).toBeInTheDocument()

    await user.clear(line)
    await user.type(line, '70')
    await user.click(within(form).getByRole('button', { name: 'Use the default (20)' }))
    await user.click(within(form).getByRole('button', { name: 'Save settings' }))
    await waitFor(() => expect(writes).toEqual([{ method: 'PATCH', path: '/settings', body: { fuel_variance_threshold_pct: 20, health_alert_below: 70 } }]))
  })

  it("changes the driver score's weights in a card of their own; refuses them all at 0 (FMS-146)", async () => {
    const writes = serve({ fleet: { ...FLEET, ...never }, depots: [] })
    const { user } = await open()
    const form = await screen.findByRole('form', { name: 'Driver score weights' })
    expect(within(form).getByLabelText('Punctuality')).toHaveValue('35')
    expect(within(form).getByLabelText('Inspections')).toHaveValue('10')
    // The alert card keeps to its own three.
    expect(within(screen.getByRole('form', { name: 'Alert settings' })).queryByLabelText('Punctuality')).not.toBeInTheDocument()

    for (const label of ['Punctuality', 'Safety', 'Incidents', 'Inspections']) {
      await user.clear(within(form).getByLabelText(label))
      await user.type(within(form).getByLabelText(label), '0')
    }
    await user.click(within(form).getByRole('button', { name: 'Save settings' }))
    expect(await within(form).findByText('At least one weight must be above 0, or no driver could be scored.')).toBeInTheDocument()
    expect(writes).toEqual([])

    await user.clear(within(form).getByLabelText('Safety'))
    await user.type(within(form).getByLabelText('Safety'), '50')
    await user.click(within(form).getByRole('button', { name: 'Save settings' }))
    await waitFor(() =>
      expect(writes).toEqual([
        { method: 'PATCH', path: '/settings', body: { driver_score_weight_punctuality: 0, driver_score_weight_safety: 50, driver_score_weight_incidents: 0, driver_score_weight_dvir: 0 } },
      ]),
    )
  })

  it('says why a save was refused', async () => {
    serve({ fleet: { ...FLEET, ...never }, depots: [] })
    server.use(http.put('/api/v1/settings/telemetry-rules/fleet', () => errorEnvelope(403, 'FORBIDDEN_INSUFFICIENT_ROLE', 'Needs settings:write.')))
    const { user, rules } = await open()
    const pings = within(rules).getByLabelText('Speeding after')
    await user.clear(pings)
    await user.type(pings, '4')
    await user.click(within(rules).getByRole('button', { name: 'Save driving rules' }))
    expect(await within(rules).findByText('Not saved: Needs settings:write.')).toBeInTheDocument()
  })

  it('is admin only: a fleet owner, who manages depots, has no Settings', async () => {
    serve({ fleet: { ...FLEET, ...never }, depots: [] })
    signedInAs(owner)
    renderApp('/settings')
    expect(await screen.findByRole('link', { name: 'Depots' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument()
    expect(screen.queryByRole('form', { name: "The fleet's driving rules" })).not.toBeInTheDocument()
  })
})

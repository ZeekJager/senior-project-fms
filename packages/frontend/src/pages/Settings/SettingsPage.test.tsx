import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { currentUser, envelope, errorEnvelope, renderApp, signedInAs } from '@/test/auth'
import { server } from '@/test/msw/server'
import type { RuleThresholds } from './api'
import type { HistoryEntry, Parameter } from './registry'

const admin = currentUser(['admin'], ['depot:read', 'depot:write', 'settings:write', 'settings:define', 'audit:read'])
/** Changes values, but cannot add, delete, enable or disable parameters. */
const editor = currentUser(['admin'], ['depot:read', 'settings:write'])
const owner = currentUser(['fleet_owner'], ['depot:read', 'depot:write', 'audit:read'])

const ADDIS = { id: 'd-1', name: 'Addis Ababa Central', code: 'ADD', location: 'Addis Ababa' }
const ADAMA = { id: 'd-2', name: 'Adama Hub', code: 'ADM', location: 'Adama' }
const FLEET = { speed_limit_kmh: 80, speeding_pings: 3, clear_pings: 3, idle_minutes: 5, route_deviation_m: 500, route_deviation_pings: 3, trip_delay_minutes: 15, trip_delay_urgent_minutes: 60, driver_attendance_exception: 'warn' as const, trip_overrun_exception: 'warn' as const, daily_distance_km: 500, weekly_distance_km: 2500, distance_weight_light: 0.8, distance_weight_standard: 1, distance_weight_heavy: 1.5 }
const never = { updated_by: null, updated_by_name: null, updated_at: null }

function param(p: Partial<Parameter> & Pick<Parameter, 'key' | 'label' | 'category' | 'type'>): Parameter {
  return {
    description: '',
    rules: {},
    default_value: null,
    value: null,
    is_default: true,
    is_enabled: true,
    is_system: true,
    is_secret: false,
    has_value: true,
    required_permission: null,
    storage: 'settings',
    version: 1,
    value_changed_at: null,
    value_changed_by: null,
    value_changed_by_name: null,
    created_at: '2026-11-01T08:00:00Z',
    updated_at: '2026-11-01T08:00:00Z',
    ...p,
  }
}

const SPEED = param({ key: 'speed_limit_kmh', label: 'Speed limit', category: 'Driving rules', type: 'integer', rules: { min: 20, max: 200, unit: 'km/h' }, default_value: 80, value: 80, storage: 'rule_thresholds', description: 'Exactly the limit is not speeding.' })
const HEALTH = param({ key: 'health_alert_below', label: 'Health score alert line', category: 'Alerts and anomalies', type: 'integer', rules: { min: 50, max: 84, unit: 'score' }, default_value: 75, value: 70, is_default: false, version: 4, value_changed_at: '2026-11-20T09:40:00Z', value_changed_by_name: 'Abebe Kebede' })
const DETAIL = param({
  key: 'report_detail',
  label: 'Report detail',
  category: 'Reports',
  type: 'dropdown',
  is_system: false,
  rules: { options: [{ value: 'summary', label: 'Summary' }, { value: 'standard', label: 'Standard' }, { value: 'full', label: 'Everything' }] },
  default_value: 'standard',
  value: 'standard',
})
const KEY = param({ key: 'maps_api_key', label: 'Maps API key', category: 'Integrations', type: 'text', is_system: false, is_secret: true, has_value: true, is_default: false, value: null, default_value: null })

/** A fake registry: the parameters, their histories, every write recorded with its If-Match. */
function serve(parameters: Parameter[], options: { history?: HistoryEntry[]; rules?: RuleThresholds } = {}) {
  const writes: { method: string; path: string; body: unknown; ifMatch: string | null }[] = []
  const path = (url: string) => new URL(url).pathname.replace('/api/v1', '')
  server.use(
    http.get('/api/v1/depots', () => envelope([ADDIS, ADAMA])),
    http.get('/api/v1/settings/telemetry-rules', () => envelope(options.rules ?? { fleet: { ...FLEET, ...never }, depots: [] })),
    http.put('/api/v1/settings/telemetry-rules/*', async ({ request }) => {
      writes.push({ method: 'PUT', path: path(request.url), body: await request.json(), ifMatch: null })
      return envelope(options.rules ?? { fleet: { ...FLEET, ...never }, depots: [] })
    }),
    http.delete('/api/v1/settings/telemetry-rules/depots/:id', ({ request }) => {
      writes.push({ method: 'DELETE', path: path(request.url), body: null, ifMatch: null })
      return new HttpResponse(null, { status: 204 })
    }),
    http.get('/api/v1/settings/definitions', () => envelope(parameters)),
    http.get('/api/v1/settings/definitions/:key/history', () => envelope(options.history ?? [])),
    http.post('/api/v1/settings/definitions', async ({ request }) => {
      const body = (await request.json()) as Parameter
      writes.push({ method: 'POST', path: '/settings/definitions', body, ifMatch: null })
      return HttpResponse.json({ data: param({ ...body, is_system: false, value: body.default_value }), meta: { request_id: 'r' } }, { status: 201 })
    }),
    http.patch('/api/v1/settings/definitions/:key', async ({ request, params }) => {
      const body = (await request.json()) as Record<string, unknown>
      writes.push({ method: 'PATCH', path: path(request.url), body, ifMatch: request.headers.get('If-Match') })
      const p = parameters.find((x) => x.key === params.key)!
      return envelope({ ...p, ...('value' in body ? { value: body.value ?? p.default_value } : {}), version: p.version + 1 })
    }),
    http.delete('/api/v1/settings/definitions/:key', ({ request }) => {
      writes.push({ method: 'DELETE', path: path(request.url), body: null, ifMatch: request.headers.get('If-Match') })
      return new HttpResponse(null, { status: 204 })
    }),
  )
  return writes
}

/** The category headings of the page (not the sidebar's). */
const categoryHeadings = () => within(screen.getByRole('main')).getAllByRole('heading', { level: 2 }).map((h) => h.textContent)

async function open(user = admin) {
  signedInAs(user)
  renderApp('/settings')
  await screen.findByRole('heading', { name: 'Settings', level: 1 })
  return userEvent.setup()
}

describe('S-27 Settings (FMS-80, FMS-157)', () => {
  it('lists every parameter by category, with its value, and narrows by view, search and category', async () => {
    serve([SPEED, HEALTH, DETAIL, KEY])
    const user = await open()
    const rules = await screen.findByRole('region', { name: 'Driving rules' })
    expect(within(rules).getByRole('button', { name: 'Speed limit: 80 km/h' })).toBeInTheDocument()
    const alerts = screen.getByRole('region', { name: 'Alerts and anomalies' })
    expect(within(alerts).getByText('70 score')).toBeInTheDocument()
    expect(within(alerts).getByText('Changed by Abebe Kebede, 20 Nov 2026, 12:40')).toBeInTheDocument()
    // A secret's value is never shown, only whether it is set.
    expect(screen.getByRole('button', { name: 'Maps API key: Set' })).toBeInTheDocument()
    // The system categories first, in the order the rules run.
    expect(categoryHeadings()).toEqual(['Driving rules', 'Alerts and anomalies', 'Integrations', 'Reports'])

    await user.click(screen.getByRole('button', { name: /^Changed from default/ }))
    expect(categoryHeadings()).toEqual(['Alerts and anomalies', 'Integrations'])
    await user.click(screen.getByRole('button', { name: /^All/ }))
    await user.type(screen.getByRole('searchbox', { name: 'Search settings' }), 'report')
    expect(categoryHeadings()).toEqual(['Reports'])
    await user.clear(screen.getByRole('searchbox', { name: 'Search settings' }))
    await user.type(screen.getByRole('searchbox', { name: 'Search settings' }), 'nothing like it')
    expect(screen.getByText('No parameter matches')).toBeInTheDocument()
  })

  it('a value is checked as it is typed by the API’s own validator; a system parameter needs a reason; the save sends If-Match', async () => {
    const writes = serve([SPEED, HEALTH])
    const user = await open()
    await user.click(await screen.findByRole('button', { name: 'Health score alert line: 70 score' }))
    const drawer = await screen.findByRole('dialog', { name: 'Health score alert line' })
    const value = within(drawer).getByLabelText('Value')
    expect(value).toHaveValue('70')

    await user.clear(value)
    await user.type(value, '90')
    expect(within(drawer).getByText('A whole number from 50 to 84.')).toBeInTheDocument()
    await user.click(within(drawer).getByRole('button', { name: 'Save value' }))
    expect(writes).toEqual([])

    await user.clear(value)
    await user.type(value, '72')
    await user.click(within(drawer).getByRole('button', { name: 'Save value' }))
    expect(await within(drawer).findByText('Say why: it changes how FMS works for everyone.')).toBeInTheDocument()
    expect(writes).toEqual([])

    await user.type(within(drawer).getByLabelText('Why'), 'Fewer false alarms')
    await user.click(within(drawer).getByRole('button', { name: 'Save value' }))
    await waitFor(() => expect(writes).toEqual([{ method: 'PATCH', path: '/settings/definitions/health_alert_below', body: { value: 72, reason: 'Fewer false alarms' }, ifMatch: '"4"' }]))
  })

  it('someone else saved first: 412 says so and offers to reload', async () => {
    serve([DETAIL])
    server.use(http.patch('/api/v1/settings/definitions/:key', () => errorEnvelope(412, 'PRECONDITION_FAILED', 'Someone else changed this parameter.')))
    const user = await open()
    await user.click(await screen.findByRole('button', { name: 'Report detail: Standard' }))
    const drawer = await screen.findByRole('dialog', { name: 'Report detail' })
    await user.selectOptions(within(drawer).getByLabelText('Value'), 'full')
    await user.click(within(drawer).getByRole('button', { name: 'Save value' }))
    expect(await within(drawer).findByText(/Someone else changed this parameter since you opened it/)).toBeInTheDocument()
    expect(within(drawer).getByRole('button', { name: 'Reload' })).toBeInTheDocument()
  })

  it('resets to the default, disables, and deletes a custom parameter after asking', async () => {
    const writes = serve([{ ...DETAIL, value: 'full', is_default: false, version: 3 }])
    const user = await open()
    await user.click(await screen.findByRole('button', { name: 'Report detail: Everything' }))
    const drawer = await screen.findByRole('dialog', { name: 'Report detail' })
    await user.click(within(drawer).getByRole('button', { name: 'Reset to default' }))
    await waitFor(() => expect(writes.at(-1)).toEqual({ method: 'PATCH', path: '/settings/definitions/report_detail', body: { value: null }, ifMatch: '"3"' }))

    await user.click(within(drawer).getByRole('switch', { name: /Enabled/ }))
    await waitFor(() => expect(writes.at(-1)).toMatchObject({ body: { is_enabled: false } }))

    await user.click(within(drawer).getByRole('button', { name: 'Delete parameter' }))
    const confirm = await screen.findByRole('dialog', { name: 'Delete Report detail?' })
    await user.click(within(confirm).getByRole('button', { name: 'Delete parameter' }))
    await waitFor(() => expect(writes.at(-1)).toEqual({ method: 'DELETE', path: '/settings/definitions/report_detail', body: null, ifMatch: '"3"' }))
  })

  it('the history shows who, when and why, restores a value and exports CSV; a secret’s is masked', async () => {
    const history: HistoryEntry[] = [
      { at: '2026-11-21T10:00:00Z', change: 'value', old_value: 'full', new_value: 'summary', fields: [], reason: null, by: 'u-2', by_name: 'Sara Tesfaye' },
      { at: '2026-11-20T09:00:00Z', change: 'value', old_value: null, new_value: 'full', fields: [], reason: 'The board wants it all', by: 'u-1', by_name: 'Abebe Kebede' },
      { at: '2026-11-19T08:00:00Z', change: 'defined', old_value: null, new_value: null, fields: [], reason: null, by: 'u-1', by_name: 'Abebe Kebede' },
    ]
    const writes = serve([{ ...DETAIL, value: 'summary', is_default: false, version: 5 }], { history })
    const user = await open()
    await user.click(await screen.findByRole('button', { name: 'Report detail: Summary' }))
    const drawer = await screen.findByRole('dialog', { name: 'Report detail' })
    const items = await within(drawer).findAllByRole('listitem')
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringContaining('Value changedEverything → Summary'),
      expect.stringContaining('Value changedDefault → Everything“The board wants it all”Abebe Kebede'),
      expect.stringContaining('AddedAbebe Kebede'),
    ])
    await user.click(within(items[1]).getByRole('button', { name: 'Restore this value' }))
    await waitFor(() => expect(writes.at(-1)).toMatchObject({ method: 'PATCH', body: { value: 'full', reason: expect.stringContaining('Restored the value of') }, ifMatch: '"5"' }))
    expect(within(drawer).getByRole('button', { name: 'Export CSV' })).toBeEnabled()
  })

  it('adds a dropdown with 3 options, checked before it is sent', async () => {
    const writes = serve([SPEED])
    const user = await open()
    await user.click(await screen.findByRole('button', { name: 'Add parameter' }))
    const drawer = await screen.findByRole('dialog', { name: 'Add parameter' })
    await user.type(within(drawer).getByLabelText('Name'), 'Report detail')
    expect(within(drawer).getByLabelText('Key')).toHaveValue('report_detail')
    await user.type(within(drawer).getByLabelText('Category'), 'Reports')
    await user.selectOptions(within(drawer).getByLabelText('Type'), 'dropdown')
    await user.type(within(drawer).getByLabelText('Option 1'), 'Summary')
    await user.type(within(drawer).getByLabelText('Option 2'), 'Standard')
    // Two options with the same value are refused before anything is sent.
    await user.click(within(drawer).getByRole('button', { name: 'Add option' }))
    await user.type(within(drawer).getByLabelText('Option 3'), 'Standard')
    await user.selectOptions(within(drawer).getByLabelText('Default'), 'standard')
    await user.click(within(drawer).getByRole('button', { name: 'Add parameter' }))
    expect(await within(drawer).findByText('The value standard is used twice.')).toBeInTheDocument()
    expect(writes).toEqual([])

    await user.clear(within(drawer).getByLabelText('Option 3'))
    await user.type(within(drawer).getByLabelText('Option 3'), 'Everything')
    await user.click(within(drawer).getByRole('button', { name: 'Add parameter' }))
    await waitFor(() =>
      expect(writes).toEqual([
        {
          method: 'POST',
          path: '/settings/definitions',
          ifMatch: null,
          body: {
            key: 'report_detail',
            label: 'Report detail',
            category: 'Reports',
            description: '',
            type: 'dropdown',
            default_value: 'standard',
            rules: { options: [{ value: 'summary', label: 'Summary' }, { value: 'standard', label: 'Standard' }, { value: 'everything', label: 'Everything' }] },
            is_enabled: true,
            is_secret: false,
            required_permission: null,
          },
        },
      ]),
    )
  })

  it('without settings:define: values change, but nothing is added, enabled, disabled or deleted', async () => {
    serve([DETAIL])
    const user = await open(editor)
    expect(screen.queryByRole('button', { name: 'Add parameter' })).not.toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: 'Report detail: Standard' }))
    const drawer = await screen.findByRole('dialog', { name: 'Report detail' })
    expect(within(drawer).getByRole('button', { name: 'Save value' })).toBeInTheDocument()
    expect(within(drawer).queryByRole('switch', { name: /Enabled/ })).not.toBeInTheDocument()
    expect(within(drawer).queryByRole('button', { name: 'Delete parameter' })).not.toBeInTheDocument()
  })

  it("a depot's own driving rules: listed under Driving rules, given to another depot, and removed", async () => {
    const writes = serve([SPEED], {
      rules: {
        fleet: { ...FLEET, ...never },
        depots: [{ depot_id: 'd-2', ...FLEET, speed_limit_kmh: 60, route_deviation_m: 1000, driver_attendance_exception: 'approve', daily_distance_km: 400, weekly_distance_km: 2000, ...never }],
      },
    })
    const user = await open()
    const rules = await screen.findByRole('region', { name: 'Driving rules' })
    expect(await within(rules).findByText('Adama Hub')).toBeInTheDocument()
    expect(within(rules).getByText('60 km/h')).toBeInTheDocument()
    expect(within(rules).getByText(/approval for absent driver/)).toBeInTheDocument()

    await user.click(within(rules).getByRole('button', { name: 'Thresholds for a depot' }))
    const drawer = await screen.findByRole('dialog', { name: 'Thresholds for a depot' })
    await user.selectOptions(within(drawer).getByLabelText('Depot'), 'd-1')
    await user.clear(within(drawer).getByLabelText('Idling after'))
    await user.type(within(drawer).getByLabelText('Idling after'), '8')
    await user.click(within(drawer).getByRole('button', { name: 'Save thresholds' }))
    await waitFor(() => expect(writes).toEqual([{ method: 'PUT', path: '/settings/telemetry-rules/depots/d-1', body: { ...FLEET, idle_minutes: 8 }, ifMatch: null }]))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await user.click(within(rules).getByRole('button', { name: "Edit Adama Hub's thresholds" }))
    await user.click(within(await screen.findByRole('dialog', { name: 'Adama Hub thresholds' })).getByRole('button', { name: 'Use the fleet’s' }))
    await waitFor(() => expect(writes.at(-1)).toEqual({ method: 'DELETE', path: '/settings/telemetry-rules/depots/d-2', body: null, ifMatch: null }))
  })

  it('is admin only: a fleet owner, who manages depots, has no Settings', async () => {
    serve([SPEED])
    signedInAs(owner)
    renderApp('/settings')
    expect(await screen.findByRole('link', { name: 'Depots' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Driving rules' })).not.toBeInTheDocument()
  })
})

import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { scrubEvent, scrubText } from '@/lib/errorTracking'
import { currentUser, envelope, renderApp, signedInAs } from '@/test/auth'
import { server } from '@/test/msw/server'
import type { MaintenanceWindow, ResourceMetric, SystemMetrics } from './api'

// FMS-163: System health's Resources tab: every host and service against its lines, the application and the database,
// maintenance windows. The browser asks the API, never Prometheus.

const admin = currentUser(['admin'], ['system:read', 'settings:write'])
const reader = currentUser(['compliance_officer'], ['system:read'])
const NOW = '2026-11-25T08:00:00.000Z'
const t = Date.parse(NOW) / 1000

const metric = (value: number | null, status: ResourceMetric['status'] = 'ok', ageSeconds = 10): ResourceMetric => ({
  value,
  status,
  sampled_at: value === null ? null : new Date((t - ageSeconds) * 1000).toISOString(),
  series: value === null ? [] : [[t - 120, value - 5], [t - 60, value - 2], [t - ageSeconds, value]],
})

const METRICS: SystemMetrics = {
  range: '1h',
  step_seconds: 60,
  generated_at: NOW,
  source: { configured: true, reachable: true },
  thresholds: { cpu_pct: { warning: 75, critical: 90 }, memory_pct: { warning: 80, critical: 90 }, disk_pct: { warning: 75, critical: 90 }, db_connections_pct: { warning: 70, critical: 85 }, replica_lag_seconds: { warning: 30, critical: 60 }, error_pct: { warning: 2, critical: 5 }, p95_ms: { warning: 500, critical: 1000 }, gps_silence_minutes: 2 },
  hosts: [{ name: 'fms-host', status: 'critical', cpu: metric(95, 'critical'), memory: metric(62), disk: metric(41), network_in: metric(120_000), network_out: metric(80_000) }],
  services: [
    { name: 'backend', status: 'ok', cpu: metric(12), memory: metric(4), disk: null, network_in: metric(40_000), network_out: metric(30_000) },
    { name: 'postgres', status: 'warning', cpu: metric(78, 'warning'), memory: metric(9), disk: null, network_in: metric(1000), network_out: metric(900) },
  ],
  application: { request_rate_per_minute: metric(420), error_pct: metric(0.3), p95_ms: metric(620, 'warning'), gps_points_per_minute: metric(160), sockets: metric(14), job_failures_last_hour: metric(0) },
  database: { connections_pct: metric(22), transactions_per_second: metric(35), cache_hit_pct: metric(99.6), replica_lag_seconds: metric(1.2), slowest_queries: [{ query: 'SELECT * FROM trip.trips WHERE driver_id = $1', calls: 42, mean_ms: 812.4, total_ms: 34120 }] },
}

function serve(metrics: SystemMetrics = METRICS, windows: MaintenanceWindow[] = []) {
  const asked: string[] = []
  const created: unknown[] = []
  let list = windows
  server.use(
    http.get('/api/v1/system/metrics', ({ request }) => {
      asked.push(new URL(request.url).searchParams.get('range') ?? '')
      return envelope(metrics)
    }),
    http.get('/api/v1/system/maintenance-windows', () => envelope(list)),
    http.post('/api/v1/system/maintenance-windows', async ({ request }) => {
      const body = (await request.json()) as { hosts: string[]; starts_at: string; ends_at: string; reason: string }
      created.push(body)
      list = [...list, { id: 'w-1', ...body, cancelled_at: null, in_force: true, suppressed: 0, version: 1 }]
      return HttpResponse.json({ data: list.at(-1), meta: { request_id: 'r-1' } }, { status: 201 })
    }),
  )
  return { asked, created }
}

describe('Resources (FMS-163)', () => {
  it('shows every host and service with its status as an icon and a label, how old each value is, and the panels', async () => {
    const { asked } = serve()
    signedInAs(admin)
    renderApp('/system-health?tab=resources')

    const hosts = await screen.findByRole('region', { name: /Hosts/ })
    expect(within(hosts).getByText('fms-host')).toBeInTheDocument()
    expect(within(hosts).getAllByText('Critical').length).toBeGreaterThan(0)
    expect(within(hosts).getByText('Updated 10 s ago')).toBeInTheDocument()
    expect(within(hosts).getByText('95%')).toBeInTheDocument()
    const services = screen.getByRole('region', { name: 'Services' })
    expect(within(services).getByText('backend')).toBeInTheDocument()
    expect(within(services).getAllByText('Warning').length).toBeGreaterThan(0)
    expect(screen.getByText('620 ms')).toBeInTheDocument()
    expect(screen.getByText('SELECT * FROM trip.trips WHERE driver_id = $1')).toBeInTheDocument()
    expect(asked).toContain('1h')

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: '12 months' }))
    expect(asked).toContain('12m')
  })

  it('says when monitoring is not set up', async () => {
    serve({ ...METRICS, source: { configured: false, reachable: false }, hosts: [], services: [], application: null, database: null })
    signedInAs(reader)
    renderApp('/system-health?tab=resources')
    expect(await screen.findByText('Monitoring is not set up')).toBeInTheDocument()
    // A reader without settings:write keeps no windows.
    expect(screen.queryByRole('button', { name: 'Add a window' })).not.toBeInTheDocument()
  })

  it('an administrator adds a maintenance window for chosen hosts', async () => {
    const { created } = serve()
    signedInAs(admin)
    renderApp('/system-health?tab=resources')
    const user = userEvent.setup()
    await user.click(await screen.findByRole('button', { name: 'Add a window' }))
    const form = screen.getByRole('form', { name: 'Add a maintenance window' })
    await user.type(within(form).getByLabelText('Hosts or services (comma-separated)'), 'fms-host, postgres')
    await user.type(within(form).getByLabelText('Why'), 'Disk replacement')
    await user.type(within(form).getByLabelText('Starts'), '2026-11-25T09:00')
    await user.type(within(form).getByLabelText('Ends'), '2026-11-25T11:00')
    await user.click(within(form).getByRole('button', { name: 'Save window' }))
    expect(await screen.findByText('Maintenance window added')).toBeInTheDocument()
    expect(created).toEqual([{ hosts: ['fms-host', 'postgres'], starts_at: expect.any(String), ends_at: expect.any(String), reason: 'Disk replacement' }])
    expect(await screen.findByText('fms-host, postgres')).toBeInTheDocument()
  })
})

describe('error tracking in the web app', () => {
  it('masks what identifies a person and keeps no query, form or breadcrumbs', () => {
    expect(scrubText('failed for abebe@example.com, 0911 234 567, Bearer abc.def')).toBe('failed for [email], [number], Bearer [Filtered]')
    const out = scrubEvent({ type: undefined, request: { url: 'https://fms.example/drivers?search=abebe#x' }, user: { id: 'u-1', email: 'a@b.cc' }, breadcrumbs: [{ message: 'typed password' }], message: 'x@y.io' })
    expect(out).toMatchObject({ request: { url: 'https://fms.example/drivers' }, user: { id: 'u-1' }, message: '[email]' })
    expect(out.breadcrumbs).toBeUndefined()
  })
})

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { currentUser, envelope, errorEnvelope, renderApp, signedInAs } from '@/test/auth'
import { server } from '@/test/msw/server'
import type { ComponentHealth, SystemHealth, SystemHealthHistory, Uptime } from './api'

// jsdom has no canvas: the charts stand in as what they were given.
vi.mock('@/pages/SystemHealth/charts', () => ({
  ErrorRateChart: ({ cells }: { cells: unknown[] }) => <p>Error rate chart: {cells.length} cells</p>,
  LatencyChart: ({ cells }: { cells: unknown[] }) => <p>Latency chart: {cells.length} cells</p>,
}))

const admin = currentUser(['admin'], ['system:read', 'users:read'])
const manager = currentUser(['fleet_manager'], ['users:read', 'vehicle:read'])

const NOW = '2026-11-04T09:30:00.000Z'
const up = (pct: number | null, down = 0): Uptime => ({ uptime_pct: pct, ok_minutes: 1440 - down, down_minutes: down, disabled_minutes: 0, no_data_minutes: 0 })
const none: Uptime = { uptime_pct: null, ok_minutes: 0, down_minutes: 0, disabled_minutes: 1440, no_data_minutes: 0 }

function component(over: Partial<ComponentHealth> & Pick<ComponentHealth, 'component' | 'kind' | 'label'>): ComponentHealth {
  return { status: 'ok', checked_at: '2026-11-04T09:29:00.000Z', latency_ms: 4, error: null, uptime: { '24h': up(100), '7d': up(100), '30d': up(100) }, ...over }
}

const COMPONENTS: ComponentHealth[] = [
  component({ component: 'api', kind: 'api', label: 'API', latency_ms: 2 }),
  component({ component: 'database', kind: 'database', label: 'Database', latency_ms: 1 }),
  component({ component: 'replica', kind: 'replica', label: 'Read replica', status: 'disabled', latency_ms: null, uptime: { '24h': none, '7d': none, '30d': none } }),
  component({ component: 'redis', kind: 'redis', label: 'Redis', uptime: { '24h': up(99.79, 3), '7d': up(99.97, 3), '30d': up(99.99, 3) } }),
  component({ component: 'ai_service', kind: 'ai_service', label: 'AI service', latency_ms: 12 }),
  component({ component: 'provider:fuel-card', kind: 'provider', label: 'Fuel card gateway', latency_ms: 210 }),
]

const SUMMARY: SystemHealth = {
  generated_at: NOW,
  window_end: '2026-11-04T09:30:00.000Z',
  sampled_from: '2026-10-20T06:00:00.000Z',
  components: COMPONENTS,
  outages: [
    { component: 'redis', label: 'Redis', started_at: '2026-11-04T07:12:00.000Z', ended_at: '2026-11-04T07:15:00.000Z', duration_minutes: 3, error: 'connect ECONNREFUSED 172.18.0.4:6379' },
    // Ten days ago: in the 30 days, not the 24 hours.
    { component: 'api', label: 'API', started_at: '2026-10-25T02:00:00.000Z', ended_at: '2026-10-25T02:40:00.000Z', duration_minutes: 40, error: 'No samples: the API was not running' },
  ],
  outages_total: 2,
  failed_jobs: [{ job: 'analytics-refresh-nightly', run_key: '2026-11-04', attempts: 5, started_at: '2026-11-03T23:15:00.000Z', failed_at: '2026-11-03T23:16:02.000Z', error: 'canceling statement due to statement timeout' }],
  failed_jobs_total: 1,
}

function history(window: '24h' | '7d' | '30d', cells = 96): SystemHealthHistory {
  const bucket = { '24h': 15, '7d': 120, '30d': 480 }[window]
  const start = (i: number) => new Date(Date.parse(NOW) - (cells - i) * bucket * 60_000).toISOString()
  const timeline = (down: number[] = []) =>
    Array.from({ length: cells }, (_, i) => ({ start: start(i), ok_minutes: down.includes(i) ? bucket - 3 : bucket, down_minutes: down.includes(i) ? 3 : 0, disabled_minutes: 0, no_data_minutes: 0 }))
  return {
    window,
    from: start(0),
    to: NOW,
    bucket_minutes: bucket,
    requests: {
      requests: 12_480,
      errors_5xx: 25,
      error_rate_pct: 0.2,
      p95_ms: 184,
      cells: Array.from({ length: cells }, (_, i) => ({ start: start(i), requests: 130, errors_5xx: 0, error_rate_pct: 0, p95_ms: 180 })),
    },
    components: COMPONENTS.map((c) => ({ component: c.component, label: c.label, cells: c.component === 'redis' ? timeline([cells - 10]) : timeline() })),
  }
}

function serve(summary: SystemHealth = SUMMARY) {
  const windows: string[] = []
  server.use(
    http.get('/api/v1/system/health', () => envelope(summary)),
    http.get('/api/v1/system/health/history', ({ request }) => {
      const window = (new URL(request.url).searchParams.get('window') ?? '24h') as '24h' | '7d' | '30d'
      windows.push(window)
      return envelope(history(window, { '24h': 96, '7d': 84, '30d': 90 }[window]))
    }),
  )
  return windows
}

describe('S-31 System health (FMS-143)', () => {
  it('shows each component now and its uptime, the outages, failed jobs and request figures of the period', async () => {
    serve()
    signedInAs(admin)
    renderApp('/system-health')

    expect(await screen.findByRole('heading', { name: 'System health', level: 1 })).toBeInTheDocument()
    expect(await screen.findByText('All systems working')).toBeInTheDocument()

    const list = screen.getByRole('list', { name: 'Components' })
    const rows = within(list).getAllByRole('listitem')
    expect(rows.map((r) => within(r).getAllByText(/\S/)[0].textContent)).toEqual(['API', 'Database', 'Read replica', 'Redis', 'AI service', 'Fuel card gateway'])
    const redis = rows[3]
    expect(within(redis).getByText('Up')).toBeInTheDocument()
    expect(within(redis).getByText('99.79%')).toBeInTheDocument()
    expect(within(redis).getByText('99.97%')).toBeInTheDocument()
    expect(within(redis).getByRole('img', { name: 'Redis: down 3 min in the period, 99.79% up' })).toBeInTheDocument()
    expect(within(rows[2]).getByText('Not configured')).toBeInTheDocument()
    expect(within(rows[2]).getByText('Not set up on this server')).toBeInTheDocument()
    expect(within(rows[5]).getByText('210 ms')).toBeInTheDocument()

    // The KPI strip and the charts for the 24 hours.
    expect(screen.getByText('12,480')).toBeInTheDocument()
    expect(screen.getByText('0.2%')).toBeInTheDocument()
    expect(screen.getByText('184 ms')).toBeInTheDocument()
    expect(await screen.findByText('Error rate chart: 96 cells')).toBeInTheDocument()
    expect(screen.getByText('Latency chart: 96 cells')).toBeInTheDocument()

    // Only the outage of the last 24 hours, with its error.
    const outages = screen.getByRole('table', { name: /Outages in the last 24 hours/ })
    expect(within(outages).getAllByRole('row')).toHaveLength(2)
    expect(within(outages).getByText('3 min')).toBeInTheDocument()
    expect(within(outages).getByText('connect ECONNREFUSED 172.18.0.4:6379')).toBeInTheDocument()

    const jobs = screen.getByRole('table', { name: /Scheduled job runs that failed/ })
    expect(within(jobs).getByText('analytics-refresh-nightly')).toBeInTheDocument()
    expect(within(jobs).getByText('canceling statement due to statement timeout')).toBeInTheDocument()
    expect(within(jobs).getByText('5')).toBeInTheDocument()
  })

  it('30 days: the history of the month and the outages in it', async () => {
    const windows = serve()
    signedInAs(admin)
    renderApp('/system-health')
    await screen.findByText('Error rate chart: 96 cells')
    await userEvent.setup().click(screen.getByRole('button', { name: '30 days' }))
    expect(await screen.findByText('Error rate chart: 90 cells')).toBeInTheDocument()
    expect(windows).toContain('30d')
    const outages = screen.getByRole('table', { name: /Outages in the last 30 days/ })
    expect(within(outages).getAllByRole('row')).toHaveLength(3)
    expect(within(outages).getByText('40 min')).toBeInTheDocument()
  })

  it('a component down now leads the page with its error, and its outage goes on', async () => {
    serve({
      ...SUMMARY,
      components: COMPONENTS.map((c) => (c.component === 'redis' ? { ...c, status: 'down', error: 'Connection is closed.' } : c)),
      outages: [{ component: 'redis', label: 'Redis', started_at: '2026-11-04T09:26:00.000Z', ended_at: null, duration_minutes: 4, error: 'Connection is closed.' }],
    })
    signedInAs(admin)
    renderApp('/system-health')
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Redis is down')
    expect(alert).toHaveTextContent('Redis: Connection is closed.')
    expect(within(screen.getByRole('table', { name: /Outages/ })).getByText('Going on')).toBeInTheDocument()
    expect(screen.getByText('One is going on now')).toBeInTheDocument()
  })

  it('empty: nothing sampled yet, no outages, no failed jobs', async () => {
    const empty = (c: ComponentHealth): ComponentHealth => ({ ...c, status: c.component === 'api' ? 'ok' : 'no_data', checked_at: null, latency_ms: null, uptime: { '24h': up(null), '7d': up(null), '30d': up(null) } })
    serve({ ...SUMMARY, sampled_from: null, components: COMPONENTS.map(empty), outages: [], outages_total: 0, failed_jobs: [], failed_jobs_total: 0 })
    signedInAs(admin)
    renderApp('/system-health')
    expect(await screen.findByText('No samples yet')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'No outages' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'No failed jobs' })).toBeInTheDocument()
  })

  // A 5xx is retried twice (lib/query) before the page gives up, a second and two apart.
  it('error: the summary failed, and Try again reads it again', { timeout: 15_000 }, async () => {
    let calls = 0
    server.use(
      http.get('/api/v1/system/health', () => {
        calls += 1
        return calls <= 3 ? errorEnvelope(500, 'INTERNAL_SERVER_ERROR', 'Something went wrong on our side.') : envelope(SUMMARY)
      }),
      http.get('/api/v1/system/health/history', () => envelope(history('24h'))),
    )
    signedInAs(admin)
    renderApp('/system-health')
    expect(await screen.findByText('System health could not be loaded', {}, { timeout: 8_000 })).toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole('button', { name: /try again/i }))
    expect(await screen.findByText('All systems working')).toBeInTheDocument()
    await waitFor(() => expect(calls).toBe(4))
  })

  it('is admin only: a fleet manager has no System health', async () => {
    serve()
    signedInAs(manager)
    renderApp('/system-health')
    expect(await screen.findByRole('link', { name: 'Users & roles' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'System health' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'System health', level: 1 })).not.toBeInTheDocument()
  })
})

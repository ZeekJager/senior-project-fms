import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { currentUser, errorEnvelope, renderApp, signedInAs } from '@/test/auth'
import { server } from '@/test/msw/server'
import { ago, formatBytes } from './BackupsPage'
import type { Backup, BackupsMeta, BaseBackup, PitrOverview } from './api'

// FMS-144: S-30 Backups. The API is faked; so is the browser's download (startDownload).

const downloads = vi.hoisted(() => ({ started: [] as [string, string][] }))
vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  startDownload: (url: string, filename: string) => downloads.started.push([url, filename]),
}))

const ADMIN = ['backup:read', 'backup:write', 'audit:read', 'users:read']

const backup = (over: Partial<Backup> = {}): Backup => ({
  id: 'b1',
  kind: 'manual',
  status: 'succeeded',
  database_name: 'fms_db',
  requested_by: { id: 'u1', name: 'Sara Admin' },
  requested_at: '2026-11-01T22:00:00Z',
  started_at: '2026-11-01T22:00:01Z',
  finished_at: '2026-11-01T22:01:10Z',
  size_bytes: 3_456_789,
  checksum_sha256: 'a'.repeat(64),
  error: null,
  expires_at: '2026-12-01T22:01:10Z',
  downloadable: true,
  ...over,
})

const meta = (over: Partial<BackupsMeta> = {}): BackupsMeta => ({
  page: 1,
  page_size: 20,
  total_items: 1,
  total_pages: 1,
  available: true,
  retention_days: 30,
  last_succeeded_at: '2026-11-01T22:01:10Z',
  last_restore_drill: null,
  pitr: pitr(),
  ...over,
})

// FMS-108: point-in-time recovery, as GET /system/backups meta.pitr gives it. Healthy unless a test says otherwise.
function pitr(over: Partial<PitrOverview> = {}): PitrOverview {
  return {
    enabled: true,
    recoverable_from: '2026-11-10T21:01:14Z',
    recoverable_to: '2026-11-24T08:59:30Z',
    archiving: { last_archived_at: '2026-11-24T08:59:30Z', last_failed_at: null, failing_since: null },
    repositories: [
      { repo: 1, location: 'local', status: 'ok', message: null, encrypted: true, base_backups: 9, recoverable_from: '2026-11-10T21:01:14Z', recoverable_to: '2026-11-24T08:59:30Z', checked_at: '2026-11-24T09:00:00Z' },
      { repo: 2, location: 'offsite', status: 'ok', message: null, encrypted: true, base_backups: 9, recoverable_from: '2026-11-10T21:01:14Z', recoverable_to: '2026-11-24T08:59:30Z', checked_at: '2026-11-24T09:00:00Z' },
    ],
    last_base_backup_at: '2026-11-23T22:01:10Z',
    last_drill: {
      id: 'd1',
      base_backup_label: '20261123-220000F',
      recovery_target: 'fms-drill-20261123T230000Z',
      status: 'succeeded',
      started_at: '2026-11-23T23:00:00Z',
      finished_at: '2026-11-23T23:01:23Z',
      tables_restored: 74,
      rto_seconds: 80,
      checks: [
        { table: 'fleet.vehicles', live_rows: 50, restored_rows: 50, match: true },
        { table: 'trip.trips', live_rows: 160, restored_rows: 160, match: true },
      ],
      error: null,
      run_by: 'monthly drill',
    },
    findings: [],
    ...over,
  }
}

const baseBackup = (over: Partial<BaseBackup> = {}): BaseBackup => ({
  id: 'bb1',
  label: '20261123-220000F_20261123-220005D',
  type: 'diff',
  triggered_by: 'schedule',
  repo: 1,
  location: 'local',
  status: 'succeeded',
  started_at: '2026-11-23T22:00:00Z',
  finished_at: '2026-11-23T22:01:10Z',
  size_bytes: 10_800_000_000,
  repo_size_bytes: 52_000_000,
  error: null,
  ...over,
})

function serveBase(data: BaseBackup[] = [baseBackup()]) {
  server.use(
    http.get('/api/v1/system/base-backups', () =>
      HttpResponse.json({ data, meta: { page: 1, page_size: 10, total_items: data.length, total_pages: 1, request_id: 'r' } }),
    ),
  )
}

function serve(...pages: { data: Backup[]; meta: BackupsMeta }[]) {
  let calls = 0
  server.use(
    http.get('/api/v1/system/backups', () => {
      const page = pages[Math.min(calls++, pages.length - 1)]
      return HttpResponse.json({ data: page.data, meta: { ...page.meta, request_id: 'r' } })
    }),
  )
}

async function open(permissions = ADMIN) {
  signedInAs(currentUser(['admin'], permissions))
  renderApp('/backups')
  return screen.findByRole('table', { name: 'Database backups, newest first' })
}

beforeEach(() => {
  downloads.started = []
  serveBase()
})

describe('S-30 Backups (FMS-144)', () => {
  it('lists each backup with its status, size and who started it, and the backups’ health', async () => {
    serve({
      data: [
        backup(),
        backup({ id: 'b2', kind: 'scheduled', requested_by: null, status: 'failed', size_bytes: null, checksum_sha256: null, error: 'pg_dump: error: connection failed', downloadable: false }),
        backup({ id: 'b3', status: 'expired', downloadable: false }),
      ],
      meta: meta({ total_items: 3 }),
    })
    const table = await open()
    await within(table).findAllByText('Sara Admin')
    const rows = within(table).getAllByRole('row').slice(1)
    expect(rows[0]).toHaveTextContent('Back up now')
    expect(rows[0]).toHaveTextContent('Succeeded')
    expect(rows[0]).toHaveTextContent('3.3 MB')
    expect(rows[0]).toHaveTextContent('Sara Admin')
    expect(within(rows[0]).getByRole('button', { name: /Download the backup/ })).toBeInTheDocument()
    expect(rows[1]).toHaveTextContent('Nightly')
    expect(rows[1]).toHaveTextContent('Failed')
    expect(rows[1]).toHaveTextContent('pg_dump: error: connection failed')
    expect(rows[1]).toHaveTextContent('Schedule')
    expect(within(rows[1]).queryByRole('button')).not.toBeInTheDocument()
    expect(rows[2]).toHaveTextContent('Expired')
    const health = screen.getByRole('region', { name: 'Backup health' })
    expect(health).toHaveTextContent('Last restore drill')
    expect(health).toHaveTextContent('None yet')
  })

  it('Back up now asks first, starts one, and watches it until it is done', async () => {
    const queued = backup({ id: 'b9', status: 'queued', started_at: null, finished_at: null, size_bytes: null, checksum_sha256: null, expires_at: null, downloadable: false })
    serve({ data: [], meta: meta({ total_items: 0, last_succeeded_at: null }) }, { data: [queued], meta: meta() }, { data: [backup({ id: 'b9' })], meta: meta() })
    let posted = 0
    server.use(
      http.post('/api/v1/system/backups', () => {
        posted += 1
        return HttpResponse.json({ data: queued, meta: { request_id: 'r' } }, { status: 202 })
      }),
    )
    const user = userEvent.setup()
    const table = await open()
    expect(await screen.findByText('No backups yet')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Back up now' }))
    const dialog = await screen.findByRole('dialog', { name: 'Back up the database now?' })
    await user.click(within(dialog).getByRole('button', { name: 'Back up now' }))
    expect(await screen.findByText('Backup started')).toBeInTheDocument()
    expect(posted).toBe(1)
    // While it runs the button waits, and the list is polled until it is done.
    expect(await screen.findByRole('button', { name: /Backing up/ })).toBeDisabled()
    await waitFor(() => expect(within(table).getByText('Succeeded')).toBeInTheDocument(), { timeout: 6000 })
    expect(screen.getByRole('button', { name: 'Back up now' })).toBeEnabled()
  }, 10_000)

  it('a refused start is said in the dialog', async () => {
    serve({ data: [], meta: meta({ total_items: 0 }) })
    server.use(http.post('/api/v1/system/backups', () => errorEnvelope(409, 'CONFLICT_DUPLICATE', 'A backup is already under way. Wait for it to finish.')))
    const user = userEvent.setup()
    await open()
    await user.click(await screen.findByRole('button', { name: 'Back up now' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Back up now' }))
    expect(await within(dialog).findByText('A backup is already under way. Wait for it to finish.')).toBeInTheDocument()
  })

  it('Download asks for a signed link and hands it to the browser', async () => {
    serve({ data: [backup()], meta: meta() })
    server.use(
      http.post('/api/v1/system/backups/b1/download-link', () =>
        HttpResponse.json({
          data: { url: '/api/v1/system/backups/b1/content?user=u&expires=1&signature=s', expires_at: '2026-11-01T22:06:00Z', filename: 'fms-fms_db-20261101-2200Z.dump' },
          meta: {},
        }),
      ),
    )
    const user = userEvent.setup()
    await open()
    await user.click(await screen.findByRole('button', { name: /Download the backup/ }))
    await waitFor(() => expect(downloads.started).toEqual([['/api/v1/system/backups/b1/content?user=u&expires=1&signature=s', 'fms-fms_db-20261101-2200Z.dump']]))
  })

  it('says when backups are not set up, and shows the last restore drill', async () => {
    serve({
      data: [],
      meta: meta({
        available: false,
        total_items: 0,
        last_restore_drill: {
          id: 'd1',
          backup_id: 'b1',
          target_database: 'fms_drill',
          status: 'succeeded',
          started_at: '2026-11-01T22:10:00Z',
          finished_at: '2026-11-01T22:11:00Z',
          tables_restored: 61,
          error: null,
          run_by: 'ops',
        },
      }),
    })
    await open()
    expect(await screen.findByRole('alert')).toHaveTextContent('Backups are not set up on this server')
    expect(screen.getByRole('button', { name: 'Back up now' })).toBeDisabled()
    expect(screen.getByRole('region', { name: 'Backup health' })).toHaveTextContent('61 tables into fms_drill')
  })

  it('without backup:write there is no Back up now', async () => {
    serve({ data: [backup()], meta: meta() })
    await open(['backup:read'])
    expect(await screen.findByText('Sara Admin')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Back up now' })).not.toBeInTheDocument()
  })
})

describe('backup formatting', () => {
  it('sizes and ages', () => {
    expect(formatBytes(900)).toBe('900 B')
    expect(formatBytes(312 * 1024)).toBe('312 KB')
    expect(formatBytes(1.45 * 1024 * 1024)).toBe('1.4 MB')
    const now = Date.parse('2026-11-02T00:00:00Z')
    expect(ago('2026-11-01T23:59:40Z', now)).toBe('just now')
    expect(ago('2026-11-01T23:30:00Z', now)).toBe('30 min ago')
    expect(ago('2026-11-01T20:00:00Z', now)).toBe('4 h ago')
    expect(ago('2026-10-28T00:00:00Z', now)).toBe('5 days ago')
  })
})

describe('S-30 Backups: point-in-time recovery (FMS-108)', () => {
  const section = () => screen.findByRole('region', { name: 'Point-in-time recovery' })

  it('shows how far back and how recently the database can be restored, the copies, the drill and the base backups', async () => {
    serve({ data: [backup()], meta: meta() })
    await open()
    const pitrSection = await section()
    expect(await within(pitrSection).findByText('Protected')).toBeInTheDocument()
    // Addis Ababa time, to the second.
    expect(pitrSection).toHaveTextContent('11 Nov, 00:01:14')
    expect(pitrSection).toHaveTextContent('24 Nov, 11:59:30')
    expect(pitrSection).toHaveTextContent('Every change, within a minute')
    expect(pitrSection).toHaveTextContent('Beside the database')
    expect(pitrSection).toHaveTextContent('Off site')
    expect(pitrSection).toHaveTextContent('9 base backups, encrypted')
    expect(pitrSection).toHaveTextContent('Opened in 1 min 20 s, 2 of 2 key tables identical')

    const table = await within(pitrSection).findByRole('table', { name: 'Base backups, newest first' })
    const [row] = within(table).getAllByRole('row').slice(1)
    expect(row).toHaveTextContent('Nightly differential')
    expect(row).toHaveTextContent('Succeeded')
    expect(row).toHaveTextContent('10.1 GB')
    expect(row).toHaveTextContent('49.6 MB')
  })

  it('lists what puts recovery at risk, critical first, and says who is alerted how', async () => {
    serve({
      data: [],
      meta: meta({
        pitr: pitr({
          archiving: { last_archived_at: '2026-11-24T08:40:00Z', last_failed_at: '2026-11-24T08:59:00Z', failing_since: '2026-11-24T08:40:00Z' },
          repositories: [pitr().repositories[0], { ...pitr().repositories[1], status: 'error', message: 'unable to connect to the bucket' }],
          findings: [
            { condition: 'archiving_failing', severity: 'critical', repo: null, since: '2026-11-24T08:40:00Z', message: 'WAL archiving has failed for 20 min.' },
            { condition: 'drill_overdue', severity: 'high', repo: null, since: '2026-10-01T00:00:00Z', message: 'No restore drill has passed for 54 days.' },
          ],
        }),
      }),
    })
    await open()
    const pitrSection = await section()
    expect(await within(pitrSection).findByText('At risk')).toBeInTheDocument()
    const risks = within(pitrSection).getAllByRole('listitem').filter((li) => li.textContent?.includes('Since'))
    expect(risks[0]).toHaveTextContent('Critical: WAL archiving has failed for 20 min.')
    expect(risks[0]).toHaveTextContent('by email, SMS and push')
    expect(risks[1]).toHaveTextContent('Warning: No restore drill has passed for 54 days.')
    expect(risks[1]).toHaveTextContent('by push')
    expect(pitrSection).toHaveTextContent('Failing since 24 Nov 2026, 11:40')
    expect(pitrSection).toHaveTextContent('unable to connect to the bucket')
  })

  it('says when there is no off-site copy, and when no base backup has finished yet', async () => {
    serveBase([])
    serve({ data: [], meta: meta({ pitr: pitr({ recoverable_from: null, recoverable_to: null, repositories: [pitr().repositories[0]], last_drill: null }) }) })
    await open()
    const pitrSection = await section()
    expect(await within(pitrSection).findByText('Needs attention')).toBeInTheDocument()
    expect(pitrSection).toHaveTextContent('Not yet: the first base backup is still being taken')
    expect(pitrSection).toHaveTextContent('No off-site copy')
    expect(await within(pitrSection).findByText('No base backups yet')).toBeInTheDocument()
  })

  it('on a server that does not archive its WAL, says so and shows only the nightly copies', async () => {
    serve({ data: [backup()], meta: meta({ pitr: pitr({ enabled: false, recoverable_from: null, recoverable_to: null, repositories: [], last_drill: null }) }) })
    await open()
    const pitrSection = await section()
    expect(await within(pitrSection).findByText('Not set up')).toBeInTheDocument()
    expect(pitrSection).toHaveTextContent('does not archive its changes')
    expect(within(pitrSection).queryByRole('table')).not.toBeInTheDocument()
  })
})

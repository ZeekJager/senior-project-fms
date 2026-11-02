import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { currentUser, errorEnvelope, renderApp, signedInAs } from '@/test/auth'
import { server } from '@/test/msw/server'
import { ago, formatBytes } from './BackupsPage'
import type { Backup, BackupsMeta } from './api'

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
  ...over,
})

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
    await open()
    expect(await screen.findByText('No backups yet')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Back up now' }))
    const dialog = await screen.findByRole('dialog', { name: 'Back up the database now?' })
    await user.click(within(dialog).getByRole('button', { name: 'Back up now' }))
    expect(await screen.findByText('Backup started')).toBeInTheDocument()
    expect(posted).toBe(1)
    // While it runs the button waits, and the list is polled until it is done.
    expect(await screen.findByRole('button', { name: /Backing up/ })).toBeDisabled()
    await waitFor(() => expect(screen.getByText('Succeeded')).toBeInTheDocument(), { timeout: 6000 })
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

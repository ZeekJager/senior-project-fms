import { AlertTriangle, CalendarClock, DatabaseBackup, Download, FlaskConical, HardDriveDownload, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { ConfirmDialog, DataTable, EmptyState, type Column } from '@/components/shared'
import { Badge, Button, Spinner, useToast, type BadgeTone } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { errorDetails } from '@/components/shared'
import { Fact, ago, at, formatBytes } from './parts'
import { PointInTime } from './PointInTime'
import { BACKUPS_PAGE_SIZE, startDownload, useBackups, useDownloadLink, useStartBackup, type Backup, type BackupStatus, type RestoreDrill } from './api'

// S-30 Backups (FMS-144, docs/backups.md): point-in-time recovery (FMS-108), then every scheduled copy, Back up now,
// and a download. Admin only.

export { ago, formatBytes } from './parts'

const STATUS: Record<BackupStatus, { label: string; tone: BadgeTone }> = {
  queued: { label: 'Queued', tone: 'info' },
  running: { label: 'Running', tone: 'info' },
  succeeded: { label: 'Succeeded', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  expired: { label: 'Expired', tone: 'neutral' },
}

function DrillFact({ drill }: { drill: RestoreDrill | null }) {
  if (!drill) {
    return (
      <Fact icon={<FlaskConical />} label="Last restore drill" tone="warning">
        <p className="font-medium">None yet</p>
        <p className="mt-0.5 text-xs text-ink-muted">A backup is proven only once it restores. The steps are in docs/backups.md.</p>
      </Fact>
    )
  }
  return (
    <Fact icon={<FlaskConical />} label="Last restore drill" tone={drill.status === 'failed' ? 'danger' : 'neutral'}>
      <p className="font-medium">
        {drill.status === 'succeeded' ? 'Restored' : 'Failed'} · {ago(drill.finished_at)}
      </p>
      <p className="mt-0.5 text-xs text-ink-muted [overflow-wrap:anywhere]">
        {drill.status === 'succeeded' ? `${drill.tables_restored ?? 0} tables into ${drill.target_database}` : (drill.error ?? 'The restore did not finish.')}
      </p>
    </Fact>
  )
}

export function BackupsPage() {
  const { hasPermission } = useAuth()
  const { toast } = useToast()
  const [page, setPage] = useState(1)
  const [confirming, setConfirming] = useState(false)
  const backups = useBackups(page)
  const start = useStartBackup()
  const link = useDownloadLink()
  const canWrite = hasPermission('backup:write')
  const meta = backups.data?.meta
  const rows = backups.data?.items
  const busy = rows?.some((b) => b.status === 'queued' || b.status === 'running') ?? false
  const unavailable = meta?.available === false

  async function backUpNow() {
    try {
      await start.mutateAsync()
      setConfirming(false)
      toast({ title: 'Backup started', description: 'It runs in the background. The list shows when it is done.' })
    } catch {
      // Shown in the dialog.
    }
  }

  async function download(b: Backup) {
    try {
      const { url, filename } = await link.mutateAsync(b.id)
      startDownload(url, filename)
    } catch (err) {
      toast({ title: 'The download did not start', description: errorDetails(err).message, tone: 'danger' })
    }
  }

  const columns: Column<Backup>[] = [
    {
      key: 'when',
      header: 'Taken',
      width: 'w-[11rem]',
      cell: (b) => (
        <div className="min-w-0">
          <p className="tabular truncate text-sm font-medium text-ink">{at(b.started_at ?? b.requested_at)}</p>
          <p className="truncate text-xs text-ink-muted">{b.kind === 'scheduled' ? 'Scheduled' : 'Back up now'}</p>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: 'w-[16rem]',
      cell: (b) => (
        <div className="min-w-0">
          <Badge tone={STATUS[b.status].tone} icon={b.status === 'running' ? <Spinner className="h-3 w-3" /> : undefined}>
            {STATUS[b.status].label}
          </Badge>
          {b.status === 'failed' && b.error && (
            <p className="mt-1 truncate text-xs text-danger" title={b.error}>
              {b.error}
            </p>
          )}
          {b.status === 'succeeded' && b.expires_at && <p className="mt-1 truncate text-xs text-ink-muted">Kept until {at(b.expires_at)}</p>}
        </div>
      ),
    },
    {
      key: 'size',
      header: 'Size',
      width: 'w-[7rem]',
      align: 'right',
      hideBelow: 'sm',
      cell: (b) => <span className="tabular text-sm text-ink">{b.size_bytes === null ? '—' : formatBytes(b.size_bytes)}</span>,
    },
    {
      key: 'by',
      header: 'Started by',
      hideBelow: 'md',
      cell: (b) => <span className="block truncate text-sm text-ink">{b.requested_by?.name ?? (b.kind === 'scheduled' ? 'Schedule' : 'Unknown user')}</span>,
    },
    {
      key: 'checksum',
      header: 'SHA-256',
      hideBelow: 'lg',
      width: 'w-[9rem]',
      cell: (b) =>
        b.checksum_sha256 ? (
          <code className="block truncate font-mono text-xs text-ink-muted" title={b.checksum_sha256}>
            {b.checksum_sha256.slice(0, 12)}…
          </code>
        ) : (
          <span className="text-ink-subtle">—</span>
        ),
    },
    {
      key: 'download',
      header: <span className="sr-only">Download</span>,
      label: 'Download',
      width: 'w-[8.5rem]',
      align: 'right',
      cell: (b) =>
        b.downloadable ? (
          <Button size="sm" variant="secondary" onClick={() => void download(b)} disabled={link.isPending && link.variables === b.id} aria-label={`Download the backup of ${at(b.started_at ?? b.requested_at)}`}>
            <Download className="h-4 w-4" aria-hidden="true" />
            <span className="hidden sm:inline">Download</span>
          </Button>
        ) : null,
    },
  ]

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line pb-5 sm:items-center">
        <div className="min-w-0 basis-72 flex-1">
          <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">Backups</h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-muted">
            The database can be restored to any second of the last 14 days or more, and a full copy is taken every 4 hours and whenever you need one. Take one before a risky
            change. Times are Addis Ababa time.
          </p>
        </div>
        {canWrite && (
          <Button onClick={() => setConfirming(true)} disabled={busy || unavailable || !meta}>
            {busy ? <Spinner className="h-4 w-4" /> : <DatabaseBackup className="h-4 w-4" aria-hidden="true" />}
            {busy ? 'Backing up…' : 'Back up now'}
          </Button>
        )}
      </header>

      <PointInTime pitr={meta?.pitr} />

      <div className="border-t border-line pt-6">
        <h2 className="text-base font-semibold text-ink">Scheduled copies</h2>
        <p className="mt-1 max-w-2xl text-sm text-ink-muted">
          A pg_dump of the whole database, restorable on any server, kept {meta?.retention_days ?? 30} days. Download one to keep a copy of your own.
        </p>
      </div>

      {unavailable && (
        <div role="alert" className="flex gap-3 rounded-card border border-warning/40 bg-warning-soft p-4 text-sm text-ink">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
          <p>
            Backups are not set up on this server: it has no database account for pg_dump. Set BACKUP_DB_USER and BACKUP_DB_PASSWORD (docs/backups.md).
          </p>
        </div>
      )}

      <section aria-label="Backup health" className="grid gap-3 sm:grid-cols-3">
        <Fact icon={<ShieldCheck />} label="Last good backup" tone={meta && !meta.last_succeeded_at ? 'warning' : 'neutral'}>
          {meta?.last_succeeded_at ? (
            <>
              <p className="font-medium">{ago(meta.last_succeeded_at)}</p>
              <p className="mt-0.5 text-xs text-ink-muted">{at(meta.last_succeeded_at)}</p>
            </>
          ) : (
            <p className="font-medium">{meta ? 'None yet' : '…'}</p>
          )}
        </Fact>
        <Fact icon={<CalendarClock />} label="Schedule">
          <p className="font-medium">Every 4 hours, from 02:40</p>
          <p className="mt-0.5 text-xs text-ink-muted">Each kept {meta?.retention_days ?? 30} days, then removed</p>
        </Fact>
        <DrillFact drill={meta?.last_restore_drill ?? null} />
      </section>

      <DataTable
        caption="Database backups, newest first"
        columns={columns}
        data={rows}
        rowKey={(b) => b.id}
        isLoading={backups.isPending}
        error={backups.error}
        onRetry={() => void backups.refetch()}
        rowHeight="stacked"
        emptyState={
          <EmptyState
            icon={<HardDriveDownload />}
            heading="No backups yet"
            description={canWrite ? 'The first one is taken at the next 4-hourly time (02:40, 06:40, 10:40, 14:40, 18:40, 22:40), or now with Back up now.' : 'The first one is taken at the next 4-hourly time (02:40, 06:40, 10:40, 14:40, 18:40, 22:40).'}
            headingLevel="h2"
          />
        }
        pagination={meta ? { page, pageSize: BACKUPS_PAGE_SIZE, totalItems: meta.total_items, onPageChange: setPage } : undefined}
      />

      <p className="text-xs text-ink-muted">
        Restoring is not a button: it replaces the live data. An administrator restores a backup into a new database with <code className="font-mono">npm run backup:restore</code>, then
        switches the app to it (docs/backups.md).
      </p>

      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Back up the database now?"
        message="A full copy of the database is taken in the background. FMS keeps working while it runs; it usually takes a minute or two."
        action="Back up now"
        tone="default"
        busy={start.isPending}
        error={start.isError ? errorDetails(start.error).message : undefined}
        onConfirm={backUpNow}
      />
    </div>
  )
}

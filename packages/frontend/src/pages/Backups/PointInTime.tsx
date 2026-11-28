import { AlertTriangle, Archive, CheckCircle2, Cloud, FlaskConical, History, Server, ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import { DataTable, EmptyState, type Column } from '@/components/shared'
import { Badge, Skeleton, Spinner, type BadgeTone } from '@/components/ui'
import { BASE_BACKUPS_PAGE_SIZE, useBaseBackups, type BackupFinding, type BaseBackup, type PitrDrill, type PitrOverview, type PitrRepository } from './api'
import { Fact, ago, at, atSecond, formatBytes, seconds } from './parts'

// S-30 Backups, point-in-time recovery (FMS-108, docs/backups.md): how far back and how recently the database can be
// restored, what puts that at risk now, archiving, the copies, the last drill, and the base backups.

const BASE_STATUS: Record<BaseBackup['status'], { label: string; tone: BadgeTone }> = {
  running: { label: 'Running', tone: 'info' },
  succeeded: { label: 'Succeeded', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  expired: { label: 'Expired', tone: 'neutral' },
}

function baseKind(b: BaseBackup): string {
  if (b.triggered_by === 'first-start') return 'First full backup'
  if (b.type === 'full') return b.triggered_by === 'schedule' ? 'Weekly full' : 'Full, by hand'
  if (b.type === 'diff') return b.triggered_by === 'schedule' ? 'Nightly differential' : 'Differential, by hand'
  return 'Incremental'
}

/** Protected, at risk, or not set up: the section's one-word answer. */
function verdict(pitr: PitrOverview): { label: string; tone: BadgeTone } {
  if (!pitr.enabled) return { label: 'Not set up', tone: 'neutral' }
  if (pitr.findings.some((f) => f.severity === 'critical')) return { label: 'At risk', tone: 'danger' }
  if (pitr.findings.length > 0 || !pitr.recoverable_to) return { label: 'Needs attention', tone: 'warning' }
  return { label: 'Protected', tone: 'success' }
}

function Range({ pitr }: { pitr: PitrOverview }) {
  if (!pitr.enabled) {
    return (
      <p className="text-sm text-ink-muted">
        This database does not archive its changes, so it can only be restored to a scheduled copy below (one every 4 hours). Point-in-time recovery is set up in docs/backups.md.
      </p>
    )
  }
  if (!pitr.recoverable_from || !pitr.recoverable_to) {
    return <p className="text-sm text-ink-muted">Not yet: the first base backup is still being taken. Every change is archived meanwhile.</p>
  }
  return (
    <>
      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-lg font-semibold tracking-tight text-ink sm:text-xl">
        <span className="tabular">{atSecond(pitr.recoverable_from)}</span>
        <span aria-hidden="true" className="text-ink-subtle">
          →
        </span>
        <span className="sr-only">to</span>
        <span className="tabular">{atSecond(pitr.recoverable_to)}</span>
      </p>
      <p className="mt-1 text-sm text-ink-muted">
        Any second in between. The latest change kept off this server’s disk was archived {ago(pitr.recoverable_to)}.
      </p>
    </>
  )
}

function Findings({ findings }: { findings: BackupFinding[] }) {
  if (findings.length === 0) return null
  return (
    <ul aria-label="What puts recovery at risk" className="space-y-2">
      {findings.map((f) => {
        const critical = f.severity === 'critical'
        return (
          <li
            key={`${f.condition}:${f.repo ?? ''}`}
            className={`flex gap-3 rounded-card border p-3 text-sm text-ink ${critical ? 'border-danger/40 bg-danger-soft' : 'border-warning/40 bg-warning-soft'}`}
          >
            {critical ? (
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
            ) : (
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
            )}
            <div className="min-w-0">
              <p>
                <span className="sr-only">{critical ? 'Critical: ' : 'Warning: '}</span>
                {f.message}
              </p>
              <p className="mt-0.5 text-xs text-ink-muted">Since {at(f.since)}. Administrators are alerted{critical ? ' by email, SMS and push' : ' by push'}.</p>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

function ArchivingFact({ pitr }: { pitr: PitrOverview }) {
  const { archiving } = pitr
  if (archiving.failing_since) {
    return (
      <Fact icon={<Archive />} label="Archiving" tone="danger">
        <p className="font-medium">Failing since {at(archiving.failing_since)}</p>
        <p className="mt-0.5 text-xs text-ink-muted">Changes since then are only on the database server’s disk.</p>
      </Fact>
    )
  }
  return (
    <Fact icon={<Archive />} label="Archiving" tone={archiving.last_archived_at ? 'success' : 'neutral'}>
      <p className="font-medium">Every change, within a minute</p>
      <p className="mt-0.5 text-xs text-ink-muted">{archiving.last_archived_at ? `Last archived ${ago(archiving.last_archived_at)}` : 'Nothing archived yet'}</p>
    </Fact>
  )
}

function RepositoryLine({ repo }: { repo: PitrRepository }) {
  const Icon = repo.location === 'local' ? Server : Cloud
  const name = repo.location === 'local' ? 'Beside the database' : 'Off site'
  return (
    <li className="flex min-w-0 items-start gap-2">
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${repo.status === 'ok' ? 'text-success' : 'text-danger'}`} aria-hidden="true" />
      <div className="min-w-0">
        <p className="font-medium">
          {name}
          <span className="sr-only">{repo.status === 'ok' ? ', reachable' : ', unreachable'}</span>
        </p>
        <p className="truncate text-xs text-ink-muted" title={repo.message ?? undefined}>
          {repo.status === 'ok'
            ? `${repo.base_backups} base backup${repo.base_backups === 1 ? '' : 's'}${repo.encrypted ? ', encrypted' : ''}`
            : (repo.message ?? 'Unreachable')}
        </p>
      </div>
    </li>
  )
}

function CopiesFact({ repositories }: { repositories: PitrRepository[] }) {
  const offsite = repositories.some((r) => r.location === 'offsite')
  const broken = repositories.some((r) => r.status === 'error')
  return (
    <Fact icon={<History />} label="Copies" tone={broken ? 'danger' : offsite ? 'success' : 'warning'}>
      {repositories.length === 0 ? (
        <p className="font-medium">Not reported yet</p>
      ) : (
        <ul className="space-y-2">
          {repositories.map((r) => (
            <RepositoryLine key={r.repo} repo={r} />
          ))}
          {!offsite && (
            <li className="text-xs text-ink-muted">No off-site copy: losing this site would lose the backups too (docs/backups.md).</li>
          )}
        </ul>
      )}
    </Fact>
  )
}

function DrillFact({ drill }: { drill: PitrDrill | null }) {
  if (!drill) {
    return (
      <Fact icon={<FlaskConical />} label="Last restore drill" tone="warning">
        <p className="font-medium">None yet</p>
        <p className="mt-0.5 text-xs text-ink-muted">The first runs after a night’s base backup, then monthly.</p>
      </Fact>
    )
  }
  const checks = drill.checks ?? []
  const matched = checks.filter((c) => c.match).length
  return (
    <Fact icon={<FlaskConical />} label="Last restore drill" tone={drill.status === 'failed' ? 'danger' : 'success'}>
      <p className="font-medium">
        {drill.status === 'succeeded' ? 'Passed' : 'Failed'} · {ago(drill.finished_at)}
      </p>
      <p className="mt-0.5 text-xs text-ink-muted [overflow-wrap:anywhere]">
        {drill.status === 'succeeded'
          ? `Opened in ${seconds(drill.rto_seconds ?? 0)}, ${matched} of ${checks.length} key tables identical`
          : (drill.error ?? 'The restore did not finish.')}
      </p>
    </Fact>
  )
}

export function PointInTime({ pitr }: { pitr: PitrOverview | undefined }) {
  const [page, setPage] = useState(1)
  const base = useBaseBackups(page)
  const v = pitr && verdict(pitr)

  const columns: Column<BaseBackup>[] = [
    {
      key: 'when',
      header: 'Taken',
      width: 'w-[12rem]',
      cell: (b) => (
        <div className="min-w-0">
          <p className="tabular truncate text-sm font-medium text-ink">{at(b.started_at)}</p>
          <p className="truncate text-xs text-ink-muted">
            {baseKind(b)}
            {b.location === 'offsite' ? ' · off site' : ''}
          </p>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: 'w-[14rem]',
      cell: (b) => (
        <div className="min-w-0">
          <Badge tone={BASE_STATUS[b.status].tone} icon={b.status === 'running' ? <Spinner className="h-3 w-3" /> : undefined}>
            {BASE_STATUS[b.status].label}
          </Badge>
          {b.status === 'failed' && b.error && (
            <p className="mt-1 truncate text-xs text-danger" title={b.error}>
              {b.error}
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'size',
      header: 'Database',
      width: 'w-[7rem]',
      align: 'right',
      hideBelow: 'sm',
      cell: (b) => <span className="tabular text-sm text-ink">{b.size_bytes === null ? '—' : formatBytes(b.size_bytes)}</span>,
    },
    {
      key: 'repo',
      header: 'Stored',
      width: 'w-[7rem]',
      align: 'right',
      hideBelow: 'md',
      cell: (b) => <span className="tabular text-sm text-ink-muted">{b.repo_size_bytes === null ? '—' : formatBytes(b.repo_size_bytes)}</span>,
    },
    {
      key: 'label',
      header: 'Label',
      hideBelow: 'lg',
      cell: (b) => (b.label ? <code className="block truncate font-mono text-xs text-ink-muted">{b.label}</code> : <span className="text-ink-subtle">—</span>),
    },
  ]

  return (
    <section aria-labelledby="pitr-heading" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="pitr-heading" className="text-base font-semibold text-ink">
          Point-in-time recovery
        </h2>
        {v && (
          <Badge tone={v.tone} icon={v.tone === 'success' ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> : undefined}>
            {v.label}
          </Badge>
        )}
      </div>

      <div className="rounded-card border border-line bg-surface p-5 shadow-soft">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Recoverable to any second</p>
        <div className="mt-2">{pitr ? <Range pitr={pitr} /> : <Skeleton className="h-7 w-72 max-w-full" />}</div>
      </div>

      {pitr && <Findings findings={pitr.findings} />}

      {pitr?.enabled && (
        <div className="grid gap-3 sm:grid-cols-3">
          <ArchivingFact pitr={pitr} />
          <CopiesFact repositories={pitr.repositories} />
          <DrillFact drill={pitr.last_drill} />
        </div>
      )}

      {pitr?.enabled !== false && (
        <DataTable
          caption="Base backups, newest first"
          columns={columns}
          data={base.data?.items}
          rowKey={(b) => b.id}
          isLoading={base.isPending}
          error={base.error}
          onRetry={() => void base.refetch()}
          rowHeight="stacked"
          emptyState={
            <EmptyState
              icon={<Archive />}
              heading="No base backups yet"
              description="The first full one is taken when the database first starts; then a full one every Sunday and a differential one every other night at 01:00."
              headingLevel="h3"
            />
          }
          pagination={base.data ? { page, pageSize: BASE_BACKUPS_PAGE_SIZE, totalItems: base.data.meta.total_items, onPageChange: setPage } : undefined}
        />
      )}
    </section>
  )
}

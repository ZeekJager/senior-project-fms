import { CircleCheck, CircleSlash, Clock, HeartPulse, OctagonAlert, ServerCrash } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { DataTable, EmptyState, ErrorState, type Column } from '@/components/shared'
import { Badge, Card, cn, Skeleton, ViewTabs, type BadgeTone } from '@/components/ui'
import { WINDOWS, useSystemHealth, useSystemHealthHistory, type ComponentHealth, type ComponentStatus, type FailedJobRun, type HealthWindow, type Outage, type SystemHealthHistory, type TimelineCell } from './api'
import { ErrorRateChart, LatencyChart } from './charts'
import { cellRange, clock, duration, milliseconds, percentText, when } from './describe'

// S-31 System health (FMS-143, docs/system-health.md): how FMS itself is doing. Each component checked every
// minute, its uptime over 24 hours, 7 days and 30 days, the outages, the failed scheduled jobs, and the API's
// error rate and latency. Admin only (system:read).

const STATUS: Record<ComponentStatus, { label: string; tone: BadgeTone }> = {
  ok: { label: 'Up', tone: 'success' },
  down: { label: 'Down', tone: 'danger' },
  disabled: { label: 'Not configured', tone: 'neutral' },
  no_data: { label: 'No data', tone: 'neutral' },
}

const KIND_NOTE: Record<ComponentHealth['kind'], string> = {
  api: 'Answers HTTP',
  database: 'PostgreSQL primary',
  replica: 'Reporting reads',
  redis: 'Cache and locks',
  ai_service: 'Maintenance predictions',
  provider: 'Provider circuit',
}

function Panel({ title, description, aside, children, className }: { title: string; description?: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Card className={cn('min-w-0 p-4 sm:p-5', className)}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-ink-subtle">{description}</p>}
        </div>
        {aside}
      </div>
      {children}
    </Card>
  )
}

/** All up, some down, or nothing sampled yet: the first thing an admin reads. */
function Overall({ components, sampledFrom }: { components: ComponentHealth[]; sampledFrom: string | null }) {
  const down = components.filter((c) => c.status === 'down')
  if (!sampledFrom) {
    return (
      <div role="status" className="flex gap-3 rounded-card border border-line bg-surface p-4 text-sm text-ink shadow-soft">
        <Clock className="mt-0.5 h-5 w-5 shrink-0 text-ink-subtle" aria-hidden="true" />
        <div>
          <p className="font-semibold">No samples yet</p>
          <p className="mt-0.5 text-ink-muted">The server checks every component once a minute; the first figures appear within a minute or two of it starting.</p>
        </div>
      </div>
    )
  }
  if (down.length > 0) {
    return (
      <div role="alert" className="flex gap-3 rounded-card border border-danger/40 bg-danger-soft p-4 text-sm text-ink">
        <OctagonAlert className="mt-0.5 h-5 w-5 shrink-0 text-danger" aria-hidden="true" />
        <div className="min-w-0">
          <p className="font-semibold">{down.length === 1 ? `${down[0].label} is down` : `${down.length} components are down: ${down.map((c) => c.label).join(', ')}`}</p>
          <ul className="mt-1 space-y-0.5 text-ink-muted">
            {down.map((c) => (
              <li key={c.component} className="[overflow-wrap:anywhere]">
                {c.label}: {c.error ?? 'the check failed'}
              </li>
            ))}
          </ul>
        </div>
      </div>
    )
  }
  const checked = components.filter((c) => c.status === 'ok').length
  return (
    <div role="status" className="flex gap-3 rounded-card border border-success/40 bg-success-soft p-4 text-sm text-ink">
      <CircleCheck className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden="true" />
      <div>
        <p className="font-semibold">All systems working</p>
        <p className="mt-0.5 text-ink-muted">
          {checked} components up at the last check. Sampled since {when(sampledFrom)}.
        </p>
      </div>
    </div>
  )
}

/** The period's request figures and how many outages began or went on in it. */
function KpiStrip({ history, outages }: { history: SystemHealthHistory | undefined; outages: Outage[] | undefined }) {
  const r = history?.requests
  const figures = [
    { label: 'Requests', value: r && r.requests.toLocaleString(), note: 'Answered by the API (health checks left out)' },
    { label: 'Error rate', value: r && percentText(r.error_rate_pct), note: r && `${r.errors_5xx.toLocaleString()} answered with a 5xx` },
    { label: 'p95 latency', value: r && milliseconds(r.p95_ms), note: '95 of 100 requests answered within' },
    { label: 'Outages', value: outages?.length.toLocaleString(), note: outages && (outages.some((o) => o.ended_at === null) ? 'One is going on now' : 'Runs of down minutes') },
  ]
  return (
    <dl className="stat-strip" aria-busy={!r || undefined}>
      {figures.map((f) => (
        <div key={f.label} className="flex flex-col p-4 sm:p-5">
          <dt className="text-[13px] font-medium leading-tight text-ink-muted">{f.label}</dt>
          <dd className="tabular mt-2 text-xl font-semibold tracking-tight text-ink sm:text-2xl">{f.value ?? <Skeleton className="h-8 w-24" />}</dd>
          <dd className="mt-1.5 text-xs text-ink-subtle">{f.note ?? <Skeleton className="h-3 w-32" />}</dd>
        </div>
      ))}
    </dl>
  )
}

/** A cell's colour: up, partly down (under half its sampled minutes), down, not configured, or no data. */
function cellTone(c: TimelineCell): { className: string; word: string } {
  const sampled = c.ok_minutes + c.down_minutes
  if (c.down_minutes > 0 && c.down_minutes * 2 >= sampled) return { className: 'bg-danger', word: `down ${duration(c.down_minutes)}` }
  if (c.down_minutes > 0) return { className: 'bg-warning', word: `down ${duration(c.down_minutes)}` }
  if (c.ok_minutes > 0) return { className: 'bg-success/80', word: 'up' }
  if (c.disabled_minutes > 0) return { className: 'bg-surface-sunken ring-1 ring-inset ring-line', word: 'not configured' }
  return { className: 'bg-line', word: 'no data' }
}

const STRIP_LEGEND = [
  { className: 'bg-success/80', label: 'Up' },
  { className: 'bg-warning', label: 'Partly down' },
  { className: 'bg-danger', label: 'Down' },
  { className: 'bg-line', label: 'No data' },
]

/** The component's minutes across the period, one cell per period, oldest on the left. */
function StatusStrip({ label, cells, bucketMinutes, uptime }: { label: string; cells: TimelineCell[]; bucketMinutes: number; uptime: string }) {
  const down = cells.reduce((s, c) => s + c.down_minutes, 0)
  return (
    <div
      role="img"
      aria-label={`${label}: ${down > 0 ? `down ${duration(down)}` : 'no downtime'} in the period, ${uptime} up`}
      className="flex h-6 w-full items-stretch gap-px overflow-hidden rounded-[3px]"
    >
      {cells.map((c) => {
        const tone = cellTone(c)
        return <span key={c.start} className={cn('min-w-0 flex-1', tone.className)} title={`${cellRange(c.start, bucketMinutes)}: ${tone.word}`} />
      })}
    </div>
  )
}

function Components({
  components,
  history,
  period,
}: {
  components: ComponentHealth[]
  history: SystemHealthHistory | undefined
  period: HealthWindow
}) {
  const cellsOf = useMemo(() => new Map(history?.components.map((c) => [c.component, c.cells])), [history])
  const periodLabel = WINDOWS.find((w) => w.value === period)!.label
  return (
    <Panel
      title="Components"
      description={`Checked every minute. The strip shows the last ${periodLabel}; uptime counts only the minutes that were sampled.`}
      aside={
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-muted" aria-label="Legend">
          {STRIP_LEGEND.map((l) => (
            <li key={l.label} className="flex items-center gap-1.5">
              <span className={cn('h-2.5 w-2.5 rounded-sm', l.className)} aria-hidden="true" />
              {l.label}
            </li>
          ))}
        </ul>
      }
    >
      <ul className="divide-y divide-line" aria-label="Components">
        {components.map((c) => {
          const cells = cellsOf.get(c.component)
          const s = STATUS[c.status]
          return (
            <li key={c.component} className="grid gap-x-6 gap-y-3 py-4 first:pt-0 last:pb-0 lg:grid-cols-[minmax(12rem,16rem)_minmax(0,1fr)_auto] lg:items-center">
              <div className="flex min-w-0 items-start justify-between gap-3 lg:block">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink">{c.label}</p>
                  <p className="truncate text-xs text-ink-subtle">{KIND_NOTE[c.kind]}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2 lg:mt-1.5">
                  <Badge tone={s.tone} dot>
                    {s.label}
                  </Badge>
                  {c.status === 'ok' && c.latency_ms !== null && <span className="tabular text-xs text-ink-muted">{milliseconds(c.latency_ms)}</span>}
                </div>
                {c.status === 'down' && c.error && <p className="mt-1 hidden text-xs text-danger [overflow-wrap:anywhere] lg:block">{c.error}</p>}
              </div>
              {c.status === 'down' && c.error && <p className="-mt-2 text-xs text-danger [overflow-wrap:anywhere] lg:hidden">{c.error}</p>}
              <div className="min-w-0">
                {c.status === 'disabled' && c.uptime[period].ok_minutes + c.uptime[period].down_minutes === 0 ? (
                  <p className="flex items-center gap-1.5 text-xs text-ink-muted">
                    <CircleSlash className="h-3.5 w-3.5" aria-hidden="true" />
                    Not set up on this server
                  </p>
                ) : cells && history ? (
                  <StatusStrip label={c.label} cells={cells} bucketMinutes={history.bucket_minutes} uptime={percentText(c.uptime[period].uptime_pct)} />
                ) : (
                  <Skeleton className="h-6 w-full" />
                )}
              </div>
              <dl className="grid grid-cols-3 gap-4 text-right lg:w-64">
                {WINDOWS.map((w) => {
                  const u = c.uptime[w.value]
                  return (
                    <div key={w.value} className={cn(w.value === period ? 'text-ink' : 'text-ink-muted')}>
                      <dt className="text-[11px] font-medium uppercase tracking-wide text-ink-subtle">{w.label}</dt>
                      <dd className={cn('tabular text-sm', w.value === period && 'font-semibold', u.down_minutes > 0 && u.uptime_pct !== null && u.uptime_pct < 99 && 'text-danger')}>
                        {percentText(u.uptime_pct)}
                      </dd>
                    </div>
                  )
                })}
              </dl>
            </li>
          )
        })}
      </ul>
    </Panel>
  )
}

/** Outages and failed jobs that reach into the period. */
const inWindow = (endIso: string | null, windowEnd: string, minutes: number) => endIso === null || Date.parse(endIso) > Date.parse(windowEnd) - minutes * 60_000

export function SystemHealthPage() {
  const [period, setPeriod] = useState<HealthWindow>('24h')
  const summary = useSystemHealth()
  const history = useSystemHealthHistory(period)
  const data = summary.data
  const minutes = WINDOWS.find((w) => w.value === period)!.minutes
  const periodLabel = WINDOWS.find((w) => w.value === period)!.label

  const outages = useMemo(() => data?.outages.filter((o) => inWindow(o.ended_at, data.window_end, minutes)), [data, minutes])
  const failedJobs = useMemo(() => data?.failed_jobs.filter((j) => inWindow(j.failed_at, data.window_end, minutes)), [data, minutes])

  const outageColumns: Column<Outage>[] = [
    {
      key: 'component',
      header: 'Component',
      width: 'w-[11rem]',
      cell: (o) => <span className="block truncate text-sm font-medium text-ink">{o.label}</span>,
    },
    {
      key: 'started',
      header: 'Started',
      width: 'w-[9rem]',
      cell: (o) => <span className="tabular text-sm text-ink">{when(o.started_at)}</span>,
    },
    {
      key: 'ended',
      header: 'Ended',
      width: 'w-[9rem]',
      hideBelow: 'sm',
      cell: (o) => (o.ended_at ? <span className="tabular text-sm text-ink">{clock(o.ended_at)}</span> : <Badge tone="danger">Going on</Badge>),
    },
    {
      key: 'duration',
      header: 'Lasted',
      width: 'w-[7rem]',
      align: 'right',
      cell: (o) => <span className="tabular text-sm text-ink">{duration(o.duration_minutes)}</span>,
    },
    {
      key: 'error',
      header: 'Error',
      hideBelow: 'md',
      cell: (o) => (
        <span className="block truncate text-sm text-ink-muted" title={o.error ?? undefined}>
          {o.error ?? '—'}
        </span>
      ),
    },
  ]

  const jobColumns: Column<FailedJobRun>[] = [
    {
      key: 'job',
      header: 'Job',
      width: 'w-[13rem]',
      cell: (j) => (
        <div className="min-w-0">
          <p className="truncate font-mono text-[13px] text-ink">{j.job}</p>
          <p className="truncate text-xs text-ink-subtle">Run {j.run_key}</p>
        </div>
      ),
    },
    {
      key: 'failed',
      header: 'Failed',
      width: 'w-[9rem]',
      cell: (j) => <span className="tabular text-sm text-ink">{when(j.failed_at)}</span>,
    },
    {
      key: 'attempts',
      header: 'Attempts',
      width: 'w-[6rem]',
      align: 'right',
      hideBelow: 'sm',
      cell: (j) => <span className="tabular text-sm text-ink">{j.attempts}</span>,
    },
    {
      key: 'error',
      header: 'Error',
      cell: (j) => (
        <span className="block truncate text-sm text-danger" title={j.error ?? undefined}>
          {j.error ?? 'No error recorded'}
        </span>
      ),
    },
  ]

  if (summary.isError && !data) {
    return (
      <div className="space-y-6">
        <Header period={period} onPeriod={setPeriod} checkedAt={undefined} />
        <ErrorState error={summary.error} heading="System health could not be loaded" onRetry={() => void summary.refetch()} />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <Header period={period} onPeriod={setPeriod} checkedAt={data?.generated_at} />

      {data ? <Overall components={data.components} sampledFrom={data.sampled_from} /> : <Skeleton className="h-[4.5rem] w-full" />}

      <KpiStrip history={history.data} outages={outages} />

      {data ? (
        <Components components={data.components} history={history.data} period={period} />
      ) : (
        <Panel title="Components">
          <Skeleton className="h-64 w-full" />
        </Panel>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="Error rate" description="Share of requests answered with a 5xx">
          {history.data ? <ErrorRateChart cells={history.data.requests.cells} bucketMinutes={history.data.bucket_minutes} /> : history.isError ? <ChartError onRetry={() => void history.refetch()} /> : <Skeleton className="h-56 w-full" />}
        </Panel>
        <Panel title="p95 latency" description="Time to answer 95 of 100 requests">
          {history.data ? <LatencyChart cells={history.data.requests.cells} bucketMinutes={history.data.bucket_minutes} /> : history.isError ? <ChartError onRetry={() => void history.refetch()} /> : <Skeleton className="h-56 w-full" />}
        </Panel>
      </div>

      <section aria-labelledby="outages-heading" className="space-y-3">
        <h2 id="outages-heading" className="text-sm font-semibold text-ink">
          Outages <span className="font-normal text-ink-subtle">· last {periodLabel}</span>
        </h2>
        <DataTable
          caption={`Outages in the last ${periodLabel}, newest first`}
          columns={outageColumns}
          data={outages}
          rowKey={(o) => `${o.component}-${o.started_at}`}
          isLoading={!data}
          emptyState={<EmptyState icon={<CircleCheck />} heading="No outages" description={`Every component that was sampled stayed up in the last ${periodLabel}.`} headingLevel="h3" />}
        />
      </section>

      <section aria-labelledby="jobs-heading" className="space-y-3">
        <h2 id="jobs-heading" className="text-sm font-semibold text-ink">
          Failed scheduled jobs <span className="font-normal text-ink-subtle">· last {periodLabel}</span>
        </h2>
        <DataTable
          caption={`Scheduled job runs that failed in the last ${periodLabel}, newest first`}
          columns={jobColumns}
          data={failedJobs}
          rowKey={(j) => `${j.job}-${j.run_key}`}
          isLoading={!data}
          rowHeight="stacked"
          emptyState={<EmptyState icon={<CircleCheck />} heading="No failed jobs" description={`Every scheduled job that ran in the last ${periodLabel} succeeded. A daily job that fails is retried; the scheduled jobs and their runs are in the audit log.`} headingLevel="h3" />}
        />
      </section>
    </div>
  )
}

function Header({ period, onPeriod, checkedAt }: { period: HealthWindow; onPeriod: (w: HealthWindow) => void; checkedAt: string | undefined }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
      <div className="min-w-0 basis-72 flex-1">
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight text-ink sm:text-2xl">
          <HeartPulse className="h-6 w-6 text-brand-ink" aria-hidden="true" />
          System health
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-muted">
          How FMS itself is doing: every part checked once a minute, when anything was down and why, failed jobs and request errors. Times are Addis Ababa time
          {checkedAt ? `; updated ${clock(checkedAt)}, every minute` : ''}.
        </p>
      </div>
      <ViewTabs label="Period" value={period} options={WINDOWS.map((w) => ({ value: w.value, label: w.label }))} onChange={onPeriod} />
    </header>
  )
}

function ChartError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex h-56 flex-col items-center justify-center gap-2 text-center text-sm text-ink-muted">
      <ServerCrash className="h-6 w-6 text-ink-subtle" aria-hidden="true" />
      <p>The history could not be loaded.</p>
      <button type="button" onClick={onRetry} className="text-sm font-medium text-brand-ink underline-offset-2 hover:underline">
        Try again
      </button>
    </div>
  )
}

import { AlertTriangle, CircleCheck, CircleHelp, Database, FileDown, Gauge, OctagonAlert, Plus, Server, ServerCog, Wrench } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { EmptyState } from '@/components/shared'
import { Badge, Button, Card, Skeleton, TextField, ViewTabs, cn, useToast, type BadgeTone } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import {
  RESOURCE_RANGES,
  useCancelMaintenanceWindow,
  useCreateMaintenanceWindow,
  useDownloadCapacityReport,
  useMaintenanceWindows,
  useSystemMetrics,
  type MaintenanceWindow,
  type ResourceMetric,
  type ResourceRange,
  type ResourceStatus,
  type ResourceTile,
} from './api'

// The Resources tab of System health (FMS-163, docs/observability.md): every host and service against its thresholds,
// the application and the database, live (every 15 s) and back 12 months; maintenance windows; the capacity report.

const STATUS: Record<ResourceStatus, { label: string; tone: BadgeTone; icon: ReactNode }> = {
  ok: { label: 'OK', tone: 'success', icon: <CircleCheck className="h-3.5 w-3.5" aria-hidden="true" /> },
  warning: { label: 'Warning', tone: 'warning', icon: <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" /> },
  critical: { label: 'Critical', tone: 'danger', icon: <OctagonAlert className="h-3.5 w-3.5" aria-hidden="true" /> },
  unknown: { label: 'No data', tone: 'neutral', icon: <CircleHelp className="h-3.5 w-3.5" aria-hidden="true" /> },
}

function StatusBadge({ status }: { status: ResourceStatus }) {
  const s = STATUS[status]
  return (
    <Badge tone={s.tone}>
      <span className="inline-flex items-center gap-1">
        {s.icon}
        {s.label}
      </span>
    </Badge>
  )
}

const STROKE: Record<ResourceStatus, string> = { ok: 'stroke-success', warning: 'stroke-warning', critical: 'stroke-danger', unknown: 'stroke-ink-subtle' }

/** A metric's line over the range, scaled to its own minimum and maximum. */
function Sparkline({ metric, label }: { metric: ResourceMetric; label: string }) {
  const pts = metric.series
  if (pts.length < 2) return <div className="h-8" aria-hidden="true" />
  const xs = pts.map(([t]) => t)
  const ys = pts.map(([, v]) => v)
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)]
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)]
  const d = pts.map(([t, v]) => `${(((t - x0) / (x1 - x0 || 1)) * 100).toFixed(2)},${(30 - ((v - y0) / (y1 - y0 || 1)) * 28 - 1).toFixed(2)}`).join(' ')
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="h-8 w-full" role="img" aria-label={`${label} over the range`}>
      <polyline points={d} fill="none" strokeWidth={1.5} vectorEffect="non-scaling-stroke" className={STROKE[metric.status]} />
    </svg>
  )
}

const pct = (v: number | null) => (v === null ? '—' : `${v.toLocaleString('en-US', { maximumFractionDigits: 1 })}%`)
const num = (v: number | null, unit = '') => (v === null ? '—' : `${v.toLocaleString('en-US', { maximumFractionDigits: 1 })}${unit}`)
function bytesPerSecond(v: number | null): string {
  if (v === null) return '—'
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)} MB/s`
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)} kB/s`
  return `${Math.round(v)} B/s`
}
const ago = (iso: string | null, now: number) => (iso ? `${Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))} s ago` : 'no sample')

function MetricRow({ label, metric, format }: { label: string; metric: ResourceMetric; format: (v: number | null) => string }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-ink-muted">{label}</span>
        <span className="flex items-center gap-1.5">
          <span className="tabular text-sm font-medium text-ink">{format(metric.value)}</span>
          {metric.status !== 'ok' && metric.status !== 'unknown' && <span className="sr-only">{STATUS[metric.status].label}</span>}
        </span>
      </div>
      <Sparkline metric={metric} label={label} />
    </div>
  )
}

function Tile({ tile, kind, now }: { tile: ResourceTile; kind: 'host' | 'service'; now: number }) {
  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 truncate text-sm font-semibold text-ink">
            {kind === 'host' ? <Server className="h-4 w-4 text-ink-subtle" aria-hidden="true" /> : <ServerCog className="h-4 w-4 text-ink-subtle" aria-hidden="true" />}
            {tile.name}
          </p>
          <p className="text-xs text-ink-subtle">Updated {ago(tile.cpu.sampled_at, now)}</p>
        </div>
        <StatusBadge status={tile.status} />
      </div>
      <MetricRow label={kind === 'host' ? 'CPU' : 'CPU (of a core)'} metric={tile.cpu} format={pct} />
      <MetricRow label={kind === 'host' ? 'Memory' : 'Memory (of the host)'} metric={tile.memory} format={pct} />
      {tile.disk && <MetricRow label="Disk" metric={tile.disk} format={pct} />}
      <div className="grid grid-cols-2 gap-3">
        <MetricRow label="Network in" metric={tile.network_in} format={bytesPerSecond} />
        <MetricRow label="Network out" metric={tile.network_out} format={bytesPerSecond} />
      </div>
    </Card>
  )
}

function Figure({ label, metric, format, hint }: { label: string; metric: ResourceMetric; format: (v: number | null) => string; hint?: string }) {
  return (
    <div className="space-y-1 rounded-control border border-line bg-surface p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-ink-muted">{label}</span>
        {metric.status !== 'ok' && <StatusBadge status={metric.status} />}
      </div>
      <p className="tabular text-lg font-semibold text-ink">{format(metric.value)}</p>
      {hint && <p className="text-xs text-ink-subtle">{hint}</p>}
      <Sparkline metric={metric} label={label} />
    </div>
  )
}

/** System health's Resources tab. */
export function ResourcesTab() {
  const [range, setRange] = useState<ResourceRange>('1h')
  const metrics = useSystemMetrics(range)
  const { hasPermission } = useAuth()
  const download = useDownloadCapacityReport()
  const data = metrics.data
  const now = data ? new Date(data.generated_at).getTime() : Date.now()

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ViewTabs label="Range" value={range} options={RESOURCE_RANGES.map((r) => ({ value: r.value, label: r.label }))} onChange={setRange} />
        <Button variant="secondary" size="sm" leadingIcon={<FileDown className="h-4 w-4" />} loading={download.isPending} disabled={!data?.source.configured} onClick={() => download.mutate()}>
          Capacity report (PDF)
        </Button>
      </div>

      {!data && metrics.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : !data ? (
        <EmptyState icon={<Gauge />} heading="Resources could not be loaded" description="Try again in a moment." />
      ) : !data.source.configured ? (
        <EmptyState
          icon={<Gauge />}
          heading="Monitoring is not set up"
          description="Start the observability stack (make observability) and set PROMETHEUS_URL, and every host and service appears here, live and back 12 months (docs/observability.md)."
        />
      ) : !data.source.reachable ? (
        <EmptyState icon={<AlertTriangle />} heading="The metrics store is not answering" description={data.source.error ?? 'Prometheus or VictoriaMetrics could not be reached. The tab tries again every 15 seconds.'} />
      ) : (
        <>
          <section aria-labelledby="hosts-heading" className="space-y-3">
            <h2 id="hosts-heading" className="text-sm font-semibold text-ink">
              Hosts <span className="font-normal text-ink-subtle">· warning at {data.thresholds.cpu_pct.warning}% CPU, critical at {data.thresholds.cpu_pct.critical}% (Settings, Monitoring)</span>
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {data.hosts.map((h) => (
                <Tile key={h.name} tile={h} kind="host" now={now} />
              ))}
            </div>
          </section>
          <section aria-labelledby="services-heading" className="space-y-3">
            <h2 id="services-heading" className="text-sm font-semibold text-ink">
              Services
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {data.services.map((s) => (
                <Tile key={s.name} tile={s} kind="service" now={now} />
              ))}
            </div>
          </section>
          {data.application && (
            <section aria-labelledby="app-heading" className="space-y-3">
              <h2 id="app-heading" className="text-sm font-semibold text-ink">
                Application
              </h2>
              <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
                <Figure label="Requests" metric={data.application.request_rate_per_minute} format={(v) => num(v, '/min')} />
                <Figure label="5xx" metric={data.application.error_pct} format={pct} hint={`Warning ${data.thresholds.error_pct.warning}%`} />
                <Figure label="p95 latency" metric={data.application.p95_ms} format={(v) => num(v, ' ms')} hint={`Warning ${data.thresholds.p95_ms.warning} ms`} />
                <Figure label="GPS points" metric={data.application.gps_points_per_minute} format={(v) => num(v, '/min')} />
                <Figure label="Sockets" metric={data.application.sockets} format={(v) => num(v)} />
                <Figure label="Job failures" metric={data.application.job_failures_last_hour} format={(v) => num(v)} hint="Last hour" />
              </div>
            </section>
          )}
          {data.database && (
            <section aria-labelledby="db-heading" className="space-y-3">
              <h2 id="db-heading" className="flex items-center gap-1.5 text-sm font-semibold text-ink">
                <Database className="h-4 w-4 text-ink-subtle" aria-hidden="true" />
                Database
              </h2>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <Figure label="Connections" metric={data.database.connections_pct} format={pct} hint={`Warning ${data.thresholds.db_connections_pct.warning}%`} />
                <Figure label="Transactions" metric={data.database.transactions_per_second} format={(v) => num(v, '/s')} />
                <Figure label="Cache hit" metric={data.database.cache_hit_pct} format={pct} />
                <Figure label="Replica lag" metric={data.database.replica_lag_seconds} format={(v) => num(v, ' s')} hint={`Warning ${data.thresholds.replica_lag_seconds.warning} s`} />
              </div>
              <Card className="overflow-hidden p-0">
                <table className="w-full text-sm">
                  <caption className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-ink-subtle">The 5 slowest queries, by mean time</caption>
                  <thead className="border-y border-line bg-surface-muted text-xs text-ink-muted">
                    <tr>
                      <th scope="col" className="px-4 py-2 text-left font-medium">Query</th>
                      <th scope="col" className="px-4 py-2 text-right font-medium">Mean</th>
                      <th scope="col" className="hidden px-4 py-2 text-right font-medium sm:table-cell">Calls</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.database.slowest_queries.length === 0 ? (
                      <tr>
                        <td colSpan={3} className="px-4 py-4 text-ink-muted">No statistics yet (pg_stat_statements).</td>
                      </tr>
                    ) : (
                      data.database.slowest_queries.map((q) => (
                        <tr key={q.query} className="border-b border-line last:border-0">
                          <td className="max-w-0 px-4 py-2">
                            <code className="block truncate font-mono text-xs text-ink" title={q.query}>
                              {q.query}
                            </code>
                          </td>
                          <td className="tabular px-4 py-2 text-right text-ink">{num(q.mean_ms, ' ms')}</td>
                          <td className="tabular hidden px-4 py-2 text-right text-ink-muted sm:table-cell">{q.calls.toLocaleString('en-US')}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </Card>
            </section>
          )}
        </>
      )}

      <MaintenanceWindows canWrite={hasPermission('settings:write')} />
    </div>
  )
}

function MaintenanceWindows({ canWrite }: { canWrite: boolean }) {
  const windows = useMaintenanceWindows()
  const create = useCreateMaintenanceWindow()
  const cancel = useCancelMaintenanceWindow()
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [hosts, setHosts] = useState('')
  const [starts, setStarts] = useState('')
  const [ends, setEnds] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    const list = hosts.split(',').map((h) => h.trim()).filter(Boolean)
    if (!list.length || !starts || !ends || !reason.trim()) {
      setError('Name the hosts, both times and why.')
      return
    }
    try {
      await create.mutateAsync({ hosts: list, starts_at: new Date(starts).toISOString(), ends_at: new Date(ends).toISOString(), reason: reason.trim() })
      toast({ title: 'Maintenance window added', description: 'Alerts for its hosts are held back between its times.' })
      setOpen(false)
      setHosts('')
      setStarts('')
      setEnds('')
      setReason('')
    } catch {
      setError('It could not be saved: check the times (it ends after it starts, in the future, within 31 days).')
    }
  }

  const list: MaintenanceWindow[] = windows.data ?? []
  return (
    <section aria-labelledby="windows-heading" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="windows-heading" className="flex items-center gap-1.5 text-sm font-semibold text-ink">
          <Wrench className="h-4 w-4 text-ink-subtle" aria-hidden="true" />
          Maintenance windows <span className="font-normal text-ink-subtle">· alerts for these hosts are held back</span>
        </h2>
        {canWrite && !open && (
          <Button size="sm" variant="secondary" leadingIcon={<Plus className="h-4 w-4" />} onClick={() => setOpen(true)}>
            Add a window
          </Button>
        )}
      </div>
      {open && (
        <form onSubmit={(e) => void onSubmit(e)} aria-label="Add a maintenance window" className="grid gap-3 rounded-card border border-line bg-surface-muted p-4 sm:grid-cols-2">
          <TextField label="Hosts or services (comma-separated)" value={hosts} onChange={(e) => setHosts(e.target.value)} />
          <TextField label="Why" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          <TextField label="Starts" type="datetime-local" alwaysFloat value={starts} onChange={(e) => setStarts(e.target.value)} />
          <TextField label="Ends" type="datetime-local" alwaysFloat value={ends} onChange={(e) => setEnds(e.target.value)} />
          {error && <p className="text-sm text-danger sm:col-span-2">{error}</p>}
          <div className="flex gap-2 sm:col-span-2">
            <Button type="submit" size="sm" loading={create.isPending}>
              Save window
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {windows.isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : list.length === 0 ? (
        <p className="text-sm text-ink-muted">No maintenance window in force or coming.</p>
      ) : (
        <ul className="space-y-2" aria-label="Maintenance windows">
          {list.map((w) => (
            <li key={w.id} className={cn('flex flex-wrap items-center justify-between gap-2 rounded-control border border-line bg-surface px-3.5 py-2.5', w.cancelled_at && 'opacity-60')}>
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">{w.hosts.join(', ')}</p>
                <p className="text-xs text-ink-muted">
                  {new Date(w.starts_at).toLocaleString('en-GB', { timeZone: 'Africa/Addis_Ababa' })} to {new Date(w.ends_at).toLocaleString('en-GB', { timeZone: 'Africa/Addis_Ababa' })} · {w.reason}
                  {w.suppressed > 0 && ` · ${w.suppressed} alert${w.suppressed === 1 ? '' : 's'} held back`}
                </p>
              </div>
              <span className="flex items-center gap-2">
                {w.cancelled_at ? <Badge tone="neutral">Cancelled</Badge> : w.in_force ? <Badge tone="warning">In force</Badge> : <Badge tone="info">Coming</Badge>}
                {canWrite && !w.cancelled_at && (
                  <Button size="sm" variant="ghost" loading={cancel.isPending} onClick={() => cancel.mutate(w.id)}>
                    End it
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

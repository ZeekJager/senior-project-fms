import { AlertTriangle, BarChart3, Building2, CalendarRange, CircleCheck } from 'lucide-react'
import { useMemo, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { EmptyState, ErrorState } from '@/components/shared'
import { Badge, Card, cn, FilterSelect, Skeleton } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { useDepots } from '@/features/depots'
import { RANGES, readState, useAnalytics, writeState, type DashboardState, type FleetSummary, type MaintenanceRisk, type UtilisationSummary } from './api'
import { CostByDayChart, UtilisationByDayChart, UtilisationByVehicleChart } from './charts'
import { ago, birr, birrPerKm, clock, litres, percent } from './describe'

/** Behind the primary by more than this, the note says so. */
const NOTEWORTHY_LAG_SECONDS = 5

function Panel({ title, description, legend, children, className }: { title: string; description?: string; legend?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Card className={cn('flex min-w-0 flex-col p-4 sm:p-5', className)}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-ink-subtle">{description}</p>}
        </div>
        {legend}
      </div>
      {children}
    </Card>
  )
}

const chartFallback = <Skeleton className="h-64 w-full" />

function Legend({ items }: { items: { label: string; colorVar: string }[] }) {
  return (
    <ul className="flex items-center gap-4 text-xs text-ink-muted" aria-label="Legend">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: `rgb(var(${i.colorVar}))` }} aria-hidden />
          {i.label}
        </li>
      ))}
    </ul>
  )
}

/** The range at a glance: utilisation, what driving cost per km, the cost, on time. */
function KpiBand({ s }: { s: FleetSummary | undefined }) {
  const figures: { label: string; value: string | undefined; note: string | undefined }[] = [
    { label: 'Utilisation', value: s && percent(s.utilisation_pct), note: s && `${s.distance_km.toLocaleString()} km over ${s.trips_completed.toLocaleString()} trips` },
    { label: 'Cost per km', value: s && birrPerKm(s.cost_per_km_cents), note: s && 'Fuel and repairs over distance driven' },
    { label: 'Fleet cost', value: s && birr(s.total_cost_cents), note: s && `${birr(s.fuel_cost_cents)} fuel (${litres(s.fuel_ml)}) · ${birr(s.maintenance_cost_cents)} repairs` },
    { label: 'Trips on time', value: s && percent(s.on_time_pct), note: s && 'Ended within 15 minutes of the scheduled end' },
  ]
  return (
    <dl className="stat-strip" aria-busy={!s || undefined}>
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

const SEVERITY_TONE = { critical: 'danger', high: 'warning', medium: 'info', low: 'neutral' } as const

/** Open alerts by severity, the fleet's status, and the vehicles most at risk of a breakdown. */
function NeedsAttention({ s, risks, canOpenVehicle }: { s: FleetSummary | undefined; risks: MaintenanceRisk[] | undefined; canOpenVehicle: boolean }) {
  const top = (risks ?? []).filter((r) => r.risk_pct !== null || r.maintenance_flag).slice(0, 5)
  return (
    <Panel title="Needs attention" description="Open alerts and the vehicles most at risk, now">
      {!s ? (
        <Skeleton className="h-48 w-full" />
      ) : (
        <div className="space-y-5">
          <ul className="grid grid-cols-2 gap-2" aria-label="Open alerts by severity">
            {(['critical', 'high', 'medium', 'low'] as const).map((sev) => (
              <li key={sev} className="flex items-center justify-between rounded-control border border-line px-3 py-2">
                <Badge tone={SEVERITY_TONE[sev]}>{sev[0].toUpperCase() + sev.slice(1)}</Badge>
                <span className="tabular text-sm font-semibold text-ink">{s.open_alerts[sev].toLocaleString()}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-ink-subtle">
            {s.vehicles.total.toLocaleString()} vehicles · {s.vehicles.by_status.active.toLocaleString()} active · {s.vehicles.by_status.maintenance.toLocaleString()} in maintenance
            {s.vehicles.average_health_score !== null && ` · average health ${s.vehicles.average_health_score}`}
          </p>
          <div>
            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-subtle">Highest breakdown risk</h3>
            {top.length === 0 ? (
              <p className="flex items-center gap-2 text-sm text-ink-muted">
                <CircleCheck className="h-4 w-4 text-success" aria-hidden /> No vehicle is flagged or predicted at risk.
              </p>
            ) : (
              <ol className="divide-y divide-line">
                {top.map((r) => (
                  <li key={r.vehicle_id} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      {canOpenVehicle ? (
                        <Link to={`/vehicles/${r.vehicle_id}?section=health`} className="plate focus-ring rounded text-ink hover:underline">
                          {r.registration_number}
                        </Link>
                      ) : (
                        <span className="plate text-ink">{r.registration_number}</span>
                      )}
                      <p className="truncate text-xs text-ink-subtle">{r.predicted_failure_type ? `${r.predicted_failure_type.replace(/_/g, ' ')} · ${r.depot_name}` : r.depot_name}</p>
                    </div>
                    <span className="tabular shrink-0 text-sm font-semibold text-ink">{r.risk_pct === null ? <Badge tone="warning">Flagged</Badge> : `${r.risk_pct}%`}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      )}
    </Panel>
  )
}

/**
 * S-18 Analytics dashboard (FMS-51): the fleet's KPIs over a range of days from the analytics API (FMS-50), with a
 * utilisation and a cost chart by day, utilisation by vehicle for the whole fleet, and what needs attention. The
 * figures come from a cache refreshed hourly: a banner says when it is more than 25 hours old. Needs analytics:read.
 */
export function AnalyticsDashboardPage() {
  const { hasPermission } = useAuth()
  const [params, setParams] = useSearchParams()
  const state = useMemo(() => readState(params), [params])
  const update = (patch: Partial<DashboardState>) => setParams(writeState({ ...state, ...patch }), { replace: true })
  const canPickDepot = hasPermission('depot:read')
  const canOpenVehicle = hasPermission({ all: ['vehicle:read', 'depot:read'] })

  const depots = useDepots()
  const summary = useAnalytics<FleetSummary>('fleet-summary', state)
  const utilisation = useAnalytics<UtilisationSummary>('utilisation', state)
  const risk = useAnalytics<MaintenanceRisk[]>('maintenance-risk', state)

  const s = summary.data?.data
  const meta = summary.data?.meta
  const depotOptions = [{ value: '', label: 'All depots' }, ...(depots.data ?? []).map((d) => ({ value: d.id, label: d.name }))]
  const lagging = meta && meta.data_freshness.source === 'replica' && meta.data_freshness.lag_seconds >= NOTEWORTHY_LAG_SECONDS

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 border-b border-line pb-5">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">Dashboard</h1>
          <p className="mt-1 max-w-xl text-sm text-ink-muted">How much the fleet is used, what it costs to run, and what needs attention.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <FilterSelect label="Range" icon={<CalendarRange />} value={state.range} emptyValue="30d" options={RANGES} onChange={(range) => update({ range })} />
          {canPickDepot && (depots.data?.length ?? 0) > 1 && (
            <FilterSelect label="Depot" icon={<Building2 />} value={state.depotId} emptyValue="" options={depotOptions} onChange={(depotId) => update({ depotId })} />
          )}
        </div>
      </header>

      {meta?.stale && (
        <div role="status" className="flex items-start gap-3 rounded-card border border-warning/30 bg-warning-soft px-4 py-3 text-sm text-ink">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
          <p>
            <span className="font-semibold">These figures may be out of date.</span>{' '}
            {meta.computed_at
              ? `They were last refreshed ${ago(meta.computed_at)}; the hourly refresh has not run since.`
              : 'They have not been calculated yet: the first refresh has not run.'}
          </p>
        </div>
      )}

      {summary.isError ? (
        <Card>
          <ErrorState error={summary.error} heading="The dashboard could not load" onRetry={() => void summary.refetch()} />
        </Card>
      ) : s && s.vehicles.total === 0 ? (
        <Card>
          <EmptyState icon={<BarChart3 />} heading="No vehicles to report on" description="Figures appear here once your depots have vehicles on the road." headingLevel="h2" />
        </Card>
      ) : (
        <>
          <div className="space-y-2">
            <KpiBand s={s} />
            {meta && (
              <p className="text-xs text-ink-subtle">
                {meta.computed_at ? `Figures as of ${clock(meta.computed_at)}, refreshed hourly` : 'Not calculated yet'}
                {lagging && <span className="text-warning"> · {meta.data_freshness.lag_seconds.toLocaleString()} s behind live</span>}
              </p>
            )}
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            <Panel title="Utilisation by day" description="Share of vehicles out on a trip each day" className="lg:col-span-2">
              {s ? <UtilisationByDayChart daily={s.daily} /> : chartFallback}
            </Panel>
            <NeedsAttention s={s} risks={risk.data?.data} canOpenVehicle={canOpenVehicle} />
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Panel
              title="Cost by day"
              description="Fuel logged and repairs completed, in birr"
              legend={
                <Legend
                  items={[
                    { label: 'Fuel', colorVar: '--c-series-1' },
                    { label: 'Repairs', colorVar: '--c-series-2' },
                  ]}
                />
              }
            >
              {s ? <CostByDayChart daily={s.daily} /> : chartFallback}
            </Panel>
            <Panel
              title="Utilisation by vehicle"
              description={utilisation.data ? `Days on the road, ${utilisation.data.data.vehicles.length.toLocaleString()} vehicles, highest first` : 'Days on the road, highest first'}
            >
              {utilisation.data ? <UtilisationByVehicleChart vehicles={utilisation.data.data.vehicles} /> : chartFallback}
            </Panel>
          </div>
        </>
      )}
    </div>
  )
}

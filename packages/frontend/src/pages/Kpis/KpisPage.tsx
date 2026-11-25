import { ArrowDownRight, ArrowRight, ArrowUpRight, ChevronRight, CircleCheck, CircleMinus, CircleX, Gauge, TriangleAlert } from 'lucide-react'
import { useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { EmptyState } from '@/components/shared'
import { Button, cn, FilterSelect, Skeleton, ViewTabs } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { useDepots } from '@/features/depots'
import { readState, writeState, type ScreenState } from '@/pages/Reports/api'
import { DepotsFilter, FilterChips, PeriodPicker, VehicleTypeFilter } from '@/pages/Reports/ReportControls'
import { BETTER, formatChange, formatKpi, formatTarget, reportLink, UNIT_WORDS, useKpis, useKpiTrend, type Kpi, type KpiKey, type KpiStatus } from './api'
import { BreakdownChart, Sparkline, TrendChart } from './charts'

const STATUS: Record<KpiStatus, { label: string; icon: JSX.Element; className: string }> = {
  green: { label: 'On target', icon: <CircleCheck className="h-4 w-4" aria-hidden="true" />, className: 'text-success' },
  amber: { label: 'Near target', icon: <TriangleAlert className="h-4 w-4" aria-hidden="true" />, className: 'text-warning' },
  red: { label: 'Off target', icon: <CircleX className="h-4 w-4" aria-hidden="true" />, className: 'text-danger' },
  none: { label: 'No target', icon: <CircleMinus className="h-4 w-4" aria-hidden="true" />, className: 'text-ink-subtle' },
}

/** Where a KPI without a report of its own leads, and the permission it needs. */
const ELSEWHERE: Partial<Record<KpiKey, { to: string; permission: string; label: string }>> = {
  vehicles_at_risk: { to: '/predictive-maintenance', permission: 'prediction:read', label: 'Open predictive maintenance' },
  appeals: { to: '/appeals', permission: 'appeal:read', label: 'Open score appeals' },
  feedback: { to: '/drivers', permission: 'driver:read', label: 'Open drivers' },
}

const KPI_KEYS: readonly KpiKey[] = ['cost_per_km', 'fuel_l_per_100km', 'utilisation_pct', 'availability_pct', 'on_time_pct', 'pm_compliance_pct', 'incidents_per_100k_km', 'vehicles_at_risk', 'appeals', 'feedback']

function Change({ kpi }: { kpi: Kpi }) {
  if (kpi.change === null) return <span className="text-xs text-ink-subtle">No figure for the period before</span>
  const better = BETTER[kpi.key]
  const good = better === null || kpi.change === 0 ? null : (kpi.change < 0) === (better === 'lower')
  const Icon = kpi.change > 0 ? ArrowUpRight : kpi.change < 0 ? ArrowDownRight : ArrowRight
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs font-medium', good === null ? 'text-ink-muted' : good ? 'text-success' : 'text-danger')}>
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {formatChange(kpi.unit, kpi.change)}
      <span className="font-normal text-ink-subtle">vs the period before{good === null ? '' : good ? ', better' : ', worse'}</span>
    </span>
  )
}

function KpiTile({ kpi, state, selected, onSelect }: { kpi: Kpi; state: ScreenState; selected: boolean; onSelect: () => void }) {
  const { hasPermission } = useAuth()
  const status = STATUS[kpi.status]
  const target = formatTarget(kpi)
  const elsewhere = ELSEWHERE[kpi.key]
  const to = kpi.report ? reportLink(kpi.report, state) : elsewhere && hasPermission(elsewhere.permission) ? elsewhere.to : null
  return (
    <li className={cn('group relative flex flex-col rounded-card border bg-surface p-4 shadow-card transition-colors', selected ? 'border-brand ring-1 ring-brand/30' : 'border-line hover:border-line-strong')}>
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-medium text-ink-muted">{kpi.label}</h3>
        <span className={cn('inline-flex items-center gap-1 text-xs font-medium', status.className)}>
          {status.icon}
          {status.label}
        </span>
      </div>
      <p className="mt-2 flex items-baseline gap-1.5">
        <span className="tabular text-2xl font-semibold tracking-tight text-ink">{formatKpi(kpi.unit, kpi.value)}</span>
        {UNIT_WORDS[kpi.unit] && kpi.value !== null && <span className="text-xs text-ink-subtle">{UNIT_WORDS[kpi.unit]}</span>}
      </p>
      <div className="mt-1 min-h-[1.25rem]">
        <Change kpi={kpi} />
      </div>
      {target && <p className="mt-0.5 text-xs text-ink-subtle">Target {target}{kpi.unit === 'tenths_per_100k_km' ? ' per 100,000 km' : ''}</p>}
      <div className="mt-3">
        <Sparkline points={kpi.sparkline} unit={kpi.unit} label={kpi.label} />
      </div>
      <div className="mt-3 flex items-center justify-between gap-2 border-t border-line pt-3">
        <button type="button" onClick={onSelect} aria-pressed={selected} className="text-xs font-medium text-brand hover:underline">
          {selected ? 'Showing its trend' : 'Show trend'}
        </button>
        {to && (
          <Link to={to} className="inline-flex items-center gap-0.5 text-xs font-medium text-ink-muted hover:text-ink" aria-label={kpi.report ? `Open the report behind ${kpi.label}` : elsewhere!.label}>
            {kpi.report ? 'Open report' : 'Open'}
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        )}
      </div>
    </li>
  )
}

function TrendPanel({ kpi, state, months, group, onChange }: { kpi: Kpi; state: ScreenState; months: number; group: 'depot' | 'vehicle'; onChange: (patch: { months?: number; group?: 'depot' | 'vehicle'; depotIds?: string[] }) => void }) {
  const trend = useKpiTrend(kpi.key, state, months, group)
  const depots = useDepots()
  const t = trend.data && trend.data.kpi === kpi.key ? trend.data : undefined
  const drillable = kpi.report !== null
  // Fleet, then a depot, then its vehicles: picking a depot's bar narrows to it and shows its vehicles.
  const pickDepot = (name: string) => {
    const depot = depots.data?.find((d) => d.name === name)
    if (depot) onChange({ depotIds: [depot.id], group: 'vehicle' })
  }
  return (
    <section aria-labelledby="trend-heading" className="rounded-card border border-line bg-surface p-5 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="trend-heading" className="text-base font-semibold text-ink">
            {kpi.label}, month by month
          </h2>
          <p className="mt-0.5 text-sm text-ink-muted">Each month against the same month a year before.</p>
        </div>
        <FilterSelect label="Months" value={String(months)} options={[{ value: '12', label: '12 months' }, { value: '24', label: '24 months' }]} onChange={(v) => onChange({ months: Number(v) })} />
      </div>
      <div className="mt-4">{t ? <TrendChart trend={t} /> : <Skeleton className="h-64" />}</div>
      {drillable && (
        <div className="mt-6 border-t border-line pt-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-ink">
              {group === 'depot' ? 'By depot' : 'By vehicle'}
              {t ? `, ${t.period.label}` : ''}
            </h3>
            <ViewTabs label="Break down by" value={group} options={[{ value: 'depot', label: 'Each depot' }, { value: 'vehicle', label: 'Each vehicle' }]} onChange={(g) => onChange({ group: g })} />
          </div>
          <div className="mt-3">
            {!t ? (
              <Skeleton className="h-32" />
            ) : t.breakdown.length === 0 ? (
              <p className="py-6 text-sm text-ink-muted">Nothing to break down in this period.</p>
            ) : (
              <>
                <BreakdownChart trend={t} onPick={group === 'depot' ? pickDepot : undefined} />
                <table className="mt-4 w-full text-sm">
                  <caption className="sr-only">
                    {kpi.label} {group === 'depot' ? 'by depot' : 'by vehicle'}
                  </caption>
                  <thead>
                    <tr className="border-b border-line text-left text-xs text-ink-subtle">
                      <th scope="col" className="py-2 font-medium">
                        {group === 'depot' ? 'Depot' : 'Vehicle'}
                      </th>
                      <th scope="col" className="py-2 text-right font-medium">
                        {kpi.label}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {t.breakdown.map((b) => (
                      <tr key={b.name} className="border-b border-line/60">
                        <td className="py-2 text-ink">
                          {group === 'depot' ? (
                            <button type="button" className="text-left text-brand hover:underline" onClick={() => pickDepot(b.name)}>
                              {b.name}
                            </button>
                          ) : (
                            b.name
                          )}
                        </td>
                        <td className="tabular py-2 text-right text-ink">{formatKpi(t.unit, b.value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

/**
 * S-39 KPIs (FMS-160, docs/reports.md#kpis): cost per km, fuel use, utilisation, availability, on time, PM compliance,
 * incidents per 100,000 km, vehicles at risk, and appeal and feedback counts, for any period and filters. Each with its
 * change from the period before, a 12-month sparkline, its status against its target (with an icon and a label, never
 * colour alone), and a link to its report; one KPI's trend over 12 or 24 months beside last year, with its drill-down
 * from depots to vehicles. Needs analytics:read.
 */
export function KpisPage() {
  const [params, setParams] = useSearchParams()
  const state = useMemo(() => readState(params), [params])
  const selectedKey = (KPI_KEYS.find((k) => k === params.get('kpi')) ?? 'cost_per_km') as KpiKey
  const months = params.get('months') === '24' ? 24 : 12
  const group = params.get('group') === 'vehicle' ? 'vehicle' : 'depot'
  const kpis = useKpis(state)

  const write = (next: ScreenState, extra: { kpi?: KpiKey; months?: number; group?: string }) => {
    const q = writeState({ ...next, report: 'fuel' })
    const kpi = extra.kpi ?? selectedKey
    const m = extra.months ?? months
    const g = extra.group ?? group
    if (kpi !== 'cost_per_km') q.set('kpi', kpi)
    if (m !== 12) q.set('months', String(m))
    if (g !== 'depot') q.set('group', g)
    setParams(q, { replace: true })
  }
  const update = (patch: Partial<ScreenState>) => write({ ...state, ...patch }, {})
  const data = kpis.data
  const selected = data?.kpis.find((k) => k.key === selectedKey)

  return (
    <div className="space-y-6">
      <header className="space-y-4 border-b border-line pb-5">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">KPIs</h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-muted">How the fleet is doing against its targets{data ? `, ${data.period.label}` : ''}. Each figure comes from its report for the same period and filters.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PeriodPicker state={state} onChange={update} />
          <DepotsFilter value={state.depotIds} onChange={(depotIds) => update({ depotIds })} />
          <VehicleTypeFilter value={state.vehicleType} onChange={(vehicleType) => update({ vehicleType })} />
        </div>
        <FilterChips state={state} names={undefined} onChange={update} />
      </header>

      {kpis.isError ? (
        <EmptyState
          icon={<Gauge />}
          heading="The KPIs could not be loaded"
          description="Check your connection and try again."
          action={
            <Button variant="secondary" onClick={() => void kpis.refetch()}>
              Try again
            </Button>
          }
        />
      ) : !data ? (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-busy="true" aria-label="KPIs loading">
          {Array.from({ length: 8 }, (_, i) => (
            <li key={i}>
              <Skeleton className="h-48" />
            </li>
          ))}
        </ul>
      ) : (
        <ul className={cn('grid gap-4 sm:grid-cols-2 xl:grid-cols-4', kpis.isFetching && 'opacity-70 transition-opacity')} aria-label="KPIs">
          {data.kpis.map((k) => (
            <KpiTile key={k.key} kpi={k} state={state} selected={k.key === selectedKey} onSelect={() => write(state, { kpi: k.key })} />
          ))}
        </ul>
      )}

      {selected && (
        <TrendPanel
          kpi={selected}
          state={state}
          months={months}
          group={group}
          onChange={(patch) => write({ ...state, ...(patch.depotIds ? { depotIds: patch.depotIds } : {}) }, { months: patch.months, group: patch.group })}
        />
      )}
    </div>
  )
}

import { Building2, ChevronLeft, ChevronRight, Download } from 'lucide-react'
import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Button, FilterSelect, IconButton, useToast, ViewTabs } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { useDepots } from '@/features/depots'
import { downloadCsv, toCsv } from '@/lib/csv'
import { AnomaliesTab } from './AnomaliesTab'
import { AnomalyDrawer } from './AnomalyDrawer'
import { currentMonth, monthLabel, readState, shiftMonth, useAnomaly, useAnomalyCounts, useReconciliation, writeState, type DataFreshness, type ScreenState, type Tab } from './api'
import { CSV_HEADERS, csvRow, formatTime } from './describe'
import { VehiclesTab } from './VehiclesTab'

/** Behind the primary by more than this, the note says so; a second or two is not worth mentioning. */
const NOTEWORTHY_LAG_SECONDS = 5

/** "Data as of 14:05", and how far behind the live database when the reporting copy lags (FMS-94). */
function Freshness({ freshness }: { freshness: DataFreshness | undefined }) {
  if (!freshness) return null
  const lagging = freshness.source === 'replica' && freshness.lag_seconds >= NOTEWORTHY_LAG_SECONDS
  return (
    <p className="text-xs text-ink-subtle" title={freshness.source === 'replica' ? 'Read from the reporting copy of the database' : 'Read from the live database'}>
      Data as of {formatTime(freshness.as_of, lagging)}
      {lagging && <span className="text-warning"> · {freshness.lag_seconds.toLocaleString()} s behind live</span>}
    </p>
  )
}

/** "‹ September 2026 ›": the period is a calendar month, as the monthly reconciliation reads it; no month not yet begun. */
function MonthStepper({ month, onChange }: { month: string; onChange: (month: string) => void }) {
  const latest = currentMonth()
  return (
    <div className="flex h-9 items-center rounded-control border border-line bg-surface coarse:h-11" role="group" aria-label="Month">
      <IconButton label="Previous month" size="sm" icon={<ChevronLeft className="h-4 w-4" />} onClick={() => onChange(shiftMonth(month, -1))} />
      <span className="tabular min-w-[9.5rem] px-1 text-center text-sm font-medium text-ink" aria-live="polite">
        {monthLabel(month)}
      </span>
      <IconButton label="Next month" size="sm" icon={<ChevronRight className="h-4 w-4" />} disabled={month >= latest} onClick={() => onChange(shiftMonth(month, 1))} />
    </div>
  )
}

/**
 * S-15 Fuel reconciliation (FMS-42): the month's fuel logged for each vehicle against what its trips needed, the
 * vehicles furthest off first, exported as CSV for the books; and the fuel anomalies the monthly run raised, each
 * resolved or dismissed here with who did it recorded. Needs fuel-anomaly:read; the vehicle table also needs
 * analytics:read and fuel:read (a depot admin sees the anomalies only), closing an anomaly fuel-anomaly:write.
 */
export function FuelReconciliationPage() {
  const { hasPermission } = useAuth()
  const { toast } = useToast()
  const canReconcile = hasPermission({ all: ['analytics:read', 'fuel:read'] })
  const canClose = hasPermission('fuel-anomaly:write')
  const canPickDepot = hasPermission('depot:read')

  const [params, setParams] = useSearchParams()
  const state = useMemo(() => readState(params), [params])
  const update = (patch: Partial<ScreenState>) => setParams(writeState({ ...state, ...patch }), { replace: true })
  const tab: Tab = canReconcile ? state.tab : 'anomalies'

  const depots = useDepots()
  const reconciliation = useReconciliation(state.month, state.depotId, canReconcile)
  const counts = useAnomalyCounts()
  const anomaly = useAnomaly(state.anomaly)

  const depotOptions = [{ value: '', label: 'All depots' }, ...(canPickDepot ? (depots.data ?? []) : []).map((d) => ({ value: d.id, label: d.name }))]
  const data = reconciliation.data

  function exportCsv() {
    if (!data) return
    const scope = state.depotId ? (depots.data?.find((d) => d.id === state.depotId)?.code ?? 'depot').toLowerCase() : 'all'
    downloadCsv(`fuel-reconciliation-${state.month}-${scope}.csv`, toCsv(CSV_HEADERS, data.rows.map((r) => csvRow(r, data.thresholdPct))))
    toast({ title: 'CSV downloaded', description: `${data.rows.length.toLocaleString()} vehicles, ${monthLabel(state.month)}.` })
  }

  const openCount = counts.counts.needs_review

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 border-b border-line pb-5">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">Fuel reconciliation</h1>
          <p className="mt-1 max-w-xl text-sm text-ink-muted">
            {canReconcile
              ? 'Fuel logged for each vehicle against what its trips needed at its rated consumption. Review the flagged vehicles, then close their anomalies.'
              : 'Fuel anomalies the monthly reconciliation raised for your depot’s vehicles.'}
          </p>
        </div>
        {canReconcile && tab === 'vehicles' && (
          <div className="flex flex-wrap items-center gap-2">
            <MonthStepper month={state.month} onChange={(month) => update({ month })} />
            {canPickDepot && (depots.data?.length ?? 0) > 1 && (
              <FilterSelect label="Depot" icon={<Building2 />} value={state.depotId} emptyValue="" options={depotOptions} onChange={(depotId) => update({ depotId })} />
            )}
            <Button variant="secondary" leadingIcon={<Download className="h-4 w-4" />} disabled={!data || data.rows.length === 0} onClick={exportCsv}>
              Export CSV
            </Button>
          </div>
        )}
      </header>

      {canReconcile && (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <ViewTabs
            label="Fuel reconciliation sections"
            value={tab}
            options={[
              { value: 'vehicles', label: 'Vehicles' },
              { value: 'anomalies', label: 'Anomalies', count: openCount, isLoading: counts.isLoading, hint: 'Open and reviewed anomalies, waiting to be resolved or dismissed' },
            ]}
            onChange={(next) => update({ tab: next })}
          />
          {tab === 'vehicles' && <Freshness freshness={data?.freshness} />}
        </div>
      )}

      {tab === 'vehicles' ? (
        <VehiclesTab
          month={state.month}
          rows={data?.rows}
          summary={data?.summary}
          thresholdPct={data?.thresholdPct ?? 20}
          isLoading={reconciliation.isPending}
          isFetching={reconciliation.isFetching}
          error={reconciliation.isError ? reconciliation.error : undefined}
          onRetry={() => void reconciliation.refetch()}
          mark={state.mark}
          onMark={(mark) => update({ mark })}
          onOpenAnomaly={(id) => update({ anomaly: id })}
        />
      ) : (
        <AnomaliesTab view={state.anomalyView} onView={(anomalyView) => update({ anomalyView })} onOpen={(id) => update({ anomaly: id })} />
      )}

      <AnomalyDrawer anomaly={state.anomaly ? (anomaly.data ?? null) : null} canClose={canClose} onClose={() => update({ anomaly: '' })} />
    </div>
  )
}

import { Building2, Download } from 'lucide-react'
import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { MonthStepper } from '@/components/shared'
import { Button, cn, FilterSelect, Skeleton, useToast } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { useDepots } from '@/features/depots'
import { downloadCsv, toCsv } from '@/lib/csv'
import { monthLabel } from '@/lib/month'
import { readState, useAvailability, writeState, type DataFreshness, type ScreenState } from './api'
import { DepotTable, VehicleTable } from './AvailabilityTables'
import { CSV_HEADERS, csvRow, hours, pct, span } from './describe'
import { PeriodsDrawer } from './PeriodsDrawer'
import { ReasonBars } from './ReasonBars'

/** Behind the live database by more than this, the note says so; a second or two is not worth mentioning. */
const NOTEWORTHY_LAG_SECONDS = 5
const clock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Addis_Ababa', hour: '2-digit', minute: '2-digit' })

/** "Data as of 14:05", and how far behind the live database when the reporting copy lags (FMS-94). */
function Freshness({ freshness }: { freshness: DataFreshness | undefined }) {
  if (!freshness) return null
  const lagging = freshness.source === 'replica' && freshness.lag_seconds >= NOTEWORTHY_LAG_SECONDS
  return (
    <p className="text-xs text-ink-subtle" title={freshness.source === 'replica' ? 'Read from the reporting copy of the database' : 'Read from the live database'}>
      Data as of {clock.format(new Date(freshness.as_of))}
      {lagging && <span className="text-warning"> · {freshness.lag_seconds.toLocaleString()} s behind live</span>}
    </p>
  )
}

/**
 * S-33 Fleet availability (FMS-142): how much of the month vehicles could work, the downtime by reason behind the
 * rest, MTBF and MTTR, for the fleet, each depot and each vehicle; each vehicle's periods with the work order or
 * failure behind them; CSV for the books. From FMS-131's downtime periods. Needs analytics:read and maintenance:read.
 */
export function FleetAvailabilityPage() {
  const { hasPermission } = useAuth()
  const { toast } = useToast()
  const canPickDepot = hasPermission('depot:read')

  const [params, setParams] = useSearchParams()
  const state = useMemo(() => readState(params), [params])
  const update = (patch: Partial<ScreenState>) => setParams(writeState({ ...state, ...patch }), { replace: true })

  const depots = useDepots()
  const availability = useAvailability(state.month, state.depotId)
  const data = availability.data
  const fleet = data?.fleet
  const open = data?.vehicles.find((v) => v.vehicle_id === state.vehicle) ?? null

  const depotOptions = [{ value: '', label: 'All depots' }, ...(canPickDepot ? (depots.data ?? []) : []).map((d) => ({ value: d.id, label: d.name }))]

  function exportCsv() {
    if (!data) return
    const scope = state.depotId ? (depots.data?.find((d) => d.id === state.depotId)?.code ?? 'depot').toLowerCase() : 'all'
    downloadCsv(`fleet-availability-${state.month}-${scope}.csv`, toCsv(CSV_HEADERS, data.vehicles.map(csvRow)))
    toast({ title: 'CSV downloaded', description: `${data.vehicles.length.toLocaleString()} vehicles, ${monthLabel(state.month)}.` })
  }

  const figures: { label: string; value: string | undefined; note: string | undefined; hint: string }[] = [
    {
      label: 'Availability',
      value: fleet ? pct(fleet.availability_pct) : undefined,
      note: fleet ? `${fleet.vehicles.toLocaleString()} ${fleet.vehicles === 1 ? 'vehicle' : 'vehicles'}, ${hours(fleet.uptime_minutes)} up` : undefined,
      hint: 'Time up over time in the fleet: from registration, until retirement',
    },
    {
      label: 'Downtime',
      value: fleet ? hours(fleet.downtime_minutes) : undefined,
      note: fleet ? `${hours(fleet.unplanned_downtime_minutes)} unplanned` : undefined,
      hint: 'In the workshop, out of service, or broken down until repaired',
    },
    {
      label: 'MTBF',
      value: fleet ? span(fleet.mtbf_minutes) : undefined,
      note: fleet ? `time up per failure · ${fleet.failures} ${fleet.failures === 1 ? 'failure' : 'failures'}` : undefined,
      hint: 'Mean time between failures: time up over the unplanned periods that began in the month',
    },
    {
      label: 'MTTR',
      value: fleet ? span(fleet.mttr_minutes) : undefined,
      note: fleet ? `per repair · ${fleet.repairs} ${fleet.repairs === 1 ? 'repair' : 'repairs'} ended` : undefined,
      hint: 'Mean time to repair: the length of the unplanned periods that ended in the month',
    },
  ]

  const showDepots = !state.depotId && (data?.depots.length ?? 0) > 1

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 border-b border-line pb-5">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">Fleet availability</h1>
          <p className="mt-1 max-w-xl text-sm text-ink-muted">How much of the month vehicles could work, and what kept the rest in the workshop. Open a vehicle for the repairs and failures behind its downtime.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <MonthStepper month={state.month} onChange={(month) => update({ month, vehicle: '' })} />
          {canPickDepot && (depots.data?.length ?? 0) > 1 && (
            <FilterSelect label="Depot" icon={<Building2 />} value={state.depotId} emptyValue="" options={depotOptions} onChange={(depotId) => update({ depotId, vehicle: '' })} />
          )}
          <Button variant="secondary" leadingIcon={<Download className="h-4 w-4" />} disabled={!data || data.vehicles.length === 0} onClick={exportCsv}>
            Export CSV
          </Button>
        </div>
      </header>

      <div className="flex justify-end">
        <Freshness freshness={data?.freshness} />
      </div>

      {/* A failed read leaves the figures out: the table below says what went wrong and offers to try again. */}
      {!availability.isError && (
        <>
          <dl className="stat-strip" aria-busy={availability.isPending || undefined}>
            {figures.map((f) => (
              <div key={f.label} className="flex flex-col p-4 sm:p-5" title={f.hint}>
                <dt className="text-[13px] font-medium leading-tight text-ink-muted">{f.label}</dt>
                <dd className="tabular mt-2 text-xl font-semibold tracking-tight text-ink sm:text-2xl">{f.value ?? <Skeleton className="h-8 w-24" />}</dd>
                <dd className="mt-1.5 text-xs text-ink-subtle">{f.note ?? <Skeleton className="h-3 w-28" />}</dd>
              </div>
            ))}
          </dl>

          <div className={cn('grid gap-6', showDepots && 'xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]')}>
            <ReasonBars byReason={fleet?.downtime_by_reason} total={fleet?.downtime_minutes} isLoading={availability.isPending} />
            {showDepots && <DepotTable depots={data!.depots} onPick={(depotId) => update({ depotId })} />}
          </div>
        </>
      )}

      <VehicleTable
        month={state.month}
        rows={data?.vehicles}
        isLoading={availability.isPending}
        error={availability.isError ? availability.error : undefined}
        onRetry={() => void availability.refetch()}
        view={state.view}
        onView={(view) => update({ view })}
        sort={state.sort}
        order={state.order}
        onSort={(sort, order) => update({ sort, order })}
        onOpen={(vehicle) => update({ vehicle })}
      />

      <PeriodsDrawer vehicle={open} month={state.month} onClose={() => update({ vehicle: '' })} />
    </div>
  )
}

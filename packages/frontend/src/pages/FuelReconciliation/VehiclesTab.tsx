import { CircleCheck, Fuel, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Badge, Button, cn, Skeleton, ViewTabs } from '@/components/ui'
import { DataTable, EmptyState, type Column } from '@/components/shared'
import { markOf, monthLabel, type Mark, type ReconciliationRow, type ReconciliationSummary } from './api'
import { MARKS, birr, litres, markHint, reasonLabel, signedPct } from './describe'

const VARIANCE_INK: Record<Mark, string> = {
  flag: 'text-danger',
  watch: 'text-warning',
  ok: 'text-ink',
  not_judged: 'text-ink-subtle',
}

/** The month at a glance: what was bought, what it cost, how it compares with what the trips needed, how many are flagged. */
function Summary({ rows, summary, thresholdPct, isLoading }: { rows: ReconciliationRow[] | undefined; summary: ReconciliationSummary | undefined; thresholdPct: number; isLoading: boolean }) {
  const bought = rows?.reduce((sum, r) => sum + r.actual_ml, 0)
  const flagged = rows?.filter((r) => markOf(r, thresholdPct) === 'flag').length
  const figures: { label: string; value: string | undefined; note: string | undefined; tone?: string }[] = [
    { label: 'Fuel logged', value: bought === undefined ? undefined : litres(bought), note: rows ? `${rows.reduce((n, r) => n + r.fuel_logs, 0).toLocaleString()} fill-ups` : undefined },
    { label: 'Fuel cost', value: summary ? birr(summary.total_cost_cents) : undefined, note: rows ? `${rows.length.toLocaleString()} vehicles` : undefined },
    {
      label: 'Against what trips needed',
      value: summary ? signedPct(summary.variance_pct) : undefined,
      note: summary ? `${litres(summary.actual_ml)} of ${litres(summary.expected_ml)}, ${summary.judged} judged` : undefined,
      tone: summary?.variance_pct !== null && summary && Math.abs(summary.variance_pct ?? 0) > thresholdPct ? 'text-danger' : undefined,
    },
    {
      label: 'Flagged',
      value: flagged === undefined ? undefined : flagged.toLocaleString(),
      note: summary ? `more than ${thresholdPct}% off, of ${summary.judged} judged` : undefined,
      tone: flagged ? 'text-danger' : undefined,
    },
  ]
  return (
    <dl className="stat-strip" aria-busy={isLoading || undefined}>
      {figures.map((f) => (
        <div key={f.label} className="flex flex-col p-4 sm:p-5">
          <dt className="text-[13px] font-medium leading-tight text-ink-muted">{f.label}</dt>
          <dd className={cn('tabular mt-2 text-xl font-semibold tracking-tight text-ink sm:text-2xl', f.tone)}>{f.value ?? <Skeleton className="h-8 w-24" />}</dd>
          <dd className="mt-1.5 text-xs text-ink-subtle">{f.note ?? <Skeleton className="h-3 w-28" />}</dd>
        </div>
      ))}
    </dl>
  )
}

interface VehiclesTabProps {
  month: string
  rows: ReconciliationRow[] | undefined
  summary: ReconciliationSummary | undefined
  thresholdPct: number
  isLoading: boolean
  isFetching: boolean
  error: unknown
  onRetry: () => void
  mark: Mark | ''
  onMark: (mark: Mark | '') => void
  onOpenAnomaly: (id: string) => void
}

/**
 * The month by vehicle (S-15, FMS-42): every vehicle's fuel logged against what its completed trips needed at its
 * rated consumption, furthest off first, so a flag (beyond the threshold, red) always tops the list.
 */
export function VehiclesTab({ month, rows, summary, thresholdPct, isLoading, isFetching, error, onRetry, mark, onMark, onOpenAnomaly }: VehiclesTabProps) {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  useEffect(() => setPage(1), [month, mark])

  const counts = useMemo(() => {
    const c: Record<Mark, number> = { flag: 0, watch: 0, ok: 0, not_judged: 0 }
    for (const r of rows ?? []) c[markOf(r, thresholdPct)] += 1
    return c
  }, [rows, thresholdPct])
  const shown = useMemo(() => (rows ?? []).filter((r) => !mark || markOf(r, thresholdPct) === mark), [rows, mark, thresholdPct])
  const pageRows = rows ? shown.slice((page - 1) * pageSize, page * pageSize) : undefined

  const columns: Column<ReconciliationRow>[] = [
    {
      key: 'vehicle',
      header: 'Vehicle',
      cell: (r) => (
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="plate whitespace-nowrap text-ink">{r.registration_number}</p>
            {/* On a phone the mark rides with the plate: there is no room for its own column. */}
            <span className="sm:hidden">
              <Badge tone={MARKS[markOf(r, thresholdPct)].tone}>{MARKS[markOf(r, thresholdPct)].label}</Badge>
            </span>
          </div>
          <p className="truncate text-xs text-ink-subtle xl:hidden">{r.depot_name}</p>
          <p className="truncate text-xs text-ink-subtle lg:hidden">
            {r.distance_km.toLocaleString('en-US', { maximumFractionDigits: 1 })} km · {r.trips} {r.trips === 1 ? 'trip' : 'trips'}
          </p>
        </div>
      ),
      skeleton: (
        <div className="space-y-2">
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="h-3 w-20" />
        </div>
      ),
    },
    { key: 'depot', header: 'Depot', width: 'w-[14%]', hideBelow: 'xl', cell: (r) => <span className="block truncate text-ink-muted">{r.depot_name}</span> },
    {
      key: 'driven',
      header: 'Trips driven',
      width: 'w-[11%]',
      hideBelow: 'lg',
      align: 'right',
      cell: (r) => (
        <span className="tabular block text-right text-ink-muted">
          {r.distance_km.toLocaleString('en-US', { maximumFractionDigits: 1 })} km
          <span className="block text-xs text-ink-subtle">
            {r.trips} {r.trips === 1 ? 'trip' : 'trips'}
          </span>
        </span>
      ),
    },
    {
      key: 'expected',
      header: 'Trips needed',
      width: 'w-[11%]',
      hideBelow: 'md',
      align: 'right',
      cell: (r) => <span className="tabular block text-right text-ink-muted">{litres(r.expected_ml)}</span>,
    },
    {
      key: 'actual',
      header: 'Logged',
      width: 'w-[11%]',
      hideBelow: 'sm',
      align: 'right',
      cell: (r) => (
        <span className="tabular block text-right text-ink">
          {litres(r.actual_ml)}
          <span className="block text-xs text-ink-subtle">
            {r.fuel_logs} {r.fuel_logs === 1 ? 'fill-up' : 'fill-ups'}
          </span>
        </span>
      ),
    },
    {
      key: 'variance',
      header: 'Variance',
      width: 'w-[34%] sm:w-[11%] lg:w-[9%]',
      align: 'right',
      cell: (r) => {
        const m = markOf(r, thresholdPct)
        return (
          <span className={cn('tabular block text-right font-semibold', VARIANCE_INK[m])}>
            {signedPct(r.variance_pct)}
            {r.variance_ml !== null && <span className="block text-xs font-normal text-ink-subtle">{`${r.variance_ml > 0 ? '+' : r.variance_ml < 0 ? '−' : ''}${litres(Math.abs(r.variance_ml))}`}</span>}
          </span>
        )
      },
    },
    { key: 'cost', header: 'Cost', width: 'w-[13%]', hideBelow: 'lg', align: 'right', cell: (r) => <span className="tabular block text-right text-ink-muted">{birr(r.total_cost_cents)}</span> },
    {
      key: 'mark',
      header: 'Mark',
      width: 'w-[140px]',
      hideBelow: 'sm',
      cell: (r) => {
        const m = markOf(r, thresholdPct)
        return (
          <div className="flex min-w-0 flex-col items-start gap-1">
            <Badge tone={MARKS[m].tone}>{MARKS[m].label}</Badge>
            {m === 'not_judged' && <span className="truncate text-xs text-ink-subtle">{reasonLabel(r)}</span>}
            {r.anomaly_id && (
              <button type="button" className="focus-ring rounded text-xs font-medium text-brand-ink underline-offset-2 hover:underline" onClick={() => onOpenAnomaly(r.anomaly_id!)}>
                Review anomaly
              </button>
            )}
          </div>
        )
      },
      skeleton: <Skeleton className="h-6 w-14 rounded-full" />,
    },
  ]

  const views: { value: Mark | 'all'; label: string; count?: number; isLoading?: boolean; hint?: string; archived?: boolean }[] = [
    { value: 'all', label: 'All', count: rows?.length, isLoading, hint: 'Every vehicle with trips or fill-ups in the month, furthest off first' },
    ...(['flag', 'watch', 'ok'] as const).map((m) => ({ value: m, label: MARKS[m].label, count: rows ? counts[m] : undefined, isLoading, hint: markHint(m, thresholdPct) })),
    { value: 'not_judged', label: MARKS.not_judged.label, count: rows ? counts.not_judged : undefined, isLoading, hint: markHint('not_judged', thresholdPct), archived: true },
  ]

  return (
    <div className="space-y-6">
      <Summary rows={rows} summary={summary} thresholdPct={thresholdPct} isLoading={isLoading} />
      <DataTable
        toolbar={<ViewTabs label="Variance marks" value={mark || 'all'} options={views} onChange={(v) => onMark(v === 'all' ? '' : (v as Mark))} />}
        caption={`Fuel by vehicle, ${monthLabel(month)}, furthest from expected first`}
        rowHeight="stacked3"
        tableId="fuel-reconciliation"
        rowLabel={(r) => r.registration_number}
        rowClassName={(r) => (markOf(r, thresholdPct) === 'flag' ? 'bg-danger-soft/25' : undefined)}
        columns={columns}
        data={pageRows}
        rowKey={(r) => r.vehicle_id}
        isLoading={isLoading}
        error={error ?? undefined}
        onRetry={onRetry}
        pagination={
          rows && shown.length > 0
            ? {
                page,
                pageSize,
                totalItems: shown.length,
                onPageChange: setPage,
                onPageSizeChange: (size) => {
                  setPageSize(size)
                  setPage(1)
                },
              }
            : undefined
        }
        emptyState={
          mark && rows?.length ? (
            <EmptyState
              icon={mark === 'flag' ? <CircleCheck /> : <Search />}
              heading={mark === 'flag' ? `No vehicle flagged in ${monthLabel(month)}` : `No vehicles marked ${MARKS[mark].label.toLowerCase()}`}
              description={mark === 'flag' ? `Every judged vehicle was within ${thresholdPct}% of what its trips needed.` : markHint(mark, thresholdPct)}
              action={
                <Button variant="secondary" onClick={() => onMark('')}>
                  Show every vehicle
                </Button>
              }
            />
          ) : (
            <EmptyState icon={<Fuel />} heading={`Nothing to reconcile for ${monthLabel(month)}`} description="No vehicle in your depots had trips or fill-ups that month." />
          )
        }
      />
      {isFetching && !isLoading && <span className="sr-only">Updating…</span>}
    </div>
  )
}

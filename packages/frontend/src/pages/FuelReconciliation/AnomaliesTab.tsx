import { CircleCheck, Eye, Search } from 'lucide-react'
import { useState } from 'react'
import { Badge, Button, Skeleton, ViewTabs } from '@/components/ui'
import { DataTable, EmptyState, type Column } from '@/components/shared'
import { useAnomalies, useAnomalyCounts, type AnomalyView, type FuelAnomaly } from './api'
import { isClosed } from './AnomalyDrawer'
import { anomalyPeriod, anomalyTitle, formatDay, litres, signedPct } from './describe'

const VIEW_LABELS: Record<AnomalyView, string> = {
  needs_review: 'Needs review',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
  all: 'All',
}

/**
 * The anomalies the monthly reconciliation raised (S-15, FMS-42), those still needing someone first by default,
 * newest first. A row opens it; there it is resolved or dismissed, which records who did it.
 */
export function AnomaliesTab({ view, onView, onOpen }: { view: AnomalyView; onView: (view: AnomalyView) => void; onOpen: (id: string) => void }) {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const list = useAnomalies(view, page, pageSize)
  const counts = useAnomalyCounts()

  const columns: Column<FuelAnomaly>[] = [
    {
      key: 'vehicle',
      header: 'Vehicle',
      width: 'w-[40%] sm:w-[22%]',
      cell: (a) => (
        <div className="min-w-0">
          <p className="plate whitespace-nowrap text-ink">{a.registration_number}</p>
          <p className="truncate text-xs text-ink-subtle">{a.depot_name}</p>
        </div>
      ),
      skeleton: (
        <div className="space-y-2">
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="h-3 w-20" />
        </div>
      ),
    },
    {
      key: 'what',
      header: 'Found',
      cell: (a) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-ink">{anomalyTitle(a)}</p>
          <p className="truncate text-xs text-ink-subtle">
            {anomalyPeriod(a) ?? formatDay(a.detected_at)}
            {a.actual_ml !== null && a.expected_ml !== null && (
              <span className="md:hidden">
                {' '}
                · {litres(a.actual_ml)} of {litres(a.expected_ml)}
              </span>
            )}
          </p>
        </div>
      ),
    },
    {
      key: 'litres',
      header: 'Logged of needed',
      width: 'w-[20%]',
      hideBelow: 'md',
      align: 'right',
      cell: (a) =>
        a.actual_ml !== null && a.expected_ml !== null ? (
          <span className="tabular block text-right text-ink-muted">
            {litres(a.actual_ml)}
            <span className="block text-xs text-ink-subtle">of {litres(a.expected_ml)}</span>
          </span>
        ) : (
          <span className="block text-right text-ink-subtle">—</span>
        ),
    },
    {
      key: 'deviation',
      header: 'Off by',
      width: 'w-[10%]',
      hideBelow: 'sm',
      align: 'right',
      cell: (a) => <span className={`tabular block text-right font-semibold ${(a.deviation_pct ?? 0) > 0 ? 'text-danger' : 'text-warning'}`}>{signedPct(a.deviation_pct)}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      width: 'w-[22%]',
      hideBelow: 'lg',
      cell: (a) =>
        isClosed(a) ? (
          <div className="min-w-0">
            <Badge tone={a.status === 'resolved' ? 'success' : 'neutral'}>{a.status === 'resolved' ? 'Resolved' : 'Dismissed'}</Badge>
            <p className="mt-1 truncate text-xs text-ink-subtle">
              {a.reviewed_by_name ?? 'A deleted account'}
              {a.reviewed_at ? `, ${formatDay(a.reviewed_at)}` : ''}
            </p>
          </div>
        ) : (
          <div className="min-w-0">
            <Badge tone={a.severity === 'high' || a.severity === 'critical' ? 'danger' : 'warning'}>{a.status === 'reviewed' ? 'Reviewed' : 'Open'}</Badge>
            <p className="mt-1 truncate text-xs text-ink-subtle">Detected {formatDay(a.detected_at)}</p>
          </div>
        ),
    },
    {
      key: 'action',
      header: <span className="sr-only">Actions</span>,
      width: 'w-[104px]',
      hideBelow: 'sm',
      align: 'right',
      cell: (a) => (
        <Button size="sm" variant={isClosed(a) ? 'ghost' : 'secondary'} leadingIcon={<Eye className="h-3.5 w-3.5" />} onClick={() => onOpen(a.id)} aria-label={`${isClosed(a) ? 'View' : 'Review'} ${a.registration_number} anomaly`}>
          {isClosed(a) ? 'View' : 'Review'}
        </Button>
      ),
    },
  ]

  const views = (['needs_review', 'resolved', 'dismissed', 'all'] as const).map((v) => ({
    value: v,
    label: VIEW_LABELS[v],
    count: counts.counts[v],
    isLoading: counts.isLoading,
  }))

  return (
    <DataTable
      toolbar={
        <ViewTabs
          label="Anomaly views"
          value={view}
          options={views}
          onChange={(v) => {
            setPage(1)
            onView(v)
          }}
        />
      }
      caption={`Fuel anomalies, ${VIEW_LABELS[view].toLowerCase()}, newest first`}
      rowHeight="stacked3"
      tableId="fuel-anomalies"
      rowLabel={(a) => `${a.registration_number}, ${anomalyTitle(a)}`}
      onRowClick={(a) => onOpen(a.id)}
      columns={columns}
      data={list.data?.anomalies}
      rowKey={(a) => a.id}
      isLoading={list.isPending}
      error={list.isError ? list.error : undefined}
      onRetry={() => void list.refetch()}
      pagination={
        list.data && list.data.total > 0
          ? {
              page,
              pageSize,
              totalItems: list.data.total,
              onPageChange: setPage,
              onPageSizeChange: (size) => {
                setPageSize(size)
                setPage(1)
              },
            }
          : undefined
      }
      emptyState={
        view === 'needs_review' ? (
          <EmptyState icon={<CircleCheck />} heading="Nothing to review" description="Every fuel anomaly has been resolved or dismissed. The monthly reconciliation raises new ones on the 1st." />
        ) : (
          <EmptyState
            icon={<Search />}
            heading={`No ${VIEW_LABELS[view].toLowerCase()} anomalies`}
            action={
              <Button variant="secondary" onClick={() => onView('needs_review')}>
                Show those needing review
              </Button>
            }
          />
        )
      }
    />
  )
}

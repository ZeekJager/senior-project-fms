import { CircleCheck, Truck } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { DataTable, EmptyState, type Column } from '@/components/shared'
import { Badge, Button, Skeleton, ViewTabs } from '@/components/ui'
import { monthLabel } from '@/lib/month'
import { FIRST_ORDER, type DepotAvailability, type DowntimeKpis, type SortKey, type VehicleAvailability, type View } from './api'
import { hours, mainReason, pct, REASONS, sortRows, span } from './describe'

/** Availability as a figure with a thin meter under it: the share of the month the vehicle could work. */
function Availability({ row }: { row: Pick<DowntimeKpis, 'availability_pct'> }) {
  return (
    <span className="block">
      <span className="tabular block text-right font-semibold text-ink">{pct(row.availability_pct)}</span>
      <span className="mt-1 ml-auto block h-1 w-16 overflow-hidden rounded-full bg-surface-sunken" aria-hidden="true">
        <span className="block h-full rounded-full bg-brand" style={{ width: `${row.availability_pct ?? 0}%` }} />
      </span>
    </span>
  )
}

function Downtime({ row }: { row: Pick<DowntimeKpis, 'downtime_minutes' | 'unplanned_downtime_minutes'> }) {
  return (
    <span className="tabular block text-right text-ink">
      {row.downtime_minutes > 0 ? hours(row.downtime_minutes) : '—'}
      {row.unplanned_downtime_minutes > 0 && <span className="block text-xs text-ink-subtle">{hours(row.unplanned_downtime_minutes)} unplanned</span>}
    </span>
  )
}

/** The depots side by side (FMS-142): each one's figures, from its vehicles' time, not an average of percentages. */
export function DepotTable({ depots, onPick }: { depots: DepotAvailability[]; onPick: (depotId: string) => void }) {
  const columns: Column<DepotAvailability>[] = [
    {
      key: 'depot',
      header: 'Depot',
      cell: (d) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-ink">{d.depot_name}</p>
          <p className="text-xs text-ink-subtle">
            {d.vehicles} {d.vehicles === 1 ? 'vehicle' : 'vehicles'}
          </p>
        </div>
      ),
    },
    { key: 'availability', header: 'Available', width: 'w-[16%]', align: 'right', cell: (d) => <Availability row={d} /> },
    { key: 'downtime', header: 'Down', width: 'w-[18%]', align: 'right', hideBelow: 'sm', cell: (d) => <Downtime row={d} /> },
    { key: 'mtbf', header: 'MTBF', width: 'w-[14%]', align: 'right', hideBelow: 'md', cell: (d) => <span className="tabular block text-right text-ink-muted">{span(d.mtbf_minutes)}</span> },
    { key: 'mttr', header: 'MTTR', width: 'w-[14%]', align: 'right', hideBelow: 'md', cell: (d) => <span className="tabular block text-right text-ink-muted">{span(d.mttr_minutes)}</span> },
  ]
  return (
    <section aria-labelledby="depots-heading" className="space-y-3">
      <h2 id="depots-heading" className="text-base font-semibold text-ink">
        By depot
      </h2>
      <DataTable caption="Availability by depot" rowHeight="stacked" columns={columns} data={depots} rowKey={(d) => d.depot_id} isLoading={false} rowLabel={(d) => d.depot_name} onRowClick={(d) => onPick(d.depot_id)} />
    </section>
  )
}

interface VehicleTableProps {
  month: string
  rows: VehicleAvailability[] | undefined
  isLoading: boolean
  error: unknown
  onRetry: () => void
  view: View
  onView: (view: View) => void
  sort: SortKey
  order: 'asc' | 'desc'
  onSort: (sort: SortKey, order: 'asc' | 'desc') => void
  onOpen: (vehicleId: string) => void
}

/**
 * The month by vehicle (S-33, FMS-142): most downtime first, sortable by any figure. A row opens the vehicle's
 * periods. Every vehicle comes at once (a fleet is a few hundred), so sorting and paging are here, not a request.
 */
export function VehicleTable({ month, rows, isLoading, error, onRetry, view, onView, sort, order, onSort, onOpen }: VehicleTableProps) {
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  useEffect(() => setPage(1), [month, view, sort, order])

  const down = useMemo(() => (rows ?? []).filter((r) => r.downtime_minutes > 0), [rows])
  const shown = useMemo(() => sortRows(view === 'down' ? down : (rows ?? []), sort, order), [rows, down, view, sort, order])
  const pageRows = rows ? shown.slice((page - 1) * pageSize, page * pageSize) : undefined

  const columns: Column<VehicleAvailability>[] = [
    {
      key: 'vehicle',
      header: 'Vehicle',
      sortKey: 'plate',
      cell: (r) => (
        <div className="min-w-0">
          <p className="plate whitespace-nowrap text-ink">{r.registration_number}</p>
          <p className="truncate text-xs text-ink-subtle xl:hidden">{r.depot_name}</p>
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
    { key: 'availability', header: 'Available', sortKey: 'availability', width: 'w-[24%] sm:w-[12%]', align: 'right', cell: (r) => <Availability row={r} /> },
    { key: 'downtime', header: 'Down', sortKey: 'downtime', width: 'w-[24%] sm:w-[14%]', align: 'right', cell: (r) => <Downtime row={r} /> },
    {
      key: 'failures',
      header: 'Failures',
      sortKey: 'failures',
      width: 'w-[10%]',
      align: 'right',
      hideBelow: 'lg',
      cell: (r) => <span className="tabular block text-right text-ink-muted">{r.failures || '—'}</span>,
    },
    { key: 'mtbf', header: 'MTBF', sortKey: 'mtbf', width: 'w-[11%]', align: 'right', hideBelow: 'lg', cell: (r) => <span className="tabular block text-right text-ink-muted">{span(r.mtbf_minutes)}</span> },
    { key: 'mttr', header: 'MTTR', sortKey: 'mttr', width: 'w-[11%]', align: 'right', hideBelow: 'md', cell: (r) => <span className="tabular block text-right text-ink-muted">{span(r.mttr_minutes)}</span> },
    {
      key: 'reason',
      header: 'Mostly',
      width: 'w-[150px]',
      hideBelow: 'sm',
      cell: (r) => {
        const main = mainReason(r)
        return main ? <Badge tone={REASONS[main].tone}>{REASONS[main].label}</Badge> : <span className="text-xs text-ink-subtle">Not down</span>
      },
      skeleton: <Skeleton className="h-6 w-20 rounded-full" />,
    },
  ]

  return (
    <DataTable
      toolbar={
        <ViewTabs
          label="Vehicles shown"
          value={view}
          options={[
            { value: 'all', label: 'All vehicles', count: rows?.length, isLoading, hint: 'Every vehicle in the fleet in the month' },
            { value: 'down', label: 'With downtime', count: rows ? down.length : undefined, isLoading, hint: 'Out of service at some time in the month' },
          ]}
          onChange={onView}
        />
      }
      caption={`Availability by vehicle, ${monthLabel(month)}`}
      rowHeight="stacked"
      tableId="fleet-availability"
      rowLabel={(r) => r.registration_number}
      columns={columns}
      data={pageRows}
      rowKey={(r) => r.vehicle_id}
      isLoading={isLoading}
      error={error ?? undefined}
      onRetry={onRetry}
      onRowClick={(r) => onOpen(r.vehicle_id)}
      sort={{
        key: sort,
        order,
        onChange: (key) => {
          const next = key as SortKey
          onSort(next, next === sort ? (order === 'asc' ? 'desc' : 'asc') : FIRST_ORDER[next])
        },
      }}
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
        view === 'down' && rows?.length ? (
          <EmptyState
            icon={<CircleCheck />}
            heading={`No vehicle was down in ${monthLabel(month)}`}
            description="Every vehicle was available the whole month."
            action={
              <Button variant="secondary" onClick={() => onView('all')}>
                Show every vehicle
              </Button>
            }
          />
        ) : (
          <EmptyState icon={<Truck />} heading={`No vehicles in ${monthLabel(month)}`} description="No vehicle in your depots was in the fleet that month." />
        )
      }
    />
  )
}

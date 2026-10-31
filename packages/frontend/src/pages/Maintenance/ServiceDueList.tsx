import { ArrowUpRight, CalendarCheck2, CalendarClock, Wrench } from 'lucide-react'
import { Link } from 'react-router-dom'
import { DataTable, EmptyState, ListToolbar, type Column, type ListToolbarViews } from '@/components/shared'
import { Badge, Button, FilterSelect } from '@/components/ui'
import { formatDate } from '@/features/documents/expiry'
import { ServiceDueBadge, dueText, useServiceDue, type DueFilters, type ServiceDue } from '@/features/service-due'
import type { RepairPreset } from './LogRepairDrawer'

const DUE_FILTERS: { value: DueFilters['status']; label: string }[] = [
  { value: 'attention', label: 'Due and overdue' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'due', label: 'Due' },
]

/** "Next at 10,000 km · 30 Jun 2026 · 250 engine hours": where each measure falls due. */
function nextText(d: ServiceDue): string {
  return [
    d.next_due.odometer_km !== null ? `${d.next_due.odometer_km.toLocaleString('en-US')} km` : null,
    d.next_due.at ? formatDate(d.next_due.at.slice(0, 10)) : null,
    d.next_due.engine_hours !== null ? `${d.next_due.engine_hours.toLocaleString('en-US')} engine hours` : null,
  ]
    .filter(Boolean)
    .join(' · ')
}

interface ServiceDueListProps<V extends string> {
  /** The repair log's views, so the switch stays where it is. */
  views: ListToolbarViews<V>
  filters: DueFilters
  onFilters: (patch: Partial<DueFilters>) => void
  depots: { id: string; name: string }[]
  /** Given when the user may log work: opens the job card for this service. */
  onLog?: (preset: RepairPreset) => void
}

/**
 * S-08 Service due (FMS-129): the vehicles due or overdue under their service programs, most urgent
 * first, each with what made it due and a job card to log the service.
 */
export function ServiceDueList<V extends string>({ views, filters, onFilters, depots, onLog }: ServiceDueListProps<V>) {
  const list = useServiceDue(filters)

  const columns: Column<ServiceDue>[] = [
    {
      key: 'vehicle',
      header: 'Vehicle',
      cell: (d) => (
        <div className="min-w-0">
          <p className="plate truncate text-ink">{d.registration_number}</p>
          <p className="truncate text-xs text-ink-subtle">{d.program.name}</p>
        </div>
      ),
    },
    { key: 'status', header: 'Status', width: 'w-[128px]', cell: (d) => <ServiceDueBadge status={d.status} /> },
    {
      key: 'due',
      header: 'When',
      width: 'w-[34%]',
      hideBelow: 'md',
      cell: (d) => (
        <div className="min-w-0">
          <p className="text-sm text-ink">{dueText(d)}</p>
          <p className="truncate text-xs text-ink-subtle">
            Next at {nextText(d)}
            {d.last_service ? ` · last done ${formatDate(d.last_service.completed_at.slice(0, 10))}` : ' · no service on record'}
          </p>
        </div>
      ),
    },
    {
      key: 'action',
      header: <span className="sr-only">Actions</span>,
      width: 'w-[136px]',
      align: 'right',
      cell: (d) =>
        d.open_record ? (
          <Badge tone="info" icon={<CalendarCheck2 aria-hidden="true" />}>
            Booked
          </Badge>
        ) : onLog ? (
          <Button
            size="sm"
            variant="secondary"
            leadingIcon={<Wrench className="h-3.5 w-3.5" />}
            onClick={() =>
              onLog({
                vehicle: { id: d.vehicle_id, registration_number: d.registration_number },
                type: 'preventive',
                description: d.program.tasks.length ? `${d.program.name}: ${d.program.tasks.join(', ')}` : d.program.name,
                programId: d.program.id,
              })
            }
            aria-label={`Log ${d.program.name} on ${d.registration_number}`}
          >
            Log service
          </Button>
        ) : null,
      skeleton: <span />,
    },
  ]

  return (
    <DataTable
      toolbar={
        <ListToolbar views={views} onClear={filters.status !== 'attention' || filters.depotId ? () => onFilters({ status: 'attention', depotId: '' }) : undefined}>
          <FilterSelect label="Status" icon={<CalendarClock />} value={filters.status} emptyValue="attention" options={DUE_FILTERS} onChange={(status) => onFilters({ status })} />
          {depots.length > 1 && (
            <FilterSelect
              label="Depot"
              value={filters.depotId}
              emptyValue=""
              options={[{ value: '', label: 'All depots' }, ...depots.map((d) => ({ value: d.id, label: d.name }))]}
              onChange={(depotId) => onFilters({ depotId })}
            />
          )}
        </ListToolbar>
      }
      caption="Service due"
      rowHeight="stacked"
      columns={columns}
      data={list.data?.items}
      rowKey={(d) => `${d.vehicle_id}:${d.program.id}`}
      rowLabel={(d) => `${d.registration_number} ${d.program.name}`}
      isLoading={list.isPending}
      error={list.isError ? list.error : undefined}
      onRetry={() => void list.refetch()}
      pagination={list.data ? { page: filters.page, pageSize: 25, totalItems: list.data.meta.total_items, onPageChange: (page) => onFilters({ page }) } : undefined}
      emptyState={
        <EmptyState
          icon={<CalendarCheck2 />}
          heading={filters.status === 'overdue' ? 'Nothing overdue' : 'No service due'}
          description="Vehicles appear here as they come within a service program's window. Programs say how often each kind of vehicle is serviced."
          action={
            <Link to="/service-programs" className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-ink hover:underline">
              Service programs
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          }
        />
      }
    />
  )
}

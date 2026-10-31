import { ArrowUpRight, Building2, CalendarClock, Eye, Pencil, Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { DataTable, EmptyState, ListToolbar, type Column } from '@/components/shared'
import { Badge, Button, FilterSelect } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { useDepots } from '@/features/depots'
import {
  ServiceDueBadge,
  coverageText,
  intervalsText,
  leadText,
  seesEveryDepot,
  useProgramCounts,
  useServiceDueCount,
  useServicePrograms,
  type ProgramFilters,
  type ServiceProgram,
} from '@/features/service-due'
import { ProgramFormDrawer } from './ProgramFormDrawer'
import { RetireProgramDialog } from './RetireProgramDialog'

function readFilters(params: URLSearchParams): ProgramFilters {
  const page = Number.parseInt(params.get('page') ?? '', 10)
  return {
    status: params.get('view') === 'retired' ? 'retired' : 'active',
    depotId: params.get('depot') ?? '',
    page: Number.isInteger(page) && page > 0 ? page : 1,
  }
}

function writeFilters(f: ProgramFilters): URLSearchParams {
  const p = new URLSearchParams()
  if (f.status === 'retired') p.set('view', 'retired')
  if (f.depotId) p.set('depot', f.depotId)
  if (f.page > 1) p.set('page', String(f.page))
  return p
}

/**
 * S-23 Service programs (FMS-129): how often each kind of vehicle is serviced, by distance, time and
 * engine hours, whichever comes first, and how many vehicles each finds due or overdue. Fleet managers
 * and depot admins define them; the repair log lists the vehicles due.
 */
export function ServiceProgramsPage() {
  const { hasPermission, session } = useAuth()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const filters = useMemo(() => readFilters(params), [params])
  const canWrite = hasPermission('service-program:write')
  const everyDepot = seesEveryDepot(session?.roles ?? [])

  function update(patch: Partial<ProgramFilters>) {
    setParams(writeFilters({ ...filters, page: 1, ...patch }), { replace: true })
  }

  const list = useServicePrograms(filters)
  const counts = useProgramCounts(filters.depotId)
  const depots = useDepots()
  const depotNames = useMemo(() => new Map((depots.data ?? []).map((d) => [d.id, d.name])), [depots.data])
  const manyDepots = (depots.data?.length ?? 0) > 1

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<ServiceProgram | null>(null)
  const [retiring, setRetiring] = useState<ServiceProgram | null>(null)

  /** A depot admin sees fleet-wide programs but changes only their depot's. */
  const editable = (p: ServiceProgram) => canWrite && (p.depot_id !== null || everyDepot)

  function open(program: ServiceProgram | null) {
    setEditing(program)
    setFormOpen(true)
  }

  const columns: Column<ServiceProgram>[] = [
    {
      key: 'program',
      header: 'Program',
      cell: (p) => (
        <div className="min-w-0">
          <p className="flex items-center gap-2 truncate font-semibold text-ink">
            <span className="truncate">{p.name}</span>
            {!p.is_active && <Badge tone="neutral">Retired</Badge>}
          </p>
          <p className="truncate text-xs text-ink-subtle">
            {p.depot_id === null ? 'Fleet-wide' : (depotNames.get(p.depot_id) ?? 'Depot')} · {coverageText(p)}
          </p>
        </div>
      ),
    },
    {
      key: 'interval',
      header: 'When',
      width: 'w-[34%]',
      hideBelow: 'md',
      cell: (p) => (
        <div className="min-w-0">
          <p className="text-sm text-ink">{intervalsText(p)}</p>
          <p className="text-xs text-ink-subtle">
            {leadText(p)}
            {p.tasks.length > 0 && ` · ${p.tasks.length} task${p.tasks.length === 1 ? '' : 's'}`}
          </p>
        </div>
      ),
    },
    {
      key: 'vehicles',
      header: 'Vehicles',
      width: 'w-[200px]',
      cell: (p) =>
        !p.is_active ? (
          <span className="text-sm text-ink-subtle">—</span>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            {p.vehicles.overdue > 0 && <ServiceDueBadge status="overdue">{p.vehicles.overdue} overdue</ServiceDueBadge>}
            {p.vehicles.due > 0 && <ServiceDueBadge status="due">{p.vehicles.due} due</ServiceDueBadge>}
            <span className="tabular text-xs text-ink-subtle">
              {p.vehicles.total.toLocaleString('en-US')} vehicle{p.vehicles.total === 1 ? '' : 's'}
            </span>
          </div>
        ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      width: 'w-[104px]',
      align: 'right',
      hideBelow: 'sm',
      cell: (p) =>
        editable(p) ? (
          <Button size="sm" variant="secondary" leadingIcon={<Pencil className="h-3.5 w-3.5" />} onClick={(e) => {
              e.stopPropagation()
              open(p)
            }}
            aria-label={`Edit ${p.name}`}>
            Edit
          </Button>
        ) : (
          <Button size="sm" variant="secondary" leadingIcon={<Eye className="h-3.5 w-3.5" />} onClick={(e) => {
              e.stopPropagation()
              open(p)
            }}
            aria-label={`View ${p.name}`}>
            View
          </Button>
        ),
      skeleton: <span />,
    },
  ]

  const canSeeDue = hasPermission({ all: ['maintenance:read', 'vehicle:read'] })
  const attention = useServiceDueCount(canSeeDue).data ?? 0

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-3 border-b border-line pb-5 sm:items-center">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">Service programs</h1>
          <p className="mt-1 max-w-xl text-sm text-ink-muted">
            How often each kind of vehicle is serviced: by kilometres, days or engine hours, whichever comes first.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 self-start sm:self-auto">
          {canSeeDue && (
            <Button variant="secondary" trailingIcon={<ArrowUpRight className="h-3.5 w-3.5" />} onClick={() => navigate('/maintenance?view=service')} title="Opens the repair log's Service due view">
              Service due{attention > 0 ? ` · ${attention}` : ''}
            </Button>
          )}
          {canWrite && (
            <Button leadingIcon={<Plus className="h-4 w-4" />} onClick={() => open(null)}>
              Add program
            </Button>
          )}
        </div>
      </header>

      <section aria-label="Service program list">
        <DataTable
          toolbar={
            <ListToolbar
              views={{
                label: 'Program views',
                value: filters.status,
                options: [
                  { value: 'active', label: 'Active', count: counts.data?.active, isLoading: counts.isPending, hint: 'Scheduling service now' },
                  { value: 'retired', label: 'Retired', count: counts.data?.retired, isLoading: counts.isPending, archived: true, hint: 'Kept with the repairs that carried them out' },
                ],
                onChange: (status) => update({ status }),
              }}
              onClear={filters.depotId ? () => update({ depotId: '' }) : undefined}
            >
              {manyDepots && (
                <FilterSelect
                  label="Depot"
                  icon={<Building2 />}
                  value={filters.depotId}
                  emptyValue=""
                  options={[{ value: '', label: 'All depots' }, ...(depots.data ?? []).map((d) => ({ value: d.id, label: d.name }))]}
                  onChange={(depotId) => update({ depotId })}
                />
              )}
            </ListToolbar>
          }
          caption="Service programs"
          rowHeight="stacked"
          columns={columns}
          data={list.data?.programs}
          rowKey={(p) => p.id}
          rowLabel={(p) => p.name}
          onRowClick={(p) => open(p)}
          isLoading={list.isPending}
          error={list.isError ? list.error : undefined}
          onRetry={() => void list.refetch()}
          pagination={list.data ? { page: filters.page, pageSize: 50, totalItems: list.data.meta.total_items, onPageChange: (page) => setParams(writeFilters({ ...filters, page })) } : undefined}
          emptyState={
            filters.status === 'retired' ? (
              <EmptyState icon={<CalendarClock />} heading="No retired programs" description="Programs you retire are kept here with the repairs that carried them out." />
            ) : (
              <EmptyState
                icon={<CalendarClock />}
                heading="No service programs yet"
                description="Define how often vehicles are serviced, and the vehicles due appear in the repair log and on the dispatch board."
                action={
                  canWrite && (
                    <Button leadingIcon={<Plus className="h-4 w-4" />} onClick={() => open(null)}>
                      Add program
                    </Button>
                  )
                }
              />
            )
          }
        />
      </section>

      <ProgramFormDrawer
        open={formOpen}
        onClose={() => setFormOpen(false)}
        program={editing}
        depots={depots.data ?? []}
        everyDepot={everyDepot}
        readOnly={editing !== null && !editable(editing)}
        onRetire={
          editing && editable(editing)
            ? () => {
                setFormOpen(false)
                setRetiring(editing)
              }
            : undefined
        }
      />
      <RetireProgramDialog program={retiring} onClose={() => setRetiring(null)} />
    </div>
  )
}

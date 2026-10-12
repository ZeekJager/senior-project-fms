import { AlertTriangle, ClipboardCheck, Package, Plus, Search, Wrench } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { RoleGate } from '@/components/RoleGate'
import { DataTable, EmptyState, MoneyDisplay, StatCard, StatShare, StatusBadge, type Column } from '@/components/shared'
import { Badge, Button, Combobox, Dialog, type ComboboxOption } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { formatDate } from '@/features/documents/expiry'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import type { Vehicle } from '@/pages/Vehicles/types'
import { TYPE_LABELS, useBelowReorder, useRecords, useVehicleSearch, useWorkshopCounts, type MaintenanceRecord, type RecordFilters } from './api'
import { LogRepairDrawer, type CorrectionOf } from './LogRepairDrawer'
import { RecordDrawer } from './RecordDrawer'

function readFilters(params: URLSearchParams): RecordFilters {
  const view = params.get('view')
  const page = Number.parseInt(params.get('page') ?? '', 10)
  return {
    view: view === 'completed' || view === 'all' ? view : 'open',
    vehicleId: params.get('vehicle') ?? '',
    page: Number.isInteger(page) && page > 0 ? page : 1,
  }
}

/**
 * S-08 Technician repair log (FMS-24): open work first, every repair one
 * click away, and a job card to log the next. Replaces the paper cards.
 */
export function MaintenancePage() {
  const { hasPermission } = useAuth()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const filters = useMemo(() => readFilters(params), [params])
  const canWrite = hasPermission('maintenance:write')
  const canInventory = hasPermission('inventory:read')

  function update(patch: Partial<RecordFilters>) {
    const next = { ...filters, page: 1, ...patch }
    const p = new URLSearchParams()
    if (next.view !== 'open') p.set('view', next.view)
    if (next.vehicleId) p.set('vehicle', next.vehicleId)
    if (next.page > 1) p.set('page', String(next.page))
    setParams(p, { replace: true })
  }

  const list = useRecords(filters)
  const workshop = useWorkshopCounts(canInventory)
  const [logging, setLogging] = useState(false)
  const [correctionOf, setCorrectionOf] = useState<CorrectionOf | null>(null)
  const [viewing, setViewing] = useState<MaintenanceRecord | null>(null)
  const [showReorder, setShowReorder] = useState(false)
  const reorder = useBelowReorder(showReorder)

  // Vehicle filter: search any vehicle by plate.
  const [vehicleQuery, setVehicleQuery] = useState('')
  const [vehicleFilter, setVehicleFilter] = useState<ComboboxOption<Vehicle> | null>(null)
  const vehicleSearch = useVehicleSearch(useDebouncedValue(vehicleQuery, 250))
  const vehicleOptions = (vehicleSearch.data ?? []).map((v): ComboboxOption<Vehicle> => ({ value: v, key: v.id, label: v.registration_number, detail: `${v.make} ${v.model}` }))

  const columns: Column<MaintenanceRecord>[] = [
    {
      key: 'vehicle',
      header: 'Vehicle',
      cell: (r) => (
        <div className="min-w-0">
          <p className="truncate font-semibold tracking-wide text-ink">{r.registration_number}</p>
          <p className="truncate text-xs text-ink-subtle">{TYPE_LABELS[r.maintenance_type]}</p>
        </div>
      ),
    },
    { key: 'work', header: 'Work done', width: 'w-[34%]', hideBelow: 'md', cell: (r) => <p className="line-clamp-2 text-sm text-ink-muted">{r.description}</p> },
    { key: 'status', header: 'Status', width: 'w-[128px]', cell: (r) => <StatusBadge status={r.status} /> },
    {
      key: 'parts',
      header: 'Parts',
      width: 'w-[88px]',
      hideBelow: 'lg',
      cell: (r) => (r.parts.length ? <Badge>{r.parts.reduce((n, p) => n + p.quantity, 0)} items</Badge> : <span className="text-ink-subtle">—</span>),
    },
    { key: 'cost', header: 'Total', width: 'w-[136px]', align: 'right', hideBelow: 'sm', cell: (r) => <MoneyDisplay amountMinorUnits={r.total_cost_cents} className="font-medium" /> },
    {
      key: 'when',
      header: filters.view === 'completed' ? 'Completed' : 'Logged',
      width: 'w-[120px]',
      hideBelow: 'lg',
      cell: (r) => <span className="tabular text-sm text-ink-muted">{formatDate((r.completed_at ?? r.created_at).slice(0, 10))}</span>,
    },
    {
      key: 'open',
      header: <span className="sr-only">Actions</span>,
      width: 'w-[96px]',
      align: 'right',
      cell: (r) => (
        <Button size="sm" variant="ghost" onClick={() => setViewing(r)} aria-label={`View ${r.registration_number} ${TYPE_LABELS[r.maintenance_type]}`}>
          View
        </Button>
      ),
      skeleton: <span />,
    },
  ]

  const pct = (n?: number, of?: number) => (n === undefined || !of ? 0 : Math.round((n * 100) / of))

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 border-b border-line pb-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">Repair log</h1>
          <p className="mt-1 max-w-xl text-sm text-ink-muted">Every repair on every vehicle, with parts and costs. Open work comes first.</p>
        </div>
        <RoleGate permission="maintenance:write">
          <Button
            leadingIcon={<Plus className="h-4 w-4" />}
            onClick={() => {
              setCorrectionOf(null)
              setLogging(true)
            }}
            className="self-start sm:self-auto"
          >
            Log a repair
          </Button>
        </RoleGate>
      </header>

      <section aria-label="Workshop summary" className="stat-strip">
        <StatCard
          label="Open work"
          value={workshop.counts.open}
          isLoading={workshop.isLoading}
          icon={<Wrench />}
          tone="brand"
          pressed={filters.view === 'open'}
          onClick={() => update({ view: 'open' })}
          footer={<StatShare value={pct(workshop.counts.open, (workshop.counts.open ?? 0) + (workshop.counts.completed ?? 0))} tone="brand" caption="of all logged work" />}
        />
        <StatCard
          label="Completed"
          value={workshop.counts.completed}
          isLoading={workshop.isLoading}
          icon={<ClipboardCheck />}
          tone="success"
          pressed={filters.view === 'completed'}
          onClick={() => update({ view: 'completed' })}
          footer={<StatShare value={pct(workshop.counts.completed, (workshop.counts.open ?? 0) + (workshop.counts.completed ?? 0))} tone="success" caption="closed job cards" />}
        />
        <StatCard
          label="Vehicles flagged"
          value={workshop.counts.flagged}
          isLoading={workshop.isLoading}
          icon={<AlertTriangle />}
          tone="warning"
          pressed={false}
          onClick={() => navigate('/vehicles?flagged=1')}
          footer={<span className="text-xs text-ink-subtle">Waiting for the workshop · see vehicles</span>}
        />
        {canInventory && (
          <StatCard
            label="Parts to reorder"
            value={workshop.counts.reorder}
            isLoading={workshop.counts.reorder === undefined}
            icon={<Package />}
            tone="danger"
            pressed={false}
            onClick={() => setShowReorder(true)}
            footer={<span className="text-xs text-ink-subtle">At or below reorder level · show list</span>}
          />
        )}
      </section>

      <section aria-label="Repairs" className="space-y-0">

        <DataTable

          toolbar={
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
          <div role="tablist" aria-label="Which work" className="inline-flex h-10 shrink-0 items-center gap-1 self-start rounded-control bg-surface-sunken p-1">
            {(['open', 'completed', 'all'] as const).map((v) => (
              <button
                key={v}
                role="tab"
                type="button"
                aria-selected={filters.view === v}
                onClick={() => update({ view: v })}
                className={
                  filters.view === v
                    ? 'focus-ring h-8 rounded-control bg-surface px-3.5 text-sm font-medium text-ink '
                    : 'focus-ring h-8 rounded-control px-3.5 text-sm text-ink-muted transition-colors hover:text-ink'
                }
              >
                {v === 'open' ? 'Open work' : v === 'completed' ? 'Completed' : 'All'}
              </button>
            ))}
          </div>
          <Combobox
            className="lg:w-80 [&>p]:mt-0 [&>p]:min-h-0"
            label="Filter by vehicle"
            hideLabel
            value={vehicleFilter}
            onChange={(option) => {
              setVehicleFilter(option)
              update({ vehicleId: option?.value.id ?? '' })
            }}
            query={vehicleQuery}
            onQueryChange={setVehicleQuery}
            options={vehicleOptions}
            loading={vehicleSearch.isFetching}
            emptyText={vehicleQuery ? 'No vehicle matches' : 'Type a plate'}
          />
        </div>

          }
          caption="Repairs"
          columns={columns}
          data={list.data?.records}
          rowKey={(r) => r.id}
          isLoading={list.isPending}
          error={list.isError ? list.error : undefined}
          onRetry={() => void list.refetch()}
          pagination={list.data ? { page: filters.page, pageSize: 25, totalItems: list.data.meta.total_items, onPageChange: (page) => update({ page }) } : undefined}
          emptyState={
            <EmptyState
              icon={filters.vehicleId ? <Search /> : <ClipboardCheck />}
              heading={filters.view === 'open' ? 'No open work' : 'No repairs logged yet'}
              description={filters.view === 'open' ? 'Every job card is closed. New repairs appear here until they are completed.' : 'Logged repairs appear here with their parts and costs.'}
              action={
                canWrite && (
                  <Button leadingIcon={<Plus className="h-4 w-4" />} onClick={() => setLogging(true)}>
                    Log a repair
                  </Button>
                )
              }
            />
          }
        />
      </section>

      <LogRepairDrawer
        open={logging}
        onClose={() => {
          setLogging(false)
          setCorrectionOf(null)
        }}
        canInventory={canInventory}
        correctionOf={correctionOf}
      />
      <RecordDrawer
        record={viewing}
        onClose={() => setViewing(null)}
        canWrite={canWrite}
        onCorrect={(r) => {
          setViewing(null)
          setCorrectionOf({ id: r.id, vehicle: { value: { id: r.vehicle_id, registration_number: r.registration_number }, key: r.vehicle_id, label: r.registration_number } })
          setLogging(true)
        }}
      />
      <Dialog open={showReorder} onClose={() => setShowReorder(false)} title="Parts to reorder" description="At or below their reorder level, lowest stock first.">
        {reorder.isPending ? (
          <p className="text-sm text-ink-subtle">Loading…</p>
        ) : (reorder.data ?? []).length === 0 ? (
          <p className="text-sm text-ink-muted">Nothing to reorder.</p>
        ) : (
          <ul className="max-h-80 divide-y divide-line overflow-auto">
            {(reorder.data ?? []).map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 py-2.5">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-ink">{p.name}</span>
                  <span className="block text-xs text-ink-subtle">
                    {p.part_number} · reorder at {p.reorder_threshold}
                  </span>
                </span>
                <Badge tone={p.stock_status === 'out' ? 'danger' : 'warning'} dot>
                  {p.stock_quantity} in stock
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Dialog>
    </div>
  )
}

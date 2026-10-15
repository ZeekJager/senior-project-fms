import { ClipboardCheck, Plus, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { RoleGate } from '@/components/RoleGate'
import { DataTable, EmptyState, ListToolbar, MoneyDisplay, StatusBadge, type Column } from '@/components/shared'
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

/** "1 item", "3 items". */
const partCount = (n: number) => `${n.toLocaleString()} ${n === 1 ? 'item' : 'items'}`

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
          <p className="plate truncate text-ink">{r.registration_number}</p>
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
      cell: (r) => (r.parts.length ? <Badge>{partCount(r.parts.reduce((n, p) => n + p.quantity, 0))}</Badge> : <span className="text-ink-subtle">—</span>),
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


  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-3 border-b border-line pb-5 sm:items-center">
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

      <section aria-label="Repairs" className="space-y-0">

        <DataTable

          toolbar={
            <ListToolbar
              views={{
                label: 'Repair views',
                value: filters.view,
                options: [
                  { value: 'open', label: 'Open work', count: workshop.counts.open, isLoading: workshop.isLoading },
                  { value: 'completed', label: 'Completed', count: workshop.counts.completed, isLoading: workshop.isLoading },
                  {
                    value: 'all',
                    label: 'All',
                    count: workshop.counts.open === undefined || workshop.counts.completed === undefined ? undefined : workshop.counts.open + workshop.counts.completed,
                    isLoading: workshop.isLoading,
                  },
                ],
                onChange: (view) => update({ view }),
              }}
              onClear={
                filters.vehicleId
                  ? () => {
                      setVehicleFilter(null)
                      update({ vehicleId: '' })
                    }
                  : undefined
              }
            >
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
              <Button variant="ghost" onClick={() => navigate('/vehicles?flagged=1')} title="Opens Vehicles, filtered to flagged">
                Flagged vehicles{workshop.counts.flagged === undefined ? '' : ` · ${workshop.counts.flagged}`}
              </Button>
              {canInventory && (
                <Button variant="ghost" onClick={() => setShowReorder(true)} title="Opens the list of parts at or below their reorder level">
                  Parts to reorder{workshop.counts.reorder === undefined ? '' : ` · ${workshop.counts.reorder}`}
                </Button>
              )}
            </ListToolbar>
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

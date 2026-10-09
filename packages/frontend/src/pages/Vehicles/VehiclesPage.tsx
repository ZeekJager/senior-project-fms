import { Activity, Building2, Plus, Search, SlidersHorizontal, Truck, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { DataTable, EmptyState } from '@/components/shared'
import { Button, cn, FilterSelect, Spinner } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { useDepots, useFleetCounts, useVehicleDocuments, useVehicles } from './api'
import { vehicleColumns } from './columns'
import { DecommissionDialog } from './DecommissionDialog'
import { DocumentsDrawer } from './DocumentsDrawer'
import { documentHealth } from './documents'
import { FleetStats } from './FleetStats'
import { hasActiveFilters, readFilters, writeFilters, type VehicleFilters } from './filters'
import { VehicleFormDrawer } from './VehicleFormDrawer'
import type { Vehicle, VehicleStatus } from './types'

const STATUS_OPTIONS: { value: VehicleStatus | ''; label: string; dot?: string }[] = [
  { value: '', label: 'All' },
  { value: 'active', label: 'Active', dot: 'bg-emerald-500' },
  { value: 'maintenance', label: 'Maintenance', dot: 'bg-orange-500' },
  { value: 'inactive', label: 'Inactive', dot: 'bg-slate-400' },
  { value: 'retired', label: 'Retired', dot: 'bg-slate-300' },
]

/**
 * S-04 Vehicle Management (FMS-18): the whole fleet's state in one place
 * (status, maintenance flags, current trips, document expiry) so dispatch
 * decisions need no phone call to the depot.
 */
export function VehiclesPage() {
  const { hasPermission } = useAuth()
  const [params, setParams] = useSearchParams()
  const filters = useMemo(() => readFilters(params), [params])

  const canWrite = hasPermission('vehicle:write')
  const canDelete = hasPermission('vehicle:delete')
  const canReadDocs = hasPermission('document:read')
  const canUploadDocs = hasPermission('document:write')
  const canDeleteDocs = hasPermission('document:delete')

  function update(patch: Partial<VehicleFilters>, options: { keepPage?: boolean } = {}) {
    const next = { ...filters, ...patch, ...(options.keepPage ? {} : { page: 1 }) }
    setParams(writeFilters(next), { replace: true })
  }

  // Search: what is typed shows at once; the request waits until typing pauses.
  const [searchText, setSearchText] = useState(filters.search)
  const debouncedSearch = useDebouncedValue(searchText, 300)
  // Runs only when the debounced text settles, not on every filter change.
  useEffect(() => {
    if (debouncedSearch !== filters.search) update({ search: debouncedSearch })
  }, [debouncedSearch])

  const list = useVehicles(filters)
  const depots = useDepots()
  const fleet = useFleetCounts(filters.depotId)
  const vehicles = list.data?.vehicles
  const vehicleIds = useMemo(() => (vehicles ?? []).map((v) => v.id), [vehicles])
  const docs = useVehicleDocuments(vehicleIds, canReadDocs)
  const health = useMemo(() => documentHealth(docs.data ?? []), [docs.data])
  const depotMap = useMemo(() => new Map((depots.data ?? []).map((d) => [d.id, d])), [depots.data])

  const [editing, setEditing] = useState<Vehicle | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [decommissioning, setDecommissioning] = useState<Vehicle | null>(null)
  const [docsFor, setDocsFor] = useState<Vehicle | null>(null)
  const [stagedFile, setStagedFile] = useState<File | null>(null)
  const filePicker = useRef<HTMLInputElement>(null)
  const pickingFor = useRef<Vehicle | null>(null)

  const openCreate = () => {
    setEditing(null)
    setFormOpen(true)
  }

  const columns = vehicleColumns({
    depots: depotMap,
    documents: { health, isLoading: docs.isPending && docs.fetchStatus !== 'idle', canRead: canReadDocs, canWrite: canUploadDocs },
    canWrite,
    canDelete,
    onEdit: (v) => {
      setEditing(v)
      setFormOpen(true)
    },
    onDecommission: setDecommissioning,
    onOpenDocuments: (v) => {
      setStagedFile(null)
      setDocsFor(v)
    },
    // The + button opens the file picker straight away; the drawer then asks for the type and expiry.
    onAddDocument: (v) => {
      pickingFor.current = v
      if (filePicker.current) {
        filePicker.current.value = ''
        filePicker.current.click()
      }
    },
  })

  const depotOptions = [{ value: '', label: 'All depots' }, ...(depots.data ?? []).map((d) => ({ value: d.id, label: d.name }))]
  const showDepotFilter = (depots.data?.length ?? 0) > 1
  const filtered = hasActiveFilters(filters)
  const scopeName = filters.depotId ? depotMap.get(filters.depotId)?.name : depots.data?.length === 1 ? depots.data[0].name : null

  return (
    <div className="space-y-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-line bg-surface/70 px-2.5 py-1 text-xs font-medium text-ink-muted shadow-soft backdrop-blur">
            <Activity className="h-3.5 w-3.5 text-brand-ink" aria-hidden="true" />
            Fleet operations
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">Vehicles</h1>
          <p className="mt-1.5 max-w-xl text-sm text-ink-muted">
            Registration, maintenance and trip status for every vehicle{scopeName ? ` in ${scopeName}` : ' across your depots'}.
          </p>
        </div>
        {canWrite && (
          <Button size="lg" leadingIcon={<Plus className="h-4 w-4" />} onClick={openCreate} className="self-start sm:self-auto">
            Add vehicle
          </Button>
        )}
      </header>

      <FleetStats
        counts={fleet.counts}
        isLoading={fleet.isLoading}
        filters={filters}
        onSelect={(focus) => {
          if (focus === 'all') update({ status: '', flagged: false })
          else if (focus === 'flagged') update({ status: '', flagged: !(filters.flagged && !filters.status) })
          else update({ status: filters.status === focus && !filters.flagged ? '' : focus, flagged: false })
        }}
      />

      <section aria-label="Vehicle list" className="space-y-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="relative flex-1 lg:max-w-md">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-subtle" aria-hidden="true" />
            <input
              type="search"
              aria-label="Search vehicles"
              placeholder="Search plate, VIN, make or model"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              className="focus-ring h-10 w-full rounded-control border border-line-strong bg-surface pl-10 pr-10 text-sm text-ink shadow-soft transition-[border-color,box-shadow] duration-150 placeholder:text-ink-subtle hover:border-ink-subtle/50 focus:border-brand"
            />
            {list.isFetching && searchText && (
              <Spinner className="absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-subtle" />
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {showDepotFilter && (
              <FilterSelect
                label="Depot"
                icon={<Building2 />}
                value={filters.depotId}
                emptyValue=""
                options={depotOptions}
                onChange={(depotId) => update({ depotId })}
              />
            )}
            <FilterSelect
              label="Status"
              icon={<SlidersHorizontal />}
              value={filters.status}
              emptyValue=""
              options={STATUS_OPTIONS.map((o) => ({
                value: o.value,
                label: o.label,
                adornment: o.dot ? <span className={cn('h-2 w-2 rounded-full', o.dot)} aria-hidden="true" /> : undefined,
              }))}
              onChange={(status) => update({ status })}
            />
            <button
              type="button"
              role="switch"
              aria-checked={filters.flagged}
              onClick={() => update({ flagged: !filters.flagged })}
              className={cn(
                'focus-ring inline-flex h-10 items-center gap-2.5 rounded-control border px-3.5 text-sm shadow-soft transition-all duration-150 ease-smooth',
                filters.flagged ? 'border-brand/30 bg-brand-soft text-brand-ink' : 'border-line-strong bg-surface text-ink-muted hover:text-ink',
              )}
            >
              <span
                className={cn(
                  'relative h-4 w-7 rounded-full transition-colors duration-200',
                  filters.flagged ? 'bg-brand' : 'bg-line-strong',
                )}
                aria-hidden="true"
              >
                <span
                  className={cn(
                    'absolute left-0 top-0.5 h-3 w-3 rounded-full bg-white shadow-soft transition-transform duration-200 ease-smooth',
                    filters.flagged ? 'translate-x-3.5' : 'translate-x-0.5',
                  )}
                />
              </span>
              Maintenance flagged
            </button>
            {filtered && (
              <Button
                variant="ghost"
                leadingIcon={<X className="h-4 w-4" />}
                onClick={() => {
                  setSearchText('')
                  update({ search: '', depotId: '', status: '', flagged: false })
                }}
              >
                Clear
              </Button>
            )}
          </div>
        </div>

        <DataTable
          caption="Vehicles"
          columns={columns}
          data={vehicles}
          rowKey={(v) => v.id}
          isLoading={list.isPending}
          error={list.isError ? list.error : undefined}
          onRetry={() => void list.refetch()}
          sort={{
            key: filters.sortBy,
            order: filters.sortOrder,
            onChange: () => update({ sortOrder: filters.sortOrder === 'asc' ? 'desc' : 'asc' }, { keepPage: true }),
          }}
          pagination={
            list.data
              ? {
                  page: filters.page,
                  pageSize: filters.pageSize,
                  totalItems: list.data.meta.total_items,
                  onPageChange: (page) => update({ page }, { keepPage: true }),
                  onPageSizeChange: (pageSize) => update({ pageSize }),
                }
              : undefined
          }
          emptyState={
            filtered ? (
              <EmptyState
                icon={<Search />}
                heading="No vehicles match these filters"
                description="Try a different search, or clear the filters to see the whole fleet."
                action={
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setSearchText('')
                      update({ search: '', depotId: '', status: '', flagged: false })
                    }}
                  >
                    Clear filters
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={<Truck />}
                heading="No vehicles registered for this depot"
                description="Add the first vehicle to start tracking its status, trips and documents."
                action={
                  canWrite && (
                    <Button leadingIcon={<Plus className="h-4 w-4" />} onClick={openCreate}>
                      Add vehicle
                    </Button>
                  )
                }
              />
            )
          }
        />
      </section>

      <input
        ref={filePicker}
        type="file"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        accept=".jpg,.jpeg,.png,.pdf,image/jpeg,image/png,application/pdf"
        data-testid="row-file-picker"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file && pickingFor.current) {
            setStagedFile(file)
            setDocsFor(pickingFor.current)
          }
        }}
      />

      <VehicleFormDrawer
        open={formOpen}
        onClose={() => setFormOpen(false)}
        vehicle={editing}
        depots={depots.data ?? []}
        defaultDepotId={filters.depotId || undefined}
      />
      <DecommissionDialog vehicle={decommissioning} onClose={() => setDecommissioning(null)} />
      <DocumentsDrawer
        vehicle={docsFor}
        documents={docs.data ?? []}
        isLoading={docs.isPending}
        onClose={() => {
          setDocsFor(null)
          setStagedFile(null)
        }}
        stagedFile={stagedFile}
        canUpload={canUploadDocs}
        canDelete={canDeleteDocs}
      />
    </div>
  )
}

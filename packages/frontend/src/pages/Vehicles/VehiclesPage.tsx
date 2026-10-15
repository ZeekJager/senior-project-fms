import { Building2, Download, Plus, Search, Truck } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { DataTable, EmptyState, ListToolbar } from '@/components/shared'
import { Button, FilterSelect, useToast } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { useDepots } from '@/features/depots'
import { DocumentsDrawer } from '@/features/documents/DocumentsDrawer'
import { useOwnerDocuments } from '@/features/documents/api'
import { documentHealth, today } from '@/features/documents/expiry'
import { downloadCsv, toCsv } from '@/lib/csv'
import { describeFilters } from '@/lib/describeFilters'
import { useFleetCounts, useVehicles } from './api'
import { vehicleColumns } from './columns'
import { DecommissionDialog } from './DecommissionDialog'
import { hasActiveFilters, readFilters, writeFilters, type SortKey, type VehicleFilters } from './filters'
import { VehicleFormDrawer } from './VehicleFormDrawer'
import { VEHICLE_TYPE_LABELS, type Vehicle, type VehicleStatus } from './types'

/** The views of the fleet. "flagged" is the maintenance flag; "ready" and "docs" are the API's dispatch and document filters; the rest are statuses. */
type View = 'all' | 'ready' | 'flagged' | 'docs' | VehicleStatus

/** Which view the URL's filters amount to, or null for a mix (a status together with the flag, say). */
function viewOf(f: VehicleFilters): View | null {
  if (f.ready) return f.status || f.flagged || f.docs ? null : 'ready'
  if (f.docs) return f.status || f.flagged ? null : 'docs'
  if (f.flagged) return f.status ? null : 'flagged'
  return f.status || 'all'
}

const NO_VIEW = { status: '', flagged: false, ready: false, docs: '' } as const

const patchFor = (view: View): Partial<VehicleFilters> =>
  view === 'all'
    ? NO_VIEW
    : view === 'ready'
      ? { ...NO_VIEW, ready: true }
      : view === 'flagged'
        ? { ...NO_VIEW, flagged: true }
        : view === 'docs'
          ? { ...NO_VIEW, docs: 'due' }
          : { ...NO_VIEW, status: view }

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
  const docs = useOwnerDocuments('vehicle', vehicleIds, canReadDocs)
  const health = useMemo(() => documentHealth(docs.data ?? []), [docs.data])
  const depotMap = useMemo(() => new Map((depots.data ?? []).map((d) => [d.id, d])), [depots.data])

  const [editing, setEditing] = useState<Vehicle | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [decommissioning, setDecommissioning] = useState<Vehicle | null>(null)
  const [docsFor, setDocsFor] = useState<Vehicle | null>(null)
  const { toast } = useToast()
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  // A selection is for the page on screen: new rows, new selection.
  useEffect(() => setSelected(new Set()), [list.data])

  const openCreate = () => {
    setEditing(null)
    setFormOpen(true)
  }

  const columns = vehicleColumns({
    depots: depotMap,
    documents: { health, isLoading: docs.isPending && docs.fetchStatus !== 'idle', canRead: canReadDocs, canWrite: canUploadDocs },
    canWrite,
    canDelete,
    showStatus: (!filters.status || filters.flagged) && !filters.ready,
    onEdit: (v) => {
      setEditing(v)
      setFormOpen(true)
    },
    onOpenDocuments: setDocsFor,
  })

  function exportSelected() {
    const chosen = (vehicles ?? []).filter((v) => selected.has(v.id))
    const csv = toCsv(
      ['Plate', 'Make', 'Model', 'Year', 'Type', 'Status', 'Depot', 'Flagged for maintenance', 'Current trip', 'Documents expired', 'Documents expiring'],
      chosen.map((v) => [
        v.registration_number,
        v.make,
        v.model,
        v.year,
        VEHICLE_TYPE_LABELS[v.vehicle_type],
        v.status,
        depotMap.get(v.depot_id)?.name,
        v.maintenance_flag,
        v.current_trip ? `${v.current_trip.origin ?? ''} to ${v.current_trip.destination ?? ''}` : '',
        health.get(v.id)?.expired ?? 0,
        health.get(v.id)?.expiring ?? 0,
      ]),
    )
    downloadCsv(`vehicles-${today()}.csv`, csv)
    toast({ title: `${chosen.length} vehicle${chosen.length === 1 ? '' : 's'} exported`, description: 'Saved as a CSV file.', tone: 'success' })
  }

  const depotOptions = [{ value: '', label: 'All depots' }, ...(depots.data ?? []).map((d) => ({ value: d.id, label: d.name }))]
  const showDepotFilter = (depots.data?.length ?? 0) > 1
  const filtered = hasActiveFilters(filters)
  const hasToolbarFilters = Boolean(filters.search || filters.depotId)
  const viewLabel = { all: '', ready: 'Ready to dispatch', flagged: 'Flagged', docs: 'Documents due', maintenance: 'Workshop', active: 'Active', inactive: 'Inactive', retired: 'Retired', decommissioned: 'Decommissioned' }[viewOf(filters) ?? 'all']
  const scopeName = filters.depotId ? depotMap.get(filters.depotId)?.name : depots.data?.length === 1 ? depots.data[0].name : null

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-3 border-b border-line pb-5 sm:items-center">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">Vehicles</h1>
          <p className="mt-1 max-w-xl text-sm text-ink-muted">
            Registration, maintenance and trip status for every vehicle{scopeName ? ` in ${scopeName}` : showDepotFilter ? ' across your depots' : ''}.
          </p>
        </div>
        {canWrite && (
          <Button leadingIcon={<Plus className="h-4 w-4" />} onClick={openCreate} className="self-start sm:self-auto">
            Add vehicle
          </Button>
        )}
      </header>

      <section aria-label="Vehicle list" className="space-y-0">

        <DataTable

          toolbar={
            <>
            <ListToolbar
              views={{
                label: 'Vehicle views',
                value: viewOf(filters),
                options: [
                  { value: 'all', label: 'All', count: fleet.counts.total, isLoading: fleet.isLoading },
                  { value: 'ready', label: 'Ready to dispatch', count: fleet.counts.ready, isLoading: fleet.isLoading, hint: 'Active, not flagged, not on a trip and with no expired document' },
                  { value: 'flagged', label: 'Flagged', count: fleet.counts.flagged, isLoading: fleet.isLoading, hint: 'Vehicles flagged as needing maintenance' },
                  { value: 'maintenance', label: 'Workshop', count: fleet.counts.maintenance, isLoading: fleet.isLoading, hint: 'Vehicles currently in maintenance' },
                  { value: 'docs', label: 'Documents due', count: fleet.counts.due, isLoading: fleet.isLoading, hint: 'A document has expired or expires within 30 days' },
                  { value: 'inactive', label: 'Inactive', count: fleet.counts.inactive, isLoading: fleet.isLoading, archived: true, hint: 'Vehicles taken out of service' },
                  { value: 'retired', label: 'Retired', count: fleet.counts.retired, isLoading: fleet.isLoading, archived: true, hint: 'Vehicles no longer in the fleet' },
                ],
                onChange: (view) => update(patchFor(view)),
              }}
              search={{ label: 'Search vehicles', placeholder: 'Plate, VIN, make or model', value: searchText, onChange: setSearchText, busy: list.isFetching }}
              onClear={
                hasToolbarFilters
                  ? () => {
                      setSearchText('')
                      update({ search: '', depotId: '' })
                    }
                  : undefined
              }
            >
              {showDepotFilter && <FilterSelect label="Depot" icon={<Building2 />} value={filters.depotId} emptyValue="" options={depotOptions} onChange={(depotId) => update({ depotId })} />}
            </ListToolbar>
            {selected.size > 0 && (
              <div role="status" className="mt-3 flex flex-wrap items-center gap-2 rounded-control bg-brand-soft px-3 py-2 text-sm text-brand-ink">
                <span className="font-medium">{selected.size} selected</span>
                <Button size="sm" variant="secondary" leadingIcon={<Download className="h-3.5 w-3.5" />} onClick={exportSelected}>
                  Export CSV
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                  Clear selection
                </Button>
              </div>
            )}
            </>
          }
          caption="Vehicles"
          rowHeight="stacked3"
          tableId="vehicles"
          rowLabel={(v) => v.registration_number}
          rowClassName={(v) => (v.maintenance_flag || (health.get(v.id)?.expired ?? 0) > 0 ? 'bg-warning-soft/30' : undefined)}
          onRowClick={canWrite ? (v) => (v.status === 'retired' ? setDocsFor(v) : (setEditing(v), setFormOpen(true))) : canReadDocs ? setDocsFor : undefined}
          selection={{ selected, onChange: setSelected }}
          columns={columns}
          data={vehicles}
          rowKey={(v) => v.id}
          isLoading={list.isPending}
          error={list.isError ? list.error : undefined}
          onRetry={() => void list.refetch()}
          sort={{
            key: filters.sortBy,
            order: filters.sortOrder,
            // The same column flips the order; another column starts ascending.
            onChange: (key) => update({ sortBy: key as SortKey, sortOrder: key === filters.sortBy && filters.sortOrder === 'asc' ? 'desc' : 'asc' }, { keepPage: true }),
            then: filters.thenBy ? { key: filters.thenBy, order: filters.thenOrder } : undefined,
            // Shift+click: a second sort. The same column again flips it, and a third time drops it.
            onThen: (key) =>
              update(
                filters.thenBy !== key
                  ? { thenBy: key as SortKey, thenOrder: 'asc' }
                  : filters.thenOrder === 'asc'
                    ? { thenOrder: 'desc' }
                    : { thenBy: '', thenOrder: 'asc' },
                { keepPage: true },
              ),
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
                description={`${describeFilters({ search: filters.search, depot: filters.depotId ? depotMap.get(filters.depotId)?.name : undefined, view: viewLabel })} Try a different search, or clear the filters to see the whole fleet.`.trim()}
                action={
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setSearchText('')
                      update({ search: '', depotId: '', ...NO_VIEW })
                    }}
                  >
                    Clear filters
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={<Truck />}
                heading={scopeName ? `No vehicles registered in ${scopeName}` : 'No vehicles registered yet'}
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

      <VehicleFormDrawer
        open={formOpen}
        onClose={() => setFormOpen(false)}
        vehicle={editing}
        depots={depots.data ?? []}
        defaultDepotId={filters.depotId || undefined}
        onDecommission={
          editing && canDelete && editing.status !== 'retired'
            ? () => {
                setFormOpen(false)
                setDecommissioning(editing)
              }
            : undefined
        }
      />
      <DecommissionDialog vehicle={decommissioning} onClose={() => setDecommissioning(null)} />
      <DocumentsDrawer
        owner={docsFor && { type: 'vehicle', id: docsFor.id, label: docsFor.registration_number }}
        documents={docs.data ?? []}
        isLoading={docs.isPending}
        onClose={() => setDocsFor(null)}
        stagedFile={null}
        canUpload={canUploadDocs}
        canDelete={canDeleteDocs}
      />
    </div>
  )
}

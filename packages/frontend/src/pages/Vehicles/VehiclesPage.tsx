import { Building2, Plus, Search, Truck } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { DataTable, EmptyState, ListToolbar } from '@/components/shared'
import { Button, FilterSelect } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { useDepots } from '@/features/depots'
import { DocumentsDrawer } from '@/features/documents/DocumentsDrawer'
import { useOwnerDocuments } from '@/features/documents/api'
import { documentHealth } from '@/features/documents/expiry'
import { useFleetCounts, useVehicles } from './api'
import { vehicleColumns } from './columns'
import { DecommissionDialog } from './DecommissionDialog'
import { hasActiveFilters, readFilters, writeFilters, type SortKey, type VehicleFilters } from './filters'
import { VehicleFormDrawer } from './VehicleFormDrawer'
import type { Vehicle, VehicleStatus } from './types'

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
    showStatus: (!filters.status || filters.flagged) && !filters.ready,
    onEdit: (v) => {
      setEditing(v)
      setFormOpen(true)
    },
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
                filtered
                  ? () => {
                      setSearchText('')
                      update({ search: '', depotId: '', ...NO_VIEW })
                    }
                  : undefined
              }
            >
              {showDepotFilter && <FilterSelect label="Depot" icon={<Building2 />} value={filters.depotId} emptyValue="" options={depotOptions} onChange={(depotId) => update({ depotId })} />}
            </ListToolbar>
          }
          caption="Vehicles"
          rowHeight="stacked3"
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

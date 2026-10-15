import { Building2, Plus, Search, Users } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { RoleGate } from '@/components/RoleGate'
import { DataTable, EmptyState, ListToolbar } from '@/components/shared'
import { Button, FilterSelect, useToast } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { useDepots } from '@/features/depots'
import { DocumentsDrawer } from '@/features/documents/DocumentsDrawer'
import { useOwnerDocuments } from '@/features/documents/api'
import { documentHealth } from '@/features/documents/expiry'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { ApiError } from '@/lib/api/errors'
import { describeFilters } from '@/lib/describeFilters'
import { useDrivers, useLicenceCounts, useReinstateDriver } from './api'
import { driverColumns } from './columns'
import { DriverFormDrawer } from './DriverFormDrawer'
import { hasActiveFilters, readFilters, writeFilters, type DriverFilters, type SortKey } from './filters'
import { RetireDriverDialog } from './RetireDriverDialog'
import type { Driver, LicenseStatus } from './types'

/** The views of the roster: licence health, plus the retired drivers. */
type View = 'all' | LicenseStatus | 'retired'

/** Which view the URL's filters amount to (null when retired is combined with a licence). */
function viewOf(f: DriverFilters): View | null {
  if (f.retired) return f.licence ? null : 'retired'
  return f.licence || 'all'
}

const patchFor = (view: View): Partial<DriverFilters> =>
  view === 'all' ? { licence: '', retired: false } : view === 'retired' ? { licence: '', retired: true } : { licence: view, retired: false }

/**
 * S-05 Driver Management (FMS-19): every driver in the caller's depots with
 * their licence and document health, so an expiring licence is caught before
 * it becomes a compliance violation.
 */
export function DriversPage() {
  const { hasPermission } = useAuth()
  const { toast } = useToast()
  const [params, setParams] = useSearchParams()
  const filters = useMemo(() => readFilters(params), [params])

  const canWrite = hasPermission('driver:write')
  const canDelete = hasPermission('driver:delete')
  const canReadDocs = hasPermission('document:read')
  const canUploadDocs = hasPermission('document:write')
  const canDeleteDocs = hasPermission('document:delete')

  function update(patch: Partial<DriverFilters>, options: { keepPage?: boolean } = {}) {
    setParams(writeFilters({ ...filters, ...patch, ...(options.keepPage ? {} : { page: 1 }) }), { replace: true })
  }

  const [searchText, setSearchText] = useState(filters.search)
  const debouncedSearch = useDebouncedValue(searchText, 300)
  // Runs only when the debounced text settles, not on every filter change.
  useEffect(() => {
    if (debouncedSearch !== filters.search) update({ search: debouncedSearch })
  }, [debouncedSearch])

  const list = useDrivers(filters)
  const depots = useDepots()
  const licences = useLicenceCounts(filters.depotId)
  const drivers = list.data?.drivers
  const driverIds = useMemo(() => (drivers ?? []).map((d) => d.id), [drivers])
  const docs = useOwnerDocuments('driver', driverIds, canReadDocs)
  const health = useMemo(() => documentHealth(docs.data ?? []), [docs.data])
  const depotMap = useMemo(() => new Map((depots.data ?? []).map((d) => [d.id, d])), [depots.data])
  const reinstate = useReinstateDriver()

  const [editing, setEditing] = useState<Driver | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [retiring, setRetiring] = useState<Driver | null>(null)
  const [docsFor, setDocsFor] = useState<Driver | null>(null)

  const openCreate = () => {
    setEditing(null)
    setFormOpen(true)
  }

  const clearFilters = () => {
    setSearchText('')
    update({ search: '', depotId: '' })
  }

  const columns = driverColumns({
    depots: depotMap,
    documents: { health, isLoading: docs.isPending && docs.fetchStatus !== 'idle', canRead: canReadDocs, canWrite: canUploadDocs },
    canWrite,
    canDelete,
    onEdit: (d) => {
      setEditing(d)
      setFormOpen(true)
    },
    onReinstate: (d) =>
      reinstate.mutate(d.id, {
        onSuccess: () => toast({ title: 'Driver reinstated', description: `${d.full_name} is back on the active list.` }),
        onError: (err) =>
          toast({ title: 'Could not reinstate the driver', description: err instanceof ApiError ? err.code : undefined, tone: 'danger' }),
      }),
    onOpenDocuments: setDocsFor,
  })

  const depotOptions = [{ value: '', label: 'All depots' }, ...(depots.data ?? []).map((d) => ({ value: d.id, label: d.name }))]
  const filtered = hasActiveFilters(filters)
  const scopeName = filters.depotId ? depotMap.get(filters.depotId)?.name : depots.data?.length === 1 ? depots.data[0].name : null
  const showDepotFilter = (depots.data?.length ?? 0) > 1

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-3 border-b border-line pb-5 sm:items-center">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">Drivers</h1>
          <p className="mt-1 max-w-xl text-sm text-ink-muted">
            Licence and document health for every driver{scopeName ? ` in ${scopeName}` : showDepotFilter ? ' across your depots' : ''}, soonest expiry first.
          </p>
        </div>
        <RoleGate permission="driver:write">
          <Button leadingIcon={<Plus className="h-4 w-4" />} onClick={openCreate} className="self-start sm:self-auto">
            Add driver
          </Button>
        </RoleGate>
      </header>

      <section aria-label="Driver list" className="space-y-0">

        <DataTable

          toolbar={
            <ListToolbar
              views={{
                label: 'Driver views',
                value: viewOf(filters),
                options: [
                  { value: 'all', label: 'All', count: licences.counts.total, isLoading: licences.isLoading },
                  { value: 'valid', label: 'Valid', count: licences.counts.valid, isLoading: licences.isLoading, hint: 'Licence valid beyond 30 days' },
                  { value: 'expiring_soon', label: 'Expiring soon', count: licences.counts.expiring, isLoading: licences.isLoading, hint: 'Licence expires within 30 days' },
                  { value: 'expired', label: 'Expired', count: licences.counts.expired, isLoading: licences.isLoading, hint: 'Cannot be dispatched' },
                  { value: 'retired', label: 'Retired', count: licences.counts.retired, isLoading: licences.isLoading, archived: true, hint: 'Drivers no longer working here' },
                ],
                onChange: (view) => update(patchFor(view)),
              }}
              search={{ label: 'Search drivers', placeholder: 'Name, email or licence number', value: searchText, onChange: setSearchText, busy: list.isFetching }}
              onClear={filters.search || filters.depotId ? clearFilters : undefined}
            >
              {(depots.data?.length ?? 0) > 1 && <FilterSelect label="Depot" icon={<Building2 />} value={filters.depotId} emptyValue="" options={depotOptions} onChange={(depotId) => update({ depotId })} />}
            </ListToolbar>
          }
          caption="Drivers"
          rowHeight="stacked3"
          tableId="drivers"
          rowLabel={(d) => d.full_name}
          rowClassName={(d) => (d.license_status === 'expired' || (health.get(d.id)?.expired ?? 0) > 0 ? 'bg-warning-soft/30' : undefined)}
          onRowClick={canWrite ? (d) => (d.status === 'active' ? (setEditing(d), setFormOpen(true)) : canReadDocs ? setDocsFor(d) : undefined) : canReadDocs ? setDocsFor : undefined}
          columns={columns}
          data={drivers}
          rowKey={(d) => d.id}
          isLoading={list.isPending}
          error={list.isError ? list.error : undefined}
          onRetry={() => void list.refetch()}
          sort={{
            key: filters.sortBy,
            order: filters.sortOrder,
            onChange: (key) =>
              key === filters.sortBy
                ? update({ sortOrder: filters.sortOrder === 'asc' ? 'desc' : 'asc' }, { keepPage: true })
                : update({ sortBy: key as SortKey, sortOrder: 'asc' }, { keepPage: true }),
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
                heading="No drivers match these filters"
                description={`${describeFilters({ search: filters.search, depot: filters.depotId ? depotMap.get(filters.depotId)?.name : undefined, view: { all: '', valid: 'Valid', expiring_soon: 'Expiring soon', expired: 'Expired', retired: 'Retired' }[viewOf(filters) ?? 'all'] })} Try a different search, or clear the filters to see every driver.`.trim()}
                action={
                  <Button variant="secondary" onClick={clearFilters}>
                    Clear filters
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={<Users />}
                heading={scopeName ? `No drivers registered in ${scopeName}` : 'No drivers registered yet'}
                description="Add the first driver to track their licence, documents and trips."
                action={
                  <RoleGate permission="driver:write">
                    <Button leadingIcon={<Plus className="h-4 w-4" />} onClick={openCreate}>
                      Add driver
                    </Button>
                  </RoleGate>
                }
              />
            )
          }
        />
      </section>

      <DriverFormDrawer
        open={formOpen}
        onClose={() => setFormOpen(false)}
        driver={editing}
        depots={depots.data ?? []}
        defaultDepotId={filters.depotId || undefined}
        onRetire={
          editing && canDelete && editing.status === 'active'
            ? () => {
                setFormOpen(false)
                setRetiring(editing)
              }
            : undefined
        }
      />
      <RetireDriverDialog driver={retiring} onClose={() => setRetiring(null)} />
      <DocumentsDrawer
        owner={docsFor && { type: 'driver', id: docsFor.id, label: docsFor.full_name }}
        documents={docs.data ?? []}
        isLoading={docs.isPending}
        onClose={() => setDocsFor(null)}
        stagedFile={null}
        canUpload={canUploadDocs}
        canDelete={canDeleteDocs}
        defaultType="licence"
      />
    </div>
  )
}

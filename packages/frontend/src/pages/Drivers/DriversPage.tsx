import { Building2, IdCard, Plus, Search, ShieldCheck, Users, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { RoleGate } from '@/components/RoleGate'
import { DataTable, EmptyState } from '@/components/shared'
import { Button, cn, FilterSelect, Spinner, useToast } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { useDepots } from '@/features/depots'
import { DocumentsDrawer } from '@/features/documents/DocumentsDrawer'
import { useOwnerDocuments } from '@/features/documents/api'
import { documentHealth } from '@/features/documents/expiry'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { ApiError } from '@/lib/api/errors'
import { useDrivers, useLicenceCounts, useReinstateDriver } from './api'
import { driverColumns } from './columns'
import { DriverFormDrawer } from './DriverFormDrawer'
import { hasActiveFilters, readFilters, writeFilters, type DriverFilters, type SortKey } from './filters'
import { LicenceStats } from './LicenceStats'
import { RetireDriverDialog } from './RetireDriverDialog'
import type { Driver, LicenseStatus } from './types'

const LICENCE_OPTIONS: { value: LicenseStatus | ''; label: string; dot?: string }[] = [
  { value: '', label: 'All' },
  { value: 'valid', label: 'Valid', dot: 'bg-emerald-500' },
  { value: 'expiring_soon', label: 'Expiring soon', dot: 'bg-amber-500' },
  { value: 'expired', label: 'Expired', dot: 'bg-red-500' },
]

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
  const [stagedFile, setStagedFile] = useState<File | null>(null)
  const filePicker = useRef<HTMLInputElement>(null)
  const pickingFor = useRef<Driver | null>(null)

  const openCreate = () => {
    setEditing(null)
    setFormOpen(true)
  }

  const clearFilters = () => {
    setSearchText('')
    update({ search: '', depotId: '', licence: '', retired: false })
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
    onRetire: setRetiring,
    onReinstate: (d) =>
      reinstate.mutate(d.id, {
        onSuccess: () => toast({ title: 'Driver reinstated', description: `${d.full_name} is back on the active list.` }),
        onError: (err) =>
          toast({ title: 'Could not reinstate the driver', description: err instanceof ApiError ? err.code : undefined, tone: 'danger' }),
      }),
    onOpenDocuments: (d) => {
      setStagedFile(null)
      setDocsFor(d)
    },
    onAddDocument: (d) => {
      pickingFor.current = d
      if (filePicker.current) {
        filePicker.current.value = ''
        filePicker.current.click()
      }
    },
  })

  const depotOptions = [{ value: '', label: 'All depots' }, ...(depots.data ?? []).map((d) => ({ value: d.id, label: d.name }))]
  const filtered = hasActiveFilters(filters)
  const scopeName = filters.depotId ? depotMap.get(filters.depotId)?.name : depots.data?.length === 1 ? depots.data[0].name : null

  return (
    <div className="space-y-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-line bg-surface/70 px-2.5 py-1 text-xs font-medium text-ink-muted shadow-soft backdrop-blur">
            <ShieldCheck className="h-3.5 w-3.5 text-brand-ink" aria-hidden="true" />
            Compliance
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">Drivers</h1>
          <p className="mt-1.5 max-w-xl text-sm text-ink-muted">
            Licence and document health for every driver{scopeName ? ` in ${scopeName}` : ' across your depots'}, soonest expiry first.
          </p>
        </div>
        <RoleGate permission="driver:write">
          <Button size="lg" leadingIcon={<Plus className="h-4 w-4" />} onClick={openCreate} className="self-start sm:self-auto">
            Add driver
          </Button>
        </RoleGate>
      </header>

      <LicenceStats counts={licences.counts} isLoading={licences.isLoading} filters={filters} onSelect={(licence) => update({ licence, retired: false })} />

      <section aria-label="Driver list" className="space-y-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="relative flex-1 lg:max-w-md">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-subtle" aria-hidden="true" />
            <input
              type="search"
              aria-label="Search drivers"
              placeholder="Search name, email or licence number"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              className="focus-ring h-10 w-full rounded-control border border-line-strong bg-surface pl-10 pr-10 text-sm text-ink shadow-soft transition-[border-color,box-shadow] duration-150 placeholder:text-ink-subtle hover:border-ink-subtle/50 focus:border-brand"
            />
            {list.isFetching && searchText && <Spinner className="absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-subtle" />}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {(depots.data?.length ?? 0) > 1 && (
              <FilterSelect label="Depot" icon={<Building2 />} value={filters.depotId} emptyValue="" options={depotOptions} onChange={(depotId) => update({ depotId })} />
            )}
            <FilterSelect
              label="Licence"
              icon={<IdCard />}
              value={filters.licence}
              emptyValue=""
              options={LICENCE_OPTIONS.map((o) => ({
                value: o.value,
                label: o.label,
                adornment: o.dot ? <span className={cn('h-2 w-2 rounded-full', o.dot)} aria-hidden="true" /> : undefined,
              }))}
              onChange={(licence) => update({ licence })}
            />
            <button
              type="button"
              role="switch"
              aria-checked={filters.retired}
              onClick={() => update({ retired: !filters.retired })}
              className={cn(
                'focus-ring inline-flex h-10 items-center gap-2.5 rounded-control border px-3.5 text-sm shadow-soft transition-all duration-150 ease-smooth',
                filters.retired ? 'border-brand/30 bg-brand-soft text-brand-ink' : 'border-line-strong bg-surface text-ink-muted hover:text-ink',
              )}
            >
              <span className={cn('relative h-4 w-7 rounded-full transition-colors duration-200', filters.retired ? 'bg-brand' : 'bg-line-strong')} aria-hidden="true">
                <span
                  className={cn(
                    'absolute left-0 top-0.5 h-3 w-3 rounded-full bg-white shadow-soft transition-transform duration-200 ease-smooth',
                    filters.retired ? 'translate-x-3.5' : 'translate-x-0.5',
                  )}
                />
              </span>
              Retired drivers
            </button>
            {filtered && (
              <Button variant="ghost" leadingIcon={<X className="h-4 w-4" />} onClick={clearFilters}>
                Clear
              </Button>
            )}
          </div>
        </div>

        <DataTable
          caption="Drivers"
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
                description="Try a different search, or clear the filters to see every driver."
                action={
                  <Button variant="secondary" onClick={clearFilters}>
                    Clear filters
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={<Users />}
                heading="No drivers registered for this depot"
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

      <DriverFormDrawer open={formOpen} onClose={() => setFormOpen(false)} driver={editing} depots={depots.data ?? []} defaultDepotId={filters.depotId || undefined} />
      <RetireDriverDialog driver={retiring} onClose={() => setRetiring(null)} />
      <DocumentsDrawer
        owner={docsFor && { type: 'driver', id: docsFor.id, label: docsFor.full_name }}
        documents={docs.data ?? []}
        isLoading={docs.isPending}
        onClose={() => {
          setDocsFor(null)
          setStagedFile(null)
        }}
        stagedFile={stagedFile}
        canUpload={canUploadDocs}
        canDelete={canDeleteDocs}
        defaultType="licence"
      />
    </div>
  )
}

import { Building2, Pencil, Plus, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ConfirmDialog, DataTable, EmptyState, ListToolbar, type Column } from '@/components/shared'
import { Badge, Button, useToast } from '@/components/ui'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { describeFilters } from '@/lib/describeFilters'
import { ApiError } from '@/lib/api/errors'
import { DepotFormDrawer } from './DepotFormDrawer'
import { useDeactivateDepot, useDepotCounts, useDepotList, type DepotFilters, type DepotRecord } from './api'

function readFilters(params: URLSearchParams): DepotFilters {
  const page = Number.parseInt(params.get('page') ?? '', 10)
  return {
    search: params.get('q') ?? '',
    status: params.get('view') === 'inactive' ? 'inactive' : 'active',
    page: Number.isInteger(page) && page > 0 ? page : 1,
    pageSize: 50,
  }
}

function writeFilters(f: DepotFilters): URLSearchParams {
  const p = new URLSearchParams()
  if (f.search) p.set('q', f.search)
  if (f.status === 'inactive') p.set('view', 'inactive')
  if (f.page > 1) p.set('page', String(f.page))
  return p
}

/** "Adama, Ethiopia", from what the depot has. */
function place(d: DepotRecord): string {
  return [d.address, d.city ?? d.location, d.country].filter(Boolean).join(', ')
}

/**
 * Depots (S-26, FMS-80; FMS-20 left their screen to this card): the yards vehicles, drivers and staff belong
 * to. Admin and fleet owner (depot:write) add, edit and deactivate them; a deactivated depot stays for its
 * records and can be restored.
 */
export function DepotsPage() {
  const [params, setParams] = useSearchParams()
  const filters = useMemo(() => readFilters(params), [params])
  function update(patch: Partial<DepotFilters>) {
    setParams(writeFilters({ ...filters, page: 1, ...patch }), { replace: true })
  }

  const [searchText, setSearchText] = useState(filters.search)
  const debounced = useDebouncedValue(searchText, 300)
  // Runs only when the debounced text settles.
  useEffect(() => {
    if (debounced !== filters.search) update({ search: debounced })
  }, [debounced])

  const list = useDepotList(filters)
  const counts = useDepotCounts()
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<DepotRecord | null>(null)
  const [deactivating, setDeactivating] = useState<DepotRecord | null>(null)

  function open(depot: DepotRecord | null) {
    setEditing(depot)
    setFormOpen(true)
  }

  const columns: Column<DepotRecord>[] = [
    {
      key: 'depot',
      header: 'Depot',
      cell: (d) => (
        <div className="min-w-0">
          <p className="flex items-center gap-2 truncate font-semibold text-ink">
            <span className="truncate">{d.name}</span>
            {d.code && <span className="shrink-0 rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[11px] font-medium text-ink-muted">{d.code}</span>}
            {!d.is_active && <Badge tone="neutral">Inactive</Badge>}
          </p>
          <p className="truncate text-xs text-ink-subtle">{place(d) || d.location}</p>
        </div>
      ),
    },
    {
      key: 'capacity',
      header: 'Capacity',
      width: 'w-[112px]',
      align: 'right',
      cell: (d) =>
        d.capacity === null ? (
          <span className="text-ink-subtle">—</span>
        ) : (
          <span className="tabular font-medium text-ink">
            {d.capacity.toLocaleString('en-US')} <span className="font-normal text-ink-subtle">{d.capacity === 1 ? 'vehicle' : 'vehicles'}</span>
          </span>
        ),
    },
    {
      key: 'zone',
      header: 'Time zone',
      width: 'w-[184px]',
      hideBelow: 'md',
      cell: (d) => <span className={d.timezone ? 'text-ink-muted' : 'text-ink-subtle'}>{d.timezone ?? 'Not set'}</span>,
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      width: 'w-[104px]',
      align: 'right',
      // Phones give the width to the name: a tap on the row opens the same panel.
      hideBelow: 'sm',
      cell: (d) => (
        <Button
          size="sm"
          variant="secondary"
          leadingIcon={<Pencil className="h-3.5 w-3.5" />}
          onClick={(e) => {
            e.stopPropagation()
            open(d)
          }}
          aria-label={`${d.is_active ? 'Edit' : 'Open'} ${d.name}`}
        >
          {d.is_active ? 'Edit' : 'Open'}
        </Button>
      ),
      skeleton: <span />,
    },
  ]

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-3 border-b border-line pb-5 sm:items-center">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">Depots</h1>
          <p className="mt-1 max-w-xl text-sm text-ink-muted">The yards vehicles, drivers and staff belong to. Every list and depot filter follows this one.</p>
        </div>
        <Button leadingIcon={<Plus className="h-4 w-4" />} onClick={() => open(null)} className="self-start sm:self-auto">
          Add depot
        </Button>
      </header>

      <section aria-label="Depot list">
        <DataTable
          toolbar={
            <ListToolbar
              views={{
                label: 'Depot views',
                value: filters.status,
                options: [
                  { value: 'active', label: 'Active', count: counts.counts.active, isLoading: counts.isLoading, hint: 'In every depot list and filter' },
                  { value: 'inactive', label: 'Inactive', count: counts.counts.inactive, isLoading: counts.isLoading, archived: true, hint: 'Deactivated: kept for their records, can be restored' },
                ],
                onChange: (status) => update({ status }),
              }}
              search={{ label: 'Search depots', placeholder: 'Name, code, location or city', value: searchText, onChange: setSearchText, busy: list.isFetching }}
              onClear={
                filters.search
                  ? () => {
                      setSearchText('')
                      update({ search: '' })
                    }
                  : undefined
              }
            />
          }
          caption="Depots"
          rowHeight="stacked"
          columns={columns}
          data={list.data?.depots}
          rowKey={(d) => d.id}
          rowLabel={(d) => d.name}
          onRowClick={open}
          isLoading={list.isPending}
          error={list.isError ? list.error : undefined}
          onRetry={() => void list.refetch()}
          pagination={list.data ? { page: filters.page, pageSize: filters.pageSize, totalItems: list.data.meta.total_items, onPageChange: (page) => setParams(writeFilters({ ...filters, page })) } : undefined}
          emptyState={
            filters.search ? (
              <EmptyState icon={<Search />} heading="No depots match" description={`${describeFilters({ search: filters.search })} Try another search.`.trim()} />
            ) : filters.status === 'inactive' ? (
              <EmptyState icon={<Building2 />} heading="No inactive depots" description="A depot you deactivate is kept here with its records, and can be restored." />
            ) : (
              <EmptyState
                icon={<Building2 />}
                heading="No depots yet"
                description="Add the first yard, then put vehicles, drivers and staff in it."
                action={
                  <Button leadingIcon={<Plus className="h-4 w-4" />} onClick={() => open(null)}>
                    Add depot
                  </Button>
                }
              />
            )
          }
        />
      </section>

      <DepotFormDrawer
        open={formOpen}
        onClose={() => setFormOpen(false)}
        depot={editing}
        onDeactivate={
          editing?.is_active
            ? () => {
                setFormOpen(false)
                setDeactivating(editing)
              }
            : undefined
        }
      />
      <DeactivateDepotDialog depot={deactivating} onClose={() => setDeactivating(null)} />
    </div>
  )
}

/**
 * Deactivating is DELETE /depots/{id}, soft: the depot leaves every list, its records stay, and it can be
 * restored. Refused while vehicles, drivers or accounts still belong to it; the server's message counts them.
 */
function DeactivateDepotDialog({ depot, onClose }: { depot: DepotRecord | null; onClose: () => void }) {
  const deactivate = useDeactivateDepot()
  const { toast } = useToast()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => setError(null), [depot])

  async function confirm() {
    if (!depot) return
    setError(null)
    try {
      await deactivate.mutateAsync(depot.id)
      toast({ title: 'Depot deactivated', description: `${depot.name} is out of every depot list. Restore it from Inactive.` })
      onClose()
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CONFLICT_DEPOT_NOT_EMPTY') setError(err.message)
      else setError(err instanceof ApiError ? `The depot could not be deactivated (${err.code}).` : 'Could not reach the server. Try again.')
    }
  }

  return (
    <ConfirmDialog
      open={depot !== null}
      onClose={onClose}
      title={`Deactivate ${depot?.name ?? ''}`}
      message={<p>The depot leaves every list and filter, and nothing new can be put in it. Its trips, logs and history stay, and you can restore it from Inactive. It must have no active vehicles, drivers or user accounts left.</p>}
      action="Deactivate depot"
      onConfirm={confirm}
      error={error}
      busy={deactivate.isPending}
    />
  )
}

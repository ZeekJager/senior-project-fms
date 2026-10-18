import { ArrowRight, Building2, Pencil, Plus, Search, Waypoints } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { DataTable, EmptyState, ListToolbar, type Column } from '@/components/shared'
import { Badge, Button, FilterSelect } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { useDepots } from '@/features/depots'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { describeFilters } from '@/lib/describeFilters'
import { RetireRouteDialog } from './RetireRouteDialog'
import { RouteFormDrawer } from './RouteFormDrawer'
import { useRouteCounts, useRoutes, type Route, type RouteFilters } from './api'
import { formatDistance, formatDuration } from './routeForm'

function readFilters(params: URLSearchParams): RouteFilters {
  const page = Number.parseInt(params.get('page') ?? '', 10)
  return {
    search: params.get('q') ?? '',
    depotId: params.get('depot') ?? '',
    status: params.get('view') === 'retired' ? 'retired' : 'active',
    sortBy: params.get('sort') === 'distance' ? 'distance_km' : 'name',
    sortOrder: params.get('order') === 'desc' ? 'desc' : 'asc',
    page: Number.isInteger(page) && page > 0 ? page : 1,
    pageSize: 50,
  }
}

function writeFilters(f: RouteFilters): URLSearchParams {
  const p = new URLSearchParams()
  if (f.search) p.set('q', f.search)
  if (f.depotId) p.set('depot', f.depotId)
  if (f.status === 'retired') p.set('view', 'retired')
  if (f.sortBy === 'distance_km') p.set('sort', 'distance')
  if (f.sortOrder === 'desc') p.set('order', 'desc')
  if (f.page > 1) p.set('page', String(f.page))
  return p
}

/** "Addis Ababa → Adama", with whichever ends are known. */
function ends(r: Route): string | null {
  if (!r.origin_name && !r.destination_name) return null
  return `${r.origin_name ?? 'Origin not set'} → ${r.destination_name ?? 'Destination not set'}`
}

/**
 * Routes (FMS-83, §9.2): the planned routes trips are created from, with
 * their stops, expected distance and time. Dispatchers and depot admins
 * plan them; a retired route stays for the trips that used it.
 */
export function RoutesPage() {
  const { hasPermission } = useAuth()
  const [params, setParams] = useSearchParams()
  const filters = useMemo(() => readFilters(params), [params])
  const canWrite = hasPermission('route:write')

  function update(patch: Partial<RouteFilters>) {
    setParams(writeFilters({ ...filters, page: 1, ...patch }), { replace: true })
  }

  const [searchText, setSearchText] = useState(filters.search)
  const debounced = useDebouncedValue(searchText, 300)
  // Runs only when the debounced text settles.
  useEffect(() => {
    if (debounced !== filters.search) update({ search: debounced })
  }, [debounced])

  const list = useRoutes(filters)
  const counts = useRouteCounts(filters.depotId)
  const depots = useDepots()
  const depotNames = useMemo(() => new Map((depots.data ?? []).map((d) => [d.id, d.name])), [depots.data])
  const manyDepots = (depots.data?.length ?? 0) > 1

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Route | null>(null)
  const [retiring, setRetiring] = useState<Route | null>(null)

  function openCreate() {
    setEditing(null)
    setFormOpen(true)
  }

  function openEdit(route: Route) {
    setEditing(route)
    setFormOpen(true)
  }

  const columns: Column<Route>[] = [
    {
      key: 'route',
      header: 'Route',
      sortKey: 'name',
      cell: (r) => {
        const path = ends(r)
        const stops = r.stops.length === 1 ? '1 stop' : `${r.stops.length} stops`
        return (
          <div className="min-w-0">
            <p className="flex items-center gap-2 truncate font-semibold text-ink">
              <span className="truncate">{r.name}</span>
              {!r.is_active && <Badge tone="neutral">Retired</Badge>}
            </p>
            <p className="truncate text-xs text-ink-subtle">
              {path ?? 'No origin or destination yet'}
              {r.stops.length > 0 && ` · ${stops}`}
              {manyDepots && ` · ${depotNames.get(r.depot_id) ?? 'Depot'}`}
            </p>
          </div>
        )
      },
    },
    {
      key: 'distance',
      header: 'Distance',
      sortKey: 'distance_km',
      width: 'w-[96px] sm:w-[120px]',
      align: 'right',
      cell: (r) => <span className={r.distance_km === null ? 'text-ink-subtle' : 'tabular font-medium text-ink'}>{formatDistance(r.distance_km)}</span>,
    },
    {
      key: 'time',
      header: 'Est. time',
      width: 'w-[128px]',
      align: 'right',
      hideBelow: 'sm',
      cell: (r) => <span className={r.estimated_duration_seconds === null ? 'text-ink-subtle' : 'tabular text-ink-muted'}>{formatDuration(r.estimated_duration_seconds)}</span>,
    },
    ...(canWrite
      ? [
          {
            key: 'actions',
            header: <span className="sr-only">Actions</span>,
            width: 'w-[104px]',
            align: 'right' as const,
            // Phones give the width to the route name: a tap on the row opens the same panel.
            hideBelow: 'sm' as const,
            cell: (r: Route) => (
              <Button
                size="sm"
                variant="secondary"
                leadingIcon={<Pencil className="h-3.5 w-3.5" />}
                onClick={(e) => {
                  e.stopPropagation()
                  openEdit(r)
                }}
                aria-label={`Edit ${r.name}`}
              >
                Edit
              </Button>
            ),
            skeleton: <span />,
          },
        ]
      : []),
  ]

  const filtered = Boolean(filters.search || filters.depotId)
  const scopeName = filters.depotId ? depotNames.get(filters.depotId) : depots.data?.length === 1 ? depots.data[0].name : null

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-3 border-b border-line pb-5 sm:items-center">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">Routes</h1>
          <p className="mt-1 max-w-xl text-sm text-ink-muted">
            Planned routes with their stops, expected distance and time{scopeName ? ` in ${scopeName}` : manyDepots ? ' across your depots' : ''}. Trips are created from them.
          </p>
        </div>
        {canWrite && (
          <Button leadingIcon={<Plus className="h-4 w-4" />} onClick={openCreate} className="self-start sm:self-auto">
            Add route
          </Button>
        )}
      </header>

      <section aria-label="Route list" className="space-y-0">
        <DataTable
          toolbar={
            <ListToolbar
              views={{
                label: 'Route views',
                value: filters.status,
                options: [
                  { value: 'active', label: 'Active', count: counts.counts.active, isLoading: counts.isLoading, hint: 'Offered when creating trips' },
                  { value: 'retired', label: 'Retired', count: counts.counts.retired, isLoading: counts.isLoading, archived: true, hint: 'Kept for past trips, not offered for new ones' },
                ],
                onChange: (status) => update({ status }),
              }}
              search={{ label: 'Search routes', placeholder: 'Route, origin or destination', value: searchText, onChange: setSearchText, busy: list.isFetching }}
              onClear={
                filtered
                  ? () => {
                      setSearchText('')
                      update({ search: '', depotId: '' })
                    }
                  : undefined
              }
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
          caption="Routes"
          rowHeight="stacked"
          columns={columns}
          data={list.data?.routes}
          rowKey={(r) => r.id}
          rowLabel={(r) => r.name}
          onRowClick={canWrite ? openEdit : undefined}
          isLoading={list.isPending}
          error={list.isError ? list.error : undefined}
          onRetry={() => void list.refetch()}
          sort={{
            key: filters.sortBy,
            order: filters.sortOrder,
            onChange: (key) =>
              key === filters.sortBy ? update({ sortOrder: filters.sortOrder === 'asc' ? 'desc' : 'asc' }) : update({ sortBy: key as RouteFilters['sortBy'], sortOrder: 'asc' }),
          }}
          pagination={list.data ? { page: filters.page, pageSize: filters.pageSize, totalItems: list.data.meta.total_items, onPageChange: (page) => setParams(writeFilters({ ...filters, page })) } : undefined}
          emptyState={
            filtered ? (
              <EmptyState icon={<Search />} heading="No routes match" description={`${describeFilters({ search: filters.search })} Try another search or clear the filters.`.trim()} />
            ) : filters.status === 'retired' ? (
              <EmptyState icon={<Waypoints />} heading="No retired routes" description="Routes you retire are kept here for the trips that used them." />
            ) : (
              <EmptyState
                icon={<Waypoints />}
                heading={scopeName ? `No routes planned in ${scopeName}` : 'No routes planned yet'}
                description={
                  <span className="inline-flex flex-wrap items-center justify-center gap-1">
                    Plan an origin <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" /> destination with its stops, and trips can reuse it.
                  </span>
                }
                action={
                  canWrite && (
                    <Button leadingIcon={<Plus className="h-4 w-4" />} onClick={openCreate}>
                      Add route
                    </Button>
                  )
                }
              />
            )
          }
        />
      </section>

      <RouteFormDrawer
        open={formOpen}
        onClose={() => setFormOpen(false)}
        route={editing}
        depots={depots.data ?? []}
        defaultDepotId={filters.depotId || undefined}
        onRetire={
          editing && canWrite
            ? () => {
                setFormOpen(false)
                setRetiring(editing)
              }
            : undefined
        }
      />
      <RetireRouteDialog route={retiring} onClose={() => setRetiring(null)} />
    </div>
  )
}

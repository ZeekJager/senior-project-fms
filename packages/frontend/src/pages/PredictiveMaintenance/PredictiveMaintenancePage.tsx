import { Activity, Building2, Gauge, MapPin, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { DataTable, EmptyState, ListToolbar, type Column } from '@/components/shared'
import { Button, FilterSelect, Skeleton } from '@/components/ui'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { useDepots } from '@/features/depots'
import { useActiveModel } from '@/features/health/api'
import { HealthBadge } from '@/features/health/HealthBadge'
import { BAND_LABELS, formatAge, formatScoredAt, healthViewOf, type HealthView } from '@/features/health/health'
import type { Vehicle } from '@/pages/Vehicles/types'
import { readFilters, useHealthCounts, useHealthList, writeFilters, type HealthFilters, type HealthSort } from './api'
import { HealthPanel } from './HealthPanel'

const VIEW_HINTS: Record<HealthView, string> = {
  at_risk: 'Health score below 75: a technician has been alerted',
  watch: 'Health score 75 to 84',
  healthy: 'Health score 85 and above',
  stale: 'Scored more than 25 hours ago: the last nightly scoring missed it',
  unscored: 'Not scored yet',
}

/** What a score means for the next 30 days, in a word, for a fresh score. */
function riskWord(v: Vehicle): string {
  const view = healthViewOf(v.health_score, v.health_score_updated_at)
  if (view === 'unscored' || view === 'stale' || v.health_score === null) return '—'
  return v.health_score <= 40 ? 'High' : v.health_score < 75 ? 'Medium' : 'Low'
}

/**
 * S-19 Vehicle health (FMS-56): which vehicles to service next, by the model's nightly risk score rather
 * than by mileage alone. Riskiest first; a row opens its breakdown, and from there an inspection.
 * Needs prediction:read (fleet managers, technicians, depot admins, administrators).
 */
export function PredictiveMaintenancePage() {
  const [params, setParams] = useSearchParams()
  const filters = useMemo(() => readFilters(params), [params])
  const update = (patch: Partial<HealthFilters>, keepPage = false) =>
    setParams(writeFilters({ ...filters, ...patch, ...(keepPage ? {} : { page: 1 }) }), { replace: true })

  const [searchText, setSearchText] = useState(filters.search)
  const debouncedSearch = useDebouncedValue(searchText, 300)
  useEffect(() => {
    if (debouncedSearch !== filters.search) update({ search: debouncedSearch })
  }, [debouncedSearch])

  const list = useHealthList(filters)
  const counts = useHealthCounts(filters.depotId, filters.search)
  const depots = useDepots()
  const model = useActiveModel(true)
  const depotMap = useMemo(() => new Map((depots.data ?? []).map((d) => [d.id, d])), [depots.data])
  const [open, setOpen] = useState<Vehicle | null>(null)

  const lastScored = useMemo(() => {
    const times = (list.data?.vehicles ?? []).map((v) => v.health_score_updated_at).filter((t): t is string => t !== null)
    return times.length ? times.reduce((a, b) => (a > b ? a : b)) : null
  }, [list.data])

  const columns: Column<Vehicle>[] = [
    {
      key: 'vehicle',
      header: 'Vehicle',
      sortKey: 'registration_number',
      cell: (v) => (
        <div className="min-w-0">
          <p className="plate text-ink">{v.registration_number}</p>
          <p className="truncate text-xs text-ink-subtle">
            {v.make} {v.model}
            {v.year ? ` · ${v.year}` : ''}
          </p>
          <p className="truncate text-xs text-ink-subtle xl:hidden">{depotMap.get(v.depot_id)?.name ?? '—'}</p>
        </div>
      ),
      skeleton: (
        <div className="space-y-2">
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="h-3 w-32" />
        </div>
      ),
    },
    {
      key: 'health',
      header: 'Health',
      sortKey: 'health_score',
      width: 'w-[120px]',
      cell: (v) => <HealthBadge score={v.health_score} updatedAt={v.health_score_updated_at} onOpen={() => setOpen(v)} />,
      skeleton: <Skeleton className="h-6 w-14 rounded-full" />,
    },
    {
      key: 'risk',
      header: 'Breakdown risk',
      width: 'w-[140px]',
      hideBelow: 'md',
      cell: (v) => <span className="text-ink-muted">{riskWord(v)}</span>,
    },
    {
      key: 'depot',
      header: 'Depot',
      sortKey: 'depot',
      width: 'w-[18%]',
      hideBelow: 'xl',
      cell: (v) => (
        <span className="flex min-w-0 items-center gap-1.5 text-ink-muted">
          <MapPin className="h-3.5 w-3.5 shrink-0 text-ink-subtle" aria-hidden="true" />
          <span className="truncate">{depotMap.get(v.depot_id)?.name ?? '—'}</span>
        </span>
      ),
    },
    {
      key: 'scored',
      header: 'Last scored',
      width: 'w-[170px]',
      hideBelow: 'lg',
      cell: (v) =>
        v.health_score_updated_at ? (
          <span className="text-ink-muted" title={formatScoredAt(v.health_score_updated_at)}>
            {formatAge(v.health_score_updated_at)}
          </span>
        ) : (
          <span className="text-ink-subtle">Never</span>
        ),
    },
    {
      key: 'action',
      header: <span className="sr-only">Actions</span>,
      width: 'w-[96px]',
      align: 'right',
      cell: (v) => (
        <Button size="sm" variant="secondary" leadingIcon={<Activity className="h-3.5 w-3.5" />} onClick={() => setOpen(v)} aria-label={`View ${v.registration_number} health`}>
          View
        </Button>
      ),
    },
  ]

  const depotOptions = [{ value: '', label: 'All depots' }, ...(depots.data ?? []).map((d) => ({ value: d.id, label: d.name }))]
  const showDepotFilter = (depots.data?.length ?? 0) > 1
  const filtered = Boolean(filters.view || filters.search || filters.depotId)

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-b border-line pb-5">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">Vehicle health</h1>
          <p className="mt-1 max-w-xl text-sm text-ink-muted">
            Each vehicle’s chance of a breakdown in the next 30 days, from its use, faults, fuel and service history. Service the riskiest first.
          </p>
        </div>
        <p className="flex flex-wrap gap-x-1.5 text-xs text-ink-subtle">
          <span>Scored nightly at 02:00</span>
          {lastScored && <span className="whitespace-nowrap">· last {formatScoredAt(lastScored)}</span>}
          {model.data ? <span className="whitespace-nowrap">· model {model.data.version}</span> : model.isSuccess && <span>· no model active</span>}
        </p>
      </header>

      <section aria-label="Vehicle health list">
        <DataTable
          toolbar={
            <ListToolbar
              views={{
                label: 'Health views',
                value: filters.view || 'all',
                options: [
                  { value: 'all', label: 'All', count: counts.counts.all, isLoading: counts.isLoading },
                  ...(['at_risk', 'watch', 'healthy'] as const).map((view) => ({
                    value: view,
                    label: BAND_LABELS[view],
                    count: counts.counts[view],
                    isLoading: counts.isLoading,
                    hint: VIEW_HINTS[view],
                  })),
                  ...(['stale', 'unscored'] as const).map((view) => ({
                    value: view,
                    label: BAND_LABELS[view],
                    count: counts.counts[view],
                    isLoading: counts.isLoading,
                    hint: VIEW_HINTS[view],
                    archived: true,
                  })),
                ],
                onChange: (view) => update({ view: view === 'all' ? '' : (view as HealthView) }),
              }}
              search={{ label: 'Search vehicles', placeholder: 'Plate, VIN, make or model', value: searchText, onChange: setSearchText, busy: list.isFetching }}
              onClear={
                filters.search || filters.depotId
                  ? () => {
                      setSearchText('')
                      update({ search: '', depotId: '' })
                    }
                  : undefined
              }
            >
              {showDepotFilter && <FilterSelect label="Depot" icon={<Building2 />} value={filters.depotId} emptyValue="" options={depotOptions} onChange={(depotId) => update({ depotId })} />}
            </ListToolbar>
          }
          caption="Vehicle health"
          rowHeight="stacked3"
          tableId="vehicle-health"
          rowLabel={(v) => v.registration_number}
          rowClassName={(v) => (healthViewOf(v.health_score, v.health_score_updated_at) === 'at_risk' ? 'bg-danger-soft/25' : undefined)}
          onRowClick={setOpen}
          columns={columns}
          data={list.data?.vehicles}
          rowKey={(v) => v.id}
          isLoading={list.isPending}
          error={list.isError ? list.error : undefined}
          onRetry={() => void list.refetch()}
          sort={{
            key: filters.sortBy,
            order: filters.sortOrder,
            onChange: (key) => update({ sortBy: key as HealthSort, sortOrder: key === filters.sortBy && filters.sortOrder === 'asc' ? 'desc' : 'asc' }, true),
          }}
          pagination={
            list.data
              ? {
                  page: filters.page,
                  pageSize: filters.pageSize,
                  totalItems: list.data.total,
                  onPageChange: (page) => update({ page }, true),
                  onPageSizeChange: (pageSize) => update({ pageSize }),
                }
              : undefined
          }
          emptyState={
            filtered ? (
              <EmptyState
                icon={<Search />}
                heading={filters.view ? `No vehicles are ${BAND_LABELS[filters.view].toLowerCase()}` : 'No vehicles match'}
                description={filters.view === 'at_risk' ? 'No vehicle scored below 75 last night.' : 'Try another view or search, or clear the filters.'}
                action={
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setSearchText('')
                      update({ view: '', search: '', depotId: '' })
                    }}
                  >
                    Show every vehicle
                  </Button>
                }
              />
            ) : (
              <EmptyState icon={<Gauge />} heading="No vehicles in service" description="Vehicles appear here once they are registered; the nightly scoring gives each a health score." />
            )
          }
        />
      </section>

      <HealthPanel vehicle={open} onClose={() => setOpen(null)} />
    </div>
  )
}

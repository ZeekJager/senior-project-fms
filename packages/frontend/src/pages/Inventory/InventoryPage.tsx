import { ArrowDownRight, ArrowUpRight, Boxes, Building2, History, PackageCheck, PackageMinus, PackageX, Search, SlidersHorizontal, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { DataTable, EmptyState, StatCard, StatShare, type Column } from '@/components/shared'
import { Badge, Button, cn, Drawer, FilterSelect, IconButton, Spinner } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { useDepots } from '@/features/depots'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { AdjustStockDialog } from './AdjustStockDialog'
import { useMovements, useParts, useStockCounts, type Movement, type Part, type PartFilters, type StockStatus } from './api'

/** OUT OF STOCK (red) at 0, LOW (amber) from 1 to the reorder level, OK (green) above it (FMS-25). */
export function StockBadge({ status }: { status: StockStatus }) {
  const [tone, label] = status === 'out' ? (['danger', 'OUT OF STOCK'] as const) : status === 'low' ? (['warning', 'LOW'] as const) : (['success', 'OK'] as const)
  return (
    <Badge tone={tone} dot className="tracking-wide">
      <span data-stock={status}>{label}</span>
    </Badge>
  )
}

function readFilters(params: URLSearchParams): PartFilters {
  const status = params.get('status')
  const page = Number.parseInt(params.get('page') ?? '', 10)
  return {
    search: params.get('q') ?? '',
    depotId: params.get('depot') ?? '',
    lowOnly: params.get('low') === '1',
    status: status === 'out' || status === 'low' || status === 'ok' ? status : '',
    sortBy: params.get('sort') === 'stock' ? 'stock_quantity' : 'name',
    sortOrder: params.get('order') === 'desc' ? 'desc' : 'asc',
    page: Number.isInteger(page) && page > 0 ? page : 1,
    pageSize: 50,
  }
}

function writeFilters(f: PartFilters): URLSearchParams {
  const p = new URLSearchParams()
  if (f.search) p.set('q', f.search)
  if (f.depotId) p.set('depot', f.depotId)
  if (f.lowOnly) p.set('low', '1')
  if (f.status) p.set('status', f.status)
  if (f.sortBy === 'stock_quantity') p.set('sort', 'stock')
  if (f.sortOrder === 'desc') p.set('order', 'desc')
  if (f.page > 1) p.set('page', String(f.page))
  return p
}

const MOVEMENT_LABELS: Record<Movement['movement_type'], string> = {
  purchase: 'Stock in',
  consumption: 'Used in a repair',
  adjustment: 'Adjustment',
  transfer_in: 'Transfer in',
  transfer_out: 'Transfer out',
  return: 'Returned',
}

/**
 * S-09 Spare parts console (FMS-25): live stock counts with what is out or
 * low shown first and loudest, so reorders happen before a repair stalls.
 * A stock count view: no prices or suppliers.
 */
export function InventoryPage() {
  const { hasPermission } = useAuth()
  const [params, setParams] = useSearchParams()
  const filters = useMemo(() => readFilters(params), [params])
  const canWrite = hasPermission('inventory:write')

  function update(patch: Partial<PartFilters>) {
    setParams(writeFilters({ ...filters, page: 1, ...patch }), { replace: true })
  }

  const [searchText, setSearchText] = useState(filters.search)
  const debounced = useDebouncedValue(searchText, 300)
  // Runs only when the debounced text settles.
  useEffect(() => {
    if (debounced !== filters.search) update({ search: debounced })
  }, [debounced])

  const list = useParts(filters)
  const stock = useStockCounts(filters.depotId)
  const depots = useDepots()
  const depotNames = useMemo(() => new Map((depots.data ?? []).map((d) => [d.id, d.name])), [depots.data])
  const [adjusting, setAdjusting] = useState<Part | null>(null)
  const [history, setHistory] = useState<Part | null>(null)

  const columns: Column<Part>[] = [
    {
      key: 'part',
      header: 'Part',
      sortKey: 'name',
      cell: (p) => (
        <div className="min-w-0">
          <p className="truncate font-semibold text-ink">{p.name}</p>
          <p className="truncate text-xs text-ink-subtle">
            {p.part_number}
            {(depots.data?.length ?? 0) > 1 && ` · ${p.depot_id ? (depotNames.get(p.depot_id) ?? 'Depot') : 'Shared stock'}`}
          </p>
          {/* Phones drop the status column; the badge rides under the name. */}
          <span className="mt-1 block sm:hidden" aria-hidden="true">
            <StockBadge status={p.stock_status} />
          </span>
        </div>
      ),
    },
    {
      key: 'stock',
      header: 'In stock',
      sortKey: 'stock_quantity',
      width: 'w-[64px] sm:w-[120px]',
      align: 'right',
      cell: (p) => <span className={cn('tabular text-base font-semibold', p.stock_status === 'out' ? 'text-danger' : p.stock_status === 'low' ? 'text-warning' : 'text-ink')}>{p.stock_quantity}</span>,
    },
    { key: 'reorder', header: 'Reorder level', width: 'w-[128px]', align: 'right', hideBelow: 'sm', cell: (p) => <span className="tabular text-ink-muted">{p.reorder_threshold}</span> },
    { key: 'status', header: 'Status', width: 'w-[156px]', hideBelow: 'sm', cell: (p) => <StockBadge status={p.stock_status} /> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      width: canWrite ? 'w-[96px] sm:w-[148px]' : 'w-[64px]',
      align: 'right',
      cell: (p) => (
        <div className="flex items-center justify-end gap-1">
          <IconButton size="sm" label={`Stock history of ${p.name}`} icon={<History />} onClick={() => setHistory(p)} />
          {canWrite && (
            <Button size="sm" variant="secondary" leadingIcon={<SlidersHorizontal className="h-3.5 w-3.5" />} onClick={() => setAdjusting(p)} aria-label={`Adjust stock of ${p.name}`}>
              <span className="hidden sm:inline">Adjust</span>
            </Button>
          )}
        </div>
      ),
      skeleton: <span />,
    },
  ]

  const statusFilter = (s: StockStatus) => update({ status: filters.status === s ? '' : s, lowOnly: false })
  const pct = (n?: number) => (n === undefined || !stock.counts.total ? 0 : Math.round((n * 100) / stock.counts.total))
  const filtered = Boolean(filters.search || filters.depotId || filters.lowOnly || filters.status)

  return (
    <div className="space-y-8">
      <header>
        <p className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-line bg-surface/70 px-2.5 py-1 text-xs font-medium text-ink-muted shadow-soft backdrop-blur">
          <Boxes className="h-3.5 w-3.5 text-brand-ink" aria-hidden="true" />
          Workshop stores
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">Spare parts</h1>
        <p className="mt-1.5 max-w-xl text-sm text-ink-muted">Live stock counts. Out-of-stock and low parts are flagged so they are reordered before a repair waits.</p>
      </header>

      <section aria-label="Stock summary" className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
        <StatCard label="Parts tracked" value={stock.counts.total} isLoading={stock.isLoading} icon={<Boxes />} tone="brand" pressed={!filters.status && !filters.lowOnly} onClick={() => update({ status: '', lowOnly: false })} footer={<StatShare value={pct(stock.counts.ok)} tone="brand" caption="well stocked" />} />
        <StatCard label="Out of stock" value={stock.counts.out} isLoading={stock.isLoading} icon={<PackageX />} tone="danger" pressed={filters.status === 'out'} onClick={() => statusFilter('out')} footer={<StatShare value={pct(stock.counts.out)} tone="danger" caption="reorder now" />} />
        <StatCard label="Low" value={stock.counts.low} isLoading={stock.isLoading} icon={<PackageMinus />} tone="warning" pressed={filters.status === 'low'} onClick={() => statusFilter('low')} footer={<StatShare value={pct(stock.counts.low)} tone="warning" caption="at or below reorder level" />} />
        <StatCard label="OK" value={stock.counts.ok} isLoading={stock.isLoading} icon={<PackageCheck />} tone="success" pressed={filters.status === 'ok'} onClick={() => statusFilter('ok')} footer={<StatShare value={pct(stock.counts.ok)} tone="success" caption="above reorder level" />} />
      </section>

      <section aria-label="Parts" className="space-y-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="relative flex-1 lg:max-w-md">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-subtle" aria-hidden="true" />
            <input
              type="search"
              aria-label="Search parts"
              placeholder="Search part name or number"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              className="focus-ring h-10 w-full rounded-control border border-line-strong bg-surface pl-10 pr-10 text-sm text-ink shadow-soft placeholder:text-ink-subtle hover:border-ink-subtle/50 focus:border-brand"
            />
            {list.isFetching && searchText && <Spinner className="absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-subtle" />}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {(depots.data?.length ?? 0) > 1 && (
              <FilterSelect label="Depot" icon={<Building2 />} value={filters.depotId} emptyValue="" options={[{ value: '', label: 'All depots' }, ...(depots.data ?? []).map((d) => ({ value: d.id, label: d.name }))]} onChange={(depotId) => update({ depotId })} />
            )}
            <button
              type="button"
              role="switch"
              aria-checked={filters.lowOnly}
              onClick={() => update({ lowOnly: !filters.lowOnly, status: '' })}
              className={cn(
                'focus-ring inline-flex h-10 items-center gap-2.5 rounded-control border px-3.5 text-sm shadow-soft transition-all duration-150 ease-smooth',
                filters.lowOnly ? 'border-brand/30 bg-brand-soft text-brand-ink' : 'border-line-strong bg-surface text-ink-muted hover:text-ink',
              )}
            >
              <span className={cn('relative h-4 w-7 rounded-full transition-colors duration-200', filters.lowOnly ? 'bg-brand' : 'bg-line-strong')} aria-hidden="true">
                <span className={cn('absolute left-0 top-0.5 h-3 w-3 rounded-full bg-white shadow-soft transition-transform duration-200 ease-smooth', filters.lowOnly ? 'translate-x-3.5' : 'translate-x-0.5')} />
              </span>
              Show low stock only
            </button>
            {filtered && (
              <Button
                variant="ghost"
                leadingIcon={<X className="h-4 w-4" />}
                onClick={() => {
                  setSearchText('')
                  update({ search: '', depotId: '', lowOnly: false, status: '' })
                }}
              >
                Clear
              </Button>
            )}
          </div>
        </div>

        <DataTable
          caption="Spare parts"
          columns={columns}
          data={list.data?.parts}
          rowKey={(p) => p.id}
          isLoading={list.isPending}
          error={list.isError ? list.error : undefined}
          onRetry={() => void list.refetch()}
          sort={{
            key: filters.sortBy,
            order: filters.sortOrder,
            onChange: (key) =>
              key === filters.sortBy ? update({ sortOrder: filters.sortOrder === 'asc' ? 'desc' : 'asc' }) : update({ sortBy: key as PartFilters['sortBy'], sortOrder: 'asc' }),
          }}
          pagination={list.data ? { page: filters.page, pageSize: filters.pageSize, totalItems: list.data.meta.total_items, onPageChange: (page) => setParams(writeFilters({ ...filters, page })) } : undefined}
          emptyState={
            filtered ? (
              <EmptyState icon={<Search />} heading={filters.lowOnly || filters.status ? 'Nothing low on stock here' : 'No parts match'} description={filters.lowOnly ? 'Every part is above its reorder level.' : 'Try another search or clear the filters.'} />
            ) : (
              <EmptyState icon={<Boxes />} heading="No parts in stock records" description="Parts appear here once they are added to the inventory." />
            )
          }
        />
      </section>

      <AdjustStockDialog part={adjusting} onClose={() => setAdjusting(null)} />
      <HistoryDrawer part={history} onClose={() => setHistory(null)} />
    </div>
  )
}

function HistoryDrawer({ part, onClose }: { part: Part | null; onClose: () => void }) {
  const movements = useMovements(part?.id ?? null)
  return (
    <Drawer open={part !== null} onClose={onClose} title={`Stock history · ${part?.name ?? ''}`} description={part ? `${part.part_number} · ${part.stock_quantity} in stock now` : undefined}>
      {movements.isPending ? (
        <div className="flex justify-center py-10">
          <Spinner className="h-5 w-5 text-ink-subtle" />
        </div>
      ) : (movements.data ?? []).length === 0 ? (
        <p className="text-sm text-ink-subtle">No stock movements yet.</p>
      ) : (
        <ol className="relative space-y-4 border-l border-line pl-5">
          {(movements.data ?? []).map((m) => {
            const up = m.quantity_delta > 0
            return (
              <li key={m.id} className="relative">
                <span className={cn('absolute -left-[29px] top-0.5 flex h-4 w-4 items-center justify-center rounded-full ring-4 ring-surface', up ? 'bg-success text-white' : 'bg-danger-solid text-white')} aria-hidden="true">
                  {up ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                </span>
                <p className="flex items-center justify-between gap-3 text-sm">
                  <span className="font-medium text-ink">{MOVEMENT_LABELS[m.movement_type]}</span>
                  <span className={cn('tabular font-semibold', up ? 'text-success' : 'text-danger')}>
                    {up ? '+' : ''}
                    {m.quantity_delta}
                  </span>
                </p>
                <p className="text-xs text-ink-subtle">
                  {new Date(m.occurred_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                  {m.notes ? ` · ${m.notes}` : ''}
                </p>
              </li>
            )
          })}
        </ol>
      )}
    </Drawer>
  )
}

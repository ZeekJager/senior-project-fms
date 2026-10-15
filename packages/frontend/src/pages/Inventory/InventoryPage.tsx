import { ArrowDownRight, ArrowUpRight, Boxes, Building2, History, Search, SlidersHorizontal } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { DataTable, EmptyState, ListToolbar, type Column } from '@/components/shared'
import { Badge, Button, cn, Drawer, FilterSelect, IconButton, Spinner } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import { useDepots } from '@/features/depots'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { describeFilters } from '@/lib/describeFilters'
import { AdjustStockDialog } from './AdjustStockDialog'
import { useMovements, useParts, useStockCounts, type Movement, type Part, type PartFilters, type StockStatus } from './api'

const STOCK_VIEW: Record<string, string> = { ok: 'OK', low: 'Low', out: 'Out of stock' }

/** OUT OF STOCK (red) at 0, LOW (amber) from 1 to the reorder level, OK (green) above it (FMS-25). */
export function StockBadge({ status }: { status: StockStatus }) {
  // Healthy is the normal state: plain text, so the pills that remain are the exceptions.
  if (status === 'ok') {
    return (
      <span data-stock="ok" className="inline-flex items-center gap-1.5 text-sm text-ink-muted">
        <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />
        OK
      </span>
    )
  }
  const [tone, label] = status === 'out' ? (['danger', 'OUT OF STOCK'] as const) : (['warning', 'LOW'] as const)
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

type StockView = 'all' | 'reorder' | StockStatus

/** Which view the URL's filters amount to (null for a status together with "needs reorder"). */
function stockViewOf(f: PartFilters): StockView | null {
  if (f.lowOnly) return f.status ? null : 'reorder'
  return f.status || 'all'
}

const stockPatch = (view: StockView): Partial<PartFilters> =>
  view === 'all' ? { status: '', lowOnly: false } : view === 'reorder' ? { status: '', lowOnly: true } : { status: view, lowOnly: false }

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

  const filtered = Boolean(filters.search || filters.depotId || filters.lowOnly || filters.status)

  return (
    <div className="space-y-6">
      <header className="border-b border-line pb-5">
        <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">Spare parts</h1>
        <p className="mt-1 max-w-xl text-sm text-ink-muted">Live stock counts, with low and out-of-stock parts flagged.</p>
      </header>

      <section aria-label="Parts" className="space-y-0">

        <DataTable

          toolbar={
            <ListToolbar
              views={{
                label: 'Stock views',
                value: stockViewOf(filters),
                options: [
                  { value: 'all', label: 'All', count: stock.counts.total, isLoading: stock.isLoading },
                  {
                    value: 'reorder',
                    label: 'Needs reorder',
                    count: stock.counts.out === undefined || stock.counts.low === undefined ? undefined : stock.counts.out + stock.counts.low,
                    isLoading: stock.isLoading,
                    hint: 'Out of stock, or at or below the reorder level',
                  },
                  { value: 'out', label: 'Out of stock', count: stock.counts.out, isLoading: stock.isLoading },
                  { value: 'low', label: 'Low', count: stock.counts.low, isLoading: stock.isLoading, hint: 'At or below the reorder level' },
                  { value: 'ok', label: 'OK', count: stock.counts.ok, isLoading: stock.isLoading, hint: 'Above the reorder level' },
                ],
                onChange: (view) => update(stockPatch(view)),
              }}
              search={{ label: 'Search parts', placeholder: 'Part name or number', value: searchText, onChange: setSearchText, busy: list.isFetching }}
              onClear={
                filtered
                  ? () => {
                      setSearchText('')
                      update({ search: '', depotId: '', lowOnly: false, status: '' })
                    }
                  : undefined
              }
            >
              {(depots.data?.length ?? 0) > 1 && (
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
          caption="Spare parts"
          rowHeight="stacked"
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
              <EmptyState icon={<Search />} heading={filters.lowOnly || filters.status ? 'Nothing low on stock here' : 'No parts match'} description={filters.lowOnly ? 'Every part is above its reorder level.' : `${describeFilters({ search: filters.search, view: filters.status ? STOCK_VIEW[filters.status] : undefined })} Try another search or clear the filters.`.trim()} />
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

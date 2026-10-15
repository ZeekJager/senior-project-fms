import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import type { PageMeta } from '@/lib/api/client'

// Spare parts stock (api-contract §10.1, FMS-23). This screen is a stock count
// view: the API's unit_cost_cents is deliberately never shown (FMS-25).

export type StockStatus = 'out' | 'low' | 'ok'

export interface Part {
  id: string
  part_number: string
  name: string
  description: string | null
  depot_id: string | null
  stock_quantity: number
  reorder_threshold: number
  below_reorder: boolean
  stock_status: StockStatus
  is_active: boolean
  version: number
  updated_at: string
}

export interface Movement {
  id: string
  movement_type: 'purchase' | 'consumption' | 'adjustment' | 'transfer_in' | 'transfer_out' | 'return'
  quantity_delta: number
  reference_type: string | null
  notes: string | null
  performed_by: string | null
  occurred_at: string
}

export interface PartFilters {
  search: string
  depotId: string
  lowOnly: boolean
  status: StockStatus | ''
  sortBy: 'name' | 'stock_quantity'
  sortOrder: 'asc' | 'desc'
  page: number
  pageSize: number
}

function partQuery(f: PartFilters): string {
  const q = new URLSearchParams({ page: String(f.page), page_size: String(f.pageSize), sort_by: f.sortBy, sort_order: f.sortOrder })
  if (f.search.trim()) q.set('search', f.search.trim())
  if (f.depotId) q.set('depot_id', f.depotId)
  if (f.lowOnly) q.set('below_reorder', 'true')
  if (f.status) q.set('stock_status', f.status)
  return q.toString()
}

export function useParts(filters: PartFilters) {
  const { api } = useAuth()
  return useQuery({
    queryKey: ['inventory', 'list', filters],
    queryFn: async () => {
      const { data, meta } = await api.requestEnvelope<Part[]>(`/inventory?${partQuery(filters)}`)
      return { parts: data, meta: meta as unknown as PageMeta }
    },
  })
}

/** Totals per stock status for the stat cards (one tiny request each). */
export function useStockCounts(depotId: string) {
  const { api } = useAuth()
  const figures = { total: '', out: 'out', low: 'low', ok: 'ok' }
  const results = useQueries({
    queries: Object.entries(figures).map(([name, status]) => ({
      placeholderData: keepPreviousData,
      queryKey: ['inventory', 'counts', depotId, name],
      queryFn: async () => {
        const q = new URLSearchParams({ page_size: '1' })
        if (status) q.set('stock_status', status)
        if (depotId) q.set('depot_id', depotId)
        return ((await api.requestEnvelope<Part[]>(`/inventory?${q}`)).meta as unknown as PageMeta).total_items
      },
    })),
  })
  const [total, out, low, ok] = results.map((r) => r.data)
  return { counts: { total, out, low, ok }, isLoading: results.some((r) => r.isPending) }
}

export function useMovements(partId: string | null) {
  const { api } = useAuth()
  return useQuery({
    queryKey: ['inventory', 'movements', partId],
    queryFn: () => api.request<Movement[]>(`/inventory/${partId}/movements?page_size=50`),
    enabled: Boolean(partId),
  })
}

/** POST /inventory/{id}/adjust: + in, - out, with a reason. A take-out below zero is 409 CONFLICT_INSUFFICIENT_STOCK. */
export function useAdjustStock() {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ partId, quantity, reason }: { partId: string; quantity: number; reason: string }) =>
      api.request<Part>(`/inventory/${partId}/adjust`, { method: 'POST', json: { quantity, reason } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['inventory'] }),
  })
}

import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import type { PageMeta } from '@/lib/api/client'

// Depot administration (FMS-80, api-contract §6.1): admin and fleet owner (depot:write).

/** A depot as GET /depots returns it to someone who manages them. */
export interface DepotRecord {
  id: string
  name: string
  code: string | null
  location: string
  address: string | null
  city: string | null
  country: string | null
  timezone: string | null
  latitude: number | null
  longitude: number | null
  capacity: number | null
  is_active: boolean
  version: number
  created_at: string
  updated_at: string
}

export type DepotInput = {
  name: string
  location: string
  code: string | null
  address: string | null
  city: string | null
  country: string | null
  timezone: string | null
  latitude: number | null
  longitude: number | null
  capacity: number | null
}

export type DepotStatus = 'active' | 'inactive'

export interface DepotFilters {
  search: string
  status: DepotStatus
  page: number
  pageSize: number
}

const keys = {
  all: ['depot-admin'] as const,
  list: (f: DepotFilters) => ['depot-admin', 'list', f] as const,
  counts: ['depot-admin', 'counts'] as const,
}

export function useDepotList(filters: DepotFilters) {
  const { api } = useAuth()
  return useQuery({
    queryKey: keys.list(filters),
    queryFn: async () => {
      const q = new URLSearchParams({ page: String(filters.page), page_size: String(filters.pageSize), status: filters.status })
      if (filters.search.trim()) q.set('search', filters.search.trim())
      const { data, meta } = await api.requestEnvelope<DepotRecord[]>(`/depots?${q}`)
      return { depots: data, meta: meta as unknown as PageMeta }
    },
    placeholderData: keepPreviousData,
  })
}

/** Active and inactive totals for the views. */
export function useDepotCounts() {
  const { api } = useAuth()
  const results = useQueries({
    queries: (['active', 'inactive'] as const).map((status) => ({
      queryKey: [...keys.counts, status],
      queryFn: async () => ((await api.requestEnvelope<DepotRecord[]>(`/depots?page_size=1&status=${status}`)).meta as unknown as PageMeta).total_items,
    })),
  })
  const [active, inactive] = results.map((r) => r.data)
  return { counts: { active, inactive }, isLoading: results.some((r) => r.isPending) }
}

/** After any change: this screen's lists, and the depot pickers every other screen uses (features/depots). */
function useInvalidate() {
  const queryClient = useQueryClient()
  return () => Promise.all([queryClient.invalidateQueries({ queryKey: keys.all }), queryClient.invalidateQueries({ queryKey: ['depots'] })])
}

export function useCreateDepot() {
  const { api } = useAuth()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (input: DepotInput) => api.request<DepotRecord>('/depots', { method: 'POST', json: input }),
    onSuccess: invalidate,
  })
}

/** PATCH with If-Match: someone else's change in between is a 409, never silently overwritten. */
export function useUpdateDepot() {
  const { api } = useAuth()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, version, patch }: { id: string; version: number; patch: Partial<DepotInput> }) =>
      api.request<DepotRecord>(`/depots/${id}`, { method: 'PATCH', json: patch, headers: { 'If-Match': `"${version}"` } }),
    onSuccess: invalidate,
  })
}

/** DELETE: soft. Refused (409 CONFLICT_DEPOT_NOT_EMPTY) while vehicles, drivers or accounts still belong to it. */
export function useDeactivateDepot() {
  const { api } = useAuth()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (id: string) => api.request<void>(`/depots/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  })
}

export function useReactivateDepot() {
  const { api } = useAuth()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (id: string) => api.request<DepotRecord>(`/depots/${id}/reactivate`, { method: 'POST' }),
    onSuccess: invalidate,
  })
}

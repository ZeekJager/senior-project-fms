import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import { healthKeys } from '@/features/health/api'
import type { HealthView, PredictionFeedback } from '@/features/health/health'
import type { FailureEvent } from '@/pages/Maintenance/failures'
import type { Vehicle } from '@/pages/Vehicles/types'

export type HealthSort = 'health_score' | 'registration_number' | 'depot'

/** The screen's state, kept in the URL: view, search, depot, sort and page. */
export interface HealthFilters {
  view: HealthView | ''
  search: string
  depotId: string
  sortBy: HealthSort
  sortOrder: 'asc' | 'desc'
  page: number
  pageSize: number
}

interface PageMeta {
  total_items: number
}

const SORTS: readonly HealthSort[] = ['health_score', 'registration_number', 'depot']
const VIEWS: readonly HealthView[] = ['at_risk', 'watch', 'healthy', 'stale', 'unscored']

export function readFilters(p: URLSearchParams): HealthFilters {
  const view = p.get('view') as HealthView | null
  const sort = p.get('sort') as HealthSort | null
  return {
    view: view && VIEWS.includes(view) ? view : '',
    search: p.get('q') ?? '',
    depotId: p.get('depot') ?? '',
    sortBy: sort && SORTS.includes(sort) ? sort : 'health_score',
    sortOrder: p.get('order') === 'desc' ? 'desc' : 'asc',
    page: Math.max(1, Number(p.get('page')) || 1),
    pageSize: [25, 50, 100].includes(Number(p.get('size'))) ? Number(p.get('size')) : 25,
  }
}

/** Defaults stay out of the URL, so the plain address is the riskiest-first fleet. */
export function writeFilters(f: HealthFilters): URLSearchParams {
  const p = new URLSearchParams()
  if (f.view) p.set('view', f.view)
  if (f.search) p.set('q', f.search)
  if (f.depotId) p.set('depot', f.depotId)
  if (f.sortBy !== 'health_score') p.set('sort', f.sortBy)
  if (f.sortOrder !== 'asc') p.set('order', f.sortOrder)
  if (f.page > 1) p.set('page', String(f.page))
  if (f.pageSize !== 25) p.set('size', String(f.pageSize))
  return p
}

const keys = {
  list: (f: HealthFilters) => ['vehicle-health', 'list', f] as const,
  counts: (depotId: string, search: string) => ['vehicle-health', 'counts', depotId, search] as const,
}

/** GET /vehicles with the health filter (FMS-56): riskiest first by default; unscored vehicles sort last. */
export function useHealthList(f: HealthFilters) {
  const { api } = useAuth()
  return useQuery({
    queryKey: keys.list(f),
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const q = new URLSearchParams({ sort_by: f.sortBy, sort_order: f.sortOrder, then_by: 'registration_number', page: String(f.page), page_size: String(f.pageSize) })
      if (f.view) q.set('health', f.view)
      if (f.search) q.set('search', f.search)
      if (f.depotId) q.set('depot_id', f.depotId)
      const { data, meta } = await api.requestEnvelope<Vehicle[]>(`/vehicles?${q}`)
      return { vehicles: data, total: (meta as unknown as PageMeta).total_items }
    },
  })
}

/**
 * The vehicle's latest failure records (GET /failure-events, maintenance:read), newest first: what a confirmed
 * issue can say it led to (FMS-128). Idle until asked for; a user who may not read them just gets none.
 */
export function useVehicleFailures(vehicleId: string, enabled: boolean) {
  const { api } = useAuth()
  return useQuery({
    queryKey: ['failure-events', 'vehicle', vehicleId],
    queryFn: () => api.request<FailureEvent[]>(`/failure-events?vehicle_id=${vehicleId}&page_size=10`),
    enabled,
    retry: false,
    staleTime: 30_000,
  })
}

/**
 * POST (first time) or PATCH (the author, within 7 days) /maintenance-predictions/{id}/feedback (FMS-128). The
 * vehicle's breakdown and the model registry's precision are read again afterwards.
 */
export function useSaveFeedback(vehicleId: string, predictionId: string) {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ body, existing }: { body: Record<string, unknown>; existing: boolean }) =>
      api.request<PredictionFeedback>(`/maintenance-predictions/${predictionId}/feedback`, { method: existing ? 'PATCH' : 'POST', json: body }),
    // Also after a refusal: a second technician's answer may already be there.
    onSettled: () =>
      Promise.all([queryClient.invalidateQueries({ queryKey: healthKeys.risk(vehicleId) }), queryClient.invalidateQueries({ queryKey: ['ml-models'] })]),
  })
}

/** How many vehicles each view holds, for the view tabs: one count request per view (page_size=1). */
export function useHealthCounts(depotId: string, search: string) {
  const { api } = useAuth()
  const views = ['', ...VIEWS] as const
  const results = useQueries({
    queries: views.map((view) => ({
      placeholderData: keepPreviousData,
      queryKey: [...keys.counts(depotId, search), view],
      queryFn: async () => {
        const q = new URLSearchParams({ page_size: '1' })
        if (view) q.set('health', view)
        if (depotId) q.set('depot_id', depotId)
        if (search) q.set('search', search)
        const { meta } = await api.requestEnvelope<Vehicle[]>(`/vehicles?${q}`)
        return (meta as unknown as PageMeta).total_items
      },
    })),
  })
  const counts = Object.fromEntries(views.map((v, i) => [v || 'all', results[i].data])) as Record<HealthView | 'all', number | undefined>
  return { counts, isLoading: results.some((r) => r.isPending) }
}

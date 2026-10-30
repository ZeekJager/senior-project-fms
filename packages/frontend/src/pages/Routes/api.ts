import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import type { PageMeta } from '@/lib/api/client'

// Planned routes (api-contract §7.1, FMS-83): origin, destination, stops and
// expected distance that trips are created from.

export interface Coordinates {
  latitude: number
  longitude: number
}

export interface RouteStop {
  name: string
  latitude: number | null
  longitude: number | null
}

export interface Route {
  id: string
  name: string
  depot_id: string
  origin_name: string | null
  origin: Coordinates | null
  destination_name: string | null
  destination: Coordinates | null
  stops: RouteStop[]
  /** Measured along the road (FMS-84) unless typed in: distance_source says which. */
  distance_km: number | null
  estimated_duration_seconds: number | null
  /** 'road': measured along the road; 'manual': typed in; null: unknown. */
  distance_source: 'road' | 'manual' | null
  /** When the road was measured (its line: GET /routes/{id}/geometry); null while it is not. */
  measured_at: string | null
  is_active: boolean
  version: number
  updated_at: string
}

/** A route's road (FMS-84): GeoJSON, so [longitude, latitude] pairs. */
export interface RoadLine {
  type: 'LineString'
  coordinates: [number, number][]
}

/** The road as map points, [latitude, longitude] as Leaflet takes them. */
export const roadPoints = (line: RoadLine | null | undefined): [number, number][] | null => (line ? line.coordinates.map(([lng, lat]) => [lat, lng]) : null)

export type RouteInput = {
  name: string
  depot_id: string
  origin_name: string | null
  origin: Coordinates | null
  destination_name: string | null
  destination: Coordinates | null
  stops: RouteStop[]
  distance_km: number | null
  estimated_duration_seconds: number | null
}

export type RouteStatus = 'active' | 'retired'

export interface RouteFilters {
  search: string
  depotId: string
  status: RouteStatus
  sortBy: 'name' | 'distance_km'
  sortOrder: 'asc' | 'desc'
  page: number
  pageSize: number
}

const keys = {
  routes: ['routes'] as const,
  list: (filters: RouteFilters) => ['routes', 'list', filters] as const,
  counts: (depotId: string) => ['routes', 'counts', depotId] as const,
  road: (id: string, measuredAt: string | null) => ['routes', 'road', id, measuredAt] as const,
}

/**
 * GET /routes/{id}/geometry (route:read): the road the route follows, once measured. Keyed on when it was
 * measured, so a road measured again is fetched again. Off for a route without a road.
 */
export function useRouteRoad(route: Pick<Route, 'id' | 'measured_at'> | null, enabled = true) {
  const { api } = useAuth()
  return useQuery({
    queryKey: keys.road(route?.id ?? '', route?.measured_at ?? null),
    queryFn: () => api.request<RoadLine | null>(`/routes/${route!.id}/geometry`),
    enabled: enabled && route !== null && route.measured_at !== null,
    staleTime: Infinity,
  })
}

function routeQuery(f: RouteFilters): string {
  const q = new URLSearchParams({ page: String(f.page), page_size: String(f.pageSize), status: f.status, sort_by: f.sortBy, sort_order: f.sortOrder })
  if (f.search.trim()) q.set('search', f.search.trim())
  if (f.depotId) q.set('depot_id', f.depotId)
  return q.toString()
}

export function useRoutes(filters: RouteFilters) {
  const { api } = useAuth()
  return useQuery({
    queryKey: keys.list(filters),
    queryFn: async () => {
      const { data, meta } = await api.requestEnvelope<Route[]>(`/routes?${routeQuery(filters)}`)
      return { routes: data, meta: meta as unknown as PageMeta }
    },
    placeholderData: keepPreviousData,
  })
}

/** Active and retired totals for the views (one tiny request each). */
export function useRouteCounts(depotId: string) {
  const { api } = useAuth()
  const results = useQueries({
    queries: (['active', 'retired'] as const).map((status) => ({
      placeholderData: keepPreviousData,
      queryKey: [...keys.counts(depotId), status],
      queryFn: async () => {
        const q = new URLSearchParams({ page_size: '1', status })
        if (depotId) q.set('depot_id', depotId)
        return ((await api.requestEnvelope<Route[]>(`/routes?${q}`)).meta as unknown as PageMeta).total_items
      },
    })),
  })
  const [active, retired] = results.map((r) => r.data)
  return { counts: { active, retired }, isLoading: results.some((r) => r.isPending) }
}

function useInvalidate() {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: keys.routes })
}

export function useCreateRoute() {
  const { api } = useAuth()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (input: RouteInput) => api.request<Route>('/routes', { method: 'POST', json: input }),
    onSuccess: invalidate,
  })
}

/** PATCH with If-Match: someone else's change in between is a 409, never silently overwritten. Retiring is `{ is_active: false }`. */
export function useUpdateRoute() {
  const { api } = useAuth()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, version, patch }: { id: string; version: number; patch: Partial<RouteInput> & { is_active?: boolean } }) =>
      api.request<Route>(`/routes/${id}`, { method: 'PATCH', json: patch, headers: { 'If-Match': `"${version}"` } }),
    onSuccess: invalidate,
  })
}

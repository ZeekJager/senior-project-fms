import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'

// Geofences (FMS-90, api-contract §11.1): what a depot's vehicles must stay inside or out of. Read with tracking:read
// (the Geofences screen and the live map draw them); drawn and changed with geofence:write (admin).

export type GeofenceKind = 'keep_in' | 'keep_out'
export type GeofenceApplies = 'always' | 'off_trip'

/** GeoJSON: one ring of [longitude, latitude], closed. */
export interface GeofencePolygon {
  type: 'Polygon'
  coordinates: [number, number][][]
}

export interface Geofence {
  geofence_id: string
  depot_id: string
  name: string
  description: string | null
  kind: GeofenceKind
  applies: GeofenceApplies
  polygon: GeofencePolygon
  area_m2: number
  is_active: boolean
  version: number
  created_at: string
  updated_at: string
  updated_by: string | null
  updated_by_name: string | null
}

export const KIND_LABELS: Record<GeofenceKind, string> = { keep_in: 'Stay inside', keep_out: 'Keep out' }
export const APPLIES_LABELS: Record<GeofenceApplies, string> = { always: 'Always', off_trip: 'Only when not on a trip' }

export const geofenceKeys = {
  all: ['geofences'] as const,
  list: (depotId: string, status: 'active' | 'inactive') => ['geofences', depotId, status] as const,
}

/** A depot's geofences ('' for every depot in scope), active or removed. */
export function useGeofences(depotId: string, status: 'active' | 'inactive' = 'active', options: { enabled?: boolean } = {}) {
  const { api } = useAuth()
  return useQuery({
    queryKey: geofenceKeys.list(depotId, status),
    queryFn: () => {
      const q = new URLSearchParams({ status })
      if (depotId) q.set('depot_id', depotId)
      return api.request<Geofence[]>(`/geofences?${q}`)
    },
    staleTime: 60_000,
    enabled: options.enabled ?? true,
  })
}

/** The ring as Leaflet draws it: [latitude, longitude], without the closing corner. */
export function ringOf(polygon: GeofencePolygon): [number, number][] {
  const ring = polygon.coordinates[0] ?? []
  const open = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring
  return open.map(([lng, lat]) => [lat, lng])
}

/** "4.8 ha", "12 km²", "850 m²": a fence's size as people say it. */
export function areaLabel(m2: number): string {
  if (m2 >= 1_000_000) return `${(m2 / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: m2 >= 10_000_000 ? 0 : 1 })} km²`
  if (m2 >= 10_000) return `${(m2 / 10_000).toLocaleString('en-US', { maximumFractionDigits: 1 })} ha`
  return `${Math.round(m2).toLocaleString('en-US')} m²`
}

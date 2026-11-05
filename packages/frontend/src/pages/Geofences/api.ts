import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import { geofenceKeys, type Geofence, type GeofenceApplies, type GeofenceKind, type GeofencePolygon } from '@/features/geofences'

// Drawing and changing geofences (S-32, FMS-90): geofence:write, admin only.

export interface GeofenceInput {
  depot_id: string
  name: string
  description: string | null
  kind: GeofenceKind
  applies: GeofenceApplies
  polygon: GeofencePolygon
}

/** After any change: every list of fences, the live map's included. */
function useInvalidate() {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: geofenceKeys.all })
}

export function useCreateGeofence() {
  const { api } = useAuth()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (input: GeofenceInput) => api.request<Geofence>('/geofences', { method: 'POST', json: input }),
    onSuccess: invalidate,
  })
}

/** PATCH with If-Match: someone else's change in between is a 409, never silently overwritten. */
export function useUpdateGeofence() {
  const { api } = useAuth()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, version, patch }: { id: string; version: number; patch: Partial<GeofenceInput> }) =>
      api.request<Geofence>(`/geofences/${id}`, { method: 'PATCH', json: patch, headers: { 'If-Match': `"${version}"` } }),
    onSuccess: invalidate,
  })
}

/** DELETE: soft; its open violations close. */
export function useRemoveGeofence() {
  const { api } = useAuth()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (id: string) => api.request<void>(`/geofences/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  })
}

export function useRestoreGeofence() {
  const { api } = useAuth()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (id: string) => api.request<Geofence>(`/geofences/${id}/reactivate`, { method: 'POST' }),
    onSuccess: invalidate,
  })
}

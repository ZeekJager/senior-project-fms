import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import type { PageMeta } from '@/lib/api/client'
import { vehicleQuery, type VehicleFilters } from './filters'
import type { Vehicle } from './types'

// Server state for the vehicles screen. Every write invalidates what it can
// have changed, so the table, the counts and the documents stay in step.

const keys = {
  vehicles: ['vehicles'] as const,
  list: (filters: VehicleFilters) => ['vehicles', 'list', filters] as const,
  counts: (depotId: string) => ['vehicles', 'counts', depotId] as const,
  plate: (plate: string) => ['vehicles', 'plate', plate] as const,
}

export function useVehicles(filters: VehicleFilters) {
  const { api } = useAuth()
  return useQuery({
    queryKey: keys.list(filters),
    queryFn: async () => {
      const { data, meta } = await api.requestEnvelope<Vehicle[]>(`/vehicles?${vehicleQuery(filters)}`)
      return { vehicles: data, meta: meta as unknown as PageMeta }
    },
  })
}

/** Fleet totals for the stat cards: one tiny request per figure (page_size=1, read `total_items`). */
export function useFleetCounts(depotId: string) {
  const { api } = useAuth()
  const figures = {
    total: '',
    active: 'status=active',
    maintenance: 'status=maintenance',
    inactive: 'status=inactive',
    flagged: 'maintenance_flag=true',
  }
  const results = useQueries({
    queries: Object.entries(figures).map(([name, filter]) => ({
      queryKey: [...keys.counts(depotId), name],
      queryFn: async () => {
        const q = new URLSearchParams(filter)
        q.set('page_size', '1')
        if (depotId) q.set('depot_id', depotId)
        const { meta } = await api.requestEnvelope<Vehicle[]>(`/vehicles?${q}`)
        return (meta as unknown as PageMeta).total_items
      },
    })),
  })
  const [total, active, maintenance, inactive, flagged] = results.map((r) => r.data)
  return {
    counts: { total, active, maintenance, inactive, flagged },
    isLoading: results.some((r) => r.isPending),
    isError: results.some((r) => r.isError),
  }
}

/**
 * Is this plate already registered? Searches the API and compares the
 * normalized plate exactly. Only vehicles in the caller's scope are visible,
 * so the server's 409 on submit stays the final word.
 */
export function usePlateCheck(plate: string, enabled: boolean) {
  const { api } = useAuth()
  return useQuery({
    queryKey: keys.plate(plate),
    queryFn: async () => {
      const q = new URLSearchParams({ search: plate, page_size: '10' })
      const matches = await api.request<Vehicle[]>(`/vehicles?${q}`)
      return matches.find((v) => v.registration_number === plate) ?? null
    },
    enabled: enabled && plate.length > 0,
    staleTime: 10_000,
  })
}

export type VehicleInput = {
  registration_number: string
  vin: string | null
  make: string
  model: string
  year: number | null
  vehicle_type: string
  fuel_type: string
  fuel_efficiency_ml_per_km: number | null
  depot_id: string
  odometer_km?: number
}

function useInvalidate() {
  const queryClient = useQueryClient()
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.vehicles }),
      queryClient.invalidateQueries({ queryKey: ['documents'] }),
    ])
}

export function useCreateVehicle() {
  const { api } = useAuth()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (input: VehicleInput) => api.request<Vehicle>('/vehicles', { method: 'POST', json: input }),
    onSuccess: invalidate,
  })
}

/** PATCH with If-Match: someone else's change in between is a 409, never silently overwritten. */
export function useUpdateVehicle() {
  const { api } = useAuth()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, version, patch }: { id: string; version: number; patch: Partial<VehicleInput> }) =>
      api.request<Vehicle>(`/vehicles/${id}`, { method: 'PATCH', json: patch, headers: { 'If-Match': `"${version}"` } }),
    onSuccess: invalidate,
  })
}

export function useDecommissionVehicle() {
  const { api } = useAuth()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (id: string) => api.request<void>(`/vehicles/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  })
}

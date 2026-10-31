import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import type { PageMeta } from '@/lib/api/client'

// Preventive service programs and service due (api-contract §10.4, FMS-129).

export const SERVICE_MEASURES = ['km', 'days', 'engine_hours'] as const
export type ServiceMeasure = (typeof SERVICE_MEASURES)[number]
export type ServiceDueStatus = 'upcoming' | 'due' | 'overdue'

export const VEHICLE_TYPES = ['car', 'suv', 'van', 'truck', 'bus', 'motorcycle', 'other'] as const
export const FUEL_TYPES = ['petrol', 'diesel', 'hybrid', 'electric', 'cng', 'lpg', 'other'] as const
export type VehicleType = (typeof VEHICLE_TYPES)[number]
export type FuelType = (typeof FUEL_TYPES)[number]

export interface ServiceProgram {
  id: string
  name: string
  description: string | null
  /** Null: fleet-wide. */
  depot_id: string | null
  vehicle_type: VehicleType | null
  fuel_type: FuelType | null
  make: string | null
  model: string | null
  interval_km: number | null
  lead_km: number | null
  interval_days: number | null
  lead_days: number | null
  interval_engine_hours: number | null
  lead_engine_hours: number | null
  tasks: string[]
  is_active: boolean
  /** The caller's vehicles it covers, by status. */
  vehicles: { total: number; upcoming: number; due: number; overdue: number }
  version: number
  created_at: string
  updated_at: string
}

export type ServiceProgramInput = Omit<ServiceProgram, 'id' | 'is_active' | 'vehicles' | 'version' | 'created_at' | 'updated_at'>

export interface ServiceDue {
  vehicle_id: string
  registration_number: string
  depot_id: string
  program: { id: string; name: string; tasks: string[] }
  status: ServiceDueStatus
  due_by: ServiceMeasure[]
  last_service: { maintenance_record_id: string; completed_at: string } | null
  since: { at: string; odometer_km: number; engine_hours: number | null }
  next_due: { odometer_km: number | null; at: string | null; engine_hours: number | null }
  readings: { odometer_km: number; engine_hours: number | null }
  /** Negative when overdue. */
  remaining: { km: number | null; days: number | null; engine_hours: number | null }
  open_record: { id: string; status: string; scheduled_at: string | null } | null
  status_changed_at: string
  computed_at: string
}

/** The dispatch board's summary of a vehicle's service due (GET /dispatch/availability). */
export interface ServiceDueSummary {
  status: 'due' | 'overdue'
  programs: { program_id: string; name: string; status: 'due' | 'overdue'; due_by: ServiceMeasure[] }[]
}

export interface ProgramFilters {
  status: 'active' | 'retired'
  depotId: string
  page: number
}

export interface DueFilters {
  /** Which statuses: due and overdue together, or one of them. */
  status: 'attention' | 'overdue' | 'due'
  depotId: string
  page: number
}

export const serviceKeys = {
  all: ['service-programs'] as const,
  programs: (f: ProgramFilters) => ['service-programs', 'list', f] as const,
  programCounts: (depotId: string) => ['service-programs', 'counts', depotId] as const,
  due: (f: DueFilters) => ['service-programs', 'due', f] as const,
  dueCount: ['service-programs', 'due-count'] as const,
  vehicle: (vehicleId: string) => ['service-programs', 'vehicle', vehicleId] as const,
}

export function useServicePrograms(filters: ProgramFilters) {
  const { api } = useAuth()
  return useQuery({
    queryKey: serviceKeys.programs(filters),
    queryFn: async () => {
      const q = new URLSearchParams({ page: String(filters.page), page_size: '50', status: filters.status })
      if (filters.depotId) q.set('depot_id', filters.depotId)
      const { data, meta } = await api.requestEnvelope<ServiceProgram[]>(`/service-programs?${q}`)
      return { programs: data, meta: meta as unknown as PageMeta }
    },
    placeholderData: keepPreviousData,
  })
}

/** Active and retired totals, for the views. */
export function useProgramCounts(depotId: string) {
  const { api } = useAuth()
  return useQuery({
    queryKey: serviceKeys.programCounts(depotId),
    queryFn: async () => {
      const total = async (status: string) => {
        const q = new URLSearchParams({ page_size: '1', status })
        if (depotId) q.set('depot_id', depotId)
        return ((await api.requestEnvelope<ServiceProgram[]>(`/service-programs?${q}`)).meta as unknown as PageMeta).total_items
      }
      const [active, retired] = await Promise.all([total('active'), total('retired')])
      return { active, retired }
    },
    placeholderData: keepPreviousData,
  })
}

const STATUS_QUERY: Record<DueFilters['status'], string> = { attention: 'due,overdue', overdue: 'overdue', due: 'due' }

/** GET /service-due: the caller's vehicles due or overdue, most urgent first. */
export function useServiceDue(filters: DueFilters, enabled = true) {
  const { api } = useAuth()
  return useQuery({
    queryKey: serviceKeys.due(filters),
    queryFn: async () => {
      const q = new URLSearchParams({ page: String(filters.page), page_size: '25', status: STATUS_QUERY[filters.status] })
      if (filters.depotId) q.set('depot_id', filters.depotId)
      const { data, meta } = await api.requestEnvelope<ServiceDue[]>(`/service-due?${q}`)
      return { items: data, meta: meta as unknown as PageMeta }
    },
    placeholderData: keepPreviousData,
    enabled,
  })
}

/** How many services are due or overdue across the caller's vehicles: the tab's count. */
export function useServiceDueCount(enabled = true) {
  const { api } = useAuth()
  return useQuery({
    queryKey: serviceKeys.dueCount,
    queryFn: async () => ((await api.requestEnvelope<ServiceDue[]>('/service-due?page_size=1')).meta as unknown as PageMeta).total_items,
    enabled,
  })
}

/** GET /vehicles/{id}/service-due: every program covering the vehicle. */
export function useVehicleServiceDue(vehicleId: string | null, enabled = true) {
  const { api } = useAuth()
  return useQuery({
    queryKey: serviceKeys.vehicle(vehicleId ?? ''),
    queryFn: () => api.request<ServiceDue[]>(`/vehicles/${vehicleId}/service-due`),
    enabled: enabled && Boolean(vehicleId),
  })
}

function useInvalidate() {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: serviceKeys.all })
}

export function useCreateProgram() {
  const { api } = useAuth()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (input: Partial<ServiceProgramInput>) => api.request<ServiceProgram>('/service-programs', { method: 'POST', json: input }),
    onSuccess: invalidate,
  })
}

/** PATCH with If-Match: a change made meanwhile is a 409, never overwritten. Retiring is `{ is_active: false }`. */
export function useUpdateProgram() {
  const { api } = useAuth()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, version, patch }: { id: string; version: number; patch: Partial<ServiceProgramInput> & { is_active?: boolean } }) =>
      api.request<ServiceProgram>(`/service-programs/${id}`, { method: 'PATCH', json: patch, headers: { 'If-Match': `"${version}"` } }),
    onSuccess: invalidate,
  })
}

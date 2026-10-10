import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import type { PageMeta } from '@/lib/api/client'
import type { Vehicle } from '@/pages/Vehicles/types'

// Repair records (api-contract §10.1, FMS-22) and the parts they draw on (FMS-23).

export const MAINTENANCE_TYPES = ['corrective', 'preventive', 'inspection', 'predictive', 'other'] as const
export type MaintenanceType = (typeof MAINTENANCE_TYPES)[number]
export type MaintenanceStatus = 'scheduled' | 'open' | 'in_progress' | 'completed' | 'cancelled'

export const TYPE_LABELS: Record<MaintenanceType, string> = {
  corrective: 'Repair',
  preventive: 'Preventive service',
  inspection: 'Inspection',
  predictive: 'Predictive (AI flagged)',
  other: 'Other',
}

export interface PartLine {
  part_id: string
  part_number: string
  name: string
  quantity: number
  unit_cost_cents: number
  line_cost_cents: number
}

export interface MaintenanceRecord {
  id: string
  vehicle_id: string
  registration_number: string
  maintenance_type: MaintenanceType
  description: string | null
  status: MaintenanceStatus
  priority: 'low' | 'normal' | 'high' | 'critical'
  scheduled_at: string | null
  started_at: string | null
  completed_at: string | null
  odometer_km: number | null
  labour_hours: number | null
  total_cost_cents: number
  parts_cost_cents: number
  workshop: string | null
  notes: string | null
  completed_by: string | null
  parts: PartLine[]
  version: number
  created_at: string
  updated_at: string
}

export interface InventoryPart {
  id: string
  part_number: string
  name: string
  depot_id: string | null
  unit_cost_cents: number | null
  stock_quantity: number
  reorder_threshold: number
  below_reorder: boolean
  stock_status: 'out' | 'low' | 'ok'
}

export type MaintenanceWarning =
  | { warning: 'LOW_STOCK'; part_id: string; part_number: string; stock_quantity: number; shortfall: number }
  | { warning: 'COST_BELOW_PARTS'; total_cost_cents: number; parts_cost_cents: number }

export interface RecordFilters {
  view: 'open' | 'completed' | 'all'
  vehicleId: string
  page: number
}

export function useRecords(filters: RecordFilters) {
  const { api } = useAuth()
  return useQuery({
    queryKey: ['maintenance', 'list', filters],
    queryFn: async () => {
      const q = new URLSearchParams({ page: String(filters.page), page_size: '25' })
      if (filters.view === 'open') q.set('open', 'true')
      if (filters.view === 'completed') q.set('status', 'completed')
      if (filters.vehicleId) q.set('vehicle_id', filters.vehicleId)
      const { data, meta } = await api.requestEnvelope<MaintenanceRecord[]>(`/maintenance?${q}`)
      return { records: data, meta: meta as unknown as PageMeta }
    },
  })
}

/** Stat-card figures: open work, completed work, flagged vehicles, parts to reorder. */
export function useWorkshopCounts(canSeeInventory: boolean) {
  const { api } = useAuth()
  const total = async (path: string) => ((await api.requestEnvelope<unknown[]>(path)).meta as unknown as PageMeta).total_items
  const results = useQueries({
    queries: [
      { queryKey: ['maintenance', 'count', 'open'], queryFn: () => total('/maintenance?open=true&page_size=1') },
      { queryKey: ['maintenance', 'count', 'completed'], queryFn: () => total('/maintenance?status=completed&page_size=1') },
      { queryKey: ['vehicles', 'counts', 'flagged-workshop'], queryFn: () => total('/vehicles?maintenance_flag=true&page_size=1') },
      { queryKey: ['inventory', 'count', 'reorder'], queryFn: () => total('/inventory?below_reorder=true&page_size=1'), enabled: canSeeInventory },
    ],
  })
  const [open, completed, flagged, reorder] = results.map((r) => r.data)
  return { counts: { open, completed, flagged, reorder }, isLoading: results.slice(0, 3).some((r) => r.isPending) }
}

/** Vehicles waiting for the workshop: maintenance_flag = TRUE. */
export function useFlaggedVehicles() {
  const { api } = useAuth()
  return useQuery({
    queryKey: ['vehicles', 'flagged-for-workshop'],
    queryFn: () => api.request<Vehicle[]>('/vehicles?maintenance_flag=true&page_size=100&sort_by=registration_number'),
  })
}

/** Any vehicle by plate, make or model (for preventive work on a vehicle that is not flagged). */
export function useVehicleSearch(query: string) {
  const { api } = useAuth()
  return useQuery({
    queryKey: ['vehicles', 'workshop-search', query],
    queryFn: () => api.request<Vehicle[]>(`/vehicles?search=${encodeURIComponent(query)}&page_size=20`),
    enabled: query.trim().length >= 1,
    staleTime: 30_000,
  })
}

/** Parts by number or name, with their stock (the inline warnings come from here). */
export function usePartSearch(query: string, enabled: boolean) {
  const { api } = useAuth()
  return useQuery({
    queryKey: ['inventory', 'search', query],
    queryFn: () => api.request<InventoryPart[]>(`/inventory?search=${encodeURIComponent(query)}&page_size=20&sort_by=name`),
    enabled,
    staleTime: 15_000,
  })
}

export function useBelowReorder(enabled: boolean) {
  const { api } = useAuth()
  return useQuery({
    queryKey: ['inventory', 'below-reorder'],
    queryFn: () => api.request<InventoryPart[]>('/inventory?below_reorder=true&page_size=100&sort_by=stock_quantity'),
    enabled,
  })
}

/** Other open work on a vehicle: completing one record clears the flag only when there is none. */
export function useOpenWorkFor(vehicleId: string | null) {
  const { api } = useAuth()
  return useQuery({
    queryKey: ['maintenance', 'open-for', vehicleId],
    queryFn: () => api.request<MaintenanceRecord[]>(`/maintenance?vehicle_id=${vehicleId}&open=true&page_size=100`),
    enabled: Boolean(vehicleId),
  })
}

export interface RecordInput {
  vehicle_id: string
  maintenance_type: MaintenanceType
  description: string
  labour_hours: number
  total_cost_cents: number
  odometer_km?: number
  notes?: string | null
  parts: { part_id: string; quantity: number; unit_cost_cents: number }[]
}

function useInvalidate() {
  const queryClient = useQueryClient()
  return () =>
    Promise.all(['maintenance', 'vehicles', 'inventory'].map((key) => queryClient.invalidateQueries({ queryKey: [key] })))
}

/** POST /maintenance; returns the record and the server's warnings (LOW_STOCK, COST_BELOW_PARTS). */
export function useCreateRecord() {
  const { api } = useAuth()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: async (input: RecordInput) => {
      const { data, meta } = await api.requestEnvelope<MaintenanceRecord>('/maintenance', { method: 'POST', json: input })
      return { record: data, warnings: (meta.warnings as MaintenanceWarning[] | undefined) ?? [] }
    },
    onSuccess: invalidate,
  })
}

/** PUT /maintenance/{id} with completed_at (the card): completes the work and, if it was the last, clears the flag. */
export function useCompleteRecord() {
  const { api } = useAuth()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, version }: { id: string; version: number }) =>
      api.request<MaintenanceRecord>(`/maintenance/${id}`, {
        method: 'PUT',
        json: { completed_at: new Date().toISOString() },
        headers: { 'If-Match': `"${version}"` },
      }),
    onSuccess: invalidate,
  })
}

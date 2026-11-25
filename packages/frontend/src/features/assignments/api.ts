import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import type { PageMeta } from '@/lib/api/client'

// A driver's regular vehicle (FMS-77, api-contract §6.3, docs/driver-vehicle-assignments.md).

export type AssignmentType = 'primary' | 'temporary'

/** As the API returns it (DriverVehicleAssignment). */
export interface Assignment {
  id: string
  driver: { id: string; full_name: string | null }
  vehicle: { id: string; registration_number: string }
  depot_id: string
  assignment_type: AssignmentType
  start_at: string
  end_at: string | null
  status: 'active' | 'ended' | 'cancelled'
  current: boolean
  notes: string | null
  created_at: string
}

export interface AssignmentInput {
  driver_id: string
  vehicle_id: string
  assignment_type: AssignmentType
  start_at?: string
  end_at?: string | null
  notes?: string | null
}

export type AssignmentSubject = { kind: 'vehicle'; id: string } | { kind: 'driver'; id: string }

export const assignmentKeys = {
  all: ['driver-vehicle-assignments'] as const,
  of: (subject: AssignmentSubject, page: number) => ['driver-vehicle-assignments', subject.kind, subject.id, page] as const,
}

const PAGE_SIZE = 10

/** GET /vehicles/{id}/assignments or /drivers/{id}/assignments (assignment:read): newest first, the current one leading. */
export function useAssignments(subject: AssignmentSubject, page: number, enabled = true) {
  const { api } = useAuth()
  return useQuery({
    queryKey: assignmentKeys.of(subject, page),
    queryFn: async () => {
      const q = new URLSearchParams({ page: String(page), page_size: String(PAGE_SIZE) })
      const { data, meta } = await api.requestEnvelope<Assignment[]>(`/${subject.kind === 'vehicle' ? 'vehicles' : 'drivers'}/${subject.id}/assignments?${q}`)
      return { items: data, meta: meta as unknown as PageMeta }
    },
    enabled,
    placeholderData: keepPreviousData,
  })
}

function useInvalidate() {
  const client = useQueryClient()
  return () => client.invalidateQueries({ queryKey: assignmentKeys.all })
}

/** POST /driver-vehicle-assignments (assignment:write). */
export function useCreateAssignment() {
  const { api } = useAuth()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (input: AssignmentInput) => api.request<Assignment>('/driver-vehicle-assignments', { method: 'POST', json: input, idempotencyKey: true }),
    onSuccess: invalidate,
  })
}

/** POST /driver-vehicle-assignments/{id}/end (assignment:write): ends it now. */
export function useEndAssignment() {
  const { api } = useAuth()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (id: string) => api.request<Assignment>(`/driver-vehicle-assignments/${id}/end`, { method: 'POST', json: {} }),
    onSuccess: invalidate,
  })
}

/** What may be picked: the depot's active drivers or vehicles (driver:read / vehicle:read), one page of 100. */
export function useCandidates(kind: 'driver' | 'vehicle', depotId: string | null, enabled: boolean) {
  const { api } = useAuth()
  return useQuery({
    queryKey: ['driver-vehicle-assignments', 'candidates', kind, depotId],
    queryFn: async () => {
      const q = new URLSearchParams({ depot_id: depotId!, page_size: '100' })
      if (kind === 'driver') {
        const rows = await api.request<{ id: string; full_name: string; is_active?: boolean }[]>(`/drivers?${q}`)
        return rows.filter((r) => r.is_active !== false).map((r) => ({ value: r.id, label: r.full_name }))
      }
      const rows = await api.request<{ id: string; registration_number: string; is_active?: boolean }[]>(`/vehicles?${q}`)
      return rows.filter((r) => r.is_active !== false).map((r) => ({ value: r.id, label: r.registration_number }))
    },
    enabled: enabled && depotId !== null,
    staleTime: 60_000,
  })
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import type { FailureComponent } from '@/pages/Maintenance/failures'

// Warranties, warranty claims and recalls (api-contract §10.5, FMS-133, docs/warranties-recalls.md).

export type WarrantyStatus = 'active' | 'expiring' | 'expired' | 'not_started' | 'void'
export type ClaimStatus = 'claimable' | 'submitted' | 'approved' | 'rejected'
export type RecallVehicleStatus = 'open' | 'scheduled' | 'completed'

/** A vehicle's warranty (GET /warranties). Dates are YYYY-MM-DD, kilometres as entered. */
export interface Warranty {
  id: string
  vehicle_id: string
  registration_number: string
  /** Null: the whole vehicle. */
  component: FailureComponent | null
  provider: string
  coverage: string | null
  starts_on: string
  ends_on: string | null
  ends_km: number | null
  terms: string | null
  is_active: boolean
  status: WarrantyStatus
  days_left: number | null
  km_left: number | null
  claims: Record<ClaimStatus, number> & { recovered_cents: number }
  version: number
  created_at: string
  updated_at: string
}

/** The warranty claim on a repair (`warranty_claim` on a maintenance record). */
export interface WarrantyClaim {
  warranty_id: string
  provider: string
  component: FailureComponent | null
  status: ClaimStatus
  amount_cents: number | null
  reference: string | null
  /** False: the warranty ends at an odometer reading and the repair has none, so the distance was not checked. */
  km_checked: boolean
  updated_at: string | null
  updated_by: string | null
}

/** One vehicle a recall applies to, and its recall work. */
export interface RecallVehicle {
  recall_id: string
  campaign_code: string
  description: string
  remedy: string | null
  vehicle_id: string
  registration_number: string
  status: RecallVehicleStatus
  maintenance_record_id: string | null
  completed_at: string | null
  notes: string | null
  matched_at: string
  updated_at: string
}

export interface WarrantyInput {
  vehicle_id: string
  component: FailureComponent | null
  provider: string
  coverage: string | null
  starts_on: string
  ends_on: string | null
  ends_km: number | null
  terms: string | null
}

/** Where a claim can go from where it is (the API's rule). */
export const CLAIM_NEXT: Record<ClaimStatus, Exclude<ClaimStatus, 'claimable'>[]> = {
  claimable: ['submitted'],
  submitted: ['approved', 'rejected'],
  approved: [],
  rejected: ['submitted'],
}

export const CLAIM_LABELS: Record<ClaimStatus, string> = {
  claimable: 'Claimable',
  submitted: 'Claim submitted',
  approved: 'Claim approved',
  rejected: 'Claim rejected',
}

export const warrantyKeys = {
  warranties: (vehicleId: string) => ['warranties', vehicleId] as const,
  recalls: (vehicleId: string) => ['recalls', 'by-vehicle', vehicleId] as const,
}

/** GET /warranties?vehicle_id= (maintenance:read): live first, then by end date; voided ones too. */
export function useVehicleWarranties(vehicleId: string, enabled = true) {
  const { api } = useAuth()
  return useQuery({
    queryKey: warrantyKeys.warranties(vehicleId),
    queryFn: () => api.request<Warranty[]>(`/warranties?vehicle_id=${vehicleId}&include_void=true&page_size=100`),
    enabled,
  })
}

/** GET /vehicles/{id}/recalls (maintenance:read): open first. */
export function useVehicleRecalls(vehicleId: string, enabled = true) {
  const { api } = useAuth()
  return useQuery({
    queryKey: warrantyKeys.recalls(vehicleId),
    queryFn: () => api.request<RecallVehicle[]>(`/vehicles/${vehicleId}/recalls`),
    enabled,
  })
}

/** A warranty change can make repairs claimable, or not: their records are read again too. */
function useInvalidate() {
  const queryClient = useQueryClient()
  return () => Promise.all(['warranties', 'recalls', 'maintenance'].map((key) => queryClient.invalidateQueries({ queryKey: [key] })))
}

/** POST /warranties (maintenance:write). */
export function useCreateWarranty() {
  const { api } = useAuth()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (input: WarrantyInput) => api.request<Warranty>('/warranties', { method: 'POST', json: input }),
    onSuccess: invalidate,
  })
}

/** PATCH /warranties/{id} with If-Match: `is_active: false` voids it. */
export function useUpdateWarranty() {
  const { api } = useAuth()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, version, patch }: { id: string; version: number; patch: Partial<Omit<WarrantyInput, 'vehicle_id'>> & { is_active?: boolean } }) =>
      api.request<Warranty>(`/warranties/${id}`, { method: 'PATCH', json: patch, headers: { 'If-Match': `"${version}"` } }),
    onSuccess: invalidate,
  })
}

/** PATCH /maintenance-records/{id}/warranty-claim: submitted, approved (with the amount) or rejected. */
export function useUpdateClaim() {
  const { api } = useAuth()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ recordId, ...body }: { recordId: string; status: Exclude<ClaimStatus, 'claimable'>; amount_cents?: number; reference?: string | null }) =>
      api.request<WarrantyClaim>(`/maintenance-records/${recordId}/warranty-claim`, { method: 'PATCH', json: body }),
    onSuccess: invalidate,
  })
}

/** PATCH /recalls/{id}/vehicles/{vehicle_id}: completed by hand (done elsewhere), or the work order linked. */
export function useUpdateRecallVehicle() {
  const { api } = useAuth()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ recallId, vehicleId, ...body }: { recallId: string; vehicleId: string; status?: RecallVehicleStatus; maintenance_record_id?: string | null; notes?: string | null }) =>
      api.request<RecallVehicle>(`/recalls/${recallId}/vehicles/${vehicleId}`, { method: 'PATCH', json: body }),
    onSuccess: invalidate,
  })
}

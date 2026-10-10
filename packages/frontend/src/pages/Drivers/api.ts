import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import type { PageMeta } from '@/lib/api/client'
import { driverQuery, type DriverFilters } from './filters'
import type { Driver, LicenseCategory } from './types'

// Server state for the drivers screen. Every write invalidates the list, the
// counts and the documents.

export function useDrivers(filters: DriverFilters) {
  const { api } = useAuth()
  return useQuery({
    queryKey: ['drivers', 'list', filters],
    queryFn: async () => {
      const { data, meta } = await api.requestEnvelope<Driver[]>(`/drivers?${driverQuery(filters)}`)
      return { drivers: data, meta: meta as unknown as PageMeta }
    },
  })
}

/** Licence health for the stat cards: one tiny request per figure (page_size=1, read `total_items`). */
export function useLicenceCounts(depotId: string) {
  const { api } = useAuth()
  const figures = { total: '', valid: 'license_status=valid', expiring: 'license_status=expiring_soon', expired: 'license_status=expired' }
  const results = useQueries({
    queries: Object.entries(figures).map(([name, filter]) => ({
      queryKey: ['drivers', 'counts', depotId, name],
      queryFn: async () => {
        const q = new URLSearchParams(filter)
        q.set('page_size', '1')
        if (depotId) q.set('depot_id', depotId)
        const { meta } = await api.requestEnvelope<Driver[]>(`/drivers?${q}`)
        return (meta as unknown as PageMeta).total_items
      },
    })),
  })
  const [total, valid, expiring, expired] = results.map((r) => r.data)
  return { counts: { total, valid, expiring, expired }, isLoading: results.some((r) => r.isPending) }
}

export interface NewDriverInput {
  account: { full_name: string; email: string; phone: string | null }
  license_number: string
  license_categories: LicenseCategory[]
  license_expiry: string
  hire_date: string | null
  emergency_phone: string | null
  depot_id: string
}

export type DriverPatch = Partial<Omit<NewDriverInput, 'account'>>

function useInvalidate() {
  const queryClient = useQueryClient()
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['drivers'] }),
      queryClient.invalidateQueries({ queryKey: ['documents'] }),
    ])
}

/** POST /drivers with a new account: created with the driver role and no password (sign-in is set up later). */
export function useCreateDriver() {
  const { api } = useAuth()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (input: NewDriverInput) => api.request<Driver>('/drivers', { method: 'POST', json: input }),
    onSuccess: invalidate,
  })
}

/** PATCH with If-Match: someone else's change in between is a 409, never silently overwritten. */
export function useUpdateDriver() {
  const { api } = useAuth()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ id, version, patch }: { id: string; version: number; patch: DriverPatch }) =>
      api.request<Driver>(`/drivers/${id}`, { method: 'PATCH', json: patch, headers: { 'If-Match': `"${version}"` } }),
    onSuccess: invalidate,
  })
}

export function useRetireDriver() {
  const { api } = useAuth()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (id: string) => api.request<void>(`/drivers/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  })
}

export function useReinstateDriver() {
  const { api } = useAuth()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (id: string) => api.request<Driver>(`/drivers/${id}/reinstate`, { method: 'POST' }),
    onSuccess: invalidate,
  })
}

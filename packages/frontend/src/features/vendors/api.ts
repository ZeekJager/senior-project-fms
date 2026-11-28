import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import type { PageMeta } from '@/lib/api/client'

// Maintenance vendors (FMS-130, docs/work-orders.md): outside garages, dealers, tyre and parts suppliers.

export const VENDOR_TYPES = ['workshop', 'dealer', 'tyres', 'parts'] as const
export type VendorType = (typeof VENDOR_TYPES)[number]

export const VENDOR_TYPE_LABELS: Record<VendorType, string> = {
  workshop: 'Workshop',
  dealer: 'Dealer',
  tyres: 'Tyres',
  parts: 'Parts supplier',
}

export interface Vendor {
  id: string
  name: string
  vendor_type: VendorType
  contact_name: string | null
  phone: string | null
  email: string | null
  /** Null: every depot may use it. */
  depot_id: string | null
  notes: string | null
  is_active: boolean
  version: number
}

export interface VendorFilters {
  status: 'active' | 'retired'
  type: VendorType | ''
  search: string
  page: number
}

export interface VendorInput {
  name: string
  vendor_type: VendorType
  contact_name: string | null
  phone: string | null
  email: string | null
  depot_id: string | null
  notes: string | null
}

export const VENDOR_PAGE_SIZE = 50

export function useVendors(filters: VendorFilters) {
  const { api } = useAuth()
  return useQuery({
    queryKey: ['vendors', 'list', filters],
    queryFn: async () => {
      const q = new URLSearchParams({ page: String(filters.page), page_size: String(VENDOR_PAGE_SIZE), status: filters.status })
      if (filters.type) q.set('vendor_type', filters.type)
      if (filters.search.trim()) q.set('search', filters.search.trim())
      const { data, meta } = await api.requestEnvelope<Vendor[]>(`/vendors?${q}`)
      return { vendors: data, meta: meta as unknown as PageMeta }
    },
    placeholderData: (previous) => previous,
  })
}

/** Active vendors the caller's depots may use: the work order's picker. */
export function useActiveVendors(enabled: boolean) {
  const { api } = useAuth()
  return useQuery({
    queryKey: ['vendors', 'active'],
    queryFn: () => api.request<Vendor[]>('/vendors?status=active&page_size=100'),
    enabled,
    staleTime: 60_000,
  })
}

/** How many vendors each view holds, for the view tabs. */
export function useVendorCounts() {
  const { api } = useAuth()
  const total = async (status: string) => ((await api.requestEnvelope<unknown[]>(`/vendors?status=${status}&page_size=1`)).meta as unknown as PageMeta).total_items
  return useQuery({
    queryKey: ['vendors', 'counts'],
    queryFn: async () => ({ active: await total('active'), retired: await total('retired') }),
  })
}

function useInvalidate() {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: ['vendors'] })
}

export function useSaveVendor() {
  const { api } = useAuth()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ vendor, input }: { vendor: Vendor | null; input: VendorInput }) =>
      vendor
        ? api.request<Vendor>(`/vendors/${vendor.id}`, { method: 'PATCH', json: input, headers: { 'If-Match': `"${vendor.version}"` } })
        : api.request<Vendor>('/vendors', { method: 'POST', json: input }),
    onSuccess: invalidate,
  })
}

/** Retires a vendor (orders that named it keep it) or brings it back. */
export function useSetVendorActive() {
  const { api } = useAuth()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({ vendor, active }: { vendor: Vendor; active: boolean }) =>
      api.request<Vendor>(`/vendors/${vendor.id}`, { method: 'PATCH', json: { is_active: active }, headers: { 'If-Match': `"${vendor.version}"` } }),
    onSuccess: invalidate,
  })
}

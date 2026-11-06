import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'

// S-34 Telematics (FMS-138, api-contract §15.1): the providers that report positions, the device registry, and the
// device ids providers send that are linked to no vehicle. integration:read reads; integration:execute links and unlinks.

export type ProviderStatus = 'operational' | 'degraded' | 'down' | 'unknown' | 'inactive'

export interface Provider {
  id: string
  code: string
  name: string
  provider_type: string
  is_active: boolean
  status: ProviderStatus
  webhook_secret_configured: boolean
  last_error: string | null
  last_delivery_at: string | null
  today: { deliveries: number; deliveries_rejected: number; positions_accepted: number; positions_rejected: number }
  devices: { linked: number; unknown: number } | null
  circuit: { state: 'closed' | 'open' | 'half_open' } | null
}

export interface GpsDevice {
  id: string
  device_identifier: string
  device_model: string | null
  provider: { id: string; code: string; name: string } | null
  credential: 'provider' | 'token'
  vehicle: { id: string; registration_number: string }
  status: 'active' | 'inactive' | 'faulty' | 'removed'
  installed_at: string | null
  removed_at: string | null
  last_seen_at: string | null
  last_error: { reason: string; at: string } | null
}

export interface UnknownDevice {
  provider: { id: string; code: string; name: string }
  device_identifier: string
  first_seen_at: string
  last_seen_at: string
  positions: number
}

export interface LinkInput {
  provider_id: string
  device_identifier: string
  vehicle_id: string
  device_model: string | null
  replace: boolean
}

export const telematicsKeys = {
  all: ['telematics'] as const,
  providers: ['telematics', 'providers'] as const,
  devices: ['telematics', 'devices'] as const,
  unknown: ['telematics', 'unknown'] as const,
}

/** The telematics providers, refreshed every 30 s: today's counts move while the screen is open. */
export function useTelematicsProviders() {
  const { api } = useAuth()
  return useQuery({
    queryKey: telematicsKeys.providers,
    queryFn: async () => (await api.request<Provider[]>('/integrations/providers')).filter((p) => p.provider_type === 'telematics'),
    refetchInterval: 30_000,
  })
}

/** Every device, active and removed; the screen splits them. */
export function useDevices() {
  const { api } = useAuth()
  return useQuery({ queryKey: telematicsKeys.devices, queryFn: () => api.request<GpsDevice[]>('/integrations/devices'), refetchInterval: 30_000 })
}

export function useUnknownDevices() {
  const { api } = useAuth()
  return useQuery({ queryKey: telematicsKeys.unknown, queryFn: () => api.request<UnknownDevice[]>('/integrations/devices/unknown'), refetchInterval: 30_000 })
}

function useInvalidate() {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: telematicsKeys.all })
}

export function useLinkDevice() {
  const { api } = useAuth()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (input: LinkInput) => api.request<GpsDevice>('/integrations/devices', { method: 'POST', json: input }),
    onSuccess: invalidate,
  })
}

export function useUnlinkDevice() {
  const { api } = useAuth()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (id: string) => api.request<void>(`/integrations/devices/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  })
}

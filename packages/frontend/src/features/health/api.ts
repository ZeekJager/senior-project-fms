import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import type { MaintenanceRisk } from './health'

export const healthKeys = {
  risk: (vehicleId: string) => ['maintenance-risk', vehicleId] as const,
  activeModel: ['ml-models', 'active'] as const,
}

/** GET /vehicles/{id}/maintenance-risk (prediction:read): the latest score and what drives it. Null id: idle. */
export function useMaintenanceRisk(vehicleId: string | null) {
  const { api } = useAuth()
  return useQuery({
    queryKey: healthKeys.risk(vehicleId ?? ''),
    queryFn: () => api.request<MaintenanceRisk>(`/vehicles/${vehicleId}/maintenance-risk`),
    enabled: vehicleId !== null,
  })
}

/** The model scoring now (GET /ml-models?status=active, prediction:read), for the screen's header; null when none is active. */
export function useActiveModel(enabled: boolean) {
  const { api } = useAuth()
  return useQuery({
    queryKey: healthKeys.activeModel,
    queryFn: async () => (await api.request<{ version: string; activated_at: string | null }[]>('/ml-models?status=active&page_size=1'))[0] ?? null,
    enabled,
    staleTime: 5 * 60_000,
  })
}

import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'

/** A depot as GET /depots returns it (api-contract §6.1). */
export interface Depot {
  id: string
  name: string
  code: string | null
  location: string
}

/**
 * Depots in the caller's scope (`in_scope=true`), for filters and forms: a
 * depot admin picks only their own. One page of 100 covers any real fleet.
 */
export function useDepots() {
  const { api } = useAuth()
  return useQuery({
    queryKey: ['depots'],
    queryFn: () => api.request<Depot[]>('/depots?in_scope=true&page_size=100'),
    staleTime: 5 * 60_000,
  })
}

import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'

/** A depot as GET /depots returns it (api-contract §6.1). */
export interface Depot {
  id: string
  name: string
  code: string | null
  location: string
}

/** Depots in the caller's scope, for filters and forms. One page of 100 covers any real fleet. */
export function useDepots() {
  const { api } = useAuth()
  return useQuery({
    queryKey: ['depots'],
    queryFn: () => api.request<Depot[]>('/depots?page_size=100'),
    staleTime: 5 * 60_000,
  })
}

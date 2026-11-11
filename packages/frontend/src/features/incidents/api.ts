import { keepPreviousData, useQueries, useQuery } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import type { PageMeta } from '@/lib/api/client'
import type { Incident } from '@/pages/FleetCommandCenter/api'
import type { Vehicle } from '@/pages/Vehicles/types'

// One vehicle's or one driver's incidents (FMS-148, BR-9): the same incident on both records, read from
// GET /incidents by vehicle_id or driver_id, never copied. The API keeps them to the caller's depots.

export const INCIDENT_PAGE_SIZE = 25

/** Whose record: a vehicle's (S-22) or a driver's (S-05). */
export type IncidentSubject = { vehicleId: string } | { driverId: string }

export const incidentHistoryKeys = {
  all: ['incidents', 'history'] as const,
  of: (subject: IncidentSubject, page: number) => ['incidents', 'history', subject, page] as const,
}

/** GET /incidents?vehicle_id= or ?driver_id= (incident:read): newest first, 25 to a page. */
export function useIncidentHistory(subject: IncidentSubject, page: number, enabled = true) {
  const { api } = useAuth()
  return useQuery({
    enabled,
    queryKey: incidentHistoryKeys.of(subject, page),
    queryFn: async () => {
      const q = new URLSearchParams({ page: String(page), page_size: String(INCIDENT_PAGE_SIZE) })
      if ('vehicleId' in subject) q.set('vehicle_id', subject.vehicleId)
      else q.set('driver_id', subject.driverId)
      const { data, meta } = await api.requestEnvelope<Incident[]>(`/incidents?${q}`)
      return { incidents: data, meta: meta as unknown as PageMeta }
    },
    placeholderData: keepPreviousData,
  })
}

/**
 * The plates of the vehicles in a driver's incidents, by vehicle id (GET /vehicles/{id}, cached as the vehicle page
 * caches it). A vehicle outside the caller's depots, or gone, has no plate: the row says so.
 */
export function usePlates(vehicleIds: readonly string[], enabled: boolean): Map<string, string> {
  const { api } = useAuth()
  const ids = [...new Set(vehicleIds)]
  const results = useQueries({
    queries: ids.map((id) => ({
      queryKey: ['vehicles', 'detail', id] as const,
      queryFn: () => api.request<Vehicle>(`/vehicles/${id}`),
      enabled,
      retry: false,
      staleTime: 5 * 60_000,
    })),
  })
  return new Map(results.flatMap((r, i) => (r.data ? [[ids[i], r.data.registration_number] as const] : [])))
}

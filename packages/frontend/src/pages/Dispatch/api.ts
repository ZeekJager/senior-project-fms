import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import type { AssignmentWarning, DispatchBoard, Trip } from './types'

// Server state for the dispatcher console (S-07). Socket events mark it stale
// (RealtimeProvider, FMS-43: trip.updated, vehicle.status.changed); polling
// keeps it current when the socket is down.

/** How often the trips and the board refresh while the console is open. */
export const POLL_MS = 30_000

const keys = {
  trips: (depotId: string, from: string) => ['dispatch', 'trips', depotId, from] as const,
  board: (depotId: string, tripId: string | null) => ['dispatch', 'board', depotId, tripId] as const,
  trip: (id: string) => ['dispatch', 'trip', id] as const,
}

/** Today in Addis Ababa, YYYY-MM-DD: the console shows trips from today on. */
export function operatingToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Addis_Ababa' }).format(now)
}

/** Scheduled and assigned trips of the depot from today, earliest first. */
export function useDispatchTrips(depotId: string) {
  const { api } = useAuth()
  const from = operatingToday()
  return useQuery({
    queryKey: keys.trips(depotId, from),
    queryFn: () => {
      const q = new URLSearchParams({ status: 'scheduled,assigned', depot_id: depotId, from, sort_order: 'asc', page_size: '100' })
      return api.request<Trip[]>(`/trips?${q}`)
    },
    enabled: depotId !== '',
    refetchInterval: POLL_MS,
  })
}

/**
 * The depot's drivers and vehicles: their state now and, with a trip chosen,
 * their availability for its window (its own assignment is not a conflict).
 */
export function useDispatchBoard(depotId: string, trip: Trip | null) {
  const { api } = useAuth()
  return useQuery({
    queryKey: keys.board(depotId, trip?.id ?? null),
    queryFn: () => {
      const q = new URLSearchParams({ depot_id: depotId })
      if (trip?.scheduled_start && trip.scheduled_end) {
        q.set('from', trip.scheduled_start)
        q.set('to', trip.scheduled_end)
        q.set('exclude_trip_id', trip.id)
      }
      return api.request<DispatchBoard>(`/dispatch/availability?${q}`)
    },
    enabled: depotId !== '',
    refetchInterval: POLL_MS,
    placeholderData: (previous) => previous,
  })
}

/** One trip, to describe the trip a conflict names. */
export function useTrip(id: string | null) {
  const { api } = useAuth()
  return useQuery({
    queryKey: keys.trip(id ?? ''),
    queryFn: () => api.request<Trip>(`/trips/${id}`),
    enabled: id !== null,
    retry: false,
  })
}

/** POST /trips/{id}/assign with the version on screen; a retry replays rather than repeats. */
export function useAssignTrip() {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ trip, driverId, vehicleId }: { trip: Trip; driverId: string; vehicleId: string }) => {
      const { data, meta } = await api.requestEnvelope<Trip>(`/trips/${trip.id}/assign`, {
        method: 'POST',
        json: { driver_id: driverId, vehicle_id: vehicleId, version: trip.version },
        idempotencyKey: true,
      })
      return { trip: data, warnings: (meta.warnings as AssignmentWarning[] | undefined) ?? [] }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['dispatch'] }),
  })
}

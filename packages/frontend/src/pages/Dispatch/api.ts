import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import type { Coordinates, Route } from '@/pages/Routes/api'
import type { AssignmentWarning, DispatchBoard, ShiftedTrip, Trip } from './types'

// Server state for the dispatcher console (S-07). Socket events mark it stale
// (RealtimeProvider, FMS-43: trip.updated, vehicle.status.changed); polling
// keeps it current when the socket is down.

/** How often the trips and the board refresh while the console is open. */
export const POLL_MS = 30_000

const keys = {
  trips: (depotId: string, from: string) => ['dispatch', 'trips', depotId, from] as const,
  underWay: (depotId: string) => ['dispatch', 'under-way', depotId] as const,
  routes: (depotId: string) => ['dispatch', 'routes', depotId] as const,
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

/** The depot's trips under way, whenever they started: their end can still move (FMS-139). */
export function useUnderWayTrips(depotId: string) {
  const { api } = useAuth()
  return useQuery({
    queryKey: keys.underWay(depotId),
    queryFn: () => {
      const q = new URLSearchParams({ status: 'en_route', depot_id: depotId, sort_order: 'asc', page_size: '100' })
      return api.request<Trip[]>(`/trips?${q}`)
    },
    enabled: depotId !== '',
    refetchInterval: POLL_MS,
  })
}

/** The depot's active routes, for a new trip; read only when the drawer is open. */
export function useDepotRoutes(depotId: string, enabled: boolean) {
  const { api } = useAuth()
  return useQuery({
    queryKey: keys.routes(depotId),
    queryFn: () => {
      const q = new URLSearchParams({ depot_id: depotId, status: 'active', sort_by: 'name', sort_order: 'asc', page_size: '100' })
      return api.request<Route[]>(`/routes?${q}`)
    },
    enabled: enabled && depotId !== '',
  })
}

/** Where a one-off trip goes (FMS-139): saved as a route of its own that the routes list does not show. */
export interface AdhocRoute {
  origin_name: string
  origin: Coordinates | null
  destination_name: string
  destination: Coordinates | null
}

export type NewTrip = { scheduled_start: string; scheduled_end?: string } & ({ route_id: string } | { route: AdhocRoute; depot_id: string })

/** POST /trips; a retry replays rather than creating a second trip. */
export function useCreateTrip() {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: NewTrip) => api.request<Trip>('/trips', { method: 'POST', json: input, idempotencyKey: true }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['dispatch'] }),
  })
}

export interface TimesChange {
  scheduled_start?: string
  scheduled_end?: string
  reason?: string
  /** Move the trips the change runs into later, instead of refusing (FMS-139). */
  shift_following?: boolean
}

/** PATCH /trips/{id} with the version on screen; answers with the trips it moved later. */
export function useUpdateTripTimes() {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ trip, change }: { trip: Trip; change: TimesChange }) => {
      const { data, meta } = await api.requestEnvelope<Trip>(`/trips/${trip.id}`, { method: 'PATCH', json: change, headers: { 'If-Match': `"${trip.version}"` } })
      return { trip: data, shifted: (meta.shifted as ShiftedTrip[] | undefined) ?? [] }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['dispatch'] }),
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

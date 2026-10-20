import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'

// The driver's day (FMS-35, S-11): today's trips, and start and end with one tap.

export interface DriverTrip {
  id: string
  route_name: string | null
  origin: string | null
  destination: string | null
  vehicle_id: string | null
  status: 'assigned' | 'en_route'
  scheduled_start: string | null
  scheduled_end: string | null
  actual_start: string | null
  planned_distance_km: number | null
  stops: { id: string; sequence_number: number; name: string; status: string }[]
  version: number
}

export type TripWarning =
  | { warning: 'PREVIOUS_TRIP_OVERRUN'; field: 'driver_id' | 'vehicle_id'; trip_id: string; expected_end: string }
  | { warning: 'DRIVER_ATTENDANCE'; field: 'driver_id'; attendance: 'absent' | 'on_leave' | 'sick' }

/** Refreshes while the screen is open: dispatch may assign or move a trip. */
export const REFRESH_MS = 60_000

/** Today in Addis Ababa, YYYY-MM-DD. */
export function operatingToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Addis_Ababa' }).format(now)
}

const STORE_KEY = 'fms-driver-today'

/**
 * The last answer, kept on the phone so the driver still sees where to be
 * with no signal (FMS-34). Today's trips of this driver only: another day's
 * or another account's copy is ignored.
 */
interface Kept {
  userId: string
  day: string
  savedAt: number
  trips: DriverTrip[]
}

function readKept(userId: string, day: string): Kept | null {
  try {
    const kept = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null') as Kept | null
    return kept && kept.userId === userId && kept.day === day ? kept : null
  } catch {
    return null
  }
}

function keep(kept: Kept) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(kept))
  } catch {
    // Private mode or full: the screen still works online.
  }
}

/**
 * The trip under way (whenever it started) and the trips assigned for today,
 * earliest first. A driver sees only their own trips (the API's scope).
 */
export function useTodayTrips() {
  const { api, session } = useAuth()
  const userId = session?.user.id ?? ''
  const day = operatingToday()
  const kept = readKept(userId, day)
  return useQuery({
    queryKey: ['driver', 'today', userId, day],
    queryFn: async () => {
      const underWay = await api.request<DriverTrip[]>(`/trips?${new URLSearchParams({ status: 'en_route', sort_order: 'asc', page_size: '10' })}`)
      const assigned = await api.request<DriverTrip[]>(`/trips?${new URLSearchParams({ status: 'assigned', from: day, to: day, sort_order: 'asc', page_size: '20' })}`)
      const trips = [...underWay, ...assigned]
      keep({ userId, day, savedAt: Date.now(), trips })
      return trips
    },
    enabled: userId !== '',
    initialData: kept?.trips,
    initialDataUpdatedAt: kept?.savedAt,
    // A kept copy is shown at once, and replaced as soon as the server answers.
    staleTime: 0,
    refetchInterval: REFRESH_MS,
  })
}

/** The vehicle's plate and model, for "which vehicle do I take". */
export function useTripVehicle(id: string | null) {
  const { api } = useAuth()
  return useQuery({
    queryKey: ['driver', 'vehicle', id],
    queryFn: () => api.request<{ registration_number: string; make: string; model: string }>(`/vehicles/${id}`),
    enabled: id !== null,
    staleTime: 10 * 60_000,
    retry: false,
  })
}

/** POST /trips/{id}/start or /end, with the version on screen; a retry replays rather than repeats. */
export function useTripCommand(command: 'start' | 'end') {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (trip: DriverTrip) => {
      const { data, meta } = await api.requestEnvelope<DriverTrip>(`/trips/${trip.id}/${command}`, {
        method: 'POST',
        json: {},
        headers: { 'If-Match': `"${trip.version}"` },
        idempotencyKey: true,
      })
      return { trip: data, warnings: (meta.warnings as TripWarning[] | undefined) ?? [] }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['driver', 'today'] }),
  })
}

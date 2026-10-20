import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import { useTodayTrips, type DriverTrip } from './api'

// The vehicle inspection (FMS-37, S-12): what is checked, which vehicle, and
// the post-trip reminder that My day hands over to it.

export type InspectionType = 'pre_trip' | 'post_trip'

export const INSPECTION_NAMES: Record<InspectionType, string> = { pre_trip: 'Pre-trip inspection', post_trip: 'Post-trip inspection' }

/**
 * The checklists. Fixed in the app, so they work with no signal (the board's
 * pre-trip list; post-trip looks for what the road did to the vehicle). The
 * names are what the technician reads in the report's defects.
 */
export const CHECKLISTS: Record<InspectionType, readonly string[]> = {
  pre_trip: ['Tyres', 'Brakes', 'Lights and indicators', 'Windscreen and mirrors', 'Horn', 'Fuel level', 'Engine oil', 'Coolant', 'Fire extinguisher', 'First aid kit'],
  post_trip: ['Tyres', 'Brakes', 'Lights and indicators', 'Body damage', 'Leaks under the vehicle', 'Dashboard warning lights', 'Fuel level', 'Cabin left clean'],
}

export type Answer = { passed: true } | { passed: false; notes: string }

/** POST /dvir-reports (api-contract §6.4). `submitted_at` is when the driver pressed submit, however late the queue sends it. */
export function inspectionBody(input: { vehicleId: string; tripId: string; type: InspectionType; answers: Record<string, Answer> }, now = new Date()) {
  return {
    vehicle_id: input.vehicleId,
    trip_id: input.tripId,
    type: input.type,
    items: CHECKLISTS[input.type].map((name) => {
      const answer = input.answers[name]
      return { name, passed: answer.passed, notes: answer.passed ? null : answer.notes.trim() || null }
    }),
    submitted_at: now.toISOString(),
  }
}

const POST_TRIP_KEY = 'fms-driver-post-trip'

/** A trip just ended whose post-trip inspection is still to do: kept on the phone with its vehicle, so the form opens with no signal. */
export interface PostTrip {
  userId: string
  tripId: string
  vehicleId: string | null
  routeName: string | null
}

export function readPostTrip(userId: string): PostTrip | null {
  try {
    const kept = JSON.parse(localStorage.getItem(POST_TRIP_KEY) ?? 'null') as PostTrip | null
    return kept && typeof kept === 'object' && kept.userId === userId ? kept : null
  } catch {
    return null
  }
}

export function writePostTrip(postTrip: PostTrip | null): void {
  try {
    if (postTrip) localStorage.setItem(POST_TRIP_KEY, JSON.stringify(postTrip))
    else localStorage.removeItem(POST_TRIP_KEY)
  } catch {
    // Private mode: it lasts for this visit.
  }
}

/** The trip being inspected, as much as the form needs. */
export interface InspectedTrip {
  id: string
  routeName: string | null
  vehicleId: string | null
  status: string
}

const fromDriverTrip = (t: DriverTrip): InspectedTrip => ({ id: t.id, routeName: t.route_name, vehicleId: t.vehicle_id, status: t.status })

/**
 * Which trip, and so which vehicle: a driver inspects only the vehicle of
 * their own trip. `?trip=` names it (the post-trip prompt); without it, the
 * trip under way or the next one today. Looked up on the phone first (today's
 * saved trips, the post-trip reminder), then from the server.
 */
export function useInspectedTrip(tripId: string | null) {
  const { api, session } = useAuth()
  const today = useTodayTrips()
  const trips = today.data ?? []
  const local = tripId
    ? (() => {
        const listed = trips.find((t) => t.id === tripId)
        if (listed) return fromDriverTrip(listed)
        const ended = readPostTrip(session?.user.id ?? '')
        return ended?.tripId === tripId && ended.vehicleId ? { id: tripId, routeName: ended.routeName, vehicleId: ended.vehicleId, status: 'completed' } : null
      })()
    : null
  const fetched = useQuery({
    queryKey: ['driver', 'trip', tripId],
    queryFn: async () => fromDriverTrip(await api.request<DriverTrip>(`/trips/${tripId}`)),
    // Asked only once today's trips are known not to have it.
    enabled: tripId !== null && local === null && !today.isPending,
    retry: false,
  })

  if (tripId) {
    if (local) return { trip: local, loading: false, offline: false }
    if (today.isPending) return { trip: null, loading: today.fetchStatus !== 'paused', offline: today.fetchStatus === 'paused' }
    return { trip: fetched.data ?? null, loading: fetched.isPending && fetched.fetchStatus !== 'paused' && !fetched.isError, offline: fetched.fetchStatus === 'paused' }
  }
  const current = trips.find((t) => t.status === 'en_route') ?? trips[0]
  return {
    trip: current ? fromDriverTrip(current) : null,
    loading: today.isPending && today.fetchStatus !== 'paused',
    offline: today.isPending && today.fetchStatus === 'paused',
  }
}

// Live arrival times (FMS-86, docs/eta.md) as the screens show them: a trip's estimate from its newest
// position, worked out by the API at most every 30 seconds and sent over the socket as trip.updated.

/** A trip's latest estimate. The live map's snapshot leaves out the stop id, the seconds and the position time. */
export interface TripEta {
  /** At the destination; null when the route has no destination coordinates. */
  arrival_at: string | null
  remaining_km: number | null
  remaining_seconds?: number | null
  next_stop: { stop_id?: string; name: string; eta: string } | null
  /** When the vehicle was where the estimate is from. */
  position_at?: string
  updated_at: string
}

/** trip.updated for a new estimate: the screens patch the trip in place rather than re-reading. */
export interface TripEtaEvent {
  trip_id: string
  depot_id: string | null
  eta: TripEta | null
}

/** The `change` of a trip.updated that only brings a new estimate. */
export const ETA_CHANGE = 'TripEtaUpdated'

/** An estimate from a position older than this says so: the vehicle may have lost signal. */
export const ETA_STALE_MS = 2 * 60_000

/** The estimate a trip.updated payload carries, or null when it is another change. */
export function etaEventOf(payload: unknown): TripEtaEvent | null {
  const p = payload as { change?: unknown; trip_id?: unknown; depot_id?: unknown; eta?: unknown } | null
  if (!p || p.change !== ETA_CHANGE || typeof p.trip_id !== 'string') return null
  return { trip_id: p.trip_id, depot_id: typeof p.depot_id === 'string' ? p.depot_id : null, eta: (p.eta as TripEta | null | undefined) ?? null }
}

const clock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Addis_Ababa', hour: '2-digit', minute: '2-digit' })

/** "14:32", in Addis Ababa. */
export const etaClock = (iso: string) => clock.format(new Date(iso))

/** "350 m", "12.4 km", "128 km". */
export function formatKm(km: number): string {
  if (km < 1) return `${Math.round(km * 100) * 10} m`
  return km < 100 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`
}

/** "in 38 min", "in 1 h 5 min", "due now" (within the minute or past). */
export function timeUntil(iso: string, now: number): string {
  const minutes = Math.round((Date.parse(iso) - now) / 60_000)
  if (minutes <= 0) return 'due now'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `in ${h === 0 ? `${m} min` : m === 0 ? `${h} h` : `${h} h ${m} min`}`
}

/** Whether the estimate is from a position more than ETA_STALE_MS old. */
export function isEtaStale(eta: TripEta, now: number): boolean {
  return now - Date.parse(eta.position_at ?? eta.updated_at) > ETA_STALE_MS
}

/** "Arrives 14:32 · 12.4 km to go"; without a destination time, the next stop's: "Stop A 14:05". Null without either. */
export function etaSummary(eta: TripEta | null | undefined): string | null {
  if (!eta) return null
  const left = eta.remaining_km !== null && eta.remaining_km > 0 ? ` · ${formatKm(eta.remaining_km)} to go` : ''
  if (eta.arrival_at) return eta.remaining_km === 0 ? `Arrived ${etaClock(eta.arrival_at)}` : `Arrives ${etaClock(eta.arrival_at)}${left}`
  return eta.next_stop ? `${eta.next_stop.name} ${etaClock(eta.next_stop.eta)}` : null
}

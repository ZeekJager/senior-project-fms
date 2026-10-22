import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '@/context/AuthContext'
import { useRealtimeEvent, useRealtimeStatus } from '@/lib/realtime/context'
import { applyPositions, mergeSnapshot, type Fleet } from './liveFleet'
import type { LocationUpdate, VehicleLocation } from './types'

// The command center's live fleet (FMS-45): one snapshot over the API, then the socket's
// vehicle.location.updated moves the vehicles. The snapshot is re-read every 30 seconds (polling stays
// the fallback when the socket is down), when a trip or vehicle changes (RealtimeProvider marks
// ['tracking'] stale), after a reconnect, and when a position names a vehicle or trip it does not have.

/** How often the snapshot is re-read while the map is open. */
export const POLL_MS = 30_000
/** Positions are applied in batches this often: well inside the 500 ms budget, one render per batch. */
export const FLUSH_MS = 150
/** A position about an unknown vehicle asks for a fresh snapshot at most this often. */
const REFRESH_GAP_MS = 5_000

export const trackingKeys = { current: (depotId: string) => ['tracking', 'current', depotId] as const }

/** GET /tracking/vehicles/current, for one depot or (empty) every depot in scope. */
export function useLiveSnapshot(depotId: string) {
  const { api } = useAuth()
  return useQuery({
    queryKey: trackingKeys.current(depotId),
    queryFn: () => api.request<VehicleLocation[]>(`/tracking/vehicles/current${depotId ? `?depot_id=${encodeURIComponent(depotId)}` : ''}`),
    refetchInterval: POLL_MS,
  })
}

/** The live fleet: the snapshot merged with the socket's positions, re-rendered once per batch of them. */
export function useLiveFleet(depotId: string) {
  const snapshot = useLiveSnapshot(depotId)
  const queryClient = useQueryClient()
  const status = useRealtimeStatus()
  // State to render; the ref mirrors it for the batches, which run outside a render.
  const [fleet, setFleet] = useState<Fleet>(() => new Map())
  const latest = useRef<Fleet>(fleet)
  const commit = useCallback((next: Fleet) => {
    latest.current = next
    setFleet(next)
  }, [])

  // A new depot starts empty; a snapshot replaces the list, keeping newer positions the socket brought.
  useEffect(() => commit(new Map()), [depotId, commit])
  useEffect(() => {
    if (snapshot.data) commit(mergeSnapshot(latest.current, snapshot.data))
  }, [snapshot.data, commit])

  const lastRefresh = useRef(0)
  const refresh = useCallback(() => {
    if (Date.now() - lastRefresh.current < REFRESH_GAP_MS) return
    lastRefresh.current = Date.now()
    void queryClient.invalidateQueries({ queryKey: ['tracking', 'current'] })
  }, [queryClient])

  const pending = useRef(new Map<string, LocationUpdate>())
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )
  useRealtimeEvent('vehicle.location.updated', (payload) => {
    const update = payload as LocationUpdate
    // A fleet-wide user receives every depot's positions; a depot chosen shows only its own.
    if (!update?.vehicle_id || (depotId && update.depot_id !== depotId)) return
    const queued = pending.current.get(update.vehicle_id)
    if (!queued || Date.parse(update.recorded_at) > Date.parse(queued.recorded_at)) pending.current.set(update.vehicle_id, update)
    timer.current ??= setTimeout(() => {
      timer.current = null
      const updates = [...pending.current.values()]
      pending.current.clear()
      const result = applyPositions(latest.current, updates)
      if (result.changed) commit(result.fleet)
      if (result.stale.length > 0) refresh()
    }, FLUSH_MS)
  })

  // Events missed while the socket was down: re-read once it is back.
  const wasDown = useRef(false)
  const { refetch } = snapshot
  useEffect(() => {
    if (status === 'down') wasDown.current = true
    if (status === 'live' && wasDown.current) {
      wasDown.current = false
      void refetch()
    }
  }, [status, refetch])

  const vehicles = useMemo(() => [...fleet.values()], [fleet])
  return { vehicles, snapshot, live: status === 'live' }
}

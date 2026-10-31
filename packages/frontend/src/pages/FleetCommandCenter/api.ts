import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '@/context/AuthContext'
import { useRealtimeEvent, useRealtimeStatus } from '@/lib/realtime/context'
import { applyPositions, mergeSnapshot, type Fleet } from './liveFleet'
import {
  addAlert,
  addIncident,
  patchAlert,
  patchIncident,
  type AlertCreatedEvent,
  type AlertUpdatedEvent,
  type IncidentStatus,
  type IncidentUpdatedEvent,
  type Overview,
  type OverviewAlert,
  type OverviewIncident,
} from './overview'
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

// The overview beside the map (FMS-89): counters, alerts and incidents. Read every 30 seconds like the snapshot;
// the socket's alert and incident events change it at once, and it is re-read once the server's 5-second cache has
// passed, so the next read cannot bring back what the event changed.

/** After an alert or incident event, the overview is re-read this much later (past the server's cache). */
export const REREAD_AFTER_EVENT_MS = 6_000

export const overviewKeys = {
  all: ['command-center', 'overview'] as const,
  depot: (depotId: string) => ['command-center', 'overview', depotId] as const,
}

/** GET /command-center/overview for one depot or (empty) every depot in scope. */
export function useOverview(depotId: string) {
  const { api } = useAuth()
  return useQuery({
    queryKey: overviewKeys.depot(depotId),
    queryFn: () => api.request<Overview>(`/command-center/overview${depotId ? `?depot_id=${encodeURIComponent(depotId)}` : ''}`),
    refetchInterval: POLL_MS,
  })
}

/** An incident as GET /incidents/{id} and PATCH return it (api-contract §12.2). */
export interface Incident extends Omit<OverviewIncident, 'registration_number' | 'driver_name'> {
  depot_id: string | null
  trip_id: string | null
  reported_by: string
  resolved_at: string | null
  resolved_by: string | null
  created_at: string
}

/** Names the overview knows that an incident read on its own lacks: plates and drivers on the map. */
export interface Names {
  plate(vehicleId: string): string | null
  driver(driverId: string): string | null
}

export const toOverviewIncident = (i: Incident, names: Names): OverviewIncident => ({
  id: i.id,
  incident_type: i.incident_type,
  severity: i.severity,
  status: i.status,
  description: i.description,
  vehicle_id: i.vehicle_id,
  registration_number: i.vehicle_id ? names.plate(i.vehicle_id) : null,
  driver_id: i.driver_id,
  driver_name: i.driver_id ? names.driver(i.driver_id) : null,
  assigned_to: i.assigned_to,
  notes: i.notes,
  latitude: i.latitude,
  longitude: i.longitude,
  occurred_at: i.occurred_at,
  updated_at: i.updated_at,
})

/** The socket's alert and incident events, applied to the overview shown. */
export function useLiveOverview(depotId: string, names: Names) {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  const update = (change: (o: Overview) => Overview) => queryClient.setQueryData<Overview>(overviewKeys.depot(depotId), (o) => (o ? change(o) : o))
  // A depot chosen shows only its own; a fleet-wide user receives every depot's events.
  const mine = (eventDepot: string | null | undefined) => !depotId || eventDepot === undefined || eventDepot === depotId

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )
  const reread = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      void queryClient.invalidateQueries({ queryKey: overviewKeys.all })
    }, REREAD_AFTER_EVENT_MS)
  }

  useRealtimeEvent('alert.created', (payload) => {
    const e = payload as AlertCreatedEvent
    if (!e?.alert_id || !mine(e.depot_id)) return
    update((o) => addAlert(o, e, names.plate))
    reread()
  })
  useRealtimeEvent('alert.updated', (payload) => {
    const e = payload as AlertUpdatedEvent
    if (!e?.alert_id) return
    update((o) => patchAlert(o, e))
    reread()
  })
  useRealtimeEvent('incident.created', (payload) => {
    const e = payload as { incident_id?: string; depot_id?: string | null }
    if (!e?.incident_id || !mine(e.depot_id)) return
    reread()
    // The event carries no description (free text): read the incident itself.
    api
      .request<Incident>(`/incidents/${e.incident_id}`)
      .then((incident) => update((o) => addIncident(o, toOverviewIncident(incident, names))))
      .catch(() => {})
  })
  useRealtimeEvent('incident.updated', (payload) => {
    const e = payload as IncidentUpdatedEvent
    if (!e?.incident_id) return
    update((o) =>
      patchIncident(o, e.incident_id, { status: e.status, ...(e.assigned_to === null ? { assigned_to: null } : {}), ...(e.updated_at ? { updated_at: e.updated_at } : {}) }),
    )
    reread()
  })
}

/** POST /alerts/{id}/acknowledge or /resolve (alert:ack, alert:resolve). */
export function useAlertAction(depotId: string) {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'acknowledge' | 'resolve' }) =>
      api.request<{ id: string; status: OverviewAlert['status']; acknowledged_at: string | null }>(`/alerts/${id}/${action}`, { method: 'POST', json: {} }),
    onSuccess: (alert) =>
      queryClient.setQueryData<Overview>(overviewKeys.depot(depotId), (o) =>
        o ? patchAlert(o, { alert_id: alert.id, status: alert.status, acknowledged_at: alert.acknowledged_at }) : o,
      ),
  })
}

/** PATCH /incidents/{id} (incident:manage): status, assignee, notes. */
export function useUpdateIncident(depotId: string) {
  const { api } = useAuth()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, change }: { id: string; change: { status?: IncidentStatus; assigned_to?: string | null; notes?: string | null } }) =>
      api.request<Incident>(`/incidents/${id}`, { method: 'PATCH', json: change }),
    onSuccess: (incident) =>
      queryClient.setQueryData<Overview>(overviewKeys.depot(depotId), (o) =>
        o ? patchIncident(o, incident.id, { status: incident.status, assigned_to: incident.assigned_to, notes: incident.notes, updated_at: incident.updated_at }) : o,
      ),
  })
}

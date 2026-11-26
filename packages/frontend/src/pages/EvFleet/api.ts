import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import type { RecordSource } from '@/components/shared/SyntheticBadge'
import { useAuth } from '@/context/AuthContext'
import { useRealtimeEvent, useRealtimeStatus } from '@/lib/realtime/context'

// Server state for the EV dashboard (S-40, FMS-99). The socket's EV events (ev.battery.logged,
// ev.charging-session.updated) mark it stale (useLiveEv); polling keeps it current while the socket is down.

/** How often the dashboard refreshes while the socket is down; with it live, the events do. */
export const POLL_MS = 30_000

export type SessionStatus = 'planned' | 'in_progress' | 'completed' | 'failed' | 'cancelled'

/** GET /ev/fleet: an electric vehicle with its newest battery reading and the session charging it now. */
export interface EvFleetVehicle {
  vehicle_id: string
  registration_number: string
  make: string
  model: string
  depot: { id: string; name: string } | null
  latest: { state_of_charge: number; battery_health: number | null; estimated_range_km: number | null; recorded_at: string; source: RecordSource } | null
  charging: { id: string; station: { id: string; name: string } | null; started_at: string | null; start_soc: number | null; source: RecordSource } | null
}

/** A charging session (GET /ev/charging-sessions). Money in whole cents. */
export interface ChargingSession {
  id: string
  vehicle_id: string
  registration_number: string
  station: { id: string; name: string } | null
  status: SessionStatus
  started_at: string | null
  ended_at: string | null
  energy_kwh: number | null
  cost_cents: number | null
  start_soc: number | null
  end_soc: number | null
  source: RecordSource
}

/** A charging station (GET /ev/charging-stations), shared by every depot. */
export interface ChargingStation {
  id: string
  name: string
  latitude: number | null
  longitude: number | null
  connector_type: string | null
  power_kw: number | null
  status: string
  source: RecordSource
}

export const evKeys = {
  all: ['ev'] as const,
  fleet: (depotId: string) => ['ev', 'fleet', depotId] as const,
  sessions: (status: string, page: number, pageSize: number) => ['ev', 'sessions', status, page, pageSize] as const,
  stations: ['ev', 'stations'] as const,
}

/** Poll only while the socket is not live: live, the EV events refresh the queries. */
function usePollInterval(): number | false {
  return useRealtimeStatus() === 'live' ? false : POLL_MS
}

/**
 * While the dashboard is open, a session started, finished or failed re-reads the EVs and the sessions, and a battery
 * reading the EVs: each event names only a vehicle, and the API decides what the viewer sees (docs/realtime.md).
 */
export function useLiveEv() {
  const queryClient = useQueryClient()
  useRealtimeEvent('ev.charging-session.updated', () => {
    void queryClient.invalidateQueries({ queryKey: ['ev', 'fleet'] })
    void queryClient.invalidateQueries({ queryKey: ['ev', 'sessions'] })
  })
  useRealtimeEvent('ev.battery.logged', () => void queryClient.invalidateQueries({ queryKey: ['ev', 'fleet'] }))
}

/** GET /ev/fleet: the caller's EVs (or one depot's), lowest charge first. */
export function useEvFleet(depotId: string) {
  const { api } = useAuth()
  return useQuery({
    queryKey: evKeys.fleet(depotId),
    queryFn: () => api.request<EvFleetVehicle[]>(`/ev/fleet${depotId ? `?depot_id=${encodeURIComponent(depotId)}` : ''}`),
    refetchInterval: usePollInterval(),
  })
}

/** GET /ev/charging-sessions: the fleet's sessions newest first, one page. An empty status is every status. */
export function useChargingSessions(status: SessionStatus | '', page: number, pageSize: number) {
  const { api } = useAuth()
  return useQuery({
    queryKey: evKeys.sessions(status, page, pageSize),
    queryFn: async () => {
      const q = new URLSearchParams({ page: String(page), page_size: String(pageSize) })
      if (status) q.set('status', status)
      const { data, meta } = await api.requestEnvelope<ChargingSession[]>(`/ev/charging-sessions?${q}`)
      return { rows: data, total: (meta as unknown as { total_items: number }).total_items }
    },
    placeholderData: keepPreviousData,
    refetchInterval: usePollInterval(),
  })
}

/** GET /ev/charging-stations: every station with a place, for the map. They change rarely. Needs ev:read. */
export function useChargingStations(enabled = true) {
  const { api } = useAuth()
  return useQuery({
    queryKey: evKeys.stations,
    queryFn: () => api.request<ChargingStation[]>('/ev/charging-stations?page_size=100'),
    staleTime: 10 * 60_000,
    enabled,
  })
}

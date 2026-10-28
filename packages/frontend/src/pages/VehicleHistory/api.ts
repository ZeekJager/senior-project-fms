import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import type { PageMeta } from '@/lib/api/client'
import type { Route } from '@/pages/Routes/api'
import type { TripStatus } from '@/pages/Dispatch/types'
import type { Vehicle } from '@/pages/Vehicles/types'

// What the vehicle page (S-22, FMS-136) reads: the vehicle, then each section's history by vehicle_id.
// Public ids only; every list keeps the API's depot scope.

/** A trip as GET /trips returns it (api-contract §7.2): the plan and what happened. */
export interface TripRecord {
  id: string
  route_id: string | null
  route_name: string | null
  vehicle_id: string | null
  driver_id: string | null
  status: TripStatus
  origin: string | null
  destination: string | null
  planned_distance_km: number | null
  planned_duration_seconds: number | null
  scheduled_start: string | null
  scheduled_end: string | null
  actual_start: string | null
  actual_end: string | null
  actual_distance_km: number | null
}

/** A fill-up (api-contract §9): millilitres and cents, integers as stored. */
export interface FuelLog {
  id: string
  driver_id: string | null
  trip_id: string | null
  fuel_type: string
  quantity_ml: number
  unit_price_cents: number | null
  total_cost_cents: number
  odometer_km: number | null
  station_name: string | null
  source: 'pump' | 'fuel_card' | 'manual'
  recorded_at: string
}

/** An odometer or engine-hour reading (FMS-126). */
export interface MeterReading {
  id: string
  meter: 'odometer' | 'engine_hours'
  value: number
  source: 'fuel_log' | 'maintenance' | 'telematics' | 'gps_derived' | 'manual'
  recorded_at: string
  suspect: boolean
}

/** A stored GPS point (GET /vehicles/{id}/tracking). */
export interface TrackPoint {
  recorded_at: string
  lat: number
  lng: number
  speed_kmh: number
  trip_id: string | null
}

export const historyKeys = {
  vehicle: (id: string) => ['vehicles', 'detail', id] as const,
  trips: (id: string, cursor: string | null) => ['trips', 'by-vehicle', id, cursor] as const,
  route: (id: string) => ['routes', 'detail', id] as const,
  track: (id: string, from: string, to: string) => ['tracking', id, from, to] as const,
  fuel: (id: string, page: number) => ['fuel-logs', 'by-vehicle', id, page] as const,
  meters: (id: string, page: number) => ['meter-readings', id, page] as const,
  drivers: (depotId: string) => ['drivers', 'names', depotId] as const,
}

const PAGE_SIZE = 25

/** GET /vehicles/{id} (vehicle:read). */
export function useVehicle(id: string) {
  const { api } = useAuth()
  return useQuery({ queryKey: historyKeys.vehicle(id), queryFn: () => api.request<Vehicle>(`/vehicles/${id}`) })
}

/** GET /trips?vehicle_id= (trip:read): newest first, a page at a time by cursor. */
export function useVehicleTrips(vehicleId: string, cursor: string | null, enabled: boolean) {
  const { api } = useAuth()
  return useQuery({
    queryKey: historyKeys.trips(vehicleId, cursor),
    queryFn: async () => {
      const q = new URLSearchParams({ vehicle_id: vehicleId, page_size: String(PAGE_SIZE) })
      if (cursor) q.set('cursor', cursor)
      const { data, meta } = await api.requestEnvelope<TripRecord[]>(`/trips?${q}`)
      return { trips: data, nextCursor: (meta as { next_cursor?: string | null }).next_cursor ?? null }
    },
    enabled,
    placeholderData: keepPreviousData,
  })
}

/** GET /routes/{id} (route:read): where the trip was planned to go, with coordinates. */
export function useRoute(routeId: string | null, enabled: boolean) {
  const { api } = useAuth()
  return useQuery({
    queryKey: historyKeys.route(routeId ?? ''),
    queryFn: () => api.request<Route>(`/routes/${routeId}`),
    enabled: enabled && routeId !== null,
    staleTime: 5 * 60_000,
  })
}

/** The most pages of GPS points one trip's map loads: 5,000 points, over two weeks of driving at one every five minutes. */
const TRACK_MAX_PAGES = 5

/** GET /vehicles/{id}/tracking (tracking:read): every point between two instants, oldest first. */
export function useTrack(vehicleId: string, from: string | null, to: string | null, enabled: boolean) {
  const { api } = useAuth()
  return useQuery({
    queryKey: historyKeys.track(vehicleId, from ?? '', to ?? ''),
    queryFn: async () => {
      const points: TrackPoint[] = []
      let cursor: string | null = null
      for (let page = 0; page < TRACK_MAX_PAGES; page++) {
        const q = new URLSearchParams({ from: from!, to: to!, limit: '1000' })
        if (cursor) q.set('cursor', cursor)
        const { data, meta } = await api.requestEnvelope<TrackPoint[]>(`/vehicles/${vehicleId}/tracking?${q}`)
        points.push(...data)
        cursor = (meta as { next_cursor?: string | null }).next_cursor ?? null
        if (!cursor) break
      }
      return points
    },
    enabled: enabled && from !== null && to !== null,
    staleTime: 5 * 60_000,
  })
}

/** GET /fuel-logs?vehicle_id= (fuel:read): newest first. */
export function useVehicleFuel(vehicleId: string, page: number, enabled: boolean) {
  const { api } = useAuth()
  return useQuery({
    queryKey: historyKeys.fuel(vehicleId, page),
    queryFn: async () => {
      const q = new URLSearchParams({ vehicle_id: vehicleId, page: String(page), page_size: String(PAGE_SIZE) })
      const { data, meta } = await api.requestEnvelope<FuelLog[]>(`/fuel-logs?${q}`)
      return { logs: data, meta: meta as unknown as PageMeta }
    },
    enabled,
    placeholderData: keepPreviousData,
  })
}

/** GET /vehicles/{id}/meter-readings (vehicle:read): the odometer's history, newest first. */
export function useOdometerReadings(vehicleId: string, page: number) {
  const { api } = useAuth()
  return useQuery({
    queryKey: historyKeys.meters(vehicleId, page),
    queryFn: async () => {
      const q = new URLSearchParams({ meter: 'odometer', page: String(page), page_size: String(PAGE_SIZE) })
      const { data, meta } = await api.requestEnvelope<MeterReading[]>(`/vehicles/${vehicleId}/meter-readings?${q}`)
      return { readings: data, meta: meta as unknown as PageMeta }
    },
    placeholderData: keepPreviousData,
  })
}

/** Driver names of a depot (driver:read), to name who drove each trip; the depot's drivers fit one page. */
export function useDriverNames(depotId: string | null, enabled: boolean) {
  const { api } = useAuth()
  return useQuery({
    queryKey: historyKeys.drivers(depotId ?? ''),
    queryFn: async () => {
      const q = new URLSearchParams({ depot_id: depotId!, page_size: '100' })
      const drivers = await api.request<{ id: string; full_name: string }[]>(`/drivers?${q}`)
      return new Map(drivers.map((d) => [d.id, d.full_name]))
    },
    enabled: enabled && depotId !== null,
    staleTime: 5 * 60_000,
  })
}

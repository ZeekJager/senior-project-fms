import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import { currentMonth, shiftMonth, type Month } from '@/lib/month'

/** Which database answered a reporting read (FMS-94): the replica may be a few seconds behind. */
export interface DataFreshness {
  source: 'replica' | 'primary'
  lag_seconds: number
  as_of: string
}

export const DOWNTIME_REASONS = ['planned_service', 'unplanned_repair', 'breakdown', 'accident', 'awaiting_parts', 'other'] as const
export type DowntimeReason = (typeof DOWNTIME_REASONS)[number]

/** A month's downtime figures for a vehicle, a depot or the fleet (GET /analytics/downtime, FMS-131), in whole minutes. */
export interface DowntimeKpis {
  in_fleet_minutes: number
  uptime_minutes: number
  downtime_minutes: number
  unplanned_downtime_minutes: number
  /** Up over in the fleet, to a tenth of a percent; null with no time in the fleet. */
  availability_pct: number | null
  /** Unplanned periods begun in the month. */
  failures: number
  mtbf_minutes: number | null
  /** Unplanned periods ended in the month. */
  repairs: number
  mttr_minutes: number | null
  downtime_by_reason: Record<DowntimeReason, number>
}

export interface VehicleAvailability extends DowntimeKpis {
  vehicle_id: string
  registration_number: string
  depot_id: string
  depot_name: string
  status: string
}

export interface DepotAvailability extends DowntimeKpis {
  depot_id: string
  depot_name: string
  vehicles: number
}

export interface Availability {
  month: Month
  fleet: DowntimeKpis & { vehicles: number }
  depots: DepotAvailability[]
  vehicles: VehicleAvailability[]
}

/** One stretch a vehicle was out of service (GET /vehicles/{id}/downtime), with the problem behind it (FMS-142). */
export interface DowntimePeriod {
  id: string
  vehicle_id: string
  started_at: string
  ended_at: string | null
  duration_minutes: number
  reason: DowntimeReason
  unplanned: boolean
  derived_reason: DowntimeReason
  reason_note: string | null
  reason_set_by: string | null
  reason_set_at: string | null
  opened_by: 'status_change' | 'breakdown' | 'registration'
  maintenance_record_id: string | null
  failure_event_id: string | null
  maintenance_record: { id: string; maintenance_type: string; status: string; description: string | null } | null
  failure: { id: string; component: string; failure_mode: string; detected_by: string; occurred_at: string } | null
}

export type SortKey = 'downtime' | 'availability' | 'failures' | 'mtbf' | 'mttr' | 'plate'
export type View = 'all' | 'down'

/** The screen's state, in the URL: month, depot, view, sort, the vehicle open. Defaults stay out. */
export interface ScreenState {
  month: Month
  depotId: string
  view: View
  sort: SortKey
  order: 'asc' | 'desc'
  vehicle: string
}

const SORTS: readonly SortKey[] = ['downtime', 'availability', 'failures', 'mtbf', 'mttr', 'plate']

/** The order a column sorts in first: the worst first (most downtime, least available, failing soonest). */
export const FIRST_ORDER: Record<SortKey, 'asc' | 'desc'> = { downtime: 'desc', availability: 'asc', failures: 'desc', mtbf: 'asc', mttr: 'desc', plate: 'asc' }

export function readState(p: URLSearchParams, now = new Date()): ScreenState {
  const latest = currentMonth(now)
  const month = p.get('month')
  const sort = p.get('sort') as SortKey | null
  const key = sort && SORTS.includes(sort) ? sort : 'downtime'
  const order = p.get('order')
  return {
    // This month so far by default, as the API; never a month that has not begun.
    month: month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) && month <= latest ? month : latest,
    depotId: p.get('depot') ?? '',
    view: p.get('view') === 'down' ? 'down' : 'all',
    sort: key,
    order: order === 'asc' || order === 'desc' ? order : FIRST_ORDER[key],
    vehicle: p.get('vehicle') ?? '',
  }
}

export function writeState(s: ScreenState, now = new Date()): URLSearchParams {
  const p = new URLSearchParams()
  if (s.month !== currentMonth(now)) p.set('month', s.month)
  if (s.depotId) p.set('depot', s.depotId)
  if (s.view !== 'all') p.set('view', s.view)
  if (s.sort !== 'downtime') p.set('sort', s.sort)
  if (s.order !== FIRST_ORDER[s.sort]) p.set('order', s.order)
  if (s.vehicle) p.set('vehicle', s.vehicle)
  return p
}

/** The month's first instant and the next month's, in Addis Ababa (UTC+3 all year), as the API's ISO times. */
export function monthWindow(month: Month): { from: string; to: string } {
  return { from: `${month}-01T00:00:00+03:00`, to: `${shiftMonth(month, 1)}-01T00:00:00+03:00` }
}

/** The month's figures for the fleet, each depot and each vehicle in the caller's scope (FMS-131). */
export function useAvailability(month: Month, depotId: string) {
  const { api } = useAuth()
  return useQuery({
    queryKey: ['availability', month, depotId],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const q = new URLSearchParams({ month })
      if (depotId) q.set('depot_id', depotId)
      const { data, meta } = await api.requestEnvelope<Availability>(`/analytics/downtime?${q}`)
      return { ...data, freshness: (meta as unknown as { data_freshness?: DataFreshness }).data_freshness }
    },
  })
}

/** The vehicle's downtime periods overlapping the month, newest first (a month is a few periods: one page). */
export function useVehiclePeriods(vehicleId: string, month: Month) {
  const { api } = useAuth()
  return useQuery({
    queryKey: ['availability', 'periods', vehicleId, month],
    enabled: Boolean(vehicleId),
    queryFn: async () => {
      const q = new URLSearchParams({ ...monthWindow(month), page_size: '100' })
      const { data, meta } = await api.requestEnvelope<DowntimePeriod[]>(`/vehicles/${vehicleId}/downtime?${q}`)
      return { periods: data, total: (meta as unknown as { total_items: number }).total_items }
    },
  })
}

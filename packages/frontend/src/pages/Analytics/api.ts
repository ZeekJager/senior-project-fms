import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'

// The analytics API (api-contract §14, FMS-50), read by S-18 (FMS-51). analytics:read, in the caller's depots.

export interface DataFreshness {
  source: 'replica' | 'primary'
  lag_seconds: number
  as_of: string
}

export interface AnalyticsMeta {
  from: string
  to: string
  days: number
  /** The cache's last refresh. */
  computed_at: string | null
  /** No refresh for 25 hours, or never filled. */
  stale: boolean
  data_freshness: DataFreshness
}

/** The KPIs a range or a day carries; integers (whole percent, km, ml, cents), null with nothing to divide by. */
export interface Kpis {
  utilisation_pct: number | null
  distance_km: number
  trips_completed: number
  on_time_pct: number | null
  fuel_ml: number
  fuel_cost_cents: number
  maintenance_cost_cents: number
  total_cost_cents: number
  cost_per_km_cents: number | null
}

export type Severity = 'low' | 'medium' | 'high' | 'critical'

export interface FleetSummary extends Kpis {
  vehicles: { total: number; by_status: Record<'active' | 'inactive' | 'maintenance' | 'retired', number>; maintenance_flagged: number; average_health_score: number | null }
  open_alerts: Record<Severity | 'total', number>
  daily: (Kpis & { date: string; vehicles_used: number })[]
}

export interface VehicleUtilisation {
  vehicle_id: string
  registration_number: string
  depot_name: string
  status: string
  days_used: number
  days: number
  utilisation_pct: number | null
  distance_km: number
  trips_completed: number
}

export interface UtilisationSummary {
  utilisation_pct: number | null
  vehicle_days: number
  days_used: number
  vehicles: VehicleUtilisation[]
}

export interface MaintenanceRisk {
  vehicle_id: string
  registration_number: string
  depot_name: string
  status: string
  health_score: number | null
  maintenance_flag: boolean
  risk_pct: number | null
  predicted_failure_type: string | null
}

export type RangeKey = '7d' | '30d' | '90d' | '12m'

export const RANGES: { value: RangeKey; label: string; days: number }[] = [
  { value: '7d', label: 'Last 7 days', days: 7 },
  { value: '30d', label: 'Last 30 days', days: 30 },
  { value: '90d', label: 'Last 90 days', days: 90 },
  { value: '12m', label: 'Last 12 months', days: 365 },
]

const ADDIS_MS = 3 * 3_600_000
const DAY_MS = 86_400_000

/** Today in Addis Ababa (UTC+3 all year), YYYY-MM-DD. */
export const addisToday = (now = new Date()) => new Date(now.getTime() + ADDIS_MS).toISOString().slice(0, 10)
const shiftDay = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)

/** The days a preset covers, ending today, both included. */
export function rangeDays(key: RangeKey, now = new Date()): { from: string; to: string } {
  const to = addisToday(now)
  return { from: shiftDay(to, 1 - RANGES.find((r) => r.value === key)!.days), to }
}

/** The screen's state, kept in the URL; the defaults stay out of it. */
export interface DashboardState {
  range: RangeKey
  depotId: string
}

export function readState(params: URLSearchParams): DashboardState {
  const range = params.get('range')
  return { range: RANGES.some((r) => r.value === range) ? (range as RangeKey) : '30d', depotId: params.get('depot') ?? '' }
}

export function writeState(state: DashboardState): URLSearchParams {
  const p = new URLSearchParams()
  if (state.range !== '30d') p.set('range', state.range)
  if (state.depotId) p.set('depot', state.depotId)
  return p
}

type Report = 'fleet-summary' | 'utilisation' | 'maintenance-risk'

/** One analytics report for the range and depot; the previous answer stays on screen while the next loads. */
export function useAnalytics<T>(report: Report, state: DashboardState) {
  const { api } = useAuth()
  const { from, to } = rangeDays(state.range)
  return useQuery({
    queryKey: ['analytics', report, from, to, state.depotId],
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const q = new URLSearchParams({ from, to })
      if (state.depotId) q.set('depot_id', state.depotId)
      const { data, meta } = await api.requestEnvelope<T>(`/analytics/${report}?${q}`)
      return { data, meta: meta as unknown as AnalyticsMeta }
    },
  })
}

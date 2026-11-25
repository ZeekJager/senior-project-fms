import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import { apiFilters, writeState, type ReportKind, type ScreenState } from '@/pages/Reports/api'

// The KPI dashboard (FMS-160, S-39): GET /analytics/kpis for the period and filters of the reports, and a KPI's trend
// over up to 24 months with last year beside it and its drill-down by depot or vehicle. analytics:read.

export type KpiKey =
  | 'cost_per_km'
  | 'fuel_l_per_100km'
  | 'utilisation_pct'
  | 'availability_pct'
  | 'on_time_pct'
  | 'pm_compliance_pct'
  | 'incidents_per_100k_km'
  | 'vehicles_at_risk'
  | 'appeals'
  | 'feedback'

export type KpiUnit = 'cents_per_km' | 'tenths_l_per_100km' | 'pct' | 'tenths_per_100k_km' | 'count'
export type KpiStatus = 'green' | 'amber' | 'red' | 'none'

export interface Kpi {
  key: KpiKey
  label: string
  unit: KpiUnit
  value: number | null
  previous: number | null
  change: number | null
  /** In the unit, except incidents: whole incidents per 100,000 km. */
  target: number | null
  status: KpiStatus
  /** The 12 months to the period's end, oldest first. */
  sparkline: [string, number | null][]
  report: ReportKind | null
}

export interface KpiDashboard {
  period: { key: string; label: string; from: string; to: string }
  kpis: Kpi[]
}

export interface KpiTrend {
  kpi: KpiKey
  label: string
  unit: KpiUnit
  period: { key: string; label: string }
  series: { month: string; value: number | null; last_year: number | null }[]
  group: 'depot' | 'vehicle' | null
  breakdown: { name: string; value: number | null }[]
}

/** Which way is good: down for costs, fuel, incidents and vehicles at risk; up for the shares; neither for counts of appeals and feedback. */
export const BETTER: Record<KpiKey, 'lower' | 'higher' | null> = {
  cost_per_km: 'lower',
  fuel_l_per_100km: 'lower',
  utilisation_pct: 'higher',
  availability_pct: 'higher',
  on_time_pct: 'higher',
  pm_compliance_pct: 'higher',
  incidents_per_100k_km: 'lower',
  vehicles_at_risk: 'lower',
  appeals: null,
  feedback: null,
}

const fixed = (v: number, places: number) => v.toLocaleString('en-US', { minimumFractionDigits: places, maximumFractionDigits: places })

/** A value as it reads on a tile: "ETB 35.20", "31.0", "82%", "4.2", "7". */
export function formatKpi(unit: KpiUnit, value: number | null): string {
  if (value === null) return '—'
  switch (unit) {
    case 'cents_per_km':
      return `ETB ${fixed(value / 100, 2)}`
    case 'tenths_l_per_100km':
    case 'tenths_per_100k_km':
      return fixed(value / 10, 1)
    case 'pct':
      return `${value}%`
    default:
      return value.toLocaleString('en-US')
  }
}

/** What the number is in, beside it. */
export const UNIT_WORDS: Record<KpiUnit, string> = {
  cents_per_km: 'per km',
  tenths_l_per_100km: 'L/100 km',
  pct: '',
  tenths_per_100k_km: 'per 100,000 km',
  count: '',
}

/** A change from the period before: "+2.1", "-ETB 0.40", "+5 pts". */
export function formatChange(unit: KpiUnit, change: number): string {
  const sign = change > 0 ? '+' : change < 0 ? '−' : '±'
  const abs = Math.abs(change)
  if (unit === 'pct') return `${sign}${abs} pts`
  if (unit === 'cents_per_km') return `${sign}ETB ${fixed(abs / 100, 2)}`
  if (unit === 'tenths_l_per_100km' || unit === 'tenths_per_100k_km') return `${sign}${fixed(abs / 10, 1)}`
  return `${sign}${abs.toLocaleString('en-US')}`
}

/** A target as the tile shows it (the incidents target is whole incidents, not tenths). */
export function formatTarget(kpi: Pick<Kpi, 'unit' | 'target'>): string | null {
  if (kpi.target === null) return null
  if (kpi.unit === 'tenths_per_100k_km') return kpi.target.toLocaleString('en-US')
  return formatKpi(kpi.unit, kpi.target)
}

/** The KPIs' query: the reports' period and filters, without the safety grouping. */
function kpiQuery(state: ScreenState): URLSearchParams {
  const q = apiFilters(state)
  delete q.by
  return new URLSearchParams(q)
}

export function useKpis(state: ScreenState) {
  const { api } = useAuth()
  const q = kpiQuery(state)
  return useQuery({
    queryKey: ['kpis', q.toString()],
    queryFn: () => api.request<KpiDashboard>(`/analytics/kpis?${q}`),
    placeholderData: keepPreviousData,
  })
}

export function useKpiTrend(key: KpiKey, state: ScreenState, months: number, group: 'depot' | 'vehicle') {
  const { api } = useAuth()
  const q = kpiQuery(state)
  q.set('months', String(months))
  q.set('group', group)
  return useQuery({
    queryKey: ['kpis', 'trend', key, q.toString()],
    queryFn: () => api.request<KpiTrend>(`/analytics/kpis/${key}/trend?${q}`),
    placeholderData: keepPreviousData,
  })
}

/** The report a KPI opens, for the same period and filters. */
export function reportLink(report: ReportKind, state: ScreenState): string {
  const q = writeState({ ...state, report })
  return `/reports${q.toString() ? `?${q}` : ''}`
}

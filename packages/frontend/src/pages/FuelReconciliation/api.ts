import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'

/** Which database answered a reporting read (FMS-94): the replica may be a few seconds behind. */
export interface DataFreshness {
  source: 'replica' | 'primary'
  lag_seconds: number
  as_of: string
}

export type ReconciliationStatus = 'above' | 'below' | 'within' | 'not_judged'
export type NotJudgedReason = 'electric' | 'no_efficiency' | 'too_little_distance'

/** One vehicle's month (GET /fuel-reconciliation, FMS-41). Integers: ml, cents, whole percent. */
export interface ReconciliationRow {
  vehicle_id: string
  registration_number: string
  depot_id: string
  depot_name: string
  fuel_type: string
  fuel_efficiency_ml_per_km: number | null
  distance_km: number
  trips: number
  fuel_logs: number
  expected_ml: number | null
  actual_ml: number
  variance_ml: number | null
  variance_pct: number | null
  total_cost_cents: number
  status: ReconciliationStatus
  reason: NotJudgedReason | null
  anomaly_id: string | null
}

export interface ReconciliationSummary {
  vehicles: number
  judged: number
  above: number
  below: number
  expected_ml: number
  actual_ml: number
  variance_pct: number | null
  total_cost_cents: number
}

export type AnomalyStatus = 'open' | 'reviewed' | 'dismissed' | 'resolved'

/** A fuel anomaly (GET /fuel-anomalies, FMS-42). */
export interface FuelAnomaly {
  id: string
  vehicle_id: string
  registration_number: string
  depot_id: string
  depot_name: string
  fuel_log_id: string | null
  anomaly_type: string
  severity: string
  status: AnomalyStatus
  period_from: string | null
  period_to: string | null
  distance_km: number | null
  expected_ml: number | null
  actual_ml: number | null
  deviation_pct: number | null
  detected_at: string
  reviewed_by: string | null
  reviewed_by_name: string | null
  reviewed_at: string | null
  notes: string | null
}

/** A calendar month, `YYYY-MM`. */
export type Month = string

const pad = (n: number) => String(n).padStart(2, '0')

/** This month in Addis Ababa (UTC+3 all year). */
export function currentMonth(now = new Date()): Month {
  return new Date(now.getTime() + 3 * 3_600_000).toISOString().slice(0, 7)
}

export function shiftMonth(month: Month, by: number): Month {
  const [y, m] = month.split('-').map(Number)
  const index = y * 12 + (m - 1) + by
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}`
}

/** The month's first and last day, as the API's inclusive date bounds. */
export function monthBounds(month: Month): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { from: `${month}-01`, to: `${month}-${pad(last)}` }
}

/** "September 2026". */
export function monthLabel(month: Month): string {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

export type Tab = 'vehicles' | 'anomalies'
export type Mark = 'flag' | 'watch' | 'ok' | 'not_judged'
export type AnomalyView = 'needs_review' | 'resolved' | 'dismissed' | 'all'

/** The screen's state, in the URL: tab, month, depot, mark, anomaly view, the anomaly open. Defaults stay out. */
export interface ScreenState {
  tab: Tab
  month: Month
  depotId: string
  mark: Mark | ''
  anomalyView: AnomalyView
  anomaly: string
}

const MARKS: readonly Mark[] = ['flag', 'watch', 'ok', 'not_judged']
const ANOMALY_VIEWS: readonly AnomalyView[] = ['needs_review', 'resolved', 'dismissed', 'all']

export function readState(p: URLSearchParams, now = new Date()): ScreenState {
  const latest = currentMonth(now)
  const month = p.get('month')
  const mark = p.get('mark') as Mark | null
  const view = p.get('view') as AnomalyView | null
  return {
    tab: p.get('tab') === 'anomalies' ? 'anomalies' : 'vehicles',
    // Last month by default; never a month that has not begun.
    month: month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) && month <= latest ? month : shiftMonth(latest, -1),
    depotId: p.get('depot') ?? '',
    mark: mark && MARKS.includes(mark) ? mark : '',
    anomalyView: view && ANOMALY_VIEWS.includes(view) ? view : 'needs_review',
    anomaly: p.get('anomaly') ?? '',
  }
}

export function writeState(s: ScreenState, now = new Date()): URLSearchParams {
  const p = new URLSearchParams()
  if (s.tab !== 'vehicles') p.set('tab', s.tab)
  if (s.month !== shiftMonth(currentMonth(now), -1)) p.set('month', s.month)
  if (s.depotId) p.set('depot', s.depotId)
  if (s.mark) p.set('mark', s.mark)
  if (s.anomalyView !== 'needs_review') p.set('view', s.anomalyView)
  if (s.anomaly) p.set('anomaly', s.anomaly)
  return p
}

/**
 * How far off a vehicle is, as a mark (FMS-42): beyond the anomaly threshold (20% by default) either way is a flag,
 * beyond half of it a watch, the rest OK. A vehicle the reconciliation could not judge has no mark.
 */
export function markOf(row: Pick<ReconciliationRow, 'status' | 'variance_pct'>, thresholdPct: number): Mark {
  if (row.status === 'not_judged' || row.variance_pct === null) return 'not_judged'
  const off = Math.abs(row.variance_pct)
  if (off > thresholdPct) return 'flag'
  return off > Math.round(thresholdPct / 2) ? 'watch' : 'ok'
}

/** The largest page the API serves (api-contract §18). */
const PAGE = 100

interface PageMeta {
  total_items: number
  threshold_pct: number
  summary: ReconciliationSummary
  data_freshness: DataFreshness
  from: string
  to: string
}

/**
 * Every vehicle's month at once (a fleet is hundreds of vehicles: a few pages of 100), so the marks, their counts,
 * the paging and the CSV all work on the same rows without asking again.
 */
export function useReconciliation(month: Month, depotId: string, enabled: boolean) {
  const { api } = useAuth()
  return useQuery({
    queryKey: ['fuel-reconciliation', month, depotId],
    enabled,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const { from, to } = monthBounds(month)
      const rows: ReconciliationRow[] = []
      let meta: PageMeta | null = null
      for (let page = 1; ; page += 1) {
        const q = new URLSearchParams({ from, to, page: String(page), page_size: String(PAGE) })
        if (depotId) q.set('depot_id', depotId)
        const res = await api.requestEnvelope<ReconciliationRow[]>(`/fuel-reconciliation?${q}`)
        rows.push(...res.data)
        meta = res.meta as unknown as PageMeta
        if (rows.length >= meta.total_items || res.data.length === 0) break
      }
      return { rows, summary: meta.summary, thresholdPct: meta.threshold_pct, freshness: meta.data_freshness }
    },
  })
}

const ANOMALY_STATUSES: Record<AnomalyView, string> = {
  needs_review: 'open,reviewed',
  resolved: 'resolved',
  dismissed: 'dismissed',
  all: '',
}

const anomalyKeys = {
  all: ['fuel-anomalies'] as const,
  list: (view: AnomalyView, page: number, pageSize: number) => ['fuel-anomalies', 'list', view, page, pageSize] as const,
  counts: ['fuel-anomalies', 'counts'] as const,
  one: (id: string) => ['fuel-anomalies', 'one', id] as const,
}

export function useAnomalies(view: AnomalyView, page: number, pageSize: number) {
  const { api } = useAuth()
  return useQuery({
    queryKey: anomalyKeys.list(view, page, pageSize),
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const q = new URLSearchParams({ page: String(page), page_size: String(pageSize) })
      if (ANOMALY_STATUSES[view]) q.set('status', ANOMALY_STATUSES[view])
      const { data, meta } = await api.requestEnvelope<FuelAnomaly[]>(`/fuel-anomalies?${q}`)
      return { anomalies: data, total: (meta as unknown as { total_items: number }).total_items }
    },
  })
}

/** How many anomalies each view holds (page_size=1 per view), for the tabs. */
export function useAnomalyCounts() {
  const { api } = useAuth()
  const results = useQueries({
    queries: ANOMALY_VIEWS.map((view) => ({
      queryKey: [...anomalyKeys.counts, view],
      queryFn: async () => {
        const q = new URLSearchParams({ page_size: '1' })
        if (ANOMALY_STATUSES[view]) q.set('status', ANOMALY_STATUSES[view])
        const { meta } = await api.requestEnvelope<FuelAnomaly[]>(`/fuel-anomalies?${q}`)
        return (meta as unknown as { total_items: number }).total_items
      },
    })),
  })
  return {
    counts: Object.fromEntries(ANOMALY_VIEWS.map((view, i) => [view, results[i].data])) as Record<AnomalyView, number | undefined>,
    isLoading: results.some((r) => r.isPending),
  }
}

/** One anomaly, for a link that opens it (a notification, a vehicle's row). */
export function useAnomaly(id: string) {
  const { api } = useAuth()
  return useQuery({ queryKey: anomalyKeys.one(id), enabled: Boolean(id), queryFn: () => api.request<FuelAnomaly>(`/fuel-anomalies/${id}`) })
}

/** POST /fuel-anomalies/{id}/resolve: resolved (dealt with) or dismissed (not a problem; a note is required). */
export function useCloseAnomaly() {
  const { api } = useAuth()
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, outcome, notes }: { id: string; outcome: 'resolved' | 'dismissed'; notes: string }) =>
      api.request<FuelAnomaly>(`/fuel-anomalies/${id}/resolve`, { method: 'POST', json: notes ? { outcome, notes } : { outcome } }),
    onSuccess: (closed) => {
      client.setQueryData(anomalyKeys.one(closed.id), closed)
      void client.invalidateQueries({ queryKey: anomalyKeys.all })
    },
  })
}

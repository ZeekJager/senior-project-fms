import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import { API_BASE } from '@/lib/api/client'
import { currentMonth, shiftMonth, type Month } from '@/lib/month'

// Reports (FMS-91, FMS-160, S-28): GET /reports/{report} as JSON for the preview, and the same table as CSV, Excel or
// PDF to download, for a month, a quarter, a year or a range, narrowed by depots, vehicle type, vehicle, driver and
// route. analytics:read, in the caller's depot scope; read from the reporting copy of the database. Saved filters,
// background exports over 20,000 rows, and schedules that email a report.

export type ReportKind = 'fuel' | 'maintenance' | 'cost' | 'trips' | 'drivers' | 'utilisation' | 'compliance' | 'safety'
export type ReportFormat = 'csv' | 'xlsx' | 'pdf'
export type PeriodKind = 'month' | 'quarter' | 'year' | 'range'
export type SafetyGroup = 'depot' | 'driver' | 'route'

/** How a column's values are kept: litres in ml, etb in cents, km in metres, l_per_100km in ml per km, hours in minutes, rate in tenths. */
export type ColumnKind = 'text' | 'count' | 'litres' | 'etb' | 'km' | 'l_per_100km' | 'pct' | 'hours' | 'datetime' | 'rate'

export interface ReportColumn {
  key: string
  label: string
  kind: ColumnKind
}

export type ReportValue = string | number | null
export type ReportRow = Record<string, ReportValue>

export interface DataFreshness {
  source: 'replica' | 'primary'
  lag_seconds: number
  as_of: string
}

export interface ReportSection {
  title: string
  columns: ReportColumn[]
  rows: ReportRow[]
}

export interface Report {
  report: ReportKind
  title: string
  /** The month, when the period is one. */
  month: Month | null
  period: { from: string; to: string; kind: PeriodKind; key: string; label: string; first_day: string; last_day: string }
  /** What the filters name: depot names, the vehicle's registration, the driver, the route. */
  filter_names: { depots: string[]; vehicle: string | null; driver: string | null; route: string | null }
  group?: SafetyGroup
  sections?: ReportSection[]
  depot: { id: string; name: string; code: string } | null
  columns: ReportColumn[]
  rows: ReportRow[]
  /** Sums and overall ratios; null with no rows. */
  totals: ReportRow | null
  generated_at: string
}

/** Over this many rows a file is made in the background (the server's BACKGROUND_EXPORT_ROWS). */
export const BACKGROUND_ROWS = 20_000

/** The reports, in the order the screen offers them, with what each answers. */
export const REPORT_OPTIONS: readonly { value: ReportKind; label: string; description: string; empty: string }[] = [
  {
    value: 'fuel',
    label: 'Fuel',
    description: 'Each vehicle’s fill-ups, litres and cost, the km it drove, and what it used per 100 km against its rating.',
    empty: 'No fuel was logged and no trip was completed',
  },
  {
    value: 'maintenance',
    label: 'Maintenance',
    description: 'Repairs each vehicle had done, by type, with labour and cost, and the work still open when the period ended.',
    empty: 'No repair was completed or left open',
  },
  {
    value: 'cost',
    label: 'Cost',
    description: 'Fuel and repair costs per vehicle, their total, and the cost of each km driven.',
    empty: 'Nothing was spent and no km were driven',
  },
  {
    value: 'trips',
    label: 'Trip history',
    description: 'Every trip due to start in the period: route, vehicle, driver, when it ran, how far, and whether it ended on time.',
    empty: 'No trip was scheduled',
  },
  {
    value: 'drivers',
    label: 'Driver performance',
    description:
      'Each driver’s completed trips, km and hours behind the wheel, punctuality, speeding and idling flags, and incidents; with tracking access, their score from 0 to 100 and rank.',
    empty: 'No driver completed a trip, was flagged or had an incident',
  },
  {
    value: 'utilisation',
    label: 'Utilisation',
    description: 'Days each vehicle was in the fleet, available and in use, its utilisation, its downtime by cause, and its availability.',
    empty: 'No vehicle was in the fleet',
  },
  {
    value: 'compliance',
    label: 'Compliance',
    description: 'Programmed services on time, late and overdue, repairs repeated within 30 days, time between failures, and repair cost by system and workshop.',
    empty: 'No service was due and no repair was done',
  },
  {
    value: 'safety',
    label: 'Safety',
    description: 'Incidents and driving flags per 100,000 km, by depot, driver or route, with the score appeals raised against them.',
    empty: 'No km were driven and nothing was reported',
  },
]

export const SAFETY_GROUPS: readonly { value: SafetyGroup; label: string }[] = [
  { value: 'depot', label: 'By depot' },
  { value: 'driver', label: 'By driver' },
  { value: 'route', label: 'By route' },
]

const KINDS = REPORT_OPTIONS.map((o) => o.value)
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/
const QUARTER = /^\d{4}-Q[1-4]$/
const YEAR = /^\d{4}$/
const DAY = /^\d{4}-\d{2}-\d{2}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ScreenState {
  report: ReportKind
  period: PeriodKind
  month: Month
  /** YYYY-Qn. */
  quarter: string
  /** YYYY. */
  year: string
  /** A range's days, YYYY-MM-DD, both included. */
  from: string
  to: string
  depotIds: string[]
  vehicleType: string
  vehicleId: string
  driverId: string
  routeId: string
  by: SafetyGroup
}

/** The quarter a month is in, YYYY-Qn. */
export const quarterOf = (month: Month) => `${month.slice(0, 4)}-Q${Math.floor((Number(month.slice(5, 7)) - 1) / 3) + 1}`

/**
 * The screen's state from its address: fuel, last month (the last whole one) and every depot unless chosen. The
 * FMS-91 links (`?report=&month=&depot=`) still open the same report.
 */
export function readState(params: URLSearchParams, now = new Date()): ScreenState {
  const report = KINDS.find((k) => k === params.get('report')) ?? 'fuel'
  const latest = currentMonth(now)
  const lastMonth = shiftMonth(latest, -1)
  const asked = params.get('month') ?? ''
  const month = MONTH.test(asked) && asked <= latest ? asked : lastMonth
  const quarter = QUARTER.test(params.get('quarter') ?? '') ? params.get('quarter')! : quarterOf(lastMonth)
  const year = YEAR.test(params.get('year') ?? '') ? params.get('year')! : lastMonth.slice(0, 4)
  const from = DAY.test(params.get('from') ?? '') ? params.get('from')! : `${lastMonth}-01`
  const to = DAY.test(params.get('to') ?? '') ? params.get('to')! : `${latest}-01`
  const kind = params.get('period')
  const period: PeriodKind = kind === 'quarter' || kind === 'year' || kind === 'range' ? kind : 'month'
  const ids = (params.get('depots') ?? params.get('depot') ?? '').split(',').filter((id) => UUID.test(id))
  const by = SAFETY_GROUPS.find((g) => g.value === params.get('by'))?.value ?? 'depot'
  const id = (name: string) => (UUID.test(params.get(name) ?? '') ? params.get(name)! : '')
  return { report, period, month, quarter, year, from, to, depotIds: ids, vehicleType: params.get('type') ?? '', vehicleId: id('vehicle'), driverId: id('driver'), routeId: id('route'), by }
}

export function writeState(state: ScreenState, now = new Date()): URLSearchParams {
  const params = new URLSearchParams()
  if (state.report !== 'fuel') params.set('report', state.report)
  if (state.period !== 'month') params.set('period', state.period)
  if (state.period === 'month' && state.month !== shiftMonth(currentMonth(now), -1)) params.set('month', state.month)
  if (state.period === 'quarter') params.set('quarter', state.quarter)
  if (state.period === 'year') params.set('year', state.year)
  if (state.period === 'range') {
    params.set('from', state.from)
    params.set('to', state.to)
  }
  if (state.depotIds.length === 1) params.set('depot', state.depotIds[0])
  else if (state.depotIds.length > 1) params.set('depots', state.depotIds.join(','))
  if (state.vehicleType) params.set('type', state.vehicleType)
  if (state.vehicleId) params.set('vehicle', state.vehicleId)
  if (state.driverId) params.set('driver', state.driverId)
  if (state.routeId) params.set('route', state.routeId)
  if (state.report === 'safety' && state.by !== 'depot') params.set('by', state.by)
  return params
}

/** The period and filters as the API takes them. */
export function apiFilters(state: ScreenState): Record<string, string> {
  const q: Record<string, string> = {}
  if (state.period === 'month') q.month = state.month
  if (state.period === 'quarter') q.quarter = state.quarter
  if (state.period === 'year') q.year = state.year
  if (state.period === 'range') {
    q.from = state.from
    q.to = state.to
  }
  if (state.depotIds.length) q.depot_ids = state.depotIds.join(',')
  if (state.vehicleType) q.vehicle_type = state.vehicleType
  if (state.vehicleId) q.vehicle_id = state.vehicleId
  if (state.driverId) q.driver_id = state.driverId
  if (state.routeId) q.route_id = state.routeId
  if (state.report === 'safety') q.by = state.by
  return q
}

/** A saved filter back on the screen: its period and filters over the current report. */
export function fromSaved(state: ScreenState, filters: Record<string, string>): ScreenState {
  const params = new URLSearchParams({ ...(state.report !== 'fuel' ? { report: state.report } : {}) })
  if (filters.month) params.set('month', filters.month)
  for (const [kind, key] of [['quarter', 'quarter'], ['year', 'year']] as const) {
    if (filters[key]) {
      params.set('period', kind)
      params.set(key, filters[key])
    }
  }
  if (filters.from && filters.to) {
    params.set('period', 'range')
    params.set('from', filters.from)
    params.set('to', filters.to)
  }
  if (filters.depot_ids) params.set('depots', filters.depot_ids)
  if (filters.vehicle_type) params.set('type', filters.vehicle_type)
  if (filters.vehicle_id) params.set('vehicle', filters.vehicle_id)
  if (filters.driver_id) params.set('driver', filters.driver_id)
  if (filters.route_id) params.set('route', filters.route_id)
  if (filters.by) params.set('by', filters.by)
  return readState(params)
}

/** The filters a saved filter keeps (the API's body form: depot_ids a list). */
export function savedBody(state: ScreenState): Record<string, unknown> {
  const { depot_ids, ...rest } = apiFilters(state)
  return { ...rest, ...(depot_ids ? { depot_ids: depot_ids.split(',') } : {}) }
}

/** How many filters past the period are set (the depots count as one). */
export const filterCount = (s: ScreenState) => [s.depotIds.length > 0, s.vehicleType, s.vehicleId, s.driverId, s.routeId].filter(Boolean).length

function reportPath(state: ScreenState, format?: ReportFormat): string {
  const q = new URLSearchParams(apiFilters(state))
  if (format) q.set('format', format)
  return `/reports/${state.report}?${q}`
}

/** The report for the preview, with how current its data is. */
export function useReport(state: ScreenState) {
  const { api } = useAuth()
  return useQuery({
    queryKey: ['reports', state.report, apiFilters(state)],
    queryFn: async () => {
      const { data, meta } = await api.requestEnvelope<Report>(reportPath(state))
      return { report: data, freshness: (meta as { data_freshness?: DataFreshness }).data_freshness }
    },
    placeholderData: keepPreviousData,
  })
}

/** A browser download through a link: the session cookie goes with it, and the file keeps the server's name. */
function follow(href: string) {
  const link = document.createElement('a')
  link.href = href
  link.download = ''
  document.body.appendChild(link)
  link.click()
  link.remove()
}

export interface ReportExport {
  id: string
  report: ReportKind
  format: ReportFormat
  status: 'queued' | 'running' | 'ready' | 'failed' | 'expired'
  rows: number | null
  size_bytes: number | null
  error: string | null
  created_at: string
  expires_at: string | null
  url: string | null
}

/**
 * Downloads the report as CSV, Excel or PDF, built by the server. The session is checked first (GET /auth/me renews
 * a lapsed access token, as every request does), then the browser follows a download link to the file. A link, not
 * fetch(): a browser may take a PDF response for its viewer or a download before a script can read it. A report over
 * 20,000 rows is asked for once by fetch: the server answers 202 with an export to wait for (useExport).
 */
export function useDownloadReport() {
  const { api } = useAuth()
  return useMutation({
    mutationFn: async ({ state, format, rows }: { state: ScreenState; format: ReportFormat; rows: number }): Promise<ReportExport | null> => {
      if (rows > BACKGROUND_ROWS) return (await api.requestEnvelope<ReportExport>(reportPath(state, format))).data
      await api.request('/auth/me')
      follow(`${API_BASE}${reportPath(state, format)}`)
      return null
    },
  })
}

/** A background export, asked again every few seconds until it is ready or failed. */
export function useExport(id: string | null) {
  const { api } = useAuth()
  return useQuery({
    queryKey: ['reports', 'exports', id],
    enabled: id !== null,
    queryFn: () => api.request<ReportExport>(`/reports/exports/${id}`),
    refetchInterval: (q) => (q.state.data && q.state.data.status !== 'queued' && q.state.data.status !== 'running' ? false : 3000),
  })
}

/** Opens a ready export's signed link (the API's path, under the same origin). */
export const openExport = (e: ReportExport) => e.url && follow(`${API_BASE}${e.url.replace(/^\/api\/v1/, '')}`)

// Saved filters ---------------------------------------------------------------------------------------------------

export interface SavedFilter {
  id: string
  name: string
  filters: Record<string, string>
  created_at: string
}

export function useSavedFilters() {
  const { api } = useAuth()
  return useQuery({ queryKey: ['reports', 'filters'], queryFn: () => api.request<SavedFilter[]>('/reports/filters') })
}

export function useSaveFilter() {
  const { api } = useAuth()
  const client = useQueryClient()
  return useMutation({
    mutationFn: (body: { name: string; filters: Record<string, unknown> }) => api.request<SavedFilter>('/reports/filters', { method: 'POST', json: body }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['reports', 'filters'] }),
  })
}

export function useDeleteFilter() {
  const { api } = useAuth()
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.request<void>(`/reports/filters/${id}`, { method: 'DELETE' }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['reports', 'filters'] }),
  })
}

// Schedules -------------------------------------------------------------------------------------------------------

export type Frequency = 'daily' | 'weekly' | 'monthly'

export interface Person {
  id: string
  name: string
}

export interface Schedule {
  id: string
  name: string
  report: ReportKind
  filters: Record<string, unknown>
  format: ReportFormat
  frequency: Frequency
  day: number | null
  hour: number
  recipients: Person[]
  owner: Person | null
  next_run_at: string
  version: number
  created_at: string
}

export interface ScheduleInput {
  name: string
  report: ReportKind
  filters: Record<string, unknown>
  format: ReportFormat
  frequency: Frequency
  day: number | null
  hour: number
  recipients: string[]
}

export interface ScheduleRun {
  id: string
  due_at: string
  period: { from: string; to: string }
  status: 'running' | 'sent' | 'partial' | 'failed' | 'retrying'
  attempts: number
  next_attempt_at: string | null
  rows: number | null
  size_bytes: number | null
  error: string | null
  recipients: { user: Person | null; outcome: 'sent' | 'skipped' | 'failed'; reason: string | null; delivered: 'attached' | 'link' | null }[]
  started_at: string
  finished_at: string | null
}

const schedulesKey = ['reports', 'schedules'] as const

export function useSchedules() {
  const { api } = useAuth()
  return useQuery({ queryKey: schedulesKey, queryFn: () => api.request<Schedule[]>('/reports/schedules') })
}

export function useSaveSchedule() {
  const { api } = useAuth()
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string | null; input: ScheduleInput }) =>
      api.request<Schedule>(id ? `/reports/schedules/${id}` : '/reports/schedules', { method: id ? 'PATCH' : 'POST', json: input }),
    onSuccess: () => void client.invalidateQueries({ queryKey: schedulesKey }),
  })
}

export function useDeleteSchedule() {
  const { api } = useAuth()
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.request<void>(`/reports/schedules/${id}`, { method: 'DELETE' }),
    onSuccess: () => void client.invalidateQueries({ queryKey: schedulesKey }),
  })
}

export function useScheduleRuns(id: string | null) {
  const { api } = useAuth()
  return useQuery({ queryKey: ['reports', 'schedules', id, 'runs'], enabled: id !== null, queryFn: () => api.request<ScheduleRun[]>(`/reports/schedules/${id}/runs`) })
}

/** Who a schedule can go to: active users who read reports. */
export function useRecipients(search: string) {
  const { api } = useAuth()
  return useQuery({
    queryKey: ['reports', 'recipients', search],
    queryFn: () => api.request<(Person & { roles: string[] })[]>(`/reports/recipients?${new URLSearchParams({ search })}`),
    placeholderData: keepPreviousData,
  })
}

// Filter options --------------------------------------------------------------------------------------------------

export interface PickOption {
  id: string
  label: string
  detail?: string
}

/** Vehicles, drivers or routes matching what was typed, for a filter's search (20 at most). */
export function usePickOptions(kind: 'vehicles' | 'drivers' | 'routes', search: string, enabled: boolean) {
  const { api } = useAuth()
  return useQuery({
    queryKey: ['reports', 'options', kind, search],
    enabled,
    placeholderData: keepPreviousData,
    queryFn: async (): Promise<PickOption[]> => {
      const q = new URLSearchParams({ page_size: '20' })
      if (search.trim()) q.set('search', search.trim())
      if (kind === 'vehicles') {
        const rows = await api.request<{ id: string; registration_number: string; make?: string; model?: string; depot?: { name?: string } | null }[]>(`/vehicles?${q}`)
        return rows.map((v) => ({ id: v.id, label: v.registration_number, detail: [v.make, v.model].filter(Boolean).join(' ') || undefined }))
      }
      if (kind === 'drivers') {
        const rows = await api.request<{ id: string; full_name: string; license_number?: string }[]>(`/drivers?${q}`)
        return rows.map((d) => ({ id: d.id, label: d.full_name }))
      }
      const rows = await api.request<{ id: string; name: string; origin_name?: string; destination_name?: string }[]>(`/routes?${q}`)
      return rows.map((r) => ({ id: r.id, label: r.name, detail: r.origin_name && r.destination_name ? `${r.origin_name} to ${r.destination_name}` : undefined }))
    },
  })
}

import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import { API_BASE } from '@/lib/api/client'
import { currentMonth, shiftMonth, type Month } from '@/lib/month'

// Monthly reports (FMS-91, S-28): GET /reports/{report} as JSON for the preview, and the same table as CSV or PDF
// to download. analytics:read, in the caller's depot scope; read from the reporting copy of the database.

export type ReportKind = 'fuel' | 'maintenance' | 'cost' | 'trips' | 'drivers'
export type ReportFormat = 'csv' | 'pdf'

/** How a column's values are kept: litres in ml, etb in cents, km in metres, l_per_100km in ml per km, hours in minutes. */
export type ColumnKind = 'text' | 'count' | 'litres' | 'etb' | 'km' | 'l_per_100km' | 'pct' | 'hours' | 'datetime'

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

export interface Report {
  report: ReportKind
  title: string
  month: Month
  depot: { id: string; name: string; code: string } | null
  columns: ReportColumn[]
  rows: ReportRow[]
  /** Sums and overall ratios; null with no rows. */
  totals: ReportRow | null
  generated_at: string
}

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
    description: 'Repairs each vehicle had done, by type, with labour and cost, and the work still open when the month ended.',
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
    description: 'Every trip due to start in the month: route, vehicle, driver, when it ran, how far, and whether it ended on time.',
    empty: 'No trip was scheduled',
  },
  {
    value: 'drivers',
    label: 'Driver performance',
    description: 'Each driver’s completed trips, km and hours behind the wheel, punctuality, speeding and idling flags, and incidents.',
    empty: 'No driver completed a trip, was flagged or had an incident',
  },
]

const KINDS = REPORT_OPTIONS.map((o) => o.value)

export interface ScreenState {
  report: ReportKind
  month: Month
  depotId: string
}

/** The screen's state from its address: fuel, last month (the last whole one) and every depot unless chosen. */
export function readState(params: URLSearchParams, now = new Date()): ScreenState {
  const report = KINDS.find((k) => k === params.get('report')) ?? 'fuel'
  const asked = params.get('month') ?? ''
  const latest = currentMonth(now)
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(asked) && asked <= latest ? asked : shiftMonth(latest, -1)
  return { report, month, depotId: params.get('depot') ?? '' }
}

export function writeState(state: ScreenState, now = new Date()): URLSearchParams {
  const params = new URLSearchParams()
  if (state.report !== 'fuel') params.set('report', state.report)
  if (state.month !== shiftMonth(currentMonth(now), -1)) params.set('month', state.month)
  if (state.depotId) params.set('depot', state.depotId)
  return params
}

function reportPath(state: ScreenState, format?: ReportFormat): string {
  const q = new URLSearchParams({ month: state.month })
  if (state.depotId) q.set('depot_id', state.depotId)
  if (format) q.set('format', format)
  return `/reports/${state.report}?${q}`
}

/** The report for the preview, with how current its data is. */
export function useReport(state: ScreenState) {
  const { api } = useAuth()
  return useQuery({
    queryKey: ['reports', state.report, state.month, state.depotId],
    queryFn: async () => {
      const { data, meta } = await api.requestEnvelope<Report>(reportPath(state))
      return { report: data, freshness: (meta as { data_freshness?: DataFreshness }).data_freshness }
    },
    placeholderData: keepPreviousData,
  })
}

/**
 * Downloads the report as CSV or PDF, built by the server. The session is checked first (GET /auth/me renews a
 * lapsed access token, as every request does), then the browser follows a download link to the file, sending the
 * session cookie and saving it under the server's name. A link, not fetch(): a browser may take a PDF response for
 * its viewer or a download before a script can read it.
 */
export function useDownloadReport() {
  const { api } = useAuth()
  return useMutation({
    mutationFn: async ({ state, format }: { state: ScreenState; format: ReportFormat }) => {
      await api.request('/auth/me')
      const link = document.createElement('a')
      link.href = `${API_BASE}${reportPath(state, format)}`
      link.download = ''
      document.body.appendChild(link)
      link.click()
      link.remove()
    },
  })
}

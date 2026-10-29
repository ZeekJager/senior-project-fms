import { formatMinor } from '@/components/shared'
import type { BadgeTone } from '@/components/ui'
import type { CsvCell } from '@/lib/csv'
import type { FuelAnomaly, Mark, ReconciliationRow } from './api'
import { markOf, monthLabel } from './api'

/** "+25%", "−30%", "0%": the sign always shown, a true minus. */
export function signedPct(pct: number | null): string {
  if (pct === null) return '—'
  if (pct === 0) return '0%'
  return `${pct > 0 ? '+' : '−'}${Math.abs(pct)}%`
}

/** "42.50 L" from integer ml, or a dash. */
export const litres = (ml: number | null, decimals: 2 | 3 = 2) => (ml === null || !Number.isSafeInteger(ml) ? '—' : `${formatMinor(ml, 3, decimals)} L`)

/** "ETB 3,800.50" from integer cents. */
export const birr = (cents: number) => `ETB ${formatMinor(cents, 2)}`

export const MARKS: Record<Mark, { label: string; tone: BadgeTone }> = {
  flag: { label: 'Flag', tone: 'danger' },
  watch: { label: 'Watch', tone: 'warning' },
  ok: { label: 'OK', tone: 'success' },
  not_judged: { label: 'Not judged', tone: 'neutral' },
}

/** What each mark means, with the threshold in force. */
export function markHint(mark: Mark, thresholdPct: number): string {
  const watch = Math.round(thresholdPct / 2)
  switch (mark) {
    case 'flag':
      return `More than ${thresholdPct}% over or under what the trips needed: a fuel anomaly`
    case 'watch':
      return `Between ${watch}% and ${thresholdPct}% off`
    case 'ok':
      return `Within ${watch}% of what the trips needed`
    case 'not_judged':
      return 'Electric, no rated consumption, or under 100 km of trips'
  }
}

const REASONS = {
  electric: 'Electric',
  no_efficiency: 'No rated consumption',
  too_little_distance: 'Under 100 km of trips',
} as const

/** Why a row has no variance, in words. */
export const reasonLabel = (row: Pick<ReconciliationRow, 'reason'>) => (row.reason ? REASONS[row.reason] : '')

/** "Fuel 25% over expected", "Fuel 30% under expected", or the type in words for a per-fill-up rule. */
export function anomalyTitle(a: Pick<FuelAnomaly, 'anomaly_type' | 'deviation_pct'>): string {
  const pct = a.deviation_pct === null ? '' : ` ${Math.abs(a.deviation_pct)}%`
  if (a.anomaly_type === 'consumption_above_expected') return `Fuel${pct} over expected`
  if (a.anomaly_type === 'consumption_below_expected') return `Fuel${pct} under expected`
  const words = a.anomaly_type.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** "September 2026" for a reconciliation's month (period_from is its first midnight, Addis Ababa). */
export function anomalyPeriod(a: Pick<FuelAnomaly, 'period_from'>): string | null {
  if (!a.period_from) return null
  return monthLabel(new Date(Date.parse(a.period_from) + 3 * 3_600_000).toISOString().slice(0, 7))
}

const TZ = 'Africa/Addis_Ababa'

/** "1 Oct 2026". */
export const formatDay = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' })

/** "14:05", or "14:05:09" when seconds matter. */
export const formatTime = (iso: string, seconds = false) =>
  new Date(iso).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) })

export const CSV_HEADERS = [
  'Plate',
  'Depot',
  'Fuel type',
  'Rated (ml/km)',
  'Distance (km)',
  'Trips',
  'Fill-ups',
  'Expected (L)',
  'Actual (L)',
  'Variance (L)',
  'Variance (%)',
  'Cost (ETB)',
  'Mark',
  'Not judged because',
] as const

/** One row of the export: litres to the millilitre and birr to the cent, from the integers, never rounded. */
export function csvRow(row: ReconciliationRow, thresholdPct: number): CsvCell[] {
  const l = (ml: number | null) => (ml === null ? '' : formatMinor(ml, 3, 3, { group: false }))
  return [
    row.registration_number,
    row.depot_name,
    row.fuel_type,
    row.fuel_efficiency_ml_per_km,
    row.distance_km,
    row.trips,
    row.fuel_logs,
    l(row.expected_ml),
    l(row.actual_ml),
    l(row.variance_ml),
    row.variance_pct,
    formatMinor(row.total_cost_cents, 2, 2, { group: false }),
    MARKS[markOf(row, thresholdPct)].label,
    reasonLabel(row),
  ]
}

import type { BadgeTone } from '@/components/ui'
import type { CsvCell } from '@/lib/csv'
import { COMPONENT_LABELS, DETECTION_LABELS, MODE_LABELS, type FailureComponent, type FailureDetection, type FailureMode } from '@/pages/Maintenance/failures'
import { TYPE_LABELS, type MaintenanceType } from '@/pages/Maintenance/api'
import { DOWNTIME_REASONS, monthWindow, type DowntimePeriod, type DowntimeReason, type SortKey, type VehicleAvailability } from './api'

/** Each reason in words (docs/downtime.md); unplanned ones count as failures in MTBF and MTTR. */
export const REASONS: Record<DowntimeReason, { label: string; unplanned: boolean; tone: BadgeTone }> = {
  planned_service: { label: 'Planned service', unplanned: false, tone: 'info' },
  unplanned_repair: { label: 'Unplanned repair', unplanned: true, tone: 'warning' },
  breakdown: { label: 'Breakdown', unplanned: true, tone: 'danger' },
  accident: { label: 'Accident', unplanned: true, tone: 'danger' },
  awaiting_parts: { label: 'Awaiting parts', unplanned: false, tone: 'neutral' },
  other: { label: 'Other', unplanned: false, tone: 'neutral' },
}

/** "84 h", "1,240 h", "45 min": a month's downtime, in hours once there is an hour of it. */
export function hours(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  const h = minutes / 60
  return `${h.toLocaleString('en-US', { maximumFractionDigits: h < 10 ? 1 : 0 })} h`
}

/** "45 min", "5 h 20 min", "3 d 12 h": a length of time, in the largest units that read well. */
export function span(minutes: number | null): string {
  if (minutes === null) return '—'
  if (minutes < 60) return `${minutes} min`
  if (minutes < 24 * 60) {
    const m = minutes % 60
    return m === 0 ? `${Math.floor(minutes / 60)} h` : `${Math.floor(minutes / 60)} h ${m} min`
  }
  const totalHours = Math.round(minutes / 60)
  const d = Math.floor(totalHours / 24)
  const h = totalHours % 24
  return h === 0 ? `${d} d` : `${d} d ${h} h`
}

/** "88.3%", or a dash with no time in the fleet. */
export const pct = (value: number | null) => (value === null ? '—' : `${value.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`)

/** The reason with the most minutes, or null when the vehicle was never down. */
export function mainReason(row: Pick<VehicleAvailability, 'downtime_by_reason'>): DowntimeReason | null {
  let best: DowntimeReason | null = null
  for (const r of DOWNTIME_REASONS) if ((row.downtime_by_reason[r] ?? 0) > 0 && (best === null || row.downtime_by_reason[r] > row.downtime_by_reason[best])) best = r
  return best
}

const SORT_VALUE: Record<Exclude<SortKey, 'plate'>, (r: VehicleAvailability) => number | null> = {
  downtime: (r) => r.downtime_minutes,
  availability: (r) => r.availability_pct,
  failures: (r) => r.failures,
  mtbf: (r) => r.mtbf_minutes,
  mttr: (r) => r.mttr_minutes,
}

/** Sorted by a column, ties by plate; a vehicle with no figure (no failure for MTBF, say) always last. */
export function sortRows(rows: readonly VehicleAvailability[], key: SortKey, order: 'asc' | 'desc'): VehicleAvailability[] {
  const dir = order === 'asc' ? 1 : -1
  const byPlate = (a: VehicleAvailability, b: VehicleAvailability) => a.registration_number.localeCompare(b.registration_number)
  if (key === 'plate') return [...rows].sort((a, b) => dir * byPlate(a, b))
  const value = SORT_VALUE[key]
  return [...rows].sort((a, b) => {
    const [x, y] = [value(a), value(b)]
    if (x === null || y === null) return x === y ? byPlate(a, b) : x === null ? 1 : -1
    return dir * (x - y) || byPlate(a, b)
  })
}

const TZ = 'Africa/Addis_Ababa'
const dayTime = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

/** "5 Sep, 08:00". */
export const when = (iso: string) => dayTime.format(new Date(iso))

/** The minutes of a period inside the month: a period may begin before it, or still be going on. */
export function minutesInMonth(period: Pick<DowntimePeriod, 'started_at' | 'ended_at'>, month: string, now = new Date()): number {
  const { from, to } = monthWindow(month)
  const start = Math.max(Date.parse(period.started_at), Date.parse(from))
  const end = Math.min(period.ended_at ? Date.parse(period.ended_at) : now.getTime(), Date.parse(to), now.getTime())
  return Math.max(0, Math.round((end - start) / 60_000))
}

/** What began a period that has no work order or failure behind it. */
export function openedByLabel(period: Pick<DowntimePeriod, 'opened_by'>): string {
  switch (period.opened_by) {
    case 'breakdown':
      return 'A breakdown'
    case 'registration':
      return 'Registered out of service'
    case 'status_change':
      return 'Status set by hand'
  }
}

/** "Repair: Radiator leak on the Adama road", from the work order behind a period. */
export function recordLabel(record: NonNullable<DowntimePeriod['maintenance_record']>): string {
  const type = TYPE_LABELS[record.maintenance_type as MaintenanceType] ?? record.maintenance_type
  return record.description ? `${type}: ${record.description}` : type
}

/** "Cooling: Leak", and how it was found ("Breakdown on the road"). */
export function failureLabel(failure: NonNullable<DowntimePeriod['failure']>): { what: string; found: string } {
  const component = COMPONENT_LABELS[failure.component as FailureComponent] ?? failure.component
  const mode = MODE_LABELS[failure.failure_mode as FailureMode] ?? failure.failure_mode
  return { what: `${component}: ${mode}`, found: DETECTION_LABELS[failure.detected_by as FailureDetection] ?? failure.detected_by }
}

export const CSV_HEADERS = [
  'Plate',
  'Depot',
  'Status',
  'Availability (%)',
  'In fleet (h)',
  'Downtime (h)',
  'Unplanned downtime (h)',
  'Failures',
  'MTBF (h)',
  'Repairs',
  'MTTR (h)',
  ...DOWNTIME_REASONS.map((r) => `${REASONS[r].label} (h)`),
] as const

/** Hours to two decimals from the API's whole minutes: exact to the minute, as a spreadsheet wants. */
const h2 = (minutes: number | null) => (minutes === null ? '' : (minutes / 60).toFixed(2))

export function csvRow(row: VehicleAvailability): CsvCell[] {
  return [
    row.registration_number,
    row.depot_name,
    row.status,
    row.availability_pct,
    h2(row.in_fleet_minutes),
    h2(row.downtime_minutes),
    h2(row.unplanned_downtime_minutes),
    row.failures,
    h2(row.mtbf_minutes),
    row.repairs,
    h2(row.mttr_minutes),
    ...DOWNTIME_REASONS.map((r) => h2(row.downtime_by_reason[r] ?? 0)),
  ]
}

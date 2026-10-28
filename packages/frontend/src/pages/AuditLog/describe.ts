import { formatMinor } from '@/components/shared'
import { formatDuration } from '@/pages/VehicleHistory/format'

// How an audit entry reads on S-10 (FMS-29): what happened, to which record, and which fields changed,
// with money in ETB, fuel in litres and times in Addis Ababa. Values arrive as stored (api-contract §5.2).

export type AuditActor =
  | { type: 'user'; id: string | null; full_name: string | null; email: string | null }
  | { type: 'system' }
  | { type: 'anonymous' }

/** One row of GET /audit-logs. */
export interface AuditEntry {
  id: string
  occurred_at: string
  action: string
  result: 'success' | 'denied' | 'failed' | null
  actor: AuditActor
  entity_type: string | null
  entity_id: string | null
  correlation_id: string
  request_source: Record<string, unknown> | null
  old_values: Record<string, unknown> | null
  new_values: Record<string, unknown> | null
  details: Record<string, unknown>
}

const ACTIONS: Record<string, string> = {
  INSERT: 'Created',
  UPDATE: 'Updated',
  DELETE: 'Deleted',
  ROLE_CHANGE: 'Roles changed',
  'auth.login_succeeded': 'Signed in',
  'auth.login_failed': 'Sign-in failed',
  'auth.login_throttled': 'Sign-in blocked: too many attempts',
  'auth.logout': 'Signed out',
  'auth.refresh_reuse_detected': 'Session token reused',
  'auth.password_set': 'Password set',
  'access.denied': 'Access denied',
  'job.started': 'Job started',
  'job.succeeded': 'Job finished',
  'job.failed': 'Job failed',
  'tracking.pings_ingested': 'GPS positions received',
  'alert.notified': 'Alert sent',
  'notification.read_all': 'Notifications read',
}

/** "Updated", "Signed in"; an action without a name of its own reads as its words ("stock.adjusted" is "Stock adjusted"). */
export function actionLabel(action: string): string {
  if (ACTIONS[action]) return ACTIONS[action]
  const words = action.replace(/[._]/g, ' ').trim().toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** The audited tables, by what their rows are: [singular, plural]. The plural names the table filter. */
export const TABLES: Record<string, [string, string]> = {
  'fleet.vehicles': ['Vehicle', 'Vehicles'],
  'fleet.drivers': ['Driver', 'Drivers'],
  'fleet.depots': ['Depot', 'Depots'],
  'fleet.driver_attendance': ['Attendance record', 'Attendance'],
  'fleet.dvir_reports': ['Inspection', 'Inspections'],
  'fleet.meter_readings': ['Meter reading', 'Meter readings'],
  'fleet.vehicle_status_history': ['Status change', 'Vehicle status changes'],
  'trip.trips': ['Trip', 'Trips'],
  'trip.routes': ['Route', 'Routes'],
  'fuel.fuel_logs': ['Fuel log', 'Fuel logs'],
  'maintenance.maintenance_records': ['Repair', 'Repairs and services'],
  'maintenance.inventory_parts': ['Spare part', 'Spare parts'],
  'maintenance.inventory_movements': ['Stock movement', 'Stock movements'],
  'maintenance.failure_events': ['Failure record', 'Failure records'],
  'maintenance.maintenance_predictions': ['Health prediction', 'Health predictions'],
  'maintenance.ml_models': ['ML model', 'ML models'],
  'document.documents': ['Document', 'Documents'],
  'alert.alerts': ['Alert', 'Alerts'],
  'alert.incident_reports': ['Incident', 'Incidents'],
  'alert.notifications': ['Notification', 'Notifications'],
  'auth.users': ['User account', 'User accounts'],
  'auth.user_roles': ['Role assignment', 'Role assignments'],
  'auth.password_tokens': ['Password link', 'Password links'],
  'integration.gps_devices': ['GPS device', 'GPS devices'],
  'tracking.gps_pings': ['GPS positions', 'GPS positions'],
  'jobs.job_runs': ['Job run', 'Job runs'],
}

/** "Vehicle"; an unknown table reads as its own name. */
export function tableLabel(entityType: string | null): string | null {
  if (!entityType) return null
  return TABLES[entityType]?.[0] ?? entityType
}

// The fields that name a record, most telling first.
const NAMES = ['registration_number', 'full_name', 'name', 'email', 'part_number', 'title', 'original_filename', 'code', 'version'] as const

/** What the record is called in its values ("AA 3-12345", "Hanna Tesfaye"), or null. */
export function recordName(entry: Pick<AuditEntry, 'old_values' | 'new_values'>): string | null {
  for (const key of NAMES) {
    const value = entry.new_values?.[key] ?? entry.old_values?.[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return null
}

export interface ChangedField {
  key: string
  label: string
  /** Undefined: the field did not exist before (a record created) or after (a record deleted). */
  before: unknown
  after: unknown
}

/** A stable text form for comparing values: object keys sorted, so the same object always reads the same. */
function canonical(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(object[k])}`)
    .join(',')}}`
}

/**
 * The fields the entry changed, and only those (FMS-29): on an update, each field whose value differs before
 * and after; on a create, each field it was given; on a delete, each field it had. The record's own id is shown
 * apart, never as a change.
 */
export function changedFields(entry: Pick<AuditEntry, 'old_values' | 'new_values'>): ChangedField[] {
  const before = entry.old_values
  const after = entry.new_values
  if (!before && !after) return []
  // The stored order is the database's (by key length), not a reading order: the record's name first, then A to Z, times last.
  const rank = (key: string) => ((NAMES as readonly string[]).includes(key) ? 0 : key.endsWith('_at') ? 2 : 1)
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])]
    .filter((k) => k !== 'public_id')
    .sort((a, b) => rank(a) - rank(b) || fieldLabel(a).localeCompare(fieldLabel(b)))
  return keys
    .map((key) => ({ key, label: fieldLabel(key), before: before ? (before[key] ?? null) : undefined, after: after ? (after[key] ?? null) : undefined }))
    .filter((f) => {
      if (!before) return f.after !== null
      if (!after) return f.before !== null
      return canonical(f.before) !== canonical(f.after)
    })
}

const FIELD_LABELS: Record<string, string> = {
  odometer_km: 'Odometer',
  fuel_efficiency_ml_per_km: 'Fuel efficiency',
  quantity_ml: 'Quantity',
  is_active: 'Active',
  vin: 'VIN',
}

/** "Total cost" for total_cost_cents, "Completed at" for completed_at: the unit shows in the value instead. */
export function fieldLabel(key: string): string {
  if (FIELD_LABELS[key]) return FIELD_LABELS[key]
  const words = key
    .replace(/_(cents|ml|seconds)$/, '')
    .replace(/_/g, ' ')
    .trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

const TZ = 'Africa/Addis_Ababa'
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** "28 Oct 2026, 14:05:09", Addis Ababa. */
export function formatInstant(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

// Fields whose number has a unit. Big integers and decimals reach the trail as text ("57220"), read as numbers here.
const UNIT_FIELD = /(_cents|_ml|_km|_seconds|_ms)$|^fuel_efficiency_ml_per_km$/
const NUMBER_TEXT = /^-?\d+(\.\d+)?$/

/** The value as text, in its unit: integer cents as ETB, millilitres as litres, km, durations, times in Addis Ababa. */
export function formatValue(key: string, value: unknown): string {
  if (typeof value === 'string' && UNIT_FIELD.test(key) && NUMBER_TEXT.test(value)) return formatValue(key, Number(value))
  if (value === null || value === undefined || value === '') return '—'
  if (value === '[REDACTED]') return 'Hidden'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'number') {
    if (key.endsWith('_cents') && Number.isSafeInteger(value)) return `ETB ${formatMinor(value, 2)}`
    // ml per km × 100 / 1000 = litres per 100 km.
    if (key === 'fuel_efficiency_ml_per_km' && Number.isSafeInteger(value)) return `${formatMinor(value, 1)} L/100 km`
    if (key.endsWith('_ml') && Number.isSafeInteger(value)) return `${formatMinor(value, 3, 2)} L`
    if (key.endsWith('_km')) return `${value.toLocaleString('en-US', { maximumFractionDigits: 1 })} km`
    if (key.endsWith('_seconds')) return formatDuration(value)
    if (key.endsWith('_ms')) return `${value.toLocaleString('en-US')} ms`
    return value.toLocaleString('en-US', { maximumFractionDigits: 6 })
  }
  if (typeof value === 'string') {
    if (ISO_INSTANT.test(value) && !Number.isNaN(Date.parse(value))) return formatInstant(value)
    if (ISO_DATE.test(value)) return new Date(`${value}T12:00:00Z`).toLocaleDateString('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' })
    return value
  }
  if (Array.isArray(value) && value.every((v) => v === null || typeof v !== 'object')) return value.length ? value.map((v) => formatValue(key, v)).join(', ') : 'None'
  return JSON.stringify(value, null, 2)
}

/** Whether formatValue gives a block of JSON, which reads better set apart than in a sentence. */
export const isStructured = (value: unknown): boolean =>
  value !== null && typeof value === 'object' && !(Array.isArray(value) && value.every((v) => v === null || typeof v !== 'object'))

/**
 * "Hanna Tesfaye", "Scheduled job", "Not signed in". A sign-in event without a user was someone not signed in;
 * any other entry without one was written by the system itself (an event consumer, the seed).
 */
export function actorName(actor: AuditActor, action = ''): string {
  if (actor.type === 'system') return 'Scheduled job'
  if (actor.type === 'anonymous') return /^(auth|access)\./.test(action) ? 'Not signed in' : 'System'
  return actor.full_name ?? actor.email ?? 'Deleted account'
}

/** One line under an entry: which fields changed, or what its details count. */
export function summary(entry: AuditEntry): string | null {
  const fields = changedFields(entry)
  if (entry.action === 'UPDATE' || entry.action === 'ROLE_CHANGE') {
    if (fields.length === 0) return 'No field changed'
    const names = fields.slice(0, 4).map((f) => f.label.toLowerCase())
    return `${names.join(', ')}${fields.length > 4 ? ` and ${fields.length - 4} more` : ''}`
  }
  if (entry.action === 'INSERT') return fields.length ? `${fields.length} ${fields.length === 1 ? 'field' : 'fields'} set` : null
  const job = entry.details.job
  if (typeof job === 'string') return job
  if (typeof entry.details.accepted === 'number') return `${entry.details.accepted.toLocaleString('en-US')} accepted`
  const email = entry.details.email
  return typeof email === 'string' ? email : null
}

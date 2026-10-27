import { CALENDAR_KEY, getPreference, type CalendarSystem } from '@/lib/preferences'

// The health score (FMS-55, FMS-56): round((1 - p) * 100), where p is the chance of an unplanned
// breakdown within 30 days. Set every night by the scoring job; never by hand.

/** As the API's `health` filter (fleet HEALTH_BANDS): below 75 at risk (the alert line), 75-84 watch, 85 and up healthy. */
export const AT_RISK_BELOW = 75
export const HEALTHY_FROM = 85
/** A score older than this is stale: the night's scoring did not reach the vehicle. */
export const STALE_AFTER_HOURS = 25

export type HealthBand = 'at_risk' | 'watch' | 'healthy'
export type HealthView = HealthBand | 'stale' | 'unscored'
export type RiskLevel = 'low' | 'medium' | 'high'

export const BAND_LABELS: Record<HealthView, string> = {
  at_risk: 'At risk',
  watch: 'Watch',
  healthy: 'Healthy',
  stale: 'Stale',
  unscored: 'Not scored',
}

export const RISK_LABELS: Record<RiskLevel, string> = { high: 'High risk', medium: 'Medium risk', low: 'Low risk' }

export function bandOf(score: number): HealthBand {
  if (score < AT_RISK_BELOW) return 'at_risk'
  return score < HEALTHY_FROM ? 'watch' : 'healthy'
}

export function isStale(updatedAt: string | null, now: number = Date.now()): boolean {
  return updatedAt !== null && now - Date.parse(updatedAt) > STALE_AFTER_HOURS * 3_600_000
}

/** Which view a vehicle's score falls in, as the badge shows it: a stale score is stale whatever its value. */
export function healthViewOf(score: number | null, updatedAt: string | null, now: number = Date.now()): HealthView {
  if (score === null) return 'unscored'
  return isStale(updatedAt, now) ? 'stale' : bandOf(score)
}

/** GET /vehicles/{id}/maintenance-risk (api-contract §10.2). */
export interface RiskFactor {
  feature: string
  value: number | null
  unit: string | null
}

export interface MaintenanceRisk {
  vehicle_id: string
  prediction_id: string | null
  health_score: number | null
  risk_level: RiskLevel | null
  failure_probability: number | null
  prediction_horizon_days: number | null
  factors: RiskFactor[]
  model_name: string | null
  model_version: string | null
  as_of: string | null
  scored_at: string | null
  stale: boolean
}

/** The model's inputs (packages/ai-service/feature_spec.json), as a technician reads them. */
const FEATURE_LABELS: Record<string, string> = {
  mileage_km: 'Distance driven, last 30 days',
  engine_hours: 'Engine hours, last 30 days',
  days_since_last_service: 'Time since last service',
  num_fault_reports: 'Faults reported, last 90 days',
  fuel_variance_pct: 'Fuel use against expected',
  age_years: 'Vehicle age',
  days_since_oil_change: 'Time since oil change',
  km_since_oil_change: 'Distance since oil change',
  km_since_air_filter_change: 'Distance since air filter change',
  km_since_fuel_filter_change: 'Distance since fuel filter change',
  days_since_coolant_change: 'Time since coolant change',
  km_since_brake_pad_change: 'Distance since brake pad change',
  days_since_brake_fluid_change: 'Time since brake fluid change',
  days_since_clutch_fluid_change: 'Time since clutch fluid change',
  km_since_tyre_change: 'Distance since tyre change',
  days_since_tyre_change: 'Time since tyre change',
  days_since_battery_change: 'Time since battery change',
  km_since_gearbox_oil_change: 'Distance since gearbox oil change',
  km_since_belt_change: 'Distance since belt change',
}

export function featureLabel(feature: string): string {
  return FEATURE_LABELS[feature] ?? feature.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
}

const whole = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 })
const oneDecimal = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 })

/** The vehicle's value of an input, in words: "100 days", "17,380 km", "+3.1%", "7.9 years". */
export function formatFactorValue(value: number | null, unit: string | null): string {
  if (value === null) return '—'
  switch (unit) {
    case 'd':
      return `${whole.format(value)} ${value === 1 ? 'day' : 'days'}`
    case 'km':
      return `${whole.format(value)} km`
    case 'h':
      return `${oneDecimal.format(value)} h`
    case '%':
      return `${value > 0 ? '+' : ''}${oneDecimal.format(value)}%`
    case 'years':
      return `${oneDecimal.format(value)} ${value === 1 ? 'year' : 'years'}`
    default:
      return whole.format(value)
  }
}

/** "25 Oct, 02:00" in Addis Ababa, in the user's calendar (Help: calendar). */
export function formatScoredAt(iso: string): string {
  const ethiopic = getPreference<CalendarSystem>(CALENDAR_KEY, 'gregorian') === 'ethiopic'
  return new Date(iso).toLocaleString(ethiopic ? 'en-u-ca-ethiopic' : 'en-GB', {
    timeZone: 'Africa/Addis_Ababa',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** "3 h ago", "2 days ago": how old a score is. */
export function formatAge(iso: string, now: number = Date.now()): string {
  const hours = Math.max(0, Math.floor((now - Date.parse(iso)) / 3_600_000))
  if (hours < 1) return 'just now'
  if (hours < 48) return `${hours} h ago`
  return `${Math.floor(hours / 24)} days ago`
}

import type { BadgeTone } from '@/components/ui'
import type { FuelType, ServiceDue, ServiceDueStatus, ServiceMeasure, ServiceProgram, VehicleType } from './api'

// How service programs and service due read on screen (FMS-129).

export const STATUS_LABELS: Record<ServiceDueStatus, string> = { upcoming: 'Upcoming', due: 'Due', overdue: 'Overdue' }
export const STATUS_TONES: Record<ServiceDueStatus, BadgeTone> = { upcoming: 'neutral', due: 'warning', overdue: 'danger' }

export const VEHICLE_TYPE_LABELS: Record<VehicleType, string> = {
  car: 'Cars',
  suv: 'SUVs',
  van: 'Vans',
  truck: 'Trucks',
  bus: 'Buses',
  motorcycle: 'Motorcycles',
  other: 'Other vehicles',
}

export const FUEL_TYPE_LABELS: Record<FuelType, string> = {
  petrol: 'Petrol',
  diesel: 'Diesel',
  hybrid: 'Hybrid',
  electric: 'Electric',
  cng: 'CNG',
  lpg: 'LPG',
  other: 'Other fuel',
}

/** Roles that see every depot (the API's DEPOT_UNSCOPED_ROLES): only they define fleet-wide programs. */
const UNSCOPED_ROLES = ['admin', 'fleet_manager', 'fleet_owner', 'compliance_officer']
export const seesEveryDepot = (roles: readonly string[]) => roles.some((r) => UNSCOPED_ROLES.includes(r))

const number = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 1 })
const plural = (n: number, one: string, many: string) => `${number(n)} ${n === 1 ? one : many}`

/** "in 400 km", "1,200 km over"; "in 3 days", "today", "2 days over"; "in 25 engine hours". */
export function measureText(measure: ServiceMeasure, remaining: number): string {
  if (measure === 'days') {
    if (remaining === 0) return 'today'
    return remaining > 0 ? `in ${plural(remaining, 'day', 'days')}` : `${plural(-remaining, 'day', 'days')} over`
  }
  const unit = measure === 'km' ? 'km' : 'engine hours'
  const unitOne = measure === 'km' ? 'km' : 'engine hour'
  return remaining >= 0 ? `in ${plural(remaining, unitOne, unit)}` : `${plural(-remaining, unitOne, unit)} over`
}

/**
 * What a service due says at a glance: the measures that made it due or overdue, or every measure it counts
 * while upcoming. "In 400 km", "1,200 km over · 3 days over".
 */
export function dueText(d: Pick<ServiceDue, 'due_by' | 'remaining'>): string {
  const counted = (['km', 'days', 'engine_hours'] as const).filter((m) => d.remaining[m] !== null)
  const measures = d.due_by.length > 0 ? d.due_by.filter((m) => d.remaining[m] !== null) : counted
  const text = measures.map((m) => measureText(m, d.remaining[m]!)).join(' · ')
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Not measured yet'
}

/** "Every 10,000 km or 180 days, whichever comes first". */
export function intervalsText(p: Pick<ServiceProgram, 'interval_km' | 'interval_days' | 'interval_engine_hours'>): string {
  const parts = [
    p.interval_km !== null ? `${number(p.interval_km)} km` : null,
    p.interval_days !== null ? plural(p.interval_days, 'day', 'days') : null,
    p.interval_engine_hours !== null ? plural(p.interval_engine_hours, 'engine hour', 'engine hours') : null,
  ].filter((s): s is string => s !== null)
  if (parts.length === 0) return 'No interval'
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} or ${parts[parts.length - 1]}`
  return `Every ${list}${parts.length > 1 ? ', whichever comes first' : ''}`
}

/** "Due within 500 km or 14 days". */
export function leadText(p: Pick<ServiceProgram, 'lead_km' | 'lead_days' | 'lead_engine_hours'>): string {
  const parts = [
    p.lead_km !== null ? `${number(p.lead_km)} km` : null,
    p.lead_days !== null ? plural(p.lead_days, 'day', 'days') : null,
    p.lead_engine_hours !== null ? plural(p.lead_engine_hours, 'engine hour', 'engine hours') : null,
  ].filter((s): s is string => s !== null)
  return parts.length ? `Due within ${parts.join(' or ')}` : ''
}

/** Which vehicles: "Diesel trucks · Isuzu NPR", or "Every vehicle". The depot is said apart. */
export function coverageText(p: Pick<ServiceProgram, 'vehicle_type' | 'fuel_type' | 'make' | 'model'>): string {
  const fuel = p.fuel_type ? FUEL_TYPE_LABELS[p.fuel_type] : null
  const type = p.vehicle_type ? VEHICLE_TYPE_LABELS[p.vehicle_type] : null
  const vehicles = fuel && type ? `${fuel} ${type.toLowerCase()}` : fuel ? `${fuel} vehicles` : type
  const model = [p.make, p.model].filter(Boolean).join(' ')
  return [vehicles, model || null].filter(Boolean).join(' · ') || 'Every vehicle'
}

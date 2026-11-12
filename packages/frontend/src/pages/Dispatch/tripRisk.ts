import type { BoardTripRisk, DriverTripRisk, TripRiskFactor } from './types'

// The trip risk model on the console (FMS-155, docs/ml-trip-risk.md): a driver's chance of the trip running late and of a
// safety event, in words. It informs one trip's choice; it never blocks, sorts or ranks the drivers.

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

/** A chance as the console says it: whole percents, "under 1%" rather than 0%. */
export function chance(p: number): string {
  const pct = Math.round(p * 100)
  return pct < 1 ? 'under 1%' : `${pct}%`
}

const pct = (v: number) => `${Math.round(v * 100)}%`
const hours = (v: number) => `${Number.isInteger(v) ? v : v.toFixed(1)} h`

/** What each input says at its value, as a reason. The spec's input names (trip_risk_spec.json). */
const FACTOR_TEXT: Record<string, (v: number) => string> = {
  driver_trips_90d: (v) => (v === 0 ? 'no trips in the last 90 days' : `${v} trips in the last 90 days`),
  driver_late_share_90d: (v) => `late on ${pct(v)} of recent trips`,
  driver_safety_share_90d: (v) => `safety events on ${pct(v)} of recent trips`,
  driver_same_load_trips_90d: (v) => (v === 0 ? 'no similar jobs lately' : `${v} similar jobs lately`),
  driver_same_load_late_share_90d: (v) => `late on ${pct(v)} of similar jobs`,
  job_load_points: (v) => (v >= 3 ? 'a heavy job' : v >= 1 ? 'a standard job' : 'a light job'),
  planned_distance_km: (v) => `${Math.round(v)} km planned`,
  planned_duration_h: (v) => `${hours(v)} planned`,
  stops: (v) => `${v} stops`,
  night_hours: (v) => `${hours(v)} at night`,
  cargo_share: (v) => `cargo at ${pct(v)} of the payload`,
  cargo_hazardous: () => 'hazardous cargo',
  cargo_fragile: () => 'fragile cargo',
  cargo_refrigerated: () => 'refrigerated cargo',
  cargo_passengers: () => 'carrying passengers',
  start_hour: (v) => `starting at ${String(v).padStart(2, '0')}:00`,
  weekday: (v) => `on a ${WEEKDAYS[v] ?? 'weekday'}`,
  hours_since_last_trip: (v) => (v === 0 ? 'still on a trip' : `rested ${hours(v)}`),
  hours_driven_24h: (v) => `${hours(v)} driven in the last day`,
  hours_driven_7d: (v) => `${hours(v)} driven in the last week`,
  route_trips_90d: (v) => `${v} trips on this route lately`,
  route_late_share_90d: (v) => `this route late ${pct(v)} of the time`,
}

export const factorText = (f: TripRiskFactor) => FACTOR_TEXT[f.feature]?.(f.value) ?? f.feature.replaceAll('_', ' ')

/** "18% chance of running late: 12.5 h driven in the last day, 6 h at night" (the two factors that raise it most). */
export function lateLine(risk: DriverTripRisk): string {
  const why = risk.factors.late.map(factorText)
  return `${chance(risk.late_probability)} chance of running late${why.length > 0 ? `: ${why.join(', ')}` : ''}`
}

export function safetyLine(risk: DriverTripRisk): string {
  const why = risk.factors.safety_event.map(factorText)
  return `${chance(risk.safety_event_probability)} chance of a safety event${why.length > 0 ? `: ${why.join(', ')}` : ''}`
}

/**
 * The note above the drivers: a demonstration model, too few trips to learn from, or the model off. Null when the
 * chances are the fleet's own model's, with nothing to say.
 */
export function tripRiskNote(risk: BoardTripRisk | null | undefined): { tone: 'info' | 'muted'; text: string } | null {
  if (!risk) return null
  if (risk.status === 'ok') {
    return risk.demonstration
      ? { tone: 'info', text: 'Trip risk is a demonstration: the model learnt from generated trips, not this fleet’s.' }
      : null
  }
  if (risk.status === 'not_enough_trips') {
    const n = (v: number) => v.toLocaleString('en')
    return {
      tone: 'muted',
      text: `Not enough trips yet for a trip risk prediction: ${n(risk.trips)} of ${n(risk.minimum.trips)} completed trips, ${risk.drivers} of ${risk.minimum.drivers} drivers.`,
    }
  }
  if (risk.status === 'unavailable') return { tone: 'muted', text: 'Trip risk could not be predicted just now.' }
  return { tone: 'muted', text: 'Trip risk prediction is off.' }
}

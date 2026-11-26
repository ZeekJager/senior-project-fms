import type { ChargingSession, EvFleetVehicle, SessionStatus } from './api'

// What the EV dashboard (S-40, FMS-99) says about a battery and a session, apart from the page so it is tested alone.

/**
 * Below this state of charge an EV is low: the line of the battery alert (ev_low_soc_pct, FMS-98, 20 by default).
 * Below half of it, critical.
 */
export const LOW_SOC_PCT = 20

/** A reading older than this is stale: the vehicle has not reported for a day. */
export const STALE_READING_MS = 24 * 3_600_000

export type ChargeLevel = 'critical' | 'low' | 'ok' | 'unknown'

export function chargeLevel(v: Pick<EvFleetVehicle, 'latest'>, line = LOW_SOC_PCT): ChargeLevel {
  if (!v.latest) return 'unknown'
  const soc = v.latest.state_of_charge
  if (soc < line / 2) return 'critical'
  if (soc < line) return 'low'
  return 'ok'
}

export const LEVEL_TONE: Record<ChargeLevel, 'danger' | 'warning' | 'success' | 'neutral'> = {
  critical: 'danger',
  low: 'warning',
  ok: 'success',
  unknown: 'neutral',
}

export const STATUS_LABELS: Record<SessionStatus, string> = {
  planned: 'Planned',
  in_progress: 'Charging',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

export const STATUS_TONE: Record<SessionStatus, 'brand' | 'info' | 'success' | 'danger' | 'neutral'> = {
  planned: 'neutral',
  in_progress: 'info',
  completed: 'success',
  failed: 'danger',
  cancelled: 'neutral',
}

/** Whole percent, or one decimal below 10 (a battery at 4.5% reads so). */
export function percent(value: number): string {
  return value < 10 && !Number.isInteger(value) ? `${value.toFixed(1)}%` : `${Math.round(value)}%`
}

const TIME = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Addis_Ababa', hour: '2-digit', minute: '2-digit' })
const DAY_TIME = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Addis_Ababa', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

/** "14:05" today in Addis Ababa, else "26 Nov, 14:05". */
export function when(iso: string, now = Date.now()): string {
  const day = (t: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Addis_Ababa' }).format(t)
  const t = Date.parse(iso)
  return day(t) === day(now) ? TIME.format(t) : DAY_TIME.format(t)
}

/** "3 min ago", "2 h ago", "4 days ago": how old a reading is. */
export function ago(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  return `${days} ${days === 1 ? 'day' : 'days'} ago`
}

/** "1 h 25 min" between two instants, for how long a session has charged. */
export function duration(fromIso: string, toMs: number): string {
  const minutes = Math.max(0, Math.floor((toMs - Date.parse(fromIso)) / 60_000))
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

/** A session's charge, start to end: "18% → 86%", or the start alone while it charges. */
export function socSpan(s: Pick<ChargingSession, 'start_soc' | 'end_soc'>): string {
  if (s.start_soc === null && s.end_soc === null) return '—'
  if (s.end_soc === null) return `${percent(s.start_soc!)} →`
  if (s.start_soc === null) return `→ ${percent(s.end_soc)}`
  return `${percent(s.start_soc)} → ${percent(s.end_soc)}`
}

/** The dashboard's figures: how many EVs, charging now, low (critical included), and without a reading. */
export function fleetFigures(vehicles: readonly EvFleetVehicle[], line = LOW_SOC_PCT) {
  let charging = 0
  let low = 0
  let unknown = 0
  for (const v of vehicles) {
    if (v.charging) charging += 1
    const level = chargeLevel(v, line)
    if (level === 'low' || level === 'critical') low += 1
    if (level === 'unknown') unknown += 1
  }
  return { total: vehicles.length, charging, low, unknown }
}

/** The order the API gives, kept by the screen after a live patch: lowest charge first, no reading last. */
export function lowestFirst(a: EvFleetVehicle, b: EvFleetVehicle): number {
  const sa = a.latest?.state_of_charge ?? Number.POSITIVE_INFINITY
  const sb = b.latest?.state_of_charge ?? Number.POSITIVE_INFINITY
  if (sa !== sb) return sa < sb ? -1 : 1
  return a.registration_number.localeCompare(b.registration_number)
}

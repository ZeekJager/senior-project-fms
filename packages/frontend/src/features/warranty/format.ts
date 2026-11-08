import type { BadgeTone } from '@/components/ui'
import { COMPONENT_LABELS } from '@/pages/Maintenance/failures'
import type { ClaimStatus, RecallVehicleStatus, Warranty, WarrantyStatus } from './api'

const day = (ymd: string) => new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' })
const km = (n: number) => `${n.toLocaleString('en-US', { maximumFractionDigits: 1 })} km`
const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`

/** What a warranty is on: "Brakes" or "Whole vehicle". */
export function coverName(w: Pick<Warranty, 'component'>): string {
  return w.component ? COMPONENT_LABELS[w.component] : 'Whole vehicle'
}

/** "28 Nov 2026 or 100,000 km, whichever comes first". */
export function coverEnd(w: Pick<Warranty, 'ends_on' | 'ends_km'>): string {
  if (w.ends_on && w.ends_km !== null) return `${day(w.ends_on)} or ${km(w.ends_km)}, whichever comes first`
  if (w.ends_on) return day(w.ends_on)
  return w.ends_km !== null ? km(w.ends_km) : '—'
}

export const WARRANTY_STATUS: Record<WarrantyStatus, { label: string; tone: BadgeTone }> = {
  active: { label: 'Active', tone: 'success' },
  expiring: { label: 'Expiring', tone: 'warning' },
  expired: { label: 'Expired', tone: 'neutral' },
  not_started: { label: 'Not started', tone: 'info' },
  void: { label: 'Void', tone: 'neutral' },
}

/** What is left of it, in words: "Ends in 20 days", "4,200 km left", "Ended 3 days ago". */
export function remainingText(w: Warranty): string {
  if (w.status === 'void') return 'Voided: it covers nothing.'
  if (w.status === 'not_started') return `Starts ${day(w.starts_on)}`
  const parts: string[] = []
  if (w.days_left !== null) parts.push(w.days_left < 0 ? `Ended ${days(-w.days_left)} ago` : w.days_left === 0 ? 'Ends today' : `Ends in ${days(w.days_left)}`)
  if (w.km_left !== null) parts.push(w.km_left < 0 ? `${km(-w.km_left)} past its limit` : `${km(w.km_left)} left`)
  return parts.join(' · ') || 'No end on record'
}

export const CLAIM_TONES: Record<ClaimStatus, BadgeTone> = {
  claimable: 'brand',
  submitted: 'info',
  approved: 'success',
  rejected: 'danger',
}

export const RECALL_STATUS: Record<RecallVehicleStatus, { label: string; tone: BadgeTone }> = {
  open: { label: 'Open', tone: 'danger' },
  scheduled: { label: 'Booked', tone: 'info' },
  completed: { label: 'Done', tone: 'success' },
}

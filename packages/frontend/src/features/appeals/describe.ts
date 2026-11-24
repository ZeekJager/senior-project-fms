import type { BadgeTone } from '@/components/ui'
import { monthLabel } from '@/lib/month'
import type { Appeal, AppealEventType, AppealReason, AppealStatus, Correction } from './api'

// Words for score appeals (FMS-159), shared by the driver app and the reviewers' queue.

export const STATUS: Record<AppealStatus, { label: string; tone: BadgeTone }> = {
  submitted: { label: 'Submitted', tone: 'info' },
  under_review: { label: 'Under review', tone: 'warning' },
  approved: { label: 'Approved', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'danger' },
  closed: { label: 'Closed', tone: 'neutral' },
}

/** A closed appeal says how it ended. */
export function statusOf(a: Pick<Appeal, 'status' | 'outcome'>): { label: string; tone: BadgeTone } {
  if (a.status !== 'closed') return STATUS[a.status]
  if (a.outcome === 'withdrawn') return { label: 'Withdrawn', tone: 'neutral' }
  if (a.outcome === 'approved') return { label: 'Approved · closed', tone: 'success' }
  if (a.outcome === 'rejected') return { label: 'Rejected · closed', tone: 'neutral' }
  return STATUS.closed
}

export const REASONS: { value: AppealReason; label: string }[] = [
  { value: 'wrong_data', label: 'Wrong data or GPS error' },
  { value: 'not_my_trip', label: 'Not my trip' },
  { value: 'road_conditions', label: 'Road or traffic conditions' },
  { value: 'vehicle_fault', label: 'Vehicle fault' },
  { value: 'other', label: 'Other' },
]
export const reasonLabel = (r: AppealReason) => REASONS.find((x) => x.value === r)?.label ?? r

export const CORRECTIONS: Record<Correction, { label: string; detail: string }> = {
  exclude_flag: { label: 'Exclude the flag', detail: 'The flag no longer counts in the score. The trip still does.' },
  exclude_incident: { label: 'Exclude the incident', detail: 'The incident no longer counts in the score.' },
  exclude_trip: { label: 'Exclude the whole trip', detail: 'The trip, its km and every flag and incident on it leave the score.' },
}

const FLAG_WORDS: Record<string, string> = { speeding: 'Speeding', idling: 'Idling' }
const INCIDENT_WORDS: Record<string, string> = {
  accident: 'Accident',
  breakdown: 'Breakdown',
  flat_tyre: 'Flat tyre',
  theft: 'Theft',
  vandalism: 'Vandalism',
  road_hazard: 'Road hazard',
}
export const flagWord = (kind: string) => FLAG_WORDS[kind] ?? kind.replace(/_/g, ' ')
export const incidentWord = (kind: string) => INCIDENT_WORDS[kind] ?? kind.replace(/_/g, ' ')

const DATE_TIME = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Africa/Addis_Ababa' })
const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Addis_Ababa' })
export const when = (iso: string) => DATE_TIME.format(new Date(iso))
export const day = (iso: string) => DATE.format(new Date(iso))

/** What an appeal is against, in a few words. */
export function targetLabel(a: Pick<Appeal, 'target'>, kind?: string): string {
  const t = a.target
  if (t.type === 'score') return `Score for ${monthLabel(t.month!)}`
  if (t.type === 'flag') return `${kind ? flagWord(kind) : 'Flag'} on ${when(t.event_at)}`
  return `${kind ? incidentWord(kind) : 'Incident'} on ${when(t.event_at)}`
}

export const EVENT_WORDS: Record<AppealEventType, string> = {
  submitted: 'Sent',
  claimed: 'Claimed for review',
  commented: 'Wrote',
  approved: 'Approved',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
  escalated: 'Overdue: sent to the depot admin',
  acknowledged: 'Decision read',
  closed: 'Closed',
  attachment_opened: 'Opened a file',
}

/** Days left to the review deadline, or how late. */
export function dueLabel(a: Pick<Appeal, 'due_at' | 'overdue' | 'status'>, now = new Date()): string | null {
  if (a.status !== 'submitted' && a.status !== 'under_review') return null
  const days = Math.round((new Date(a.due_at).getTime() - now.getTime()) / 86_400_000)
  if (a.overdue) return days <= -1 ? `Overdue by ${-days} day${days === -1 ? '' : 's'}` : 'Overdue'
  return days <= 0 ? 'Due today' : `Due in ${days} day${days === 1 ? '' : 's'}`
}

export const MIN_EXPLANATION = 20
export const MAX_EXPLANATION = 2000
export const MAX_FILES = 5
export const MAX_FILE_BYTES = 5 * 1024 * 1024
export const FILE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']

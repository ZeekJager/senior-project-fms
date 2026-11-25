import type { BadgeTone } from '@/components/ui'
import { monthLabel } from '@/lib/month'
import type { DriverFeedback, FeedbackTone } from './api'

// Words for driver feedback (FMS-158), shared by the driver app and the managers' drawer.

/** The categories' labels: the feedback_categories parameter's options (settings decide which are in use). */
export const CATEGORIES: { value: string; label: string }[] = [
  { value: 'safety', label: 'Safety' },
  { value: 'driving_behaviour', label: 'Driving behaviour' },
  { value: 'fuel_efficiency', label: 'Fuel efficiency' },
  { value: 'punctuality', label: 'Punctuality' },
  { value: 'vehicle_care', label: 'Vehicle care' },
  { value: 'general', label: 'General comment' },
]
export const categoryLabel = (c: string) => CATEGORIES.find((x) => x.value === c)?.label ?? c

export const TONES: Record<FeedbackTone, { label: string; tone: BadgeTone }> = {
  praise: { label: 'Praise', tone: 'success' },
  needs_improvement: { label: 'Needs improvement', tone: 'warning' },
  information: { label: 'Information', tone: 'info' },
}

export const MIN_MESSAGE = 10
export const MAX_MESSAGE = 2000
export const MAX_REPLY = 1000

/** What it is about, in words. */
export function subjectLabel(f: Pick<DriverFeedback, 'subject'>): string {
  if (f.subject.type === 'month' && f.subject.month) {
    const shown = f.subject.score_shown !== null ? ` (score ${f.subject.score_shown})` : ''
    return `${monthLabel(f.subject.month)}${shown}`
  }
  if (f.subject.type === 'trip') return 'A trip'
  return 'Overall performance'
}

export function when(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Addis_Ababa' }).format(new Date(iso))
}

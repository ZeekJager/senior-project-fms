import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'
import type { Person } from '@/features/appeals/api'

// Admin-to-driver feedback (FMS-158, docs/driver-feedback.md): the driver's side (My feedback, Got it, a reply) and
// the managers' (a driver's feedback, giving, correcting and retracting it, and its templates).

export type FeedbackSubject = 'trip' | 'month' | 'overall'
export type FeedbackTone = 'praise' | 'needs_improvement' | 'information'

export interface DriverFeedback {
  id: string
  subject: { type: FeedbackSubject; trip_id: string | null; month: string | null; score_shown: number | null }
  category: string
  tone: FeedbackTone
  message: string
  from: Person | null
  given_at: string
  edited_at: string | null
  acknowledged_at: string | null
  reply: string | null
  replied_at: string | null
  can: { edit: boolean; retract: boolean; acknowledge: boolean; reply: boolean; disagree: boolean }
}

export interface Feedback extends DriverFeedback {
  driver: Person | null
  depot: Person | null
  editable_until: string
  retracted_at: string | null
  retracted_by: Person | null
  retraction_reason: string | null
  unacknowledged_overdue: boolean
  revisions: { message: string; revised_by: Person | null; at: string }[]
  version: number
}

export interface FeedbackCounts {
  days: number
  by_category: Record<string, number>
  unacknowledged_overdue: number
}

export interface FeedbackTemplate {
  id: string
  category: string
  title: string
  body: string
  updated_at: string
  version: number
}

export interface NewFeedback {
  subject_type: FeedbackSubject
  trip_id?: string
  month?: string
  category: string
  tone: FeedbackTone
  message: string
}

export const PAGE_SIZE = 25

export const feedbackKeys = {
  all: ['feedback'] as const,
  mine: (userId: string) => ['feedback', 'mine', userId] as const,
  mineOne: (id: string) => ['feedback', 'mine', 'item', id] as const,
  driver: (driverId: string, f: { category: string; tone: string; page: number }) => ['feedback', 'driver', driverId, f] as const,
  templates: () => ['feedback', 'templates'] as const,
}

// My feedback works offline from its last copy (FMS-158): this driver's, on this phone.
const STORE_KEY = 'fms-driver-feedback'
interface Kept {
  userId: string
  savedAt: number
  items: DriverFeedback[]
  unacknowledged: number
}

function readKept(userId: string): Kept | null {
  try {
    const kept = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null') as Kept | null
    return kept && kept.userId === userId ? kept : null
  } catch {
    return null
  }
}

function keep(kept: Kept) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(kept))
  } catch {
    // Private mode or full: the screen still works online.
  }
}

/** The signed-in driver's live feedback, newest first; the last copy at once, then the server's. */
export function useMyFeedback() {
  const { api, session } = useAuth()
  const userId = session?.user.id ?? ''
  const kept = readKept(userId)
  return useQuery({
    queryKey: feedbackKeys.mine(userId),
    queryFn: async () => {
      const res = await api.requestEnvelope<DriverFeedback[]>(`/driver/feedback?page=1&page_size=100`)
      const value = { items: res.data, unacknowledged: Number(res.meta.unacknowledged ?? 0), savedAt: Date.now() }
      keep({ userId, ...value })
      return value
    },
    enabled: userId !== '',
    initialData: kept ? { items: kept.items, unacknowledged: kept.unacknowledged, savedAt: kept.savedAt } : undefined,
    initialDataUpdatedAt: kept?.savedAt,
    staleTime: 0,
  })
}

/** One item of the driver's: from the server, or from the last copy with no signal. */
export function useMyFeedbackItem(id: string) {
  const { api, session } = useAuth()
  const kept = readKept(session?.user.id ?? '')?.items.find((i) => i.id === id)
  return useQuery({
    queryKey: feedbackKeys.mineOne(id),
    queryFn: () => api.request<DriverFeedback>(`/driver/feedback/${id}`),
    initialData: kept,
    initialDataUpdatedAt: kept ? 0 : undefined,
    staleTime: 0,
  })
}

export type FeedbackAnswer = { action: 'acknowledge' } | { action: 'reply'; body: string }

/** "Got it", or the one reply; the answer is the item as it now is. */
export function useAnswerFeedback(id: string) {
  const { api } = useAuth()
  const client = useQueryClient()
  return useMutation({
    mutationFn: (a: FeedbackAnswer) => api.request<DriverFeedback>(`/driver/feedback/${id}/${a.action}`, { method: 'POST', json: a.action === 'reply' ? { body: a.body } : {} }),
    onSuccess: (item) => {
      client.setQueryData(feedbackKeys.mineOne(id), item)
      void client.invalidateQueries({ queryKey: ['feedback', 'mine'] })
    },
  })
}

export interface DriverFeedbackFilters {
  category: string
  tone: string
  page: number
}

/** A driver's feedback for a manager, newest first, with the 90 days' counts. */
export function useDriverFeedback(driverId: string, f: DriverFeedbackFilters) {
  const { api } = useAuth()
  return useQuery({
    queryKey: feedbackKeys.driver(driverId, f),
    queryFn: async () => {
      const q = new URLSearchParams({ page: String(f.page), page_size: String(PAGE_SIZE) })
      if (f.category) q.set('category', f.category)
      if (f.tone) q.set('tone', f.tone)
      const res = await api.requestEnvelope<Feedback[]>(`/drivers/${driverId}/feedback?${q}`)
      return { items: res.data, counts: res.meta.counts as FeedbackCounts, total: Number(res.meta.total_items ?? 0) }
    },
    placeholderData: keepPreviousData,
  })
}

export function useGiveFeedback(driverId: string) {
  const { api } = useAuth()
  const client = useQueryClient()
  return useMutation({
    mutationFn: (f: NewFeedback) => api.request<Feedback>(`/drivers/${driverId}/feedback`, { method: 'POST', json: f }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['feedback', 'driver', driverId] }),
  })
}

export type FeedbackChange = { action: 'edit'; message: string } | { action: 'retract'; reason: string }

export function useChangeFeedback(driverId: string) {
  const { api } = useAuth()
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, change }: { id: string; change: FeedbackChange }) =>
      change.action === 'edit'
        ? api.request<Feedback>(`/feedback/${id}`, { method: 'PATCH', json: { message: change.message } })
        : api.request<Feedback>(`/feedback/${id}/retract`, { method: 'POST', json: { reason: change.reason } }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['feedback', 'driver', driverId] }),
  })
}

export function useFeedbackTemplates(enabled: boolean) {
  const { api } = useAuth()
  return useQuery({ queryKey: feedbackKeys.templates(), queryFn: () => api.request<FeedbackTemplate[]>('/feedback/templates'), enabled, staleTime: 60_000 })
}

export function useSaveTemplate() {
  const { api } = useAuth()
  const client = useQueryClient()
  return useMutation({
    mutationFn: (t: { category: string; title: string; body: string }) => api.request<FeedbackTemplate>('/feedback/templates', { method: 'POST', json: t }),
    onSuccess: () => client.invalidateQueries({ queryKey: feedbackKeys.templates() }),
  })
}

export function useRemoveTemplate() {
  const { api } = useAuth()
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.request<void>(`/feedback/templates/${id}`, { method: 'DELETE' }),
    onSuccess: () => client.invalidateQueries({ queryKey: feedbackKeys.templates() }),
  })
}

/** A driver's completed trips, newest first, to give feedback on one. */
export function useCompletedTrips(driverId: string, enabled: boolean) {
  const { api } = useAuth()
  return useQuery({
    queryKey: ['feedback', 'trips', driverId],
    queryFn: () =>
      api.request<{ id: string; route_name: string | null; actual_end: string | null; scheduled_start: string | null }[]>(
        `/trips?${new URLSearchParams({ driver_id: driverId, status: 'completed', sort_order: 'desc', page_size: '20' })}`,
      ),
    enabled,
    staleTime: 60_000,
  })
}

/** The categories in use: the feedback_categories parameter's value (FMS-157), any signed-in user reads it. */
export function useFeedbackCategories() {
  const { api } = useAuth()
  return useQuery({
    queryKey: ['feedback', 'categories'],
    queryFn: async () => (await api.request<{ value: string[] }>('/settings/definitions/feedback_categories')).value,
    staleTime: 5 * 60_000,
  })
}

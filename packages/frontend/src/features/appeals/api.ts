import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/context/AuthContext'

// Score appeals and complaints (FMS-159, docs/score-appeals.md): the driver's side (My appeals, a new appeal) and the
// reviewers' (the queue, claiming, the thread, the decision), over /appeals.

export type AppealStatus = 'submitted' | 'under_review' | 'approved' | 'rejected' | 'closed'
export type AppealReason = 'wrong_data' | 'not_my_trip' | 'road_conditions' | 'vehicle_fault' | 'other'
export type Correction = 'exclude_flag' | 'exclude_incident' | 'exclude_trip'
export type AppealEventType = 'submitted' | 'claimed' | 'commented' | 'approved' | 'rejected' | 'withdrawn' | 'escalated' | 'acknowledged' | 'closed' | 'attachment_opened'

export interface Person {
  id: string
  name: string
}

export interface Appeal {
  id: string
  kind: 'appeal' | 'complaint'
  status: AppealStatus
  outcome: 'approved' | 'rejected' | 'withdrawn' | null
  target: { type: 'flag' | 'incident' | 'score'; id: string | null; month: string | null; trip_id: string | null; event_at: string }
  reason: AppealReason
  explanation: string
  /** The feedback (FMS-158) the driver disagrees with, when the appeal came from "I disagree". */
  feedback_id: string | null
  driver: Person
  depot: Person | null
  submitted_at: string
  due_at: string
  overdue: boolean
  escalated_at: string | null
  claimed_by: Person | null
  claimed_at: string | null
  decided_by: Person | null
  decided_at: string | null
  decision_note: string | null
  correction: Correction | null
  score_before: number | null
  score_after: number | null
  acknowledged_at: string | null
  closed_at: string | null
  attachments: { id: string; content_type: string; size_bytes: number; filename: string | null }[]
  version: number
}

export interface AppealEvidence {
  track: { vehicle_id: string; registration_number: string; from: string; to: string } | null
  flag: { type: string; observed_at: string; resolved_at: string | null } | null
  incident: { type: string; occurred_at: string } | null
  trip_flags: { id: string; type: string; observed_at: string; resolved_at: string | null; excluded: boolean }[]
  score: {
    month: string
    score: number | null
    reason: string | null
    components: Record<'punctuality' | 'safety' | 'incidents' | 'dvir', { score: number | null; weight: number }>
    figures: Record<string, number>
  }
  corrections: Correction[]
}

export interface AppealDetail extends Appeal {
  timeline: { id: string; type: AppealEventType; actor: Person | null; body: string | null; at: string }[]
  evidence: AppealEvidence | null
  can: { claim: boolean; comment: boolean; decide: boolean; withdraw: boolean; acknowledge: boolean }
}

export interface Appealable {
  items: { target_type: 'flag' | 'incident'; id: string; kind: string; at: string; trip_id: string | null; open_appeal_id: string | null; excluded: boolean }[]
  months: string[]
  window_days: number
}

export interface QueueFilters {
  status: AppealStatus[]
  depotId: string | null
  overdue: boolean
  page: number
}

export const appealKeys = {
  all: ['appeals'] as const,
  mine: (page: number) => ['appeals', 'mine', page] as const,
  appealable: () => ['appeals', 'appealable'] as const,
  detail: (id: string) => ['appeals', 'detail', id] as const,
  queue: (f: QueueFilters) => ['appeals', 'queue', f] as const,
}

export const PAGE_SIZE = 25
/** The queue and an open appeal refresh while on screen: drivers and other reviewers move them on. */
const REFRESH_MS = 30_000

export function useMyAppeals(page = 1) {
  const { api } = useAuth()
  return useQuery({
    queryKey: appealKeys.mine(page),
    queryFn: () => api.requestEnvelope<Appeal[]>(`/appeals/mine?page=${page}&page_size=${PAGE_SIZE}`),
    placeholderData: keepPreviousData,
  })
}

export function useAppealable(enabled = true) {
  const { api } = useAuth()
  return useQuery({ queryKey: appealKeys.appealable(), queryFn: () => api.request<Appealable>('/appeals/appealable'), enabled })
}

export function useAppeal(id: string | null) {
  const { api } = useAuth()
  return useQuery({
    queryKey: appealKeys.detail(id ?? ''),
    queryFn: () => api.request<AppealDetail>(`/appeals/${id}`),
    enabled: id !== null,
    refetchInterval: REFRESH_MS,
  })
}

export function useAppealQueue(f: QueueFilters) {
  const { api } = useAuth()
  return useQuery({
    queryKey: appealKeys.queue(f),
    queryFn: () => {
      const q = new URLSearchParams({ page: String(f.page), page_size: String(PAGE_SIZE) })
      if (f.status.length) q.set('status', f.status.join(','))
      if (f.depotId) q.set('depot_id', f.depotId)
      if (f.overdue) q.set('overdue', 'true')
      return api.requestEnvelope<Appeal[]>(`/appeals?${q}`)
    },
    placeholderData: keepPreviousData,
    refetchInterval: REFRESH_MS,
  })
}

export interface NewAppeal {
  kind: 'appeal' | 'complaint'
  target_type: 'flag' | 'incident' | 'score'
  target_id?: string
  month?: string
  reason: AppealReason
  explanation: string
  /** The feedback (FMS-158) the appeal disagrees with. */
  feedback_id?: string
  files: File[]
}

export function useSubmitAppeal() {
  const { api } = useAuth()
  const client = useQueryClient()
  return useMutation({
    mutationFn: (a: NewAppeal) => {
      const form = new FormData()
      form.set('kind', a.kind)
      form.set('target_type', a.target_type)
      if (a.target_id) form.set('target_id', a.target_id)
      if (a.month) form.set('month', a.month)
      form.set('reason', a.reason)
      form.set('explanation', a.explanation)
      if (a.feedback_id) form.set('feedback_id', a.feedback_id)
      for (const f of a.files) form.append('files', f, f.name)
      return api.request<AppealDetail>('/appeals', { method: 'POST', formData: form })
    },
    onSuccess: () => client.invalidateQueries({ queryKey: appealKeys.all }),
  })
}

export type AppealStep =
  | { action: 'claim' }
  | { action: 'withdraw' }
  | { action: 'acknowledge' }
  | { action: 'comment'; body: string }
  | { action: 'decision'; outcome: 'approved' | 'rejected'; note: string; correction?: Correction; item_id?: string }

/** A step on one appeal; the answer is the appeal as it now is. */
export function useAppealStep(id: string) {
  const { api } = useAuth()
  const client = useQueryClient()
  return useMutation({
    mutationFn: (step: AppealStep) => {
      const { action, ...body } = step
      const path = action === 'comment' ? 'comments' : action
      return api.request<AppealDetail>(`/appeals/${id}/${path}`, { method: 'POST', json: body })
    },
    onSuccess: (appeal) => {
      client.setQueryData(appealKeys.detail(id), appeal)
      void client.invalidateQueries({ queryKey: ['appeals', 'queue'] })
      void client.invalidateQueries({ queryKey: ['appeals', 'mine'] })
      // An approval corrects the score.
      void client.invalidateQueries({ queryKey: ['analytics'] })
    },
  })
}

/** A signed link to one file (recorded on the appeal), opened in a new tab. */
export function useOpenAttachment(appealId: string) {
  const { api } = useAuth()
  return useMutation({
    mutationFn: async (attachmentId: string) => {
      const { url } = await api.request<{ url: string; expires_at: string }>(`/appeals/${appealId}/attachments/${attachmentId}/link`)
      window.open(url, '_blank', 'noopener')
      return url
    },
  })
}

import type { MaintenanceRisk, PredictionFeedback, PredictionOutcome } from '@/features/health/health'
import { FAILURE_COMPONENTS, type FailureComponent } from '@/pages/Maintenance/failures'

// What the inspection of a flagged vehicle found (FMS-128, docs/ml-scoring.md): the answer that tells the
// system whether a high-risk prediction was right. The form on the health breakdown (S-19).

export const OUTCOMES: readonly { value: PredictionOutcome; label: string; hint: string }[] = [
  { value: 'confirmed_issue', label: 'Found a problem', hint: 'The inspection found what the score feared.' },
  { value: 'no_issue_found', label: 'Nothing wrong', hint: 'Inspected: the vehicle is fine.' },
  { value: 'already_fixed', label: 'Already fixed', hint: 'A real problem, repaired before the inspection.' },
  { value: 'not_inspected', label: 'Not inspected', hint: 'Nobody has looked at it.' },
]

export const OUTCOME_LABELS: Record<PredictionOutcome, string> = Object.fromEntries(OUTCOMES.map((o) => [o.value, o.label])) as Record<PredictionOutcome, string>

export const MAX_COMMENT = 1000

/** The feedback as it is being filled in. */
export interface FeedbackDraft {
  outcome: PredictionOutcome | ''
  component: FailureComponent | ''
  /** The failure record the issue led to (its id), or ''. */
  failureId: string
  comment: string
}

export const emptyDraft = (): FeedbackDraft => ({ outcome: '', component: '', failureId: '', comment: '' })

/** An existing feedback, to change. */
export function draftOf(feedback: PredictionFeedback): FeedbackDraft {
  return {
    outcome: feedback.outcome,
    component: (FAILURE_COMPONENTS as readonly string[]).includes(feedback.component ?? '') ? (feedback.component as FailureComponent) : '',
    failureId: feedback.failure_event_id ?? '',
    comment: feedback.comment ?? '',
  }
}

/**
 * Whether the breakdown asks what the inspection found: the prediction flagged the vehicle as high risk (the
 * only ones whose accuracy is measured), and the user may record it (maintenance:write) or feedback exists to read.
 */
export function asksForFeedback(risk: MaintenanceRisk, canWrite: boolean): boolean {
  if (risk.risk_level !== 'high' || risk.prediction_id === null) return false
  return canWrite || risk.feedback !== null
}

/** What to send, or the errors to show (keyed `outcome`, `comment`). A problem found may name the component and the failure record; nothing else may. */
export function checkFeedback(draft: FeedbackDraft): { body: Record<string, unknown> | null; errors: Record<string, string> } {
  const errors: Record<string, string> = {}
  if (draft.outcome === '') errors.outcome = 'Choose what the inspection found.'
  const comment = draft.comment.trim()
  if (comment.length > MAX_COMMENT) errors.comment = `Keep it to ${MAX_COMMENT} characters.`
  if (Object.keys(errors).length > 0 || draft.outcome === '') return { body: null, errors }
  const found = draft.outcome === 'confirmed_issue'
  return {
    body: {
      outcome: draft.outcome,
      component: found && draft.component ? draft.component : null,
      failure_event_id: found && draft.failureId ? draft.failureId : null,
      comment: comment || null,
    },
    errors,
  }
}

import { describe, expect, it } from 'vitest'
import type { MaintenanceRisk, PredictionFeedback } from '@/features/health/health'
import { MAX_COMMENT, OUTCOMES, asksForFeedback, checkFeedback, draftOf, emptyDraft } from './feedback'

const base: MaintenanceRisk = {
  vehicle_id: 'v-1',
  prediction_id: 'p-1',
  health_score: 30,
  risk_level: 'high',
  failure_probability: 0.7,
  prediction_horizon_days: 30,
  factors: [],
  model_name: 'predictive-maintenance',
  model_version: 'pm-2026.10',
  as_of: null,
  scored_at: null,
  stale: false,
  feedback: null,
}

const given: PredictionFeedback = {
  id: 'f-1',
  prediction_id: 'p-1',
  outcome: 'confirmed_issue',
  component: 'brakes',
  failure_event_id: 'fe-1',
  comment: 'Pads gone',
  recorded_by: 'u-1',
  created_at: '2026-10-25T08:00:00Z',
  updated_at: '2026-10-25T08:00:00Z',
  editable_until: '2026-11-01T08:00:00Z',
  can_edit: true,
}

describe('asksForFeedback', () => {
  it('asks about a high-risk prediction when the user may record it', () => {
    expect(asksForFeedback(base, true)).toBe(true)
  })

  it('does not ask about a medium or low one: only a flag is judged', () => {
    expect(asksForFeedback({ ...base, risk_level: 'medium' }, true)).toBe(false)
    expect(asksForFeedback({ ...base, risk_level: 'low' }, true)).toBe(false)
    expect(asksForFeedback({ ...base, risk_level: null, prediction_id: null }, true)).toBe(false)
  })

  it('shows a user who cannot record only what was recorded', () => {
    expect(asksForFeedback(base, false)).toBe(false)
    expect(asksForFeedback({ ...base, feedback: given }, false)).toBe(true)
  })
})

describe('checkFeedback', () => {
  it('needs an outcome', () => {
    expect(checkFeedback(emptyDraft())).toEqual({ body: null, errors: { outcome: 'Choose what the inspection found.' } })
  })

  it('sends a confirmed issue with the part and the failure record it led to', () => {
    const { body } = checkFeedback({ outcome: 'confirmed_issue', component: 'brakes', failureId: 'fe-1', comment: '  Pads gone  ' })
    expect(body).toEqual({ outcome: 'confirmed_issue', component: 'brakes', failure_event_id: 'fe-1', comment: 'Pads gone' })
  })

  it('leaves out the part and the failure record for any other outcome, even if they were filled in before the choice changed', () => {
    for (const o of OUTCOMES.filter((x) => x.value !== 'confirmed_issue')) {
      const { body } = checkFeedback({ outcome: o.value, component: 'brakes', failureId: 'fe-1', comment: '' })
      expect(body).toEqual({ outcome: o.value, component: null, failure_event_id: null, comment: null })
    }
  })

  it('a confirmed issue needs neither the part nor the record', () => {
    expect(checkFeedback({ outcome: 'confirmed_issue', component: '', failureId: '', comment: '' }).body).toEqual({
      outcome: 'confirmed_issue',
      component: null,
      failure_event_id: null,
      comment: null,
    })
  })

  it('refuses notes the server would refuse', () => {
    const { body, errors } = checkFeedback({ outcome: 'no_issue_found', component: '', failureId: '', comment: 'x'.repeat(MAX_COMMENT + 1) })
    expect(body).toBeNull()
    expect(errors.comment).toBe(`Keep it to ${MAX_COMMENT} characters.`)
  })
})

describe('draftOf', () => {
  it('fills the form with what was recorded', () => {
    expect(draftOf(given)).toEqual({ outcome: 'confirmed_issue', component: 'brakes', failureId: 'fe-1', comment: 'Pads gone' })
    expect(draftOf({ ...given, outcome: 'no_issue_found', component: null, failure_event_id: null, comment: null })).toEqual({
      outcome: 'no_issue_found',
      component: '',
      failureId: '',
      comment: '',
    })
  })
})

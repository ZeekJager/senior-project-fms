import { AlertCircle, CheckCircle2, Pencil } from 'lucide-react'
import { useState } from 'react'
import { useAuth } from '@/context/AuthContext'
import type { HealthVehicle } from '@/features/health/HealthDrawer'
import { formatScoredAt, type MaintenanceRisk, type PredictionFeedback, type PredictionOutcome } from '@/features/health/health'
import { Badge, Button, SelectField, TextAreaField, cn, useToast, type BadgeTone } from '@/components/ui'
import { ApiError } from '@/lib/api/errors'
import { COMPONENT_LABELS, FAILURE_COMPONENTS, MODE_LABELS, type FailureComponent } from '@/pages/Maintenance/failures'
import { useSaveFeedback, useVehicleFailures } from './api'
import { MAX_COMMENT, OUTCOMES, OUTCOME_LABELS, asksForFeedback, checkFeedback, draftOf, emptyDraft, type FeedbackDraft } from './feedback'

const OUTCOME_TONE: Record<PredictionOutcome, BadgeTone> = {
  confirmed_issue: 'danger',
  no_issue_found: 'success',
  already_fixed: 'warning',
  not_inspected: 'neutral',
}

const componentLabel = (c: string | null) => (c && c in COMPONENT_LABELS ? COMPONENT_LABELS[c as FailureComponent] : c)

/**
 * "What the inspection found" (S-19, FMS-128), under the breakdown of a high-risk vehicle: the answer that
 * tells the system whether the prediction was right. A technician (maintenance:write) records it once; its
 * author can change it for 7 days. Everyone who sees the breakdown reads what was found.
 */
export function FeedbackSection({ vehicle, risk }: { vehicle: HealthVehicle; risk: MaintenanceRisk }) {
  const { hasPermission } = useAuth()
  const canWrite = hasPermission('maintenance:write')
  const [editing, setEditing] = useState(false)
  if (!asksForFeedback(risk, canWrite)) return null
  const feedback = risk.feedback

  return (
    <section aria-labelledby="health-feedback" className="space-y-3">
      <div>
        <h3 id="health-feedback" className="text-sm font-semibold text-ink">
          What the inspection found
        </h3>
        <p className="mt-1 text-xs text-ink-muted">
          {feedback
            ? 'The score flagged this vehicle. This is what a technician found.'
            : 'The score flagged this vehicle. Say what the inspection found: it shows how often the model is right.'}
        </p>
      </div>
      {feedback && !editing ? (
        <Summary feedback={feedback} onEdit={() => setEditing(true)} />
      ) : (
        <FeedbackForm
          key={feedback?.id ?? 'new'}
          vehicle={vehicle}
          risk={risk}
          existing={feedback}
          onDone={() => setEditing(false)}
          onCancel={feedback ? () => setEditing(false) : undefined}
        />
      )}
    </section>
  )
}

function Summary({ feedback, onEdit }: { feedback: PredictionFeedback; onEdit: () => void }) {
  return (
    <div className="space-y-3 rounded-card border border-line p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={OUTCOME_TONE[feedback.outcome]} dot>
          {OUTCOME_LABELS[feedback.outcome]}
        </Badge>
        {feedback.component && <span className="text-sm text-ink">{componentLabel(feedback.component)}</span>}
      </div>
      {feedback.failure_event_id && (
        <p className="flex items-center gap-1.5 text-xs text-ink-muted">
          <CheckCircle2 className="h-3.5 w-3.5 text-success" aria-hidden="true" />
          Linked to the failure record it led to
        </p>
      )}
      {feedback.comment && <p className="whitespace-pre-line text-sm text-ink">{feedback.comment}</p>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-ink-subtle">
          Recorded {formatScoredAt(feedback.created_at)}
          {feedback.can_edit ? `. You can change it until ${formatScoredAt(feedback.editable_until)}.` : '.'}
        </p>
        {feedback.can_edit && (
          <Button size="sm" variant="secondary" leadingIcon={<Pencil className="h-3.5 w-3.5" />} onClick={onEdit}>
            Change
          </Button>
        )}
      </div>
    </div>
  )
}

function FeedbackForm({
  vehicle,
  risk,
  existing,
  onDone,
  onCancel,
}: {
  vehicle: HealthVehicle
  risk: MaintenanceRisk
  existing: PredictionFeedback | null
  onDone: () => void
  onCancel?: () => void
}) {
  const { toast } = useToast()
  const { hasPermission } = useAuth()
  const [draft, setDraft] = useState<FeedbackDraft>(existing ? draftOf(existing) : emptyDraft())
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const save = useSaveFeedback(vehicle.id, risk.prediction_id!)
  const found = draft.outcome === 'confirmed_issue'
  const failures = useVehicleFailures(vehicle.id, found && hasPermission('maintenance:read'))
  const linked = failures.data?.find((f) => f.id === draft.failureId)

  const set = (patch: Partial<FeedbackDraft>) => {
    setDraft((d) => ({ ...d, ...patch }))
    setErrors({})
    setFormError(null)
  }

  async function submit() {
    const checked = checkFeedback(draft)
    if (!checked.body) return setErrors(checked.errors)
    setFormError(null)
    try {
      await save.mutateAsync({ body: checked.body, existing: existing !== null })
      toast({ title: existing ? 'Feedback changed' : 'Feedback saved', description: `${vehicle.registration_number} · ${OUTCOME_LABELS[draft.outcome as PredictionOutcome]}`, tone: 'success' })
      onDone()
    } catch (err) {
      const reason = err instanceof ApiError ? err.details[0]?.reason : undefined
      if (err instanceof ApiError && err.code === 'CONFLICT_DUPLICATE') {
        toast({ title: 'Already recorded', description: 'A technician has already said what they found on this prediction. It is shown now.', tone: 'info' })
        return onDone()
      }
      if (reason === 'edit_window_closed') {
        toast({ title: 'Too late to change', description: 'Feedback can be changed for 7 days after it was given.', tone: 'info' })
        return onDone()
      }
      if (reason === 'failure_other_vehicle' || reason === 'references_missing_record') return setErrors({ failure: 'Choose a failure record of this vehicle.' })
      setFormError(err instanceof ApiError ? `The feedback could not be saved (${err.code}).` : 'Could not reach the server. Try again.')
    }
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
      noValidate
    >
      <fieldset aria-describedby={errors.outcome ? 'feedback-outcome-error' : undefined}>
        <legend className="mb-2 text-xs font-medium text-ink-subtle">What did the inspection find?</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {OUTCOMES.map((o) => (
            <label
              key={o.value}
              className={cn(
                'focus-within:ring-4 focus-within:ring-brand/15 flex min-h-[3.25rem] cursor-pointer flex-col justify-center rounded-control border px-3 py-2 transition-colors coarse:min-h-14',
                draft.outcome === o.value ? 'border-brand bg-brand-soft' : 'border-line-strong bg-surface hover:border-ink-subtle/50',
                errors.outcome && draft.outcome === '' && 'border-danger/70',
              )}
            >
              <input type="radio" name="outcome" value={o.value} checked={draft.outcome === o.value} onChange={() => set({ outcome: o.value })} className="sr-only" />
              <span className="text-sm font-medium text-ink">{o.label}</span>
              <span className="text-xs text-ink-muted">{o.hint}</span>
            </label>
          ))}
        </div>
        <p id="feedback-outcome-error" aria-live="polite" className="mt-1.5 flex min-h-5 items-start gap-1.5 px-1 text-xs text-danger">
          {errors.outcome && (
            <>
              <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {errors.outcome}
            </>
          )}
        </p>
      </fieldset>

      {found && (
        <div className="grid gap-x-3 sm:grid-cols-2">
          <SelectField
            label="Part of the vehicle"
            optional
            placeholder="Choose…"
            value={linked ? linked.component : draft.component}
            disabled={Boolean(linked)}
            hint={linked ? 'From the failure record' : undefined}
            onChange={(e) => set({ component: e.target.value as FailureComponent })}
            options={FAILURE_COMPONENTS.map((c) => ({ value: c, label: COMPONENT_LABELS[c] }))}
          />
          {(failures.data?.length ?? 0) > 0 && (
            <SelectField
              label="Failure record it led to"
              optional
              value={draft.failureId}
              error={errors.failure}
              onChange={(e) => set({ failureId: e.target.value })}
              options={[
                { value: '', label: 'None yet' },
                ...failures.data!.map((f) => ({ value: f.id, label: `${COMPONENT_LABELS[f.component]} · ${MODE_LABELS[f.failure_mode]} · ${formatScoredAt(f.occurred_at)}` })),
              ]}
            />
          )}
        </div>
      )}

      <TextAreaField
        label="Notes"
        optional
        rows={2}
        value={draft.comment}
        onChange={(e) => set({ comment: e.target.value })}
        maxLength={MAX_COMMENT}
        error={errors.comment}
      />

      <div role="alert" className="empty:hidden">
        {formError && (
          <p className="flex items-start gap-2 rounded-control border border-danger/25 bg-danger-soft px-3.5 py-2.5 text-sm text-danger">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            {formError}
          </p>
        )}
      </div>

      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button variant="secondary" onClick={onCancel} disabled={save.isPending}>
            Cancel
          </Button>
        )}
        <Button type="submit" loading={save.isPending}>
          {existing ? 'Save changes' : 'Save'}
        </Button>
      </div>
    </form>
  )
}

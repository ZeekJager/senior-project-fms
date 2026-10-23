import { AlertCircle, Plus, Trash2 } from 'lucide-react'
import { useId } from 'react'
import { Button, IconButton, SelectField, cn } from '@/components/ui'
import {
  COMPONENT_LABELS,
  DETECTION_LABELS,
  FAILURE_COMPONENTS,
  FAILURE_DETECTIONS,
  FAILURE_MODES,
  MODE_LABELS,
  emptyFailure,
  type FailureComponent,
  type FailureDetection,
  type FailureDraft,
  type FailureMode,
} from './failures'

const MAX_FAILURES = 10

/**
 * "What failed" (FMS-125): one row per failure the repair found, with the
 * component and mode from the fixed catalogues, whether it was planned, and
 * how it was found. Errors come from `checkFailures`.
 */
export function FailureFields({
  drafts,
  onChange,
  errors,
}: {
  drafts: FailureDraft[]
  onChange: (drafts: FailureDraft[]) => void
  errors: Record<string, string>
}) {
  const update = (key: number, patch: Partial<FailureDraft>) => onChange(drafts.map((d) => (d.key === key ? { ...d, ...patch } : d)))

  return (
    <div className="space-y-3">
      <div role="alert" className="empty:hidden">
        {errors.failures && (
          <p className="flex animate-fade-in items-start gap-2 rounded-control border border-danger/25 bg-danger-soft px-3.5 py-2.5 text-sm text-danger">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            {errors.failures}
          </p>
        )}
      </div>
      <ul className="space-y-3">
        {drafts.map((d, i) => (
          <li key={d.key}>
            <fieldset className="rounded-card border border-line bg-surface-muted/50 p-3">
              {/* The legend names the group; the visible heading shares its row with the remove button. */}
              <legend className="sr-only">Failure {i + 1}</legend>
              <div className="mb-2 flex min-h-9 items-center justify-between">
                <span aria-hidden="true" className="text-sm font-medium text-ink">
                  Failure {i + 1}
                </span>
                {drafts.length > 1 && (
                  <IconButton
                    label={`Remove failure ${i + 1}`}
                    icon={<Trash2 />}
                    onClick={() => onChange(drafts.filter((x) => x.key !== d.key))}
                    className="hover:bg-danger-soft hover:text-danger"
                  />
                )}
              </div>
              <div className="grid gap-x-3 sm:grid-cols-2">
                <SelectField
                  label="Component"
                  placeholder="Choose…"
                  value={d.component}
                  onChange={(e) => update(d.key, { component: e.target.value as FailureComponent })}
                  options={FAILURE_COMPONENTS.map((c) => ({ value: c, label: COMPONENT_LABELS[c] }))}
                  error={errors[`failure.${i}.component`]}
                />
                <SelectField
                  label="Failure mode"
                  placeholder="Choose…"
                  value={d.failure_mode}
                  onChange={(e) => update(d.key, { failure_mode: e.target.value as FailureMode })}
                  options={FAILURE_MODES.map((m) => ({ value: m, label: MODE_LABELS[m] }))}
                  error={errors[`failure.${i}.failure_mode`]}
                />
              </div>
              <PlannedChoice index={i} value={d.unplanned} onChange={(unplanned) => update(d.key, { unplanned })} error={errors[`failure.${i}.unplanned`]} />
              <SelectField
                label="How it was found"
                value={d.detected_by}
                onChange={(e) => update(d.key, { detected_by: e.target.value as FailureDetection })}
                options={FAILURE_DETECTIONS.map((x) => ({ value: x, label: DETECTION_LABELS[x] }))}
              />
            </fieldset>
          </li>
        ))}
      </ul>
      {drafts.length < MAX_FAILURES && (
        <Button size="sm" variant="secondary" leadingIcon={<Plus className="h-4 w-4" />} onClick={() => onChange([...drafts, emptyFailure()])}>
          Add another failure
        </Button>
      )}
    </div>
  )
}

const CHOICES = [
  { value: true, label: 'Breakdown or found in service' },
  { value: false, label: 'Found at planned work' },
] as const

/** Unplanned or not: the label the predictive model learns from, so it is always asked, never defaulted. */
function PlannedChoice({ index, value, onChange, error }: { index: number; value: boolean | null; onChange: (v: boolean) => void; error?: string }) {
  const messageId = `${useId()}-message`
  return (
    <div className="mb-1">
      <div
        role="radiogroup"
        aria-label={`Was failure ${index + 1} planned?`}
        aria-invalid={error ? true : undefined}
        aria-describedby={messageId}
        className={cn('grid grid-cols-2 gap-1 rounded-control bg-surface-sunken p-1', error && 'ring-1 ring-danger/60')}
      >
        {CHOICES.map((c) => {
          const on = value === c.value
          return (
            <button
              key={String(c.value)}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange(c.value)}
              className={cn(
                'focus-ring flex min-h-9 coarse:min-h-11 items-center justify-center rounded-control px-2 py-1.5 text-center text-xs font-semibold transition-all duration-200 ease-smooth',
                on ? (c.value ? 'bg-warning-soft text-warning shadow-soft' : 'bg-surface text-ink shadow-soft') : 'text-ink-muted hover:bg-surface hover:text-ink',
              )}
            >
              {c.label}
            </button>
          )
        })}
      </div>
      <p id={messageId} aria-live="polite" className="mt-1.5 min-h-5 px-1 text-xs text-danger">
        {error}
      </p>
    </div>
  )
}

import { ArrowRight, CircleCheck, CircleSlash } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Badge, Button, cn, Drawer, TextAreaField, useToast } from '@/components/ui'
import { ApiError } from '@/lib/api/errors'
import { useCloseAnomaly, type FuelAnomaly } from './api'
import { anomalyPeriod, anomalyTitle, formatDay, formatTime, litres, signedPct } from './describe'

const STATUS: Record<FuelAnomaly['status'], { label: string; tone: 'danger' | 'warning' | 'success' | 'neutral' }> = {
  open: { label: 'Open', tone: 'danger' },
  reviewed: { label: 'Reviewed', tone: 'warning' },
  resolved: { label: 'Resolved', tone: 'success' },
  dismissed: { label: 'Dismissed', tone: 'neutral' },
}

export const isClosed = (a: Pick<FuelAnomaly, 'status'>) => a.status === 'resolved' || a.status === 'dismissed'

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8.5rem_1fr] gap-3 py-2 text-sm">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="tabular min-w-0 text-ink">{children}</dd>
    </div>
  )
}

/**
 * One fuel anomaly (S-15, FMS-42): what the month's reconciliation found, and closing it. `resolved` means it was real
 * and dealt with, `dismissed` that it was not a problem (a note is required). Closing records who and when; a closed
 * anomaly shows that instead of the form. Only `canClose` (fuel-anomaly:write) gets the form.
 */
export function AnomalyDrawer({ anomaly, canClose, onClose }: { anomaly: FuelAnomaly | null; canClose: boolean; onClose: () => void }) {
  const close = useCloseAnomaly()
  const { toast } = useToast()
  const [outcome, setOutcome] = useState<'resolved' | 'dismissed'>('resolved')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setOutcome('resolved')
    setNotes('')
    setError(null)
  }, [anomaly?.id])

  if (!anomaly) return null
  const period = anomalyPeriod(anomaly)
  const closed = isClosed(anomaly)
  const needsNote = outcome === 'dismissed' && !notes.trim()

  async function submit() {
    if (!anomaly) return
    if (needsNote) {
      setError('Say why it is not a problem, so the next person reading the trail knows.')
      return
    }
    setError(null)
    try {
      const done = await close.mutateAsync({ id: anomaly.id, outcome, notes: notes.trim() })
      toast({
        title: outcome === 'resolved' ? 'Anomaly resolved' : 'Anomaly dismissed',
        description: `${done.registration_number}${period ? `, ${period}` : ''}. Recorded as ${done.reviewed_by_name ?? 'you'}.`,
      })
      onClose()
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'CONFLICT_INVALID_STATE_TRANSITION'
          ? 'Someone else closed it a moment ago. Close this panel to see what they recorded.'
          : 'It could not be saved. Check your connection and try again.',
      )
    }
  }

  return (
    <Drawer
      open
      onClose={onClose}
      title={`${anomaly.registration_number}: ${anomalyTitle(anomaly)}`}
      description={
        <>
          {anomaly.depot_name}
          {period ? ` · ${period}` : ''}
        </>
      }
      footer={
        canClose && !closed ? (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button loading={close.isPending} onClick={() => void submit()} leadingIcon={outcome === 'resolved' ? <CircleCheck className="h-4 w-4" /> : <CircleSlash className="h-4 w-4" />}>
              {outcome === 'resolved' ? 'Mark resolved' : 'Dismiss'}
            </Button>
          </div>
        ) : undefined
      }
    >
      <div className="space-y-6">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={STATUS[anomaly.status].tone}>{STATUS[anomaly.status].label}</Badge>
          <Badge tone={anomaly.severity === 'high' || anomaly.severity === 'critical' ? 'danger' : 'warning'}>{anomaly.severity === 'high' ? 'High' : anomaly.severity === 'critical' ? 'Critical' : 'Medium'} severity</Badge>
        </div>

        {anomaly.expected_ml !== null && anomaly.actual_ml !== null && (
          <section aria-label="What the reconciliation found" className="rounded-card border border-line bg-surface-muted p-4">
            <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
              <div>
                <p className="text-xs font-medium text-ink-muted">Trips needed</p>
                <p className="tabular text-lg font-semibold text-ink">{litres(anomaly.expected_ml)}</p>
              </div>
              <ArrowRight className="mb-1.5 h-4 w-4 text-ink-subtle" aria-hidden="true" />
              <div>
                <p className="text-xs font-medium text-ink-muted">Fuel logged</p>
                <p className="tabular text-lg font-semibold text-ink">{litres(anomaly.actual_ml)}</p>
              </div>
              <p className={cn('tabular mb-0.5 ml-auto text-lg font-semibold', (anomaly.deviation_pct ?? 0) > 0 ? 'text-danger' : 'text-warning')}>{signedPct(anomaly.deviation_pct)}</p>
            </div>
            <p className="mt-3 text-sm text-ink-muted">
              {(anomaly.deviation_pct ?? 0) > 0
                ? 'More fuel was logged than its trips explain. Check the fill-ups against the trips, and the receipts against the fuel card.'
                : 'Less fuel was logged than its trips needed. Fill-ups may be missing, or a trip’s distance may be wrong.'}
            </p>
          </section>
        )}

        <dl className="divide-y divide-line">
          {period && <Fact label="Period">{period}</Fact>}
          {anomaly.distance_km !== null && <Fact label="Trips driven">{anomaly.distance_km.toLocaleString('en-US', { maximumFractionDigits: 1 })} km</Fact>}
          <Fact label="Detected">
            {formatDay(anomaly.detected_at)}, {formatTime(anomaly.detected_at)}
          </Fact>
          {closed && (
            <Fact label={anomaly.status === 'resolved' ? 'Resolved by' : 'Dismissed by'}>
              {anomaly.reviewed_by_name ?? 'A deleted account'}
              {anomaly.reviewed_at && (
                <span className="block text-xs text-ink-subtle">
                  {formatDay(anomaly.reviewed_at)}, {formatTime(anomaly.reviewed_at)}
                </span>
              )}
            </Fact>
          )}
          {closed && anomaly.notes && <Fact label="Note">{<span className="whitespace-pre-line [overflow-wrap:anywhere]">{anomaly.notes}</span>}</Fact>}
        </dl>

        {canClose && !closed && (
          <section aria-labelledby="close-anomaly" className="space-y-3">
            <h3 id="close-anomaly" className="text-sm font-semibold text-ink">
              Close this anomaly
            </h3>
            <fieldset className="grid gap-2 sm:grid-cols-2">
              <legend className="sr-only">Outcome</legend>
              {(
                [
                  ['resolved', 'Resolved', 'It was real and has been dealt with.'],
                  ['dismissed', 'Not a problem', 'The fuel is explained; nothing to fix.'],
                ] as const
              ).map(([value, label, hint]) => (
                <label
                  key={value}
                  className={cn(
                    'focus-within:ring-2 focus-within:ring-brand/40 flex cursor-pointer gap-3 rounded-control border p-3 transition-colors duration-150 ease-smooth',
                    outcome === value ? 'border-brand bg-brand-soft' : 'border-line hover:bg-surface-muted',
                  )}
                >
                  <input type="radio" name="outcome" value={value} checked={outcome === value} onChange={() => setOutcome(value)} className="mt-0.5 accent-[rgb(var(--c-brand))]" />
                  <span>
                    <span className="block text-sm font-medium text-ink">{label}</span>
                    <span className="block text-xs text-ink-muted">{hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <TextAreaField
              label="Note"
              optional={outcome === 'resolved'}
              hint={outcome === 'dismissed' ? 'Required: why the fuel is explained.' : 'What was found, for the audit trail.'}
              value={notes}
              maxLength={2000}
              rows={4}
              error={error ?? undefined}
              onChange={(e) => setNotes(e.target.value)}
            />
            <p className="text-xs text-ink-subtle">Closing records your name and the time. It cannot be undone.</p>
          </section>
        )}

        {!canClose && !closed && <p className="text-sm text-ink-muted">A finance clerk or fleet manager closes anomalies. You can read them.</p>}
      </div>
    </Drawer>
  )
}

import { CheckCircle2, Lock, PencilLine } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { ConfirmDialog, MoneyDisplay, StatusBadge } from '@/components/shared'
import { Badge, Button, Drawer, useToast } from '@/components/ui'
import { formatDate } from '@/features/documents/expiry'
import { ApiError } from '@/lib/api/errors'
import { TYPE_LABELS, useCompleteRecord, useOpenWorkFor, useRecordFailures, type MaintenanceRecord } from './api'
import { FailureFields } from './FailureFields'
import { COMPONENT_LABELS, DETECTION_LABELS, MODE_LABELS, checkFailures, emptyFailure, type FailureDraft, type FailureInput } from './failures'

const OPEN = ['scheduled', 'open', 'in_progress']

function when(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return `${formatDate(d.toISOString().slice(0, 10))}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
}

/**
 * One repair: what was done, what failed, parts and costs. Open work can be
 * marked complete (after a confirmation that the vehicle's flag clears); a
 * repair that does not yet say what failed asks for it first (FMS-125).
 * Completed work is read-only, and a correction is a new record.
 */
export function RecordDrawer({
  record,
  onClose,
  canWrite,
  onCorrect,
}: {
  record: MaintenanceRecord | null
  onClose: () => void
  canWrite: boolean
  onCorrect: (record: MaintenanceRecord) => void
}) {
  const complete = useCompleteRecord()
  const recordFailures = useRecordFailures()
  const { toast } = useToast()
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<FailureDraft[]>([])
  const [failureErrors, setFailureErrors] = useState<Record<string, string>>({})
  const [pending, setPending] = useState<FailureInput[]>([])
  const openWork = useOpenWorkFor(record && OPEN.includes(record.status) ? record.vehicle_id : null)
  const others = (openWork.data ?? []).filter((r) => r.id !== record?.id).length
  const isOpen = record ? OPEN.includes(record.status) : false
  // A repair is completed only once it says what failed (FMS-125).
  const needsFailure = Boolean(record && isOpen && record.maintenance_type === 'corrective' && (record.failures ?? []).length === 0)

  useEffect(() => {
    setDrafts([emptyFailure()])
    setFailureErrors({})
  }, [record?.id])

  function askToComplete() {
    if (needsFailure) {
      const { failures, errors } = checkFailures(drafts, true)
      setFailureErrors(errors)
      if (Object.keys(errors).length > 0) return
      setPending(failures)
    } else setPending([])
    setConfirming(true)
  }

  async function markComplete() {
    if (!record) return
    setError(null)
    try {
      if (pending.length) await recordFailures.mutateAsync({ id: record.id, failures: pending })
      await complete.mutateAsync({ id: record.id, version: record.version })
      toast({
        title: 'Repair completed',
        description: others ? `${record.registration_number} stays flagged: ${others} other open job${others === 1 ? '' : 's'}.` : `${record.registration_number} is available for dispatch.`,
      })
      setConfirming(false)
      onClose()
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'CONFLICT_CONCURRENT_MODIFICATION'
          ? 'Someone else changed this record. Close it and open it again.'
          : err instanceof ApiError
            ? `Could not complete the repair (${err.code}).`
            : 'Could not reach the server. Try again.',
      )
    }
  }

  return (
    <>
      <Drawer
        open={record !== null && !confirming}
        onClose={onClose}
        title={record ? `${record.registration_number} · ${TYPE_LABELS[record.maintenance_type]}` : ''}
        description={record ? `Logged ${when(record.created_at)}` : undefined}
        footer={
          record &&
          canWrite && (
            <div className="flex w-full justify-end gap-2">
              {isOpen ? (
                <Button leadingIcon={<CheckCircle2 className="h-4 w-4" />} onClick={askToComplete}>
                  Mark as complete
                </Button>
              ) : (
                <Button variant="secondary" leadingIcon={<PencilLine className="h-4 w-4" />} onClick={() => onCorrect(record)}>
                  Log a correction
                </Button>
              )}
            </div>
          )
        }
      >
        {record && (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={record.status} />
              {record.completed_at && <span className="text-sm text-ink-muted">Completed {when(record.completed_at)}</span>}
            </div>
            {!isOpen && (
              <p className="flex items-start gap-2 rounded-control border border-line bg-surface-muted px-3.5 py-3 text-sm text-ink-muted">
                <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                Completed records cannot be changed. To correct one, log a new record with a note.
              </p>
            )}

            <Block title="Work done">
              <p className="whitespace-pre-line text-sm text-ink">{record.description || '—'}</p>
            </Block>

            {record.service_program && (
              <Block title="Service program">
                <p className="text-sm text-ink">{record.service_program.name}</p>
                <p className="mt-0.5 text-xs text-ink-subtle">
                  {isOpen ? 'Completing this work starts the program’s count again on this vehicle.' : 'The program’s count on this vehicle started again from this work.'}
                </p>
              </Block>
            )}

            {(record.failures ?? []).length > 0 ? (
              <Block title="What failed">
                <ul className="space-y-2">
                  {record.failures.map((f) => (
                    <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-line bg-surface-muted/60 px-3.5 py-2.5 text-sm">
                      <span>
                        <span className="block font-medium text-ink">
                          {COMPONENT_LABELS[f.component]} · {MODE_LABELS[f.failure_mode]}
                        </span>
                        <span className="block text-xs text-ink-subtle">{DETECTION_LABELS[f.detected_by]}</span>
                      </span>
                      <Badge tone={f.unplanned ? 'warning' : 'neutral'}>{f.unplanned ? 'Unplanned' : 'Planned work'}</Badge>
                    </li>
                  ))}
                </ul>
              </Block>
            ) : (
              needsFailure &&
              canWrite && (
                <Block title="What failed">
                  <p className="mb-3 text-sm text-ink-muted">Needed to complete this repair.</p>
                  <FailureFields drafts={drafts} onChange={setDrafts} errors={failureErrors} />
                </Block>
              )
            )}

            <dl className="grid grid-cols-2 gap-3">
              <Fact label="Labour">{record.labour_hours === null ? '—' : `${record.labour_hours} h`}</Fact>
              <Fact label="Odometer">{record.odometer_km === null ? '—' : `${record.odometer_km.toLocaleString()} km`}</Fact>
              <Fact label="Parts">
                <MoneyDisplay amountMinorUnits={record.parts_cost_cents} className="text-left" />
              </Fact>
              <Fact label="Total cost">
                <MoneyDisplay amountMinorUnits={record.total_cost_cents} className="text-left font-semibold" />
              </Fact>
            </dl>

            <Block title={`Parts used (${record.parts.length})`}>
              {record.parts.length === 0 ? (
                <p className="text-sm text-ink-subtle">No parts.</p>
              ) : (
                <table className="w-full text-sm">
                  <caption className="sr-only">Parts used</caption>
                  <thead>
                    <tr className="text-left text-xs uppercase tracking-wide text-ink-subtle">
                      <th className="pb-2 font-medium">Part</th>
                      <th className="pb-2 text-right font-medium">Qty</th>
                      <th className="pb-2 text-right font-medium">Line</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {record.parts.map((p) => (
                      <tr key={p.part_id}>
                        <td className="py-2">
                          <span className="block text-ink">{p.name}</span>
                          <span className="block text-xs text-ink-subtle">
                            {p.part_number} · <MoneyDisplay amountMinorUnits={p.unit_cost_cents} className="inline" /> each
                          </span>
                        </td>
                        <td className="tabular py-2 text-right">{p.quantity}</td>
                        <td className="py-2">
                          <MoneyDisplay amountMinorUnits={p.line_cost_cents} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Block>

            {record.notes && (
              <Block title="Notes">
                <p className="whitespace-pre-line text-sm text-ink">{record.notes}</p>
              </Block>
            )}
          </div>
        )}
      </Drawer>

      <ConfirmDialog
        open={record !== null && confirming}
        onClose={() => setConfirming(false)}
        title="Mark this repair as complete?"
        tone="default"
        action="Mark as complete"
        busy={complete.isPending || recordFailures.isPending}
        error={error}
        message={
          others > 0 ? (
            <p>
              The record becomes read-only. {record?.registration_number} has {others} other open job{others === 1 ? '' : 's'}, so its maintenance flag stays until{' '}
              {others === 1 ? 'that is' : 'those are'} done.
            </p>
          ) : (
            <p>
              The record becomes read-only. This <strong className="text-ink">clears {record?.registration_number}&apos;s maintenance flag</strong> and makes it available
              for dispatch.
            </p>
          )
        }
        onConfirm={markComplete}
      />
    </>
  )
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-subtle">{title}</h3>
      {children}
    </section>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-control border border-line bg-surface-muted/60 px-3.5 py-2.5">
      <dt className="text-xs text-ink-subtle">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium text-ink">{children}</dd>
    </div>
  )
}

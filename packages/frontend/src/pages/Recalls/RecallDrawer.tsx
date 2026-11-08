import { AlertCircle, CheckCircle2, Pencil } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Button, Drawer, Skeleton } from '@/components/ui'
import { RECALL_STATUS, recallTarget, useRecallVehicles, type Recall, type RecallVehicle } from '@/features/warranty'
import { formatDay } from '@/pages/VehicleHistory/format'
import { CompleteRecallDialog } from '@/pages/VehicleHistory/WarrantySection'

interface RecallDrawerProps {
  recall: Recall | null
  onClose: () => void
  /** Given to a user who may change the recall itself (maintenance:write and every depot). */
  onEdit?: () => void
  /** Whether the user may mark a vehicle's recall work done (maintenance:write). */
  canComplete: boolean
}

/** One recall (FMS-133): what it is, and the user's vehicles under it, open first, each opening its page. */
export function RecallDrawer({ recall, onClose, onEdit, canComplete }: RecallDrawerProps) {
  const vehicles = useRecallVehicles(recall?.id ?? null)
  const [completing, setCompleting] = useState<RecallVehicle | null>(null)

  return (
    <>
      <Drawer
        open={recall !== null && completing === null}
        onClose={onClose}
        title={recall?.campaign_code ?? 'Recall'}
        description={recall ? recallTarget(recall) : undefined}
        footer={
          <>
            {onEdit && (
              <Button variant="ghost" className="mr-auto" leadingIcon={<Pencil className="h-4 w-4" />} onClick={onEdit}>
                Edit recall
              </Button>
            )}
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
          </>
        }
      >
        {recall && (
          <div className="space-y-6">
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <Fact label="Defect" wide>
                {recall.description}
              </Fact>
              <Fact label="Remedy" wide>
                {recall.remedy ?? '—'}
              </Fact>
              <Fact label="Issued">{recall.issued_on ? formatDay(recall.issued_on) : '—'}</Fact>
              <Fact label="Recorded">{formatDay(recall.created_at)}</Fact>
            </dl>

            <section aria-labelledby="recall-vehicles-heading" className="space-y-3">
              <div>
                <h3 id="recall-vehicles-heading" className="text-sm font-semibold text-ink">
                  Your vehicles under it
                </h3>
                <p className="mt-0.5 text-xs text-ink-subtle">Open first. Work under a work order completes with it; a remedy done elsewhere is marked done here.</p>
              </div>
              {vehicles.isError ? (
                <p role="alert" className="flex items-start gap-2 rounded-control bg-danger-soft px-3 py-2.5 text-sm text-danger">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  The vehicles could not be loaded.
                  <button type="button" className="focus-ring rounded font-medium underline" onClick={() => void vehicles.refetch()}>
                    Try again
                  </button>
                </p>
              ) : vehicles.isPending ? (
                <div className="space-y-2" aria-hidden="true">
                  <Skeleton className="h-14 w-full rounded-control" />
                  <Skeleton className="h-14 w-full rounded-control" />
                </div>
              ) : vehicles.data.vehicles.length === 0 ? (
                <p className="rounded-control border border-line bg-surface px-3 py-2.5 text-sm text-ink-muted">None of your vehicles in service matches it.</p>
              ) : (
                <>
                  <ul className="divide-y divide-line rounded-card border border-line bg-surface">
                    {vehicles.data.vehicles.map((v) => (
                      <VehicleRow key={v.vehicle_id} vehicle={v} onComplete={canComplete && v.status !== 'completed' ? () => setCompleting(v) : undefined} />
                    ))}
                  </ul>
                  {vehicles.data.total > vehicles.data.vehicles.length && (
                    <p className="text-xs text-ink-subtle">
                      Showing {vehicles.data.vehicles.length} of {vehicles.data.total.toLocaleString('en-US')}: the open ones come first.
                    </p>
                  )}
                </>
              )}
            </section>
          </div>
        )}
      </Drawer>
      <CompleteRecallDialog recall={completing} onClose={() => setCompleting(null)} />
    </>
  )
}

function VehicleRow({ vehicle: v, onComplete }: { vehicle: RecallVehicle; onComplete?: () => void }) {
  const status = RECALL_STATUS[v.status]
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
      <div className="min-w-0">
        <p className="flex items-center gap-2">
          <Link to={`/vehicles/${v.vehicle_id}?section=warranty`} className="plate focus-ring rounded font-medium text-ink hover:underline">
            {v.registration_number}
          </Link>
          <Badge tone={status.tone}>{status.label}</Badge>
        </p>
        <p className="mt-0.5 text-xs text-ink-subtle">
          {v.status === 'completed' && v.completed_at ? `Done ${formatDay(v.completed_at)}` : `Listed ${formatDay(v.matched_at)}`}
          {v.maintenance_record_id ? ' · with a work order' : ''}
        </p>
      </div>
      {onComplete && (
        <Button size="sm" variant="secondary" leadingIcon={<CheckCircle2 className="h-3.5 w-3.5" />} onClick={onComplete} aria-label={`Mark ${v.campaign_code} done on ${v.registration_number}`}>
          Mark done
        </Button>
      )}
    </li>
  )
}

function Fact({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={`min-w-0 ${wide ? 'sm:col-span-2' : ''}`}>
      <dt className="text-xs text-ink-subtle">{label}</dt>
      <dd className="whitespace-pre-line text-ink [overflow-wrap:anywhere]">{children}</dd>
    </div>
  )
}

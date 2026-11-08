import { AlertCircle, BadgeCheck, CheckCircle2, Megaphone, Plus, ShieldCheck, ShieldOff } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { ConfirmDialog, EmptyState, MoneyDisplay } from '@/components/shared'
import { Badge, Button, Skeleton, useToast } from '@/components/ui'
import { useAuth } from '@/context/AuthContext'
import {
  RECALL_STATUS,
  WARRANTY_STATUS,
  coverEnd,
  coverName,
  remainingText,
  useUpdateRecallVehicle,
  useUpdateWarranty,
  useVehicleRecalls,
  useVehicleWarranties,
  type RecallVehicle,
  type Warranty,
} from '@/features/warranty'
import { ApiError } from '@/lib/api/errors'
import type { Vehicle } from '@/pages/Vehicles/types'
import { formatDay } from './format'
import { WarrantyFormDrawer } from './WarrantyFormDrawer'

/**
 * Warranty and recalls (FMS-133) on the vehicle's own page: the manufacturer recalls it is under, open ones
 * first, and its warranties with what is left of each and the repairs claimed under it. With maintenance:write,
 * a recall done elsewhere is marked done and a warranty is added or voided.
 */
export function WarrantySection({ vehicle }: { vehicle: Vehicle }) {
  const { hasPermission } = useAuth()
  const canWrite = hasPermission('maintenance:write')
  const recalls = useVehicleRecalls(vehicle.id)
  const warranties = useVehicleWarranties(vehicle.id)
  const [adding, setAdding] = useState(false)
  const [completing, setCompleting] = useState<RecallVehicle | null>(null)
  const [voiding, setVoiding] = useState<Warranty | null>(null)

  return (
    <div className="max-w-3xl space-y-8">
      <section aria-labelledby="recalls-heading" className="space-y-4">
        <Heading id="recalls-heading" title="Recalls" note="Manufacturer campaigns for its make, model and year." />
        {recalls.isError ? (
          <LoadError what="recalls" />
        ) : recalls.isPending ? (
          <Skeleton className="h-24 w-full rounded-card" />
        ) : recalls.data.length === 0 ? (
          <p className="flex items-center gap-2 rounded-card border border-line bg-surface px-4 py-3 text-sm text-ink-muted">
            <BadgeCheck className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
            No recall applies to it.
          </p>
        ) : (
          <ul className="space-y-3">
            {recalls.data.map((r) => (
              <RecallCard key={r.recall_id} recall={r} onComplete={canWrite && r.status !== 'completed' ? () => setCompleting(r) : undefined} />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="warranties-heading" className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <Heading id="warranties-heading" title="Warranties" note="A repair on something under warranty is marked claimable." />
          {canWrite && vehicle.status !== 'retired' && (
            <Button size="sm" variant="secondary" leadingIcon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>
              Add warranty
            </Button>
          )}
        </div>
        {warranties.isError ? (
          <LoadError what="warranties" />
        ) : warranties.isPending ? (
          <div className="space-y-3" aria-hidden="true">
            <Skeleton className="h-28 w-full rounded-card" />
            <Skeleton className="h-28 w-full rounded-card" />
          </div>
        ) : warranties.data.length === 0 ? (
          <EmptyState
            icon={<ShieldCheck />}
            heading="No warranty on record"
            description="Add the vehicle's warranties so repairs they cover are claimed, not paid twice."
            headingLevel="h3"
          />
        ) : (
          <ul className="space-y-3">
            {warranties.data.map((w) => (
              <WarrantyCard key={w.id} warranty={w} onVoid={canWrite && w.is_active ? () => setVoiding(w) : undefined} />
            ))}
          </ul>
        )}
      </section>

      <WarrantyFormDrawer open={adding} onClose={() => setAdding(false)} vehicle={vehicle} />
      <CompleteRecallDialog recall={completing} onClose={() => setCompleting(null)} />
      <VoidWarrantyDialog warranty={voiding} onClose={() => setVoiding(null)} />
    </div>
  )
}

function Heading({ id, title, note }: { id: string; title: string; note: string }) {
  return (
    <div>
      <h2 id={id} className="text-base font-semibold text-ink">
        {title}
      </h2>
      <p className="mt-0.5 text-sm text-ink-muted">{note}</p>
    </div>
  )
}

function LoadError({ what }: { what: string }) {
  return (
    <p role="alert" className="flex items-start gap-2 rounded-control bg-danger-soft px-3 py-2.5 text-sm text-danger">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      The {what} could not be loaded. Reload the page to try again.
    </p>
  )
}

function RecallCard({ recall, onComplete }: { recall: RecallVehicle; onComplete?: () => void }) {
  const status = RECALL_STATUS[recall.status]
  return (
    <li className={`rounded-card border bg-surface p-4 shadow-soft ${recall.status === 'open' ? 'border-danger/30' : 'border-line'}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 font-semibold text-ink">
            <Megaphone className="h-4 w-4 text-ink-subtle" aria-hidden="true" />
            <span className="tabular">{recall.campaign_code}</span>
            <Badge tone={status.tone}>{status.label}</Badge>
          </p>
          <p className="mt-1 text-sm text-ink">{recall.description}</p>
        </div>
        {onComplete && (
          <Button size="sm" variant="secondary" leadingIcon={<CheckCircle2 className="h-3.5 w-3.5" />} onClick={onComplete} aria-label={`Mark recall ${recall.campaign_code} done`}>
            Mark done
          </Button>
        )}
      </div>
      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <Fact label="Remedy">{recall.remedy ?? '—'}</Fact>
        <Fact label={recall.status === 'completed' ? 'Done' : 'Listed'}>
          {recall.status === 'completed' && recall.completed_at ? formatDay(recall.completed_at) : formatDay(recall.matched_at)}
          {recall.maintenance_record_id ? ' · with a work order' : ''}
        </Fact>
      </dl>
      {recall.notes && <p className="mt-3 text-xs text-ink-subtle">{recall.notes}</p>}
    </li>
  )
}

function WarrantyCard({ warranty: w, onVoid }: { warranty: Warranty; onVoid?: () => void }) {
  const status = WARRANTY_STATUS[w.status]
  const claimed = w.claims.claimable + w.claims.submitted + w.claims.approved + w.claims.rejected
  return (
    <li className={`rounded-card border border-line bg-surface p-4 shadow-soft ${w.is_active ? '' : 'opacity-70'}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 font-semibold text-ink">
            {coverName(w)}
            <Badge tone={status.tone}>{status.label}</Badge>
          </p>
          <p className="mt-1 text-sm text-ink">{w.provider}</p>
          <p className={`mt-0.5 text-sm ${w.status === 'expiring' ? 'font-medium text-warning' : 'text-ink-muted'}`}>{remainingText(w)}</p>
        </div>
        {onVoid && (
          <Button size="sm" variant="ghost" leadingIcon={<ShieldOff className="h-3.5 w-3.5" />} onClick={onVoid} aria-label={`Void the ${coverName(w).toLowerCase()} warranty from ${w.provider}`}>
            Void
          </Button>
        )}
      </div>
      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <Fact label="Cover">
          {formatDay(w.starts_on)} to {coverEnd(w)}
        </Fact>
        <Fact label="Claims">
          {claimed === 0 ? (
            'None yet'
          ) : (
            <>
              {[
                w.claims.claimable && `${w.claims.claimable} to claim`,
                w.claims.submitted && `${w.claims.submitted} submitted`,
                w.claims.approved && `${w.claims.approved} approved`,
                w.claims.rejected && `${w.claims.rejected} rejected`,
              ]
                .filter(Boolean)
                .join(', ')}
              {w.claims.recovered_cents > 0 && (
                <span className="block">
                  Recovered <MoneyDisplay amountMinorUnits={w.claims.recovered_cents} className="inline" />
                </span>
              )}
            </>
          )}
        </Fact>
      </dl>
      {w.coverage && <p className="mt-3 text-xs text-ink-subtle">Covers: {w.coverage}</p>}
    </li>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-subtle">{label}</dt>
      <dd className="text-ink-muted [overflow-wrap:anywhere]">{children}</dd>
    </div>
  )
}

const failure = (err: unknown, what: string) =>
  err instanceof ApiError
    ? err.code === 'CONFLICT_CONCURRENT_MODIFICATION'
      ? 'Someone else changed it just now. Close this and try again.'
      : err.code === 'CONFLICT_INVALID_STATE_TRANSITION'
        ? 'It is already done.'
        : `${what} (${err.code}).`
    : 'Could not reach the server. Try again.'

function CompleteRecallDialog({ recall, onClose }: { recall: RecallVehicle | null; onClose: () => void }) {
  const update = useUpdateRecallVehicle()
  const { toast } = useToast()
  const [error, setError] = useState<string | null>(null)

  async function confirm() {
    if (!recall) return
    setError(null)
    try {
      await update.mutateAsync({ recallId: recall.recall_id, vehicleId: recall.vehicle_id, status: 'completed' })
      toast({ title: 'Recall done', description: `${recall.campaign_code} on ${recall.registration_number}.` })
      onClose()
    } catch (err) {
      setError(failure(err, 'The recall could not be marked done'))
    }
  }

  return (
    <ConfirmDialog
      open={recall !== null}
      onClose={() => {
        setError(null)
        onClose()
      }}
      title={`Mark ${recall?.campaign_code ?? ''} done?`}
      tone="default"
      action="Mark done"
      busy={update.isPending}
      error={error}
      message={
        <p>
          For a remedy carried out without a work order here, at the dealer for example. It is recorded as done today and cannot be reopened. Work done under a work order
          completes with it.
        </p>
      }
      onConfirm={confirm}
    />
  )
}

function VoidWarrantyDialog({ warranty, onClose }: { warranty: Warranty | null; onClose: () => void }) {
  const update = useUpdateWarranty()
  const { toast } = useToast()
  const [error, setError] = useState<string | null>(null)

  async function confirm() {
    if (!warranty) return
    setError(null)
    try {
      await update.mutateAsync({ id: warranty.id, version: warranty.version, patch: { is_active: false } })
      toast({ title: 'Warranty voided', description: `${coverName(warranty)}, ${warranty.provider}.` })
      onClose()
    } catch (err) {
      setError(failure(err, 'The warranty could not be voided'))
    }
  }

  return (
    <ConfirmDialog
      open={warranty !== null}
      onClose={() => {
        setError(null)
        onClose()
      }}
      title="Void this warranty?"
      action="Void warranty"
      busy={update.isPending}
      error={error}
      message={
        <p>
          For a warranty entered by mistake or cancelled. Repairs not yet claimed under it stop being claimable; claims already submitted, approved or rejected stay as
          they are.
        </p>
      }
      onConfirm={confirm}
    />
  )
}

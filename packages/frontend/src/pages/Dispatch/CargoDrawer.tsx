import { AlertCircle } from 'lucide-react'
import { useEffect, useId, useState, type FormEvent } from 'react'
import { Button, Drawer, SelectField, TextField, useToast } from '@/components/ui'
import { ApiError } from '@/lib/api/errors'
import { useUpdateTripCargo, type CargoChange } from './api'
import { CARGO_KINDS, cargoSummary, parseCargoWeight } from './cargo'
import { tripTitle } from './format'
import type { CargoKind, Trip } from './types'

interface CargoDrawerProps {
  open: boolean
  onClose: () => void
  trip: Trip | null
}

const MESSAGES: Record<string, string> = {
  CONFLICT_CONCURRENT_MODIFICATION: 'Someone changed this trip a moment ago. Close the panel to see their change, then try again.',
  CONFLICT_INVALID_STATE_TRANSITION: 'The cargo is set before the trip starts: this one has started, finished or been cancelled.',
  NOT_FOUND: 'This trip no longer exists or is outside your depots.',
}

/**
 * What a trip carries (FMS-153), before it starts. The weight is optional, and never more than the assigned
 * vehicle's payload: the API refuses it, and says so here. The job load follows from it.
 */
export function CargoDrawer({ open, onClose, trip: current }: CargoDrawerProps) {
  const formId = useId()
  const { toast } = useToast()
  const update = useUpdateTripCargo()
  // As it was when the panel opened: its version goes in If-Match.
  const [trip, setTrip] = useState<Trip | null>(current)
  const [kind, setKind] = useState<CargoKind>('general')
  const [weight, setWeight] = useState('')
  const [weightError, setWeightError] = useState<string | undefined>()
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setTrip(current)
    setKind(current?.cargo_kind ?? 'general')
    setWeight(current?.cargo_weight_kg != null ? String(current.cargo_weight_kg) : '')
    setWeightError(undefined)
    setFormError(null)
    update.reset()
  }, [open])

  if (!trip) return null

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (!trip || update.isPending) return
    setFormError(null)
    const parsed = parseCargoWeight(weight)
    if (!parsed.ok) return setWeightError(parsed.error)
    const change: CargoChange = {}
    if (kind !== (trip.cargo_kind ?? 'general')) change.cargo_kind = kind
    if (parsed.value !== (trip.cargo_weight_kg ?? null)) change.cargo_weight_kg = parsed.value
    if (Object.keys(change).length === 0) return setFormError('Change the cargo or its weight first.')
    try {
      const saved = await update.mutateAsync({ trip, change })
      toast({ title: 'Cargo changed', description: `${tripTitle(saved)}: ${cargoSummary(saved)}.` })
      onClose()
    } catch (err) {
      if (!(err instanceof ApiError)) return setFormError('Could not reach the server. Check your connection and try again.')
      if (err.details.some((d) => d.field === 'cargo_weight_kg')) return setWeightError(err.message)
      setFormError(MESSAGES[err.code] ?? `The cargo could not be changed (${err.code}).`)
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Change cargo"
      description={`${tripTitle(trip)} · now ${cargoSummary(trip).toLowerCase()}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={update.isPending}>
            Save cargo
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={onSubmit} noValidate className="space-y-6">
        <div role="alert" className="empty:-mb-6">
          {formError && (
            <div className="flex animate-fade-in items-start gap-2.5 rounded-control border border-danger/25 bg-danger-soft px-3.5 py-3 text-sm text-danger">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {formError}
            </div>
          )}
        </div>
        <CargoFields
          kind={kind}
          weight={weight}
          weightError={weightError}
          onKind={setKind}
          onWeight={(v) => {
            setWeight(v)
            setWeightError(undefined)
          }}
        />
      </form>
    </Drawer>
  )
}

interface CargoFieldsProps {
  kind: CargoKind
  weight: string
  weightError?: string
  onKind: (kind: CargoKind) => void
  onWeight: (weight: string) => void
}

/** The cargo's kind and weight (FMS-153), as the new-trip and change-cargo drawers ask for them. */
export function CargoFields({ kind, weight, weightError, onKind, onWeight }: CargoFieldsProps) {
  return (
    <fieldset className="space-y-1">
      <legend className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-subtle">What it carries</legend>
      <div className="grid gap-x-4 sm:grid-cols-2">
        <SelectField label="Cargo" value={kind} onChange={(e) => onKind(e.target.value as CargoKind)} options={CARGO_KINDS} />
        <TextField
          label="Weight"
          optional
          inputMode="decimal"
          value={weight}
          onChange={(e) => onWeight(e.target.value)}
          error={weightError}
          trailing={<span className="text-sm">kg</span>}
          hint="With passengers, about 75 kg each. Never more than the vehicle carries."
          autoComplete="off"
        />
      </div>
    </fieldset>
  )
}

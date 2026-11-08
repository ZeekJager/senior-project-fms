import { AlertCircle } from 'lucide-react'
import { useEffect, useId, useState, type FormEvent } from 'react'
import { Button, Drawer, SelectField, TextAreaField, TextField, useToast } from '@/components/ui'
import { useCreateWarranty, type WarrantyInput } from '@/features/warranty'
import { ApiError } from '@/lib/api/errors'
import { COMPONENT_LABELS, FAILURE_COMPONENTS, type FailureComponent } from '@/pages/Maintenance/failures'
import type { Vehicle } from '@/pages/Vehicles/types'

interface Values {
  component: FailureComponent | ''
  provider: string
  coverage: string
  starts_on: string
  ends_on: string
  ends_km: string
  terms: string
}

type Errors = Partial<Record<keyof Values | 'end', string>>

const EMPTY: Values = { component: '', provider: '', coverage: '', starts_on: '', ends_on: '', ends_km: '', terms: '' }

const KM = /^\d{1,7}(\.\d)?$/

/** The form's checks, as the API makes them; the input to send when they pass. */
export function checkWarranty(vehicleId: string, v: Values): { errors: Errors; input: WarrantyInput | null } {
  const errors: Errors = {}
  if (!v.provider.trim()) errors.provider = 'Who gives the warranty: the dealer, the manufacturer or the parts supplier.'
  if (!v.starts_on) errors.starts_on = 'When cover starts.'
  const km = v.ends_km.trim().replace(/,/g, '')
  if (km && (!KM.test(km) || Number(km) <= 0)) errors.ends_km = 'An odometer reading in kilometres, e.g. 100000.'
  if (!v.ends_on && !km) errors.end = 'Give an end date, an odometer reading, or both.'
  if (v.ends_on && v.starts_on && v.ends_on < v.starts_on) errors.ends_on = 'On or after the start date.'
  if (Object.keys(errors).length > 0) return { errors, input: null }
  return {
    errors,
    input: {
      vehicle_id: vehicleId,
      component: v.component || null,
      provider: v.provider.trim(),
      coverage: v.coverage.trim() || null,
      starts_on: v.starts_on,
      ends_on: v.ends_on || null,
      ends_km: km ? Number(km) : null,
      terms: v.terms.trim() || null,
    },
  }
}

/**
 * Record a vehicle's warranty (FMS-133): what it covers, from whom, and until when, by date, odometer or both.
 * Saving judges the vehicle's repairs not yet claimed against it at once.
 */
export function WarrantyFormDrawer({ open, onClose, vehicle }: { open: boolean; onClose: () => void; vehicle: Vehicle }) {
  const formId = useId()
  const { toast } = useToast()
  const create = useCreateWarranty()
  const [values, setValues] = useState<Values>(EMPTY)
  const [errors, setErrors] = useState<Errors>({})
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setValues(EMPTY)
    setErrors({})
    setFormError(null)
  }, [open])

  function set<K extends keyof Values>(field: K, value: Values[K]) {
    setValues((current) => ({ ...current, [field]: value }))
    setErrors((current) => {
      const next = { ...current }
      delete next[field]
      if (field === 'ends_on' || field === 'ends_km') delete next.end
      return next
    })
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (create.isPending) return
    setFormError(null)
    const { errors: found, input } = checkWarranty(vehicle.id, values)
    setErrors(found)
    if (!input) return
    try {
      const saved = await create.mutateAsync(input)
      const claimable = saved.claims.claimable
      toast({
        title: 'Warranty added',
        description: claimable > 0 ? `${claimable} earlier repair${claimable === 1 ? ' is' : 's are'} claimable under it.` : `${vehicle.registration_number}: repairs it covers are marked claimable.`,
      })
      onClose()
    } catch (err) {
      if (!(err instanceof ApiError)) return setFormError('Could not reach the server. Check your connection and try again.')
      const reason = err.details[0]?.reason
      if (reason === 'end_required') return setErrors({ end: 'Give an end date, an odometer reading, or both.' })
      if (reason === 'before_starts_on') return setErrors({ ends_on: 'On or after the start date.' })
      setFormError(err.code === 'VALIDATION_FAILED' ? 'Check the values and try again.' : `The warranty could not be saved (${err.code}).`)
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Add warranty"
      description={`${vehicle.registration_number}. Repairs it covers are marked claimable, and its end is warned of 30 days ahead.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={create.isPending}>
            Add warranty
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={onSubmit} noValidate className="space-y-5">
        <div role="alert" className="empty:-mb-5">
          {formError && (
            <div className="flex animate-fade-in items-start gap-2.5 rounded-control border border-danger/25 bg-danger-soft px-3.5 py-3 text-sm text-danger">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {formError}
            </div>
          )}
        </div>
        <SelectField
          label="Covers"
          value={values.component}
          onChange={(e) => set('component', e.target.value as Values['component'])}
          options={[{ value: '', label: 'The whole vehicle' }, ...FAILURE_COMPONENTS.map((c) => ({ value: c, label: COMPONENT_LABELS[c] }))]}
          hint="A repair is claimable when what failed is covered."
        />
        <TextField label="Provider" value={values.provider} onChange={(e) => set('provider', e.target.value)} error={errors.provider} autoComplete="off" maxLength={255} />
        <TextAreaField label="What it covers" optional rows={2} value={values.coverage} onChange={(e) => set('coverage', e.target.value)} maxLength={2000} />
        <TextField label="Starts" type="date" value={values.starts_on} onChange={(e) => set('starts_on', e.target.value)} error={errors.starts_on} />
        <fieldset className="space-y-1">
          <legend className="mb-2 text-sm font-medium text-ink">Ends</legend>
          <p className="mb-3 text-xs text-ink-subtle">On a date, at an odometer reading, or both: whichever comes first.</p>
          <div className="grid gap-x-4 sm:grid-cols-2">
            <TextField label="End date" optional type="date" value={values.ends_on} onChange={(e) => set('ends_on', e.target.value)} error={errors.ends_on} />
            <TextField
              label="End odometer"
              optional
              inputMode="decimal"
              value={values.ends_km}
              onChange={(e) => set('ends_km', e.target.value)}
              error={errors.ends_km}
              trailing={<span className="text-xs">km</span>}
            />
          </div>
          <div role="alert" className="empty:hidden">
            {errors.end && <p className="text-sm font-medium text-danger">{errors.end}</p>}
          </div>
        </fieldset>
        <TextAreaField label="Terms" optional rows={3} value={values.terms} onChange={(e) => set('terms', e.target.value)} maxLength={5000} hint="Claim conditions, excess, how to file." />
      </form>
    </Drawer>
  )
}

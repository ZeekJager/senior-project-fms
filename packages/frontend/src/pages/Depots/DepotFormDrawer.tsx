import { AlertCircle, Archive, RotateCcw } from 'lucide-react'
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import { Button, Drawer, TextField, useToast } from '@/components/ui'
import { ApiError } from '@/lib/api/errors'
import { useCreateDepot, useReactivateDepot, useUpdateDepot, type DepotRecord } from './api'
import {
  EMPTY_DEPOT,
  changedDepotFields,
  depotFormField,
  formFromDepot,
  validateDepotForm,
  type DepotField,
  type DepotFieldErrors,
  type DepotFormValues,
} from './depotForm'

interface DepotFormDrawerProps {
  open: boolean
  onClose: () => void
  /** Null: add a depot. */
  depot: DepotRecord | null
  /** Given for a live depot: shown in the footer, apart from Save. */
  onDeactivate?: () => void
}

const SERVER_MESSAGES: Record<string, string> = {
  CONFLICT_CONCURRENT_MODIFICATION: 'Someone else changed this depot while you were editing. Close the panel to see their changes, then edit again.',
  CONFLICT_INVALID_STATE_TRANSITION: 'This depot was deactivated meanwhile. Restore it before changing it.',
  NOT_FOUND: 'This depot no longer exists.',
}

/**
 * Add or edit a depot (S-26, FMS-80): a slide-in panel over the list. A deactivated depot is read here and
 * restored from the footer; it cannot be edited until then.
 */
export function DepotFormDrawer({ open, onClose, depot, onDeactivate }: DepotFormDrawerProps) {
  const formId = useId()
  const { toast } = useToast()
  const [values, setValues] = useState<DepotFormValues>(EMPTY_DEPOT)
  const [errors, setErrors] = useState<DepotFieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const create = useCreateDepot()
  const update = useUpdateDepot()
  const reactivate = useReactivateDepot()
  const saving = create.isPending || update.isPending || reactivate.isPending
  const inactive = depot !== null && !depot.is_active

  useEffect(() => {
    if (!open) return
    setValues(depot ? formFromDepot(depot) : EMPTY_DEPOT)
    setErrors({})
    setFormError(null)
  }, [open, depot])

  function set(field: DepotField, value: string) {
    setValues((current) => ({ ...current, [field]: value }))
    if (errors[field]) setErrors((current) => Object.fromEntries(Object.entries(current).filter(([k]) => k !== field)))
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (saving || inactive) return
    setFormError(null)
    const { errors: found, input } = validateDepotForm(values)
    setErrors(found)
    if (!input) return
    try {
      if (depot) {
        const patch = changedDepotFields(input, depot)
        if (Object.keys(patch).length > 0) await update.mutateAsync({ id: depot.id, version: depot.version, patch })
        toast({ title: 'Changes saved', description: `${input.name} is up to date.` })
      } else {
        await create.mutateAsync(input)
        toast({ title: 'Depot added', description: `${input.name} can now hold vehicles, drivers and staff.` })
      }
      onClose()
    } catch (err) {
      showServerError(err)
    }
  }

  async function restore() {
    if (!depot || saving) return
    try {
      await reactivate.mutateAsync(depot.id)
      toast({ title: 'Depot restored', description: `${depot.name} is back in every depot list.` })
      onClose()
    } catch (err) {
      showServerError(err)
    }
  }

  function showServerError(err: unknown) {
    if (!(err instanceof ApiError)) {
      setFormError('Could not reach the server. Check your connection and try again.')
      return
    }
    if (err.code === 'CONFLICT_DUPLICATE' && err.details.some((d) => d.field === 'code')) return setErrors({ code: 'Another depot already has this code.' })
    const fieldErrors: DepotFieldErrors = {}
    for (const detail of err.details) {
      const field = depotFormField(detail.field)
      if (field) fieldErrors[field] = detail.reason === 'coordinates_pair' ? 'Give both latitude and longitude, or neither.' : 'Check this value.'
    }
    if (Object.keys(fieldErrors).length > 0) return setErrors(fieldErrors)
    setFormError(SERVER_MESSAGES[err.code] ?? `The depot could not be saved (${err.code}).`)
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={depot ? (inactive ? depot.name : `Edit ${depot.name}`) : 'Add depot'}
      description={
        inactive
          ? 'Inactive: out of every depot list, and nothing new can be put in it. Its records stay.'
          : depot
            ? 'Changes are saved to the audit log.'
            : 'A yard that vehicles, drivers and staff belong to.'
      }
      footer={
        <>
          {depot && !inactive && onDeactivate && (
            <Button variant="ghost" leadingIcon={<Archive className="h-4 w-4" />} className="mr-auto !text-danger hover:!bg-danger-soft hover:!text-danger" onClick={onDeactivate}>
              Deactivate depot
            </Button>
          )}
          {inactive ? (
            <>
              <Button variant="secondary" onClick={onClose}>
                Close
              </Button>
              <Button leadingIcon={<RotateCcw className="h-4 w-4" />} onClick={() => void restore()} loading={reactivate.isPending}>
                Restore depot
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" form={formId} loading={saving}>
                {depot ? 'Save changes' : 'Add depot'}
              </Button>
            </>
          )}
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

        <fieldset disabled={inactive} className="space-y-6 disabled:opacity-70">
          <Section title="Depot">
            <TextField label="Name" value={values.name} onChange={(e) => set('name', e.target.value)} error={errors.name} hint="As staff call it, e.g. Adama Hub." autoComplete="off" />
            <TextField
              label="Code"
              optional
              value={values.code}
              onChange={(e) => set('code', e.target.value)}
              error={errors.code}
              hint="Short and unique; driver imports use it, e.g. ADM-01."
              autoComplete="off"
              spellCheck={false}
              className="[&_input]:uppercase"
            />
            <TextField
              label="Capacity"
              optional
              inputMode="numeric"
              value={values.capacity}
              onChange={(e) => set('capacity', e.target.value)}
              error={errors.capacity}
              trailing={<span className="text-xs">vehicles</span>}
              autoComplete="off"
            />
          </Section>

          <Section title="Where">
            <TextField label="Location" value={values.location} onChange={(e) => set('location', e.target.value)} error={errors.location} hint="Shown beside the name in lists, e.g. Adama." autoComplete="off" />
            <TextField label="Address" optional value={values.address} onChange={(e) => set('address', e.target.value)} error={errors.address} autoComplete="off" />
            <div className="grid gap-x-3 sm:grid-cols-2">
              <TextField label="City" optional value={values.city} onChange={(e) => set('city', e.target.value)} error={errors.city} autoComplete="off" />
              <TextField label="Country" optional value={values.country} onChange={(e) => set('country', e.target.value)} error={errors.country} autoComplete="off" />
            </div>
            <TextField
              label="Coordinates"
              optional
              inputMode="decimal"
              value={values.coordinates}
              onChange={(e) => set('coordinates', e.target.value)}
              error={errors.coordinates}
              hint="Latitude, longitude: paste from a map, e.g. 8.5400, 39.2700."
              autoComplete="off"
              spellCheck={false}
            />
            <TextField
              label="Time zone"
              optional
              value={values.timezone}
              onChange={(e) => set('timezone', e.target.value)}
              error={errors.timezone}
              hint="Africa/Addis_Ababa for every depot in Ethiopia."
              autoComplete="off"
              spellCheck={false}
            />
          </Section>
        </fieldset>
      </form>
    </Drawer>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-1">
      <legend className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-subtle">{title}</legend>
      {children}
    </fieldset>
  )
}

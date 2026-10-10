import { AlertCircle, CheckCircle2, XCircle } from 'lucide-react'
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import { Button, Drawer, SelectField, Spinner, TextField, useToast } from '@/components/ui'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { ApiError } from '@/lib/api/errors'
import { useCreateVehicle, usePlateCheck, useUpdateVehicle } from './api'
import { normalizePlate } from './filters'
import { FUEL_TYPES, FUEL_TYPE_LABELS, VEHICLE_TYPES, VEHICLE_TYPE_LABELS, type Depot, type Vehicle } from './types'
import {
  API_FIELDS,
  EMPTY_FORM,
  changedFields,
  formFromVehicle,
  validateVehicleForm,
  type FieldErrors,
  type FieldName,
  type VehicleFormValues,
} from './vehicleForm'

interface VehicleFormDrawerProps {
  open: boolean
  onClose: () => void
  /** Null: register a new vehicle. */
  vehicle: Vehicle | null
  depots: Depot[]
  /** Preselected depot for a new vehicle (the filter's, or the only one). */
  defaultDepotId?: string
}

const CONFLICT_MESSAGES: Record<string, string> = {
  CONFLICT_CONCURRENT_MODIFICATION: 'Someone else changed this vehicle while you were editing. Close the panel to see their changes, then edit again.',
  CONFLICT_INVALID_STATE_TRANSITION: 'This vehicle has been retired and can no longer be changed.',
  NOT_FOUND: 'This vehicle no longer exists or is outside your depots.',
}

/**
 * S-04 add / edit: a slide-in panel over the list, not a separate page.
 * The plate is checked for duplicates as it is typed (debounced); the API
 * repeats every check on save.
 */
export function VehicleFormDrawer({ open, onClose, vehicle, depots, defaultDepotId }: VehicleFormDrawerProps) {
  const formId = useId()
  const { toast } = useToast()
  const [values, setValues] = useState<VehicleFormValues>(EMPTY_FORM)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const create = useCreateVehicle()
  const update = useUpdateVehicle()
  const saving = create.isPending || update.isPending

  useEffect(() => {
    if (!open) return
    setValues(vehicle ? formFromVehicle(vehicle) : { ...EMPTY_FORM, depot_id: defaultDepotId ?? (depots.length === 1 ? depots[0].id : '') })
    setErrors({})
    setFormError(null)
  }, [open, vehicle, defaultDepotId, depots])

  // Duplicate-plate check: only for a plate that is new (or changed) and well-formed.
  const plate = normalizePlate(values.registration_number)
  const debouncedPlate = useDebouncedValue(plate, 400)
  const plateChanged = plate !== '' && plate !== vehicle?.registration_number
  const check = usePlateCheck(debouncedPlate, open && plateChanged && debouncedPlate === plate && !errors.registration_number)
  const duplicate = plateChanged && debouncedPlate === plate && check.data ? check.data : null
  const plateError = errors.registration_number ?? (duplicate ? `${plate} is already registered.` : null)
  const plateAvailable = plateChanged && debouncedPlate === plate && check.isSuccess && !check.isFetching && !duplicate

  function set<K extends FieldName>(field: K, value: VehicleFormValues[K]) {
    setValues((current) => ({ ...current, [field]: value }))
    if (errors[field]) {
      setErrors((current) => {
        const next = { ...current }
        delete next[field]
        return next
      })
    }
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (saving) return
    setFormError(null)
    const { errors: found, input } = validateVehicleForm(values)
    if (duplicate) found.registration_number = `${plate} is already registered.`
    setErrors(found)
    if (!input || Object.keys(found).length > 0) return

    try {
      if (vehicle) {
        const patch = changedFields(input, vehicle)
        if (Object.keys(patch).length > 0) await update.mutateAsync({ id: vehicle.id, version: vehicle.version, patch })
        toast({ title: 'Changes saved', description: `${input.registration_number} is up to date.` })
      } else {
        await create.mutateAsync(input)
        toast({ title: 'Vehicle registered', description: `${input.registration_number} has been added to the fleet.` })
      }
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
    if (err.code === 'CONFLICT_DUPLICATE_PLATE') return setErrors({ registration_number: `${plate} is already registered.` })
    if (err.code === 'CONFLICT_DUPLICATE' && err.details.some((d) => d.field === 'vin')) return setErrors({ vin: 'Another vehicle has this VIN.' })
    if (err.code === 'CONFLICT_ODOMETER_REGRESSION') return setErrors({ odometer_km: 'Lower than the current reading; an odometer only goes up.' })
    const fieldErrors: FieldErrors = {}
    for (const detail of err.details) {
      const field = detail.field ? API_FIELDS[detail.field] : undefined
      if (field) fieldErrors[field] = detail.reason === 'references_missing_record' ? 'Choose one of your depots.' : 'Check this value.'
    }
    if (Object.keys(fieldErrors).length > 0) return setErrors(fieldErrors)
    setFormError(CONFLICT_MESSAGES[err.code] ?? `The vehicle could not be saved (${err.code}).`)
  }

  let plateStatus: ReactNode = null
  if (plateChanged && !errors.registration_number) {
    if (debouncedPlate !== plate || check.isFetching) plateStatus = <Spinner className="h-4 w-4" />
    else if (duplicate) plateStatus = <XCircle className="h-4 w-4 text-danger" aria-hidden="true" />
    else if (check.isSuccess) plateStatus = <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />
  }

  const electric = values.fuel_type === 'electric'

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={vehicle ? `Edit ${vehicle.registration_number}` : 'Add vehicle'}
      description={vehicle ? 'Changes are saved to the audit log.' : 'Register a vehicle in one of your depots.'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={saving}>
            {vehicle ? 'Save changes' : 'Add vehicle'}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={onSubmit} noValidate className="space-y-6">
        <div role="alert">
          {formError && (
            <div className="flex animate-fade-in items-start gap-2.5 rounded-control border border-danger/25 bg-danger-soft px-3.5 py-3 text-sm text-danger">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {formError}
            </div>
          )}
        </div>

        <Section title="Identity">
          <TextField
            label="Registration number"
            value={values.registration_number}
            onChange={(e) => set('registration_number', e.target.value)}
            error={plateError}
            hint={plateAvailable ? `${plate} is available.` : 'Stored in capitals, e.g. AA 3-12345.'}
            trailing={plateStatus}
            autoComplete="off"
            spellCheck={false}
          />
          <TextField
            label="VIN"
            optional
            value={values.vin}
            onChange={(e) => set('vin', e.target.value)}
            error={errors.vin}
            hint="17 characters, on the chassis plate."
            autoComplete="off"
            spellCheck={false}
            maxLength={17}
          />
        </Section>

        <Section title="Vehicle">
          <div className="grid gap-x-4 sm:grid-cols-2">
            <TextField label="Make" value={values.make} onChange={(e) => set('make', e.target.value)} error={errors.make} />
            <TextField label="Model" value={values.model} onChange={(e) => set('model', e.target.value)} error={errors.model} />
            <SelectField
              label="Type"
              value={values.vehicle_type}
              onChange={(e) => set('vehicle_type', e.target.value as VehicleFormValues['vehicle_type'])}
              error={errors.vehicle_type}
              placeholder="Choose…"
              options={VEHICLE_TYPES.map((t) => ({ value: t, label: VEHICLE_TYPE_LABELS[t] }))}
            />
            <TextField
              label="Year"
              optional
              inputMode="numeric"
              value={values.year}
              onChange={(e) => set('year', e.target.value)}
              error={errors.year}
              maxLength={4}
            />
          </div>
        </Section>

        <Section title="Operation">
          <SelectField
            label="Depot"
            value={values.depot_id}
            onChange={(e) => set('depot_id', e.target.value)}
            error={errors.depot_id}
            placeholder="Choose a depot…"
            options={depots.map((d) => ({ value: d.id, label: d.name }))}
          />
          <div className="grid gap-x-4 sm:grid-cols-2">
            <SelectField
              label="Fuel"
              value={values.fuel_type}
              onChange={(e) => set('fuel_type', e.target.value as VehicleFormValues['fuel_type'])}
              error={errors.fuel_type}
              placeholder="Choose…"
              options={FUEL_TYPES.map((t) => ({ value: t, label: FUEL_TYPE_LABELS[t] }))}
            />
            <TextField
              label="Consumption"
              inputMode="decimal"
              value={electric ? '' : values.efficiency}
              onChange={(e) => set('efficiency', e.target.value)}
              error={electric ? null : errors.efficiency}
              hint={electric ? 'Not used for electric vehicles.' : 'Expected use, for fuel reconciliation.'}
              disabled={electric}
              trailing={<span className="text-xs">L/100 km</span>}
            />
          </div>
          <TextField
            label="Odometer"
            optional={!vehicle}
            inputMode="decimal"
            value={values.odometer_km}
            onChange={(e) => set('odometer_km', e.target.value)}
            error={errors.odometer_km}
            hint={vehicle ? 'Readings only go up.' : 'Current reading, if known.'}
            trailing={<span className="text-xs">km</span>}
          />
        </Section>
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

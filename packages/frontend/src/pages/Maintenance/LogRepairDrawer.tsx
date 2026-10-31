import { AlertCircle, AlertTriangle, PackagePlus, Trash2 } from 'lucide-react'
import { useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { ConfirmDialog, MoneyDisplay, MoneyInput } from '@/components/shared'
import { Badge, Button, Combobox, Drawer, IconButton, SelectField, TextAreaField, TextField, useToast, type ComboboxOption } from '@/components/ui'
import { STATUS_LABELS, useVehicleServiceDue } from '@/features/service-due'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { ApiError } from '@/lib/api/errors'
import type { Vehicle } from '@/pages/Vehicles/types'
import {
  MAINTENANCE_TYPES,
  TYPE_LABELS,
  useCompleteRecord,
  useCreateRecord,
  useFlaggedVehicles,
  useOpenWorkFor,
  usePartSearch,
  useVehicleSearch,
  type InventoryPart,
  type MaintenanceType,
  type RecordInput,
} from './api'
import { FailureFields } from './FailureFields'
import { checkFailures, emptyFailure, type FailureDraft } from './failures'

interface PartRowState {
  key: number
  part: ComboboxOption<InventoryPart> | null
  quantity: string
  unitCost: number | null
}

/** A record to correct: the new record starts on the same vehicle with a note pointing at it. */
export interface CorrectionOf {
  id: string
  vehicle: ComboboxOption<Pick<Vehicle, 'id' | 'registration_number'>>
}

/** Work started from elsewhere (the health score screen, FMS-56; service due, FMS-129): the vehicle, the kind of work and what it is for. */
export interface RepairPreset {
  vehicle: Pick<Vehicle, 'id' | 'registration_number'>
  type: MaintenanceType
  description: string
  /** The service program it carries out (preventive work). */
  programId?: string
}

interface LogRepairDrawerProps {
  open: boolean
  onClose: () => void
  canInventory: boolean
  correctionOf?: CorrectionOf | null
  preset?: RepairPreset | null
}

const HOURS = /^\d{1,6}(\.\d{1,2})?$/
const WHOLE = /^\d{1,5}$/

let nextKey = 1

/**
 * S-08 Log a repair (FMS-24): the workshop job card. A vehicle (flagged ones
 * first), what was done, hours, parts used with running total, and the total
 * cost in ETB through MoneyInput (whole cents, never a float). A repair says
 * what failed (FMS-125): needed to complete it, optional while it stays open.
 * Saved as open work, or saved and completed after a confirmation that the
 * vehicle's maintenance flag will clear.
 */
export function LogRepairDrawer({ open, onClose, canInventory, correctionOf, preset }: LogRepairDrawerProps) {
  const formId = useId()
  const { toast } = useToast()
  const create = useCreateRecord()
  const complete = useCompleteRecord()

  const [vehicle, setVehicle] = useState<ComboboxOption<Pick<Vehicle, 'id' | 'registration_number'>> | null>(null)
  const [vehicleQuery, setVehicleQuery] = useState('')
  const [type, setType] = useState<MaintenanceType>('corrective')
  const [description, setDescription] = useState('')
  const [hours, setHours] = useState('')
  const [odometer, setOdometer] = useState('')
  const [notes, setNotes] = useState('')
  const [totalCost, setTotalCost] = useState<number | null>(null)
  const [parts, setParts] = useState<PartRowState[]>([])
  const [failures, setFailures] = useState<FailureDraft[]>([])
  const [programId, setProgramId] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const saving = create.isPending || complete.isPending

  useEffect(() => {
    if (!open) return
    setVehicle(
      correctionOf?.vehicle ??
        (preset ? { value: preset.vehicle, key: preset.vehicle.id, label: preset.vehicle.registration_number } : null),
    )
    setVehicleQuery('')
    setType(preset?.type ?? 'corrective')
    setDescription(preset?.description ?? '')
    setHours('')
    setOdometer('')
    setNotes(correctionOf ? `Correction of record ${correctionOf.id}: ` : '')
    setTotalCost(null)
    setParts([])
    setFailures([emptyFailure()])
    setProgramId(preset?.programId ?? '')
    setErrors({})
    setFormError(null)
  }, [open, correctionOf, preset])

  // Vehicle choices: the flagged ones first, then whatever matches the search.
  const flagged = useFlaggedVehicles()
  const debouncedVehicleQuery = useDebouncedValue(vehicleQuery, 250)
  const searched = useVehicleSearch(debouncedVehicleQuery)
  const vehicleOptions = useMemo(() => {
    const q = vehicleQuery.trim().toUpperCase()
    const option = (v: Vehicle, group: string): ComboboxOption<Pick<Vehicle, 'id' | 'registration_number'>> => ({
      value: v,
      key: v.id,
      label: v.registration_number,
      detail: `${v.make} ${v.model}${v.year ? ` · ${v.year}` : ''}`,
      aside: v.maintenance_flag ? <Badge tone="warning">Flagged</Badge> : undefined,
      group,
    })
    const flaggedList = (flagged.data ?? []).filter((v) => !q || `${v.registration_number} ${v.make} ${v.model}`.toUpperCase().includes(q))
    const seen = new Set(flaggedList.map((v) => v.id))
    const others = q ? (searched.data ?? []).filter((v) => !seen.has(v.id) && v.status !== 'retired') : []
    return [...flaggedList.map((v) => option(v, 'Needs maintenance')), ...others.map((v) => option(v, 'Other vehicles'))]
  }, [flagged.data, searched.data, vehicleQuery])

  const partsTotal = parts.reduce((sum, p) => {
    const qty = WHOLE.test(p.quantity) ? Number.parseInt(p.quantity, 10) : 0
    return sum + (p.unitCost ?? 0) * qty
  }, 0)

  const openWork = useOpenWorkFor(vehicle?.value.id ?? null)
  const otherOpen = (openWork.data ?? []).length

  // Preventive work can carry out one of the vehicle's service programs (FMS-129): completing it starts the count again.
  const programs = useVehicleServiceDue(vehicle?.value.id ?? null, type === 'preventive')
  const programOptions = (programs.data ?? []).map((d) => ({ value: d.program.id, label: `${d.program.name} · ${STATUS_LABELS[d.status].toLowerCase()}` }))
  const program = type === 'preventive' ? (programs.data ?? []).find((d) => d.program.id === programId) : undefined

  function updatePart(key: number, patch: Partial<PartRowState>) {
    setParts((rows) => rows.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  }

  /** Everything the API will check, checked first: nothing is sent while anything is wrong. */
  function validate(completing: boolean): RecordInput | null {
    const found: Record<string, string> = {}
    if (!vehicle) found.vehicle = 'Choose the vehicle that was worked on.'
    if (!description.trim()) found.description = 'Describe the work done.'
    if (!HOURS.test(hours.trim())) found.hours = 'Hours worked, with at most two decimals (e.g. 2.5).'
    if (totalCost === null) found.totalCost = 'Enter the total cost in ETB, with at most two decimals.'
    if (odometer.trim() && !/^\d{1,11}(\.\d)?$/.test(odometer.trim())) found.odometer = 'Kilometres, with at most one decimal.'
    parts.forEach((p, i) => {
      if (!p.part) found[`part.${i}`] = 'Choose a part.'
      if (!WHOLE.test(p.quantity) || Number.parseInt(p.quantity, 10) < 1) found[`qty.${i}`] = 'A whole number, 1 or more.'
      if (p.unitCost === null) found[`cost.${i}`] = 'Unit cost in ETB.'
    })
    const failed = type === 'corrective' ? checkFailures(failures, completing) : { failures: [], errors: {} }
    Object.assign(found, failed.errors)
    setErrors(found)
    if (Object.keys(found).length > 0 || !vehicle || totalCost === null) return null
    return {
      vehicle_id: vehicle.value.id,
      maintenance_type: type,
      description: description.trim(),
      labour_hours: Number(hours.trim()),
      total_cost_cents: totalCost,
      ...(odometer.trim() ? { odometer_km: Number(odometer.trim()) } : {}),
      notes: notes.trim() || null,
      parts: parts.map((p) => ({ part_id: p.part!.value.id, quantity: Number.parseInt(p.quantity, 10), unit_cost_cents: p.unitCost! })),
      ...(failed.failures.length ? { failures: failed.failures } : {}),
      ...(program ? { service_program_id: program.program.id } : {}),
    }
  }

  async function save(andComplete: boolean) {
    const input = validate(andComplete)
    if (!input) return
    setFormError(null)
    try {
      const { record, warnings } = await create.mutateAsync(input)
      if (andComplete) await complete.mutateAsync({ id: record.id, version: record.version })
      const shortages = warnings.flatMap((w) => (w.warning === 'LOW_STOCK' ? [`${w.part_number}: ${w.shortfall} more than in stock`] : []))
      toast({
        title: andComplete ? 'Repair logged and completed' : 'Repair logged',
        description: shortages.length ? `Stock record short: ${shortages.join('; ')}. Stock is now 0.` : `${record.registration_number} · ${TYPE_LABELS[record.maintenance_type]}`,
        tone: shortages.length ? 'info' : 'success',
      })
      onClose()
    } catch (err) {
      setConfirming(false)
      if (err instanceof ApiError && err.details.length) {
        const found: Record<string, string> = {}
        for (const d of err.details) {
          if (d.field === 'vehicle_id') found.vehicle = 'This vehicle is outside your depots or retired.'
          else if (d.field?.startsWith('parts.')) {
            const [, i] = d.field.split('.')
            found[`part.${i}`] = d.reason === 'part_in_other_depot' ? "This part is in another depot's stock." : 'This part is no longer stocked.'
          } else if (d.field === 'total_cost_cents') found.totalCost = 'Enter the total cost in whole cents.'
          else if (d.field === 'service_program_id') found.program = d.reason === 'program_not_applicable' ? 'This program does not cover this vehicle.' : 'This program is retired or no longer exists.'
          else if (d.reason === 'failure_required') found.failures = 'Say what failed: a repair can be completed only with at least one failure.'
          else if (d.field?.startsWith('failures.')) {
            const [, i, name] = d.field.split('.')
            found[`failure.${i}.${name}`] = 'Check this value.'
          }
        }
        if (Object.keys(found).length) return setErrors(found)
      }
      setFormError(err instanceof ApiError ? `The repair could not be saved (${err.code}).` : 'Could not reach the server. Try again.')
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    void save(false)
  }

  const plate = vehicle?.label ?? 'the vehicle'

  return (
    <>
      <Drawer
        open={open && !confirming}
        onClose={onClose}
        title={correctionOf ? 'Log a correction' : preset?.type === 'inspection' ? 'Schedule an inspection' : 'Log a repair'}
        description="Replaces the paper job card. Every save is kept in the audit log."
        footer={
          <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="secondary" type="submit" form={formId} loading={saving && !confirming}>
              Save as open work
            </Button>
            <Button
              onClick={() => {
                if (validate(true)) setConfirming(true)
              }}
            >
              Save and complete…
            </Button>
          </div>
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

          <Section title="Vehicle and work">
            <Combobox
              label="Vehicle"
              value={vehicle}
              onChange={(option) => {
                setVehicle(option)
                if (option?.key !== vehicle?.key) setProgramId('')
              }}
              query={vehicleQuery}
              onQueryChange={setVehicleQuery}
              options={vehicleOptions}
              loading={flagged.isPending || searched.isFetching}
              error={errors.vehicle}
              hint={vehicle ? (otherOpen ? `${otherOpen} open job${otherOpen === 1 ? '' : 's'} on this vehicle.` : 'No other open work on this vehicle.') : 'Flagged vehicles are listed first; type a plate to find any other.'}
              emptyText="No vehicle matches: try a plate, make or model"
            />
            <div className="grid gap-x-4 sm:grid-cols-2">
              <SelectField
                label="Type of work"
                value={type}
                onChange={(e) => setType(e.target.value as MaintenanceType)}
                options={MAINTENANCE_TYPES.map((t) => ({ value: t, label: TYPE_LABELS[t] }))}
              />
              <TextField label="Labour" inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} error={errors.hours} trailing={<span className="text-xs">hours</span>} />
            </div>
            {type === 'preventive' && vehicle && (programs.isPending || programOptions.length > 0) && (
              <SelectField
                label="Service program"
                optional
                value={programId}
                onChange={(e) => setProgramId(e.target.value)}
                options={[{ value: '', label: 'None: other preventive work' }, ...programOptions]}
                error={errors.program}
                disabled={programs.isPending}
                hint={program ? `Completing this work starts ${program.program.name}'s count again.${program.program.tasks.length ? ` Checklist: ${program.program.tasks.join(', ')}.` : ''}` : 'The scheduled service this work carries out, if any.'}
              />
            )}
            <TextAreaField label="Work done" value={description} onChange={(e) => setDescription(e.target.value)} error={errors.description} maxLength={2000} />
            <TextField
              label="Odometer"
              optional
              inputMode="decimal"
              value={odometer}
              onChange={(e) => setOdometer(e.target.value)}
              error={errors.odometer}
              trailing={<span className="text-xs">km</span>}
            />
          </Section>

          {type === 'corrective' && (
            <Section title="What failed">
              <p className="-mt-1 mb-3 text-sm text-ink-muted">Needed to complete the repair. It builds the failure history the maintenance predictions learn from.</p>
              <FailureFields drafts={failures} onChange={setFailures} errors={errors} />
            </Section>
          )}

          <Section
            title="Parts used"
            action={
              canInventory && (
                <Button size="sm" variant="secondary" leadingIcon={<PackagePlus className="h-4 w-4" />} onClick={() => setParts((rows) => [...rows, { key: nextKey++, part: null, quantity: '1', unitCost: null }])}>
                  Add part
                </Button>
              )
            }
          >
            {parts.length === 0 ? (
              <p className="rounded-control border border-dashed border-line-strong px-4 py-5 text-center text-sm text-ink-subtle">No parts added. Labour-only work needs none.</p>
            ) : (
              <ul className="space-y-3">
                {parts.map((row, i) => (
                  <PartRow
                    key={row.key}
                    row={row}
                    index={i}
                    errors={errors}
                    onChange={(patch) => updatePart(row.key, patch)}
                    onRemove={() => setParts((rows) => rows.filter((r) => r.key !== row.key))}
                  />
                ))}
              </ul>
            )}
            <div className="flex items-center justify-between gap-3 rounded-control bg-surface-muted px-4 py-2.5 text-sm">
              <span className="text-ink-muted">Parts total</span>
              <span className="flex items-center gap-2">
                {partsTotal > 0 && (
                  <Button size="sm" variant="ghost" onClick={() => setTotalCost(partsTotal)}>
                    Use as total cost
                  </Button>
                )}
                <MoneyDisplay amountMinorUnits={partsTotal} className="font-semibold text-ink" />
              </span>
            </div>
          </Section>

          <Section title="Cost">
            <MoneyInput
              label="Total cost"
              value={totalCost}
              onChange={setTotalCost}
              required
              error={errors.totalCost}
              hint="labour, parts and anything else"
            />
            <TextAreaField label="Notes" optional rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={4000} />
          </Section>
        </form>
      </Drawer>

      <ConfirmDialog
        open={open && confirming}
        onClose={() => setConfirming(false)}
        title="Complete this repair?"
        tone="default"
        action="Save and complete"
        busy={saving}
        error={formError}
        message={
          otherOpen > 0 ? (
            <p>
              The repair is saved as completed and can no longer be edited. {plate} still has {otherOpen} other open job{otherOpen === 1 ? '' : 's'}, so it stays
              flagged for maintenance until {otherOpen === 1 ? 'that is' : 'those are'} done.
            </p>
          ) : (
            <p>
              The repair is saved as completed and can no longer be edited. This <strong className="text-ink">clears {plate}&apos;s maintenance flag</strong> and makes it
              available for dispatch.
            </p>
          )
        }
        onConfirm={() => save(true)}
      />
    </>
  )
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <fieldset className="space-y-1">
      <div className="mb-3 flex items-center justify-between">
        <legend className="text-xs font-semibold uppercase tracking-wider text-ink-subtle">{title}</legend>
        {action}
      </div>
      {children}
    </fieldset>
  )
}

function PartRow({
  row,
  index,
  errors,
  onChange,
  onRemove,
}: {
  row: PartRowState
  index: number
  errors: Record<string, string>
  onChange: (patch: Partial<PartRowState>) => void
  onRemove: () => void
}) {
  const [query, setQuery] = useState('')
  const debounced = useDebouncedValue(query, 250)
  const search = usePartSearch(debounced, true)
  const options = (search.data ?? []).map(
    (p): ComboboxOption<InventoryPart> => ({
      value: p,
      key: p.id,
      label: `${p.name} (${p.part_number})`,
      detail: p.unit_cost_cents === null ? 'No price on record' : <MoneyDisplay amountMinorUnits={p.unit_cost_cents} className="text-left" />,
      aside: <Badge tone={p.stock_status === 'out' ? 'danger' : p.stock_status === 'low' ? 'warning' : 'neutral'}>{p.stock_quantity} in stock</Badge>,
    }),
  )
  const part = row.part?.value
  const qty = WHOLE.test(row.quantity) ? Number.parseInt(row.quantity, 10) : 0
  // Not a block: the repair is recorded; the stock record is what is wrong (FMS-22/23).
  const warning = !part
    ? null
    : part.stock_quantity === 0
      ? 'Out of stock on record. It will still be logged; stock stays at 0.'
      : qty > part.stock_quantity
        ? `Only ${part.stock_quantity} in stock on record. All ${qty} will be logged; stock stops at 0.`
        : null

  return (
    <li className="rounded-card border border-line bg-surface-muted/50 p-3">
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <Combobox
          label={`Part ${index + 1}`}
          hideLabel
          value={row.part}
          onChange={(option) => onChange({ part: option, ...(option && option.value.unit_cost_cents !== null && row.unitCost === null ? { unitCost: option.value.unit_cost_cents } : {}) })}
          query={query}
          onQueryChange={setQuery}
          options={options}
          loading={search.isFetching}
          error={errors[`part.${index}`]}
          emptyText="No part matches: search by name or part number"
        />
        <IconButton label={`Remove part ${index + 1}`} icon={<Trash2 />} onClick={onRemove} className="hover:bg-danger-soft hover:text-danger" />
      </div>
      <div className="mt-1 grid grid-cols-[96px_1fr_auto] items-start gap-2">
        <TextField
          label={`Quantity of part ${index + 1}`}
          className="[&_label]:sr-only [&_input]:h-10 [&_input]:pt-0 [&_input]:pb-0"
          inputMode="numeric"
          value={row.quantity}
          onChange={(e) => onChange({ quantity: e.target.value })}
          error={errors[`qty.${index}`]}
          trailing={<span className="text-xs">qty</span>}
        />
        <MoneyInput label={`Unit cost of part ${index + 1}`} hideLabel value={row.unitCost} onChange={(v) => onChange({ unitCost: v })} error={errors[`cost.${index}`]} />
        <div className="flex h-10 min-w-[108px] items-center justify-end text-sm font-medium text-ink">
          <MoneyDisplay amountMinorUnits={(row.unitCost ?? 0) * qty} />
        </div>
      </div>
      <div aria-live="polite">
        {warning && (
          <p className="mt-1 flex animate-fade-in items-start gap-1.5 text-xs font-medium text-warning">
            <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {warning}
          </p>
        )}
      </div>
    </li>
  )
}

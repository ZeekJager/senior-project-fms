import { AlertCircle, Archive, ListChecks, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import { Button, Drawer, IconButton, SelectField, TextAreaField, TextField, useToast } from '@/components/ui'
import type { Depot } from '@/features/depots'
import { FUEL_TYPE_LABELS, FUEL_TYPES, VEHICLE_TYPE_LABELS, VEHICLE_TYPES, useCreateProgram, useUpdateProgram, type ServiceProgram } from '@/features/service-due'
import { ApiError } from '@/lib/api/errors'
import {
  EMPTY_FORM,
  MAX_TASKS,
  MEASURES,
  changedFields,
  defaultLead,
  formField,
  formFromProgram,
  newTask,
  validateProgramForm,
  type FieldErrors,
  type FieldName,
  type ProgramFormValues,
} from './programForm'

interface ProgramFormDrawerProps {
  open: boolean
  onClose: () => void
  /** Null: define a new program. */
  program: ServiceProgram | null
  depots: Depot[]
  /** Whether the user sees every depot: only they define fleet-wide programs. */
  everyDepot: boolean
  /** The user may look but not change it (a fleet-wide program, for a depot admin; or no service-program:write). */
  readOnly?: boolean
  /** Given when the user may retire this program: shown in the footer, apart from Save. */
  onRetire?: () => void
}

const MESSAGES: Record<string, string> = {
  CONFLICT_CONCURRENT_MODIFICATION: 'Someone else changed this program while you were editing. Close the panel to see their changes, then edit again.',
  NOT_FOUND: 'This program no longer exists or is outside your depots.',
  FORBIDDEN_INSUFFICIENT_ROLE: 'Only someone who sees every depot can change a fleet-wide program.',
}

const REASONS: Record<string, string> = {
  interval_required: 'Give at least one interval: kilometres, days or engine hours.',
  not_below_interval: 'Less than the interval.',
  interval_missing: 'Give the interval first.',
  duplicate_task: 'Each task once.',
  fleet_wide_not_allowed: 'Choose your depot: fleet-wide programs are set by those who see every depot.',
  references_missing_record: 'Choose one of your depots.',
  required: 'Name the make as well as the model.',
}

/**
 * S-23 Define or edit a preventive service program (FMS-129): which vehicles it covers, how often they are
 * serviced (whichever comes first of kilometres, days and engine hours, each with the window in which it
 * shows as due) and the checklist of tasks.
 */
export function ProgramFormDrawer({ open, onClose, program, depots, everyDepot, readOnly = false, onRetire }: ProgramFormDrawerProps) {
  const formId = useId()
  const { toast } = useToast()
  const [values, setValues] = useState<ProgramFormValues>(EMPTY_FORM)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [formError, setFormError] = useState<string | null>(null)
  const create = useCreateProgram()
  const update = useUpdateProgram()
  const saving = create.isPending || update.isPending

  useEffect(() => {
    if (!open) return
    setValues(program ? formFromProgram(program) : { ...EMPTY_FORM, depot_id: everyDepot ? '' : (depots[0]?.id ?? ''), tasks: [newTask()] })
    setErrors({})
    setFormError(null)
  }, [open, program, depots, everyDepot])

  function clearError(...fields: FieldName[]) {
    setErrors((current) => {
      const next = { ...current }
      for (const f of fields) delete next[f]
      return next
    })
  }

  function set<K extends Exclude<keyof ProgramFormValues, 'tasks'>>(field: K, value: ProgramFormValues[K]) {
    setValues((current) => ({ ...current, [field]: value }))
    clearError(field, ...(field.startsWith('interval_') ? (['intervals'] as const) : []))
  }

  function setTask(index: number, text: string) {
    setValues((current) => ({ ...current, tasks: current.tasks.map((t, i) => (i === index ? { ...t, text } : t)) }))
    clearError(`tasks.${index}`, 'tasks')
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (saving || readOnly) return
    setFormError(null)
    const { errors: found, input } = validateProgramForm(values)
    setErrors(found)
    if (!input) return
    try {
      if (program) {
        const patch = changedFields(input, program)
        if (Object.keys(patch).length > 0) await update.mutateAsync({ id: program.id, version: program.version, patch })
        toast({ title: 'Changes saved', description: `${input.name}: its vehicles' service due is computed again.` })
      } else {
        // A new program's depot: chosen, or fleet-wide (null) for one who sees every depot.
        await create.mutateAsync(input)
        toast({ title: 'Program added', description: `${input.name}: its vehicles' service due is computed now.` })
      }
      onClose()
    } catch (err) {
      showServerError(err)
    }
  }

  async function restore() {
    if (!program || saving) return
    try {
      await update.mutateAsync({ id: program.id, version: program.version, patch: { is_active: true } })
      toast({ title: 'Program restored', description: `${program.name} applies to its vehicles again.` })
      onClose()
    } catch (err) {
      showServerError(err)
    }
  }

  function showServerError(err: unknown) {
    if (!(err instanceof ApiError)) return setFormError('Could not reach the server. Check your connection and try again.')
    if (err.code === 'CONFLICT_DUPLICATE') return setErrors({ name: 'An active program of this name already applies here.' })
    const found: FieldErrors = {}
    for (const d of err.details) {
      const field = d.reason === 'interval_required' ? 'intervals' : formField(d.field)
      if (field) found[field] = REASONS[d.reason ?? ''] ?? 'Check this value.'
    }
    if (Object.keys(found).length > 0) return setErrors(found)
    setFormError(MESSAGES[err.code] ?? `The program could not be saved (${err.code}).`)
  }

  const retired = program !== null && !program.is_active
  const depotOptions = [...(everyDepot ? [{ value: '', label: 'Every depot (fleet-wide)' }] : []), ...depots.map((d) => ({ value: d.id, label: d.name }))]
  const fleetWideShown = program !== null && program.depot_id === null && !everyDepot

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={readOnly ? (program?.name ?? 'Service program') : program ? `Edit ${program.name}` : 'Add service program'}
      description={
        retired
          ? 'Retired: its vehicles are no longer due under it. Restore it to schedule them again.'
          : readOnly
            ? fleetWideShown
              ? 'A fleet-wide program: set by those who see every depot.'
              : 'You can see this program but not change it.'
            : 'Vehicles fall due at whichever comes first. Changes are saved to the audit log.'
      }
      footer={
        readOnly ? (
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        ) : (
          <>
            {program && !retired && onRetire && (
              <Button variant="ghost" leadingIcon={<Archive className="h-4 w-4" />} className="mr-auto !text-danger hover:!bg-danger-soft hover:!text-danger" onClick={onRetire}>
                Retire program
              </Button>
            )}
            {retired && (
              <Button variant="ghost" leadingIcon={<RotateCcw className="h-4 w-4" />} className="mr-auto" onClick={() => void restore()} disabled={saving}>
                Restore program
              </Button>
            )}
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" form={formId} loading={saving}>
              {program ? 'Save changes' : 'Add program'}
            </Button>
          </>
        )
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

        <fieldset disabled={readOnly} className="space-y-6">
          <Section title="Program">
            <TextField label="Name" value={values.name} onChange={(e) => set('name', e.target.value)} error={errors.name} hint="How the workshop knows it, e.g. A-service or 6-monthly inspection." autoComplete="off" maxLength={120} />
            <TextAreaField label="Description" optional rows={2} value={values.description} onChange={(e) => set('description', e.target.value)} error={errors.description} maxLength={2000} />
          </Section>

          <Section title="Which vehicles">
            {fleetWideShown ? (
              <TextField label="Depot" value="Every depot (fleet-wide)" readOnly />
            ) : (
              <SelectField
                label="Depot"
                value={values.depot_id}
                onChange={(e) => set('depot_id', e.target.value)}
                error={errors.depot_id}
                options={depotOptions}
                hint={everyDepot ? 'Fleet-wide covers every depot.' : undefined}
              />
            )}
            <div className="grid gap-x-4 sm:grid-cols-2">
              <SelectField
                label="Vehicle type"
                value={values.vehicle_type}
                onChange={(e) => set('vehicle_type', e.target.value as ProgramFormValues['vehicle_type'])}
                options={[{ value: '', label: 'Any type' }, ...VEHICLE_TYPES.map((t) => ({ value: t, label: VEHICLE_TYPE_LABELS[t] }))]}
              />
              <SelectField
                label="Fuel type"
                value={values.fuel_type}
                onChange={(e) => set('fuel_type', e.target.value as ProgramFormValues['fuel_type'])}
                options={[{ value: '', label: 'Any fuel' }, ...FUEL_TYPES.map((t) => ({ value: t, label: FUEL_TYPE_LABELS[t] }))]}
              />
              <TextField label="Make" optional value={values.make} onChange={(e) => set('make', e.target.value)} error={errors.make} autoComplete="off" maxLength={100} />
              <TextField label="Model" optional value={values.model} onChange={(e) => set('model', e.target.value)} error={errors.model} autoComplete="off" maxLength={100} />
            </div>
            <p className="text-xs text-ink-subtle">Leave any of these open to cover every vehicle in the depot that matches the rest.</p>
          </Section>

          <Section title="When it is due">
            <p className="-mt-1 mb-3 text-sm text-ink-muted">Whichever comes first. A service shows as due within its window, and overdue once past the interval.</p>
            <div role="alert" className="empty:hidden">
              {errors.intervals && <p className="mb-3 text-sm font-medium text-danger">{errors.intervals}</p>}
            </div>
            {MEASURES.map(({ interval, lead, unit }) => {
              const every = Number(values[interval])
              const hint = values[interval].trim() && Number.isInteger(every) && every > 1 ? `Blank: ${defaultLead(every).toLocaleString('en-US')} ${unit}` : 'Blank: a tenth of the interval'
              return (
                <div key={interval} className="grid grid-cols-2 gap-x-4">
                  <TextField label={`Every (${unit})`} optional inputMode="numeric" value={values[interval]} onChange={(e) => set(interval, e.target.value)} error={errors[interval]} trailing={<span className="text-xs">{unit}</span>} />
                  <TextField
                    label={`Due within (${unit})`}
                    optional
                    inputMode="numeric"
                    value={values[lead]}
                    onChange={(e) => set(lead, e.target.value)}
                    error={errors[lead]}
                    hint={values[interval].trim() ? hint : undefined}
                    trailing={<span className="text-xs">{unit}</span>}
                    disabled={!values[interval].trim() && !values[lead].trim()}
                  />
                </div>
              )
            })}
          </Section>

          <fieldset className="space-y-3">
            <legend className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-ink-subtle">
              <ListChecks className="h-3.5 w-3.5" aria-hidden="true" />
              Checklist
            </legend>
            {values.tasks.length === 0 ? (
              <p className="text-sm text-ink-subtle">No tasks listed. Add what the workshop does at this service.</p>
            ) : (
              <ol className="space-y-2">
                {values.tasks.map((task, i) => (
                  <li key={task.key} className="grid grid-cols-[1fr_auto] items-start gap-2">
                    <TextField label={`Task ${i + 1}`} value={task.text} onChange={(e) => setTask(i, e.target.value)} error={errors[`tasks.${i}`]} autoComplete="off" maxLength={200} />
                    {!readOnly && (
                      <IconButton
                        label={`Remove task ${i + 1}`}
                        icon={<Trash2 />}
                        className="mt-1 hover:bg-danger-soft hover:text-danger"
                        onClick={() => {
                          setValues((current) => ({ ...current, tasks: current.tasks.filter((_, j) => j !== i) }))
                          setErrors((current) => Object.fromEntries(Object.entries(current).filter(([k]) => !k.startsWith('tasks'))))
                        }}
                      />
                    )}
                  </li>
                ))}
              </ol>
            )}
            {errors.tasks && <p className="text-xs text-danger">{errors.tasks}</p>}
            {!readOnly && (
              <Button
                variant="secondary"
                size="sm"
                leadingIcon={<Plus className="h-4 w-4" />}
                onClick={() => setValues((current) => ({ ...current, tasks: [...current.tasks, newTask()] }))}
                disabled={values.tasks.length >= MAX_TASKS}
              >
                Add task
              </Button>
            )}
          </fieldset>
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

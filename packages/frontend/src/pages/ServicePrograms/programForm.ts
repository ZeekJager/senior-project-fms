import type { FuelType, ServiceProgram, ServiceProgramInput, VehicleType } from '@/features/service-due'

/** A task row as typed. `key` keeps React rows stable while tasks are removed. */
export interface TaskValue {
  key: string
  text: string
}

/** The editor's fields as typed: always text, so nothing is rounded or lost while editing. */
export interface ProgramFormValues {
  name: string
  description: string
  /** '' : fleet-wide. */
  depot_id: string
  vehicle_type: VehicleType | ''
  fuel_type: FuelType | ''
  make: string
  model: string
  interval_km: string
  lead_km: string
  interval_days: string
  lead_days: string
  interval_engine_hours: string
  lead_engine_hours: string
  tasks: TaskValue[]
}

type Measure = 'km' | 'days' | 'engine_hours'
export type FieldName = Exclude<keyof ProgramFormValues, 'tasks'> | 'intervals' | 'tasks' | `tasks.${number}`
export type FieldErrors = Partial<Record<FieldName, string>>

export const MAX_TASKS = 30
export const MEASURES: { measure: Measure; interval: `interval_${Measure}`; lead: `lead_${Measure}`; unit: string; max: number }[] = [
  { measure: 'km', interval: 'interval_km', lead: 'lead_km', unit: 'km', max: 1_000_000 },
  { measure: 'days', interval: 'interval_days', lead: 'lead_days', unit: 'days', max: 3650 },
  { measure: 'engine_hours', interval: 'interval_engine_hours', lead: 'lead_engine_hours', unit: 'engine hours', max: 100_000 },
]

let nextKey = 0
export const newTask = (text = ''): TaskValue => ({ key: `task-${++nextKey}`, text })

export const EMPTY_FORM: ProgramFormValues = {
  name: '',
  description: '',
  depot_id: '',
  vehicle_type: '',
  fuel_type: '',
  make: '',
  model: '',
  interval_km: '',
  lead_km: '',
  interval_days: '',
  lead_days: '',
  interval_engine_hours: '',
  lead_engine_hours: '',
  tasks: [],
}

const text = (n: number | null) => (n === null ? '' : String(n))

export function formFromProgram(p: ServiceProgram): ProgramFormValues {
  return {
    name: p.name,
    description: p.description ?? '',
    depot_id: p.depot_id ?? '',
    vehicle_type: p.vehicle_type ?? '',
    fuel_type: p.fuel_type ?? '',
    make: p.make ?? '',
    model: p.model ?? '',
    interval_km: text(p.interval_km),
    lead_km: text(p.lead_km),
    interval_days: text(p.interval_days),
    lead_days: text(p.lead_days),
    interval_engine_hours: text(p.interval_engine_hours),
    lead_engine_hours: text(p.lead_engine_hours),
    tasks: p.tasks.map((t) => newTask(t)),
  }
}

const WHOLE = /^\d{1,7}$/

/** A lead window left blank is a tenth of its interval, as the API sets it. */
export const defaultLead = (interval: number) => Math.min(Math.round(interval * 0.1), interval - 1)

/**
 * Checks the editor the way the API will (api-contract §10.4) and builds the request body. The API stays
 * the authority; this puts each message next to its field. Blank task rows are dropped.
 */
export function validateProgramForm(values: ProgramFormValues): { errors: FieldErrors; input: ServiceProgramInput | null } {
  const errors: FieldErrors = {}
  const name = values.name.trim()
  if (!name) errors.name = 'Give the program a name.'
  else if (name.length > 120) errors.name = 'At most 120 characters.'
  if (values.description.trim().length > 2000) errors.description = 'At most 2,000 characters.'
  const make = values.make.trim()
  const model = values.model.trim()
  if (make.length > 100) errors.make = 'At most 100 characters.'
  if (model.length > 100) errors.model = 'At most 100 characters.'
  if (model && !make) errors.make = 'Name the make as well as the model.'

  const numbers: Record<string, number | null> = {}
  for (const { interval, lead, unit, max } of MEASURES) {
    const i = values[interval].trim()
    const l = values[lead].trim()
    let every: number | null = null
    if (i) {
      if (!WHOLE.test(i) || Number(i) < 1) errors[interval] = `A whole number of ${unit}, 1 or more.`
      else if (Number(i) > max) errors[interval] = `At most ${max.toLocaleString('en-US')} ${unit}.`
      else every = Number(i)
    }
    let within: number | null = null
    if (l) {
      if (!i) errors[lead] = 'Give the interval first.'
      else if (!WHOLE.test(l)) errors[lead] = `A whole number of ${unit}.`
      else if (every !== null && Number(l) >= every) errors[lead] = `Less than the interval (${every.toLocaleString('en-US')} ${unit}).`
      else within = Number(l)
    }
    numbers[interval] = every
    numbers[lead] = every === null ? null : within
  }
  if (!values.interval_km.trim() && !values.interval_days.trim() && !values.interval_engine_hours.trim()) {
    errors.intervals = 'Give at least one interval: kilometres, days or engine hours.'
  }

  const tasks: string[] = []
  const seen = new Set<string>()
  values.tasks.forEach((t, i) => {
    const task = t.text.trim()
    if (!task) return
    if (task.length > 200) errors[`tasks.${i}`] = 'At most 200 characters.'
    else if (seen.has(task.toLowerCase())) errors[`tasks.${i}`] = 'Already on the checklist.'
    seen.add(task.toLowerCase())
    tasks.push(task)
  })
  if (tasks.length > MAX_TASKS) errors.tasks = `At most ${MAX_TASKS} tasks.`

  if (Object.keys(errors).length > 0) return { errors, input: null }
  return {
    errors,
    input: {
      name,
      description: values.description.trim() || null,
      depot_id: values.depot_id || null,
      vehicle_type: values.vehicle_type || null,
      fuel_type: values.fuel_type || null,
      make: make || null,
      model: model || null,
      interval_km: numbers.interval_km,
      lead_km: numbers.lead_km,
      interval_days: numbers.interval_days,
      lead_days: numbers.lead_days,
      interval_engine_hours: numbers.interval_engine_hours,
      lead_engine_hours: numbers.lead_engine_hours,
      tasks,
    },
  }
}

/** Only what changed, for PATCH: an unchanged program sends nothing. */
export function changedFields(input: ServiceProgramInput, program: ServiceProgram): Partial<ServiceProgramInput> {
  const patch: Partial<ServiceProgramInput> = {}
  for (const key of Object.keys(input) as (keyof ServiceProgramInput)[]) {
    const before = program[key]
    const after = input[key]
    const same = Array.isArray(after) && Array.isArray(before) ? after.join('\n') === before.join('\n') : after === before
    if (!same) (patch as Record<string, unknown>)[key] = after
  }
  return patch
}

/** An API error detail's field, as the editor names it. */
export function formField(field: string | undefined): FieldName | null {
  if (!field) return null
  if (field.startsWith('tasks')) return 'tasks'
  const known: FieldName[] = [
    'name',
    'description',
    'depot_id',
    'vehicle_type',
    'fuel_type',
    'make',
    'model',
    'interval_km',
    'lead_km',
    'interval_days',
    'lead_days',
    'interval_engine_hours',
    'lead_engine_hours',
  ]
  return (known as string[]).includes(field) ? (field as FieldName) : null
}

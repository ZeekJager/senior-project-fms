import { describe, expect, it } from 'vitest'
import type { ServiceProgram } from '@/features/service-due'
import { EMPTY_FORM, changedFields, formFromProgram, newTask, validateProgramForm, type ProgramFormValues } from './programForm'

const form = (patch: Partial<ProgramFormValues>): ProgramFormValues => ({ ...EMPTY_FORM, name: 'A-service', ...patch })

const program: ServiceProgram = {
  id: 'p-1',
  name: 'A-service',
  description: null,
  depot_id: null,
  vehicle_type: 'truck',
  fuel_type: 'diesel',
  make: 'Isuzu',
  model: null,
  interval_km: 10_000,
  lead_km: 500,
  interval_days: 180,
  lead_days: 14,
  interval_engine_hours: null,
  lead_engine_hours: null,
  tasks: ['Engine oil', 'Oil filter'],
  is_active: true,
  vehicles: { total: 12, upcoming: 9, due: 2, overdue: 1 },
  version: 3,
  created_at: '2026-10-01T08:00:00Z',
  updated_at: '2026-10-01T08:00:00Z',
}

describe('the program editor: validateProgramForm (FMS-129)', () => {
  it('needs a name and at least one interval', () => {
    const { errors, input } = validateProgramForm({ ...EMPTY_FORM })
    expect(input).toBeNull()
    expect(errors.name).toBe('Give the program a name.')
    expect(errors.intervals).toBe('Give at least one interval: kilometres, days or engine hours.')
  })

  it('takes whole numbers within range, and a lead window below its interval and only with it', () => {
    expect(validateProgramForm(form({ interval_km: '10000.5' })).errors.interval_km).toBe('A whole number of km, 1 or more.')
    expect(validateProgramForm(form({ interval_km: '0' })).errors.interval_km).toBe('A whole number of km, 1 or more.')
    expect(validateProgramForm(form({ interval_days: '4000' })).errors.interval_days).toBe('At most 3,650 days.')
    expect(validateProgramForm(form({ interval_km: '10000', lead_km: '10000' })).errors.lead_km).toBe('Less than the interval (10,000 km).')
    expect(validateProgramForm(form({ interval_days: '90', lead_km: '500' })).errors.lead_km).toBe('Give the interval first.')
  })

  it('a model needs its make; the checklist drops blank rows and refuses a task listed twice', () => {
    expect(validateProgramForm(form({ interval_km: '5000', model: 'NPR' })).errors.make).toBe('Name the make as well as the model.')
    const tasks = [newTask('Engine oil'), newTask('  '), newTask('engine oil')]
    expect(validateProgramForm(form({ interval_km: '5000', tasks })).errors['tasks.2']).toBe('Already on the checklist.')
  })

  it('builds the body: blank leads left to the API, empty filters as null, fleet-wide as a null depot', () => {
    const { errors, input } = validateProgramForm(
      form({ name: '  A-service ', interval_km: '10000', interval_engine_hours: '250', lead_engine_hours: '20', fuel_type: 'diesel', tasks: [newTask(' Engine oil '), newTask('')] }),
    )
    expect(errors).toEqual({})
    expect(input).toEqual({
      name: 'A-service',
      description: null,
      depot_id: null,
      vehicle_type: null,
      fuel_type: 'diesel',
      make: null,
      model: null,
      interval_km: 10_000,
      lead_km: null,
      interval_days: null,
      lead_days: null,
      interval_engine_hours: 250,
      lead_engine_hours: 20,
      tasks: ['Engine oil'],
    })
  })

  it('an edit sends only what changed', () => {
    const values = formFromProgram(program)
    expect(changedFields(validateProgramForm(values).input!, program)).toEqual({})
    const edited = { ...values, interval_km: '15000', tasks: [...values.tasks, newTask('Air filter')] }
    expect(changedFields(validateProgramForm(edited).input!, program)).toEqual({ interval_km: 15_000, tasks: ['Engine oil', 'Oil filter', 'Air filter'] })
  })
})

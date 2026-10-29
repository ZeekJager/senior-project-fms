import { describe, expect, it } from 'vitest'
import { actionLabel, actorName, changedFields, fieldLabel, formatValue, recordName, summary, type AuditEntry } from './describe'

function entry(action: string, old_values: Record<string, unknown> | null, new_values: Record<string, unknown> | null, details: Record<string, unknown> = {}): AuditEntry {
  return {
    id: '1',
    occurred_at: '2026-10-28T11:05:09.000000Z',
    action,
    result: 'success',
    actor: { type: 'user', id: 'u-1', full_name: 'Hanna Tesfaye', email: 'hanna@fleet.demo' },
    entity_type: 'fuel.fuel_logs',
    entity_id: 'e-1',
    correlation_id: 'c-1',
    request_source: null,
    old_values,
    new_values,
    details,
  }
}

describe('changedFields: the diff shows changed fields only (FMS-29)', () => {
  it('an update lists only the fields whose value differs, never the record id', () => {
    const fields = changedFields(
      entry(
        'UPDATE',
        { public_id: 'p', quantity_ml: 40_000, total_cost_cents: 380_000, station_name: 'Total Bole', stops: [{ name: 'A', lat: 9 }] },
        { public_id: 'p', quantity_ml: 42_500, total_cost_cents: 380_000, station_name: 'Total Bole', stops: [{ lat: 9, name: 'A' }] },
      ),
    )
    // The stops are the same object with its keys in another order: not a change.
    expect(fields.map((f) => [f.key, f.before, f.after])).toEqual([['quantity_ml', 40_000, 42_500]])
  })

  it('a field that appears or disappears counts as changed, from or to empty', () => {
    expect(changedFields(entry('UPDATE', { notes: 'x' }, { odometer_km: 5 })).map((f) => [f.key, f.before, f.after])).toEqual([
      ['notes', 'x', null],
      ['odometer_km', null, 5],
    ])
  })

  it('a create lists the fields it set, a delete the fields it had; empty ones are left out', () => {
    expect(changedFields(entry('INSERT', null, { public_id: 'p', name: 'Bole', notes: null })).map((f) => f.key)).toEqual(['name'])
    expect(changedFields(entry('DELETE', { public_id: 'p', name: 'Bole', notes: null }, null)).map((f) => [f.key, f.before, f.after])).toEqual([['name', 'Bole', undefined]])
  })

  it('an event without values has no fields', () => {
    expect(changedFields(entry('auth.login_succeeded', null, null))).toEqual([])
  })
})

describe('formatValue: fuel in litres, money in ETB', () => {
  it('turns integer units into what people read', () => {
    expect(formatValue('total_cost_cents', 380_050)).toBe('ETB 3,800.50')
    expect(formatValue('unit_price_cents', 8_947)).toBe('ETB 89.47')
    expect(formatValue('quantity_ml', 42_505)).toBe('42.51 L')
    expect(formatValue('fuel_efficiency_ml_per_km', 320)).toBe('32.0 L/100 km')
    expect(formatValue('odometer_km', 87_000.5)).toBe('87,000.5 km')
    expect(formatValue('actual_duration_seconds', 19_200)).toBe('5 h 20 min')
  })

  it('reads big integers and decimals stored as text the same way', () => {
    expect(formatValue('quantity_ml', '57220')).toBe('57.22 L')
    expect(formatValue('odometer_km', '50067.7')).toBe('50,067.7 km')
    expect(formatValue('station_name', '12345')).toBe('12345')
  })

  it('says yes, no, empty and hidden in words; times in Addis Ababa', () => {
    expect(formatValue('is_active', false)).toBe('No')
    expect(formatValue('notes', null)).toBe('—')
    expect(formatValue('password_hash', '[REDACTED]')).toBe('Hidden')
    expect(formatValue('completed_at', '2026-10-28T11:05:09Z')).toBe('28 Oct 2026, 14:05:09')
    expect(formatValue('expiry_date', '2026-12-31')).toBe('31 Dec 2026')
    expect(formatValue('roles', ['dispatcher', 'technician'])).toBe('dispatcher, technician')
  })

  it('a value that is not a whole number of cents or millilitres is shown as it is, never as a wrong amount', () => {
    expect(formatValue('total_cost_cents', 12.5)).toBe('12.5')
  })
})

describe('labels', () => {
  it('names actions, fields and records in words', () => {
    expect(actionLabel('UPDATE')).toBe('Updated')
    expect(actionLabel('auth.login_failed')).toBe('Sign-in failed')
    expect(actionLabel('stock.adjusted')).toBe('Stock adjusted')
    expect(fieldLabel('total_cost_cents')).toBe('Total cost')
    expect(fieldLabel('quantity_ml')).toBe('Quantity')
    expect(fieldLabel('completed_at')).toBe('Completed at')
    expect(recordName(entry('UPDATE', { registration_number: 'AA 3-12345' }, { registration_number: 'AA 3-12345', status: 'maintenance' }))).toBe('AA 3-12345')
  })

  it('an entry without a user is someone not signed in when signing in, otherwise the system', () => {
    expect(actorName({ type: 'anonymous' }, 'auth.login_failed')).toBe('Not signed in')
    expect(actorName({ type: 'anonymous' }, 'INSERT')).toBe('System')
    expect(actorName({ type: 'system' }, 'job.started')).toBe('Scheduled job')
  })

  it('summarises an entry in one line', () => {
    expect(summary(entry('UPDATE', { status: 'active', odometer_km: 1 }, { status: 'maintenance', odometer_km: 2 }))).toBe('odometer, status')
    expect(summary(entry('INSERT', null, { name: 'Bole', code: 'BOL' }))).toBe('2 fields set')
    expect(summary(entry('job.succeeded', null, null, { job: 'maintenance-scoring' }))).toBe('maintenance-scoring')
  })
})

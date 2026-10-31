import { describe, expect, it } from 'vitest'
import { coverageText, dueText, intervalsText, leadText, seesEveryDepot } from './format'

describe('service due wording (FMS-129)', () => {
  it('says what made it due, or every measure while upcoming', () => {
    expect(dueText({ due_by: ['km'], remaining: { km: 400, days: 40, engine_hours: null } })).toBe('In 400 km')
    expect(dueText({ due_by: ['km', 'days'], remaining: { km: -1200, days: -2, engine_hours: null } })).toBe('1,200 km over · 2 days over')
    expect(dueText({ due_by: [], remaining: { km: 6000, days: 1, engine_hours: 30 } })).toBe('In 6,000 km · in 1 day · in 30 engine hours')
    expect(dueText({ due_by: ['days'], remaining: { km: null, days: 0, engine_hours: null } })).toBe('Today')
  })

  it('describes a program: its intervals, lead windows and the vehicles it covers', () => {
    expect(intervalsText({ interval_km: 10_000, interval_days: null, interval_engine_hours: null })).toBe('Every 10,000 km')
    expect(intervalsText({ interval_km: 10_000, interval_days: 180, interval_engine_hours: 250 })).toBe('Every 10,000 km, 180 days or 250 engine hours, whichever comes first')
    expect(leadText({ lead_km: 500, lead_days: 14, lead_engine_hours: null })).toBe('Due within 500 km or 14 days')
    expect(coverageText({ vehicle_type: 'truck', fuel_type: 'diesel', make: 'Isuzu', model: 'NPR' })).toBe('Diesel trucks · Isuzu NPR')
    expect(coverageText({ vehicle_type: null, fuel_type: 'electric', make: null, model: null })).toBe('Electric vehicles')
    expect(coverageText({ vehicle_type: null, fuel_type: null, make: null, model: null })).toBe('Every vehicle')
  })

  it('only those who see every depot define fleet-wide programs', () => {
    expect(seesEveryDepot(['fleet_manager'])).toBe(true)
    expect(seesEveryDepot(['depot_admin', 'technician'])).toBe(false)
  })
})

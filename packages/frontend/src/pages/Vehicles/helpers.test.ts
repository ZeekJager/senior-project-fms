import { describe, expect, it } from 'vitest'
import { daysBetween, documentHealth, expiryState, formatDate } from './documents'
import { readFilters, vehicleQuery, writeFilters } from './filters'
import type { Vehicle, VehicleDocument } from './types'
import { changedFields, formFromVehicle, validateVehicleForm, type VehicleFormValues } from './vehicleForm'

describe('expiryState', () => {
  const on = '2026-10-09'
  it.each([
    [null, 'none'],
    ['2026-10-08', 'expired'],
    ['2026-10-09', 'expiring'], // still valid on its last day
    ['2026-11-08', 'expiring'], // 30 days away
    ['2026-11-09', 'valid'], // 31 days away
  ] as const)('%s is %s', (expiresOn, state) => {
    expect(expiryState(expiresOn, on).state).toBe(state)
  })

  it('counts whole days across a month and a year end', () => {
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1)
    expect(daysBetween('2026-10-09', '2026-09-09')).toBe(-30)
  })

  it('summarises a vehicle by its worst documents', () => {
    const doc = (owner: string, expires: string | null) => ({ owner_id: owner, expires_on: expires }) as VehicleDocument
    const health = documentHealth([doc('a', '2026-10-01'), doc('a', '2026-10-20'), doc('a', null), doc('b', '2027-06-01')], on)
    expect(health.get('a')).toEqual({ total: 3, expired: 1, expiring: 1 })
    expect(health.get('b')).toEqual({ total: 1, expired: 0, expiring: 0 })
    expect(health.has('c')).toBe(false)
  })

  it('formats a date without shifting it across time zones', () => {
    expect(formatDate('2027-01-31')).toBe('31 Jan 2027')
  })
})

describe('filters in the URL', () => {
  it('round-trips, writing only what differs from the defaults', () => {
    const filters = readFilters(new URLSearchParams('q=hilux&depot=d-1&status=maintenance&flagged=1&page=3&size=50&order=desc'))
    expect(filters).toMatchObject({ search: 'hilux', depotId: 'd-1', status: 'maintenance', flagged: true, page: 3, pageSize: 50, sortOrder: 'desc' })
    expect(writeFilters(filters).toString()).toBe('q=hilux&depot=d-1&status=maintenance&flagged=1&page=3&size=50&order=desc')
    expect(writeFilters(readFilters(new URLSearchParams())).toString()).toBe('')
  })

  it('ignores values the API would reject', () => {
    expect(readFilters(new URLSearchParams('status=parked&page=-2&size=1000&sort=vin'))).toMatchObject({
      status: '',
      page: 1,
      pageSize: 25,
      sortBy: 'registration_number',
    })
  })

  it('builds the GET /vehicles query', () => {
    const q = new URLSearchParams(vehicleQuery(readFilters(new URLSearchParams('flagged=1&q=%20aa%20'))))
    expect(Object.fromEntries(q)).toEqual({
      page: '1',
      page_size: '25',
      sort_by: 'registration_number',
      sort_order: 'asc',
      search: 'aa',
      maintenance_flag: 'true',
    })
  })
})

describe('vehicle form', () => {
  const valid: VehicleFormValues = {
    registration_number: ' aa   3-12345 ',
    vin: '1hgcm82633a004352',
    make: 'Isuzu',
    model: 'FSR',
    year: '2022',
    vehicle_type: 'truck',
    fuel_type: 'diesel',
    efficiency: '32.5',
    depot_id: 'd-1',
    odometer_km: '1200.5',
  }

  it('normalizes and converts litres per 100 km to whole ml/km without floats', () => {
    const { errors, input } = validateVehicleForm(valid, new Date('2026-10-09'))
    expect(errors).toEqual({})
    expect(input).toEqual({
      registration_number: 'AA 3-12345',
      vin: '1HGCM82633A004352',
      make: 'Isuzu',
      model: 'FSR',
      year: 2022,
      vehicle_type: 'truck',
      fuel_type: 'diesel',
      fuel_efficiency_ml_per_km: 325,
      depot_id: 'd-1',
      odometer_km: 1200.5,
    })
  })

  it('rejects rather than rounds: two decimals of L/100 km, two of km', () => {
    const { errors } = validateVehicleForm({ ...valid, efficiency: '32.55', odometer_km: '10.25' })
    expect(errors.efficiency).toMatch(/one decimal/)
    expect(errors.odometer_km).toMatch(/one decimal/)
  })

  it('needs consumption unless electric', () => {
    expect(validateVehicleForm({ ...valid, efficiency: '' }).errors.efficiency).toMatch(/Required/)
    const electric = validateVehicleForm({ ...valid, fuel_type: 'electric', efficiency: '' })
    expect(electric.errors).toEqual({})
    expect(electric.input?.fuel_efficiency_ml_per_km).toBeNull()
  })

  it('checks plate, VIN, year and required choices', () => {
    const { errors } = validateVehicleForm(
      { ...valid, registration_number: 'AA_1', vin: 'IOQ', year: '1850', vehicle_type: '', depot_id: '' },
      new Date('2026-10-09'),
    )
    expect(Object.keys(errors).sort()).toEqual(['depot_id', 'registration_number', 'vehicle_type', 'vin', 'year'])
  })

  it('edits start from the stored values and send only what changed', () => {
    const vehicle = {
      registration_number: 'AA 3-12345',
      vin: null,
      make: 'Isuzu',
      model: 'FSR',
      year: 2022,
      vehicle_type: 'truck',
      fuel_type: 'diesel',
      fuel_efficiency_ml_per_km: 325,
      depot_id: 'd-1',
      odometer_km: 1200.5,
    } as Vehicle
    const form = formFromVehicle(vehicle)
    expect(form.efficiency).toBe('32.5')
    const { input } = validateVehicleForm({ ...form, model: 'FVR', odometer_km: '1300' })
    expect(changedFields(input!, vehicle)).toEqual({ model: 'FVR', odometer_km: 1300 })
  })
})

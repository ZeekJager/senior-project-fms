import { describe, expect, it } from 'vitest'
import { changedFields, EMPTY_FORM, formFromDriver, validateDriverForm } from './driverForm'
import { driverQuery, readFilters, writeFilters } from './filters'
import type { Driver } from './types'

const base = {
  ...EMPTY_FORM,
  full_name: ' Abebe Kebede ',
  email: 'Abebe@Fleet.Test',
  license_number: ' aa  12345 ',
  license_expiry: '2030-06-30',
  license_categories: ['CE', 'B'] as Driver['license_categories'],
  depot_id: 'd-1',
}

describe('driver form', () => {
  it('normalizes the licence, orders the categories and lower-cases the email', () => {
    const { errors, input } = validateDriverForm(base, true, '2026-10-10')
    expect(errors).toEqual({})
    expect(input).toMatchObject({
      account: { full_name: 'Abebe Kebede', email: 'abebe@fleet.test', phone: null },
      license_number: 'AA 12345',
      license_categories: ['B', 'CE'],
    })
  })

  it('refuses a hire date in the future and a malformed phone', () => {
    const { errors } = validateDriverForm({ ...base, hire_date: '2026-10-11', emergency_phone: 'call me' }, true, '2026-10-10')
    expect(Object.keys(errors).sort()).toEqual(['emergency_phone', 'hire_date'])
  })

  it('editing does not require the account fields and sends only what changed', () => {
    const driver = {
      full_name: 'Abebe Kebede',
      email: 'abebe@fleet.test',
      phone: null,
      license_number: 'AA 12345',
      license_categories: ['B', 'CE'],
      license_expiry: '2030-06-30',
      hire_date: null,
      emergency_phone: null,
      depot_id: 'd-1',
    } as unknown as Driver
    const form = { ...formFromDriver(driver), full_name: '', email: '', license_categories: ['CE', 'B', 'D'] as Driver['license_categories'] }
    const { errors, input } = validateDriverForm(form, false)
    expect(errors).toEqual({})
    expect(changedFields(input!, driver)).toEqual({ license_categories: ['B', 'CE', 'D'] })
  })
})

describe('driver filters', () => {
  it('default to soonest licence expiry first and keep the URL clean', () => {
    const f = readFilters(new URLSearchParams())
    expect(f).toMatchObject({ sortBy: 'license_expiry', sortOrder: 'asc', licence: '', retired: false })
    expect(writeFilters(f).toString()).toBe('')
  })

  it('round-trip and map to the GET /drivers query', () => {
    const f = readFilters(new URLSearchParams('licence=expiring_soon&retired=1&depot=d-1&q=abebe&sort=full_name'))
    expect(writeFilters(f).toString()).toBe('q=abebe&depot=d-1&licence=expiring_soon&retired=1&sort=full_name')
    expect(Object.fromEntries(new URLSearchParams(driverQuery(f)))).toMatchObject({
      license_status: 'expiring_soon',
      status: 'retired',
      depot_id: 'd-1',
      search: 'abebe',
      sort_by: 'full_name',
    })
    expect(readFilters(new URLSearchParams('licence=bogus&sort=email')).licence).toBe('')
  })
})

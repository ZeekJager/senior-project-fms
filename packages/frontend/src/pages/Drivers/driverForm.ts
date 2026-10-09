import { today } from '@/features/documents/expiry'
import type { DriverPatch, NewDriverInput } from './api'
import { normalizeLicence } from './filters'
import { LICENSE_CATEGORIES, type Driver, type LicenseCategory } from './types'

/** The form's fields as typed. Account fields (name, email, phone) are set on add only. */
export interface DriverFormValues {
  full_name: string
  email: string
  phone: string
  license_number: string
  license_categories: LicenseCategory[]
  license_expiry: string
  hire_date: string
  emergency_phone: string
  depot_id: string
}

export type FieldName = keyof DriverFormValues
export type FieldErrors = Partial<Record<FieldName, string>>

export const EMPTY_FORM: DriverFormValues = {
  full_name: '',
  email: '',
  phone: '',
  license_number: '',
  license_categories: [],
  license_expiry: '',
  hire_date: '',
  emergency_phone: '',
  depot_id: '',
}

export function formFromDriver(d: Driver): DriverFormValues {
  return {
    full_name: d.full_name,
    email: d.email,
    phone: d.phone ?? '',
    license_number: d.license_number,
    license_categories: [...d.license_categories],
    license_expiry: d.license_expiry,
    hire_date: d.hire_date ?? '',
    emergency_phone: d.emergency_phone ?? '',
    depot_id: d.depot_id ?? '',
  }
}

// The API's rules (driver.schemas.ts), checked here to put each message next to its field.
const EMAIL = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*\.[A-Za-z]{2,}$/
const PHONE = /^\+?[0-9][0-9 ()-]{5,29}$/
const LICENCE = /^[\p{L}\p{N}][\p{L}\p{N} /-]*$/u
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** Categories in licence order, without duplicates (as the API stores them). */
export function orderedCategories(categories: readonly LicenseCategory[]): LicenseCategory[] {
  return LICENSE_CATEGORIES.filter((c) => categories.includes(c))
}

/**
 * Checks the form and builds the request body. `creating`: the account
 * fields are required and sent; editing leaves them to user administration.
 */
export function validateDriverForm(
  v: DriverFormValues,
  creating: boolean,
  on: string = today(),
): { errors: FieldErrors; input: NewDriverInput | null } {
  const errors: FieldErrors = {}
  if (creating) {
    if (!v.full_name.trim()) errors.full_name = 'Enter the driver’s full name.'
    else if (v.full_name.trim().length > 255) errors.full_name = 'At most 255 characters.'
    if (!v.email.trim()) errors.email = 'Enter an email for the driver’s account.'
    else if (!EMAIL.test(v.email.trim())) errors.email = 'Enter a valid email address, like name@example.com.'
    if (v.phone.trim() && !PHONE.test(v.phone.trim())) errors.phone = 'A phone number such as +251 911 234567.'
  }

  const licence = normalizeLicence(v.license_number)
  if (!licence) errors.license_number = 'Enter the licence number.'
  else if (licence.length > 100 || !LICENCE.test(licence)) errors.license_number = 'Letters, digits, spaces, hyphens and slashes only.'

  if (!v.license_expiry) errors.license_expiry = 'Enter the expiry date on the licence.'
  else if (!DATE.test(v.license_expiry)) errors.license_expiry = 'A date, e.g. 2030-06-30.'

  if (v.hire_date && (!DATE.test(v.hire_date) || v.hire_date > on)) errors.hire_date = 'A date that is not in the future.'
  if (v.emergency_phone.trim() && !PHONE.test(v.emergency_phone.trim())) errors.emergency_phone = 'A phone number such as +251 911 234567.'
  if (!v.depot_id) errors.depot_id = 'Choose the home depot.'

  if (Object.keys(errors).length > 0) return { errors, input: null }
  return {
    errors,
    input: {
      account: { full_name: v.full_name.trim(), email: v.email.trim().toLowerCase(), phone: v.phone.trim() || null },
      license_number: licence,
      license_categories: orderedCategories(v.license_categories),
      license_expiry: v.license_expiry,
      hire_date: v.hire_date || null,
      emergency_phone: v.emergency_phone.trim() || null,
      depot_id: v.depot_id,
    },
  }
}

/** For PATCH: only the licence, depot and contact fields that changed. */
export function changedFields(input: NewDriverInput, original: Driver): DriverPatch {
  const patch: DriverPatch = {}
  if (input.license_number !== original.license_number) patch.license_number = input.license_number
  if (input.license_categories.join() !== original.license_categories.join()) patch.license_categories = input.license_categories
  if (input.license_expiry !== original.license_expiry) patch.license_expiry = input.license_expiry
  if (input.hire_date !== original.hire_date) patch.hire_date = input.hire_date
  if (input.emergency_phone !== original.emergency_phone) patch.emergency_phone = input.emergency_phone
  if (input.depot_id !== original.depot_id) patch.depot_id = input.depot_id
  return patch
}

/** API field names (error details) to form fields. */
export const API_FIELDS: Record<string, FieldName> = {
  'account.full_name': 'full_name',
  'account.email': 'email',
  'account.phone': 'phone',
  license_number: 'license_number',
  license_categories: 'license_categories',
  license_expiry: 'license_expiry',
  hire_date: 'hire_date',
  emergency_phone: 'emergency_phone',
  depot_id: 'depot_id',
}

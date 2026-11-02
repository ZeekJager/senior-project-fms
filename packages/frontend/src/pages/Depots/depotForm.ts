import { formatCoordinates, parseCoordinates } from '@/pages/Routes/routeForm'
import type { DepotInput, DepotRecord } from './api'

/** The form's fields as typed: always text. */
export interface DepotFormValues {
  name: string
  code: string
  location: string
  address: string
  city: string
  country: string
  timezone: string
  /** "latitude, longitude", as a map app copies it. */
  coordinates: string
  capacity: string
}

export type DepotField = keyof DepotFormValues
export type DepotFieldErrors = Partial<Record<DepotField, string>>

export const DEFAULT_TIME_ZONE = 'Africa/Addis_Ababa'

export const EMPTY_DEPOT: DepotFormValues = {
  name: '',
  code: '',
  location: '',
  address: '',
  city: '',
  country: 'Ethiopia',
  timezone: DEFAULT_TIME_ZONE,
  coordinates: '',
  capacity: '',
}

export function formFromDepot(d: DepotRecord): DepotFormValues {
  return {
    name: d.name,
    code: d.code ?? '',
    location: d.location,
    address: d.address ?? '',
    city: d.city ?? '',
    country: d.country ?? '',
    timezone: d.timezone ?? '',
    coordinates: d.latitude !== null && d.longitude !== null ? formatCoordinates({ latitude: d.latitude, longitude: d.longitude }) : '',
    capacity: d.capacity === null ? '' : String(d.capacity),
  }
}

const CODE = /^[A-Z0-9][A-Z0-9-]*$/

function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

const optional = (s: string) => s.trim() || null

/** Checks the form as the API would (api-contract §6.1), so most mistakes are caught before sending. */
export function validateDepotForm(v: DepotFormValues): { errors: DepotFieldErrors; input: DepotInput | null } {
  const errors: DepotFieldErrors = {}
  if (!v.name.trim()) errors.name = 'Give the depot a name.'
  else if (v.name.trim().length > 255) errors.name = 'At most 255 characters.'
  if (!v.location.trim()) errors.location = 'Where it is, as people say it, e.g. Adama.'
  const code = v.code.trim().toUpperCase()
  if (code && (!CODE.test(code) || code.length > 50)) errors.code = 'Letters, digits and hyphens, e.g. ADM-01.'
  const zone = v.timezone.trim()
  if (zone && !isTimeZone(zone)) errors.timezone = 'A time zone name, e.g. Africa/Addis_Ababa.'
  const point = parseCoordinates(v.coordinates)
  if (!point.ok) errors.coordinates = point.error
  const capacityText = v.capacity.trim()
  if (capacityText && (!/^\d{1,6}$/.test(capacityText) || Number(capacityText) > 100_000)) errors.capacity = 'A whole number of vehicles, up to 100,000.'
  if (Object.keys(errors).length > 0 || !point.ok) return { errors, input: null }
  return {
    errors,
    input: {
      name: v.name.trim(),
      location: v.location.trim(),
      code: code || null,
      address: optional(v.address),
      city: optional(v.city),
      country: optional(v.country),
      timezone: zone || null,
      latitude: point.value?.latitude ?? null,
      longitude: point.value?.longitude ?? null,
      capacity: capacityText ? Number(capacityText) : null,
    },
  }
}

/** Only what changed, for PATCH. Coordinates go as a pair, as the API requires. */
export function changedDepotFields(input: DepotInput, d: DepotRecord): Partial<DepotInput> {
  const patch: Partial<DepotInput> = {}
  for (const key of ['name', 'location', 'code', 'address', 'city', 'country', 'timezone', 'capacity'] as const) {
    if (input[key] !== d[key]) Object.assign(patch, { [key]: input[key] })
  }
  if (input.latitude !== d.latitude || input.longitude !== d.longitude) Object.assign(patch, { latitude: input.latitude, longitude: input.longitude })
  return patch
}

/** The form field an API error detail is about. */
export function depotFormField(field: string | undefined): DepotField | null {
  if (field === 'latitude' || field === 'longitude') return 'coordinates'
  return field && field in EMPTY_DEPOT ? (field as DepotField) : null
}

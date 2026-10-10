import { formatMinor, parseDecimal } from '@/components/shared'
import type { VehicleInput } from './api'
import { normalizePlate } from './filters'
import type { FuelType, Vehicle, VehicleType } from './types'

/** The form's fields as typed: always text, so nothing is rounded or lost while editing. */
export interface VehicleFormValues {
  registration_number: string
  vin: string
  make: string
  model: string
  year: string
  vehicle_type: VehicleType | ''
  fuel_type: FuelType | ''
  /** Litres per 100 km, at most one decimal. Stored as whole ml/km: 32.5 L/100 km is 325 ml/km. */
  efficiency: string
  depot_id: string
  odometer_km: string
}

export type FieldName = keyof VehicleFormValues
export type FieldErrors = Partial<Record<FieldName, string>>

export const EMPTY_FORM: VehicleFormValues = {
  registration_number: '',
  vin: '',
  make: '',
  model: '',
  year: '',
  vehicle_type: '',
  fuel_type: '',
  efficiency: '',
  depot_id: '',
  odometer_km: '',
}

export function formFromVehicle(v: Vehicle): VehicleFormValues {
  return {
    registration_number: v.registration_number,
    vin: v.vin ?? '',
    make: v.make,
    model: v.model,
    year: v.year === null ? '' : String(v.year),
    vehicle_type: v.vehicle_type,
    fuel_type: v.fuel_type,
    // ml/km is L/100 km with one implied decimal: 325 -> "32.5".
    efficiency: v.fuel_efficiency_ml_per_km === null ? '' : formatMinor(v.fuel_efficiency_ml_per_km, 1, 1, { group: false }),
    depot_id: v.depot_id,
    odometer_km: String(v.odometer_km),
  }
}

const PLATE = /^[\p{L}\p{N}][\p{L}\p{N} -]*$/u
const VIN = /^[A-HJ-NPR-Z0-9]{17}$/
const ODOMETER = /^\d{1,11}(\.\d)?$/
const MAX_ML_PER_KM = 100_000

/**
 * Checks the form the way the API will (api-contract §6.2) and builds the
 * request body. The API stays the authority; this saves a round trip and
 * puts each message next to its field.
 */
export function validateVehicleForm(values: VehicleFormValues, now: Date = new Date()): { errors: FieldErrors; input: VehicleInput | null } {
  const errors: FieldErrors = {}
  const plate = normalizePlate(values.registration_number)
  if (!plate) errors.registration_number = 'Enter the registration number.'
  else if (plate.length > 50 || !PLATE.test(plate)) errors.registration_number = 'Use letters, digits, spaces and hyphens (up to 50).'

  const vin = values.vin.trim().toUpperCase()
  if (vin && !VIN.test(vin)) errors.vin = 'A VIN is 17 characters: digits and capitals except I, O and Q.'

  if (!values.make.trim()) errors.make = 'Enter the make.'
  else if (values.make.trim().length > 100) errors.make = 'At most 100 characters.'
  if (!values.model.trim()) errors.model = 'Enter the model.'
  else if (values.model.trim().length > 100) errors.model = 'At most 100 characters.'

  let year: number | null = null
  if (values.year.trim()) {
    year = Number.parseInt(values.year.trim(), 10)
    const max = now.getFullYear() + 1
    if (!/^\d{4}$/.test(values.year.trim()) || year < 1900 || year > max) errors.year = `A year from 1900 to ${max}.`
  }

  if (!values.vehicle_type) errors.vehicle_type = 'Choose the vehicle type.'
  if (!values.fuel_type) errors.fuel_type = 'Choose the fuel type.'

  let mlPerKm: number | null = null
  if (values.fuel_type !== 'electric') {
    const parsed = parseDecimal(values.efficiency, 1)
    if (!parsed.ok) {
      errors.efficiency = parsed.error === 'too_many_decimals' ? 'At most one decimal, e.g. 32.5.' : 'Enter litres per 100 km, e.g. 32.5.'
    } else if (parsed.minor === null) {
      // Until a fuel type is chosen, that field's message is the one that matters.
      if (values.fuel_type) errors.efficiency = 'Required unless the vehicle is electric.'
    } else if (parsed.minor <= 0 || parsed.minor > MAX_ML_PER_KM) {
      errors.efficiency = 'Between 0.1 and 10,000 L/100 km.'
    } else {
      mlPerKm = parsed.minor
    }
  }

  if (!values.depot_id) errors.depot_id = 'Choose a depot.'

  const odometer = values.odometer_km.trim()
  if (odometer && !ODOMETER.test(odometer)) errors.odometer_km = 'Kilometres, with at most one decimal.'

  if (Object.keys(errors).length > 0) return { errors, input: null }
  return {
    errors,
    input: {
      registration_number: plate,
      vin: vin || null,
      make: values.make.trim(),
      model: values.model.trim(),
      year,
      vehicle_type: values.vehicle_type,
      fuel_type: values.fuel_type,
      fuel_efficiency_ml_per_km: mlPerKm,
      depot_id: values.depot_id,
      ...(odometer ? { odometer_km: Number(odometer) } : {}),
    },
  }
}

/** For PATCH: only what changed against the vehicle as loaded. */
export function changedFields(input: VehicleInput, original: Vehicle): Partial<VehicleInput> {
  const patch: Partial<VehicleInput> = {}
  const before: Record<keyof VehicleInput, unknown> = {
    registration_number: original.registration_number,
    vin: original.vin,
    make: original.make,
    model: original.model,
    year: original.year,
    vehicle_type: original.vehicle_type,
    fuel_type: original.fuel_type,
    fuel_efficiency_ml_per_km: original.fuel_efficiency_ml_per_km,
    depot_id: original.depot_id,
    odometer_km: original.odometer_km,
  }
  for (const key of Object.keys(input) as (keyof VehicleInput)[]) {
    if (input[key] !== before[key]) (patch as Record<string, unknown>)[key] = input[key]
  }
  return patch
}

/** API field names (error details) to form fields. */
export const API_FIELDS: Record<string, FieldName> = {
  registration_number: 'registration_number',
  vin: 'vin',
  make: 'make',
  model: 'model',
  year: 'year',
  vehicle_type: 'vehicle_type',
  fuel_type: 'fuel_type',
  fuel_efficiency_ml_per_km: 'efficiency',
  depot_id: 'depot_id',
  odometer_km: 'odometer_km',
}

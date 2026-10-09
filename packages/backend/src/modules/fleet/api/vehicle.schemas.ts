import { z } from 'zod';
import { pageQuery } from '../../../shared/http/pagination';
import { FLOAT_IN_MONEY_PATH } from '../../../shared/http/validate';
import {
  FUEL_TYPES,
  VEHICLE_STATUSES,
  VEHICLE_TYPES,
  VIN_PATTERN,
  normalizeRegistration,
  normalizeVin,
  requiresFuelEfficiency,
} from '../domain/vehicle';
import { VEHICLE_SORT_COLUMNS, type VehicleSortKey } from '../infrastructure/vehicle.repository';

const MAX_FUEL_EFFICIENCY_ML_PER_KM = 100_000;
const MAX_ODOMETER_KM = 99_999_999_999.9;

const registrationNumber = z
  .string()
  .transform(normalizeRegistration)
  .pipe(
    z
      .string()
      .min(1)
      .max(50)
      .regex(/^[\p{L}\p{N}][\p{L}\p{N} -]*$/u, 'Letters, digits, spaces and hyphens only.'),
  );

const vin = z.string().transform(normalizeVin).pipe(z.string().regex(VIN_PATTERN, '17 characters: digits and capitals except I, O and Q.'));

const name = z.string().trim().min(1).max(100);

const year = z
  .number()
  .int()
  .min(1900)
  .max(new Date().getUTCFullYear() + 1);

// Integer millilitres per km: a fraction is a float in a fuel path, which the
// contract answers with VALIDATION_FLOAT_IN_MONEY_PATH (§17), not a rounding.
const fuelEfficiency = z
  .number()
  .refine(Number.isInteger, { message: 'Whole millilitres per km.', params: { reason: FLOAT_IN_MONEY_PATH } })
  .refine((n) => n > 0 && n <= MAX_FUEL_EFFICIENCY_ML_PER_KM, {
    message: `Between 1 and ${MAX_FUEL_EFFICIENCY_ML_PER_KM}.`,
    params: { reason: 'out_of_range' },
  });

// A physical measurement: one decimal at most, as stored (NUMERIC(12,1)).
const odometer = z
  .number()
  .min(0)
  .max(MAX_ODOMETER_KM)
  .refine((n) => /^\d+(\.\d)?$/.test(String(n)), { message: 'At most one decimal.', params: { reason: 'too_many_decimals' } });

/**
 * The writable fields (api-contract §6.2, §16.1). status, maintenance_flag and
 * health_score are set by their own workflows (FMS-76, maintenance, the ML
 * service) and are rejected here as `not_writable`, like any unknown field.
 */
const writable = {
  registration_number: registrationNumber,
  vin: vin.nullable().optional(),
  make: name,
  model: name,
  year: year.nullable().optional(),
  vehicle_type: z.enum(VEHICLE_TYPES),
  fuel_type: z.enum(FUEL_TYPES),
  fuel_efficiency_ml_per_km: fuelEfficiency.nullable().optional(),
  depot_id: z.uuid(),
  odometer_km: odometer.optional(),
};

/** POST /vehicles. Fuel efficiency is required unless the vehicle is electric. */
export const vehicleCreateBody = z
  .strictObject(writable)
  .refine((v) => !requiresFuelEfficiency(v.fuel_type) || v.fuel_efficiency_ml_per_km != null, {
    message: 'Required unless fuel_type is electric.',
    path: ['fuel_efficiency_ml_per_km'],
    params: { reason: 'required' },
  });

/** PATCH /vehicles/{id}: at least one writable field. The fuel-efficiency rule is checked against the merged vehicle. */
export const vehicleUpdateBody = z
  .strictObject(writable)
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Send at least one field to change.', params: { reason: 'empty_update' } });

const SORT_KEYS = Object.keys(VEHICLE_SORT_COLUMNS) as [VehicleSortKey, ...VehicleSortKey[]];

/** GET /vehicles query (api-contract §6.2, §18). An empty `search` means no search. */
export const vehicleListQuery = z.object({
  ...pageQuery,
  depot_id: z.uuid().optional(),
  status: z.enum(VEHICLE_STATUSES).optional(),
  maintenance_flag: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  search: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((s) => s || undefined),
  sort_by: z.enum(SORT_KEYS).default('registration_number'),
  sort_order: z.enum(['asc', 'desc']).default('asc'),
});

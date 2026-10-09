import { z } from 'zod';
import { pageQuery } from '../../../shared/http/pagination';
import { LICENSE_CATEGORIES, LICENSE_STATUSES, OPERATING_TIME_ZONE, normalizeLicense } from '../domain/driver';
import { DRIVER_SORT_COLUMNS, type DriverSortKey } from '../infrastructure/driver.repository';

/** Today's date in Addis Ababa, `YYYY-MM-DD`. */
function today(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: OPERATING_TIME_ZONE }).format(new Date());
}

const licenseNumber = z
  .string()
  .transform(normalizeLicense)
  .pipe(
    z
      .string()
      .min(1)
      .max(100)
      .regex(/^[\p{L}\p{N}][\p{L}\p{N} /-]*$/u, 'Letters, digits, spaces, hyphens and slashes only.'),
  );

const date = z.iso.date();
const phone = z.string().trim().regex(/^\+?[0-9][0-9 ()-]{5,29}$/, 'A phone number such as +251 911 234567.');

/**
 * The writable driver fields (api-contract §6.3). Name, email and phone are
 * the user account's and change through user administration; `user_id` is
 * fixed once the driver exists.
 */
const writable = {
  license_number: licenseNumber,
  // An Ethiopian licence class (LICENSE_CATEGORY_VEHICLE_TYPES); it decides which vehicle types the driver may drive.
  license_category: z.enum(LICENSE_CATEGORIES).nullable().optional(),
  license_expiry: date,
  hire_date: date
    .refine((d) => d <= today(), { message: 'Cannot be in the future.', params: { reason: 'in_future' } })
    .nullable()
    .optional(),
  emergency_phone: phone.nullable().optional(),
  depot_id: z.uuid(),
};

/** POST /drivers: an existing user account with the driver role, its licence, and its home depot. */
export const driverCreateBody = z.strictObject({ user_id: z.uuid(), ...writable });

/** PATCH /drivers/{id}: at least one writable field. */
export const driverUpdateBody = z
  .strictObject(writable)
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Send at least one field to change.', params: { reason: 'empty_update' } });

const SORT_KEYS = Object.keys(DRIVER_SORT_COLUMNS) as [DriverSortKey, ...DriverSortKey[]];

/** GET /drivers query (api-contract §6.3, §18). */
export const driverListQuery = z.object({
  ...pageQuery,
  depot_id: z.uuid().optional(),
  license_expiring_before: date.optional(),
  license_status: z.enum(LICENSE_STATUSES).optional(),
  search: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((s) => s || undefined),
  status: z.enum(['active', 'retired']).optional(),
  sort_by: z.enum(SORT_KEYS).default('license_number'),
  sort_order: z.enum(['asc', 'desc']).default('asc'),
});

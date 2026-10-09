import { z } from 'zod';
import { pageQuery } from '../../../shared/http/pagination';
import { LICENSE_CATEGORIES, LICENSE_STATUSES, OPERATING_TIME_ZONE, normalizeCategories, normalizeLicense } from '../domain/driver';
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
/** Field rules shared by POST /drivers and the CSV import. */
export const driverFields = {
  license_number: licenseNumber,
  // European categories held (LICENSE_CATEGORY_VEHICLE_TYPES); they decide which vehicle types the driver may drive.
  // Stored without duplicates in licence order; [] clears them.
  license_categories: z.array(z.enum(LICENSE_CATEGORIES)).max(LICENSE_CATEGORIES.length).transform(normalizeCategories).optional(),
  license_expiry: date,
  hire_date: date
    .refine((d) => d <= today(), { message: 'Cannot be in the future.', params: { reason: 'in_future' } })
    .nullable()
    .optional(),
  emergency_phone: phone.nullable().optional(),
};

const writable = { ...driverFields, depot_id: z.uuid() };

/** A new account for POST /drivers: created with the driver role and no password (FMS-19). */
const newAccount = z.strictObject({
  full_name: z.string().trim().min(1).max(255),
  email: z.string().trim().toLowerCase().pipe(z.email().max(255)),
  phone: phone.nullable().optional(),
});

/**
 * POST /drivers: the licence and home depot, plus the person: an existing
 * user account with the driver role (`user_id`), or a new one (`account`).
 * Exactly one of the two.
 */
export const driverCreateBody = z
  .strictObject({ user_id: z.uuid().optional(), account: newAccount.optional(), ...writable })
  .refine((v) => (v.user_id === undefined) !== (v.account === undefined), {
    message: 'Send user_id for an existing account or account for a new one, not both.',
    path: ['user_id'],
    params: { reason: 'user_id_or_account' },
  });

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

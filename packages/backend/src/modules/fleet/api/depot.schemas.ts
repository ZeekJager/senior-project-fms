import { z } from 'zod';
import { pageQuery } from '../../../shared/http/pagination';

/** An IANA time zone the runtime knows (Africa/Addis_Ababa). */
function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).transform((s) => s || null).nullable().optional();

/** Codes are how people name depots in spreadsheets (CSV driver import): stored trimmed and upper case. */
const code = z
  .string()
  .transform((s) => s.trim().toUpperCase())
  .pipe(z.string().min(1).max(50).regex(/^[A-Z0-9][A-Z0-9-]*$/, 'Letters, digits and hyphens, e.g. ADD-01.'));

/** The writable fields (api-contract §6.1). `is_active` changes only through DELETE and reactivate. */
const fields = {
  name: text(255),
  location: text(255),
  code: code.nullable().optional(),
  address: optionalText(1000),
  city: optionalText(120),
  country: optionalText(120),
  timezone: z.string().trim().refine(isTimeZone, { message: 'An IANA time zone, e.g. Africa/Addis_Ababa.', params: { reason: 'invalid_time_zone' } }).nullable().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  capacity: z.number().int().min(0).max(100_000).nullable().optional(),
};

/** POST /depots and PUT /depots/{id}: name and location required. */
export const depotCreateBody = z.strictObject(fields);

/** PATCH /depots/{id}: any non-empty subset. */
export const depotUpdateBody = z
  .strictObject(fields)
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Send at least one field to change.', params: { reason: 'empty_update' } });

const flag = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .default(false);

/** GET /depots query. */
export const depotListQuery = z.object({
  ...pageQuery,
  status: z.enum(['active', 'inactive', 'all']).default('active'),
  in_scope: flag,
  search: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((s) => s || undefined),
});

import { z } from 'zod';
import { pageQuery } from '../../../shared/http/pagination';
import { USER_STATUSES } from '../domain/user-admin';

const text = (max: number) => z.string().trim().min(1).max(max);
const email = z.string().trim().toLowerCase().pipe(z.email().max(255));
const phone = z
  .string()
  .trim()
  .regex(/^\+?[0-9][0-9 ()-]{5,29}$/, 'A phone number such as +251 911 234567.')
  .transform((s) => s || null)
  .nullable()
  .optional();
const depotId = z.uuid().nullable().optional();
const status = z.enum(USER_STATUSES as [string, ...string[]]);

/** Role names, at least one, no repeats. */
const roles = z
  .array(z.string().trim().min(1).max(50))
  .min(1)
  .max(10)
  .refine((r) => new Set(r).size === r.length, { message: 'Each role once.', params: { reason: 'duplicate' } });

/** POST /users (api-contract §5.1). No password: the user sets one through the setup link. */
export const userCreateBody = z.strictObject({
  email,
  full_name: text(255),
  phone,
  depot_id: depotId,
  roles,
});

/** PATCH /users/{id}: any non-empty subset. `status` other than active deactivates. */
export const userUpdateBody = z
  .strictObject({ email, full_name: text(255), phone, depot_id: depotId, status, roles })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Send at least one field to change.', params: { reason: 'empty_update' } });

/** GET /users query. */
export const userListQuery = z.object({
  ...pageQuery,
  search: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((s) => s || undefined),
  role: z.string().trim().max(50).optional(),
  status: status.optional(),
  depot_id: z.uuid().optional(),
});

/** POST /auth/password. The length rules are checked after the token (passwordProblem). */
export const passwordSetBody = z.strictObject({
  token: z.string().min(1).max(200),
  password: z.string().min(1).max(1024),
});

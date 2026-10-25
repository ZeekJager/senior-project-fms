import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../shared/http/async-handler';
import { idempotent, OFFLINE_QUEUE_TTL_HOURS } from '../../../shared/http/idempotency';
import { pageMeta, pageQuery } from '../../../shared/http/pagination';
import { parseInput } from '../../../shared/http/validate';
import { authorize } from '../../auth';
import type { Caller } from '../application/caller';
import type { DvirService } from '../application/dvir.service';
import { DVIR_TYPES } from '../domain/dvir';
import { vehicleNotFound } from '../domain/vehicle';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_ITEMS = 100;

const item = z.strictObject({
  name: z.string().trim().min(1).max(100),
  passed: z.boolean(),
  notes: z
    .string()
    .trim()
    .max(1000)
    .nullish()
    .transform((n) => n || null),
});

const instant = z.iso.datetime({ offset: true }).transform((s) => new Date(s));

/**
 * POST /dvir-reports and /dvir (api-contract §6.4). `items` is the checklist,
 * one entry per thing checked; a failed one is a defect. Anything else is
 * `not_writable`; a `type` outside the list is VALIDATION_INVALID_ENUM.
 */
const createBody = z.strictObject({
  vehicle_id: z.uuid(),
  trip_id: z.uuid().optional(),
  driver_id: z.uuid().optional(),
  type: z.enum(DVIR_TYPES),
  items: z
    .array(item)
    .min(1)
    .max(MAX_ITEMS)
    .refine((items) => new Set(items.map((i) => i.name.toLowerCase())).size === items.length, {
      message: 'Each item once.',
      params: { reason: 'duplicate_item' },
    }),
  issues_found: z.boolean().optional(),
  submitted_at: instant.optional(),
});

/** Addis Ababa is UTC+3 all year: a date filter means that local day (as in GET /audit-logs and /trips). */
const ADDIS_OFFSET = '+03:00';

/** A date `to` covers that whole day: the bound is the next local midnight. */
function bound(value: string, end: boolean): Date {
  if (value.includes('T')) return new Date(value);
  if (!end) return new Date(`${value}T00:00:00${ADDIS_OFFSET}`);
  const next = new Date(`${value}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return new Date(`${next.toISOString().slice(0, 10)}T00:00:00${ADDIS_OFFSET}`);
}

const instantOrDate = z.union([z.iso.datetime({ offset: true }), z.iso.date()]);

const listQuery = z
  .object({
    ...pageQuery,
    type: z.enum(DVIR_TYPES).optional(),
    issues_found: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    from: instantOrDate.optional(),
    to: instantOrDate.optional(),
    sort_order: z.enum(['asc', 'desc']).default('desc'),
  })
  .transform(({ from, to, ...rest }) => ({ ...rest, from: from ? bound(from, false) : undefined, to: to ? bound(to, true) : undefined }));

function caller(req: Request): Caller {
  return { user: req.user!, correlationId: req.correlationId };
}

function vehicleId(req: Request): string {
  const id = req.params.vehicleId;
  if (!UUID.test(id)) throw vehicleNotFound();
  return id;
}

/**
 * Inspection reports (api-contract §6.4, FMS-36). `dvir:write` (drivers,
 * technicians, depot admins, fleet managers, admins) submits; `dvir:read`
 * reads. A driver submits and sees only their own. The POST takes an optional
 * Idempotency-Key, and a trip's inspection of one type is recorded once on its
 * own: submitting it again answers `200` with the original and `created: false`.
 */
export function dvirRouter(service: DvirService): Router {
  const router = Router();

  const submit: RequestHandler = asyncHandler(async (req, res) => {
    const { report, created } = await service.create(caller(req), parseInput(createBody, req.body));
    res.status(created ? 201 : 200).json({ data: report, meta: { created, request_id: req.correlationId } });
  });

  // The canonical path, and the legacy-compatible alias with the same behaviour.
  for (const path of ['/dvir-reports', '/dvir']) router.post(path, authorize('dvir:write'), idempotent({ ttlHours: OFFLINE_QUEUE_TTL_HOURS }), submit);

  router.get(
    '/vehicles/:vehicleId/dvir-reports',
    authorize('dvir:read'),
    asyncHandler(async (req, res) => {
      const query = parseInput(listQuery, req.query);
      const { items, total } = await service.listForVehicle(caller(req), vehicleId(req), query);
      res.json({ data: items, meta: { ...pageMeta(query, total), request_id: req.correlationId } });
    }),
  );

  return router;
}

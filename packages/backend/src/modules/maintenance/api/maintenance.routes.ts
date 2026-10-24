import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../shared/http/async-handler';
import { etagFor, ifMatchVersion } from '../../../shared/http/etag';
import { pageMeta, pageQuery } from '../../../shared/http/pagination';
import { FLOAT_IN_MONEY_PATH, parseInput, rejectFractionalMoney } from '../../../shared/http/validate';
import { authorize } from '../../auth';
import type { Caller, MaintenanceService } from '../application/maintenance.service';
import { FAILURE_COMPONENTS, FAILURE_DETECTIONS, FAILURE_MODES, MAX_FAILURES_PER_REQUEST } from '../domain/failure';
import { MAINTENANCE_PRIORITIES, MAINTENANCE_STATUSES, MAINTENANCE_TYPES, maintenanceNotFound, maintenanceVehicleMissing } from '../domain/maintenance';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CENTS = 2_147_483_647;

/** Whole cents: a fraction is VALIDATION_FLOAT_IN_MONEY_PATH, never rounded (api-contract §17). */
const cents = z
  .number()
  .refine(Number.isInteger, { message: 'Whole cents.', params: { reason: FLOAT_IN_MONEY_PATH } })
  .refine((n) => n >= 0 && n <= MAX_CENTS, { message: 'Between 0 and 2147483647.', params: { reason: 'out_of_range' } });

/** Hours with at most two decimals, as stored (NUMERIC(8,2)). */
const labourHours = z
  .number()
  .min(0)
  .max(999_999)
  .refine((n) => /^\d+(\.\d{1,2})?$/.test(String(n)), { message: 'At most two decimals.', params: { reason: 'too_many_decimals' } });

const odometer = z
  .number()
  .min(0)
  .refine((n) => /^\d+(\.\d)?$/.test(String(n)), { message: 'At most one decimal.', params: { reason: 'too_many_decimals' } });

const instant = z.iso.datetime({ offset: true });
const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).transform((s) => s || null).nullable().optional();

const partUse = z.strictObject({
  part_id: z.uuid(),
  quantity: z.number().int().min(1).max(10_000),
  unit_cost_cents: cents,
});

/** What failed (FMS-125): a catalogue component and mode (docs/maintenance.md); anything else is 400. */
const failure = z.strictObject({
  component: z.enum(FAILURE_COMPONENTS),
  failure_mode: z.enum(FAILURE_MODES),
  unplanned: z.boolean(),
  detected_by: z.enum(FAILURE_DETECTIONS).optional(),
  occurred_at: instant.optional(),
  odometer_km: odometer.nullable().optional(),
  incident_id: z.uuid().nullable().optional(),
  notes: optionalText(2000),
});

const failures = z.array(failure).max(MAX_FAILURES_PER_REQUEST).optional();

/** POST /maintenance (the card's vehicleId, description, labourHours, totalCostCents, parts[], in snake_case). */
const createBody = rejectFractionalMoney(
  z.strictObject({
    vehicle_id: z.uuid(),
    description: text(2000),
    labour_hours: labourHours,
    total_cost_cents: cents,
    parts: z
      .array(partUse)
      .max(50)
      .refine((parts) => new Set(parts.map((p) => p.part_id)).size === parts.length, {
        message: 'List each part once, with its total quantity.',
        params: { reason: 'duplicate_part' },
      })
      .optional(),
    maintenance_type: z.enum(MAINTENANCE_TYPES).optional(),
    status: z.enum(['scheduled', 'open', 'in_progress']).optional(),
    priority: z.enum(MAINTENANCE_PRIORITIES).optional(),
    scheduled_at: instant.nullable().optional(),
    odometer_km: odometer.nullable().optional(),
    workshop: optionalText(255),
    notes: optionalText(4000),
    failures,
  }),
);

/** PUT (the card) and PATCH (the contract): the fields sent. `completed_at` completes the work. */
const updateBody = rejectFractionalMoney(
  z
    .strictObject({
      description: text(2000),
      labour_hours: labourHours,
      total_cost_cents: cents,
      maintenance_type: z.enum(MAINTENANCE_TYPES),
      status: z.enum(MAINTENANCE_STATUSES),
      priority: z.enum(MAINTENANCE_PRIORITIES),
      scheduled_at: instant.nullable(),
      odometer_km: odometer.nullable(),
      workshop: optionalText(255),
      notes: optionalText(4000),
      completed_at: instant,
    })
    .partial()
    .refine((v) => Object.keys(v).length > 0, { message: 'Send at least one field to change.', params: { reason: 'empty_update' } }),
);

const completeBody = z.strictObject({ completed_at: instant.optional(), notes: optionalText(4000), failures });

const flag = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();

/** Addis Ababa is UTC+3 all year: a date filter means that local day (as in GET /incidents and /fuel-logs). */
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

const failureQuery = z
  .strictObject({
    ...pageQuery,
    vehicle_id: z.uuid().optional(),
    component: z.enum(FAILURE_COMPONENTS).optional(),
    unplanned: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    from: instantOrDate.optional(),
    to: instantOrDate.optional(),
  })
  .transform(({ from, to, ...rest }) => ({ ...rest, from: from ? bound(from, false) : undefined, to: to ? bound(to, true) : undefined }));

const listQuery = z.object({
  ...pageQuery,
  vehicle_id: z.uuid().optional(),
  status: z.enum(MAINTENANCE_STATUSES).optional(),
  open: flag,
  maintenance_type: z.enum(MAINTENANCE_TYPES).optional(),
  sort_order: z.enum(['asc', 'desc']).default('desc'),
});

function caller(req: Request): Caller {
  return { user: req.user!, correlationId: req.correlationId };
}

function recordId(req: Request): string {
  const id = req.params.recordId;
  if (!UUID.test(id)) throw maintenanceNotFound();
  return id;
}

/**
 * Maintenance records (api-contract §10.1, FMS-22). The card's /maintenance
 * paths and the contract's canonical /maintenance-records paths are the same
 * handlers. Reads: maintenance:read; writes: maintenance:write (not
 * dispatchers); POST .../complete: maintenance:execute. What failed
 * (FMS-125): POST .../failures (maintenance:write) and GET /failure-events
 * (maintenance:read).
 */
export function maintenanceRouter(service: MaintenanceService): Router {
  const router = Router();

  for (const base of ['/maintenance', '/maintenance-records']) {
    router.get(
      base,
      authorize('maintenance:read'),
      asyncHandler(async (req, res) => {
        const query = parseInput(listQuery, req.query);
        const { items, total } = await service.list(caller(req), query);
        res.json({ data: items, meta: { ...pageMeta(query, total), request_id: req.correlationId } });
      }),
    );

    router.post(
      base,
      authorize('maintenance:write'),
      asyncHandler(async (req, res) => {
        const { record, warnings } = await service.create(caller(req), parseInput(createBody, req.body));
        res
          .status(201)
          .location(`/api/v1/maintenance-records/${record.id}`)
          .set('ETag', etagFor(record.version))
          .json({ data: record, meta: { request_id: req.correlationId, warnings } });
      }),
    );

    router.get(
      `${base}/:recordId`,
      authorize('maintenance:read'),
      asyncHandler(async (req, res) => {
        const record = await service.get(caller(req), recordId(req));
        res.set('ETag', etagFor(record.version)).json({ data: record, meta: { request_id: req.correlationId } });
      }),
    );

    for (const method of ['put', 'patch'] as const) {
      router[method](
        `${base}/:recordId`,
        authorize('maintenance:write'),
        asyncHandler(async (req, res) => {
          const id = recordId(req);
          const expected = ifMatchVersion(req.get('If-Match'));
          const record = await service.update(caller(req), id, parseInput(updateBody, req.body), expected);
          res.set('ETag', etagFor(record.version)).json({ data: record, meta: { request_id: req.correlationId } });
        }),
      );
    }

    router.post(
      `${base}/:recordId/complete`,
      authorize('maintenance:execute'),
      asyncHandler(async (req, res) => {
        const id = recordId(req);
        const body = parseInput(completeBody, req.body);
        const record = await service.update(caller(req), id, {
          status: 'completed',
          ...(body.completed_at ? { completed_at: body.completed_at } : {}),
          ...(body.notes !== undefined ? { notes: body.notes } : {}),
          ...(body.failures ? { failures: body.failures } : {}),
        });
        res.set('ETag', etagFor(record.version)).json({ data: record, meta: { request_id: req.correlationId } });
      }),
    );

    router.post(
      `${base}/:recordId/failures`,
      authorize('maintenance:write'),
      asyncHandler(async (req, res) => {
        const id = recordId(req);
        const created = await service.recordFailure(caller(req), id, parseInput(failure, req.body));
        res.status(201).json({ data: created, meta: { request_id: req.correlationId } });
      }),
    );
  }

  // When each wearing part and fluid was last changed (FMS-52): what the predictive model's part history reads.
  router.get(
    '/vehicles/:vehicleId/service-items',
    authorize('maintenance:read'),
    asyncHandler(async (req, res) => {
      const id = req.params.vehicleId;
      if (!UUID.test(id)) throw maintenanceVehicleMissing();
      const items = await service.serviceItems(caller(req), id);
      res.json({ data: items, meta: { request_id: req.correlationId } });
    }),
  );

  // Every recorded failure (FMS-125): the fleet's failure history, and the predictive model's labels.
  router.get(
    '/failure-events',
    authorize('maintenance:read'),
    asyncHandler(async (req, res) => {
      const query = parseInput(failureQuery, req.query);
      const { items, total } = await service.listFailures(caller(req), query);
      res.json({ data: items, meta: { ...pageMeta(query, total), request_id: req.correlationId } });
    }),
  );

  return router;
}

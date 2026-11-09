import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../shared/http/async-handler';
import { etagFor, ifMatchVersion } from '../../../shared/http/etag';
import { pageMeta, pageQuery } from '../../../shared/http/pagination';
import { parseInput } from '../../../shared/http/validate';
import { authorize } from '../../auth';
import type { Caller } from '../application/maintenance.service';
import type { WarrantyService } from '../application/warranty.service';
import { FAILURE_COMPONENTS } from '../domain/failure';
import { maintenanceNotFound, maintenanceVehicleMissing } from '../domain/maintenance';
import { RECALL_VEHICLE_STATUSES, recallNotFound, recallVehicleNotFound, warrantyNotFound } from '../domain/warranty';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const optionalText = (max: number) => z.string().trim().max(max).transform((s) => s || null).nullable().optional();
const day = z.iso.date();
/** Whole cents (ETB), never a fraction (api-contract §17). */
const cents = z.number().int().min(0).max(2_000_000_000);

/** What a warranty's PATCH may change: all but its vehicle. */
const warrantyEditable = {
  component: z.enum(FAILURE_COMPONENTS).nullable(),
  provider: z.string().trim().min(1).max(255),
  coverage: optionalText(2000),
  starts_on: day,
  ends_on: day.nullable(),
  ends_km: z.number().positive().max(10_000_000).nullable(),
  terms: optionalText(5000),
};

/** POST /warranties: the vehicle, the provider and the start; an end date, an end odometer or both (checked by the service). */
const warrantyCreate = z.strictObject({ vehicle_id: z.uuid(), ...warrantyEditable }).partial().required({ vehicle_id: true, provider: true, starts_on: true });

/** PATCH /warranties/{id}: the fields sent; `is_active: false` voids it. */
const warrantyUpdate = z
  .strictObject({ ...warrantyEditable, is_active: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Send at least one field to change.', params: { reason: 'empty_update' } });

const warrantyList = z.strictObject({
  ...pageQuery,
  vehicle_id: z.uuid().optional(),
  include_void: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .default(false),
});

/** PATCH .../warranty-claim: where the claim goes; the amount recovered with `approved`. */
const claimBody = z.strictObject({
  status: z.enum(['submitted', 'approved', 'rejected']),
  amount_cents: cents.nullable().optional(),
  reference: optionalText(100),
  // The odometer at the repair, for one that has none, whose warranty ends at a reading (one decimal at most).
  odometer_km: z
    .number()
    .min(0)
    .max(10_000_000)
    .refine((n) => /^\d+(\.\d)?$/.test(String(n)), { message: 'At most one decimal.', params: { reason: 'too_many_decimals' } })
    .optional(),
});

const year = z.number().int().min(1900).max(2100);
const recallFields = {
  campaign_code: z.string().trim().min(1).max(50),
  make: z.string().trim().min(1).max(100),
  model: z.string().trim().min(1).max(100),
  year_from: year,
  year_to: year,
  description: z.string().trim().min(1).max(5000),
  remedy: optionalText(5000),
  issued_on: day.nullable().optional(),
};

const recallCreate = z.strictObject(recallFields);
const recallUpdate = z
  .strictObject(recallFields)
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Send at least one field to change.', params: { reason: 'empty_update' } });

/** `status`: one or more of open, scheduled and completed, comma-separated; all by default. */
const recallStatuses = z
  .string()
  .transform((s) => s.split(',').map((x) => x.trim()))
  .pipe(z.array(z.enum(RECALL_VEHICLE_STATUSES)).min(1));

const recallVehicleList = z.strictObject({ ...pageQuery, status: recallStatuses.optional() });

const recallVehicleBody = z
  .strictObject({
    status: z.enum(RECALL_VEHICLE_STATUSES),
    maintenance_record_id: z.uuid().nullable(),
    completed_at: z.iso.datetime({ offset: true }),
    notes: optionalText(2000),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Send at least one field to change.', params: { reason: 'empty_update' } });

function caller(req: Request): Caller {
  return { user: req.user!, correlationId: req.correlationId };
}

function idParam(req: Request, name: string, notFound: () => Error): string {
  const id = req.params[name];
  if (!UUID.test(id)) throw notFound();
  return id;
}

/**
 * Warranties, warranty claims and recalls (api-contract §10.5, FMS-133). Reads: maintenance:read, in the
 * caller's depots; writes: maintenance:write. A recall itself applies to the whole fleet, so issuing or
 * changing one also needs a user who sees every depot.
 */
export function warrantyRouter(service: WarrantyService): Router {
  const router = Router();

  router.get(
    '/warranties',
    authorize('maintenance:read'),
    asyncHandler(async (req, res) => {
      const query = parseInput(warrantyList, req.query);
      const { items, total } = await service.listWarranties(caller(req), query);
      res.json({ data: items, meta: { ...pageMeta(query, total), request_id: req.correlationId } });
    }),
  );

  router.post(
    '/warranties',
    authorize('maintenance:write'),
    asyncHandler(async (req, res) => {
      const warranty = await service.createWarranty(caller(req), parseInput(warrantyCreate, req.body) as Parameters<WarrantyService['createWarranty']>[1]);
      res
        .status(201)
        .location(`/api/v1/warranties/${warranty.id}`)
        .set('ETag', etagFor(warranty.version))
        .json({ data: warranty, meta: { request_id: req.correlationId } });
    }),
  );

  router.get(
    '/warranties/:warrantyId',
    authorize('maintenance:read'),
    asyncHandler(async (req, res) => {
      const warranty = await service.getWarranty(caller(req), idParam(req, 'warrantyId', warrantyNotFound));
      res.set('ETag', etagFor(warranty.version)).json({ data: warranty, meta: { request_id: req.correlationId } });
    }),
  );

  router.patch(
    '/warranties/:warrantyId',
    authorize('maintenance:write'),
    asyncHandler(async (req, res) => {
      const id = idParam(req, 'warrantyId', warrantyNotFound);
      const expected = ifMatchVersion(req.get('If-Match'));
      const warranty = await service.updateWarranty(caller(req), id, parseInput(warrantyUpdate, req.body), expected);
      res.set('ETag', etagFor(warranty.version)).json({ data: warranty, meta: { request_id: req.correlationId } });
    }),
  );

  for (const base of ['/maintenance', '/maintenance-records']) {
    router.patch(
      `${base}/:recordId/warranty-claim`,
      authorize('maintenance:write'),
      asyncHandler(async (req, res) => {
        const id = idParam(req, 'recordId', maintenanceNotFound);
        const claim = await service.updateClaim(caller(req), id, parseInput(claimBody, req.body));
        res.json({ data: claim, meta: { request_id: req.correlationId } });
      }),
    );
  }

  router.get(
    '/recalls',
    authorize('maintenance:read'),
    asyncHandler(async (req, res) => {
      const query = parseInput(z.strictObject(pageQuery), req.query);
      const { items, total } = await service.listRecalls(caller(req), query);
      res.json({ data: items, meta: { ...pageMeta(query, total), request_id: req.correlationId } });
    }),
  );

  router.post(
    '/recalls',
    authorize('maintenance:write'),
    asyncHandler(async (req, res) => {
      const recall = await service.createRecall(caller(req), parseInput(recallCreate, req.body));
      res
        .status(201)
        .location(`/api/v1/recalls/${recall.id}`)
        .set('ETag', etagFor(recall.version))
        .json({ data: recall, meta: { request_id: req.correlationId } });
    }),
  );

  router.get(
    '/recalls/:recallId',
    authorize('maintenance:read'),
    asyncHandler(async (req, res) => {
      const recall = await service.getRecall(caller(req), idParam(req, 'recallId', recallNotFound));
      res.set('ETag', etagFor(recall.version)).json({ data: recall, meta: { request_id: req.correlationId } });
    }),
  );

  router.patch(
    '/recalls/:recallId',
    authorize('maintenance:write'),
    asyncHandler(async (req, res) => {
      const id = idParam(req, 'recallId', recallNotFound);
      const expected = ifMatchVersion(req.get('If-Match'));
      const recall = await service.updateRecall(caller(req), id, parseInput(recallUpdate, req.body), expected);
      res.set('ETag', etagFor(recall.version)).json({ data: recall, meta: { request_id: req.correlationId } });
    }),
  );

  router.get(
    '/recalls/:recallId/vehicles',
    authorize('maintenance:read'),
    asyncHandler(async (req, res) => {
      const id = idParam(req, 'recallId', recallNotFound);
      const query = parseInput(recallVehicleList, req.query);
      const { items, total } = await service.recallVehicles(caller(req), id, query);
      res.json({ data: items, meta: { ...pageMeta(query, total), request_id: req.correlationId } });
    }),
  );

  router.patch(
    '/recalls/:recallId/vehicles/:vehicleId',
    authorize('maintenance:write'),
    asyncHandler(async (req, res) => {
      const id = idParam(req, 'recallId', recallNotFound);
      const vehicleId = idParam(req, 'vehicleId', recallVehicleNotFound);
      const updated = await service.updateRecallVehicle(caller(req), id, vehicleId, parseInput(recallVehicleBody, req.body));
      res.json({ data: updated, meta: { request_id: req.correlationId } });
    }),
  );

  router.get(
    '/vehicles/:vehicleId/recalls',
    authorize('maintenance:read'),
    asyncHandler(async (req, res) => {
      const vehicleId = idParam(req, 'vehicleId', maintenanceVehicleMissing);
      res.json({ data: await service.vehicleRecalls(caller(req), vehicleId), meta: { request_id: req.correlationId } });
    }),
  );

  return router;
}

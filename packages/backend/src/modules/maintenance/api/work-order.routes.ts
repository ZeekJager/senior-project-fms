import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../shared/http/async-handler';
import { etagFor, ifMatchVersion } from '../../../shared/http/etag';
import { pageMeta, pageQuery } from '../../../shared/http/pagination';
import { FLOAT_IN_MONEY_PATH, parseInput, rejectFractionalMoney } from '../../../shared/http/validate';
import { AppError } from '../../../shared/errors/app-error';
import { authorize } from '../../auth';
import type { MaintenanceService } from '../application/maintenance.service';
import type { Caller, WorkOrderService } from '../application/work-order.service';
import { FAILURE_COMPONENTS } from '../domain/failure';
import { maintenanceNotFound } from '../domain/maintenance';
import { TASK_STATUSES, VENDOR_TYPES, labourEntryNotFound, taskNotFound, vendorNotFound } from '../domain/work-order';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CENTS = 2_147_483_647;

const cents = z
  .number()
  .refine(Number.isInteger, { message: 'Whole cents.', params: { reason: FLOAT_IN_MONEY_PATH } })
  .refine((n) => n >= 0 && n <= MAX_CENTS, { message: 'Between 0 and 2147483647.', params: { reason: 'out_of_range' } });

/** Hours with at most two decimals. */
const hours = (max: number) =>
  z
    .number()
    .min(0)
    .max(max)
    .refine((n) => /^\d+(\.\d{1,2})?$/.test(String(n)), { message: 'At most two decimals.', params: { reason: 'too_many_decimals' } });

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).transform((s) => s || null).nullable().optional();

const vendorBody = z.strictObject({
  name: text(255),
  vendor_type: z.enum(VENDOR_TYPES),
  contact_name: optionalText(255),
  phone: optionalText(50),
  email: z.email().max(255).nullable().optional(),
  depot_id: z.uuid().nullable().optional(),
  notes: optionalText(2000),
});

const vendorPatch = vendorBody
  .extend({ is_active: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Send at least one field to change.', params: { reason: 'empty_update' } });

const vendorQuery = z.strictObject({
  ...pageQuery,
  vendor_type: z.enum(VENDOR_TYPES).optional(),
  search: z.string().trim().min(1).max(100).optional(),
  status: z.enum(['active', 'retired', 'all']).default('active'),
});

const orderVendorBody = rejectFractionalMoney(
  z.strictObject({
    vendor_id: z.uuid().nullable(),
    vendor_invoice_ref: optionalText(100),
    vendor_cost_cents: cents.optional(),
  }),
);

const taskBody = z.strictObject({
  description: text(500),
  component: z.enum(FAILURE_COMPONENTS).nullable().optional(),
  estimated_hours: hours(9999).nullable().optional(),
  status: z.enum(TASK_STATUSES).optional(),
});

const taskPatch = taskBody
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Send at least one field to change.', params: { reason: 'empty_update' } });

const labourBody = rejectFractionalMoney(
  z.strictObject({
    technician_id: z.uuid(),
    task_id: z.uuid().nullable().optional(),
    work_date: z.iso.date().optional(),
    hours: hours(24).refine((n) => n > 0, { message: 'More than 0.', params: { reason: 'out_of_range' } }),
    rate_cents: cents.optional(),
    notes: optionalText(1000),
  }),
);

/** At most a year at once: a workload report, not an export. */
const MAX_REPORT_DAYS = 366;

const labourQuery = z
  .strictObject({
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    technician_id: z.uuid().optional(),
  })
  .transform((q) => {
    const to = q.to ?? addisToday();
    // Twelve weeks back from the Monday of `to`'s week by default.
    const from = q.from ?? shiftDays(mondayOf(to), -7 * 11);
    return { ...q, from, to };
  })
  .superRefine((q, ctx) => {
    if (q.from > q.to) ctx.addIssue({ code: 'custom', path: ['from'], message: 'From must not be after to.', params: { reason: 'after_to' } });
    else if (daysBetween(q.from, q.to) > MAX_REPORT_DAYS) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: `At most ${MAX_REPORT_DAYS} days.`, params: { reason: 'range_too_long' } });
    }
  });

function addisToday(): string {
  return new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
}
function shiftDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function mondayOf(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return shiftDays(day, -((d.getUTCDay() + 6) % 7));
}
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

function caller(req: Request): Caller {
  return { user: req.user!, correlationId: req.correlationId };
}

function param(req: Request, name: string, notFound: () => AppError): string {
  const id = req.params[name];
  if (!UUID.test(id)) throw notFound();
  return id;
}

/**
 * Work orders (FMS-130, docs/work-orders.md, api-contract §10.1). Vendors: read with maintenance:read, written with
 * vendor:write. An order's vendor, tasks and labour: maintenance:write. Approving a request: maintenance:approve.
 * Hours per technician per week: maintenance:read (costs with labour-rate:read). Each write answers with the
 * updated MaintenanceRecord.
 */
export function workOrderRouter(service: WorkOrderService, records: MaintenanceService): Router {
  const router = Router();

  const respondRecord = async (req: Request, res: import('express').Response, recordId: string, status = 200) => {
    const record = await records.get(caller(req), recordId);
    res.status(status).set('ETag', etagFor(record.version)).json({ data: record, meta: { request_id: req.correlationId } });
  };

  router.get(
    '/vendors',
    authorize('maintenance:read'),
    asyncHandler(async (req, res) => {
      const query = parseInput(vendorQuery, req.query);
      const { items, total } = await service.listVendors(caller(req), query);
      res.json({ data: items, meta: { ...pageMeta(query, total), request_id: req.correlationId } });
    }),
  );

  router.post(
    '/vendors',
    authorize('vendor:write'),
    asyncHandler(async (req, res) => {
      const vendor = await service.createVendor(caller(req), parseInput(vendorBody, req.body));
      res
        .status(201)
        .location(`/api/v1/vendors/${vendor.id}`)
        .set('ETag', etagFor(vendor.version))
        .json({ data: vendor, meta: { request_id: req.correlationId } });
    }),
  );

  router.get(
    '/vendors/:vendorId',
    authorize('maintenance:read'),
    asyncHandler(async (req, res) => {
      const vendor = await service.getVendor(caller(req), param(req, 'vendorId', vendorNotFound));
      res.set('ETag', etagFor(vendor.version)).json({ data: vendor, meta: { request_id: req.correlationId } });
    }),
  );

  router.patch(
    '/vendors/:vendorId',
    authorize('vendor:write'),
    asyncHandler(async (req, res) => {
      const id = param(req, 'vendorId', vendorNotFound);
      const vendor = await service.updateVendor(caller(req), id, parseInput(vendorPatch, req.body), ifMatchVersion(req.get('If-Match')));
      res.set('ETag', etagFor(vendor.version)).json({ data: vendor, meta: { request_id: req.correlationId } });
    }),
  );

  router.put(
    '/maintenance-records/:recordId/vendor',
    authorize('maintenance:write'),
    asyncHandler(async (req, res) => {
      const id = param(req, 'recordId', maintenanceNotFound);
      await service.setVendor(caller(req), id, parseInput(orderVendorBody, req.body));
      await respondRecord(req, res, id);
    }),
  );

  router.post(
    '/maintenance-records/:recordId/tasks',
    authorize('maintenance:write'),
    asyncHandler(async (req, res) => {
      const id = param(req, 'recordId', maintenanceNotFound);
      await service.addTask(caller(req), id, parseInput(taskBody, req.body));
      await respondRecord(req, res, id, 201);
    }),
  );

  router.patch(
    '/maintenance-records/:recordId/tasks/:taskId',
    authorize('maintenance:write'),
    asyncHandler(async (req, res) => {
      const id = param(req, 'recordId', maintenanceNotFound);
      const taskId = param(req, 'taskId', taskNotFound);
      await service.updateTask(caller(req), id, taskId, parseInput(taskPatch, req.body), ifMatchVersion(req.get('If-Match')));
      await respondRecord(req, res, id);
    }),
  );

  router.delete(
    '/maintenance-records/:recordId/tasks/:taskId',
    authorize('maintenance:write'),
    asyncHandler(async (req, res) => {
      const id = param(req, 'recordId', maintenanceNotFound);
      await service.removeTask(caller(req), id, param(req, 'taskId', taskNotFound));
      await respondRecord(req, res, id);
    }),
  );

  router.post(
    '/maintenance-records/:recordId/labour',
    authorize('maintenance:write'),
    asyncHandler(async (req, res) => {
      const id = param(req, 'recordId', maintenanceNotFound);
      await service.addLabour(caller(req), id, parseInput(labourBody, req.body));
      await respondRecord(req, res, id, 201);
    }),
  );

  router.delete(
    '/maintenance-records/:recordId/labour/:entryId',
    authorize('maintenance:write'),
    asyncHandler(async (req, res) => {
      const id = param(req, 'recordId', maintenanceNotFound);
      await service.removeLabour(caller(req), id, param(req, 'entryId', labourEntryNotFound));
      await respondRecord(req, res, id);
    }),
  );

  router.post(
    '/maintenance-records/:recordId/approve',
    authorize('maintenance:approve'),
    asyncHandler(async (req, res) => {
      const id = param(req, 'recordId', maintenanceNotFound);
      await service.approve(caller(req), id);
      await respondRecord(req, res, id);
    }),
  );

  router.get(
    '/maintenance-records/:recordId/technicians',
    authorize('maintenance:write'),
    asyncHandler(async (req, res) => {
      const items = await service.technicians(caller(req), param(req, 'recordId', maintenanceNotFound));
      res.json({ data: items, meta: { request_id: req.correlationId } });
    }),
  );

  router.get(
    '/labour-hours',
    authorize('maintenance:read'),
    asyncHandler(async (req, res) => {
      const query = parseInput(labourQuery, req.query);
      const items = await service.labourByWeek(caller(req), query);
      res.json({ data: items, meta: { from: query.from, to: query.to, request_id: req.correlationId } });
    }),
  );

  return router;
}

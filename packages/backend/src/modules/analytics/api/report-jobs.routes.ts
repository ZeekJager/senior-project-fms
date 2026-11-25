import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { publicRoute } from '../../../shared/authz/route-policy';
import { AppError } from '../../../shared/errors/app-error';
import { asyncHandler } from '../../../shared/http/async-handler';
import { parseInput } from '../../../shared/http/validate';
import { authorize } from '../../auth';
import type { ReportJobsService } from '../application/report-jobs.service';
import { FREQUENCIES } from '../domain/report-schedule';
import { REPORT_KINDS } from '../domain/reports';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The filters a saved filter or a schedule keeps: the report query without its format (the schedule sets the period). */
const filtersBody = z
  .strictObject({
    month: z.string().optional(),
    quarter: z.string().optional(),
    year: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    depot_ids: z.array(z.uuid()).max(50).optional(),
    vehicle_type: z.string().trim().min(1).max(40).optional(),
    vehicle_id: z.uuid().optional(),
    driver_id: z.uuid().optional(),
    route_id: z.uuid().optional(),
    by: z.enum(['depot', 'driver', 'route']).optional(),
  })
  .transform((f) => ({ ...f, ...(f.depot_ids ? { depot_ids: f.depot_ids.join(',') } : {}) }));

const filterBody = z.strictObject({ name: z.string().trim().min(1).max(80), filters: filtersBody });

const scheduleFields = {
  name: z.string().trim().min(1).max(80),
  report: z.enum(REPORT_KINDS),
  filters: filtersBody.optional(),
  format: z.enum(['csv', 'xlsx', 'pdf']),
  frequency: z.enum(FREQUENCIES),
  day: z.number().int().min(1).max(28).nullable().optional(),
  hour: z.number().int().min(0).max(23),
  recipients: z.array(z.uuid()).min(1).max(50),
};
const scheduleBody = z.strictObject(scheduleFields);
const schedulePatch = z.strictObject(scheduleFields).partial();

const contentQuery = z.object({ expires: z.string().optional(), signature: z.string().optional() });
const recipientQuery = z.object({ search: z.string().max(100).default('') });

const caller = (req: Request) => ({ user: req.user!, correlationId: req.correlationId });
const ok = (res: Response, req: Request, data: unknown, status = 200) => res.status(status).json({ data, meta: { request_id: req.correlationId } });

function idParam(req: Request, name: string, what: string): string {
  const id = String(req.params[name]);
  if (!UUID.test(id)) throw new AppError(404, 'NOT_FOUND', `${what} not found.`);
  return id;
}

/**
 * Saved report filters, background exports and report schedules (FMS-160, docs/reports.md), analytics:read. Filters and
 * exports are the caller's own; a schedule is its owner's (an administrator sees and changes all). Registered before
 * GET /reports/{report}, whose path they would otherwise match.
 */
export function reportJobsRouter(service: ReportJobsService): Router {
  const router = Router();

  router.get(
    '/reports/filters',
    authorize('analytics:read'),
    asyncHandler(async (req, res) => ok(res, req, await service.savedFilters(caller(req)))),
  );
  router.post(
    '/reports/filters',
    authorize('analytics:read'),
    asyncHandler(async (req, res) => ok(res, req, await service.saveFilter(caller(req), parseInput(filterBody, req.body)), 201)),
  );
  router.delete(
    '/reports/filters/:filterId',
    authorize('analytics:read'),
    asyncHandler(async (req, res) => {
      await service.deleteFilter(caller(req), idParam(req, 'filterId', 'Saved filter'));
      res.status(204).end();
    }),
  );

  router.get(
    '/reports/exports/:exportId',
    authorize('analytics:read'),
    asyncHandler(async (req, res) => ok(res, req, await service.exportStatus(caller(req), idParam(req, 'exportId', 'Export')))),
  );

  router.get(
    '/reports/schedules',
    authorize('analytics:read'),
    asyncHandler(async (req, res) => ok(res, req, await service.schedules(caller(req)))),
  );
  // Who a schedule can go to: active users who read reports, names and roles only.
  router.get(
    '/reports/recipients',
    authorize('analytics:read'),
    asyncHandler(async (req, res) => ok(res, req, await service.recipients(parseInput(recipientQuery, req.query).search))),
  );
  router.post(
    '/reports/schedules',
    authorize('analytics:read'),
    asyncHandler(async (req, res) => ok(res, req, await service.createSchedule(caller(req), parseInput(scheduleBody, req.body)), 201)),
  );
  router.patch(
    '/reports/schedules/:scheduleId',
    authorize('analytics:read'),
    asyncHandler(async (req, res) => ok(res, req, await service.updateSchedule(caller(req), idParam(req, 'scheduleId', 'Schedule'), parseInput(schedulePatch, req.body)))),
  );
  router.delete(
    '/reports/schedules/:scheduleId',
    authorize('analytics:read'),
    asyncHandler(async (req, res) => {
      await service.deleteSchedule(caller(req), idParam(req, 'scheduleId', 'Schedule'));
      res.status(204).end();
    }),
  );
  router.get(
    '/reports/schedules/:scheduleId/runs',
    authorize('analytics:read'),
    asyncHandler(async (req, res) => ok(res, req, await service.runs(caller(req), idParam(req, 'scheduleId', 'Schedule')))),
  );

  // The signed link to an export's file or a large scheduled report's. Public: the signature is the permission.
  router.get(
    '/report-files/:fileId/content',
    publicRoute(),
    asyncHandler(async (req, res) => {
      const { expires, signature } = parseInput(contentQuery, req.query);
      const file = await service.fileContent(idParam(req, 'fileId', 'File'), expires, signature);
      res.set({
        'Content-Type': file.contentType,
        'Content-Disposition': `attachment; filename="${file.filename.replace(/[^a-z0-9.-]/gi, '_')}"`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
      });
      file.stream.on('error', (err) => res.destroy(err));
      file.stream.pipe(res);
    }),
  );

  return router;
}

import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../shared/http/async-handler';
import { pageMeta, pageQuery } from '../../../shared/http/pagination';
import { parseInput } from '../../../shared/http/validate';
import { authorize } from '../../auth';
import { resolveDate, type AttendanceService } from '../application/attendance.service';
import type { Caller } from '../application/caller';
import { ATTENDANCE_STATUSES, attendanceNotFound } from '../domain/attendance';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const date = z.iso.date();
const notes = z.string().trim().max(500).transform((s) => s || null).nullable().optional();

/** POST /attendance (the card's `{driverId, date, status}`, in the API's snake_case). */
const createBody = z.strictObject({
  driver_id: z.uuid(),
  date,
  status: z.enum(ATTENDANCE_STATUSES),
  notes,
});

/** PUT replaces status (and notes); PATCH changes what is sent. */
const putBody = z.strictObject({ status: z.enum(ATTENDANCE_STATUSES), notes });
const patchBody = z
  .strictObject({ status: z.enum(ATTENDANCE_STATUSES), notes })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Send status or notes.', params: { reason: 'empty_update' } });

/** GET /attendance: one day (default today, Addis Ababa), every driver the caller may see. */
const rosterQuery = z.object({
  ...pageQuery,
  date: z.union([z.literal('today'), date]).default('today').transform(resolveDate),
  depot_id: z.uuid().optional(),
  driver_id: z.uuid().optional(),
  status: z.enum([...ATTENDANCE_STATUSES, 'unmarked']).optional(),
  search: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((s) => s || undefined),
});

function caller(req: Request): Caller {
  return { user: req.user!, correlationId: req.correlationId };
}

function attendanceId(req: Request): string {
  const id = req.params.attendanceId;
  if (!UUID.test(id)) throw attendanceNotFound();
  return id;
}

/** Driver attendance (api-contract §6.3, FMS-21). Reads: attendance:read; writes: attendance:write (not dispatchers). */
export function attendanceRouter(service: AttendanceService): Router {
  const router = Router();

  router.get(
    '/attendance',
    authorize('attendance:read'),
    asyncHandler(async (req, res) => {
      const query = parseInput(rosterQuery, req.query);
      const { items, total } = await service.roster(caller(req), query);
      res.json({ data: items, meta: { ...pageMeta(query, total), date: query.date, request_id: req.correlationId } });
    }),
  );

  router.post(
    '/attendance',
    authorize('attendance:write'),
    asyncHandler(async (req, res) => {
      const record = await service.create(caller(req), parseInput(createBody, req.body));
      res
        .status(201)
        .location(`/api/v1/attendance/${record.id}`)
        .json({ data: record, meta: { request_id: req.correlationId } });
    }),
  );

  router.get(
    '/attendance/:attendanceId',
    authorize('attendance:read'),
    asyncHandler(async (req, res) => {
      res.json({ data: await service.get(caller(req), attendanceId(req)), meta: { request_id: req.correlationId } });
    }),
  );

  // PUT (the card) and PATCH (the contract) both change an existing record.
  router.put(
    '/attendance/:attendanceId',
    authorize('attendance:write'),
    asyncHandler(async (req, res) => {
      const { status, notes: n } = parseInput(putBody, req.body);
      const record = await service.update(caller(req), attendanceId(req), { status, notes: n ?? null });
      res.json({ data: record, meta: { request_id: req.correlationId } });
    }),
  );

  router.patch(
    '/attendance/:attendanceId',
    authorize('attendance:write'),
    asyncHandler(async (req, res) => {
      const record = await service.update(caller(req), attendanceId(req), parseInput(patchBody, req.body));
      res.json({ data: record, meta: { request_id: req.correlationId } });
    }),
  );

  return router;
}

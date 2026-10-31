import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../shared/http/async-handler';
import { etagFor, ifMatchVersion } from '../../../shared/http/etag';
import { pageMeta, pageQuery } from '../../../shared/http/pagination';
import { parseInput } from '../../../shared/http/validate';
import { authorize } from '../../auth';
import type { Caller } from '../application/maintenance.service';
import type { ServiceProgramService } from '../application/service-program.service';
import { maintenanceVehicleMissing } from '../domain/maintenance';
import {
  MAX_INTERVAL,
  MAX_PROGRAM_TASKS,
  MAX_TASK_LENGTH,
  PROGRAM_FUEL_TYPES,
  PROGRAM_VEHICLE_TYPES,
  SERVICE_DUE_STATUSES,
  programNotFound,
} from '../domain/service-program';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const optionalText = (max: number) => z.string().trim().max(max).transform((s) => s || null).nullable().optional();
const whole = (max: number) => z.number().int().min(1).max(max);
const lead = (max: number) => z.number().int().min(0).max(max);

/** The checklist: task names, trimmed, each once. */
const tasks = z
  .array(z.string().trim().min(1).max(MAX_TASK_LENGTH))
  .max(MAX_PROGRAM_TASKS)
  .refine((list) => new Set(list.map((s) => s.toLowerCase())).size === list.length, {
    message: 'List each task once.',
    params: { reason: 'duplicate_task' },
  });

const fields = {
  name: z.string().trim().min(1).max(120),
  description: optionalText(2000),
  depot_id: z.uuid().nullable(),
  vehicle_type: z.enum(PROGRAM_VEHICLE_TYPES).nullable(),
  fuel_type: z.enum(PROGRAM_FUEL_TYPES).nullable(),
  make: optionalText(100),
  model: optionalText(100),
  interval_km: whole(MAX_INTERVAL.km).nullable(),
  lead_km: lead(MAX_INTERVAL.km).nullable(),
  interval_days: whole(MAX_INTERVAL.days).nullable(),
  lead_days: lead(MAX_INTERVAL.days).nullable(),
  interval_engine_hours: whole(MAX_INTERVAL.engine_hours).nullable(),
  lead_engine_hours: lead(MAX_INTERVAL.engine_hours).nullable(),
  tasks,
};

/** POST /service-programs: a name and at least one interval (checked by the service, with the lead windows). */
const createBody = z.strictObject({ ...fields }).partial().required({ name: true });

/** PATCH: the fields sent; `is_active` retires or restores. */
const updateBody = z
  .strictObject({ ...fields, is_active: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Send at least one field to change.', params: { reason: 'empty_update' } });

const listQuery = z.strictObject({
  ...pageQuery,
  status: z.enum(['active', 'retired', 'all']).default('active'),
  depot_id: z.uuid().optional(),
});

/** `status`: one or more of upcoming, due and overdue, comma-separated; due and overdue by default. */
const statuses = z
  .string()
  .transform((s) => s.split(',').map((x) => x.trim()))
  .pipe(z.array(z.enum(SERVICE_DUE_STATUSES)).min(1));

const dueQuery = z.strictObject({
  ...pageQuery,
  status: statuses.default(['due', 'overdue']),
  vehicle_id: z.uuid().optional(),
  program_id: z.uuid().optional(),
  depot_id: z.uuid().optional(),
});

function caller(req: Request): Caller {
  return { user: req.user!, correlationId: req.correlationId };
}

function programId(req: Request): string {
  const id = req.params.programId;
  if (!UUID.test(id)) throw programNotFound();
  return id;
}

/**
 * Preventive service programs and service due (api-contract §10.5, FMS-129). Programs: read with
 * maintenance:read, defined with service-program:write (admin, fleet manager, depot admin). Service
 * due: vehicle:read, in the caller's depots.
 */
export function serviceProgramRouter(service: ServiceProgramService): Router {
  const router = Router();

  router.get(
    '/service-programs',
    authorize('maintenance:read'),
    asyncHandler(async (req, res) => {
      const query = parseInput(listQuery, req.query);
      const { items, total } = await service.list(caller(req), query);
      res.json({ data: items, meta: { ...pageMeta(query, total), request_id: req.correlationId } });
    }),
  );

  router.post(
    '/service-programs',
    authorize('service-program:write'),
    asyncHandler(async (req, res) => {
      const program = await service.create(caller(req), parseInput(createBody, req.body));
      res
        .status(201)
        .location(`/api/v1/service-programs/${program.id}`)
        .set('ETag', etagFor(program.version))
        .json({ data: program, meta: { request_id: req.correlationId } });
    }),
  );

  router.get(
    '/service-programs/:programId',
    authorize('maintenance:read'),
    asyncHandler(async (req, res) => {
      const program = await service.get(caller(req), programId(req));
      res.set('ETag', etagFor(program.version)).json({ data: program, meta: { request_id: req.correlationId } });
    }),
  );

  router.patch(
    '/service-programs/:programId',
    authorize('service-program:write'),
    asyncHandler(async (req, res) => {
      const id = programId(req);
      const expected = ifMatchVersion(req.get('If-Match'));
      const program = await service.update(caller(req), id, parseInput(updateBody, req.body), expected);
      res.set('ETag', etagFor(program.version)).json({ data: program, meta: { request_id: req.correlationId } });
    }),
  );

  router.get(
    '/service-due',
    authorize('vehicle:read'),
    asyncHandler(async (req, res) => {
      const query = parseInput(dueQuery, req.query);
      const { items, total } = await service.dueList(caller(req), query);
      res.json({ data: items, meta: { ...pageMeta(query, total), request_id: req.correlationId } });
    }),
  );

  router.get(
    '/vehicles/:vehicleId/service-due',
    authorize('vehicle:read'),
    asyncHandler(async (req, res) => {
      const id = req.params.vehicleId;
      if (!UUID.test(id)) throw maintenanceVehicleMissing();
      res.json({ data: await service.forVehicle(caller(req), id), meta: { request_id: req.correlationId } });
    }),
  );

  return router;
}

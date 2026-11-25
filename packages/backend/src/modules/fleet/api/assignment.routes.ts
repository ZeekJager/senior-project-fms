import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../shared/http/async-handler';
import { idempotent } from '../../../shared/http/idempotency';
import { pageMeta, pageQuery } from '../../../shared/http/pagination';
import { parseInput } from '../../../shared/http/validate';
import { authorize } from '../../auth';
import type { AssignmentService } from '../application/assignment.service';
import type { Caller } from '../application/caller';
import { ASSIGNMENT_TYPES, assignmentNotFound } from '../domain/assignment';
import { driverNotFound } from '../domain/driver';
import { vehicleNotFound } from '../domain/vehicle';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const instant = z.iso.datetime({ offset: true }).transform((s) => new Date(s));
const notes = z.string().trim().min(1).max(1000);

const createBody = z.strictObject({
  driver_id: z.uuid(),
  vehicle_id: z.uuid(),
  assignment_type: z.enum(ASSIGNMENT_TYPES).optional(),
  start_at: instant.optional(),
  end_at: instant.nullable().optional(),
  notes: notes.nullable().optional(),
});

const endBody = z.strictObject({ end_at: instant.optional(), notes: notes.optional() });
const listQuery = z.strictObject({ ...pageQuery });

function caller(req: Request): Caller {
  return { user: req.user!, correlationId: req.correlationId };
}

function param(req: Request, name: string, notFound: () => Error): string {
  const value = req.params[name];
  if (!UUID.test(value)) throw notFound();
  return value;
}

/** A driver's regular vehicle (FMS-77, api-contract §6.3, docs/driver-vehicle-assignments.md). */
export function assignmentRouter(service: AssignmentService): Router {
  const router = Router();

  router.post(
    '/driver-vehicle-assignments',
    authorize('assignment:write'),
    idempotent(),
    asyncHandler(async (req, res) => {
      const view = await service.create(caller(req), parseInput(createBody, req.body));
      res.status(201).location(`/api/v1/driver-vehicle-assignments/${view.id}`).json({ data: view, meta: { request_id: req.correlationId } });
    }),
  );

  router.get(
    '/driver-vehicle-assignments/:assignmentId',
    authorize('assignment:read'),
    asyncHandler(async (req, res) => {
      const view = await service.get(caller(req), param(req, 'assignmentId', assignmentNotFound));
      res.json({ data: view, meta: { request_id: req.correlationId } });
    }),
  );

  router.post(
    '/driver-vehicle-assignments/:assignmentId/end',
    authorize('assignment:write'),
    asyncHandler(async (req, res) => {
      const view = await service.end(caller(req), param(req, 'assignmentId', assignmentNotFound), parseInput(endBody, req.body ?? {}));
      res.json({ data: view, meta: { request_id: req.correlationId } });
    }),
  );

  router.get(
    '/drivers/:driverId/assignments',
    authorize('assignment:read'),
    asyncHandler(async (req, res) => {
      const query = parseInput(listQuery, req.query);
      const { items, total } = await service.forDriver(caller(req), param(req, 'driverId', driverNotFound), query);
      res.json({ data: items, meta: { ...pageMeta(query, total), request_id: req.correlationId } });
    }),
  );

  router.get(
    '/vehicles/:vehicleId/assignments',
    authorize('assignment:read'),
    asyncHandler(async (req, res) => {
      const query = parseInput(listQuery, req.query);
      const { items, total } = await service.forVehicle(caller(req), param(req, 'vehicleId', vehicleNotFound), query);
      res.json({ data: items, meta: { ...pageMeta(query, total), request_id: req.correlationId } });
    }),
  );

  return router;
}

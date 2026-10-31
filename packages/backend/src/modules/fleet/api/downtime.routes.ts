import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../shared/http/async-handler';
import { pageMeta, pageQuery } from '../../../shared/http/pagination';
import { parseInput } from '../../../shared/http/validate';
import { authorize } from '../../auth';
import type { Caller } from '../application/caller';
import type { DowntimeService } from '../application/downtime.service';
import { DOWNTIME_REASONS, downtimeNotFound } from '../domain/downtime';
import { vehicleNotFound } from '../domain/vehicle';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const downtimeQuery = z.strictObject({ ...pageQuery });

/** A staff member's reason for a period, or null for the one its repair or failure gives. */
const reasonBody = z.strictObject({
  reason: z.enum(DOWNTIME_REASONS).nullable(),
  note: z.string().max(500).nullable().optional(),
});

function caller(req: Request): Caller {
  return { user: req.user!, correlationId: req.correlationId };
}

function vehicleId(req: Request): string {
  const id = req.params.vehicleId;
  if (!UUID.test(id)) throw vehicleNotFound();
  return id;
}

/**
 * A vehicle's downtime periods (FMS-131): vehicle:read to list them, vehicle:write to give a period its reason,
 * in the caller's depot scope.
 */
export function downtimeRouter(service: DowntimeService): Router {
  const router = Router();

  router.get(
    '/vehicles/:vehicleId/downtime',
    authorize('vehicle:read'),
    asyncHandler(async (req, res) => {
      const id = vehicleId(req);
      const query = parseInput(downtimeQuery, req.query);
      const { items, total } = await service.list(caller(req), id, query);
      res.json({ data: items, meta: { ...pageMeta(query, total), request_id: req.correlationId } });
    }),
  );

  router.patch(
    '/vehicles/:vehicleId/downtime/:periodId',
    authorize('vehicle:write'),
    asyncHandler(async (req, res) => {
      const id = vehicleId(req);
      if (!UUID.test(req.params.periodId)) throw downtimeNotFound();
      const period = await service.setReason(caller(req), id, req.params.periodId, parseInput(reasonBody, req.body));
      res.json({ data: period, meta: { request_id: req.correlationId } });
    }),
  );

  return router;
}

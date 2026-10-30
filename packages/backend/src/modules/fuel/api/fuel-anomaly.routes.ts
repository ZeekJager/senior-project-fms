import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../shared/http/async-handler';
import { pageMeta, pageQuery } from '../../../shared/http/pagination';
import { parseInput } from '../../../shared/http/validate';
import { authorize } from '../../auth';
import type { FuelAnomalyService } from '../application/fuel-anomaly.service';
import type { Caller } from '../application/fuel-log.service';
import { ANOMALY_OUTCOMES, ANOMALY_STATUSES, MAX_NOTES, anomalyNotFound } from '../domain/fuel-anomaly';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const listQuery = z.object({
  ...pageQuery,
  vehicle_id: z.uuid().optional(),
  // One status or several, comma-separated: `open,reviewed` is what still needs someone.
  status: z
    .string()
    .transform((s) => s.split(',').map((v) => v.trim()))
    .pipe(z.array(z.enum(ANOMALY_STATUSES)).min(1))
    .optional(),
  anomaly_type: z.string().trim().min(1).max(50).optional(),
});

const closeBody = z.strictObject({
  outcome: z.enum(ANOMALY_OUTCOMES).default('resolved'),
  notes: z.string().trim().min(1).max(MAX_NOTES).optional(),
});

function caller(req: Request): Caller {
  return { user: req.user!, correlationId: req.correlationId };
}

function anomalyId(req: Request): string {
  const id = req.params.anomalyId;
  if (!UUID.test(id)) throw anomalyNotFound();
  return id;
}

/**
 * Fuel anomalies (api-contract §9.1, FMS-42): reading needs `fuel-anomaly:read` (admin, fleet manager, depot admin,
 * finance clerk, compliance officer), closing `fuel-anomaly:write` (admin, fleet manager, finance clerk). Depot scope:
 * another depot's anomaly is 404.
 */
export function fuelAnomalyRouter(service: FuelAnomalyService): Router {
  const router = Router();

  router.get(
    '/fuel-anomalies',
    authorize('fuel-anomaly:read'),
    asyncHandler(async (req, res) => {
      const query = parseInput(listQuery, req.query);
      const { items, total } = await service.list(caller(req), query);
      res.json({ data: items, meta: { ...pageMeta(query, total), request_id: req.correlationId } });
    }),
  );

  router.get(
    '/fuel-anomalies/:anomalyId',
    authorize('fuel-anomaly:read'),
    asyncHandler(async (req, res) => {
      res.json({ data: await service.get(caller(req), anomalyId(req)), meta: { request_id: req.correlationId } });
    }),
  );

  router.post(
    '/fuel-anomalies/:anomalyId/resolve',
    authorize('fuel-anomaly:write'),
    asyncHandler(async (req, res) => {
      const id = anomalyId(req);
      res.json({ data: await service.close(caller(req), id, parseInput(closeBody, req.body ?? {})), meta: { request_id: req.correlationId } });
    }),
  );

  return router;
}
